import { and, eq, isNotNull, like, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, connections, messages } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { writeBatch } from "@/ingest/writer";
import { fetchGmail, type GmailCursor } from "./gmail";
import { listConnections, ProviderError, proxyApi, type Api } from "./nango";
import { fetchNotion, type NotionCursor } from "./notion";
import { fetchSlack, type SlackCursor } from "./slack";

/** Live sources and their Nango integration ids (as created in the Nango dashboard). */
export const LIVE = {
  slack: { label: "Slack", integration: () => process.env.ALRO_NANGO_SLACK ?? "slack" },
  gmail: { label: "Gmail", integration: () => process.env.ALRO_NANGO_GMAIL ?? "google-mail" },
  notion: { label: "Notion", integration: () => process.env.ALRO_NANGO_NOTION ?? "notion" },
} as const;
export type LiveProvider = keyof typeof LIVE;
export const isLive = (p: string): p is LiveProvider => p in LIVE;
const providerOf = (integration: string) => (Object.keys(LIVE) as LiveProvider[]).find((p) => LIVE[p].integration() === integration);

export const tagsFor = (viewer: Viewer) => ({ end_user_id: viewer.personId, organization_id: viewer.orgId });

export interface SyncOutcome {
  provider: LiveProvider;
  connectionId?: string;
  messages?: number;
  error?: string;
}

/** Connections this person made in Nango that ALRO hasn't seen yet: each gets its first (backfill) sync. */
export async function adoptConnections(db: Db, viewer: Viewer): Promise<SyncOutcome[]> {
  const theirs = await listConnections(tagsFor(viewer));
  const known = new Set(
    (await db.select({ id: connections.nangoConnectionId }).from(connections).where(and(eq(connections.orgId, viewer.orgId), isNotNull(connections.nangoConnectionId)))).map((c) => c.id),
  );
  const outcomes: SyncOutcome[] = [];
  for (const c of theirs) {
    const provider = providerOf(c.provider_config_key);
    if (!provider || known.has(c.connection_id)) continue;
    outcomes.push(await syncConnection(db, viewer.orgId, { provider, nangoConnectionId: c.connection_id, ownerPersonId: viewer.personId }));
  }
  return outcomes;
}

/** Every live connection in the org, one after another. */
export async function syncOrg(db: Db, orgId: string): Promise<SyncOutcome[]> {
  const live = await db.select().from(connections).where(and(eq(connections.orgId, orgId), isNotNull(connections.nangoConnectionId), ne(connections.status, "revoked")));
  const outcomes: SyncOutcome[] = [];
  for (const c of live) {
    if (!isLive(c.provider)) continue;
    outcomes.push(await syncConnection(db, orgId, { provider: c.provider, nangoConnectionId: c.nangoConnectionId!, ownerPersonId: c.ownerPersonId ?? undefined, connectionId: c.id, cursor: c.cursor ?? undefined }));
  }
  return outcomes;
}

/**
 * Fetches what's new, writes it like any upload (same people, threads, permissions),
 * then stores the new cursor. A failure is recorded on the connection, not thrown.
 */
export async function syncConnection(
  db: Db,
  orgId: string,
  c: { provider: LiveProvider; nangoConnectionId: string; ownerPersonId?: string; connectionId?: string; cursor?: Record<string, unknown> },
): Promise<SyncOutcome> {
  const api = withRetries(proxyApi(c.nangoConnectionId, LIVE[c.provider].integration()));
  const kind = c.cursor ? "incremental" : "backfill";
  try {
    const fetched =
      c.provider === "slack"
        ? await fetchSlack(api, c.cursor as SlackCursor | undefined)
        : c.provider === "gmail"
          ? await fetchGmail(api, c.cursor as GmailCursor | undefined)
          : await fetchNotion(api, c.nangoConnectionId, c.cursor as NotionCursor | undefined);
    const written = await writeBatch(db, orgId, fetched.batch, kind, c.ownerPersonId);
    if ("versions" in fetched) await retireOldVersions(db, written.connectionId, fetched.versions);
    await db
      .update(connections)
      .set({ nangoConnectionId: c.nangoConnectionId, cursor: fetched.cursor as Record<string, unknown>, lastSyncedAt: new Date(), lastError: null, status: "active", updatedAt: new Date() })
      .where(eq(connections.id, written.connectionId));
    return { provider: c.provider, connectionId: written.connectionId, messages: written.messages.inserted };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`sync failed for ${c.provider} ${c.nangoConnectionId}`, error);
    if (c.connectionId) await db.update(connections).set({ lastError: error.slice(0, 1000), updatedAt: new Date() }).where(eq(connections.id, c.connectionId));
    return { provider: c.provider, connectionId: c.connectionId, error };
  }
}

/**
 * Edited documents arrive as new versions; older versions are marked deleted and their
 * search chunks dropped, so answers only see the current text.
 */
export async function retireOldVersions(db: Db, connectionId: string, current: Map<string, string>) {
  for (const [docId, latest] of current) {
    const old = await db
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(and(eq(messages.connectionId, connectionId), like(messages.externalId, `${docId}@%`), ne(messages.externalId, latest), sql`${messages.deletedAt} is null`))
      .returning({ id: messages.id });
    if (old.length) await db.delete(chunks).where(sql`${chunks.messageIds} && ${`{${old.map((o) => o.id).join(",")}}`}::uuid[]`);
  }
}


/** Network blips, rate limits and provider 5xx: worth another try. Auth and bad requests aren't. */
export const transient = (e: unknown) =>
  e instanceof ProviderError ? e.status === 429 || e.status >= 500 : /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(String(e));

/** Retries each provider call up to 3 times with growing waits (1s, 4s, 16s) on transient errors. */
export function withRetries(api: Api, waits = [1000, 4000, 16000]): Api {
  return async (method, path, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(method, path, opts);
      } catch (e) {
        if (attempt >= waits.length || !transient(e)) throw e;
        await new Promise((r) => setTimeout(r, waits[attempt]));
      }
    }
  };
}
