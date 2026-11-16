import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { cronUnauthorized } from "@/lib/cron";
import { runForEachOrg } from "@/ops/jobs";
import { processAndRepair } from "@/ops/repair";

export const maxDuration = 300;

/** Every 10 minutes: chunk, embed, screen and extract whatever arrived since the last run. Each company's pass is recorded on its own. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const models = defaultModels();
  return Response.json(await runForEachOrg(getDb(), "process", (org) => processAndRepair(getDb(), org.id, models)));
}
