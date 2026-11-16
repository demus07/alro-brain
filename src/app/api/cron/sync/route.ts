import { defaultModels } from "@/ai/models";
import { syncOrg } from "@/connectors/sync";
import { getDb } from "@/db/client";
import { cronUnauthorized } from "@/lib/cron";
import { allOrgs, outcomeOf, runJob } from "@/ops/jobs";
import { processAndRepair } from "@/ops/repair";
import { syncAndWatch } from "@/ops/sources";

export const maxDuration = 300;

/**
 * Pulls what's new from every connected source, then processes it. Syncing and processing
 * are recorded as separate runs per company, so a failure in either shows up as what it is.
 * Admins are told once when a source stops accepting ALRO's access.
 */
export async function GET(request: Request) {
  const denied = cronUnauthorized(request);
  if (denied) return denied;
  const db = getDb();
  const models = defaultModels();
  const results: Record<string, unknown> = {};
  for (const org of await allOrgs(db)) {
    const synced = await runJob(db, { job: "sync", orgId: org.id }, () => syncAndWatch(db, org.id, () => syncOrg(db, org.id)));
    const fresh = synced.ok && synced.result.some((s) => s.messages);
    results[org.id] = { synced: outcomeOf(synced), processed: fresh ? outcomeOf(await runJob(db, { job: "process", orgId: org.id }, () => processAndRepair(db, org.id, models))) : undefined };
  }
  return Response.json(results);
}
