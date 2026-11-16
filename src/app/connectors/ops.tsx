import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { connection } from "next/server";
import { CHANNELS, type ChannelId } from "@/channels/channels";
import { getDb } from "@/db/client";
import { connections, deadLetters, jobRuns, orgs, people, routines, webhookEvents } from "@/db/schema";
import { sourceOf } from "@/lib/sources";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { openAlerts } from "@/ops/alerts";
import { LETTER_LABEL, openLetters, type DeadLetter } from "@/ops/retry";
import { isAdmin } from "@/platform/roles";
import { dismissFailed, retryFailed } from "./actions";

/** What each background job does, in the words of the page. Jobs marked `all` cover every company at once. */
const JOBS: Record<string, { label: string; every: string; all?: boolean }> = {
  sync: { label: "Fetch what's new from your sources", every: "every 15 minutes" },
  process: { label: "Read new messages: search, facts, promises, notes, trackers", every: "every 10 minutes" },
  watcher: { label: "Deadlines and reminders", every: "hourly" },
  rollups: { label: "Daily summaries", every: "hourly" },
  briefs: { label: "Briefs before meetings", every: "every 15 minutes" },
  routines: { label: "Scheduled tasks", every: "every 15 minutes" },
  approvals: { label: "Expire old proposals", every: "every 15 minutes" },
  retries: { label: "Retry what failed", every: "every 15 minutes", all: true },
  housekeeping: { label: "Clear out old history", every: "every 15 minutes", all: true },
};

const appName = (channel: string) => CHANNELS[channel as ChannelId]?.label ?? channel;

const took = (start: Date, end: Date | null) => {
  if (!end) return "";
  const s = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * Behind the scenes: when each background job last ran and whether it worked, recent
 * failures, what is waiting to be tried again or was given up on, and messages to the bot
 * that failed. Members see statuses; error details and the retry buttons are for admins.
 */
export async function Ops() {
  await connection();
  const viewer = await getViewer();
  const admin = isAdmin(viewer);
  // These tables aren't readable through row-level security: read as the owner, always filtered to this company.
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const when = (d: Date) => formatShort(d, org.timezone);
  const mine = or(eq(jobRuns.orgId, viewer.orgId), isNull(jobRuns.orgId));

  const [last, failures, letters, alerts] = await Promise.all([
    db
      .selectDistinctOn([jobRuns.job], { job: jobRuns.job, status: jobRuns.status, startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt, error: jobRuns.error })
      .from(jobRuns)
      .where(mine)
      .orderBy(jobRuns.job, desc(jobRuns.startedAt)),
    db
      .select({ id: jobRuns.id, job: jobRuns.job, startedAt: jobRuns.startedAt, error: jobRuns.error })
      .from(jobRuns)
      .where(and(mine, eq(jobRuns.status, "error"), gt(jobRuns.startedAt, sql`now() - interval '7 days'`)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(8),
    openLetters(db, viewer.orgId),
    admin ? openAlerts(db, viewer) : [],
  ]);
  const jobs = last.filter((j) => JOBS[j.job]).sort((a, b) => Object.keys(JOBS).indexOf(a.job) - Object.keys(JOBS).indexOf(b.job));

  // Whose task or reminder a failure was about: a name, never the task's wording.
  const routineIds = letters.filter((l) => l.kind === "routine").map((l) => l.ref);
  const personIds = letters.filter((l) => l.kind === "notify").map((l) => l.ref.split(":")[0]);
  const owners = routineIds.length
    ? await db.select({ id: routines.id, name: people.displayName }).from(routines).innerJoin(people, eq(people.id, routines.ownerPersonId)).where(and(eq(routines.orgId, viewer.orgId), inArray(routines.id, routineIds)))
    : [];
  const named = personIds.length ? await db.select({ id: people.id, name: people.displayName }).from(people).where(and(eq(people.orgId, viewer.orgId), inArray(people.id, personIds))) : [];
  const about = (l: DeadLetter) => {
    if (l.kind === "routine") return `Scheduled task of ${owners.find((o) => o.id === l.ref)?.name ?? "someone who left"}`;
    if (l.kind === "notify") return `Reminder for ${named.find((p) => p.id === l.ref.split(":")[0])?.name ?? "a member"}`;
    if (l.kind === "webhook") return `Message to the ALRO bot${l.payload?.channel ? ` on ${appName(String(l.payload.channel))}` : ""}`;
    return LETTER_LABEL[l.kind] ?? l.kind;
  };

  // Failed messages to the bot, tied to this company through their retry record. Never their text.
  const events = admin
    ? await db
        .select({ id: webhookEvents.id, channel: webhookEvents.channel, receivedAt: webhookEvents.receivedAt, attempts: webhookEvents.attempts, error: webhookEvents.error })
        .from(webhookEvents)
        .innerJoin(deadLetters, and(eq(deadLetters.kind, "webhook"), eq(deadLetters.ref, sql`${webhookEvents.id}::text`)))
        .where(and(eq(deadLetters.orgId, viewer.orgId), eq(webhookEvents.status, "failed")))
        .orderBy(desc(webhookEvents.receivedAt))
        .limit(10)
    : [];
  const broken = admin && alerts.some((a) => a.key.startsWith("source:"))
    ? await db.select({ id: connections.id, provider: connections.provider, label: connections.label }).from(connections).where(and(eq(connections.orgId, viewer.orgId), eq(connections.status, "error")))
    : [];
  const alertText = (key: string) => {
    const [kind, ...rest] = key.split(":");
    if (kind === "job") return `${JOBS[rest[0]]?.label ?? rest[0]} has failed several times in a row.`;
    if (kind === "source") {
      const c = broken.find((b) => b.id === rest[0]);
      return `${c ? `${sourceOf(c.provider).label}${c.label ? ` (${c.label})` : ""}` : "A source"} stopped syncing and needs reconnecting in Settings.`;
    }
    return `${LETTER_LABEL[rest[0]] ?? "Something"} failed and was given up on. It's listed below.`;
  };
  const waiting = letters.filter((l) => l.nextRetryAt);
  const givenUp = letters.filter((l) => !l.nextRetryAt);

  return (
    <>
      {alerts.length > 0 && (
        <section className="card error-card">
          <strong>Needs attention</strong>
          {alerts.map((a) => (
            <p key={a.key} className="small">
              {alertText(a.key)} <span className="muted">Since {when(a.since)}.</span>
            </p>
          ))}
        </section>
      )}

      <section className="stack">
        <h2>Background jobs</h2>
        {jobs.length === 0 ? (
          <p className="muted small">Nothing has run yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Last run</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.job}>
                    <td>
                      {JOBS[j.job].label}
                      <div className="muted small">
                        {JOBS[j.job].every}
                        {JOBS[j.job].all ? " · for every company" : ""}
                      </div>
                    </td>
                    <td className="small nowrap">{when(j.startedAt)}</td>
                    <td className={j.status === "error" ? "error" : undefined}>
                      <span className={`dot ${j.status === "ok" ? "ok" : j.status === "error" ? "bad" : "stale"}`} /> {j.status === "ok" ? "Worked" : j.status === "error" ? "Failed" : "Running"}
                      <span className="muted small"> {took(j.startedAt, j.finishedAt)}</span>
                      {admin && j.status === "error" && j.error && <div className="small">{j.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {failures.length > 0 && (
          <details className="card">
            <summary>
              <strong>{failures.length === 8 ? "The last 8 failures" : `${failures.length} failure${failures.length === 1 ? "" : "s"}`} in the past week</strong>
            </summary>
            <ul className="timeline">
              {failures.map((f) => (
                <li key={f.id}>
                  <span className="small mono">{when(f.startedAt)}</span>
                  <span>
                    {JOBS[f.job]?.label ?? f.job}
                    {admin && f.error && <span className="error small"> · {f.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="muted small">A job that fails is run again on its next turn and picks up where it stopped. Admins are told when one fails three times in a row.</p>
      </section>

      <section className="stack">
        <h2>Failed and waiting to be tried again</h2>
        {letters.length === 0 ? (
          <p className="muted small">Nothing is waiting.</p>
        ) : !admin ? (
          <p className="small">
            {waiting.length} waiting for another try, {givenUp.length} given up on. An admin can retry them here.
          </p>
        ) : (
          <ul className="sources">
            {letters.map((l) => (
              <li key={l.id} className="source">
                <span className={`dot ${l.nextRetryAt ? "stale" : "bad"}`} />
                <div className="source-text">
                  <span className="source-name">{about(l)}</span>
                  <span className="small error clamp">{l.error}</span>
                  <span className="muted small">
                    Failed {l.attempts} time{l.attempts === 1 ? "" : "s"} · {l.nextRetryAt ? `next try ${when(l.nextRetryAt)}` : "given up: it will only be tried again if you say so"}
                  </span>
                </div>
                <form className="actions">
                  <input type="hidden" name="id" value={l.id} />
                  <button formAction={retryFailed} className="chip-button" title={l.kind === "routine" ? "Runs the task again now. If it had already proposed or done something, it may do it a second time." : undefined}>
                    Retry now
                  </button>
                  <button formAction={dismissFailed} className="chip-button danger">
                    Dismiss
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Failed work is tried again after 5 minutes, 30 minutes, 2 hours and 12 hours (a scheduled task at most twice, and never if it had already proposed or done something). After that it waits here for an admin.</p>
      </section>

      {events.length > 0 && (
        <section className="stack">
          <h2>Messages to the bot that failed</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Received</th>
                  <th>Tries</th>
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{appName(e.channel)}</td>
                    <td className="small nowrap">{when(e.receivedAt)}</td>
                    <td className="mono small">{e.attempts}</td>
                    <td className="small">{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">A message that arrives twice is answered once. What a failed message said is kept only until it has been handled, and never shown here.</p>
        </section>
      )}
    </>
  );
}
