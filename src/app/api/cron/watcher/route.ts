import { getDb } from "@/db/client";
import { refreshInsights } from "@/insights/compute";
import { notifyInsights } from "@/insights/notify";
import { cronUnauthorized } from "@/lib/cron";
import { deliverOrQueue } from "@/ops/handlers";
import { runForEachOrg } from "@/ops/jobs";
import { runWatcher } from "@/pipeline/watcher";
import { applyRetention } from "@/platform/data";

export const maxDuration = 120;

/**
 * Hourly: move commitments to due_soon / overdue, queue reminders and digests, and send them.
 * A reminder that can't be delivered is queued and tried again by the tick. Then work out what
 * needs someone's attention and tell the people concerned about anything urgent, and delete
 * what is older than the company's retention period.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const db = getDb();
  return Response.json(
    await runForEachOrg(db, "watcher", async (org) => {
      const watched = await runWatcher(db, org.id);
      const delivered = await deliverOrQueue(db, org.id, watched.reminders);
      const now = new Date();
      const insights = await refreshInsights(db, org.id, now);
      const urgent = await notifyInsights(db, org.id, now);
      const retention = await applyRetention(db, org.id, now);
      return { statusChanges: watched.statusChanges, reminders: watched.reminders.length, delivered, insights, urgent, ...(retention ? { retention } : {}) };
    }),
  );
}
