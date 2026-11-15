import { and, eq, like, ne, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, connections, messages } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { writeBatch } from "@/ingest/writer";
import { readSecret, saveSecret } from "@/lib/secrets";
import { httpApi, ProviderError, withRetries, type Api } from "./api";
import { writeEvents } from "./events";
import { refreshTokens, type OAuthApp } from "./oauth";
import type { Provider } from "./provider";
import { providerOf } from "./registry";

/** What ALRO keeps (encrypted) for a connected account. */
export type StoredCredential =
  | { kind: "token"; values: Record<string, string> }
  | { kind: "oauth"; app: OAuthApp; accessToken: string; refreshToken?: string; expiresAt: number };

export interface SyncOutcome {
  provider: string;
  connectionId: string;
  messages?: number;
  events?: number;
  error?: string;
}

type ConnectionRow = typeof connections.$inferSelect;

/** The provider API for a credential. `persist` is called when a sign-in token is refreshed. */
export function apiFor(provider: Provider, credential: StoredCredential, persist?: (c: StoredCredential) => Promise<void>): Api {
  if (provider.auth.kind === "token") {
    if (credential.kind !== "token") throw new Error(`${provider.id} needs a token`);
    return provider.auth.api(credential.values);
  }
  if (credential.kind !== "oauth") throw new Error(`${provider.id} needs a sign-in`);
  let current = credential;
  return httpApi({
    baseUrl: provider.auth.baseUrl,
    hosts: provider.auth.hosts,
    headers: async () => {
      if (current.expiresAt - Date.now() < 60_000) {
        if (!current.refreshToken) throw new ProviderError("The sign-in has expired. Reconnect this source in Settings.", 401);
        const fresh = await refreshTokens(current.app, current.refreshToken);
        current = { ...current, ...fresh, refreshToken: fresh.refreshToken ?? current.refreshToken };
        await persist?.(current);
      }
      return { authorization: `Bearer ${current.accessToken}` };
    },
  });
}

/** The API and typed-in credentials for a stored connection. */
export async function sessionFor(db: Db, provider: Provider, c: Pick<ConnectionRow, "id" | "orgId">) {
  const credential = await readSecret<StoredCredential>(db, "connection", c.id);
  if (!credential) throw new ProviderError("No saved credential. Reconnect this source in Settings.", 401);
  const api = apiFor(provider, credential, (fresh) => saveSecret(db, c.orgId, "connection", c.id, fresh));
  return { api, credentials: credential.kind === "token" ? credential.values : {} };
}

/**
 * Connects an account: checks the credential against the provider, then saves the
 * connection and its encrypted credential. Connecting the same account again
 * replaces the credential (that's how a broken connection is repaired).
 */
export async function connectAccount(db: Db, viewer: Viewer, provider: Provider, credential: StoredCredential): Promise<string> {
  // A sign-in token refreshed while checking is the one worth saving.
  let latest = credential;
  const api = apiFor(provider, credential, async (fresh) => void (latest = fresh));
  const { accountId, label } = await provider.identify(api, credential.kind === "token" ? credential.values : {});
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.orgId, viewer.orgId), eq(connections.provider, provider.id), eq(connections.externalAccountId, accountId)));
  const id =
    existing?.id ??
    (
      await db
        .insert(connections)
        .values({ orgId: viewer.orgId, provider: provider.id, scope: provider.scope, ownerPersonId: viewer.personId, externalAccountId: accountId, label })
        .returning({ id: connections.id })
    )[0].id;
  if (existing) await db.update(connections).set({ status: "active", lastError: null, label, updatedAt: new Date() }).where(eq(connections.id, id));
  await saveSecret(db, viewer.orgId, "connection", id, latest);
  return id;
}

/** Every connected source in the org that syncs, one after another. */
export async function syncOrg(db: Db, orgId: string, now = new Date()): Promise<SyncOutcome[]> {
  const rows = await db.select().from(connections).where(and(eq(connections.orgId, orgId), ne(connections.status, "revoked")));
  const outcomes: SyncOutcome[] = [];
  for (const c of rows) if (providerOf(c.provider)?.sync) outcomes.push(await syncConnection(db, c, now));
  return outcomes;
}

/**
 * Fetches what's new, writes it like any upload (same people, threads, permissions),
 * then stores the new cursor. A failure is recorded on the connection, not thrown.
 */
export async function syncConnection(db: Db, c: ConnectionRow, now = new Date()): Promise<SyncOutcome> {
  const provider = providerOf(c.provider);
  const outcome: SyncOutcome = { provider: c.provider, connectionId: c.id };
  try {
    if (!provider?.sync) throw new Error(`${c.provider} doesn't sync`);
    const { api, credentials } = await sessionFor(db, provider, c);
    const fetched = await provider.sync(withRetries(api), c.cursor ?? undefined, { credentials, accountId: c.externalAccountId ?? "", now });
    const written = await writeBatch(
      db,
      c.orgId,
      {
        // Always this connection, whatever the fetcher called it.
        connection: { provider: c.provider, scope: c.scope, externalAccountId: c.externalAccountId ?? "" },
        people: fetched.people ?? [],
        threads: fetched.threads ?? [],
        messages: fetched.messages ?? [],
        records: fetched.records,
      },
      c.cursor ? "incremental" : "backfill",
      c.ownerPersonId ?? undefined,
    );
    if (fetched.versions) await retireOldVersions(db, c.id, fetched.versions);
    if (fetched.events && c.ownerPersonId) outcome.events = await writeEvents(db, c.orgId, c.id, c.ownerPersonId, fetched.events);
    await db.update(connections).set({ cursor: fetched.cursor, lastSyncedAt: now, lastError: null, status: "active", updatedAt: new Date() }).where(eq(connections.id, c.id));
    outcome.messages = written.messages.inserted;
  } catch (e) {
    outcome.error = e instanceof Error ? e.message : String(e);
    console.error(`sync failed for ${c.provider} ${c.id}`, outcome.error);
    // A refused credential needs the person; anything else is retried on the next run.
    const refused = e instanceof ProviderError && (e.status === 401 || e.status === 403);
    await db
      .update(connections)
      .set({ lastError: outcome.error.slice(0, 1000), status: refused ? "error" : c.status, updatedAt: new Date() })
      .where(eq(connections.id, c.id));
  }
  return outcome;
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
