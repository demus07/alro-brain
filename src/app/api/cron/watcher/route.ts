import { getDb } from "@/db/client";
import { cronUnauthorized, forEachOrg } from "@/lib/cron";
import { deliverReminders } from "@/notify/deliver";
import { runWatcher } from "@/pipeline/watcher";

export const maxDuration = 120;

/** Hourly: move commitments to due_soon / overdue, queue reminders and digests, and email them. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  return Response.json(
    await forEachOrg(async (org) => {
      const watched = await runWatcher(getDb(), org.id);
      return { ...watched, delivered: await deliverReminders(getDb(), org.id, watched.reminders) };
    }),
  );
}
