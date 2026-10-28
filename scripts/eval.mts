/**
 * Runs the real pipeline (AI Gateway models) over the founder fixtures in an
 * in-memory database and scores commitments against the gold set. Never
 * touches DATABASE_URL.
 *   AI_GATEWAY_API_KEY=... npm run eval
 * Exits 1 if precision, recall or outcome accuracy fall below EVAL_MIN_*.
 */
import { aliasedTable, eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { defaultModels, modelId } from "@/ai/models";
import { commitments, llmRuns, messages } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { formatReport, loadGold, score } from "@/evals/gold";
import { FIXTURE_DIR, loadFounderFixtures } from "@/ingest/fixtures";
import { runPipeline } from "@/pipeline/run";
import { runWatcher } from "@/pipeline/watcher";

/** "Today" in the story: Tue 27 Oct 2026, 10:00 IST. */
const STORY_NOW = new Date("2026-10-27T04:30:00Z");
const thresholds = {
  precision: Number(process.env.EVAL_MIN_PRECISION ?? 0.7),
  recall: Number(process.env.EVAL_MIN_RECALL ?? 0.8),
  outcomeAccuracy: Number(process.env.EVAL_MIN_OUTCOME ?? 0.7),
};

const models = defaultModels();
console.log(`screen ${modelId(models.screen)} · extract ${modelId(models.extract)} · embed ${modelId(models.embed)}`);

const { db, close } = await createTestDb();
const { orgId } = await loadFounderFixtures(db);
for (let pass = 1; ; pass++) {
  const r = await runPipeline(db, orgId, models);
  if ("skipped" in r) throw new Error("Another pipeline run holds the lease");
  console.log(`pass ${pass}: ${r.chunks} chunks, ${r.screened} screened, ${JSON.stringify(r.extraction)}`);
  if (!r.screened && !r.extraction.calls) break;
}
await runWatcher(db, orgId, STORY_NOW);

const closing = aliasedTable(messages, "closing");
const rows = await db
  .select({
    id: commitments.id,
    title: commitments.title,
    quote: commitments.quote,
    status: commitments.status,
    sourceText: messages.text,
    fulfilledByText: closing.text,
  })
  .from(commitments)
  .innerJoin(messages, eq(messages.id, commitments.sourceMessageId))
  .leftJoin(closing, eq(closing.id, commitments.fulfilledByMessageId))
  .where(eq(commitments.orgId, orgId));

const report = score(loadGold(path.join(FIXTURE_DIR, "labels")), rows);
const usage = await db.select().from(llmRuns);
const tokens = (stage: string) => usage.filter((u) => u.stage === stage).reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
console.log(`\ntokens: screen ${tokens("screen")}, extract ${tokens("extract")}, embed ${tokens("embed")}\n`);
console.log(formatReport(report));

const out = path.join(process.cwd(), "eval-report.json");
writeFileSync(out, JSON.stringify({ models: { screen: modelId(models.screen), extract: modelId(models.extract) }, thresholds, ...report }, null, 2));
console.log(`\nWrote ${out}`);
await close();

const failed = (Object.keys(thresholds) as (keyof typeof thresholds)[]).filter((k) => report[k] < thresholds[k]);
if (failed.length) {
  console.error(`\nBelow threshold: ${failed.map((k) => `${k} ${report[k].toFixed(3)} < ${thresholds[k]}`).join(", ")}`);
  process.exit(1);
}
process.exit(0);
