import { defaultModels } from "@/ai/models";
import { syncOrg } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { cronUnauthorized, forEachOrg } from "@/lib/cron";
import { runPipeline } from "@/pipeline/run";

export const maxDuration = 300;

/** Pulls what's new from every live connector (Slack, Gmail, Notion), then processes it. */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const models = defaultModels();
  return Response.json(
    await forEachOrg(async (org) => {
      const synced = await syncOrg(getDb(), org.id);
      const processed = synced.some((s) => s.messages) ? await runPipeline(getDb(), org.id, models) : undefined;
      return { synced, processed };
    }),
  );
}
