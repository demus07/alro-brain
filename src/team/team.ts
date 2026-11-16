import { generateText, isStepCount, tool, type LanguageModel, type LanguageModelUsage, type ToolSet } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Source } from "@/agent/tools";
import type { Db } from "@/db/client";
import { teamAgents } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { departmentLabel, departmentOf, DEPARTMENTS } from "./presets";
import { digestOf, reviewReport, type Report } from "./review";
import { saveRun, startRun, type RunStatus } from "./runs";

type Specialist = Pick<typeof teamAgents.$inferSelect, "name" | "job" | "tools">;

const SPECIALIST_STEPS = 8;
const LEAD_STEPS = 6;

/** What one run may use, unless the caller says otherwise. */
export const LIMITS = {
  /** Input + output tokens across the lead and every specialist. ALRO_TEAM_TOKEN_BUDGET overrides it. */
  tokens: 150_000,
  /** Wall-clock time after which specialists still working are stopped. */
  timeMs: 4 * 60_000,
  /** How long the lead then has to write the answer from what came back. */
  graceMs: 45_000,
  /** Tasks the lead may hand out in one run, follow-ups included. */
  delegations: 8,
  /** Times one specialist may be asked in one run: its task and one follow-up. */
  perSpecialist: 2,
};

/**
 * Tools a specialist never gets: it works on one task and reports back. Leaving out askTeam
 * (and `delegate`, which only the lead's own call has) means specialists can't hand work on:
 * a run is one lead and its specialists, never deeper.
 */
const NEVER = new Set(["askTeam", "scheduleTask", "cancelScheduledTask", "listScheduledTasks", "rememberAboutMe"]);

/** A specialist that lists no tools reads company memory and nothing else. */
const MEMORY_ONLY = ["searchMemory", "readThread", "lookupEntity", "dailySummaries", "listCommitments", "commitmentHistory", "findProcedure", "readTracker", "listInsights"];

/** The tools one specialist may use: its listed names and prefixes ("stripe_"), or memory alone when it lists none. */
export function toolsFor(all: ToolSet, allowed: string[]): ToolSet {
  const list = allowed.length ? allowed : MEMORY_ONLY;
  return Object.fromEntries(Object.entries(all).filter(([name]) => !NEVER.has(name) && list.some((a) => (a.endsWith("_") ? name.startsWith(a) : name === a))));
}

/** Every cited source ({ ref: "S3", thread, ... }) in a specialist's tool results, so the answer can link them. */
function collectSources(value: unknown, found: Map<string, Source>) {
  if (Array.isArray(value)) for (const v of value) collectSources(v, found);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.ref === "string" && /^S\d+$/.test(o.ref) && typeof o.thread === "string") found.set(o.ref, o as unknown as Source);
    else for (const v of Object.values(o)) collectSources(v, found);
  }
}

/** The org's specialists, grouped by department. */
export async function loadTeam(db: Db, orgId: string): Promise<Map<string, Specialist[]>> {
  const rows = await db
    .select({ department: teamAgents.department, name: teamAgents.name, job: teamAgents.job, tools: teamAgents.tools })
    .from(teamAgents)
    .where(and(eq(teamAgents.orgId, orgId), eq(teamAgents.enabled, true)))
    .orderBy(asc(teamAgents.createdAt));
  const team = new Map<string, Specialist[]>();
  for (const r of rows) team.set(r.department, [...(team.get(r.department) ?? []), r]);
  return team;
}

export interface TeamRun {
  /** Its row in team_runs. */
  id: string;
  /** ok: the lead answered. over_budget: tokens or time ran out and it answered with what it had. error: the lead itself failed. */
  status: Exclude<RunStatus, "running">;
  answer: string;
  reports: Report[];
  sources: Source[];
  inputTokens: number;
  outputTokens: number;
  /** Parts nobody delivered: a specialist that failed and wasn't made good by a follow-up. */
  missing: { specialist: string; reason: string }[];
  /** Why it stopped early or failed. */
  error?: string;
}

/** The first line of what went wrong, short enough to show. */
const reasonOf = (e: unknown) => ((e instanceof Error ? e.message : String(e)).split("\n")[0] || "Unknown error").slice(0, 200);

const envBudget = () => {
  const n = Number(process.env.ALRO_TEAM_TOKEN_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Where a specialist's figures can come from, by name: the apps behind its tools ("stripe_balance" → stripe), and trackers. */
const systemsOf = (tools: ToolSet) => [...new Set(["tracker", ...Object.keys(tools).filter((name) => name.includes("_")).map((name) => name.split("_")[0])])];

/**
 * One department works on a task as `viewer`: its lead plans and hands focused pieces to
 * specialists with `delegate` (several calls in one step run at the same time), checks their
 * reports against each other, then combines them. Each specialist sees only its own job and
 * tools, plus a digest of what earlier steps of the same run found.
 *
 * The run is bounded (tokens, time, number of delegations) and recorded in team_runs from
 * its first moment. A specialist that fails is reported as missing instead of sinking the
 * run, and if the lead itself fails the specialists' reports are still returned.
 */
export async function runDepartment(
  db: Db,
  viewer: Viewer,
  opts: {
    department: string;
    specialists: Specialist[];
    task: string;
    tools: ToolSet;
    model: LanguageModel;
    /** The asker's standing instructions (who they are, how to cite). */
    instructions: string;
    abortSignal?: AbortSignal;
    /** Input + output tokens for the whole run. */
    tokenBudget?: number;
    timeLimitMs?: number;
    /** The scheduled task this run is for. */
    routineId?: string;
  },
): Promise<TeamRun> {
  const { department, specialists, model } = opts;
  const label = departmentLabel(department);
  const preset = departmentOf(department);
  const lead = preset?.lead ?? `${label} lead`;
  const budget = opts.tokenBudget ?? envBudget() ?? LIMITS.tokens;
  const timeMs = opts.timeLimitMs ?? LIMITS.timeMs;

  const sources = new Map<string, Source>();
  /** Finished pieces of work, with the lead's step that asked for each. */
  const done: { step: number; report: Report }[] = [];
  const reports = () => done.map((d) => d.report);
  const used = { inputTokens: 0, outputTokens: 0 };
  const spent = () => used.inputTokens + used.outputTokens;
  const count = (usage: LanguageModelUsage) => {
    used.inputTokens += usage.inputTokens ?? 0;
    used.outputTokens += usage.outputTokens ?? 0;
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  };
  /** Why work was cut short, once it has been. */
  let stopped: string | undefined;
  const outOfTokens = () => {
    if (spent() < budget) return false;
    stopped ??= `the budget of ${budget.toLocaleString("en")} tokens was spent`;
    return true;
  };
  const asked = new Map<string, number>();
  let handedOut = 0;
  let leadStep = 0;
  /** Why a task can't be handed out any more, if it can't. */
  const refuse = (specialist: string) =>
    deadline.signal.aborted
      ? "The run's time is up."
      : outOfTokens()
        ? "The run's token budget is spent."
        : handedOut >= LIMITS.delegations
          ? `This run has handed out all ${LIMITS.delegations} of its tasks.`
          : (asked.get(specialist) ?? 0) >= LIMITS.perSpecialist
            ? `${specialist} has already been asked ${LIMITS.perSpecialist} times in this run.`
            : undefined;

  const id = await startRun(db, viewer, { department, task: opts.task, routineId: opts.routineId });
  // One write at a time, in order, so a slow early save never overwrites a later one.
  let saving = Promise.resolve();
  const save = (patch: Parameters<typeof saveRun>[2]) => (saving = saving.then(() => saveRun(db, id, patch)));

  // At the time limit, specialists still working are aborted; the lead keeps going to write up what came back.
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    stopped ??= `the time limit of ${Math.round(timeMs / 1000)} seconds was reached`;
    deadline.abort();
  }, timeMs);
  const signal = opts.abortSignal ? AbortSignal.any([opts.abortSignal, deadline.signal]) : deadline.signal;
  // Raced against each specialist, so one stuck in a tool that ignores the signal still gives way.
  const cut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  cut.catch(() => undefined);

  /** One specialist does one task. Never throws: whatever goes wrong becomes a failed report with the reason. */
  async function work(s: Specialist, task: string, earlier: Report[]): Promise<{ report: Report; systems: string[] }> {
    const steps = preset?.specialists.find((p) => p.name === s.name)?.steps ?? SPECIALIST_STEPS;
    const tools = toolsFor(opts.tools, s.tools);
    const digest = digestOf(earlier);
    let tokens = 0;
    let lastStep = false;
    const failed = (reason: string) => ({ report: { specialist: s.name, task, report: reason, status: "failed" as const, tokens }, systems: [] });
    try {
      const working = generateText({
        model,
        instructions: `${opts.instructions}\n\nYou are ${s.name}, a specialist on the ${label} team. Your job: ${s.job}\n\nYour lead (${lead}) gave you one task. Do only that, with your tools, and report back concisely: figures with the system they came from, claims with their [S#] refs, and the code of anything you proposed for approval. Say plainly what you couldn't find or reach.`,
        tools,
        // When its steps or the run's tokens run out it gets one last step without tools, so what it found is still reported.
        prepareStep: ({ stepNumber }) => ((lastStep = stepNumber >= steps - 1 || outOfTokens()) ? { toolChoice: "none" } : {}),
        stopWhen: [isStepCount(steps), () => lastStep],
        prompt: digest ? `${task}\n\nAlready found by others on the team in this run. Build on it rather than redoing it, and say so if what you find differs:\n${digest}` : task,
        abortSignal: signal,
        onLanguageModelCallEnd: (call) => void (tokens += count(call.usage)),
      });
      const result = await Promise.race([working, cut]);
      collectSources(
        result.steps.flatMap((step) => step.toolResults.map((r) => r.output)),
        sources,
      );
      const text = result.text.trim();
      return text ? { report: { specialist: s.name, task, report: text, status: "ok", tokens }, systems: systemsOf(tools) } : failed("Finished without writing a report");
    } catch (e) {
      return failed(deadline.signal.aborted ? "Ran out of time" : reasonOf(e));
    }
  }

  const delegate = tool({
    description: `Hand one specialist a focused task. Call it for several specialists in the same step and they work at the same time. Returns their report, or says that the part failed or wasn't run.`,
    inputSchema: z.object({
      specialist: z.enum(specialists.map((s) => s.name) as [string, ...string[]]),
      task: z.string().describe("What exactly to find out or prepare, with any names, dates and amounts it needs"),
    }),
    execute: async ({ specialist, task }) => {
      // Taken before any await: specialists called in the same step start together and stay independent.
      const step = leadStep;
      const earlier = done.filter((d) => d.step < step).map((d) => d.report);
      const refusal = refuse(specialist);
      if (refusal) return { specialist, status: "not_run", reason: `${refusal} Don't delegate this again: answer with what you have and say that this part wasn't done.` };
      handedOut++;
      asked.set(specialist, (asked.get(specialist) ?? 0) + 1);

      const { report, systems } = await work(specialists.find((s) => s.name === specialist)!, task, earlier);
      const review = reviewReport(report, reports(), systems);
      done.push({ step, report });
      void save({ reports: reports(), ...used });
      if (report.status === "failed") return { specialist, status: "failed", reason: report.report, note: "This part is missing. Say so in your answer, with the reason. Don't fill it in yourself." };
      return { specialist, status: "ok", report: report.report, ...(review.length ? { review } : {}) };
    },
  });

  const roster = specialists.map((s) => `- ${s.name}: ${s.job}`).join("\n");
  let answer = "";
  let failure: string | undefined;
  try {
    const result = await generateText({
      model,
      instructions: `${opts.instructions}\n\nRight now you are the ${lead}, leading the ${label} team. Your specialists:\n${roster}\n\nPlan the work, then hand each needed specialist a focused task with delegate. Call delegate for several specialists in the same step so they work in parallel; skip specialists the task doesn't need. A specialist you call in a later step is shown what the earlier ones found, so leave work that depends on someone else's findings for a later step. Don't do their work yourself.\n\nBefore you answer, check the reports against each other:\n- Where two reports disagree on a number, a date or a fact, or a claim has no [S#] ref and names no system it came from, either hand one specialist a single focused follow-up to settle it, or say plainly in the answer what disagrees or is unconfirmed. Never quietly pick one figure. A "review" list on a report marks likely spots, found automatically: look at each one, but it can be wrong.\n- A specialist that failed or wasn't run leaves a part missing. Name that part and the reason in the answer. Never fill it in yourself or write as if it was done.\n- You can hand out at most ${LIMITS.delegations} tasks in this run and ask each specialist at most ${LIMITS.perSpecialist} times. When delegate says tokens or time have run out, stop delegating and answer with what you have.\n\nThen write one combined answer: numbers first, keep their [S#] refs, and list anything waiting for approval with its code.`,
      tools: { delegate },
      // The last step is for the answer alone.
      prepareStep: ({ stepNumber }) => ((leadStep = stepNumber) >= LEAD_STEPS - 1 ? { toolChoice: "none" } : {}),
      stopWhen: isStepCount(LEAD_STEPS),
      prompt: opts.task,
      abortSignal: opts.abortSignal,
      timeout: { totalMs: timeMs + LIMITS.graceMs },
      // Counted as each model call ends, so the tasks that call hands out already see what it cost.
      onLanguageModelCallEnd: (call) => void count(call.usage),
    });
    answer = result.text.trim();
    if (!answer) failure = "The lead finished without writing an answer";
  } catch (e) {
    failure = reasonOf(e);
  } finally {
    clearTimeout(timer);
  }

  const finished = reports();
  const good = finished.filter((r) => r.status === "ok");
  // Parts nobody delivered: failed, and not made good by a later follow-up.
  const missing = [...new Map(finished.filter((r) => r.status === "failed" && !good.some((g) => g.specialist === r.specialist)).map((r) => [r.specialist, { specialist: r.specialist, reason: r.report }])).values()];
  if (failure) {
    // The lead's part failed; what the specialists found still goes back, uncombined.
    const parts = finished.map((r) => (r.status === "ok" ? `${r.specialist}:\n${r.report}` : `${r.specialist}: didn't finish (${r.report})`));
    answer = parts.length ? `The ${lead} couldn't combine the team's work (${failure}). What each specialist reported:\n\n${parts.join("\n\n")}` : `The ${label} team couldn't do this: ${failure}`;
  } else {
    // A safety net under the lead's instructions: a missing part is always named in the answer.
    const unsaid = missing.filter((m) => !answer.toLowerCase().includes(m.specialist.toLowerCase()));
    if (unsaid.length) answer += `\n\nNot covered: ${unsaid.map((m) => `${m.specialist} didn't finish (${m.reason})`).join("; ")}.`;
    if (stopped) answer += `\n\nStopped early: ${stopped}. Parts of this may be missing.`;
  }
  const status = failure ? "error" : stopped ? "over_budget" : "ok";
  const error = failure ?? (stopped ? `Stopped early: ${stopped}` : undefined);
  await save({ status, answer, reports: finished, ...used, error: error ?? null, finishedAt: new Date() });
  return { id, status, answer, reports: finished, sources: [...sources.values()], ...used, missing, error };
}

/** The main agent's way into the team. Undefined when the org has no specialists yet. */
export function askTeamTool(
  team: Map<string, Specialist[]>,
  opts: {
    db: Db;
    /** Whose access the team works with, and whose run it is. */
    viewer: Viewer;
    tools: () => ToolSet;
    model: LanguageModel;
    instructions: string;
    /** Set when the agent itself is running a scheduled task. */
    routineId?: string;
    tokenBudget?: number;
    /** Set it below the calling route's own time limit, so the lead still gets to answer. */
    timeLimitMs?: number;
    onUsage?: (u: { inputTokens: number; outputTokens: number }) => void;
  },
) {
  const departments = [...team.keys()];
  if (!departments.length) return undefined;
  const roster = departments.map((d) => `${d} (${departmentLabel(d)}: ${team.get(d)!.map((s) => s.name).join(", ")})`).join("; ");
  return tool({
    description: `Give a bigger piece of work to a department of the agent team, whose specialists work on it in parallel: ${roster}. Use it for multi-part work that matches a department (a cash report, chasing overdue payments, a pipeline review, what slipped this week), not for simple questions. Takes longer and costs more than answering yourself. If the result lists "missing" parts or has a "note", pass that on to the asker; don't fill the gap yourself.`,
    inputSchema: z.object({
      department: z.enum(departments as [string, ...string[]]),
      task: z.string().describe("The work, in full: what is wanted, for when, any names and dates"),
    }),
    execute: async ({ department, task }, { abortSignal }) => {
      const run = await runDepartment(opts.db, opts.viewer, { department, specialists: team.get(department)!, task, tools: opts.tools(), model: opts.model, instructions: opts.instructions, abortSignal, tokenBudget: opts.tokenBudget, timeLimitMs: opts.timeLimitMs, routineId: opts.routineId });
      opts.onUsage?.(run);
      return {
        department: departmentLabel(department),
        status: run.status,
        answer: run.answer,
        specialists: [...new Set(run.reports.map((r) => r.specialist))],
        ...(run.missing.length ? { missing: run.missing } : {}),
        ...(run.error ? { note: run.error } : {}),
        sources: run.sources,
      };
    },
  });
}

export { DEPARTMENTS };
