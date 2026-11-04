import { and, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { chunks, connections, edges, entities, entityMentions, messages, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { sourceOf } from "@/lib/sources";
import { getViewer } from "@/lib/viewer";
import { GraphView } from "./graph-view";
import { overviewLayout, treeLayout, type GraphData } from "./positions";

export const metadata: Metadata = { title: "Graph · ALRO" };

/** Entities sent to the page (the views draw the most important of them); the rest stay searchable by the agent. */
const MAX_ENTITIES = 500;

export default function GraphPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Graph />
    </Suspense>
  );
}

async function Graph() {
  await connection();
  const viewer = await getViewer();
  const data = await withScope(getDb(), viewer, async (tx) => {
    const threadRows = await tx
      .select({
        id: threads.id,
        title: threads.title,
        kind: threads.kind,
        provider: connections.provider,
        messages: count(messages.id),
        lastAt: max(messages.sentAt),
      })
      .from(threads)
      .innerJoin(connections, eq(connections.id, threads.connectionId))
      .leftJoin(messages, and(eq(messages.threadId, threads.id), isNull(messages.deletedAt)))
      .groupBy(threads.id, connections.provider)
      .orderBy(desc(max(messages.sentAt)));

    const mentions = count(sql`distinct ${entityMentions.chunkId}`);
    const entityRows = await tx
      .select({ id: entities.id, name: entities.name, type: entities.type, summary: entities.summary, mentions })
      .from(entities)
      .leftJoin(entityMentions, eq(entityMentions.entityId, entities.id))
      .groupBy(entities.id)
      .orderBy(desc(mentions), entities.name)
      .limit(MAX_ENTITIES);
    const ids = entityRows.map((e) => e.id);

    const [edgeRows, placeRows] = ids.length
      ? await Promise.all([
          tx
            .select({
              id: edges.id,
              source: edges.sourceEntityId,
              target: edges.targetEntityId,
              relation: edges.relation,
              fact: edges.fact,
              current: sql<boolean>`${edges.expiredAt} is null`,
              validFrom: edges.validFrom,
              validTo: edges.validTo,
            })
            .from(edges)
            .where(and(inArray(edges.sourceEntityId, ids), inArray(edges.targetEntityId, ids)))
            .orderBy(desc(edges.validFrom)),
          tx
            .select({ entityId: entityMentions.entityId, threadId: chunks.threadId, n: count() })
            .from(entityMentions)
            .innerJoin(chunks, eq(chunks.id, entityMentions.chunkId))
            .where(inArray(entityMentions.entityId, ids))
            .groupBy(entityMentions.entityId, chunks.threadId),
        ])
      : [[], []];

    return { threadRows, entityRows, edgeRows, placeRows };
  });

  const graph: GraphData = {
    threads: data.threadRows.map((t) => {
      const source = sourceOf(t.provider);
      return {
        id: t.id,
        title: t.title ?? "Untitled",
        kind: t.kind,
        source: source.key,
        sourceLabel: source.label,
        messages: t.messages,
        lastAt: t.lastAt ? new Date(t.lastAt).toISOString() : null,
      };
    }),
    entities: data.entityRows.map((e) => ({ id: e.id, name: e.name, type: e.type, summary: e.summary, mentions: e.mentions })),
    edges: data.edgeRows.map((e) => ({
      ...e,
      validFrom: e.validFrom?.toISOString() ?? null,
      validTo: e.validTo?.toISOString() ?? null,
    })),
    places: data.placeRows,
  };

  if (!graph.threads.length) {
    return <p className="muted">Nothing connected yet. Upload an export to see it here.</p>;
  }
  return <GraphView data={graph} initial={{ tree: treeLayout(graph), overview: overviewLayout(graph) }} />;
}
