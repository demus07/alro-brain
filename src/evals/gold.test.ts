import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR } from "@/ingest/fixtures";
import { loadGold, score, type Extracted, type Gold } from "./gold";

describe("gold set", () => {
  it("has 28 commitments, each made exactly once", () => {
    const gold = loadGold(path.join(FIXTURE_DIR, "labels"));
    const made = gold.items.filter((i) => i.role === "made").map((i) => i.commitment_id);
    expect(new Set(gold.items.map((i) => i.commitment_id)).size).toBe(28);
    expect(made.sort()).toEqual([...new Set(made)].sort());
    expect(made).toHaveLength(28);
    expect(gold.distractors.length).toBeGreaterThan(80);
  });
});

describe("scoring", () => {
  const gold: Gold = {
    items: [
      { commitment_id: "C1", role: "made", file: "x", quote: "I'll send the deck by Sunday" },
      { commitment_id: "C1", role: "fulfilled", file: "x", quote: "deck is in your inbox" },
      { commitment_id: "C2", role: "made", file: "x", quote: "I'll book the demo" },
      { commitment_id: "C3", role: "made", file: "x", quote: "I'll build the Teams connector" },
      { commitment_id: "C3", role: "cancelled", file: "x", quote: "dropping Teams from phase 1" },
    ],
    distractors: [{ file: "x", quote: "I'll never touch Jira again lol", why: "joke" }],
  };
  const e = (quote: string, sourceText: string, status: string, fulfilledByText: string | null = null): Extracted => ({
    id: quote,
    title: quote,
    quote,
    status,
    sourceText,
    fulfilledByText,
  });

  it("scores recall, precision, outcomes, evidence and distractors", () => {
    const report = score(gold, [
      e("I'll send the deck by Sunday", "ok. I'll send the deck by Sunday!", "done", "the deck is in your inbox"),
      e("send the deck", "reminder: I'll send the deck by Sunday", "open"), // duplicate of C1
      e("I'll build the Teams connector", "I'll build the Teams connector", "open"), // should be cancelled
      e("I'll never touch Jira again", "I'll never touch Jira again lol", "open"),
      e("I'll water the plants", "I'll water the plants", "open"),
    ]);
    expect(report.recall).toBeCloseTo(2 / 3);
    expect(report.precision).toBeCloseTo(3 / 5);
    expect(report.duplicates).toBe(1);
    expect(report.outcomeAccuracy).toBe(0.5);
    expect(report.evidenceAccuracy).toBe(1);
    expect(report.distractorHits.map((d) => d.why)).toEqual(["joke"]);
    expect(report.unmatched.map((u) => u.quote)).toEqual(["I'll water the plants"]);
    expect(report.commitments.find((c) => c.id === "C2")).toMatchObject({ captured: false, expected: "open" });
  });
});
