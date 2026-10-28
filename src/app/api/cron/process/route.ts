import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { cronUnauthorized, forEachOrg } from "@/lib/cron";
import { runPipeline } from "@/pipeline/run";

export const maxDuration = 300;

/** Every 10 minutes: chunk, embed, screen and extract whatever arrived since the last run. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const models = defaultModels();
  return Response.json(await forEachOrg((org) => runPipeline(getDb(), org.id, models)));
}
