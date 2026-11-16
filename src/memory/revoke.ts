import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, commitments, edges, entities, identities, insights, messages, people, procedures, rollups, trackerRows } from "@/db/schema";
import { stillVisible } from "@/work/messages";

/**
 * Keeping ALRO in step when the source takes something away.
 *
 * Losing a seat in a private channel needs nothing here: access is by principal ('t:<thread>'), so removing
 * the thread_members row hides the thread, its messages and chunks, and every derived row whose ACL is only
 * that thread. What does need work is below: derived rows whose ACL was a union computed when they were
 * written, messages deleted in the source, and text copied out of messages for one person.
 */

export const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/** Every principal on the messages in a uuid[] expression, one per row. */
const principalsOf = (ids: SQL) => sql`select unnest(m.acl) as p from messages m where m.id = any(${ids})`;
/** Those rows as one sorted, de-duplicated ACL. */
const asAcl = (rows: SQL) => sql`(select coalesce(array_agg(distinct s.p order by s.p), '{}'::text[]) from (${rows}) s)`;

const commitmentEvidence = sql`array_append(${commitments.evidenceMessageIds}, ${commitments.sourceMessageId})`;
const mentioned = sql`select 1 from entity_mentions em join chunks c on c.id = em.chunk_id where em.entity_id = ${entities.id}`;
const linked = sql`select 1 from edges e where e.source_entity_id = ${entities.id} or e.target_entity_id = ${entities.id}`;

/** Which rows to rebuild, as a condition per table. */
interface Touched {
  edges: SQL;
  commitments: SQL;
  rollups: SQL;
  insights: SQL;
  /** Decided after the facts are rebuilt, since an entity is seen through its facts. */
  entities: (rebuiltEdgeIds: string[]) => SQL;
}

export interface RebuiltAcls {
  edges: number;
  commitments: number;
  rollups: number;
  insights: number;
  entities: number;
}

/**
 * Rebuilds each derived row's ACL from the evidence it records, as it stands now:
 * - facts (edges): the messages in `sourceMessageIds`;
 * - promises: the message they were made in and every evidence message, plus the two people they are between;
 * - daily summaries (rollups): the thread they summarise, or their source messages;
 * - insights: their evidence messages, plus any person named on the row itself;
 * - entities: the chunks that mention them and the facts about them.
 * Meeting notes need nothing: a database trigger keeps them on their thread's ACL.
 */
async function rebuild(db: Db, orgId: string, touched: Touched): Promise<RebuiltAcls> {
  const facts = await db
    .update(edges)
    .set({ acl: asAcl(principalsOf(sql`${edges.sourceMessageIds}`)) })
    .where(and(eq(edges.orgId, orgId), touched.edges))
    .returning({ id: edges.id });
  const promises = await db
    .update(commitments)
    .set({
      acl: asAcl(sql`${principalsOf(commitmentEvidence)}
        union select 'p:' || ${commitments.ownerPersonId}::text where ${commitments.ownerPersonId} is not null
        union select 'p:' || ${commitments.counterpartyPersonId}::text where ${commitments.counterpartyPersonId} is not null`),
    })
    .where(and(eq(commitments.orgId, orgId), touched.commitments))
    .returning({ id: commitments.id });
  const summaries = await db
    .update(rollups)
    .set({
      acl: sql`case when ${rollups.scopeType} = 'thread'
        then coalesce((select t.acl from threads t where t.id = ${rollups.scopeId}), '{}'::text[])
        else ${asAcl(principalsOf(sql`${rollups.sourceMessageIds}`))} end`,
    })
    .where(and(eq(rollups.orgId, orgId), touched.rollups))
    .returning({ id: rollups.id });
  // How an insight's ACL was first worked out isn't recorded, only its evidence messages. So anything the
  // evidence doesn't justify is dropped, except grants to one person ('p:'), which never came from a thread.
  const noticed = await db
    .update(insights)
    .set({ acl: asAcl(sql`${principalsOf(sql`${insights.evidenceMessageIds}`)} union select q.p from unnest(${insights.acl}) q(p) where q.p like 'p:%'`) })
    .where(and(eq(insights.orgId, orgId), touched.insights))
    .returning({ id: insights.id });
  // An entity doesn't record which messages named it, only its mentions (per chunk) and its facts. One with
  // neither can't be traced to anything, so it ends up visible to nobody until something mentions it again
  // (new evidence widens it, see findOrCreateEntity).
  const things = await db
    .update(entities)
    .set({
      acl: asAcl(sql`select unnest(c.acl) as p from entity_mentions em join chunks c on c.id = em.chunk_id where em.entity_id = ${entities.id}
        union select unnest(e.acl) from edges e where e.source_entity_id = ${entities.id} or e.target_entity_id = ${entities.id}`),
    })
    .where(and(eq(entities.orgId, orgId), touched.entities(facts.map((f) => f.id))))
    .returning({ id: entities.id });
  return { edges: facts.length, commitments: promises.length, rollups: summaries.length, insights: noticed.length, entities: things.length };
}

/**
 * After threads changed who can see them (a channel went private or public, a source was limited to a
 * department): rebuilds the ACL of everything derived from them. Messages, chunks and meeting notes already
 * follow their thread through database triggers; this covers the rows that stored a union instead.
 * Entities with no evidence left to trace anywhere in the org are hidden too, the safe side of not knowing.
 */
export async function recomputeDerivedAcls(db: Db, orgId: string, threadIds: string[]): Promise<RebuiltAcls> {
  if (!threadIds.length) return { edges: 0, commitments: 0, rollups: 0, insights: 0, entities: 0 };
  const threads = uuidArray(threadIds);
  const fromThese = (ids: SQL) => sql`exists (select 1 from messages m where m.id = any(${ids}) and m.thread_id = any(${threads}))`;
  return rebuild(db, orgId, {
    edges: fromThese(sql`${edges.sourceMessageIds}`),
    commitments: fromThese(commitmentEvidence),
    rollups: sql`((${rollups.scopeType} = 'thread' and ${rollups.scopeId} = any(${threads})) or (${rollups.scopeType} <> 'thread' and ${fromThese(sql`${rollups.sourceMessageIds}`)}))`,
    insights: fromThese(sql`${insights.evidenceMessageIds}`),
    entities: (edgeIds) => sql`(
      ${entities.acl} && ${`{${threadIds.map((id) => `t:${id}`).join(",")}}`}::text[]
      or exists (${mentioned} and c.thread_id = any(${threads}))
      or exists (select 1 from edges e where (e.source_entity_id = ${entities.id} or e.target_entity_id = ${entities.id}) and e.id = any(${uuidArray(edgeIds)}))
      or (not exists (${mentioned}) and not exists (${linked})))`,
  });
}

/** Rebuilds the ACLs of the given rows, for when some of their evidence was removed (a source was disconnected). */
export async function rebuildAcls(db: Db, orgId: string, rows: { edges: string[]; commitments: string[]; rollups: string[]; insights: string[]; entities: string[] }): Promise<RebuiltAcls> {
  return rebuild(db, orgId, {
    edges: sql`${edges.id} = any(${uuidArray(rows.edges)})`,
    commitments: sql`${commitments.id} = any(${uuidArray(rows.commitments)})`,
    rollups: sql`${rollups.id} = any(${uuidArray(rows.rollups)})`,
    insights: sql`${insights.id} = any(${uuidArray(rows.insights)})`,
    entities: () => sql`${entities.id} = any(${uuidArray(rows.entities)})`,
  });
}

/**
 * Marks the matching stored messages deleted and drops the search chunks that hold them (what is left of a
 * chunk is chunked again on the next run). Returns the ids it retired. The caller's condition must pin the
 * connection or thread.
 */
export async function retireMessages(db: Db, where: SQL | undefined): Promise<string[]> {
  const gone = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(and(where, isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  const ids = gone.map((g) => g.id);
  for (let i = 0; i < ids.length; i += 5000) await db.delete(chunks).where(sql`${chunks.messageIds} && ${uuidArray(ids.slice(i, i + 5000))}`);
  return ids;
}

/**
 * Text copied out of messages for one person must not outlive their access. Deletes tracker rows whose
 * message its owner can no longer open (lost access, deleted in the source, or gone altogether); takes
 * such messages off each procedure's evidence and deletes a procedure left with none. Checked by reading
 * as each owner, so it is exactly what they could open themselves.
 */
export async function purgeRevoked(db: Db, orgId: string): Promise<{ trackerRows: number; procedures: number }> {
  const rows = await db.select({ id: trackerRows.id, personId: trackerRows.personId, messageId: trackerRows.messageId }).from(trackerRows).where(eq(trackerRows.orgId, orgId));
  const written = await db.select({ id: procedures.id, personId: procedures.personId, messageIds: procedures.messageIds }).from(procedures).where(eq(procedures.orgId, orgId));
  const purged = { trackerRows: 0, procedures: 0 };

  for (const personId of new Set([...rows, ...written].map((r) => r.personId))) {
    const mine = rows.filter((r) => r.personId === personId);
    const myProcedures = written.filter((p) => p.personId === personId);
    const cited = [...new Set([...mine.flatMap((r) => (r.messageId ? [r.messageId] : [])), ...myProcedures.flatMap((p) => p.messageIds)])];
    const visible = await stillVisible(db, { orgId, personId }, cited);

    const gone = mine.filter((r) => !r.messageId || !visible.has(r.messageId)).map((r) => r.id);
    for (let i = 0; i < gone.length; i += 5000) await db.delete(trackerRows).where(inArray(trackerRows.id, gone.slice(i, i + 5000)));
    purged.trackerRows += gone.length;

    for (const p of myProcedures) {
      const kept = p.messageIds.filter((id) => visible.has(id));
      if (kept.length === p.messageIds.length) continue;
      if (kept.length) await db.update(procedures).set({ messageIds: kept }).where(eq(procedures.id, p.id));
      else {
        await db.delete(procedures).where(eq(procedures.id, p.id));
        purged.procedures++;
      }
    }
  }
  return purged;
}

export interface DepartedMember {
  personId: string;
  displayName: string;
  email: string | null;
  /** The apps that say their account is closed, and since when ALRO has known. */
  sources: { provider: string; since: Date }[];
}

/**
 * Members who can still sign in to ALRO although a source says their account there was deactivated or
 * deleted. Nobody is removed automatically: an admin decides (someone may only have changed accounts).
 */
export async function departedMembers(db: Db, orgId: string): Promise<DepartedMember[]> {
  const rows = await db
    .select({ personId: people.id, displayName: people.displayName, email: people.primaryEmail, provider: identities.provider, since: identities.deactivatedAt })
    .from(identities)
    .innerJoin(people, eq(people.id, identities.personId))
    .where(and(eq(identities.orgId, orgId), isNotNull(identities.deactivatedAt), eq(people.isMember, true), isNull(people.deactivatedAt)))
    .orderBy(people.displayName, identities.provider);
  const departed = new Map<string, DepartedMember>();
  for (const r of rows) {
    const member = departed.get(r.personId) ?? { personId: r.personId, displayName: r.displayName, email: r.email, sources: [] };
    member.sources.push({ provider: r.provider, since: r.since! });
    departed.set(r.personId, member);
  }
  return [...departed.values()];
}
