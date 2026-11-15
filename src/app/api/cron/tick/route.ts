import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { cronUnauthorized, forEachOrg } from "@/lib/cron";
import { sendMeetingBriefs } from "@/notify/meetings";
import { runDueRoutines } from "@/routines/run";

export const maxDuration = 300;

/** Every 15 minutes: brief members on meetings about to start, and run scheduled tasks that have come due. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const models = defaultModels();
  return Response.json(
    await forEachOrg(async (org) => ({
      meetings: await sendMeetingBriefs(getDb(), org.id),
      routines: await runDueRoutines(getDb(), org.id, models),
    })),
  );
}
