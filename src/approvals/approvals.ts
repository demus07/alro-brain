import { randomInt } from "node:crypto";
import { jsonSchema, tool, type ToolSet } from "ai";
import { and, desc, eq, getTableColumns, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { notifyPerson } from "@/channels/links";
import { outcomeUnknown } from "@/connectors/api";
import { providerOf } from "@/connectors/registry";
import type { ActionDef } from "@/connectors/provider";
import { sessionFor } from "@/connectors/sync";
import type { Db } from "@/db/client";
import type { EmailInput } from "@/connectors/email-actions";
import { approvals, connections, mcpServers, orgs } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { audit } from "@/lib/audit";
import { sourceOf } from "@/lib/sources";
import { errorText, log } from "@/ops/log";
import { callMcpTool, type WriteTool } from "@/tools/mcp";

export type Approval = typeof approvals.$inferSelect;
export type Origin = "chat" | "messaging" | "routine" | "meeting" | "team";
/**
 * pending → running → done | failed | unknown; or rejected; or expired.
 * "unknown": the app didn't answer, so it may or may not have gone through. It is never sent
 * again automatically: its owner checks the app, then chooses "Send again anyway" or "Mark as done".
 */
export type ApprovalStatus = "pending" | "running" | "done" | "failed" | "unknown" | "rejected" | "expired";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 7;
/** Longer than any request that sends an action can live (300s): still "running" after this, the server stopped mid-send. */
export const RUNNING_MS = 6 * 60_000;

/** Why a decision was refused: already decided ("gone"), edited since it was opened ("changed"), or too old ("expired"). */
export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly reason: "gone" | "changed" | "expired",
  ) {
    super(message);
  }
}

/** "gmail_send_email" → Gmail; a live-tool server's proposals start with its name ("Test CRM: create_note"). */
export const appOf = (a: Pick<Approval, "mcpServerId" | "summary" | "tool">) => (a.mcpServerId ? a.summary.split(":")[0] : sourceOf(a.tool.split("_")[0]).label);

/** When a proposal made now stops waiting: the company's setting, or a week. */
async function expiryFor(db: Db, orgId: string, now: Date): Promise<Date> {
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const days = Number(org?.settings?.approvalExpiryDays);
  return new Date(now.getTime() + (days >= 1 && days <= 365 ? days : DEFAULT_EXPIRY_DAYS) * DAY_MS);
}

/** Letters and digits that can't be misread for each other (no 0/O, 1/I). */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

const appUrl = () => (process.env.ALRO_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** How someone approves from a messaging app. */
export const replyHint = (a: Pick<Approval, "code">) => `Reply "yes ${a.code}" to go ahead or "no ${a.code}" to drop it, or open ${appUrl()}/approvals`;

export interface ProposeContext {
  origin: Origin;
  /** A scheduled task: when the owner trusts it, its internal actions run without asking. */
  routine?: { id: string; trusted: boolean };
  /** Tell the person in their messaging apps (for proposals made while they weren't watching). */
  notify?: boolean;
  /**
   * Set when this run has read text that looked like instructions aimed at an assistant (src/agent/untrusted.ts).
   * The proposal carries the warning to its approver, and a trusted task doesn't run it on its own.
   */
  caution?: () => string | undefined;
  now?: Date;
}

interface Target {
  connectionId?: string;
  mcpServerId?: string;
  tool: string;
  def: Pick<ActionDef, "audience" | "summary" | "body">;
}

/** Records a proposal; runs it at once only for a trusted scheduled task. */
async function propose(db: Db, viewer: Viewer, target: Target, input: Record<string, unknown>, reason: string | undefined, ctx: ProposeContext) {
  const summary = target.def.summary(input);
  const body = target.def.body?.(input) ?? null;
  const audience = target.def.audience(input);
  const expiresAt = await expiryFor(db, viewer.orgId, ctx.now ?? new Date());
  const caution = ctx.caution?.() ?? null;
  let row: Approval | undefined;
  for (let attempt = 0; !row && attempt < 5; attempt++) {
    [row] = await db
      .insert(approvals)
      .values({
        orgId: viewer.orgId,
        personId: viewer.personId,
        connectionId: target.connectionId,
        mcpServerId: target.mcpServerId,
        tool: target.tool,
        input,
        summary,
        body,
        audience,
        reason,
        origin: ctx.origin,
        routineId: ctx.routine?.id,
        code: code(),
        expiresAt,
        caution,
        createdAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning();
  }
  if (!row) throw new Error("Couldn't record the proposal");

  // Trust covers work inside the company (a CRM note, a task, a team post). Anything that reaches a client,
  // vendor or the public still waits: a trusted task reads outside messages, and one could be written to steer it.
  // And never after reading something that tried to give the assistant orders: a person looks at that one.
  if (ctx.routine?.trusted && audience === "internal" && !caution) {
    const done = await decide(db, viewer, row.id, "approve", { approvedBy: "trusted task", now: ctx.now });
    return { status: done.status, summary, result: done.result ?? undefined, error: done.error ?? undefined, note: "Ran without asking: the owner trusts this scheduled task with internal actions." };
  }
  if (ctx.notify) {
    const preview = body ? `\n\n${body.length > 600 ? `${body.slice(0, 600)}…` : body}` : "";
    await notifyPerson(db, viewer.orgId, viewer.personId, `Waiting for your OK (${row.code}): ${summary}${reason ? `\nWhy: ${reason}` : ""}${caution ? `\nCheck first: ${caution}` : ""}${preview}\n\n${replyHint(row)}`, ctx.now);
  }
  return {
    status: "waiting for approval",
    code: row.code,
    summary,
    note: `Nothing has happened yet. It runs once approved under Approvals in ALRO, or with the reply "yes ${row.code}" in a linked messaging app.`,
  };
}

/**
 * Proposes an email from the person's own connected mailbox (Gmail or Outlook), for work done
 * while they weren't watching (meeting follow-ups). Undefined when they have no mailbox connected.
 */
export async function proposeEmail(db: Db, viewer: Viewer, email: EmailInput, reason: string, ctx: ProposeContext) {
  const [mailbox] = await db
    .select({ id: connections.id, provider: connections.provider })
    .from(connections)
    .where(and(eq(connections.orgId, viewer.orgId), eq(connections.ownerPersonId, viewer.personId), eq(connections.status, "active"), inArray(connections.provider, ["gmail", "outlook"])))
    .limit(1);
  const tool = mailbox && `${mailbox.provider}_send_email`;
  const def = tool ? providerOf(mailbox.provider)?.actions?.[tool] : undefined;
  if (!mailbox || !tool || !def) return undefined;
  return propose(db, viewer, { connectionId: mailbox.id, tool, def }, def.input.parse(email) as Record<string, unknown>, reason, ctx);
}

/** The approver-facing note added to every proposal tool; named so it can't clash with a tool's own arguments. */
const REASON_FIELD = "why_for_approver";
const REASON = z.string().describe("Why you are proposing this, in one sentence the approver will read");

/** Adds the approver-facing reason to an action's own input fields. */
function withReason(input: z.ZodType) {
  return input instanceof z.ZodObject ? input.extend({ [REASON_FIELD]: REASON }) : z.object({ input, [REASON_FIELD]: REASON });
}

function split(value: Record<string, unknown>, wrapped: boolean): { input: Record<string, unknown>; reason?: string } {
  const { [REASON_FIELD]: reason, ...rest } = value;
  return { input: wrapped ? (rest.input as Record<string, unknown>) : rest, reason: typeof reason === "string" ? reason : undefined };
}

/**
 * The actions this member can propose: one tool per action of every connected app they can
 * use (team connections, and personal ones they connected), plus live-tool server tools that
 * change things and have been switched on. Calling one only queues it for approval.
 */
export async function proposalTools(db: Db, viewer: Viewer, ctx: ProposeContext, writes: WriteTool[] = []): Promise<{ tools: ToolSet; names: string[] }> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.orgId, viewer.orgId), eq(connections.status, "active"), or(eq(connections.scope, "org"), eq(connections.ownerPersonId, viewer.personId))));
  const tools: ToolSet = {};
  // Their own accounts first: with a personal and a team connection to the same app, act as them.
  rows.sort((a, b) => Number(b.ownerPersonId === viewer.personId && b.scope === "personal") - Number(a.ownerPersonId === viewer.personId && a.scope === "personal"));
  for (const c of rows) {
    const actions = providerOf(c.provider)?.actions;
    if (!actions) continue;
    // A personal mailbox only ever sends as its owner.
    if (c.scope === "personal" && c.ownerPersonId !== viewer.personId) continue;
    for (const [name, def] of Object.entries(actions)) {
      if (tools[name]) continue;
      tools[name] = tool({
        description: `${def.description} This does NOT happen right away: it is queued for the asker's approval (in ALRO or by replying in a messaging app) and runs only once approved. Tell them it's waiting and give the code.`,
        inputSchema: withReason(def.input),
        execute: async (value: Record<string, unknown>) => {
          const { input, reason } = split(value, !(def.input instanceof z.ZodObject));
          return propose(db, viewer, { connectionId: c.id, tool: name, def }, def.input.parse(input) as Record<string, unknown>, reason, ctx);
        },
      });
    }
  }
  for (const w of writes) {
    if (tools[w.name]) continue;
    const def = {
      audience: () => "external" as const,
      summary: () => `${w.server}: ${w.tool}`,
      body: (input: Record<string, unknown>) => JSON.stringify(input, null, 2),
    };
    tools[w.name] = tool({
      description: `${w.description ?? w.tool} (in ${w.server}). This changes something, so it is queued for the asker's approval and runs only once approved.`,
      inputSchema: jsonSchema<Record<string, unknown>>({
        ...w.inputSchema,
        properties: { ...w.inputSchema.properties, [REASON_FIELD]: { type: "string", description: REASON.description } },
        required: [...(w.inputSchema.required ?? []), REASON_FIELD],
      }),
      execute: async (value) => {
        const { input, reason } = split(value, false);
        return propose(db, viewer, { mcpServerId: w.serverId, tool: w.tool, def }, input, reason, ctx);
      },
    });
  }
  return { tools, names: Object.keys(tools) };
}

/**
 * Does the approved thing in the app, once. Writes are never retried automatically: a retry
 * could send twice. The approval's id goes along as an idempotency key, for the apps that can
 * use one to refuse a second send (see ToolContext).
 */
async function perform(db: Db, a: Approval): Promise<{ url?: string; detail?: string }> {
  if (a.mcpServerId) {
    const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, a.mcpServerId));
    if (!server) throw new Error("That live-tool server was removed");
    // The approver may have edited the arguments (shown to them as JSON).
    let input: unknown = a.input;
    if (a.body) {
      try {
        input = JSON.parse(a.body);
      } catch {
        throw new Error("The edited arguments aren't valid JSON");
      }
    }
    const out = await callMcpTool(db, server, a.tool, input);
    return { detail: out };
  }
  const [c] = a.connectionId ? await db.select().from(connections).where(eq(connections.id, a.connectionId)) : [];
  if (!c || c.status === "revoked") throw new Error("That source is no longer connected");
  const provider = providerOf(c.provider);
  const def = provider?.actions?.[a.tool];
  if (!provider || !def) throw new Error(`${sourceOf(c.provider).label} can't do ${a.tool} any more`);
  const { api, credentials } = await sessionFor(db, provider, c);
  const input = a.body !== null && def.withBody ? def.withBody(def.input.parse(a.input), a.body) : def.input.parse(a.input);
  return def.run(api, input, { accountId: c.externalAccountId ?? "", credentials, idempotencyKey: a.id });
}

/**
 * Sends a claimed ("running") proposal and records how it ended: done, failed (the app said
 * no, nothing happened) or unknown (no answer: it may or may not have gone through).
 */
async function send(db: Db, claimed: Approval): Promise<Approval> {
  try {
    const result = await perform(db, claimed);
    const [row] = await db.update(approvals).set({ status: "done", result, error: null }).where(eq(approvals.id, claimed.id)).returning();
    return row;
  } catch (e) {
    const unknown = outcomeUnknown(e);
    const error = (unknown ? `${appOf(claimed)} didn't answer, so this may or may not have gone through. (${errorText(e)})` : errorText(e)).slice(0, 1000);
    log.warn("approval.not_done", { approvalId: claimed.id, tool: claimed.tool, status: unknown ? "unknown" : "failed", error: errorText(e) });
    const [row] = await db.update(approvals).set({ status: unknown ? "unknown" : "failed", error }).where(eq(approvals.id, claimed.id)).returning();
    return row;
  }
}

const owned = (viewer: Viewer, id: string) => and(eq(approvals.id, id), eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId));
/** Sent, but the server stopped before the answer was recorded: treated like "unknown". */
const crashed = (now: Date) => and(eq(approvals.status, "running"), lt(approvals.updatedAt, new Date(now.getTime() - RUNNING_MS)));
const unsettled = (now: Date) => or(eq(approvals.status, "unknown"), crashed(now));

/** Explains why a pending proposal couldn't be claimed, expiring it if that's the reason. */
async function refusal(db: Db, viewer: Viewer, id: string, revision: number | undefined, now: Date): Promise<ApprovalError> {
  const [row] = await db.select().from(approvals).where(owned(viewer, id));
  if (!row || row.status !== "pending") return new ApprovalError("That proposal was already decided or isn't yours", "gone");
  if (row.expiresAt && row.expiresAt <= now) {
    await expire(db, and(eq(approvals.id, id), eq(approvals.status, "pending")), now);
    return new ApprovalError("This waited too long and has expired. Ask ALRO again if it's still needed.", "expired");
  }
  if (revision !== undefined && row.revision !== revision) return new ApprovalError("This changed since you opened it. Read it again before approving.", "changed");
  return new ApprovalError("That proposal was already decided or isn't yours", "gone");
}

/**
 * Approves (and runs) or rejects one proposal. Only its owner can decide. A proposal is
 * claimed by moving it out of "pending" first, so a double click or two replies never run it twice.
 * `revision` is the version the approver was looking at: if the text has been edited since
 * (another tab, another device), approving is refused. A reply from a messaging app passes none
 * and approves the current text. An expired proposal can't be approved.
 */
export async function decide(
  db: Db,
  viewer: Viewer,
  id: string,
  decision: "approve" | "reject",
  opts: { body?: string; revision?: number; approvedBy?: string; now?: Date } = {},
): Promise<Approval> {
  const now = opts.now ?? new Date();
  const mine = and(owned(viewer, id), eq(approvals.status, "pending"));
  if (decision === "reject") {
    const [row] = await db.update(approvals).set({ status: "rejected", decidedAt: now }).where(mine).returning();
    if (!row) throw new ApprovalError("That proposal was already decided or isn't yours", "gone");
    await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "approval.reject", target: id, detail: { tool: row.tool } });
    return row;
  }
  const approvedBy = opts.approvedBy ?? "owner";
  const [claimed] = await db
    .update(approvals)
    .set({
      status: "running",
      decidedAt: now,
      approvedBy,
      // Approving with changed text is an edit too.
      ...(opts.body !== undefined ? { body: opts.body, revision: sql`${approvals.revision} + (case when ${approvals.body} is distinct from ${opts.body} then 1 else 0 end)` } : {}),
    })
    .where(and(mine, or(isNull(approvals.expiresAt), gt(approvals.expiresAt, now)), opts.revision === undefined ? undefined : eq(approvals.revision, opts.revision)))
    .returning();
  if (!claimed) throw await refusal(db, viewer, id, opts.revision, now);
  const row = await send(db, claimed);
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "approval.approve", target: id, detail: { tool: row.tool, by: approvedBy, revision: row.revision, outcome: row.status } });
  return row;
}

/**
 * Saves an edit to a waiting proposal's text without approving it. The revision goes up, so
 * anyone still looking at the old text can't approve it by mistake.
 */
export async function edit(db: Db, viewer: Viewer, id: string, body: string, revision: number, now = new Date()): Promise<Approval> {
  const [row] = await db
    .update(approvals)
    .set({ body, revision: sql`${approvals.revision} + 1` })
    .where(and(owned(viewer, id), eq(approvals.status, "pending"), eq(approvals.revision, revision)))
    .returning();
  if (!row) throw await refusal(db, viewer, id, revision, now);
  return row;
}

export const pendingFor = (db: Db, viewer: Viewer) =>
  db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt));

/** What was decided lately, including what expired and what needs checking in the app ("unknown"). */
export const recentFor = (db: Db, viewer: Viewer, limit = 20) =>
  db
    .select({
      ...getTableColumns(approvals),
      /** Still "running" long after any send could take: the server stopped mid-send, so it's shown as unknown. */
      crashed: sql<boolean>`${approvals.status} = 'running' and ${approvals.updatedAt} < now() - make_interval(secs => ${RUNNING_MS / 1000})`,
    })
    .from(approvals)
    .where(and(eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), inArray(approvals.status, ["done", "failed", "rejected", "running", "unknown", "expired"])))
    .orderBy(desc(approvals.updatedAt))
    .limit(limit);

const YES = /^(yes|y|ok|okay|approve|approved|send|go|go ahead|do it)$/i;
const NO = /^(no|n|reject|drop|cancel|don'?t|stop)$/i;

/**
 * A reply in a messaging app that decides a proposal: "yes K7QM" or "no K7QM". A bare "yes"/"no"
 * only counts when the last thing ALRO said in that chat was that one proposal's request, so a
 * "yes" to some other question never approves anything. Anything else returns undefined and goes to the agent.
 * The reply approves the text as it is now (there is no older copy on screen to protect against).
 */
export async function decideFromReply(db: Db, viewer: Viewer, text: string, now = new Date(), lastSaid?: string): Promise<string | undefined> {
  const m = text
    .trim()
    .replace(/[.!]+$/, "")
    .match(/^(.+?)(?:\s+([A-Za-z0-9]{4}))?$/);
  if (!m) return undefined;
  const [, word, given] = m;
  const verdict = YES.test(word) ? "approve" : NO.test(word) ? "reject" : undefined;
  if (!verdict) return undefined;
  const pending = await pendingFor(db, viewer);
  const asked = pending.filter((a) => lastSaid?.includes(a.code));
  const target = given ? pending.find((a) => a.code === given.toUpperCase()) : asked.length === 1 ? asked[0] : undefined;
  if (!target) {
    // "ok cool" isn't a code; a typed-in code ("yes ZZZZ") that matches nothing is worth saying so.
    if (given) return given === given.toUpperCase() ? `Nothing is waiting with the code ${given}.` : undefined;
    return asked.length > 1 ? `${asked.length} things are waiting. Say which: ${asked.map((a) => `"yes ${a.code}" (${a.summary})`).join(", ")}.` : undefined;
  }
  let row: Approval;
  try {
    row = await decide(db, viewer, target.id, verdict, { now });
  } catch (e) {
    if (e instanceof ApprovalError) return e.reason === "expired" ? `${target.summary}: that waited too long and has expired. Ask me again if it's still needed.` : `${e.message}.`;
    throw e;
  }
  if (row.status === "rejected") return `Dropped: ${row.summary}.`;
  if (row.status === "done") return `Done: ${row.summary}.${row.result?.url ? ` ${row.result.url}` : ""}`;
  if (row.status === "unknown") return `I can't tell if that went through: ${appOf(row)} didn't answer. Check ${appOf(row)} before sending it again. It's under Approvals, where you can send it again or mark it as done.`;
  return `That didn't go through: ${row.error ?? "unknown error"}. It's under Approvals if you want to try again.`;
}

/**
 * Puts a failed proposal back in the queue so it can be read and approved again (after fixing
 * the connection). Only for "failed", where the app said no and nothing happened. One whose
 * outcome is unknown is never requeued this way: see `sendAgain` and `markDone`.
 */
export async function retry(db: Db, viewer: Viewer, id: string, now = new Date()): Promise<void> {
  const expiresAt = await expiryFor(db, viewer.orgId, now);
  const [row] = await db
    .update(approvals)
    .set({ status: "pending", error: null, decidedAt: null, approvedBy: null, expiresAt, revision: sql`${approvals.revision} + 1` })
    .where(and(owned(viewer, id), eq(approvals.status, "failed")))
    .returning();
  if (row) await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "approval.retry", target: id, detail: { tool: row.tool, from: "failed" } });
}

/**
 * "Send again anyway": the owner has checked the app and wants an action with an unknown
 * outcome sent once more. It runs now, with the same idempotency key as the first time.
 */
export async function sendAgain(db: Db, viewer: Viewer, id: string, now = new Date()): Promise<Approval> {
  const [claimed] = await db
    .update(approvals)
    .set({ status: "running", decidedAt: now, error: null })
    .where(and(owned(viewer, id), unsettled(now)))
    .returning();
  if (!claimed) throw new ApprovalError("That was already settled or isn't yours", "gone");
  const row = await send(db, claimed);
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "approval.retry", target: id, detail: { tool: row.tool, from: "unknown", outcome: row.status } });
  return row;
}

/** "Mark as done": the owner checked the app and it did go through. Nothing is sent. */
export async function markDone(db: Db, viewer: Viewer, id: string, now = new Date()): Promise<void> {
  const [row] = await db
    .update(approvals)
    .set({ status: "done", error: null, result: { detail: "Marked as done after checking the app" } })
    .where(and(owned(viewer, id), unsettled(now)))
    .returning();
  if (!row) throw new ApprovalError("That was already settled or isn't yours", "gone");
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "approval.mark_done", target: id, detail: { tool: row.tool } });
}

async function expire(db: Db, where: ReturnType<typeof and>, now: Date): Promise<number> {
  const rows = await db.update(approvals).set({ status: "expired", decidedAt: now }).where(where).returning({ id: approvals.id, orgId: approvals.orgId, tool: approvals.tool, personId: approvals.personId });
  // The system did this, not the owner; who it was waiting for goes in the detail.
  for (const r of rows) await audit(db, { orgId: r.orgId, action: "approval.expire", target: r.id, detail: { tool: r.tool, waitingFor: r.personId } });
  return rows.length;
}

/**
 * The lifecycle's clockwork, run from the 15-minute tick for one company: waiting proposals
 * past their expiry become "expired", and ones left "running" by a server that stopped
 * mid-send become "unknown" (never sent again without their owner's say-so).
 */
export async function sweepApprovals(db: Db, orgId: string, now = new Date()): Promise<{ expired: number; unknown: number }> {
  const expired = await expire(db, and(eq(approvals.orgId, orgId), eq(approvals.status, "pending"), lte(approvals.expiresAt, now)), now);
  const lost = await db
    .update(approvals)
    .set({ status: "unknown", error: "ALRO stopped while this was being sent, so it may or may not have gone through." })
    .where(and(eq(approvals.orgId, orgId), crashed(now)))
    .returning({ id: approvals.id });
  return { expired, unknown: lost.length };
}
