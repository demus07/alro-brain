import { and, count, eq, isNull, sql } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { oauthConfigured, oauthEnvNames } from "@/connectors/oauth";
import { PROVIDERS, providerOf } from "@/connectors/registry";
import { getDb } from "@/db/client";
import { connections, events, messages, people } from "@/db/schema";
import { withScope } from "@/db/scope";
import { secretsConfigured } from "@/lib/secrets";
import { COMING, isUpload, sourceOf, UPLOAD_ONLY } from "@/lib/sources";
import { getViewer } from "@/lib/viewer";
import { syncNow } from "./actions";
import { ConnectForm } from "./connect-form";
import { DeleteSource } from "./delete-source";

const STALE_MS = 24 * 60 * 60 * 1000;

/** Settings → Sources: every connected source, its health, and what can be added. */
export async function Sources() {
  await connection();
  let data;
  try {
    data = await load();
  } catch (e) {
    return <p className="muted small">Can&apos;t reach the database: {(e as Error).message}</p>;
  }
  const { sources } = data;
  // Personal sources (a mailbox, a calendar) can be connected by each person; team ones once.
  const taken = new Set(sources.filter((s) => !isUpload(s.provider) && (s.scope === "org" || s.mine)).map((s) => s.provider));
  const available = [...PROVIDERS.values()].filter((p) => !taken.has(p.id));

  return (
    <div className="settings-sources">
      <p className="label">Connected · {sources.length}</p>
      {sources.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ul className="sources">
        {sources.map((s) => {
          const info = sourceOf(s.provider);
          const provider = providerOf(s.provider);
          const health = s.status !== "active" ? "bad" : isUpload(s.provider) ? "upload" : provider?.sync && s.stale ? "stale" : "ok";
          const what = provider && !provider.sync ? "live lookups" : s.events ? `${s.events.toLocaleString("en-US")} events` : `${s.messages.toLocaleString("en-US")} msgs`;
          return (
            <li key={s.id} className="source">
              <span className="mark">{info.mark}</span>
              <span className="source-text">
                <span className="source-name">
                  {info.label}
                  {isUpload(s.provider) && <span className="tag">export</span>}
                </span>
                <span className="muted small truncate">
                  {[s.label, s.scope === "personal" ? (s.mine ? "yours" : (s.owner ?? "personal")) : "whole team", what].filter(Boolean).join(" · ")}
                </span>
                {s.lastError && <span className="error small truncate">{s.lastError}</span>}
              </span>
              {provider?.sync && (
                <form action={syncNow} className="actions">
                  <input type="hidden" name="id" value={s.id} />
                  <button className="chip-button">Sync now</button>
                </form>
              )}
              {(s.scope !== "personal" || s.mine) && <DeleteSource id={s.id} label={info.label} />}
              <span className={`dot ${s.lastError ? "bad" : health}`} title={s.lastError ?? (health === "upload" ? "Imported from an export" : health)} />
            </li>
          );
        })}
      </ul>

      <p className="label">Add a source</p>
      {!secretsConfigured() && <p className="warn small">Set ALRO_SECRET_KEY in .env.local (openssl rand -base64 32) so tokens can be stored encrypted.</p>}
      <ul className="sources">
        {available.map((p) => {
          const info = sourceOf(p.id);
          if (p.auth.kind === "token") {
            return (
              <li key={p.id}>
                <ConnectForm provider={p.id} label={info.label} mark={info.mark} fields={p.auth.fields} setup={p.auth.setup} docsUrl={p.auth.docsUrl} />
              </li>
            );
          }
          const ready = oauthConfigured(p.auth.app);
          return (
            <li key={p.id} className={ready ? "source" : "source dim"}>
              <span className="mark">{info.mark}</span>
              <span className="source-name">{info.label}</span>
              {ready ? (
                <a className="chip-button" href={`/api/oauth/start?provider=${p.id}`}>
                  Sign in
                </a>
              ) : (
                <span className="tag" title={`Register a ${p.auth.app === "google" ? "Google Cloud" : "Microsoft Entra"} app and set ${oauthEnvNames(p.auth.app)}`}>
                  needs {p.auth.app === "google" ? "Google" : "Microsoft"} app
                </span>
              )}
            </li>
          );
        })}
        {UPLOAD_ONLY.map((k) => (
          <li key={k} className="source">
            <span className="mark">{sourceOf(k).mark}</span>
            <span className="source-name">{sourceOf(k).label}</span>
            <Link className="chip-button" href="/upload">
              Upload
            </Link>
          </li>
        ))}
        {COMING.map((k) => (
          <li key={k} className="source dim">
            <span className="mark">{sourceOf(k).mark}</span>
            <span className="source-name">{sourceOf(k).label}</span>
            <span className="tag">soon</span>
          </li>
        ))}
      </ul>
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
        label: connections.label,
        stale: sql<boolean>`coalesce(${connections.lastSyncedAt} < now() - make_interval(secs => ${STALE_MS / 1000}), true)`,
        lastError: connections.lastError,
        owner: people.displayName,
        mine: sql<boolean>`${connections.ownerPersonId} = ${viewer.personId}`,
      })
      .from(connections)
      .leftJoin(people, eq(people.id, connections.ownerPersonId))
      .orderBy(connections.provider),
  );
  // Counts only, no content, so they're read as the owner, filtered by org (as on /connectors).
  const live = and(eq(messages.orgId, viewer.orgId), isNull(messages.deletedAt));
  const counts = await db.select({ id: messages.connectionId, n: count() }).from(messages).where(live).groupBy(messages.connectionId);
  const eventCounts = await db.select({ id: events.connectionId, n: count() }).from(events).where(eq(events.orgId, viewer.orgId)).groupBy(events.connectionId);
  const byId = new Map(counts.map((c) => [c.id, c.n]));
  const eventsById = new Map(eventCounts.map((c) => [c.id, c.n]));
  return { sources: rows.map((r) => ({ ...r, messages: byId.get(r.id) ?? 0, events: eventsById.get(r.id) ?? 0 })) };
}
