import { aliasedTable, and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { approvals, commitmentEvents, commitments, edges, events, messages, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { formatShort, startOfLocalDay } from "@/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["open", "due_soon", "overdue"] as const;

export interface BriefPromise {
  id: string;
  title: string;
  person: string | null;
  due: string | null;
}

export interface Brief {
  /** The rest of today's meetings, from the member's connected calendar. */
  meetings: { title: string; at: string; with: string[] }[];
  /** Drafts and actions waiting for their OK. */
  approvals: { summary: string; code: string }[];
  /** Promises (anyone's they can see) that went overdue in the last day. */
  slipped: BriefPromise[];
  overdue: BriefPromise[];
  dueSoon: BriefPromise[];
  /** Open promises you made to someone: they're waiting on you. */
  waitingOnYou: BriefPromise[];
  /** Open promises others made to you. */
  owedToYou: BriefPromise[];
  /** Busiest conversations in the last day. */
  active: { title: string; messages: number }[];
  messages: number;
  newPromises: number;
  changedFacts: number;
}

/** What a person should know this morning. Runs in their scope, so it only uses what they can see. */
export async function buildBrief(db: Db, viewer: Viewer, timeZone: string, now = new Date()): Promise<Brief> {
  const since = new Date(now.getTime() - DAY_MS);
  const other = aliasedTable(people, "other");
  const when = (d: Date | null, text: string | null) => (d ? formatShort(d, timeZone) : text);

  return withScope(db, viewer, async (tx) => {
    const row = { id: commitments.id, title: commitments.title, status: commitments.status, dueAt: commitments.dueAt, dueText: commitments.dueText };
    const mine = await tx
      .select({ ...row, person: sql<string | null>`coalesce(${other.displayName}, ${commitments.counterpartyText})` })
      .from(commitments)
      .leftJoin(other, eq(other.id, commitments.counterpartyPersonId))
      .where(and(eq(commitments.ownerPersonId, viewer.personId), inArray(commitments.status, OPEN)))
      .orderBy(sql`${commitments.dueAt} asc nulls last`);
    const theirs = await tx
      .select({ ...row, person: other.displayName })
      .from(commitments)
      .leftJoin(other, eq(other.id, commitments.ownerPersonId))
      .where(and(eq(commitments.counterpartyPersonId, viewer.personId), inArray(commitments.status, OPEN)))
      .orderBy(sql`${commitments.dueAt} asc nulls last`);

    const n = count(messages.id);
    const active = await tx
      .select({ title: threads.title, messages: n })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(and(gte(messages.sentAt, since), isNull(messages.deletedAt)))
      .groupBy(threads.id)
      .orderBy(desc(n))
      .limit(5);
    const [{ total }] = await tx.select({ total: count() }).from(messages).where(and(gte(messages.sentAt, since), isNull(messages.deletedAt)));
    const [{ fresh }] = await tx.select({ fresh: count() }).from(commitments).where(gte(commitments.createdAt, since));
    const [{ changed }] = await tx.select({ changed: count() }).from(edges).where(and(isNotNull(edges.expiredAt), gte(edges.expiredAt, since)));

    const endOfDay = new Date(startOfLocalDay(now, timeZone).getTime() + DAY_MS);
    const today = await tx
      .select({ title: events.title, startsAt: events.startsAt, attendees: events.attendees })
      .from(events)
      .where(and(eq(events.ownerPersonId, viewer.personId), eq(events.cancelled, false), eq(events.allDay, false), gte(events.startsAt, now), lt(events.startsAt, endOfDay)))
      .orderBy(events.startsAt);

    const waiting = await tx
      .select({ summary: approvals.summary, code: approvals.code })
      .from(approvals)
      .where(and(eq(approvals.personId, viewer.personId), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt))
      .limit(10);
    const owner = aliasedTable(people, "owner");
    const slipped = await tx
      .selectDistinct({ id: commitments.id, title: commitments.title, person: owner.displayName, dueAt: commitments.dueAt, dueText: commitments.dueText })
      .from(commitmentEvents)
      .innerJoin(commitments, eq(commitments.id, commitmentEvents.commitmentId))
      .leftJoin(owner, eq(owner.id, commitments.ownerPersonId))
      .where(and(eq(commitmentEvents.toStatus, "overdue"), gte(commitmentEvents.createdAt, since), eq(commitments.status, "overdue")))
      .limit(10);

    const item = (c: (typeof mine)[number]): BriefPromise => ({ id: c.id, title: c.title, person: c.person, due: when(c.dueAt, c.dueText) });
    return {
      meetings: today.map((e) => ({
        title: e.title,
        at: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(e.startsAt),
        with: e.attendees.filter((a) => a.personId !== viewer.personId).map((a) => a.name ?? a.email ?? "someone"),
      })),
      approvals: waiting,
      slipped: slipped.map((c) => ({ id: c.id, title: c.title, person: c.person, due: when(c.dueAt, c.dueText) })),
      overdue: mine.filter((c) => c.status === "overdue").map(item),
      dueSoon: mine.filter((c) => c.status === "due_soon").map(item),
      waitingOnYou: mine.filter((c) => c.status === "open" && c.person).map(item),
      owedToYou: theirs.map(item),
      active: active.map((a) => ({ title: a.title ?? "Untitled", messages: a.messages })),
      messages: total,
      newPromises: fresh,
      changedFacts: changed,
    };
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sectionsOf(b: Brief) {
  const line = (p: BriefPromise, to: "to" | "from") => `${p.title}${p.person ? ` (${to} ${p.person})` : ""}${p.due ? `, ${p.due}` : ""}`;
  return [
    { title: "Waiting for your OK", items: b.approvals.map((a) => `${a.summary} (reply "yes ${a.code}")`) },
    { title: "Slipped since yesterday", items: b.slipped.map((p) => `${p.title}${p.person ? ` (${p.person})` : ""}${p.due ? `, was due ${p.due}` : ""}`) },
    { title: "Today's meetings", items: b.meetings.map((m) => `${m.at} ${m.title}${m.with.length ? ` (with ${m.with.slice(0, 4).join(", ")}${m.with.length > 4 ? ` +${m.with.length - 4}` : ""})` : ""}`) },
    { title: "Overdue", items: b.overdue.map((p) => line(p, "to")) },
    { title: "Due soon", items: b.dueSoon.map((p) => line(p, "to")) },
    { title: "Waiting on you", items: b.waitingOnYou.slice(0, 8).map((p) => line(p, "to")) },
    { title: "Owed to you", items: b.owedToYou.slice(0, 8).map((p) => line(p, "from")) },
    { title: "Busiest conversations", items: b.active.map((a) => `${a.title}: ${a.messages} messages`) },
  ].filter((s) => s.items.length);
}

/** Subject and body of the morning email. */
export function renderBrief(b: Brief, name: string, appUrl?: string): { subject: string; text: string; html: string } {
  const first = name.split(/\s+/)[0];
  const top = b.approvals.length ? `${b.approvals.length} waiting for your OK` : b.overdue.length ? `${b.overdue.length} overdue` : b.meetings.length ? `${b.meetings.length} meeting${b.meetings.length === 1 ? "" : "s"} today` : b.dueSoon.length ? `${b.dueSoon.length} due soon` : `${b.messages} new messages`;
  const stats = `${b.messages} messages, ${b.newPromises} new promises, ${b.changedFacts} facts changed in the last day.`;
  const sections = sectionsOf(b);
  const text = [`Morning ${first}.`, stats, ...sections.map((s) => `${s.title}\n${s.items.map((i) => `- ${i}`).join("\n")}`), ...(appUrl ? [`Open ALRO: ${appUrl}/updates`] : [])].join("\n\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#171717;max-width:560px">
<p><strong>Morning ${esc(first)}.</strong> ${esc(stats)}</p>
${sections.map((s) => `<p style="margin:18px 0 4px;font-weight:600">${esc(s.title)}</p><ul style="margin:0;padding-left:18px">${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("\n")}
${appUrl ? `<p style="margin-top:20px"><a href="${esc(appUrl)}/updates">Open ALRO</a></p>` : ""}
</div>`;
  return { subject: `Your ALRO brief: ${top}`, text, html };
}
