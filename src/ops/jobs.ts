import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { jobRuns, orgs } from "@/db/schema";
import { alert, recovered } from "./alerts";
import { errorText, log } from "./log";

/** Failures in a row before someone is told. */
export const ALERT_AFTER = 3;
/** How long job history is kept. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** Longer than any job may run (cron routes allow 300s): a run still "running" after this has died. */
const STALE_MS = 20 * 60 * 1000;
const MAX_STATS_CHARS = 4000;

export type JobOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

/** What a job returned, small enough to keep: counts and short lists, never content. */
function statsOf(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) return undefined;
  const stats = typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
  try {
    return JSON.stringify(stats).length > MAX_STATS_CHARS ? { note: "too large to keep" } : stats;
  } catch {
    return undefined;
  }
}

/**
 * Runs one background job and keeps a record of it in `job_runs`: running, then ok (with what
 * it returned and how long it took) or error (with the message). Never throws, so a loop over
 * companies carries on after one fails. Tells the admins when the same job has failed
 * ALERT_AFTER times in a row, and clears that once it succeeds again.
 */
export async function runJob<T>(db: Db, { job, orgId = null, now = new Date() }: { job: string; orgId?: string | null; now?: Date }, fn: () => Promise<T>): Promise<JobOutcome<T>> {
  const [run] = await db.insert(jobRuns).values({ job, orgId, startedAt: now }).returning({ id: jobRuns.id });
  const started = Date.now();
  const finishedAt = () => new Date(now.getTime() + (Date.now() - started));
  try {
    const result = await fn();
    await db.update(jobRuns).set({ status: "ok", stats: statsOf(result), finishedAt: finishedAt() }).where(eq(jobRuns.id, run.id));
    log.info("job.ok", { job, orgId: orgId ?? undefined, ms: Date.now() - started });
    await recovered(db, { orgId, key: `job:${job}` });
    return { ok: true, result };
  } catch (e) {
    const error = errorText(e).slice(0, 1000);
    await db.update(jobRuns).set({ status: "error", error, finishedAt: finishedAt() }).where(eq(jobRuns.id, run.id));
    log.error("job.failed", { job, orgId: orgId ?? undefined, ms: Date.now() - started, error });
    if ((await failuresInARow(db, job, orgId)) === ALERT_AFTER) {
      await alert(db, { orgId, key: `job:${job}`, text: `The ${job} job has failed ${ALERT_AFTER} times in a row. Last error: ${error.slice(0, 300)}` });
    }
    return { ok: false, error };
  }
}

/** How many of the job's most recent finished runs failed, counting back from the latest. */
async function failuresInARow(db: Db, job: string, orgId: string | null): Promise<number> {
  const recent = await db
    .select({ status: jobRuns.status })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, job), orgId ? eq(jobRuns.orgId, orgId) : isNull(jobRuns.orgId), ne(jobRuns.status, "running")))
    .orderBy(desc(jobRuns.startedAt), desc(jobRuns.finishedAt))
    .limit(ALERT_AFTER + 1);
  const firstOk = recent.findIndex((r) => r.status !== "error");
  return firstOk === -1 ? recent.length : firstOk;
}

export interface Org {
  id: string;
  timezone: string;
}

export const allOrgs = (db: Db): Promise<Org[]> => db.select({ id: orgs.id, timezone: orgs.timezone }).from(orgs);

/** What a recorded job hands back to a cron route: its result, or the error. */
export const outcomeOf = <T>(o: JobOutcome<T>): T | { error: string } => (o.ok ? o.result : { error: o.error });

/**
 * Runs a job once per company, each as its own recorded run, so one company's failure is
 * visible and doesn't stop the others. Returns each company's result or error, by org id.
 */
export async function runForEachOrg<T>(db: Db, job: string, fn: (org: Org) => Promise<T>): Promise<Record<string, T | { error: string }>> {
  const results: Record<string, T | { error: string }> = {};
  for (const org of await allOrgs(db)) {
    const outcome = await runJob(db, { job, orgId: org.id }, () => fn(org));
    results[org.id] = outcomeOf(outcome);
  }
  return results;
}

/** Closes runs that died without finishing and drops history older than two weeks. */
export async function tidyJobRuns(db: Db, now = new Date()): Promise<{ closed: number; pruned: number }> {
  const closed = await db
    .update(jobRuns)
    .set({ status: "error", error: "Stopped before it finished (the server restarted or ran out of time).", finishedAt: now })
    .where(and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, new Date(now.getTime() - STALE_MS))))
    .returning({ id: jobRuns.id });
  const pruned = await db
    .delete(jobRuns)
    .where(lt(jobRuns.startedAt, new Date(now.getTime() - KEEP_MS)))
    .returning({ id: jobRuns.id });
  return { closed: closed.length, pruned: pruned.length };
}
