import { desc, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { teamRuns } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";

export type RunStatus = "running" | "ok" | "error" | "over_budget";

/** Still "running" after this long (well past any run's time limit): the process doing it is gone. */
export const STUCK_MS = 15 * 60_000;

/** Opens the record of a run, so it shows as work in progress from its first moment. */
export async function startRun(db: Db, viewer: Viewer, run: { department: string; task: string; routineId?: string }): Promise<string> {
  const [row] = await db
    .insert(teamRuns)
    .values({ orgId: viewer.orgId, personId: viewer.personId, department: run.department, task: run.task, routineId: run.routineId ?? null })
    .returning({ id: teamRuns.id });
  return row.id;
}

/** Saves how far a run has got, or how it ended. Never throws: losing the record must not lose the work. */
export async function saveRun(db: Db, id: string, patch: Partial<Pick<typeof teamRuns.$inferInsert, "status" | "answer" | "reports" | "inputTokens" | "outputTokens" | "error" | "finishedAt">>) {
  try {
    await db.update(teamRuns).set(patch).where(eq(teamRuns.id, id));
  } catch (e) {
    console.error(`team run ${id} could not be saved`, e instanceof Error ? e.message : e);
  }
}

/** The viewer's own recent runs, newest first. A run holds what one person's access found, so only they can read it. */
export const recentRuns = (db: Db, viewer: Viewer, limit = 15) =>
  withScope(db, viewer, (tx) =>
    tx
      .select({ ...getTableColumns(teamRuns), stuck: sql<boolean>`${teamRuns.status} = 'running' and ${teamRuns.startedAt} < now() - make_interval(secs => ${STUCK_MS / 1000})` })
      .from(teamRuns)
      .orderBy(desc(teamRuns.startedAt))
      .limit(limit),
  );
