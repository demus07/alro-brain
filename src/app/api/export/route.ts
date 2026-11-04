import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { commitments, connections, edges, entities, messages, people, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { getViewer } from "@/lib/viewer";

/** Everything the asker can see, as one JSON file: sources, conversations, messages, promises and the knowledge graph. */
export async function GET() {
  const viewer = await getViewer();
  const data = await withScope(getDb(), viewer, async (tx) => ({
    exportedAt: new Date().toISOString(),
    exportedBy: viewer.email,
    sources: await tx.select({ id: connections.id, provider: connections.provider, scope: connections.scope, lastSyncedAt: connections.lastSyncedAt }).from(connections),
    people: await tx.select({ id: people.id, name: people.displayName, email: people.primaryEmail }).from(people),
    conversations: await tx.select({ id: threads.id, sourceId: threads.connectionId, kind: threads.kind, title: threads.title, url: threads.url }).from(threads),
    messages: await tx
      .select({ id: messages.id, conversationId: messages.threadId, authorId: messages.authorPersonId, sentAt: messages.sentAt, subject: messages.subject, text: messages.text, url: messages.url, deletedAt: messages.deletedAt })
      .from(messages)
      .orderBy(messages.sentAt),
    promises: await tx.select().from(commitments),
    entities: await tx.select({ id: entities.id, type: entities.type, name: entities.name, summary: entities.summary }).from(entities),
    facts: await tx
      .select({ id: edges.id, from: edges.sourceEntityId, to: edges.targetEntityId, relation: edges.relation, fact: edges.fact, validFrom: edges.validFrom, validTo: edges.validTo, current: sql<boolean>`${edges.expiredAt} is null` })
      .from(edges),
  }));
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json", "content-disposition": `attachment; filename="alro-export-${new Date().toISOString().slice(0, 10)}.json"` },
  });
}
