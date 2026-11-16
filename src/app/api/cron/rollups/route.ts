import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { cronUnauthorized } from "@/lib/cron";
import { previousLocalDay } from "@/lib/time";
import { runForEachOrg } from "@/ops/jobs";
import { writeThreadRollups } from "@/pipeline/rollups";

export const maxDuration = 300;

/**
 * Hourly, so each org gets yesterday's summaries soon after its own midnight.
 * Days that already have rollups are skipped, so the extra runs cost one query.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const models = defaultModels();
  return Response.json(
    await runForEachOrg(getDb(), "rollups", (org) => {
      const { start, end } = previousLocalDay(new Date(), org.timezone);
      return writeThreadRollups(getDb(), org.id, models, start, end);
    }),
  );
}
