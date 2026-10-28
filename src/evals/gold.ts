import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface GoldItem {
  commitment_id: string;
  role: "made" | "mentioned" | "fulfilled" | "partial" | "cancelled" | "rescheduled";
  file: string;
  speaker?: string;
  quote: string;
}

export interface GoldDistractor {
  file: string;
  speaker?: string;
  quote: string;
  why: string;
}

export interface Gold {
  items: GoldItem[];
  distractors: GoldDistractor[];
}

export function loadGold(labelDir: string): Gold {
  const gold: Gold = { items: [], distractors: [] };
  for (const f of readdirSync(labelDir).filter((f) => f.endsWith(".json")).sort()) {
    const data = JSON.parse(readFileSync(path.join(labelDir, f), "utf8")) as Gold;
    gold.items.push(...data.items);
    gold.distractors.push(...data.distractors);
  }
  return gold;
}

/** One commitment the pipeline produced, with the text of its source and closing messages. */
export interface Extracted {
  id: string;
  title: string;
  quote: string;
  status: string;
  sourceText: string;
  fulfilledByText: string | null;
}

export type ExpectedOutcome = "done" | "cancelled" | "open";

export interface CommitmentScore {
  id: string;
  captured: boolean;
  expected: ExpectedOutcome;
  actual?: string;
  outcomeCorrect: boolean;
  /** For done ones: did the closing message carry the labelled fulfilment? */
  evidenceCorrect?: boolean;
  extracted: string[];
}

export interface EvalReport {
  extracted: number;
  /** Extractions that belong to a gold commitment, over all extractions. */
  precision: number;
  /** Gold commitments captured at least once, over all gold commitments. */
  recall: number;
  /** Captured commitments whose final state (done / cancelled / still open) matches the story. */
  outcomeAccuracy: number;
  /** Done commitments closed by the labelled fulfilment message. */
  evidenceAccuracy: number;
  duplicates: number;
  distractorHits: { quote: string; why: string; extracted: string }[];
  unmatched: { title: string; quote: string }[];
  commitments: CommitmentScore[];
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Same message, and the two quotes share at least half the words of the shorter one. */
function overlaps(extracted: Extracted, labelQuote: string): boolean {
  if (!extracted.sourceText.includes(labelQuote)) return false;
  const a = words(extracted.quote);
  const b = words(labelQuote);
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.max(1, Math.min(a.size, b.size)) >= 0.5;
}

const OPEN_STATES = new Set(["open", "due_soon", "overdue"]);

/**
 * Scores extracted commitments against the gold set. An extraction belongs to
 * a gold commitment when it comes from a message labelled for that commitment
 * (made, mentioned, rescheduled...) and its quote overlaps the label.
 */
export function score(gold: Gold, extracted: Extracted[]): EvalReport {
  const ids = [...new Set(gold.items.map((i) => i.commitment_id))].sort();
  const byGold = new Map<string, Extracted[]>(ids.map((id) => [id, []]));
  const distractorHits: EvalReport["distractorHits"] = [];
  const unmatched: EvalReport["unmatched"] = [];

  for (const e of extracted) {
    const item = gold.items.find((i) => overlaps(e, i.quote));
    if (item) {
      byGold.get(item.commitment_id)!.push(e);
      continue;
    }
    const distractor = gold.distractors.find((d) => overlaps(e, d.quote));
    if (distractor) distractorHits.push({ quote: distractor.quote, why: distractor.why, extracted: e.quote });
    else unmatched.push({ title: e.title, quote: e.quote });
  }

  const commitments: CommitmentScore[] = ids.map((id) => {
    const items = gold.items.filter((i) => i.commitment_id === id);
    const expected: ExpectedOutcome = items.some((i) => i.role === "cancelled") ? "cancelled" : items.some((i) => i.role === "fulfilled") ? "done" : "open";
    const found = byGold.get(id)!;
    // Judge the outcome on the extraction that was closed, if any, else the first one.
    const main = found.find((e) => !OPEN_STATES.has(e.status)) ?? found[0];
    const actual = main?.status;
    const outcomeCorrect = !!main && (expected === "open" ? OPEN_STATES.has(actual!) : actual === expected);
    const fulfilments = items.filter((i) => i.role === "fulfilled").map((i) => i.quote);
    return {
      id,
      captured: found.length > 0,
      expected,
      actual,
      outcomeCorrect,
      evidenceCorrect: expected === "done" && actual === "done" ? fulfilments.some((q) => main!.fulfilledByText?.includes(q)) : undefined,
      extracted: found.map((e) => e.quote),
    };
  });

  const attributable = [...byGold.values()].reduce((n, list) => n + list.length, 0);
  const captured = commitments.filter((c) => c.captured);
  const doneRight = commitments.filter((c) => c.evidenceCorrect !== undefined);
  return {
    extracted: extracted.length,
    precision: extracted.length ? attributable / extracted.length : 0,
    recall: captured.length / ids.length,
    outcomeAccuracy: captured.length ? captured.filter((c) => c.outcomeCorrect).length / captured.length : 0,
    evidenceAccuracy: doneRight.length ? doneRight.filter((c) => c.evidenceCorrect).length / doneRight.length : 0,
    duplicates: attributable - captured.length,
    distractorHits,
    unmatched,
    commitments,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(r: EvalReport): string {
  const lines = [
    `Extracted commitments: ${r.extracted} (${r.duplicates} duplicates)`,
    `Precision:          ${pct(r.precision)}`,
    `Recall:             ${pct(r.recall)}`,
    `Outcome accuracy:   ${pct(r.outcomeAccuracy)}  (done / cancelled / still open, as of the story's "today")`,
    `Evidence accuracy:  ${pct(r.evidenceAccuracy)}  (closed by the labelled message)`,
    `Distractors caught: ${r.distractorHits.length}`,
    "",
    "Per commitment:",
    ...r.commitments.map(
      (c) =>
        `  ${c.id}  ${c.captured ? "captured" : "MISSED  "}  expected ${c.expected.padEnd(9)} got ${(c.actual ?? "-").padEnd(9)} ${c.captured && !c.outcomeCorrect ? "WRONG OUTCOME" : ""}${c.evidenceCorrect === false ? " WRONG EVIDENCE" : ""}`,
    ),
  ];
  if (r.distractorHits.length) lines.push("", "Distractors extracted:", ...r.distractorHits.map((d) => `  [${d.why}] ${d.quote}`));
  if (r.unmatched.length) lines.push("", "Not in the gold set (review by hand):", ...r.unmatched.map((u) => `  ${u.title} — "${u.quote}"`));
  return lines.join("\n");
}
