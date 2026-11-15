import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { loadProfile } from "@/agent/profile";
import { transcriptionConfigured } from "@/ai/transcribe";
import { CHANNELS, type ChannelId } from "@/channels/channels";
import { getDb } from "@/db/client";
import { channelLinks } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { changesThings, listServers } from "@/tools/mcp";
import { AddLiveTools, AddProfileNote, LearnStyle, LinkCode } from "./forms";
import { deleteProfileNote, reloadLiveTools, removeLiveTools, toggleLiveTool, unlinkChannel } from "./more-actions";

/** Settings → Live tools: servers the agent queries at the moment you ask. */
export async function LiveTools() {
  await connection();
  const viewer = await getViewer();
  const servers = await listServers(getDb(), viewer);
  return (
    <div className="settings-sources">
      {servers.length > 0 && (
        <ul className="sources">
          {servers.map((s) => {
            const mine = s.ownerPersonId === viewer.personId;
            const on = s.tools.filter((t) => t.enabled).length;
            return (
              <li key={s.id}>
                <details className="connect">
                  <summary className="source">
                    <span className="mark">{s.name.slice(0, 2)}</span>
                    <span className="source-text">
                      <span className="source-name">{s.name}</span>
                      <span className="muted small truncate">
                        {new URL(s.url).host} · {s.scope === "org" ? "whole team" : "only you"} · {s.status === "active" ? `${on} of ${s.tools.length} tools on` : s.status === "needs_auth" ? "needs sign-in" : "can't connect"}
                      </span>
                      {s.lastError && <span className="error small truncate">{s.lastError}</span>}
                    </span>
                    <span className={`dot ${s.status === "active" && !s.lastError ? "ok" : "bad"}`} />
                  </summary>
                  <div className="connect-form">
                    <ul className="tool-list">
                      {s.tools.map((t) => (
                        <li key={t.name}>
                          <span className="source-text">
                            <span className="mono small">{t.name}</span>
                            {t.description && <span className="muted small">{t.description}</span>}
                          </span>
                          {changesThings(t) && (
                            <span className="tag" title="This tool changes things. When it's on, each use waits for the asker's approval.">
                              asks first
                            </span>
                          )}
                          {mine ? (
                            <form action={toggleLiveTool} className="actions">
                              <input type="hidden" name="id" value={s.id} />
                              <input type="hidden" name="tool" value={t.name} />
                              <input type="hidden" name="enabled" value={String(!t.enabled)} />
                              <button className={`chip-button${t.enabled ? " on" : ""}`}>{t.enabled ? "On" : "Off"}</button>
                            </form>
                          ) : (
                            <span className="tag">{t.enabled ? "on" : "off"}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {mine && (
                      <div className="row">
                        <form action={reloadLiveTools} className="actions">
                          <input type="hidden" name="id" value={s.id} />
                          <button className="chip-button">{s.status === "needs_auth" ? "Sign in" : "Reload tools"}</button>
                        </form>
                        <form action={removeLiveTools} className="actions">
                          <input type="hidden" name="id" value={s.id} />
                          <button className="chip-button danger">Remove</button>
                        </form>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <AddLiveTools />
    </div>
  );
}

const CATEGORY: Record<string, string> = { goal: "Goals", preference: "Preferences", decision: "How you decide", about: "About you" };

/** Settings → About you: the personal brain. Private to the member. */
export async function AboutYou() {
  await connection();
  const profile = await loadProfile(getDb(), await getViewer());
  const groups = Object.entries(CATEGORY).map(([key, title]) => ({ title, notes: profile.notes.filter((n) => n.category === key) }));
  return (
    <div className="settings-sources">
      {groups
        .filter((g) => g.notes.length)
        .map((g) => (
          <div key={g.title}>
            <p className="label">{g.title}</p>
            <ul className="sources">
              {g.notes.map((n) => (
                <li key={n.id} className="source">
                  <span className="source-name">{n.text}</span>
                  <form action={deleteProfileNote} className="actions">
                    <input type="hidden" name="id" value={n.id} />
                    <button className="chip-button danger">Forget</button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {profile.notes.length === 0 && <p className="muted small">Nothing yet. Tell the agent about yourself, or let it interview you.</p>}
      <AddProfileNote />
      <Link className="link small" href="/?ask=Interview%20me%20so%20you%20know%20how%20I%20work">
        Let ALRO interview you →
      </Link>

      <p className="label">How you write</p>
      {profile.style ? <p className="small prose">{profile.style}</p> : <p className="muted small">Not learned yet. ALRO reads your own recent messages and drafts in your voice.</p>}
      <LearnStyle learned={!!profile.style} />
    </div>
  );
}

const ENV: Record<ChannelId, string> = {
  whatsapp: "WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET",
  slack: "SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET",
  teams: "MICROSOFT_BOT_APP_ID, MICROSOFT_BOT_APP_PASSWORD (and MICROSOFT_BOT_TENANT_ID for a single-tenant bot)",
};

/** Settings → Messaging: ask the agent from WhatsApp, Telegram, Slack or Teams. */
export async function Messaging() {
  await connection();
  const viewer = await getViewer();
  const links = await getDb().select().from(channelLinks).where(and(eq(channelLinks.orgId, viewer.orgId), eq(channelLinks.personId, viewer.personId)));
  const any = Object.values(CHANNELS).some((c) => c.configured());
  return (
    <div className="settings-sources">
      <ul className="sources">
        {Object.values(CHANNELS).map((c) => {
          const link = links.find((l) => l.channel === c.id);
          return (
            <li key={c.id} className={c.configured() ? "source" : "source dim"}>
              <span className="mark">{c.label.slice(0, 2)}</span>
              <span className="source-text">
                <span className="source-name">{c.label}</span>
                <span className="muted small truncate">{!c.configured() ? "Not set up on this server" : link ? (c.id === "teams" ? "Linked" : `Linked: ${link.externalUserId}`) : `Message ${c.where()} with your code`}</span>
              </span>
              {!c.configured() ? (
                <span className="tag" title={`Set ${ENV[c.id]}`}>
                  needs setup
                </span>
              ) : link ? (
                <form action={unlinkChannel} className="actions">
                  <input type="hidden" name="id" value={link.id} />
                  <button className="chip-button danger">Unlink</button>
                </form>
              ) : (
                <span className="tag">not linked</span>
              )}
            </li>
          );
        })}
      </ul>
      {any && <LinkCode />}
      {CHANNELS.teams.configured() && (
        <a className="link small" href="/api/channels/teams/app">
          Download the ALRO app for Teams (upload it in Teams → Apps → Manage your apps) →
        </a>
      )}
      {!transcriptionConfigured() && <p className="muted small">Voice notes need OPENAI_API_KEY for speech-to-text.</p>}
    </div>
  );
}
