import { and, count, eq, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import { oauthConfigured, oauthConsole, oauthEnvNames, oauthLabel } from "@/connectors/oauth";
import { gmailPushUrl, pushBase, pushSetup, pushUrl } from "@/connectors/push";
import { PROVIDERS, providerOf } from "@/connectors/registry";
import { getDb } from "@/db/client";
import { connections, events, messages, people } from "@/db/schema";
import { withScope } from "@/db/scope";
import { appOrigin } from "@/lib/origin";
import { secretsConfigured } from "@/lib/secrets";
import { COMING, isUpload, sourceOf, UPLOAD_ONLY } from "@/lib/sources";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { syncNow } from "./actions";
import { SourceIcon } from "../source-icon";
import { ConnectForm } from "./connect-form";
import { SourceFilter } from "./source-filter";
import { SourcePanel } from "./source-panel";
import { UploadForm } from "./upload-form";
import { DeleteSource } from "./delete-source";

const STALE_MS = 24 * 60 * 60 * 1000;

/** What kind of app each source is, so searching "email" or "crm" finds it as well as its name. */
const KIND: Record<string, string> = {
  slack: "chat messaging", teams: "chat messaging microsoft", "teams-channels": "chat messaging microsoft", discord: "chat messaging community",
  gmail: "email mail google", outlook: "email mail microsoft", imap: "email mail inbox", "google-calendar": "calendar meetings google",
  "outlook-calendar": "calendar meetings microsoft", "google-meet": "meetings video calls google", zoom: "meetings video calls",
  fireflies: "meetings transcripts notetaker", fathom: "meetings transcripts notetaker", "google-drive": "docs files storage google",
  "google-sheets": "spreadsheet docs google", onedrive: "docs files storage microsoft", sharepoint: "docs files intranet microsoft",
  notion: "docs wiki notes", confluence: "docs wiki atlassian", jira: "tasks issues projects atlassian", linear: "tasks issues projects",
  github: "code issues engineering", gitlab: "code issues engineering", asana: "tasks projects", clickup: "tasks projects",
  hubspot: "crm sales marketing", salesforce: "crm sales", pipedrive: "crm sales", zoho: "crm sales",
  zendesk: "support helpdesk tickets", freshdesk: "support helpdesk tickets", intercom: "support chat customers",
  stripe: "payments billing", razorpay: "payments billing", shopify: "ecommerce orders store", xero: "accounting finance invoices",
  quickbooks: "accounting finance invoices", whatsapp: "chat messaging export upload", meetings: "meetings transcripts upload",
};
const searchText = (key: string, label: string) => `${label} ${key} ${KIND[key] ?? ""}`.toLowerCase();

/** Settings → Sources: every connected source, its health, and what can be added. */
export async function Sources() {
  await connection();
  let data;
  try {
    data = await load();
  } catch (e) {
    return <p className="muted small">Can&apos;t reach the database: {(e as Error).message}</p>;
  }
  const { sources, admin } = data;
  const origin = await appOrigin();
  // Personal sources (a mailbox, a calendar) can be connected by each person; team ones once.
  const taken = new Set(sources.filter((s) => !isUpload(s.provider) && (s.scope === "org" || s.mine)).map((s) => s.provider));
  const available = [...PROVIDERS.values()].filter((p) => !taken.has(p.id));

  return (
    <div className="settings-sources">
      <p className="label">Connected · {sources.length}</p>
      {sources.length === 0 && <p className="muted small">Nothing yet.</p>}
      <ul className="source-grid">
        {sources.map((s) => {
          const info = sourceOf(s.provider);
          const provider = providerOf(s.provider);
          const health = s.status !== "active" ? "bad" : isUpload(s.provider) ? "upload" : provider?.sync && s.stale ? "stale" : "ok";
          const what = provider && !provider.sync ? "live lookups" : s.events ? `${s.events.toLocaleString("en-US")} events` : `${s.messages.toLocaleString("en-US")} msgs`;
          return (
            <li key={s.id} className="source-tile connected">
              <div className="source-tile-head">
                <SourceIcon provider={s.provider} />
                <span className="source-text">
                  <span className="source-name">
                    <span className="truncate">{info.label}</span>
                    {isUpload(s.provider) && <span className="tag">export</span>}
                  </span>
                  <span className="muted small truncate">
                    {[s.label, s.scope === "personal" ? (s.mine ? "yours" : (s.owner ?? "personal")) : "whole team", what].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className={`dot ${s.lastError ? "bad" : health}`} title={s.lastError ?? (health === "upload" ? "Imported from an export" : health)} />
              </div>
              {s.lastError && <span className="error small clamp-2">{s.lastError}</span>}
              {provider && (s.mine || (s.scope === "org" && admin)) && !isUpload(s.provider) && <InstantUpdates source={s} origin={origin} />}
              {(provider?.sync || s.scope !== "personal" || s.mine) && (
                <div className="source-tile-actions">
                  {provider?.sync && (
                    <form action={syncNow} className="actions">
                      <input type="hidden" name="id" value={s.id} />
                      <button className="chip-button">Sync now</button>
                    </form>
                  )}
                  {(s.scope !== "personal" || s.mine) && <DeleteSource id={s.id} label={info.label} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="section-head add-source-head">
        <p className="label">Add a source</p>
        <SourceFilter list="add-sources" />
      </div>
      {!secretsConfigured() && <p className="warn small">Set ALRO_SECRET_KEY in .env.local (openssl rand -base64 32) so tokens can be stored encrypted.</p>}
      <ul className="source-grid" id="add-sources">
        {available.map((p) => {
          const info = sourceOf(p.id);
          if (p.auth.kind === "token") {
            return (
              <li key={p.id} data-search={searchText(p.id, info.label)}>
                <SourcePanel provider={p.id} label={info.label} action="Connect">
                  <ConnectForm provider={p.id} label={info.label} fields={p.auth.fields} setup={p.auth.setup} docsUrl={p.auth.docsUrl} />
                </SourcePanel>
              </li>
            );
          }
          const app = oauthLabel(p.auth.app);
          if (oauthConfigured(p.auth.app)) {
            return (
              <li key={p.id} data-search={searchText(p.id, info.label)}>
                <SourcePanel provider={p.id} label={info.label} action="Connect">
                  <p className="muted small">
                    You&apos;ll sign in with {app} and allow ALRO to read your {info.label}. The sign-in is stored encrypted, and you can disconnect at any time from this page.
                  </p>
                  <a className="button-link primary" href={`/api/oauth/start?provider=${p.id}`}>
                    Continue with {app}
                  </a>
                </SourcePanel>
              </li>
            );
          }
          return (
            <li key={p.id} data-search={searchText(p.id, info.label)}>
              <SourcePanel provider={p.id} label={info.label} action="Set up" subtitle={`Needs a ${app} app`} dim>
                <p className="muted small">
                  {info.label} is connected with a {app} sign-in, which needs an app registered for this server first. It&apos;s done once, by whoever runs ALRO.
                </p>
                <ol className="setup-steps">
                  <li>
                    Register an app in <strong>{oauthConsole(p.auth.app)}</strong>.
                  </li>
                  <li>
                    Add this redirect URL to it: <code className="copyable">{origin}/api/oauth/callback</code>
                  </li>
                  <li>
                    Set <code>{oauthEnvNames(p.auth.app)}</code> in <code>.env.local</code>, then restart ALRO.
                  </li>
                </ol>
              </SourcePanel>
            </li>
          );
        })}
        {UPLOAD_ONLY.map((k) => (
          <li key={k} data-search={searchText(k, sourceOf(k).label)}>
            <SourcePanel provider={k} label={sourceOf(k).label} action="Upload">
              <p className="muted small">
                {k === "whatsapp"
                  ? "Export a chat from WhatsApp (chat → More → Export chat, without media) and upload the .txt, or the .zip an iPhone makes. It stays visible only to the people in the chat."
                  : "Upload meeting transcripts as .vtt files. Every meeting becomes searchable, and ALRO writes notes and follow-ups for new ones."}
              </p>
              <UploadForm />
            </SourcePanel>
          </li>
        ))}
        {COMING.map((k) => (
          <li key={k} className="source-tile dim" data-search={searchText(k, sourceOf(k).label)}>
            <SourceIcon provider={k} />
            <span className="source-text">
              <span className="source-name truncate">{sourceOf(k).label}</span>
              <span className="muted small">Coming soon</span>
            </span>
          </li>
        ))}
      </ul>
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
        pushExpiresAt: connections.pushExpiresAt,
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
  return { admin: isAdmin(viewer), sources: rows.map((r) => ({ ...r, messages: byId.get(r.id) ?? 0, events: eventsById.get(r.id) ?? 0 })) };
}

/** Whether a source tells ALRO about changes at once, and where to paste ALRO's address when it can't be set up automatically. */
function InstantUpdates({ source, origin }: { source: { id: string; provider: string; pushExpiresAt: Date | null }; origin: string }) {
  const setup = pushSetup(source);
  const base = pushBase();
  const note =
    setup.mode === "paste"
      ? undefined
      : source.pushExpiresAt
        ? "On: this app tells ALRO the moment something changes, and ALRO renews the subscription itself."
        : !base
          ? "Set ALRO_APP_URL to this server's public address to turn this on. Until then it's checked every 15 minutes."
          : setup.mode === "gmail"
            ? "Needs GMAIL_PUBSUB_TOPIC (a Google Pub/Sub topic) and a push subscription to the address below. Until then it's checked every 15 minutes."
            : "Not on yet. ALRO tries again every 15 minutes; until then it's checked on the usual schedule.";
  const address = setup.mode === "gmail" ? gmailPushUrl(base ?? origin) : pushUrl(base ?? origin, source.id);
  return (
    <details className="small">
      <summary className="muted">Instant updates{source.pushExpiresAt ? " · on" : ""}</summary>
      {note && <p className="muted">{note}</p>}
      {setup.mode === "paste" && <p className="muted">Paste this address into the app so it calls ALRO when something changes. {setup.hint} Until then it&apos;s checked every 15 minutes.</p>}
      {(setup.mode === "paste" || (setup.mode === "gmail" && !source.pushExpiresAt)) && <code className="copyable">{address}</code>}
      {!base && setup.mode === "paste" && <p className="warn">This address only works from this machine. Set ALRO_APP_URL to a public address first.</p>}
    </details>
  );
}
