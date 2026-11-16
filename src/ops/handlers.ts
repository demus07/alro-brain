import { and, eq, gte, inArray } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { approvals, commitments, routineRuns, routines } from "@/db/schema";
import { deliverReminders } from "@/notify/deliver";
import type { Reminder } from "@/pipeline/watcher";
import { runRoutine } from "@/routines/run";
import { deadLetter, GiveUp, resolveLetter, type RetryHandlers } from "./retry";
import { replayWebhook, type WebhookDeps } from "./webhooks";

/** Errors that usually pass by themselves: the model or an app was busy, slow or unreachable. */
const TEMPORARY = /time[d\s-]?out|overloaded|rate.?limit|too many requests|\b(429|5\d\d)\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|temporar|unavailable|try again/i;

/**
 * Did this scheduled task propose or do anything since `since`? Every action a task takes,
 * whether it waits for approval or runs because the task is trusted, is a row in `approvals`
 * tagged with the task, so one row is enough to know.
 */
async function actedSince(db: Db, routineId: string, since: Date): Promise<boolean> {
  const [row] = await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.routineId, routineId), gte(approvals.createdAt, since))).limit(1);
  return !!row;
}

/**
 * After the tick has run the scheduled tasks that were due: queues the ones that failed for
 * another try, and clears earlier failures of the ones that worked.
 *
 * The rule for running a failed task again, on purpose narrow:
 * - never if it proposed or ran any action before failing. A second run would propose or do
 *   it again (two emails waiting, or for a trusted task two Slack posts sent);
 * - never if the error doesn't look temporary ("the owner is no longer a member" won't fix itself);
 * - a watch ("every N minutes") isn't queued at all: its next run is minutes away anyway;
 * - otherwise at most twice, 5 and then 30 minutes later, checking the first point again each time.
 * A task that isn't re-run is still listed on the Health page, where an admin can run it by hand.
 * Not covered: a note or tracker row the task saved before failing can be saved again by a re-run.
 */
export async function queueFailedRoutines(db: Db, orgId: string, since: Date, now = new Date()): Promise<{ queued: number; leftForAPerson: number }> {
  const runs = await db
    .select({ id: routineRuns.id, routineId: routineRuns.routineId, status: routineRuns.status, error: routineRuns.error, startedAt: routineRuns.startedAt, schedule: routines.schedule })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(and(eq(routineRuns.orgId, orgId), gte(routineRuns.startedAt, since), inArray(routineRuns.status, ["ok", "error"])));
  const stats = { queued: 0, leftForAPerson: 0 };
  for (const run of runs) {
    if (run.status === "ok") {
      await resolveLetter(db, "routine", run.routineId, now);
      continue;
    }
    if (run.schedule.kind === "every") continue;
    const error = run.error ?? "It failed without saying why.";
    const why = (await actedSince(db, run.routineId, run.startedAt)) ? "it had already proposed or done something" : TEMPORARY.test(error) ? undefined : "the error doesn't look temporary";
    await deadLetter(db, {
      orgId,
      kind: "routine",
      ref: run.routineId,
      payload: { runId: run.id, since: run.startedAt.toISOString() },
      error: why ? `${error} Not run again automatically: ${why}.` : error,
      retry: !why,
      now,
    });
    if (why) stats.leftForAPerson++;
    else stats.queued++;
  }
  return stats;
}

/**
 * Delivers the watcher's reminders one person at a time, and queues a person's reminders
 * for another try when their delivery fails (the email service was down).
 */
export async function deliverOrQueue(db: Db, orgId: string, reminders: Reminder[], now = new Date()): Promise<{ emailed: number; messaged: number; failed: number }> {
  const total = { emailed: 0, messaged: 0, failed: 0 };
  for (const personId of new Set(reminders.map((r) => r.personId))) {
    const theirs = reminders.filter((r) => r.personId === personId);
    const stats = await deliverReminders(db, orgId, theirs, now);
    total.emailed += stats.emailed;
    total.messaged += stats.messaged;
    total.failed += stats.failed;
    if (stats.failed) {
      // Ids and kinds only; the text is built again from the promises when it's retried.
      await deadLetter(db, { orgId, kind: "notify", ref: `${personId}:${now.toISOString().slice(0, 13)}`, payload: { reminders: theirs }, error: "The reminder couldn't be delivered.", now });
    }
  }
  return total;
}

/** How each kind of failed work is done again. Used by the tick and by "Retry now". */
export function retryHandlers(db: Db, models: Models, webhooks: WebhookDeps): RetryHandlers {
  return {
    webhook: (letter, ctx) => replayWebhook(db, letter.ref, webhooks, ctx),

    async routine(letter, ctx) {
      const [routine] = await db.select().from(routines).where(eq(routines.id, letter.ref));
      // Deleted or switched off since: nothing to run.
      if (!routine?.enabled) return;
      const since = new Date(String(letter.payload?.since ?? letter.createdAt.toISOString()));
      // An automatic re-run that failed may itself have acted. A person retrying has seen the warning.
      if (!ctx.manual && (await actedSince(db, routine.id, since))) throw new GiveUp("Not run again: it had already proposed or done something before it failed.");
      const { runId, status } = await runRoutine(db, routine, models, ctx.now);
      if (status === "error") {
        const [run] = await db.select({ error: routineRuns.error }).from(routineRuns).where(eq(routineRuns.id, runId));
        throw new Error(run?.error ?? "It failed again.");
      }
    },

    async notify(letter, ctx) {
      if (!letter.orgId) return;
      const queued = ((letter.payload?.reminders as Reminder[] | undefined) ?? []).filter((r) => r.personId && r.kind);
      // A promise kept or dropped since then needs no reminder.
      const ids = queued.flatMap((r) => (r.commitmentId ? [r.commitmentId] : []));
      const open = ids.length ? await db.select({ id: commitments.id }).from(commitments).where(and(inArray(commitments.id, ids), inArray(commitments.status, ["open", "due_soon", "overdue"]))) : [];
      const still = queued.filter((r) => !r.commitmentId || open.some((c) => c.id === r.commitmentId));
      if (!still.length) return;
      const stats = await deliverReminders(db, letter.orgId, still, ctx.now);
      if (stats.failed) throw new Error("The reminder still couldn't be delivered.");
    },
  };
}
