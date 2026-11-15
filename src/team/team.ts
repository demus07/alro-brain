import { generateText, isStepCount, tool, type LanguageModel, type ToolSet } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Source } from "@/agent/tools";
import type { Db } from "@/db/client";
import { teamAgents } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { departmentLabel, departmentOf, DEPARTMENTS } from "./presets";

type Specialist = Pick<typeof teamAgents.$inferSelect, "name" | "job" | "tools">;

const SPECIALIST_STEPS = 8;
const LEAD_STEPS = 6;
/** Tools a specialist never gets: it works on one task and reports back. */
const NEVER = new Set(["askTeam", "scheduleTask", "cancelScheduledTask", "listScheduledTasks", "rememberAboutMe"]);

/** A specialist that lists no tools reads company memory and nothing else. */
const MEMORY_ONLY = ["searchMemory", "readThread", "lookupEntity", "dailySummaries", "listCommitments", "commitmentHistory", "findProcedure", "readTracker"];

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

/** Adds a ready-made department's specialists (skipping any already there by name). */
export async function addDepartment(db: Db, viewer: Viewer, id: string) {
  const preset = departmentOf(id);
  if (!preset) throw new Error("Unknown department");
  const existing = new Set((await loadTeam(db, viewer.orgId)).get(id)?.map((s) => s.name));
  const fresh = preset.specialists.filter((s) => !existing.has(s.name));
  if (fresh.length) await db.insert(teamAgents).values(fresh.map((s) => ({ orgId: viewer.orgId, department: id, name: s.name, job: s.job, tools: s.tools, createdBy: viewer.personId })));
}

export interface TeamRun {
  answer: string;
  reports: { specialist: string; task: string; report: string }[];
  sources: Source[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * One department works on a task: its lead plans and hands focused pieces to specialists
 * with `delegate` (several calls in one step run at the same time), then combines what
 * they found. Each specialist sees only its own job and tools.
 */
export async function runDepartment(opts: {
  department: string;
  specialists: Specialist[];
  task: string;
  tools: ToolSet;
  model: LanguageModel;
  /** The asker's standing instructions (who they are, how to cite). */
  instructions: string;
  abortSignal?: AbortSignal;
}): Promise<TeamRun> {
  const { department, specialists, model } = opts;
  const label = departmentLabel(department);
  const lead = departmentOf(department)?.lead ?? `${label} lead`;
  const sources = new Map<string, Source>();
  const reports: TeamRun["reports"] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  const delegate = tool({
    description: `Hand one specialist a focused task. Call it for several specialists in the same step and they work at the same time. Returns their report.`,
    inputSchema: z.object({
      specialist: z.enum(specialists.map((s) => s.name) as [string, ...string[]]),
      task: z.string().describe("What exactly to find out or prepare, with any names, dates and amounts it needs"),
    }),
    execute: async ({ specialist, task }) => {
      const s = specialists.find((x) => x.name === specialist)!;
      const result = await generateText({
        model,
        instructions: `${opts.instructions}\n\nYou are ${s.name}, a specialist on the ${label} team. Your job: ${s.job}\n\nYour lead (${lead}) gave you one task. Do only that, with your tools, and report back concisely: figures with the system they came from, claims with their [S#] refs, and the code of anything you proposed for approval. Say plainly what you couldn't find or reach.`,
        tools: toolsFor(opts.tools, s.tools),
        stopWhen: isStepCount(SPECIALIST_STEPS),
        prompt: task,
        abortSignal: opts.abortSignal,
      });
      usage.inputTokens += result.totalUsage.inputTokens ?? 0;
      usage.outputTokens += result.totalUsage.outputTokens ?? 0;
      collectSources(
        result.steps.flatMap((step) => step.toolResults.map((r) => r.output)),
        sources,
      );
      const report = result.text.trim() || "No findings.";
      reports.push({ specialist, task, report });
      return { specialist, report };
    },
  });

  const roster = specialists.map((s) => `- ${s.name}: ${s.job}`).join("\n");
  const result = await generateText({
    model,
    instructions: `${opts.instructions}\n\nRight now you are the ${lead}, leading the ${label} team. Your specialists:\n${roster}\n\nPlan the work, then hand each needed specialist a focused task with delegate. Call delegate for several specialists in the same step so they work in parallel; skip specialists the task doesn't need. Don't do their work yourself. When they report back, write one combined answer: numbers first, keep their [S#] refs, and list anything waiting for approval with its code.`,
    tools: { delegate },
    stopWhen: isStepCount(LEAD_STEPS),
    prompt: opts.task,
    abortSignal: opts.abortSignal,
  });
  usage.inputTokens += result.totalUsage.inputTokens ?? 0;
  usage.outputTokens += result.totalUsage.outputTokens ?? 0;
  return { answer: result.text.trim(), reports, sources: [...sources.values()], ...usage };
}

/** The main agent's way into the team. Undefined when the org has no specialists yet. */
export function askTeamTool(
  team: Map<string, Specialist[]>,
  opts: { tools: () => ToolSet; model: LanguageModel; instructions: string; onUsage?: (u: { inputTokens: number; outputTokens: number }) => void },
) {
  const departments = [...team.keys()];
  if (!departments.length) return undefined;
  const roster = departments.map((d) => `${d} (${departmentLabel(d)}: ${team.get(d)!.map((s) => s.name).join(", ")})`).join("; ");
  return tool({
    description: `Give a bigger piece of work to a department of the agent team, whose specialists work on it in parallel: ${roster}. Use it for multi-part work that matches a department (a cash report, chasing overdue payments, a pipeline review, what slipped this week), not for simple questions. Takes longer and costs more than answering yourself.`,
    inputSchema: z.object({
      department: z.enum(departments as [string, ...string[]]),
      task: z.string().describe("The work, in full: what is wanted, for when, any names and dates"),
    }),
    execute: async ({ department, task }, { abortSignal }) => {
      const run = await runDepartment({ department, specialists: team.get(department)!, task, tools: opts.tools(), model: opts.model, instructions: opts.instructions, abortSignal });
      opts.onUsage?.(run);
      return { department: departmentLabel(department), answer: run.answer, specialists: run.reports.map((r) => r.specialist), sources: run.sources };
    },
  });
}

export { DEPARTMENTS };
