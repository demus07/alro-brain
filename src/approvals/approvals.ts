import { randomInt } from "node:crypto";
import { jsonSchema, tool, type ToolSet } from "ai";
import { and, desc, eq, getTableColumns, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { notifyPerson } from "@/channels/links";
import { providerOf } from "@/connectors/registry";
import type { ActionDef } from "@/connectors/provider";
import { sessionFor } from "@/connectors/sync";
import type { Db } from "@/db/client";
import type { EmailInput } from "@/connectors/email-actions";
import { approvals, connections, mcpServers } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { sourceOf } from "@/lib/sources";
import { callMcpTool, type WriteTool } from "@/tools/mcp";

export type Approval = typeof approvals.$inferSelect;
export type Origin = "chat" | "messaging" | "routine" | "meeting" | "team";

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
        createdAt: ctx.now,
      })
      .onConflictDoNothing()
      .returning();
  }
  if (!row) throw new Error("Couldn't record the proposal");

  // Trust covers work inside the company (a CRM note, a task, a team post). Anything that reaches a client,
  // vendor or the public still waits: a trusted task reads outside messages, and one could be written to steer it.
  if (ctx.routine?.trusted && audience === "internal") {
    const done = await decide(db, viewer, row.id, "approve", { approvedBy: "trusted task" });
    return { status: done.status, summary, result: done.result ?? undefined, error: done.error ?? undefined, note: "Ran without asking: the owner trusts this scheduled task with internal actions." };
  }
  if (ctx.notify) {
    const preview = body ? `\n\n${body.length > 600 ? `${body.slice(0, 600)}…` : body}` : "";
    await notifyPerson(db, viewer.orgId, viewer.personId, `Waiting for your OK (${row.code}): ${summary}${reason ? `\nWhy: ${reason}` : ""}${preview}\n\n${replyHint(row)}`, ctx.now);
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

/** Does the approved thing in the app, once. Writes are never retried automatically: a retry could send twice. */
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
  return def.run(api, input, { accountId: c.externalAccountId ?? "", credentials });
}

/**
 * Approves (and runs) or rejects one proposal. Only its owner can decide. A proposal is
 * claimed by moving it out of "pending" first, so a double click or two replies never run it twice.
 */
export async function decide(
  db: Db,
  viewer: Viewer,
  id: string,
  decision: "approve" | "reject",
  opts: { body?: string; approvedBy?: string; now?: Date } = {},
): Promise<Approval> {
  const now = opts.now ?? new Date();
  const mine = and(eq(approvals.id, id), eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), eq(approvals.status, "pending"));
  if (decision === "reject") {
    const [row] = await db.update(approvals).set({ status: "rejected", decidedAt: now }).where(mine).returning();
    if (!row) throw new Error("That proposal was already decided or isn't yours");
    return row;
  }
  const [claimed] = await db
    .update(approvals)
    .set({ status: "running", decidedAt: now, approvedBy: opts.approvedBy ?? "owner", ...(opts.body !== undefined ? { body: opts.body } : {}) })
    .where(mine)
    .returning();
  if (!claimed) throw new Error("That proposal was already decided or isn't yours");
  try {
    const result = await perform(db, claimed);
    const [row] = await db.update(approvals).set({ status: "done", result }).where(eq(approvals.id, id)).returning();
    return row;
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    const [row] = await db.update(approvals).set({ status: "failed", error }).where(eq(approvals.id, id)).returning();
    return row;
  }
}

export const pendingFor = (db: Db, viewer: Viewer) =>
  db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt));

export const recentFor = (db: Db, viewer: Viewer, limit = 20) =>
  db
    .select({
      ...getTableColumns(approvals),
      /** Running far longer than any send takes: the process that ran it is gone. */
      stuck: sql<boolean>`${approvals.status} = 'running' and ${approvals.updatedAt} < now() - make_interval(secs => ${STUCK_MS / 1000})`,
    })
    .from(approvals)
    .where(and(eq(approvals.orgId, viewer.orgId), eq(approvals.personId, viewer.personId), inArray(approvals.status, ["done", "failed", "rejected", "running"])))
    .orderBy(desc(approvals.updatedAt))
    .limit(limit);

const YES = /^(yes|y|ok|okay|approve|approved|send|go|go ahead|do it)$/i;
const NO = /^(no|n|reject|drop|cancel|don'?t|stop)$/i;

/**
 * A reply in a messaging app that decides a proposal: "yes K7QM" or "no K7QM". A bare "yes"/"no"
 * only counts when the last thing ALRO said in that chat was that one proposal's request, so a
 * "yes" to some other question never approves anything. Anything else returns undefined and goes to the agent.
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
  const row = await decide(db, viewer, target.id, verdict, { now });
  if (row.status === "rejected") return `Dropped: ${row.summary}.`;
  if (row.status === "done") return `Done: ${row.summary}.${row.result?.url ? ` ${row.result.url}` : ""}`;
  return `That didn't go through: ${row.error ?? "unknown error"}. It's under Approvals if you want to try again.`;
}

/** After this long "running", the process that ran it is gone (a restart mid-send); it can be retried. */
export const STUCK_MS = 15 * 60_000;

/**
 * Puts a failed proposal back in the queue so it can be approved again (after fixing the
 * connection). One stuck in "running" can be too, but it may have gone through: the page says
 * to check the app first.
 */
export async function retry(db: Db, viewer: Viewer, id: string, now = new Date()) {
  await db
    .update(approvals)
    .set({ status: "pending", error: null })
    .where(
      and(
        eq(approvals.id, id),
        eq(approvals.personId, viewer.personId),
        or(eq(approvals.status, "failed"), and(eq(approvals.status, "running"), lt(approvals.updatedAt, new Date(now.getTime() - STUCK_MS)))),
      ),
    );
}
