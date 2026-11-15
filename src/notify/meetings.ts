import { aliasedTable, and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { notifyPerson } from "@/channels/links";
import type { Db } from "@/db/client";
import { commitments, events, meetingNotes, messages, notifications, orgs, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { sendEmail } from "./email";

const OPEN = ["open", "due_soon", "overdue"] as const;
/** A meeting's brief goes out once, when it starts within this long. */
const LEAD_MS = 30 * 60 * 1000;

export interface MeetingPrep {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  url: string | null;
  location: string | null;
  attendees: { name: string; known: boolean }[];
  /** Open promises you made to the people in the meeting. */
  youOwe: { title: string; to: string | null; due: string | null }[];
  /** Open promises they made (that you can see). */
  theyOwe: { title: string; by: string | null; due: string | null }[];
  /** The last thing each known attendee said, anywhere you can see. */
  lastSaid: { who: string; where: string; at: string; text: string }[];
  /** Notes from the most recent meeting with any of them. */
  lastMeeting?: { title: string; at: string; summary: string };
}

type EventRow = typeof events.$inferSelect;

/** A member's meetings in a time window, soonest first. Skips cancelled ones. */
export function meetingsBetween(db: Db, viewer: Viewer, from: Date, to: Date): Promise<EventRow[]> {
  return withScope(db, viewer, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.ownerPersonId, viewer.personId), eq(events.cancelled, false), gte(events.endsAt, from), lte(events.startsAt, to)))
      .orderBy(asc(events.startsAt)),
  );
}

/**
 * What to know walking into a meeting: who's in it, what you and they still owe each
 * other, what they last said, and how the last meeting with them ended. Plain lookups
 * in the member's own scope, so it costs nothing and shows only what they can see.
 */
export async function prepareMeeting(db: Db, viewer: Viewer, event: EventRow, timeZone: string): Promise<MeetingPrep> {
  const ids = [...new Set(event.attendees.flatMap((a) => (a.personId && a.personId !== viewer.personId ? [a.personId] : [])))];
  const when = (d: Date | null, text: string | null) => (d ? formatShort(d, timeZone) : text);
  const other = aliasedTable(people, "other");
  const base = {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    url: event.url,
    location: event.location,
    attendees: event.attendees.filter((a) => a.personId !== viewer.personId).map((a) => ({ name: a.name ?? a.email ?? "Someone", known: !!a.personId })),
  };
  if (!ids.length) return { ...base, youOwe: [], theyOwe: [], lastSaid: [] };

  return withScope(db, viewer, async (tx) => {
    const names = new Map((await tx.select({ id: people.id, name: people.displayName }).from(people).where(inArray(people.id, ids))).map((p) => [p.id, p.name]));
    const youOwe = await tx
      .select({ title: commitments.title, to: other.displayName, dueAt: commitments.dueAt, dueText: commitments.dueText })
      .from(commitments)
      .leftJoin(other, eq(other.id, commitments.counterpartyPersonId))
      .where(and(eq(commitments.ownerPersonId, viewer.personId), inArray(commitments.counterpartyPersonId, ids), inArray(commitments.status, OPEN)))
      .orderBy(sql`${commitments.dueAt} asc nulls last`)
      .limit(6);
    const theyOwe = await tx
      .select({ title: commitments.title, by: other.displayName, dueAt: commitments.dueAt, dueText: commitments.dueText })
      .from(commitments)
      .leftJoin(other, eq(other.id, commitments.ownerPersonId))
      .where(and(inArray(commitments.ownerPersonId, ids), inArray(commitments.status, OPEN)))
      .orderBy(sql`${commitments.dueAt} asc nulls last`)
      .limit(6);

    const recent = await tx
      .select({ author: messages.authorPersonId, text: messages.text, sentAt: messages.sentAt, thread: threads.title })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(and(inArray(messages.authorPersonId, ids), isNull(messages.deletedAt)))
      .orderBy(desc(messages.sentAt))
      .limit(40);
    const seen = new Set<string>();
    const lastSaid = recent.flatMap((m) => {
      if (!m.author || seen.has(m.author)) return [];
      seen.add(m.author);
      return [{ who: names.get(m.author) ?? "Someone", where: m.thread ?? "Untitled", at: formatShort(m.sentAt, timeZone), text: m.text.length > 240 ? `${m.text.slice(0, 240)}…` : m.text }];
    });

    const [notes] = await tx
      .select({ title: threads.title, at: meetingNotes.createdAt, summary: meetingNotes.summary })
      .from(meetingNotes)
      .innerJoin(threads, eq(threads.id, meetingNotes.threadId))
      .where(sql`exists (select 1 from thread_members tm where tm.thread_id = ${threads.id} and tm.person_id = any(${`{${ids.join(",")}}`}::uuid[]))`)
      .orderBy(desc(meetingNotes.createdAt))
      .limit(1);

    return {
      ...base,
      youOwe: youOwe.map((c) => ({ title: c.title, to: c.to, due: when(c.dueAt, c.dueText) })),
      theyOwe: theyOwe.map((c) => ({ title: c.title, by: c.by, due: when(c.dueAt, c.dueText) })),
      lastSaid: lastSaid.slice(0, 5),
      lastMeeting: notes ? { title: notes.title ?? "Meeting", at: formatShort(notes.at, timeZone), summary: notes.summary } : undefined,
    };
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The brief as a message: the same text goes to email and messaging apps. */
export function renderPrep(p: MeetingPrep, timeZone: string): { subject: string; text: string; html: string } {
  const due = (d: string | null) => (d ? `, ${d}` : "");
  const sections = [
    { title: "With", items: p.attendees.map((a) => a.name) },
    { title: "You owe them", items: p.youOwe.map((c) => `${c.title}${c.to ? ` (to ${c.to})` : ""}${due(c.due)}`) },
    { title: "They owe", items: p.theyOwe.map((c) => `${c.title}${c.by ? ` (${c.by})` : ""}${due(c.due)}`) },
    { title: "Last said", items: p.lastSaid.map((m) => `${m.who} in ${m.where}, ${m.at}: ${m.text}`) },
    ...(p.lastMeeting ? [{ title: `Last meeting: ${p.lastMeeting.title}, ${p.lastMeeting.at}`, items: p.lastMeeting.summary.split("\n").filter((l) => l.trim()).slice(0, 8) }] : []),
  ].filter((s) => s.items.length);
  const head = `${p.title}, ${formatShort(p.startsAt, timeZone)}${p.location ? `, ${p.location}` : ""}`;
  const text = [head, ...sections.map((s) => `${s.title}\n${s.items.map((i) => `- ${i.replace(/^- /, "")}`).join("\n")}`), ...(p.url ? [p.url] : [])].join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;max-width:560px"><p><strong>${esc(head)}</strong></p>${sections
    .map((s) => `<p style="margin:16px 0 4px;font-weight:600">${esc(s.title)}</p><ul style="margin:0;padding-left:18px">${s.items.map((i) => `<li>${esc(i.replace(/^- /, ""))}</li>`).join("")}</ul>`)
    .join("")}${p.url ? `<p><a href="${esc(p.url)}">Join</a></p>` : ""}</div>`;
  return { subject: `Before ${p.title}`, text, html };
}

/**
 * Sends each member a brief for meetings about to start (once per meeting), by email
 * and in their linked messaging apps. Meetings with nobody else in them are skipped.
 */
export async function sendMeetingBriefs(db: Db, orgId: string, now = new Date()): Promise<{ briefed: number }> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const soon = await db
    .select()
    .from(events)
    .where(and(eq(events.orgId, orgId), eq(events.cancelled, false), eq(events.allDay, false), gt(events.startsAt, now), lte(events.startsAt, new Date(now.getTime() + LEAD_MS))));
  let briefed = 0;
  for (const event of soon) {
    if (!event.attendees.length) continue;
    const [first] = await db
      .insert(notifications)
      .values({ orgId, personId: event.ownerPersonId, commitmentId: null, kind: `meeting:${event.id}`, channel: "in_app", sentAt: now })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (!first) continue;
    const [person] = await db.select({ email: people.primaryEmail, isMember: people.isMember }).from(people).where(eq(people.id, event.ownerPersonId));
    if (!person?.isMember) continue;
    try {
      const viewer = { orgId, personId: event.ownerPersonId };
      const mail = renderPrep(await prepareMeeting(db, viewer, event, org.timezone), org.timezone);
      const emailed = person.email ? await sendEmail({ to: person.email, ...mail }) : false;
      const pinged = await notifyPerson(db, orgId, event.ownerPersonId, mail.text, now);
      if (emailed || pinged.length) await db.update(notifications).set({ channel: emailed ? "email" : pinged[0] }).where(eq(notifications.id, first.id));
      briefed++;
    } catch (e) {
      console.error(`meeting brief failed for ${event.id}`, e instanceof Error ? e.message : e);
    }
  }
  return { briefed };
}
