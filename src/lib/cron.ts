import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Without a secret the
 * jobs only run in development.
 */
export function cronUnauthorized(request: Request): Response | undefined {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV === "production" ? Response.json({ error: "CRON_SECRET is not set" }, { status: 500 }) : undefined;
  }
  return request.headers.get("authorization") === `Bearer ${secret}` ? undefined : Response.json({ error: "Unauthorized" }, { status: 401 });
}

/** Runs `job` for every org, one at a time, collecting each result or error. */
export async function forEachOrg<T>(job: (org: { id: string; timezone: string }) => Promise<T>) {
  const all = await getDb().select({ id: orgs.id, timezone: orgs.timezone }).from(orgs);
  const results: Record<string, T | { error: string }> = {};
  for (const org of all) {
    try {
      results[org.id] = await job(org);
    } catch (e) {
      console.error(`cron job failed for org ${org.id}`, e);
      results[org.id] = { error: (e as Error).message };
    }
  }
  return results;
}
