import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, commitmentEvents, commitments, connections, edges, entities, insights, meetingNotes, messages, procedures, rollups, secrets, threadMembers, threads, trackerRows } from "@/db/schema";
import { rebuildAcls, uuidArray } from "./revoke";

/**
 * Deletes a source and everything derived only from it: its threads, messages and search chunks (by
 * cascade), the promises made in it, facts, insights and summaries whose evidence was only there, tracker
 * rows copied from its messages, procedures written only from it, entities nothing else mentions, and its
 * saved credential.
 *
 * What also rests on other sources stays, without this one's part: its messages come off the evidence,
 * quotes from them come out of promise histories, and visibility is worked out again from what is left, so
 * nothing stays open to people only because this source once showed it to them.
 *
 * An agent team's past reports (team_runs) are free text with no record of the messages behind them, so
 * they can't be traced to a source and are left; only the person who asked can read them.
 */
export async function forgetConnection(db: Db, orgId: string, connectionId: string) {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const msgIds = (await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.orgId, orgId), eq(messages.connectionId, connectionId)))).map((m) => m.id);
    const threadIds = (await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.orgId, orgId), eq(threads.connectionId, connectionId)))).map((t) => t.id);
    return forgetEvidence(tx, orgId, msgIds, threadIds, async () => {
      await tx.delete(connections).where(and(eq(connections.orgId, orgId), eq(connections.id, connectionId)));
      await tx.delete(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.kind, "connection"), eq(secrets.refId, connectionId)));
    });
  });
}

/**
 * Tells ALRO not to read one conversation (an HR channel, a board thread): everything it took from it
 * is deleted as when a source is removed, and the conversation stays only as a marker so later syncs
 * skip it. Including it again lets the next sync bring its recent history back.
 */
export async function excludeThread(db: Db, orgId: string, threadId: string, now = new Date()) {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [thread] = await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)));
    if (!thread) throw new Error("Not found");
    const msgIds = (await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.orgId, orgId), eq(messages.threadId, threadId)))).map((m) => m.id);
    return forgetEvidence(tx, orgId, msgIds, [threadId], async () => {
      await tx.delete(chunks).where(eq(chunks.threadId, threadId));
      await tx.delete(meetingNotes).where(eq(meetingNotes.threadId, threadId));
      await tx.delete(messages).where(eq(messages.threadId, threadId));
      await tx.delete(threadMembers).where(eq(threadMembers.threadId, threadId));
      await tx.update(threads).set({ excludedAt: now }).where(eq(threads.id, threadId));
    });
  });
}

/** Lets ALRO read an excluded conversation again, from the next sync. */
export async function includeThread(db: Db, orgId: string, threadId: string) {
  await db.update(threads).set({ excludedAt: null }).where(and(eq(threads.orgId, orgId), eq(threads.id, threadId)));
}

/** Removes everything derived from these messages and threads, runs `remove` to delete the rows themselves, then tidies what is left. */
async function forgetEvidence(tx: Db, orgId: string, msgIds: string[], threadIds: string[], remove: () => Promise<void>) {
  const ids = uuidArray(msgIds);
  const here = uuidArray(threadIds);
  /** Rows whose every piece of evidence came from this source, and rows with some of it. */
  const onlyFrom = (column: SQL) => sql`(cardinality(${column}) > 0 and ${column} <@ ${ids})`;
  const partlyFrom = (column: SQL) => sql`${column} && ${ids}`;
  const without = (column: SQL) => sql`array(select x from unnest(${column}) x where x <> all(${ids}))`;

  // Entities this source said something about: who can see them is worked out again once it is gone.
  const described = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.orgId, orgId),
        sql`(exists (select 1 from entity_mentions em join chunks c on c.id = em.chunk_id where em.entity_id = ${entities.id} and c.thread_id = any(${here}))
          or exists (select 1 from edges e where (e.source_entity_id = ${entities.id} or e.target_entity_id = ${entities.id}) and e.source_message_ids && ${ids}))`,
      ),
    );

  const promises = await tx.delete(commitments).where(and(eq(commitments.orgId, orgId), sql`${commitments.sourceMessageId} = any(${ids})`)).returning({ id: commitments.id });
  const facts = await tx.delete(edges).where(and(eq(edges.orgId, orgId), onlyFrom(sql`${edges.sourceMessageIds}`))).returning({ id: edges.id });
  const noticed = await tx.delete(insights).where(and(eq(insights.orgId, orgId), onlyFrom(sql`${insights.evidenceMessageIds}`))).returning({ id: insights.id });
  await tx
    .delete(rollups)
    .where(and(eq(rollups.orgId, orgId), sql`((${rollups.scopeType} = 'thread' and ${rollups.scopeId} = any(${here})) or ${onlyFrom(sql`${rollups.sourceMessageIds}`)})`));
  const copied = await tx.delete(trackerRows).where(and(eq(trackerRows.orgId, orgId), sql`${trackerRows.messageId} = any(${ids})`)).returning({ id: trackerRows.id });
  const written = await tx.delete(procedures).where(and(eq(procedures.orgId, orgId), onlyFrom(sql`${procedures.messageIds}`))).returning({ id: procedures.id });

  const mixedFacts = await tx
    .update(edges)
    .set({ sourceMessageIds: without(sql`${edges.sourceMessageIds}`) })
    .where(and(eq(edges.orgId, orgId), partlyFrom(sql`${edges.sourceMessageIds}`)))
    .returning({ id: edges.id });
  const mixedPromises = await tx
    .update(commitments)
    .set({ evidenceMessageIds: without(sql`${commitments.evidenceMessageIds}`) })
    .where(and(eq(commitments.orgId, orgId), partlyFrom(sql`${commitments.evidenceMessageIds}`)))
    .returning({ id: commitments.id });
  const mixedInsights = await tx
    .update(insights)
    .set({ evidenceMessageIds: without(sql`${insights.evidenceMessageIds}`) })
    .where(and(eq(insights.orgId, orgId), partlyFrom(sql`${insights.evidenceMessageIds}`)))
    .returning({ id: insights.id });
  const mixedRollups = await tx
    .update(rollups)
    .set({ sourceMessageIds: without(sql`${rollups.sourceMessageIds}`) })
    .where(and(eq(rollups.orgId, orgId), partlyFrom(sql`${rollups.sourceMessageIds}`)))
    .returning({ id: rollups.id });
  await tx
    .update(procedures)
    .set({ messageIds: without(sql`${procedures.messageIds}`) })
    .where(and(eq(procedures.orgId, orgId), partlyFrom(sql`${procedures.messageIds}`)));
  // A promise made elsewhere keeps its history, minus the words quoted from this source.
  await tx
    .update(commitmentEvents)
    .set({ detail: sql`${commitmentEvents.detail} - 'quote'` })
    .where(and(eq(commitmentEvents.orgId, orgId), sql`${commitmentEvents.messageId} = any(${ids})`));

  await remove();
  // Entities left with no mentions and no facts.
  const orphans = await tx
    .delete(entities)
    .where(
      and(
        eq(entities.orgId, orgId),
        sql`not exists (select 1 from entity_mentions m where m.entity_id = ${entities.id})`,
        sql`not exists (select 1 from edges g where g.source_entity_id = ${entities.id} or g.target_entity_id = ${entities.id})`,
      ),
    )
    .returning({ id: entities.id });
  await rebuildAcls(tx, orgId, {
    edges: mixedFacts.map((r) => r.id),
    commitments: mixedPromises.map((r) => r.id),
    rollups: mixedRollups.map((r) => r.id),
    insights: mixedInsights.map((r) => r.id),
    entities: described.map((r) => r.id),
  });
  return {
    messages: msgIds.length,
    threads: threadIds.length,
    promises: promises.length,
    facts: facts.length,
    entities: orphans.length,
    insights: noticed.length,
    trackerRows: copied.length,
    procedures: written.length,
  };
}
