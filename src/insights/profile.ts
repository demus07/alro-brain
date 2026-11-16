import { aliasedTable, and, asc, count, desc, eq, gte, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, commitments, edges, entities, entityAliases, entityMentions, events, messages, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { openInsights } from "./read";

const OPEN = ["open", "due_soon", "overdue"] as const;
/** Facts that say where someone works, however the extraction named the relation. */
const WORKS_AT = /^(works?_(at|for)|employed_(at|by)|employee_of)$/;
const ROLE = /^((has|holds)_)?(role|title|job_title|position)(_at|_of)?$|^works_as$/;
/** A fact nobody has restated or checked in this long is shown as possibly out of date. */
const STALE_DAYS = 180;

/**
 * Everything one person can see about a person or company: who they are, how they connect
 * to others, what is open with them, where they come up, what is currently believed about
 * them and the meetings around them. `id` is an entity id or a person id. Undefined when
 * there is nothing by that id the viewer can see.
 */
export async function loadSubject(db: Db, viewer: Viewer, id: string, now = new Date()) {
  return withScope(db, viewer, async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const entityRow = { id: entities.id, name: entities.name, type: entities.type, summary: entities.summary, personId: entities.personId };
    const personRow = { id: people.id, name: people.displayName, email: people.primaryEmail, isMember: people.isMember, department: people.department };
    let [entity] = await tx.select(entityRow).from(entities).where(eq(entities.id, id));
    let [person] = entity?.personId ? await tx.select(personRow).from(people).where(eq(people.id, entity.personId)) : [];
    if (!entity) {
      [person] = await tx.select(personRow).from(people).where(eq(people.id, id));
      if (!person) return undefined;
      [entity] = await tx.select(entityRow).from(entities).where(eq(entities.personId, id)).orderBy(desc(entities.updatedAt)).limit(1);
    }

    // Current facts touching them, newest first, each with the entity at the other end.
    const source = aliasedTable(entities, "source");
    const target = aliasedTable(entities, "target");
    const facts = entity
      ? await tx
          .select({
            id: edges.id,
            relation: edges.relation,
            fact: edges.fact,
            confidence: edges.confidence,
            disputed: sql<boolean>`${edges.disputeGroup} is not null`,
            verifiedAt: edges.verifiedAt,
            since: sql<Date>`coalesce(${edges.lastConfirmedAt}, ${edges.createdAt})`.mapWith(edges.createdAt),
            validFrom: edges.validFrom,
            messageId: sql<string | null>`${edges.sourceMessageIds}[1]`,
            sourceId: edges.sourceEntityId,
            sourceName: source.name,
            sourceType: source.type,
            sourcePersonId: source.personId,
            targetId: edges.targetEntityId,
            targetName: target.name,
            targetType: target.type,
          })
          .from(edges)
          .innerJoin(source, eq(source.id, edges.sourceEntityId))
          .innerJoin(target, eq(target.id, edges.targetEntityId))
          .where(and(or(eq(edges.sourceEntityId, entity.id), eq(edges.targetEntityId, entity.id)), isNull(edges.expiredAt)))
          .orderBy(desc(edges.createdAt))
          .limit(60)
      : [];
    const stale = now.getTime() - STALE_DAYS * 86_400_000;
    const others = new Map<string, { id: string; name: string; type: string; facts: number; latest: string }>();
    for (const f of facts) {
      const outward = f.sourceId === entity!.id;
      const other = outward ? { id: f.targetId, name: f.targetName, type: f.targetType } : { id: f.sourceId, name: f.sourceName, type: f.sourceType };
      if (other.id === entity!.id) continue;
      const seen = others.get(other.id);
      if (seen) seen.facts++;
      else others.set(other.id, { ...other, facts: 1, latest: f.fact });
    }
    const employer = facts.find((f) => f.sourceId === entity?.id && f.targetType === "company" && WORKS_AT.test(f.relation));
    const staff = facts.filter((f) => f.targetId === entity?.id && f.sourceType === "person" && WORKS_AT.test(f.relation));
    // Whose promises and messages count as theirs: the person, or for a company the people who work there.
    const side = [...new Set([...(person ? [person.id] : []), ...staff.flatMap((f) => (f.sourcePersonId ? [f.sourcePersonId] : []))])];

    const aliases = entity ? await tx.select({ alias: entityAliases.alias }).from(entityAliases).where(eq(entityAliases.entityId, entity.id)).orderBy(entityAliases.alias) : [];

    const owner = aliasedTable(people, "owner");
    const counterparty = aliasedTable(people, "counterparty");
    const involved = or(side.length ? inArray(commitments.ownerPersonId, side) : undefined, side.length ? inArray(commitments.counterpartyPersonId, side) : undefined, entity ? eq(commitments.relatedEntityId, entity.id) : undefined);
    const promises = await tx
      .select({
        id: commitments.id,
        title: commitments.title,
        status: commitments.status,
        dueAt: commitments.dueAt,
        dueText: commitments.dueText,
        ownerId: commitments.ownerPersonId,
        owner: owner.displayName,
        ownerIsMember: owner.isMember,
        to: sql<string | null>`coalesce(${counterparty.displayName}, ${commitments.counterpartyText})`,
        messageId: commitments.sourceMessageId,
      })
      .from(commitments)
      .leftJoin(owner, eq(owner.id, commitments.ownerPersonId))
      .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
      .where(and(involved, inArray(commitments.status, OPEN)))
      .orderBy(sql`${commitments.dueAt} asc nulls last`)
      .limit(40);
    const theirs = (p: (typeof promises)[number]) => (p.ownerId ? side.includes(p.ownerId) || (!person && p.ownerIsMember === false) : false);

    // Where they come up: conversations they wrote in, and conversations that mention them.
    const wrote = side.length
      ? await tx.select({ threadId: messages.threadId, lastAt: max(messages.sentAt), n: count() }).from(messages).where(and(inArray(messages.authorPersonId, side), isNull(messages.deletedAt))).groupBy(messages.threadId).orderBy(desc(max(messages.sentAt))).limit(8)
      : [];
    const mentioned = entity
      ? await tx
          .select({ threadId: chunks.threadId, lastAt: max(chunks.endAt), n: count() })
          .from(entityMentions)
          .innerJoin(chunks, eq(chunks.id, entityMentions.chunkId))
          .where(eq(entityMentions.entityId, entity.id))
          .groupBy(chunks.threadId)
          .orderBy(desc(max(chunks.endAt)))
          .limit(8)
      : [];
    const lastByThread = new Map<string, Date>();
    for (const t of [...wrote, ...mentioned]) {
      const at = t.lastAt ? new Date(t.lastAt) : undefined;
      if (at && (lastByThread.get(t.threadId)?.getTime() ?? 0) < at.getTime()) lastByThread.set(t.threadId, at);
    }
    const threadIds = [...lastByThread].sort((a, b) => b[1].getTime() - a[1].getTime()).slice(0, 8).map(([threadId]) => threadId);
    const titled = threadIds.length
      ? await tx
          .select({
            id: threads.id,
            title: threads.title,
            kind: threads.kind,
            messageId: sql<string | null>`(select m.id from messages m where m.thread_id = ${threads.id} and m.deleted_at is null order by m.sent_at desc limit 1)`,
          })
          .from(threads)
          .where(inArray(threads.id, threadIds))
      : [];
    const conversations = threadIds.flatMap((threadId) => {
      const t = titled.find((x) => x.id === threadId);
      return t ? [{ ...t, lastAt: lastByThread.get(threadId)! }] : [];
    });

    // Meetings on the viewer's own calendar with them (or, for a company, with its people).
    const attendee = (value: Record<string, string>) => sql`${events.attendees} @> ${JSON.stringify([value])}::jsonb`;
    const withThem = or(...side.map((personId) => attendee({ personId })), ...(person?.email ? [attendee({ email: person.email })] : []));
    const mine = and(eq(events.ownerPersonId, viewer.personId), eq(events.cancelled, false), withThem);
    const meeting = { id: events.id, title: events.title, startsAt: events.startsAt, url: events.url };
    const [nextMeeting] = withThem ? await tx.select(meeting).from(events).where(and(mine, gte(events.startsAt, now))).orderBy(asc(events.startsAt)).limit(1) : [];
    const [lastMeeting] = withThem ? await tx.select(meeting).from(events).where(and(mine, lt(events.startsAt, now))).orderBy(desc(events.startsAt)).limit(1) : [];

    return {
      id: entity?.id ?? person!.id,
      name: entity?.name ?? person!.name,
      type: entity?.type ?? "person",
      summary: entity?.summary ?? null,
      person: person ?? null,
      aliases: aliases.map((a) => a.alias).filter((a) => a !== entity?.name),
      company: employer ? { id: employer.targetId, name: employer.targetName } : null,
      role: facts.find((f) => f.sourceId === entity?.id && ROLE.test(f.relation))?.fact ?? null,
      staff: [...new Map(staff.map((f) => [f.sourceId, { id: f.sourceId, name: f.sourceName }])).values()],
      related: [...others.values()].sort((a, b) => b.facts - a.facts).slice(0, 8),
      facts: facts.slice(0, 30).map((f) => ({
        id: f.id,
        fact: f.fact,
        confidence: f.confidence,
        disputed: f.disputed,
        verified: !!f.verifiedAt,
        stale: !f.verifiedAt && f.since.getTime() < stale,
        validFrom: f.validFrom,
        messageId: f.messageId,
      })),
      theyOwe: promises.filter(theirs),
      owedToThem: promises.filter((p) => !theirs(p)),
      conversations,
      nextMeeting: nextMeeting ?? null,
      lastMeeting: lastMeeting ?? null,
      attention: await openInsights(tx, { subjectEntityId: entity?.id, subjectPersonId: person?.id, limit: 10 }),
    };
  });
}

export type Subject = NonNullable<Awaited<ReturnType<typeof loadSubject>>>;
