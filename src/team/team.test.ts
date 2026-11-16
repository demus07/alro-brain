import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promptText, testModels } from "@/ai/test-models";
import type { Db } from "@/db/client";
import { auditLog, llmRuns, orgs, people, routineRuns, routines, teamAgents, teamRuns } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import { runDueRoutines } from "@/routines/run";
import { addDepartment, addSpecialist, canAdd, canChange, removeSpecialist, TeamError, toggleSpecialist, updateSpecialist, type Member } from "./manage";
import { conflictingFigures, digestOf, figuresIn, uncitedFigures, type Report } from "./review";
import { recentRuns } from "./runs";
import { askTeamTool, LIMITS, runDepartment } from "./team";

let db: Db;
let close: () => Promise<void>;
let orgId: string;
let sumedh: string;
let jash: string;
let priya: string;
const viewer = () => ({ orgId, personId: sumedh });

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
/** Tokens one mock model call costs. */
const CALL = 15;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
let callId = 0;
const toolCalls = (...c: { name: string; input: unknown }[]) => ({
  content: c.map((x) => ({ type: "tool-call" as const, toolCallId: `c${callId++}`, toolName: x.name, input: JSON.stringify(x.input) })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
/** The lead hands out tasks. */
const calls = (...c: { specialist: string; task: string }[]) => toolCalls(...c.map((input) => ({ name: "delegate", input })));
type Reply = ReturnType<typeof text> | ReturnType<typeof toolCalls>;
const stub = () => tool({ description: "stub", inputSchema: z.object({}), execute: async () => ({}) });

/**
 * A model that plays the whole team: `lead(n, seen)` answers the lead's n-th call (seen = everything
 * in its prompt so far, tool results included), `specialist(name, prompt)` answers that specialist.
 */
function teamModel(script: { lead: (n: number, seen: string) => Reply | Promise<Reply>; specialist: (name: string, prompt: string, call: { abortSignal?: AbortSignal; mayUseTools: boolean }) => Reply | Promise<Reply> }) {
  const seen = { lead: [] as string[], specialists: [] as { name: string; prompt: string; tools: string[]; mayUseTools: boolean }[] };
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt, tools, toolChoice, abortSignal }) => {
      const p = promptText(prompt);
      const name = /You are (.+?), a specialist/.exec(p)?.[1];
      if (name) {
        const mayUseTools = toolChoice?.type !== "none";
        seen.specialists.push({ name, prompt: p, tools: (tools ?? []).map((t) => t.name), mayUseTools });
        return script.specialist(name, p, { abortSignal, mayUseTools });
      }
      seen.lead.push(JSON.stringify(prompt));
      return script.lead(seen.lead.length - 1, seen.lead.at(-1)!);
    },
  });
  return { model, seen };
}

const FINANCE = [
  { name: "Collections", job: "Chase overdue payments", tools: ["stripe_", "gmail_send_email"] },
  { name: "Cash report", job: "Cash position", tools: ["stripe_balance"] },
  { name: "Reconciliation", job: "Match payments", tools: ["xero_"] },
];
const run = (model: MockLanguageModelV4, extra: Partial<Parameters<typeof runDepartment>[2]> = {}) =>
  runDepartment(db, viewer(), {
    department: "finance",
    specialists: FINANCE,
    task: "Monday cash report",
    tools: { stripe_balance: stub(), stripe_invoices: stub(), xero_invoices: stub(), gmail_send_email: stub(), searchMemory: stub(), askTeam: stub() },
    model,
    instructions: "You are ALRO.",
    ...extra,
  });
const saved = async (id: string) => (await db.select().from(teamRuns).where(eq(teamRuns.id, id)))[0];

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: orgId }] = await db.insert(orgs).values({ name: "Metals Co", timezone: "Asia/Kolkata" }).returning();
  [{ id: sumedh }, { id: jash }, { id: priya }] = await db
    .insert(people)
    .values([
      { orgId, displayName: "Sumedh Kudav", isMember: true, primaryEmail: "sumedh@example.com", role: "owner" },
      { orgId, displayName: "Jash Doshi", isMember: true, primaryEmail: "jash@example.com", role: "member" },
      { orgId, displayName: "Priya Shah", isMember: true, primaryEmail: "priya@example.com", role: "member" },
    ])
    .returning();
}, 60_000);

afterAll(async () => {
  await close();
});

describe("budgets", () => {
  /** The lead asks for Cash report, then for Collections: 15 + 15 + 15 = 45 tokens before Collections would start. */
  const twoRounds = () =>
    teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Cash report", task: "Cash now" }) : n === 1 ? calls({ specialist: "Collections", task: "Overdue invoices" }) : text("Cash: 18.4L (Stripe).")),
      specialist: () => text("Cash 18.4L in Stripe."),
    });

  it("stops handing out work once the tokens are spent, and says the run stopped early", async () => {
    const { model, seen } = twoRounds();
    const result = await run(model, { tokenBudget: 40 });
    expect(seen.specialists.map((s) => s.name)).toEqual(["Cash report"]);
    expect(seen.lead.at(-1)).toContain("The run's token budget is spent. Don't delegate this again: answer with what you have");
    expect(result.status).toBe("over_budget");
    expect(result.answer).toContain("Stopped early: the budget of 40 tokens was spent");
    expect(result.reports.map((r) => [r.specialist, r.status])).toEqual([["Cash report", "ok"]]);
    expect(await saved(result.id)).toMatchObject({ status: "over_budget", error: "Stopped early: the budget of 40 tokens was spent" });

    // The same work fits the default budget.
    const roomy = twoRounds();
    expect((await run(roomy.model)).status).toBe("ok");
    expect(roomy.seen.specialists.map((s) => s.name)).toEqual(["Cash report", "Collections"]);
  });

  it("takes its budget from ALRO_TEAM_TOKEN_BUDGET when the caller sets none", async () => {
    process.env.ALRO_TEAM_TOKEN_BUDGET = "40";
    try {
      const { model, seen } = twoRounds();
      expect((await run(model)).status).toBe("over_budget");
      expect(seen.specialists.map((s) => s.name)).toEqual(["Cash report"]);
    } finally {
      delete process.env.ALRO_TEAM_TOKEN_BUDGET;
    }
  });

  it("gives a specialist caught mid-work one last step to report what it has", async () => {
    const digging = () =>
      teamModel({
        lead: (n) => (n === 0 ? calls({ specialist: "Cash report", task: "Cash now" }, { specialist: "Collections", task: "Overdue" }) : text("Cash: 18.4L (Stripe).")),
        specialist: (_name, _p, { mayUseTools }) => (mayUseTools ? toolCalls({ name: "stripe_balance", input: {} }) : text("So far: 18.4L in Stripe.")),
      });
    // Out of tokens: both are told to wrap up well before their step limits, and their reports still count.
    const tight = digging();
    const cut = await run(tight.model, { tokenBudget: 100 });
    expect(cut.status).toBe("over_budget");
    expect(tight.seen.specialists.length).toBeLessThan(10);
    expect(cut.reports.map((r) => [r.status, r.report])).toEqual([
      ["ok", "So far: 18.4L in Stripe."],
      ["ok", "So far: 18.4L in Stripe."],
    ]);
    // Out of steps (8 by default, 12 for Collections in the preset): the last one is for the report.
    const patient = digging();
    const full = await run(patient.model);
    expect(full.status).toBe("ok");
    const steps = (name: string) => patient.seen.specialists.filter((s) => s.name === name);
    expect(steps("Cash report").map((s) => s.mayUseTools)).toEqual([true, true, true, true, true, true, true, false]);
    expect(steps("Collections")).toHaveLength(12);
    expect(full.reports.every((r) => r.status === "ok")).toBe(true);
  });

  it.each([true, false])("stops specialists still working at the time limit and answers with the rest (stops when told: %s)", async (polite) => {
    const { model } = teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Cash report", task: "Cash now" }, { specialist: "Collections", task: "Overdue invoices" }) : text("Cash: 18.4L (Stripe).")),
      // Collections hangs: on the first run it gives up when told to stop, on the second it ignores that too.
      specialist: (name, _p, { abortSignal }) => (name === "Cash report" ? text("Cash 18.4L in Stripe.") : new Promise<Reply>((_, reject) => polite && abortSignal!.addEventListener("abort", () => reject(abortSignal!.reason)))),
    });
    const result = await run(model, { timeLimitMs: 60 });
    expect(result.status).toBe("over_budget");
    expect(result.reports.find((r) => r.specialist === "Collections")).toMatchObject({ status: "failed", report: "Ran out of time" });
    expect(result.reports.find((r) => r.specialist === "Cash report")).toMatchObject({ status: "ok" });
    expect(result.answer).toContain("Collections didn't finish (Ran out of time)");
    expect(result.answer).toContain("the time limit");
  });

  it("caps how often one specialist, and the run as a whole, can be asked", async () => {
    const { model, seen } = teamModel({
      lead: (n, all) => (all.includes("has already been asked") ? text("Cash: 18.4L (Stripe).") : calls({ specialist: "Cash report", task: `Cash, attempt ${n}` })),
      specialist: () => text("Cash 18.4L in Stripe."),
    });
    const result = await run(model);
    expect(seen.specialists).toHaveLength(LIMITS.perSpecialist);
    expect(result.status).toBe("ok");

    const many = Array.from({ length: LIMITS.delegations + 2 }, (_, i) => ({ name: `Clerk ${i}`, job: "Count", tools: [] }));
    const wide = teamModel({ lead: (n) => (n === 0 ? calls(...many.map((s) => ({ specialist: s.name, task: "Count" }))) : text("Counted.")), specialist: () => text("Counted 1 (tracker).") });
    await run(wide.model, { specialists: many });
    expect(wide.seen.specialists).toHaveLength(LIMITS.delegations);
    expect(wide.seen.lead.at(-1)).toContain(`handed out all ${LIMITS.delegations} of its tasks`);
  });

  it("never lets a specialist hand work on", async () => {
    const { model, seen } = teamModel({ lead: (n) => (n === 0 ? calls({ specialist: "Collections", task: "Overdue" }) : text("Done.")), specialist: () => text("Nothing overdue in Stripe.") });
    await run(model);
    expect(seen.specialists[0].tools.sort()).toEqual(["gmail_send_email", "stripe_balance", "stripe_invoices"]);
  });
});

describe("when part of the work fails", () => {
  it("keeps the other specialists going, tells the lead what is missing and says so in the answer", async () => {
    const { model, seen } = teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Collections", task: "Overdue invoices" }, { specialist: "Cash report", task: "Cash now" }) : text("Cash: 18.4L (Stripe).")),
      specialist: (name) => {
        if (name === "Collections") throw new Error("Stripe is down");
        return text("Cash 18.4L in Stripe.");
      },
    });
    const result = await run(model);
    expect(result.status).toBe("ok");
    expect(result.reports.map((r) => [r.specialist, r.status]).sort()).toEqual([
      ["Cash report", "ok"],
      ["Collections", "failed"],
    ]);
    expect(result.missing).toEqual([{ specialist: "Collections", reason: "Stripe is down" }]);
    // The lead saw the failure and was told not to paper over it...
    expect(seen.lead[1]).toContain('"status":"failed"');
    expect(seen.lead[1]).toContain("Stripe is down");
    expect(seen.lead[1]).toContain("This part is missing. Say so in your answer");
    // ...and since this lead still said nothing, the answer names the gap anyway.
    expect(result.answer).toBe("Cash: 18.4L (Stripe).\n\nNot covered: Collections didn't finish (Stripe is down).");
    expect((await saved(result.id)).reports.find((r) => r.specialist === "Collections")).toMatchObject({ status: "failed", report: "Stripe is down" });
  });

  it("doesn't call a part missing once a follow-up delivered it", async () => {
    let tries = 0;
    const { model } = teamModel({
      lead: (n) => (n < 2 ? calls({ specialist: "Collections", task: `Overdue invoices, try ${n}` }) : text("Acme owes 4.2L (Stripe).")),
      specialist: () => {
        if (tries++ === 0) throw new Error("Stripe timed out");
        return text("Acme owes 4.2L in Stripe.");
      },
    });
    const result = await run(model);
    expect(result.missing).toEqual([]);
    expect(result.answer).toBe("Acme owes 4.2L (Stripe).");
  });

  it("still returns the specialists' reports when the lead fails afterwards", async () => {
    const { model } = teamModel({
      lead: (n) => {
        if (n > 0) throw new Error("Model overloaded");
        return calls({ specialist: "Cash report", task: "Cash now" });
      },
      specialist: () => text("Cash 18.4L in Stripe."),
    });
    const result = await run(model);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Model overloaded");
    expect(result.reports).toMatchObject([{ specialist: "Cash report", status: "ok", report: "Cash 18.4L in Stripe." }]);
    expect(result.answer).toContain("couldn't combine the team's work (Model overloaded)");
    expect(result.answer).toContain("Cash 18.4L in Stripe.");
    expect(await saved(result.id)).toMatchObject({ status: "error", error: "Model overloaded" });
  });
});

describe("shared findings", () => {
  it("shows a later step what earlier steps found, cut to size, and keeps the same step independent", async () => {
    const long = `Acme paid 1,00,000 against INV-101 per Xero. ${"Then a very long list of matched payments. ".repeat(200)}`;
    const { model, seen } = teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Reconciliation", task: "Match this week's payments" }, { specialist: "Cash report", task: "Cash now" }) : n === 1 ? calls({ specialist: "Collections", task: "Chase what is still open" }) : text("Done.")),
      specialist: (name) => text(name === "Reconciliation" ? long : name === "Cash report" ? "Cash 18.4L in Stripe." : "Chased Beta only: Acme paid."),
    });
    await run(model);
    const prompt = (name: string) => seen.specialists.find((s) => s.name === name)!.prompt;
    expect(prompt("Reconciliation")).not.toContain("Already found by others");
    expect(prompt("Cash report")).not.toContain("Already found by others");
    expect(prompt("Collections")).toContain("Already found by others");
    expect(prompt("Collections")).toContain("Acme paid 1,00,000 against INV-101");
    expect(prompt("Collections")).toContain("Cash 18.4L in Stripe.");
    expect(prompt("Collections").split("Already found by others")[1].length).toBeLessThan(2600);
  });

  it("leaves failed work out of the digest", () => {
    const reports: Report[] = [
      { specialist: "A", task: "t", report: "Found 3 things", status: "ok" },
      { specialist: "B", task: "t", report: "Stripe is down", status: "failed" },
    ];
    expect(digestOf(reports)).toBe("- A (asked: t): Found 3 things");
    expect(digestOf(reports.slice(1))).toBe("");
  });
});

describe("checking reports against each other", () => {
  it("flags figures that disagree and figures without a source to the lead", async () => {
    const { model, seen } = teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Reconciliation", task: "What does Acme owe" }) : n === 1 ? calls({ specialist: "Collections", task: "Overdue invoices" }) : text("Acme owes between 3.9L (Xero) and 4.2L [S1]: the two don't agree.")),
      specialist: (name) => text(name === "Reconciliation" ? "Acme owes 3.9L per Xero." : "Acme owes 4.2L, 38 days late [S1].\n\nBeta owes 1,10,000."),
    });
    const result = await run(model);
    expect(seen.lead[1]).not.toContain('"review":');
    expect(seen.lead[2]).toContain("Possible disagreement: Collections and Reconciliation give different figures for acme: 4.2L vs 3.9L.");
    expect(seen.lead[2]).toContain('No source ref or system named for: \\"Beta owes 1,10,000.\\"');
    // The lead is told what to do about it, and no extra model call was spent on checking: 3 lead calls + 2 specialists.
    expect(seen.lead[0]).toContain("Never quietly pick one figure");
    expect(result.inputTokens + result.outputTokens).toBe(5 * CALL);
  });

  it("reads amounts the way people write them, and ignores what isn't an amount", () => {
    expect(figuresIn("Acme owes 4.2L, 38 days late on INV-101 since 2026 [S1]. Chaser waiting (K7QM).")).toEqual([{ subject: "acme", kind: "amount", value: 420000, text: "4.2L" }]);
    expect(figuresIn("Tata Steel: ₹1.2 cr outstanding, 12% of receivables; due 2026-11-03 at 10:40")).toEqual([
      { subject: "tata steel", kind: "amount", value: 12000000, text: "₹1.2 cr" },
      { subject: "tata steel", kind: "percent", value: 12, text: "12%" },
    ]);
  });

  it("doesn't call rounding, or a figure both reports share, a disagreement", () => {
    const report = (specialist: string, body: string): Report => ({ specialist, task: "t", report: body, status: "ok" });
    expect(conflictingFigures(report("A", "Acme owes 4.2L"), [report("B", "Acme outstanding 4,19,870")])).toEqual([]);
    expect(conflictingFigures(report("A", "Acme: invoiced 4.2L, paid 1L"), [report("B", "Acme invoiced 4.2L")])).toEqual([]);
    expect(conflictingFigures(report("A", "Acme owes 4.2L"), [report("A", "Acme owes 3L")])).toEqual([]);
    expect(conflictingFigures(report("A", "Acme owes 4.2L"), [report("B", "Acme owes 3L"), { ...report("C", "Acme owes 9L"), status: "failed" }])).toHaveLength(1);
  });

  it("accepts a ref or a named system anywhere in the paragraph as the source", () => {
    expect(uncitedFigures("From Stripe:\n- Acme 4.2L\n- Beta 1.1L", ["stripe", "xero"])).toEqual([]);
    expect(uncitedFigures("Acme 4.2L [S2]\n\nBeta 1.1L\nGamma 2L", ["stripe"])).toEqual(["Beta 1.1L"]);
    expect(uncitedFigures("Three customers are late.", ["stripe"])).toEqual([]);
  });
});

describe("the record of a run", () => {
  it("exists from the start, fills in as specialists report, and ends with the answer and what it cost", async () => {
    const [routine] = await db.insert(routines).values({ orgId, ownerPersonId: sumedh, title: "Cash", instruction: "Cash report", schedule: { kind: "weekdays", time: "07:30" }, team: "finance" }).returning();
    const during: (typeof teamRuns.$inferSelect)[] = [];
    const snapshot = async () => during.push(...(await db.select().from(teamRuns).where(eq(teamRuns.routineId, routine.id))));
    const { model } = teamModel({
      lead: async (n) => {
        if (n === 0) return calls({ specialist: "Cash report", task: "Cash now" });
        await snapshot();
        return text("Cash: 18.4L (Stripe). Waiting for your OK: K7QM.");
      },
      specialist: async () => {
        await snapshot();
        return text("Cash 18.4L in Stripe.");
      },
    });
    const result = await run(model, { routineId: routine.id });
    expect(during).toMatchObject([
      { status: "running", department: "finance", task: "Monday cash report", personId: sumedh, answer: null, finishedAt: null, reports: [] },
      { status: "running", answer: null, reports: [{ specialist: "Cash report", status: "ok" }], inputTokens: 20, outputTokens: 10 },
    ]);
    const row = await saved(result.id);
    expect(row).toMatchObject({
      status: "ok",
      routineId: routine.id,
      answer: "Cash: 18.4L (Stripe). Waiting for your OK: K7QM.",
      error: null,
      // Two lead calls and one specialist call, each counted once.
      inputTokens: 30,
      outputTokens: 15,
      reports: [{ specialist: "Cash report", task: "Cash now", report: "Cash 18.4L in Stripe.", status: "ok", tokens: CALL }],
    });
    expect(row.finishedAt).not.toBeNull();
    expect(result).toMatchObject({ inputTokens: 30, outputTokens: 15 });
  });

  it("is marked failed, with the reason, when the lead can't even start", async () => {
    const { model } = teamModel({
      lead: () => {
        throw new Error("No credit left");
      },
      specialist: () => text("unused"),
    });
    const result = await run(model);
    expect(result).toMatchObject({ status: "error", error: "No credit left", reports: [], answer: "The Finance team couldn't do this: No credit left" });
    const row = await saved(result.id);
    expect(row).toMatchObject({ status: "error", error: "No credit left" });
    expect(row.finishedAt).not.toBeNull();
  });

  it("is only readable by the person whose access it ran with", async () => {
    const mine = await recentRuns(db, viewer(), 50);
    expect(mine.length).toBeGreaterThan(5);
    expect(mine.every((r) => r.personId === sumedh && !r.stuck)).toBe(true);
    expect(await recentRuns(db, { orgId, personId: jash })).toEqual([]);

    // A run whose process died long ago shows as stuck rather than working forever.
    await db.insert(teamRuns).values({ orgId, personId: jash, department: "finance", task: "Old", startedAt: new Date(Date.now() - 3_600_000) });
    expect(await recentRuns(db, { orgId, personId: jash })).toMatchObject([{ task: "Old", status: "running", stuck: true }]);
  });
});

describe("where the team is called from", () => {
  it("tells the main agent what is missing and reports the run's cost once", async () => {
    const { model } = teamModel({
      lead: (n) => (n === 0 ? calls({ specialist: "Collections", task: "Overdue invoices" }, { specialist: "Cash report", task: "Cash now" }) : text("Cash: 18.4L (Stripe). Collections couldn't reach Stripe.")),
      specialist: (name) => {
        if (name === "Collections") throw new Error("Stripe is down");
        return text("Cash 18.4L in Stripe.");
      },
    });
    const costs: unknown[] = [];
    const askTeam = askTeamTool(new Map([["finance", FINANCE]]), { db, viewer: viewer(), tools: () => ({ stripe_balance: stub() }), model, instructions: "You are ALRO.", onUsage: (u) => costs.push({ in: u.inputTokens, out: u.outputTokens }) })!;
    const out = await (askTeam as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute({ department: "finance", task: "Cash report" }, { toolCallId: "t", messages: [] });
    expect(out).toMatchObject({ department: "Finance", status: "ok", answer: "Cash: 18.4L (Stripe). Collections couldn't reach Stripe.", missing: [{ specialist: "Collections", reason: "Stripe is down" }] });
    // Two lead calls and the one specialist call that came back.
    expect(costs).toEqual([{ in: 30, out: 15 }]);
  });

  it("records a scheduled task's run under that task, and fails the task when the team has nothing to show", async () => {
    const [co] = await db.insert(orgs).values({ name: "Scheduled Co", timezone: "Asia/Kolkata" }).returning();
    const [owner] = await db.insert(people).values({ orgId: co.id, displayName: "Owner", isMember: true, role: "owner" }).returning();
    await db.insert(teamAgents).values({ orgId: co.id, department: "operations", name: "What slipped", job: "Find what slipped", tools: ["listCommitments"] });
    const now = new Date("2026-11-05T04:00:00Z");
    const schedule = (title: string) => db.insert(routines).values({ orgId: co.id, ownerPersonId: owner.id, title, instruction: "What slipped yesterday", schedule: { kind: "weekdays", time: "07:30" }, nextRunAt: new Date(now.getTime() - 1000), team: "operations" }).returning();

    const [first] = await schedule("Slipped");
    const working = teamModel({ lead: (n) => (n === 0 ? calls({ specialist: "What slipped", task: "What went overdue" }) : text("One thing slipped: the mill certificate (Jash).")), specialist: () => text("The mill certificate slipped (Jash).") });
    expect(await runDueRoutines(db, co.id, testModels({ answer: working.model }), now)).toEqual({ ran: 1, failed: 0 });
    const [row] = await db.select().from(teamRuns).where(eq(teamRuns.routineId, first.id));
    expect(row).toMatchObject({ status: "ok", personId: owner.id, department: "operations", inputTokens: 30, outputTokens: 15 });
    expect(await db.select({ stage: llmRuns.stage, inputTokens: llmRuns.inputTokens, outputTokens: llmRuns.outputTokens }).from(llmRuns).where(eq(llmRuns.orgId, co.id))).toEqual([{ stage: "team", inputTokens: 30, outputTokens: 15 }]);

    const [second] = await schedule("Slipped again");
    const broken = teamModel({
      lead: () => {
        throw new Error("No credit left");
      },
      specialist: () => text("unused"),
    });
    expect(await runDueRoutines(db, co.id, testModels({ answer: broken.model }), now)).toEqual({ ran: 0, failed: 1 });
    expect((await db.select().from(routineRuns).where(eq(routineRuns.routineId, second.id)))[0]).toMatchObject({ status: "error", error: "No credit left" });
    expect((await db.select().from(teamRuns).where(eq(teamRuns.routineId, second.id)))[0]).toMatchObject({ status: "error", error: "No credit left" });
  });
});

describe("who may change the team", () => {
  const as = (personId: string, role: Member["role"]): Member => ({ orgId, personId, role });
  const input = { name: "Payment matcher", job: "Match payments to invoices", tools: ["xero_"] };

  it("lets only admins add once the company has more than one member", async () => {
    expect(await canAdd(db, as(jash, "member"))).toBe(false);
    await expect(addDepartment(db, as(jash, "member"), "finance")).rejects.toThrow(TeamError);
    await expect(addSpecialist(db, as(jash, "member"), { department: "finance", ...input })).rejects.toThrow("Only an admin");
    expect(await db.select().from(teamAgents).where(eq(teamAgents.orgId, orgId))).toEqual([]);

    await addDepartment(db, as(sumedh, "owner"), "finance");
    await addSpecialist(db, as(priya, "admin"), { department: " Finance ", ...input });
    const team = await db.select().from(teamAgents).where(eq(teamAgents.orgId, orgId));
    expect(team.map((s) => s.name).sort()).toEqual(["Cash report", "Collections", "Payment matcher", "Reconciliation"]);
    expect(team.find((s) => s.name === "Payment matcher")).toMatchObject({ department: "finance", createdBy: priya });
    await expect(addSpecialist(db, as(sumedh, "owner"), { department: "finance", ...input, name: "payment matcher" })).rejects.toThrow("already has a specialist");
    await expect(addSpecialist(db, as(sumedh, "owner"), { department: "finance", ...input, name: "Other", job: " " })).rejects.toThrow(TeamError);
  });

  it("lets a solo founder add without being an admin", async () => {
    const [solo] = await db.insert(orgs).values({ name: "Solo Co", timezone: "UTC" }).returning();
    const [founder] = await db.insert(people).values({ orgId: solo.id, displayName: "Only One", isMember: true, role: "member" }).returning();
    // Contacts and people who left don't count as members.
    await db.insert(people).values([
      { orgId: solo.id, displayName: "A client", isMember: false },
      { orgId: solo.id, displayName: "Left", isMember: true, deactivatedAt: new Date() },
    ]);
    const me: Member = { orgId: solo.id, personId: founder.id, role: "member" };
    expect(await canAdd(db, me)).toBe(true);
    await addDepartment(db, me, "tech");
    expect(await db.select().from(teamAgents).where(eq(teamAgents.orgId, solo.id))).toHaveLength(1);
  });

  it("lets a specialist be changed by whoever added it or an admin, and by nobody else", async () => {
    const [mine] = await db.insert(teamAgents).values({ orgId, department: "sales", name: "Quotes", job: "Draft quotes", createdBy: jash }).returning();
    expect(canChange(as(jash, "member"), mine)).toBe(true);
    expect(canChange(as(priya, "member"), mine)).toBe(false);
    expect(canChange(as(priya, "admin"), mine)).toBe(true);
    expect(canChange(as(jash, "member"), { createdBy: null })).toBe(false);

    for (const attempt of [() => updateSpecialist(db, as(priya, "member"), mine.id, input), () => toggleSpecialist(db, as(priya, "member"), mine.id), () => removeSpecialist(db, as(priya, "member"), mine.id)]) {
      await expect(attempt()).rejects.toThrow("Only an admin or whoever added this specialist");
    }
    // Someone from another company can't reach it at all.
    const [other] = await db.insert(orgs).values({ name: "Other Co", timezone: "UTC" }).returning();
    const [outsider] = await db.insert(people).values({ orgId: other.id, displayName: "Outsider", isMember: true, role: "owner" }).returning();
    await expect(removeSpecialist(db, { orgId: other.id, personId: outsider.id, role: "owner" }, mine.id)).rejects.toThrow("no longer there");
    await expect(removeSpecialist(db, as(sumedh, "owner"), "not-an-id")).rejects.toThrow(TeamError);
    expect((await db.select().from(teamAgents).where(eq(teamAgents.id, mine.id)))[0]).toMatchObject({ name: "Quotes", job: "Draft quotes", enabled: true });

    await updateSpecialist(db, as(jash, "member"), mine.id, { name: "Quotes", job: "Draft quotes at last price", tools: ["sheets_"] });
    await toggleSpecialist(db, as(sumedh, "owner"), mine.id);
    expect((await db.select().from(teamAgents).where(eq(teamAgents.id, mine.id)))[0]).toMatchObject({ job: "Draft quotes at last price", tools: ["sheets_"], enabled: false });
    await removeSpecialist(db, as(jash, "member"), mine.id);
    expect(await db.select().from(teamAgents).where(eq(teamAgents.id, mine.id))).toEqual([]);
  });

  it("records every change, without the job text", async () => {
    const log = await db.select().from(auditLog).where(eq(auditLog.orgId, orgId)).orderBy(auditLog.createdAt);
    expect(log.map((l) => [l.action, l.target, l.personId])).toEqual([
      ["team.add", "finance", sumedh],
      ["team.add", "finance/Payment matcher", priya],
      ["team.update", "sales/Quotes", jash],
      ["team.update", "sales/Quotes", sumedh],
      ["team.remove", "sales/Quotes", jash],
    ]);
    expect(log[2].detail).toEqual({ change: "edit", jobChanged: true, tools: ["sheets_"] });
    expect(log[3].detail).toEqual({ change: "switch_off" });
    expect(JSON.stringify(log)).not.toContain("Draft quotes");
  });
});
