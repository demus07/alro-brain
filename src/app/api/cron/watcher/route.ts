import { getDb } from "@/db/client";
import { cronUnauthorized, forEachOrg } from "@/lib/cron";
import { runWatcher } from "@/pipeline/watcher";

export const maxDuration = 120;

/** Hourly: move commitments to due_soon / overdue and queue reminders and digests. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  return Response.json(await forEachOrg((org) => runWatcher(getDb(), org.id)));
}
