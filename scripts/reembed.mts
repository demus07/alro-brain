/**
 * Re-embeds everything stored (chunks, entities, facts, daily summaries) with the embedding model
 * now configured. Every vector must come from one model, so run this after changing
 * ALRO_EMBEDDING_MODEL; until it finishes, search by meaning mixes two models and is unreliable.
 *   npm run reembed
 * Rows are updated in place, so the knowledge graph and its links to chunks are kept. Safe to
 * re-run: it starts again from the beginning. On the local database, stop the dev server first
 * (it is one shared session).
 */
import { embedMany } from "ai";
import { eq, sql } from "drizzle-orm";
import { defaultModels, modelId, recordRun } from "@/ai/models";
import { getDb } from "@/db/client";
import { chunks, edges, entities, rollups, threads } from "@/db/schema";
import { entityText } from "@/pipeline/graph";

/** Texts per embedding request. */
const BATCH = 64;

const db = getDb();
const models = defaultModels();

type Row = { id: string; orgId: string; text: string };

async function reembed(label: string, rows: Row[], save: (id: string, embedding: number[]) => Promise<unknown>) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { embeddings, usage } = await embedMany({ model: models.embed, values: batch.map((r) => r.text), dimensions: models.embedDimensions });
    for (const [j, r] of batch.entries()) await save(r.id, embeddings[j]);
    // Usage is per company; a batch is charged to the company of its first row (local data is one company).
    await recordRun(db, { orgId: batch[0].orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
    done += batch.length;
    process.stdout.write(`\r${label.padEnd(9)} ${done}/${rows.length}`);
  }
  console.log(rows.length ? "" : `${label.padEnd(9)} nothing to do`);
}

console.log(`Re-embedding with ${modelId(models.embed)}`);

const chunkRows = await db.select({ id: chunks.id, orgId: chunks.orgId, text: chunks.text }).from(chunks);
await reembed("chunks", chunkRows, (id, embedding) => db.update(chunks).set({ embedding }).where(eq(chunks.id, id)));

const entityRows = await db.select({ id: entities.id, orgId: entities.orgId, name: entities.name, type: entities.type, summary: entities.summary }).from(entities);
await reembed(
  "entities",
  entityRows.map((e) => ({ id: e.id, orgId: e.orgId, text: entityText(e) })),
  (id, embedding) => db.update(entities).set({ nameEmbedding: embedding }).where(eq(entities.id, id)),
);

const factRows = await db.select({ id: edges.id, orgId: edges.orgId, text: edges.fact }).from(edges);
await reembed("facts", factRows, (id, embedding) => db.update(edges).set({ factEmbedding: embedding }).where(eq(edges.id, id)));

// Daily summaries are embedded as "<thread title>: <summary>", as when they were written.
const rollupRows = await db
  .select({ id: rollups.id, orgId: rollups.orgId, summary: rollups.summary, title: threads.title })
  .from(rollups)
  .leftJoin(threads, sql`${rollups.scopeType} = 'thread' and ${threads.id} = ${rollups.scopeId}`);
await reembed(
  "summaries",
  rollupRows.map((r) => ({ id: r.id, orgId: r.orgId, text: r.title ? `${r.title}: ${r.summary}` : r.summary })),
  (id, embedding) => db.update(rollups).set({ embedding }).where(eq(rollups.id, id)),
);

process.exit(0);
