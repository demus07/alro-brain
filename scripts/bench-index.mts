/**
 * Compares models for the indexing stages (screen, then extract) on a small slice of the founder
 * fixtures, so it fits a free OpenRouter day (about 15 calls per model). The slice is the few
 * (conversation, day) groups with the most labelled promises; every model gets the same one.
 * Never touches DATABASE_URL.
 *   npm run bench:index -- <label> [groups]
 * with ALRO_*_MODEL (and ALRO_*_BASE_URL) set for the model under test. Writes bench-<label>.json.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { aliasedTable, eq } from "drizzle-orm";
import { defaultModels, modelId } from "@/ai/models";
import { commitments, llmRuns, messages } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { loadGold, score } from "@/evals/gold";
import { FIXTURE_DIR, loadFounderFixtures } from "@/ingest/fixtures";
import { extractPending } from "@/pipeline/extract";
import { screenPending } from "@/pipeline/screen";

const [label = "run", groupCount = "10"] = process.argv.slice(2);
const models = defaultModels();
console.log(`${label}: screen ${modelId(models.screen)} · extract ${modelId(models.extract)}`);

const { db, close } = await createTestDb();
const { orgId } = await loadFounderFixtures(db);
const gold = loadGold(path.join(FIXTURE_DIR, "labels"));

// The slice: whole (thread, day) groups, richest in labelled promises first.
const all = await db.select({ id: messages.id, threadId: messages.threadId, sentAt: messages.sentAt, text: messages.text }).from(messages).where(eq(messages.orgId, orgId));
const day = (m: { threadId: string; sentAt: Date }) => `${m.threadId}|${m.sentAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}`;
const goldIn = (text: string) => gold.items.filter((i) => text.includes(i.quote));
const groups = new Map<string, typeof all>();
for (const m of all) groups.set(day(m), [...(groups.get(day(m)) ?? []), m]);
const ranked = [...groups.entries()]
  .map(([key, list]) => ({ key, list, promises: new Set(list.flatMap((m) => goldIn(m.text).map((i) => i.commitment_id))).size }))
  .filter((g) => g.promises > 0 && g.list.length <= 45)
  .sort((a, b) => b.promises - a.promises || b.list.length - a.list.length)
  .slice(0, Number(groupCount));
const slice = new Set(ranked.flatMap((g) => g.list.map((m) => m.id)));
for (const m of all) if (!slice.has(m.id)) await db.update(messages).set({ screenResult: "skip" }).where(eq(messages.id, m.id));
const positives = new Set(all.filter((m) => slice.has(m.id) && goldIn(m.text).length > 0).map((m) => m.id));
console.log(`slice: ${slice.size} messages in ${ranked.length} groups, ${positives.size} carry a labelled promise`);

const t0 = Date.now();
const screened = await screenPending(db, orgId, models);
const t1 = Date.now();
const extraction = await extractPending(db, orgId, models);
const t2 = Date.now();

const flagged = new Set((await db.select({ id: messages.id, r: messages.screenResult }).from(messages).where(eq(messages.orgId, orgId))).filter((m) => m.r === "extract").map((m) => m.id));
const caught = [...positives].filter((id) => flagged.has(id)).length;

const closing = aliasedTable(messages, "closing");
const rows = await db
  .select({ id: commitments.id, title: commitments.title, quote: commitments.quote, status: commitments.status, sourceText: messages.text, fulfilledByText: closing.text })
  .from(commitments)
  .innerJoin(messages, eq(messages.id, commitments.sourceMessageId))
  .leftJoin(closing, eq(closing.id, commitments.fulfilledByMessageId))
  .where(eq(commitments.orgId, orgId));
const texts = all.filter((m) => slice.has(m.id)).map((m) => m.text);
const covered = (quote: string) => texts.some((t) => t.includes(quote));
const report = score({ items: gold.items.filter((i) => covered(i.quote)), distractors: gold.distractors.filter((d) => covered(d.quote)) }, rows);
const calls = await db.select().from(llmRuns);

const result = {
  label,
  models: { screen: modelId(models.screen), extract: modelId(models.extract) },
  slice: { messages: slice.size, labelledMessages: positives.size },
  screen: { calls: calls.filter((c) => c.stage === "screen").length, seconds: (t1 - t0) / 1000, flagged: flagged.size, recall: positives.size ? caught / positives.size : 0, flagRate: flagged.size / slice.size, screened },
  extract: { stats: extraction, calls: extraction.calls, failed: extraction.failed, seconds: (t2 - t1) / 1000, promises: rows.length, precision: report.precision, recall: report.recall, outcomeAccuracy: report.outcomeAccuracy, distractorHits: report.distractorHits.length },
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(path.join(process.cwd(), `bench-${label}.json`), JSON.stringify(result, null, 2));
await close();
process.exit(0);
