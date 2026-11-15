import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { commitments, connections, edges, entities, messages, rollups, secrets, threads } from "@/db/schema";

/**
 * Deletes a source and everything derived only from it: its threads, messages and
 * search chunks (by cascade), the promises made in it, facts whose evidence was only
 * there, daily summaries of its threads, entities nothing else mentions, and its saved credential.
 */
export async function forgetConnection(db: Db, orgId: string, connectionId: string) {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const msgIds = (await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.orgId, orgId), eq(messages.connectionId, connectionId)))).map((m) => m.id);
    const threadIds = (await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.orgId, orgId), eq(threads.connectionId, connectionId)))).map((t) => t.id);
    const ids = `{${msgIds.join(",")}}`;

    const promises = msgIds.length ? await tx.delete(commitments).where(and(eq(commitments.orgId, orgId), inArray(commitments.sourceMessageId, msgIds))).returning({ id: commitments.id }) : [];
    // Facts whose every piece of evidence came from this source.
    const facts = msgIds.length ? await tx.delete(edges).where(and(eq(edges.orgId, orgId), sql`${edges.sourceMessageIds} <@ ${ids}::uuid[]`)).returning({ id: edges.id }) : [];
    if (threadIds.length) await tx.delete(rollups).where(and(eq(rollups.orgId, orgId), eq(rollups.scopeType, "thread"), inArray(rollups.scopeId, threadIds)));
    await tx.delete(connections).where(and(eq(connections.orgId, orgId), eq(connections.id, connectionId)));
    await tx.delete(secrets).where(and(eq(secrets.orgId, orgId), eq(secrets.kind, "connection"), eq(secrets.refId, connectionId)));
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
    return { messages: msgIds.length, threads: threadIds.length, promises: promises.length, facts: facts.length, entities: orphans.length };
  });
}
