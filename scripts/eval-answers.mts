/**
 * Asks the agent real questions about your own data (DATABASE_URL, as
 * ALRO_DEV_USER_EMAIL) and grades the answers. Saves each run to eval_runs,
 * shown on the Health page, so model or retrieval changes can be compared.
 *   npm run eval:answers                      # evals/answers.local.json
 *   EVAL_FILE=evals/answers.example.json npm run eval:answers
 *   ALRO_ANSWER_MODEL=gpt-6-luna npm run eval:answers   # try a cheaper model
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultModels, modelId } from "@/ai/models";
import { getDb } from "@/db/client";
import { evalRuns } from "@/db/schema";
import { gradeAnswer, runAnswerEval, summarize, type AnswerCase, type CaseResult } from "@/evals/answers";
import { getViewer } from "@/lib/viewer";

const file = process.env.EVAL_FILE ?? "evals/answers.local.json";
const cases = JSON.parse(readFileSync(file, "utf8")) as AnswerCase[];
const only = process.env.EVAL_ONLY?.split(",");
const picked = only ? cases.filter((c) => only.includes(c.id)) : cases;

const db = getDb();
const viewer = await getViewer();
const models = defaultModels();
// Grading needs care more than speed; one stronger model keeps scores comparable across runs.
const judge = process.env.OPENAI_API_KEY ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(process.env.ALRO_JUDGE_MODEL ?? "gpt-6.1-terra") : models.extract;
const used = {
  answer: modelId(models.answer),
  graph: modelId(models.graph),
  extract: modelId(models.extract),
  screen: modelId(models.screen),
  embed: modelId(models.embed),
  judge: modelId(judge),
};
console.log(`${picked.length} questions from ${file} as ${viewer.displayName}\n${Object.entries(used).map(([k, v]) => `${k} ${v}`).join(" · ")}\n`);

// EVAL_REGRADE=evals/runs/<file>.json grades a saved run's answers again (a fairer judge, a new rule) without asking anew.
const regrade = process.env.EVAL_REGRADE;
const results = regrade
  ? await regradeRun(regrade)
  : await runAnswerEval(db, viewer, models, picked, {
  judge,
  concurrency: Number(process.env.EVAL_CONCURRENCY ?? 3),
  onResult: (r) => {
    const facts = r.facts.length ? `${r.facts.filter((f) => f.found).length}/${r.facts.length} facts` : r.declined ? "declined ✓" : "answered ✗";
    console.log(`${r.score >= 0.99 ? "✓" : r.score > 0 ? "~" : "✗"} ${r.id.padEnd(16)} ${facts.padEnd(12)} cites ${r.citations.valid}/${r.citations.cited}  ${r.seconds.toFixed(1)}s  $${r.costUsd.toFixed(4)}${r.error ? `  ERROR ${r.error}` : ""}`);
    for (const f of r.facts.filter((f) => !f.found)) console.log(`    missing: ${f.fact}`);
  },
});

const s = summarize(results);
// Also kept as a file (gitignored), so runs survive a database reset.
mkdirSync("evals/runs", { recursive: true });
writeFileSync(`evals/runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, JSON.stringify({ models: used, summary: s, results }, null, 2));
await db
  .insert(evalRuns)
  .values({ orgId: viewer.orgId, models: used, cases: s.cases, score: s.score, citationRate: s.citationRate, costUsd: s.costUsd, avgSeconds: s.avgSeconds, details: results })
  .catch((e) => console.error(`not saved to the database: ${e instanceof Error ? e.message.split("\n")[0] : e}`));
console.log(`\nscore ${(s.score * 100).toFixed(0)}% · citations ok ${(s.citationRate * 100).toFixed(0)}% · $${(s.costUsd / Math.max(s.cases, 1)).toFixed(4)} per answer · ${s.avgSeconds.toFixed(1)}s avg`);
process.exit(Number(process.env.EVAL_MIN_SCORE ?? 0) > s.score ? 1 : 0);

async function regradeRun(file: string): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const r of JSON.parse(readFileSync(file, "utf8")).results as CaseResult[]) {
    const c = cases.find((x) => x.id === r.id);
    out.push(c ? { ...r, ...(await gradeAnswer(judge, c, r.answer)) } : r);
  }
  return out;
}
