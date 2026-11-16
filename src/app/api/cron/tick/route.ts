import { defaultModels } from "@/ai/models";
import { sweepApprovals } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { cronUnauthorized } from "@/lib/cron";
import { queueFailedRoutines, retryHandlers } from "@/ops/handlers";
import { allOrgs, outcomeOf, runJob, tidyJobRuns } from "@/ops/jobs";
import { pruneLetters, retryDue } from "@/ops/retry";
import { liveWebhookDeps, pruneWebhooks, sweepStuckWebhooks } from "@/ops/webhooks";
import { sendMeetingBriefs } from "@/notify/meetings";
import { pruneRateLimits } from "@/platform/rate-limit";
import { runDueRoutines } from "@/routines/run";

export const maxDuration = 300;

/**
 * Every 15 minutes. Per company, each as its own recorded job so one failing doesn't stop
 * the next: brief members on meetings about to start; run scheduled tasks that have come due
 * (and queue the failed ones that are safe to run again); expire proposals nobody decided and
 * settle ones a restart left half-sent. Then, once for everyone: retry failed work that has
 * come due (messages to the bot, scheduled tasks, reminders) and clear out old history.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const db = getDb();
  const models = defaultModels();
  const results: Record<string, unknown> = {};
  for (const org of await allOrgs(db)) {
    const orgId = org.id;
    results[orgId] = {
      meetings: outcomeOf(await runJob(db, { job: "briefs", orgId }, () => sendMeetingBriefs(db, orgId))),
      routines: outcomeOf(
        await runJob(db, { job: "routines", orgId }, async () => {
          const since = new Date();
          const ran = await runDueRoutines(db, orgId, models, since);
          return { ...ran, ...(await queueFailedRoutines(db, orgId, since)) };
        }),
      ),
      approvals: outcomeOf(await runJob(db, { job: "approvals", orgId }, () => sweepApprovals(db, orgId))),
    };
  }
  const retries = await runJob(db, { job: "retries" }, async () => {
    const stuck = await sweepStuckWebhooks(db);
    return { stuck, ...(await retryDue(db, retryHandlers(db, models, liveWebhookDeps()))) };
  });
  const tidy = await runJob(db, { job: "housekeeping" }, async () => ({ jobs: await tidyJobRuns(db), webhooks: await pruneWebhooks(db), letters: await pruneLetters(db), rateLimits: await pruneRateLimits(db) }));
  return Response.json({ ...results, retries: outcomeOf(retries), housekeeping: outcomeOf(tidy) });
}
