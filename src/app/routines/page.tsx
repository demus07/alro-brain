import { and, desc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { orgs, routineRuns, routines } from "@/db/schema";
import { withScope } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { describeSchedule } from "@/routines/schedule";
import { deleteRoutine, runRoutineNow, toggleRoutine } from "./actions";
import { NewRoutine } from "./new-routine";

export const metadata: Metadata = { title: "Scheduled · ALRO" };

export default function RoutinesPage() {
  return (
    <>
      <h1>Scheduled</h1>
      <p className="muted">Work ALRO does for you on a schedule, with your access. Results land here, in your email and in your linked messaging apps. You can also just ask the agent: &quot;every Monday at 8, send me…&quot;.</p>
      <div className="split">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Routines />
        </Suspense>
        <NewRoutine />
      </div>
    </>
  );
}

async function Routines() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const { list, runs } = await withScope(db, viewer, async (tx) => {
    const list = await tx.select().from(routines).orderBy(desc(routines.createdAt));
    const runs = list.length
      ? await tx
          .select()
          .from(routineRuns)
          .where(and(inArray(routineRuns.routineId, list.map((r) => r.id))))
          .orderBy(desc(routineRuns.startedAt))
          .limit(200)
      : [];
    return { list, runs };
  });
  if (!list.length) return <p className="muted">Nothing scheduled yet.</p>;

  return (
    <section className="column">
      {list.map((r) => {
        const mine = runs.filter((x) => x.routineId === r.id);
        const last = mine[0];
        return (
          <article key={r.id} className="card">
            <header className="card-head">
              <strong className="truncate">{r.title}</strong>
              <span className="muted small nowrap">{describeSchedule(r.schedule)}</span>
            </header>
            <p className="muted small">{r.instruction}</p>
            <p className="small">
              {r.enabled && r.nextRunAt ? `Next: ${formatShort(r.nextRunAt, org.timezone)}` : r.schedule.kind === "once" && r.lastRunAt ? "Done" : "Paused"}
              {last && <span className="muted"> · last ran {formatShort(last.startedAt, org.timezone)}</span>}
            </p>
            {last && (
              <details>
                <summary className="small link">{last.status === "running" ? "Running…" : last.status === "error" ? "Last run failed" : "Latest result"}</summary>
                <p className={`prose small${last.status === "error" ? " error" : ""}`}>{last.status === "error" ? last.error : last.output}</p>
              </details>
            )}
            <div className="row">
              <form action={runRoutineNow} className="actions">
                <input type="hidden" name="id" value={r.id} />
                <button className="chip-button">Run now</button>
              </form>
              {(r.schedule.kind !== "once" || r.nextRunAt) && (
                <form action={toggleRoutine} className="actions">
                  <input type="hidden" name="id" value={r.id} />
                  <button className="chip-button">{r.enabled ? "Pause" : "Resume"}</button>
                </form>
              )}
              <form action={deleteRoutine} className="actions">
                <input type="hidden" name="id" value={r.id} />
                <button className="chip-button danger">Delete</button>
              </form>
            </div>
          </article>
        );
      })}
    </section>
  );
}
