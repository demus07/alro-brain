import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { chunks, commitments, edges, entities, messages, orgs, rollups, threads, trackerRows } from "@/db/schema";
import { purgeRevoked } from "@/memory/revoke";

/**
 * Deletes what is older than the company's retention period: messages, their search index,
 * promises made in them, facts whose only evidence was in them, summaries of those days, tracker
 * rows from then, and conversations and entities left empty. Does nothing when no period is set.
 */
export async function applyRetention(db: Db, orgId: string, now = new Date()): Promise<{ messages: number } | undefined> {
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const days = org?.settings.retentionDays;
  if (!days || days < 30) return undefined;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const old = sql`(select m.id from messages m where m.org_id = ${orgId} and m.sent_at < ${cutoff.toISOString()}::timestamptz)`;
    await tx.delete(commitments).where(and(eq(commitments.orgId, orgId), sql`${commitments.sourceMessageId} in ${old}`));
    // A fact goes only when none of its evidence is newer than the cutoff.
    await tx.delete(edges).where(
      and(
        eq(edges.orgId, orgId),
        sql`cardinality(${edges.sourceMessageIds}) > 0`,
        sql`not exists (select 1 from messages m where m.id = any(${edges.sourceMessageIds}) and m.sent_at >= ${cutoff.toISOString()}::timestamptz)`,
      ),
    );
    await tx.delete(chunks).where(and(eq(chunks.orgId, orgId), lt(chunks.endAt, cutoff)));
    await tx.delete(rollups).where(and(eq(rollups.orgId, orgId), lt(rollups.periodEnd, cutoff)));
    await tx.delete(trackerRows).where(and(eq(trackerRows.orgId, orgId), lt(trackerRows.at, cutoff)));
    const gone = await tx.delete(messages).where(and(eq(messages.orgId, orgId), lt(messages.sentAt, cutoff))).returning({ id: messages.id });
    await tx.delete(threads).where(and(eq(threads.orgId, orgId), lt(threads.createdAt, cutoff), sql`${threads.excludedAt} is null`, sql`not exists (select 1 from messages m where m.thread_id = ${threads.id})`));
    await tx.delete(entities).where(
      and(
        eq(entities.orgId, orgId),
        sql`not exists (select 1 from entity_mentions m where m.entity_id = ${entities.id})`,
        sql`not exists (select 1 from edges g where g.source_entity_id = ${entities.id} or g.target_entity_id = ${entities.id})`,
      ),
    );
    return { messages: gone.length };
  });
  // Copies of deleted text in trackers and procedures go too.
  if (result.messages) await purgeRevoked(db, orgId);
  return result;
}

/** Deletes a company and everything ALRO holds for it. Every table hangs off the company, so this leaves nothing behind. */
export async function deleteCompany(db: Db, orgId: string) {
  await db.delete(orgs).where(eq(orgs.id, orgId));
}
