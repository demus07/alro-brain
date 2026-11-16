import { and, eq, inArray, isNull } from "drizzle-orm";
import { notifyPerson } from "@/channels/links";
import type { Db } from "@/db/client";
import { insights, messages, notifications, people, threadMembers } from "@/db/schema";
import { principalsFor } from "@/db/scope";

type InsightRow = typeof insights.$inferSelect;

/**
 * Tells people about new "act today" insights in their linked messaging apps, once per
 * insight per person. Who is told: for a waiting reply, the members in that conversation;
 * for someone overloaded, that person; otherwise the members who made or are owed the
 * promises behind it (or own the tracker). Nobody is told about an insight they couldn't see.
 */
export async function notifyInsights(db: Db, orgId: string, now = new Date()): Promise<{ people: number; insights: number }> {
  const urgent = await db.select().from(insights).where(and(eq(insights.orgId, orgId), eq(insights.status, "new"), eq(insights.severity, 3)));
  if (!urgent.length) return { people: 0, insights: 0 };
  const members = await db.select({ id: people.id }).from(people).where(and(eq(people.orgId, orgId), eq(people.isMember, true), isNull(people.deactivatedAt)));
  const active = new Set(members.map((m) => m.id));

  const forPerson = new Map<string, InsightRow[]>();
  for (const insight of urgent) {
    for (const personId of await concerned(db, insight)) {
      if (active.has(personId)) forPerson.set(personId, [...(forPerson.get(personId) ?? []), insight]);
    }
  }

  const stats = { people: 0, insights: 0 };
  for (const [personId, theirs] of forPerson) {
    const principals = new Set<string>(await principalsFor(db, { orgId, personId }));
    const fresh: InsightRow[] = [];
    const rows: string[] = [];
    for (const insight of theirs) {
      if (!insight.acl.some((p) => principals.has(p))) continue;
      // The unique constraint makes "once" hold even if two runs race. An insight that resolved and came back counts again.
      const [row] = await db
        .insert(notifications)
        .values({ orgId, personId, commitmentId: null, kind: `insight:${insight.id}:${insight.firstSeenAt.getTime()}`, channel: "in_app", sentAt: now })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (!row) continue;
      fresh.push(insight);
      rows.push(row.id);
    }
    if (!fresh.length) continue;
    stats.insights += fresh.length;
    const pinged = await notifyPerson(db, orgId, personId, render(fresh), now);
    if (!pinged.length) continue;
    await db.update(notifications).set({ channel: pinged[0] }).where(inArray(notifications.id, rows));
    stats.people++;
  }
  return stats;
}

/** The members an insight is about or for (before checking they can see it). */
async function concerned(db: Db, insight: InsightRow): Promise<string[]> {
  if (insight.kind === "overloaded") return insight.subjectPersonId ? [insight.subjectPersonId] : [];
  if (insight.kind === "waiting_on_us" && insight.evidenceMessageIds.length) {
    const asked = await db.selectDistinct({ threadId: messages.threadId }).from(messages).where(inArray(messages.id, insight.evidenceMessageIds));
    const threadIds = asked.map((m) => m.threadId);
    if (!threadIds.length) return [];
    const wrote = await db
      .selectDistinct({ personId: people.id })
      .from(messages)
      .innerJoin(people, eq(people.id, messages.authorPersonId))
      .where(and(inArray(messages.threadId, threadIds), eq(people.isMember, true), isNull(messages.deletedAt)));
    // Nobody here has written yet (a first email from a customer): whoever the conversation belongs to.
    const there = wrote.length ? wrote : await db.selectDistinct({ personId: threadMembers.personId }).from(threadMembers).where(inArray(threadMembers.threadId, threadIds));
    return there.map((p) => p.personId);
  }
  // Promises carry their owner and who they were made to as 'p:<id>'; a tracker's insight carries its owner.
  return insight.acl.flatMap((p) => (p.startsWith("p:") ? [p.slice(2)] : []));
}

function render(list: InsightRow[]): string {
  const appUrl = process.env.ALRO_APP_URL;
  const one = (i: InsightRow) => `${i.title}. ${i.detail}${i.suggestion ? `\nNext: ${i.suggestion}` : ""}`;
  const body = list.length === 1 ? `Needs your attention: ${one(list[0])}` : `${list.length} things need your attention:\n${list.map((i) => `- ${one(i)}`).join("\n")}`;
  return `${body}${appUrl ? `\n\n${appUrl}/updates` : ""}`;
}
