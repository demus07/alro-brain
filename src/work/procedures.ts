import { generateText, Output } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { procedures } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { batches, render, visibleMessages } from "./messages";

const LOOKBACK_DAYS = 90;
const MAX_MESSAGES = 1500;
const BATCH_CHARS = 24_000;

const FREQUENCIES = ["daily", "weekly", "monthly", "occasional"] as const;
const JUDGMENT = ["low", "medium", "high"] as const;

const procedureSchema = z.object({
  title: z.string().describe('What gets done, e.g. "Unloading a truck at the warehouse"'),
  summary: z.string().describe("One or two sentences: when it happens and what it achieves"),
  steps: z.array(z.string()).describe("In order, concrete: who does what, with what, and checks made"),
  owners: z.string().nullable().describe("Who does it today, by name or role"),
  frequency: z.enum(FREQUENCIES),
  minutes: z.number().int().nullable().describe("Rough minutes each time, if you can tell"),
  judgment: z.enum(JUDGMENT).describe("low: same rules every time; high: needs someone's judgment"),
  lines: z.array(z.number().int()).describe("Line numbers where it is done or explained"),
});

const INSTRUCTIONS = `You read a company's conversations and write down the procedures people actually follow: recurring pieces of work that are done the same way each time (receiving stock, dispatching an order, raising an invoice, onboarding a client, approving a discount).
Only write a procedure the conversations show being done or explained, with steps you can point to. Don't invent steps or best practice. Skip one-off events and small talk. Translate other languages to English. Use people's names.`;

/**
 * Which work to hand to the agent first: often, long and rule-bound scores high, judgment
 * calls score low. Every day, over 20 minutes, same rules every time is the top of the list.
 */
export function automationScore(p: { frequency: (typeof FREQUENCIES)[number]; minutes: number | null; judgment: (typeof JUDGMENT)[number] }): number {
  const often = { daily: 40, weekly: 25, monthly: 10, occasional: 5 }[p.frequency];
  const long = p.minutes === null ? 10 : p.minutes >= 20 ? 30 : p.minutes >= 10 ? 20 : p.minutes >= 5 ? 10 : 5;
  const rules = { low: 30, medium: 15, high: 0 }[p.judgment];
  return often + long + rules;
}

/**
 * Writes up the procedures visible in what this person can see from the last 90 days,
 * merging with ones written before (same title → updated). Returns how many it saved.
 */
export async function writeProcedures(db: Db, viewer: Viewer, models: Models, now = new Date()): Promise<number> {
  const lines = await visibleMessages(db, viewer, { after: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000), limit: MAX_MESSAGES, newest: true });
  const known = await db.select({ title: procedures.title }).from(procedures).where(eq(procedures.personId, viewer.personId));
  const found = new Map<string, z.infer<typeof procedureSchema> & { messageIds: string[] }>();
  for (const batch of batches(lines, BATCH_CHARS)) {
    const titles = [...known.map((k) => k.title), ...found.keys()];
    const { output, usage } = await generateText({
      model: models.extract,
      instructions: INSTRUCTIONS,
      output: Output.object({ schema: z.object({ procedures: z.array(procedureSchema) }) }),
      prompt: `${titles.length ? `Procedures already written (reuse the exact title when you find more about one of these):\n${titles.map((t) => `- ${t}`).join("\n")}\n\n` : ""}Conversations:\n${render(batch)}`,
    });
    await recordRun(db, { orgId: viewer.orgId, stage: "procedures", model: models.extract, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    for (const p of output.procedures) {
      const messageIds = p.lines.flatMap((n) => (batch[n - 1] ? [batch[n - 1].id] : []));
      if (!p.steps.length || !messageIds.length) continue;
      const before = found.get(p.title);
      found.set(p.title, before ? { ...p, steps: p.steps.length >= before.steps.length ? p.steps : before.steps, messageIds: [...new Set([...before.messageIds, ...messageIds])] } : { ...p, messageIds });
    }
  }
  for (const p of found.values()) {
    const values = {
      summary: p.summary,
      steps: p.steps,
      owners: p.owners,
      frequency: p.frequency,
      minutes: p.minutes,
      judgment: p.judgment,
      automationScore: automationScore(p),
      messageIds: p.messageIds.slice(0, 50),
      updatedAt: now,
    };
    await db
      .insert(procedures)
      .values({ orgId: viewer.orgId, personId: viewer.personId, title: p.title.slice(0, 200), ...values })
      .onConflictDoUpdate({ target: [procedures.personId, procedures.title], set: values });
  }
  return found.size;
}

export const listProcedures = (db: Db, viewer: Viewer) =>
  db
    .select()
    .from(procedures)
    .where(and(eq(procedures.orgId, viewer.orgId), eq(procedures.personId, viewer.personId)))
    .orderBy(desc(procedures.automationScore), procedures.title);
