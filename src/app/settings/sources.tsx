import { and, count, eq, isNull, sql } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { connections, messages, people } from "@/db/schema";
import { withScope } from "@/db/scope";
import { CATALOG, isUpload, sourceOf } from "@/lib/sources";
import { getViewer } from "@/lib/viewer";
import { nangoConfigured } from "@/connectors/nango";
import { isLive } from "@/connectors/sync";
import { connectSource, importConnected, syncNow } from "./actions";

const STALE_MS = 24 * 60 * 60 * 1000;

/** Settings → Sources: every connected source, its health, and what can be added. */
export async function Sources() {
  await connection();
  let data;
  try {
    data = await load();
  } catch (e) {
    return (
      <p className="muted small">Can&apos;t reach the database: {(e as Error).message}</p>
    );
  }
  const { sources, viewer } = data;
  const connected = new Set(sources.map((s) => sourceOf(s.provider).key));

  return (
    <div className="settings-sources">
      <p className="label">Connected · {sources.length}</p>
      {sources.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ul className="sources">
        {sources.map((s) => {
          const info = sourceOf(s.provider);
          const health =
            s.status !== "active" ? "bad" : isUpload(s.provider) ? "upload" : s.stale ? "stale" : "ok";
          return (
            <li key={s.id} className="source">
              <span className="mark">{info.mark}</span>
              <span className="source-text">
                <span className="source-name">
                  {info.label}
                  {isUpload(s.provider) && <span className="tag">export</span>}
                </span>
                <span className="muted small truncate">
                  {s.scope === "personal" ? (s.owner === viewer.displayName ? "yours" : (s.owner ?? "personal")) : "whole team"} · {s.messages.toLocaleString("en-US")} msgs
                </span>
              </span>
              {s.live && (
                <form action={syncNow} className="actions">
                  <input type="hidden" name="id" value={s.id} />
                  <button className="chip-button">Sync now</button>
                </form>
              )}
              <span className={`dot ${s.lastError ? "bad" : health}`} title={s.lastError ?? (health === "upload" ? "Imported from an export" : health)} />
            </li>
          );
        })}
      </ul>

      <p className="label">Add a source</p>
      <ul className="sources">
        {CATALOG.filter((k) => !connected.has(k)).map((k) => {
          const info = sourceOf(k);
          const live = isLive(k);
          return (
            <li key={k} className={live && nangoConfigured() ? "source" : "source dim"}>
              <span className="mark">{info.mark}</span>
              <span className="source-name">{info.label}</span>
              {live && nangoConfigured() ? (
                <form action={connectSource} className="actions">
                  <input type="hidden" name="provider" value={k} />
                  <button className="chip-button">Connect</button>
                </form>
              ) : (
                <span className="tag" title={live ? "Set NANGO_SECRET_KEY in .env.local" : undefined}>
                  {live ? "needs Nango" : "soon"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {nangoConfigured() && (
        <form action={importConnected} className="actions">
          <button className="chip-button">Import what I&apos;ve connected</button>
          <span className="muted small">After connecting in Nango, come back and import. The first sync reads the last 90 days.</span>
        </form>
      )}
      <Link href="/upload" className="link small">
        Upload an export →
      </Link>
    </div>
  );
}

async function load() {
  const viewer = await getViewer();
  const db = getDb();
  const rows = await withScope(db, viewer, (tx) =>
    tx
      .select({
        id: connections.id,
        provider: connections.provider,
        scope: connections.scope,
        status: connections.status,
        stale: sql<boolean>`coalesce(${connections.lastSyncedAt} < now() - make_interval(secs => ${STALE_MS / 1000}), true)`,
        live: sql<boolean>`${connections.nangoConnectionId} is not null`,
        lastError: connections.lastError,
        owner: people.displayName,
      })
      .from(connections)
      .leftJoin(people, eq(people.id, connections.ownerPersonId))
      .orderBy(connections.provider),
  );
  // Counts only, no content, so they're read as the owner, filtered by org (as on /connectors).
  const live = and(eq(messages.orgId, viewer.orgId), isNull(messages.deletedAt));
  const counts = await db.select({ id: messages.connectionId, n: count() }).from(messages).where(live).groupBy(messages.connectionId);
  const byId = new Map(counts.map((c) => [c.id, c.n]));
  return { viewer, sources: rows.map((r) => ({ ...r, messages: byId.get(r.id) ?? 0 })) };
}
