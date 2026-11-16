import { embedMany } from "ai";
import { and, eq, isNull } from "drizzle-orm";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { edges, entities } from "@/db/schema";
import { entityText } from "@/pipeline/graph";
import { runPipeline } from "@/pipeline/run";

/**
 * Facts and entities are saved (with their source marked as processed) in one transaction,
 * and embedded just after it. If a run dies in between, they exist but can't be found by
 * meaning, and nothing would ever come back for them. This embeds any that are missing.
 * Run after each processing pass; it normally finds nothing.
 */
export async function embedMissing(db: Db, orgId: string, models: Models, limit = 200): Promise<{ facts: number; entities: number }> {
  const facts = await db.select({ id: edges.id, text: edges.fact }).from(edges).where(and(eq(edges.orgId, orgId), isNull(edges.factEmbedding), isNull(edges.expiredAt))).limit(limit);
  const named = await db.select({ id: entities.id, name: entities.name, type: entities.type, summary: entities.summary }).from(entities).where(and(eq(entities.orgId, orgId), isNull(entities.nameEmbedding))).limit(limit);
  const values = [...facts.map((f) => f.text), ...named.map(entityText)];
  if (!values.length) return { facts: 0, entities: 0 };
  const { embeddings, usage } = await embedMany({ model: models.embed, values, dimensions: models.embedDimensions });
  await recordRun(db, { orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
  for (const [i, f] of facts.entries()) await db.update(edges).set({ factEmbedding: embeddings[i] }).where(eq(edges.id, f.id));
  for (const [i, e] of named.entries()) await db.update(entities).set({ nameEmbedding: embeddings[facts.length + i] }).where(eq(entities.id, e.id));
  return { facts: facts.length, entities: named.length };
}

/** One processing pass for a company, then the embedding repair above. What the cron jobs and "Process now" run. */
export async function processAndRepair(db: Db, orgId: string, models: Models) {
  const result = await runPipeline(db, orgId, models);
  if ("skipped" in result) return result;
  return { ...result, repaired: await embedMissing(db, orgId, models) };
}
