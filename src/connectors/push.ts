import { and, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { connections } from "@/db/schema";
import { derivedToken, matchesDerivedToken } from "@/lib/secrets";
import { log, errorText } from "@/ops/log";
import { runJob } from "@/ops/jobs";
import { processAndRepair } from "@/ops/repair";
import { limitKey, rateLimit } from "@/platform/rate-limit";
import { PushNotConfigured } from "./provider";
import { providerOf } from "./registry";
import { sessionFor, syncConnection } from "./sync";

/*
 * Instant updates. A source calls ALRO's secret address for its connection when something changes, and ALRO
 * syncs that one connection at once and processes what arrived, instead of waiting for the 15-minute poll.
 * What the call says is never trusted or stored: it only means "look again", and the data itself is read
 * through the connection's own credentials. So a forged call can at worst cause one extra sync. The poll stays
 * as the safety net for anything the source fails to announce.
 */

/** A second push right after a sync waits this long, so a burst of changes becomes one or two syncs. */
const SETTLE_MS = 5_000;
/** A sync that started this long ago and never finished (the server stopped) no longer blocks the next. */
const CLAIM_MS = 3 * 60_000;
/** At most this many pushes per source per hour; past it the poll still catches up. */
const PUSH_LIMIT = 600;
/** A failed registration isn't tried again for this long. */
const RETRY_REGISTER_MS = 6 * 60 * 60_000;
/** Subscriptions that stop sending within this long are renewed. */
const RENEW_BEFORE_MS = 12 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ConnectionRow = typeof connections.$inferSelect;

/** The public address of this deployment, if it has one. Without it nothing outside can call in, so nothing is registered. */
export const pushBase = () => process.env.ALRO_APP_URL?.replace(/\/$/, "");

export const pushUrl = (base: string, connectionId: string) => `${base}/api/hooks/${connectionId}/${derivedToken("push", connectionId)}`;
/** One address for every Gmail mailbox: Google Pub/Sub delivers one topic's messages to one URL. */
export const gmailPushUrl = (base: string) => `${base}/api/hooks/gmail/${derivedToken("push", "gmail")}`;

/** Where to paste the address, for sources that can't be set up automatically. */
export const PUSH_HINTS: Record<string, string> = {
  slack: "Slack app → Event Subscriptions → Request URL.",
  stripe: "Stripe Dashboard → Developers → Webhooks → Add endpoint.",
  razorpay: "Razorpay Dashboard → Account & Settings → Webhooks → Add new webhook.",
  shopify: "Shopify admin → Settings → Notifications → Webhooks.",
  github: "Repository → Settings → Webhooks → Add webhook (content type application/json).",
  gitlab: "Project → Settings → Webhooks.",
  hubspot: "HubSpot private app → Webhooks (or a workflow's Send a webhook action).",
  zendesk: "Admin Center → Apps and integrations → Webhooks.",
  freshdesk: "Admin → Workflows → Automations → Trigger webhook.",
  intercom: "Developer Hub → your app → Webhooks.",
  linear: "Settings → API → Webhooks.",
  asana: "Create a webhook through Asana's API pointing here, or use a rule that calls a webhook.",
  clickup: "Space settings → Integrations → Webhooks.",
  jira: "Jira settings → System → WebHooks.",
  pipedrive: "Settings → Tools and apps → Webhooks.",
  "zoho-crm": "Setup → Automation → Actions → Webhooks.",
  salesforce: "Flow or Outbound Message that calls this address.",
  xero: "Xero developer portal → your app → Webhooks.",
  quickbooks: "Intuit developer portal → your app → Webhooks.",
  notion: "Notion integration → Webhooks.",
  fireflies: "Fireflies → Integrations → Webhooks.",
  fathom: "Fathom → Settings → API access → Webhooks.",
  zoom: "Zoom Marketplace app → Feature → Event Subscriptions.",
};

/** What a person sees under a source: automatic, or where to paste the address. */
export function pushSetup(c: Pick<ConnectionRow, "provider" | "pushExpiresAt">): { mode: "automatic" | "paste" | "gmail"; hint?: string } {
  const provider = providerOf(c.provider);
  if (provider?.push) return { mode: c.provider === "gmail" ? "gmail" : "automatic" };
  return { mode: "paste", hint: PUSH_HINTS[c.provider] ?? "The app's webhook or notification settings." };
}

export type PushResult = "accepted" | "forbidden" | "unknown" | "limited";

/**
 * Checks the address's secret, notes that the source reported a change, and says whether to sync.
 * `connectionId` is "gmail" for the shared Gmail address (see `receiveGmailPush`).
 */
export async function receivePush(db: Db, connectionId: string, token: string, now = new Date()): Promise<PushResult> {
  if (!UUID.test(connectionId)) return "unknown";
  if (!matchesDerivedToken("push", connectionId, token)) return "forbidden";
  if (!(await rateLimit(db, limitKey("push", connectionId), PUSH_LIMIT, 3600, now)).ok) return "limited";
  const [c] = await db
    .update(connections)
    .set({ lastPushAt: now })
    .where(and(eq(connections.id, connectionId), ne(connections.status, "revoked")))
    .returning({ id: connections.id });
  return c ? "accepted" : "unknown";
}

/** A Google Pub/Sub push: the message names the mailbox that changed. Returns the connections to sync. */
export async function receiveGmailPush(db: Db, token: string, body: unknown, now = new Date()): Promise<{ result: PushResult; connectionIds: string[] }> {
  if (!matchesDerivedToken("push", "gmail", token)) return { result: "forbidden", connectionIds: [] };
  let mailbox: string | undefined;
  try {
    const data = (body as { message?: { data?: string } })?.message?.data;
    mailbox = data ? (JSON.parse(Buffer.from(data, "base64").toString("utf8")) as { emailAddress?: string }).emailAddress?.toLowerCase() : undefined;
  } catch {
    mailbox = undefined;
  }
  if (!mailbox) return { result: "accepted", connectionIds: [] };
  if (!(await rateLimit(db, limitKey("push", "gmail", mailbox), PUSH_LIMIT, 3600, now)).ok) return { result: "limited", connectionIds: [] };
  const found = await db
    .update(connections)
    .set({ lastPushAt: now })
    .where(and(eq(connections.provider, "gmail"), sql`lower(${connections.externalAccountId}) = ${mailbox}`, ne(connections.status, "revoked")))
    .returning({ id: connections.id });
  return { result: "accepted", connectionIds: found.map((c) => c.id) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Takes the right to sync this connection now; false when another run already has it. */
async function claim(db: Db, id: string, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const rows = await db
    .update(connections)
    .set({ pushState: sql`jsonb_set(coalesce(${connections.pushState}, '{}'::jsonb), '{syncingSince}', to_jsonb(${now.toISOString()}::text))` })
    .where(and(eq(connections.id, id), sql`((${connections.pushState}->>'syncingSince') is null or (${connections.pushState}->>'syncingSince')::timestamptz < ${stale}::timestamptz)`))
    .returning({ id: connections.id });
  return rows.length > 0;
}

const release = (db: Db, id: string) =>
  db
    .update(connections)
    .set({ pushState: sql`coalesce(${connections.pushState}, '{}'::jsonb) - 'syncingSince'` })
    .where(eq(connections.id, id));

export interface PushSyncResult {
  rounds: number;
  messages: number;
  skipped?: "busy" | "up to date" | "gone";
}

/**
 * Syncs one connection because its source said something changed, then processes what arrived. A change that
 * comes in while this runs is picked up by another round; two runs never sync the same connection at once.
 */
export async function runPushSync(db: Db, connectionId: string, opts: { now?: () => Date; wait?: (ms: number) => Promise<void> } = {}): Promise<PushSyncResult> {
  const clock = opts.now ?? (() => new Date());
  const wait = opts.wait ?? sleep;
  const result: PushSyncResult = { rounds: 0, messages: 0 };
  for (let round = 0; round < 3; round++) {
    const [c] = await db.select().from(connections).where(eq(connections.id, connectionId));
    if (!c || c.status === "revoked") return { ...result, skipped: "gone" };
    // The last sync started after the last push: it already saw the change.
    if (c.lastSyncedAt && c.lastPushAt && c.lastSyncedAt >= c.lastPushAt) return result.rounds ? result : { ...result, skipped: "up to date" };
    if (c.lastSyncedAt) await wait(Math.max(0, SETTLE_MS - (clock().getTime() - c.lastSyncedAt.getTime())));
    const started = clock();
    if (!(await claim(db, connectionId, started))) return result.rounds ? result : { ...result, skipped: "busy" };
    try {
      const fresh = (await db.select().from(connections).where(eq(connections.id, connectionId)))[0];
      const outcome = await syncConnection(db, fresh, started);
      result.rounds++;
      result.messages += outcome.messages ?? 0;
      if (outcome.error) return result;
    } finally {
      await release(db, connectionId);
    }
  }
  return result;
}

/** What the route runs after answering: sync the connection, then process the company's new messages. */
export async function pushAndProcess(db: Db, connectionId: string, models: Models) {
  const [c] = await db.select({ orgId: connections.orgId }).from(connections).where(eq(connections.id, connectionId));
  if (!c) return;
  const synced = await runJob(db, { job: "push-sync", orgId: c.orgId }, () => runPushSync(db, connectionId));
  if (synced.ok && synced.result.messages) await runJob(db, { job: "process", orgId: c.orgId }, () => processAndRepair(db, c.orgId, models));
}

export type RegisterResult = { status: "registered"; expiresAt: Date } | { status: "manual"; reason?: string } | { status: "unavailable" } | { status: "failed"; error: string };

/**
 * Asks a source to send its changes to ALRO, when it can be done from here (Gmail, Outlook). Needs a public
 * address (ALRO_APP_URL). Sources that can't are set up by pasting the address in (see PUSH_HINTS).
 */
export async function registerPush(db: Db, c: ConnectionRow, now = new Date()): Promise<RegisterResult> {
  const base = pushBase();
  const provider = providerOf(c.provider);
  if (!base || !provider?.push) return { status: "unavailable" };
  try {
    const { api, credentials } = await sessionFor(db, provider, c);
    const url = c.provider === "gmail" ? gmailPushUrl(base) : pushUrl(base, c.id);
    const { expiresAt, state } = await provider.push.register(api, { accountId: c.externalAccountId ?? "", credentials, url, state: c.pushState ?? undefined, now });
    await db
      .update(connections)
      .set({ pushExpiresAt: expiresAt, pushState: sql`(coalesce(${connections.pushState}, '{}'::jsonb) - 'registerFailedAt') || ${JSON.stringify(state ?? {})}::jsonb` })
      .where(eq(connections.id, c.id));
    return { status: "registered", expiresAt };
  } catch (e) {
    if (e instanceof PushNotConfigured) return { status: "manual", reason: e.message };
    log.warn("push.register_failed", { connectionId: c.id, provider: c.provider, error: errorText(e) });
    await db
      .update(connections)
      .set({ pushState: sql`coalesce(${connections.pushState}, '{}'::jsonb) || ${JSON.stringify({ registerFailedAt: now.toISOString() })}::jsonb` })
      .where(eq(connections.id, c.id));
    return { status: "failed", error: errorText(e) };
  }
}

/**
 * Renews subscriptions that are about to lapse and sets up sources that have none yet. Called from the tick.
 * A source whose last attempt failed is left alone for a few hours.
 */
export async function renewPushes(db: Db, now = new Date()): Promise<{ registered: number; failed: number }> {
  if (!pushBase()) return { registered: 0, failed: 0 };
  const due = await db
    .select()
    .from(connections)
    .where(and(eq(connections.status, "active"), or(isNull(connections.pushExpiresAt), lt(connections.pushExpiresAt, new Date(now.getTime() + RENEW_BEFORE_MS)))));
  const stats = { registered: 0, failed: 0 };
  for (const c of due) {
    if (!providerOf(c.provider)?.push) continue;
    const failedAt = typeof c.pushState?.registerFailedAt === "string" ? Date.parse(c.pushState.registerFailedAt) : 0;
    if (failedAt && now.getTime() - failedAt < RETRY_REGISTER_MS) continue;
    const r = await registerPush(db, c, now);
    if (r.status === "registered") stats.registered++;
    else if (r.status === "failed") stats.failed++;
  }
  return stats;
}

/** Sources that were registered and are still listening, for the Settings page. */
export const listening = (db: Db, orgId: string) =>
  db.select({ id: connections.id }).from(connections).where(and(eq(connections.orgId, orgId), isNotNull(connections.pushExpiresAt)));
