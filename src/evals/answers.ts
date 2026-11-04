import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { agentFor } from "@/agent/answer";
import { modelId, type Models } from "@/ai/models";
import { costOf } from "@/ai/prices";
import type { Db } from "@/db/client";
import type { Viewer } from "@/db/scope";

/**
 * Answer-quality eval: real questions about an org's own data, each with the
 * facts a correct answer must contain. A cheap model grades each answer; the
 * citations are checked against what the tools actually returned.
 */
export interface AnswerCase {
  id: string;
  question: string;
  /** Facts a correct answer states, in plain words. Paraphrase counts. */
  expect: string[];
  /** The data doesn't hold the answer: the agent should say so, not guess. */
  unanswerable?: boolean;
}

export interface CaseResult {
  id: string;
  question: string;
  answer: string;
  facts: { fact: string; found: boolean }[];
  declined: boolean;
  /** 0 to 1 */
  score: number;
  citations: { cited: number; valid: number };
  seconds: number;
  costUsd: number;
  error?: string;
}

export interface EvalSummary {
  cases: number;
  score: number;
  citationRate: number;
  costUsd: number;
  avgSeconds: number;
}

const gradeSchema = z.object({
  facts: z.array(z.object({ fact: z.string(), found: z.boolean() })),
  declined: z.boolean().describe("The answer says it couldn't find the information"),
  invented: z.boolean().describe("The answer claims to answer the question with specific details (names, numbers, dates) it presents as found"),
});

const JUDGE = `You grade answers from a company-memory assistant.
For each EXPECTED FACT, decide whether the ANSWER states it. Paraphrase, a different order or extra detail are fine; a contradiction or a vaguer claim is not found.
Also say whether the answer declines (says it couldn't find the information), and whether it invents: claims to answer the question with specific details presented as found. Offering to help, asking a clarifying question, or mentioning related things it did find is not inventing.
Copy each expected fact exactly in your output, in the same order.`;

/** Grades one answer with the judge model. */
export async function gradeAnswer(judge: LanguageModel, c: AnswerCase, answer: string) {
  const { output } = await generateText({
    model: judge,
    instructions: JUDGE,
    prompt: `QUESTION: ${c.question}\n\nEXPECTED FACTS:\n${c.expect.map((f, i) => `${i + 1}. ${f}`).join("\n") || "(none: the data doesn't contain the answer)"}\n\nANSWER:\n${answer}`,
    output: Output.object({ schema: gradeSchema }),
  });
  // Keep the expected wording and order even if the judge rephrased or dropped one.
  const facts = c.expect.map((fact, i) => ({ fact, found: output.facts[i]?.found ?? false }));
  const score = c.unanswerable
    ? output.declined && !output.invented
      ? 1
      : 0
    : facts.length
      ? facts.filter((f) => f.found).length / facts.length
      : 1;
  return { facts, declined: output.declined, score };
}

/** [S3]-style refs in an answer, and how many point at a source a tool actually returned. */
export function citationCheck(answer: string, refs: Set<string>): { cited: number; valid: number } {
  // Refs inside brackets: [S1], [S1, S3], [S1][S2], [S1–S4].
  const cited = new Set([...answer.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => m[1].match(/\bS\d+\b/g) ?? []));
  return { cited: cited.size, valid: [...cited].filter((r) => refs.has(r)).length };
}

/** Every source ref in tool results ({ ref: "S1", thread, ... } anywhere in the output). */
export function refsIn(outputs: unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    const v = value as Record<string, unknown>;
    if (typeof v.ref === "string" && /^S\d+$/.test(v.ref)) found.add(v.ref);
    Object.values(v).forEach(walk);
  };
  outputs.forEach(walk);
  return found;
}

export function summarize(results: CaseResult[]): EvalSummary {
  const n = results.length || 1;
  const answerable = results.filter((r) => r.facts.length);
  return {
    cases: results.length,
    score: results.reduce((s, r) => s + r.score, 0) / n,
    // An answer's citations are good when it cites something and every ref is real.
    citationRate: answerable.length ? answerable.filter((r) => r.citations.cited > 0 && r.citations.valid === r.citations.cited).length / answerable.length : 1,
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    avgSeconds: results.reduce((s, r) => s + r.seconds, 0) / n,
  };
}

/** Asks every question as `viewer`, grades the answers. Runs a few at a time. */
export async function runAnswerEval(
  db: Db,
  viewer: Viewer & { displayName: string },
  models: Models,
  cases: AnswerCase[],
  opts: { judge: LanguageModel; concurrency?: number; now?: Date; onResult?: (r: CaseResult) => void },
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const queue = [...cases];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const started = Date.now();
      let r: CaseResult;
      try {
        const agent = await agentFor(db, viewer, models, opts.now);
        const out = await generateText({ ...agent, prompt: c.question });
        const graded = await gradeAnswer(opts.judge, c, out.text);
        r = {
          id: c.id,
          question: c.question,
          answer: out.text,
          ...graded,
          citations: citationCheck(out.text, refsIn(out.toolResults.map((t) => t.output))),
          seconds: (Date.now() - started) / 1000,
          costUsd: costOf(modelId(models.answer), out.usage),
        };
      } catch (e) {
        r = { id: c.id, question: c.question, answer: "", facts: c.expect.map((fact) => ({ fact, found: false })), declined: false, score: 0, citations: { cited: 0, valid: 0 }, seconds: (Date.now() - started) / 1000, costUsd: 0, error: e instanceof Error ? e.message : String(e) };
      }
      results.push(r);
      opts.onResult?.(r);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return cases.map((c) => results.find((r) => r.id === c.id)!);
}
