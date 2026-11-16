import { generateText } from "ai";
import { and, eq, lte } from "drizzle-orm";
import { openAgent } from "@/agent/answer";
import { plainAnswer } from "@/agent/plain";
import { recordRun, type Models } from "@/ai/models";
import { notifyPerson } from "@/channels/links";
import type { Db } from "@/db/client";
import { notifications, orgs, people, routineRuns, routines } from "@/db/schema";
import { sendEmail } from "@/notify/email";
import { loadTeam, runDepartment } from "@/team/team";
import { formatShort } from "@/lib/time";
import { NOTHING_NEW, nextRun } from "./schedule";

type Routine = typeof routines.$inferSelect;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Runs one scheduled task as its owner (same access as when they ask in chat) and
 * delivers the result: saved in ALRO, emailed, and sent to their linked messaging apps.
 */
export async function runRoutine(db: Db, routine: Routine, models: Models, now = new Date()): Promise<{ runId: string; status: "ok" | "error" }> {
  const [run] = await db.insert(routineRuns).values({ orgId: routine.orgId, routineId: routine.id, personId: routine.ownerPersonId, startedAt: now }).returning({ id: routineRuns.id });
  const [person] = await db.select({ displayName: people.displayName, email: people.primaryEmail, isMember: people.isMember }).from(people).where(eq(people.id, routine.ownerPersonId));
  try {
    if (!person?.isMember) throw new Error("The owner is no longer a member");
    const viewer = { orgId: routine.orgId, personId: routine.ownerPersonId, displayName: person.displayName };
    const { agent, close } = await openAgent(db, viewer, models, { now, scheduled: true, routine: { id: routine.id, trusted: routine.trusted } });
    const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, routine.orgId));
    // A watch runs every few minutes: it only looks at what's new and stays quiet otherwise.
    const watch =
      routine.schedule.kind === "every"
        ? `\n\nThis runs every ${routine.schedule.minutes} minutes. ${routine.lastRunAt ? `It last ran at ${formatShort(routine.lastRunAt, org.timezone)}: only handle what arrived or changed since then, and don't redo anything handled before.` : "This is its first run: look at the last day."} If there is nothing new to act on, reply with exactly ${NOTHING_NEW} and nothing else.`
        : "";
    const prompt = `This is a scheduled task you run for ${person.displayName}, titled "${routine.title}". Do it now and write the result for them to read later; they aren't here to answer questions.${routine.trusted ? " They trust this task: actions you take run without asking them." : " Anything you propose waits for their approval; list what's waiting with its code."}\n\nTask: ${routine.instruction}${watch}`;
    let output: string;
    try {
      const specialists = routine.team ? (await loadTeam(db, routine.orgId)).get(routine.team) : undefined;
      if (specialists?.length) {
        // A department's task: its lead hands parts to the specialists, who work in parallel.
        const run = await runDepartment(db, viewer, { department: routine.team!, specialists, task: prompt, tools: agent.tools, model: models.answer, instructions: agent.instructions, routineId: routine.id });
        await recordRun(db, { orgId: routine.orgId, stage: "team", model: models.answer, inputTokens: run.inputTokens, outputTokens: run.outputTokens });
        // The lead failed and no specialist reported anything: that is a failed run, not a result to deliver.
        if (run.status === "error" && !run.reports.some((r) => r.status === "ok")) throw new Error(run.error ?? "The team couldn't do this");
        output = plainAnswer(run.answer, run.sources);
      } else {
        const result = await generateText({ ...agent, prompt });
        await recordRun(db, { orgId: routine.orgId, stage: "routine", model: models.answer, inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens });
        output = plainAnswer(result.text, result.steps.flatMap((s) => s.toolResults.map((r) => r.output)));
      }
    } finally {
      await close();
    }
    await db.update(routineRuns).set({ status: "ok", output, finishedAt: new Date() }).where(eq(routineRuns.id, run.id));
    if (output.trim() === NOTHING_NEW || output.trim().startsWith(NOTHING_NEW)) return { runId: run.id, status: "ok" };
    await db.insert(notifications).values({ orgId: routine.orgId, personId: routine.ownerPersonId, commitmentId: null, kind: `routine:${run.id}`, channel: "in_app", sentAt: now }).onConflictDoNothing();

    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;max-width:560px;white-space:pre-wrap">${esc(output)}</div>`;
    const emailed = person.email ? await sendEmail({ to: person.email, subject: routine.title, text: output, html }).catch(() => false) : false;
    const pinged = await notifyPerson(db, routine.orgId, routine.ownerPersonId, `${routine.title}\n\n${output}`, now);
    if (emailed || pinged.length) await db.update(notifications).set({ channel: emailed ? "email" : pinged[0] }).where(and(eq(notifications.personId, routine.ownerPersonId), eq(notifications.kind, `routine:${run.id}`)));
    return { runId: run.id, status: "ok" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`routine ${routine.id} failed`, error);
    await db.update(routineRuns).set({ status: "error", error: error.slice(0, 1000), finishedAt: new Date() }).where(eq(routineRuns.id, run.id));
    return { runId: run.id, status: "error" };
  }
}

/**
 * Runs every scheduled task that has come due. Each is claimed by moving its next run
 * forward first, so two overlapping cron runs never do the same task twice.
 */
export async function runDueRoutines(db: Db, orgId: string, models: Models, now = new Date()): Promise<{ ran: number; failed: number }> {
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  const due = await db.select().from(routines).where(and(eq(routines.orgId, orgId), eq(routines.enabled, true), lte(routines.nextRunAt, now)));
  const stats = { ran: 0, failed: 0 };
  for (const routine of due) {
    const [claimed] = await db
      .update(routines)
      .set({ nextRunAt: nextRun(routine.schedule, org.timezone, now), lastRunAt: now })
      .where(and(eq(routines.id, routine.id), eq(routines.nextRunAt, routine.nextRunAt!)))
      .returning({ id: routines.id });
    if (!claimed) continue;
    const { status } = await runRoutine(db, routine, models, now);
    if (status === "ok") stats.ran++;
    else stats.failed++;
  }
  return stats;
}
