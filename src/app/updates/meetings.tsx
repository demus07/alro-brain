import { desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/db/client";
import { meetingNotes, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { meetingsBetween, prepareMeeting } from "@/notify/meetings";

const HOUR_MS = 60 * 60 * 1000;
const UPCOMING = 4;

/**
 * Updates → Meetings: what to know before the next few meetings, and the notes ALRO
 * wrote for recent ones. Renders nothing until a calendar or transcripts are connected.
 */
export async function Meetings({ viewer, timeZone }: { viewer: Viewer; timeZone: string }) {
  const db = getDb();
  const now = new Date();
  const upcoming = (await meetingsBetween(db, viewer, now, new Date(now.getTime() + 36 * HOUR_MS))).filter((e) => !e.allDay && e.attendees.length).slice(0, UPCOMING);
  const preps = await Promise.all(upcoming.map((e) => prepareMeeting(db, viewer, e, timeZone)));
  const notes = await withScope(db, viewer, (tx) =>
    tx
      .select({
        id: meetingNotes.id,
        title: threads.title,
        at: meetingNotes.createdAt,
        summary: meetingNotes.summary,
        followUp: meetingNotes.followUp,
        firstMessage: sql<string | null>`(select m.id from messages m where m.thread_id = ${threads.id} order by m.sent_at limit 1)`,
      })
      .from(meetingNotes)
      .innerJoin(threads, eq(threads.id, meetingNotes.threadId))
      .where(gte(meetingNotes.createdAt, new Date(now.getTime() - 7 * 24 * HOUR_MS)))
      .orderBy(desc(meetingNotes.createdAt))
      .limit(5),
  );
  if (!preps.length && !notes.length) return null;

  return (
    <div className="split">
      <section className="column">
        <p className="label">Coming up</p>
        {preps.length === 0 && <p className="muted small">No meetings in the next day and a half.</p>}
        {preps.map((p) => {
          const empty = !p.youOwe.length && !p.theyOwe.length && !p.lastSaid.length && !p.lastMeeting;
          return (
            <details key={p.id} className="card">
              <summary className="card-head">
                <strong className="truncate">{p.title}</strong>
                <span className="muted small nowrap">{formatShort(p.startsAt, timeZone)}</span>
              </summary>
              <p className="muted small">With {p.attendees.map((a) => a.name).join(", ")}</p>
              {empty && <p className="muted small">Nothing in memory about these people yet.</p>}
              {p.youOwe.length > 0 && <Section title="You owe them" items={p.youOwe.map((c) => `${c.title}${c.due ? `, ${c.due}` : ""}`)} />}
              {p.theyOwe.length > 0 && <Section title="They owe" items={p.theyOwe.map((c) => `${c.title}${c.by ? ` (${c.by})` : ""}${c.due ? `, ${c.due}` : ""}`)} />}
              {p.lastSaid.length > 0 && <Section title="Last said" items={p.lastSaid.map((m) => `${m.who} in ${m.where}, ${m.at}: ${m.text}`)} />}
              {p.lastMeeting && <Section title={`Last meeting: ${p.lastMeeting.title}, ${p.lastMeeting.at}`} items={p.lastMeeting.summary.split("\n").filter((l) => l.trim() && !l.startsWith("**")).slice(0, 6)} />}
              {p.url && (
                <a className="link small" href={p.url} target="_blank" rel="noreferrer">
                  Join →
                </a>
              )}
            </details>
          );
        })}
      </section>
      <section className="column">
        <p className="label">Meeting notes</p>
        {notes.length === 0 && <p className="muted small">Notes appear here after a meeting&apos;s transcript arrives.</p>}
        {notes.map((n) => (
          <details key={n.id} className="card">
            <summary className="card-head">
              <strong className="truncate">{n.title ?? "Meeting"}</strong>
              <span className="muted small nowrap">{formatShort(n.at, timeZone)}</span>
            </summary>
            <p className="prose small">{n.summary.replace(/\*\*/g, "")}</p>
            {n.followUp && (
              <>
                <p className="label">Follow-up draft</p>
                <p className="prose small">{n.followUp}</p>
              </>
            )}
            {n.firstMessage && (
              <Link className="link small" href={`/m/${n.firstMessage}`}>
                Open the transcript →
              </Link>
            )}
          </details>
        ))}
      </section>
    </div>
  );
}

const Section = ({ title, items }: { title: string; items: string[] }) => (
  <div>
    <p className="small">
      <strong>{title}</strong>
    </p>
    <ul className="plain-list small">
      {items.map((i, k) => (
        <li key={k}>{i.replace(/^- /, "")}</li>
      ))}
    </ul>
  </div>
);
