import { eq } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { pendingFor } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { departmentLabel } from "@/team/presets";
import { recentRuns } from "@/team/runs";
import { RefreshWhileRunning } from "./live";

const STATE: Record<string, { dot: string; label: string }> = {
  running: { dot: "stale", label: "Working…" },
  ok: { dot: "ok", label: "Done" },
  over_budget: { dot: "stale", label: "Stopped early" },
  error: { dot: "bad", label: "Failed" },
  stuck: { dot: "bad", label: "Stopped unexpectedly" },
};

const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)}s`);

/** The viewer's own recent team runs: what was asked, how far each specialist got, what it cost and the answer. */
export async function Workspace({ limit }: { limit: number }) {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [[org], runs, pending] = await Promise.all([db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId)), recentRuns(db, viewer, limit), pendingFor(db, viewer)]);
  return (
    <section className="column">
      {runs.some((r) => r.status === "running" && !r.stuck) && <RefreshWhileRunning />}
      {runs.length === 0 && <p className="muted small">Nothing yet. Ask ALRO for a department&apos;s work (a cash report, what slipped this week) or give a scheduled task to a department, and it shows up here while it runs. Only you see your own runs.</p>}
      {runs.map((run, i) => {
        const state = STATE[run.stuck ? "stuck" : run.status] ?? STATE.error;
        const waiting = pending.filter((a) => new RegExp(`\\b${a.code}\\b`).test(run.answer ?? ""));
        return (
          <article key={run.id} className="card">
            <header className="card-head">
              <span className={`dot ${state.dot}`} />
              <strong className="truncate">
                {departmentLabel(run.department)} team · {state.label}
              </strong>
              <span className="muted small nowrap">{formatShort(run.startedAt, org.timezone)}</span>
            </header>
            <p className="muted small clamp">{run.task}</p>
            <div className="chips">
              <span className="chip">{(run.inputTokens + run.outputTokens).toLocaleString("en")} tokens</span>
              {run.finishedAt && <span className="chip">took {took(run.finishedAt.getTime() - run.startedAt.getTime())}</span>}
              {run.routineId && <span className="tag">scheduled task</span>}
            </div>
            {run.stuck ? <p className="error small">It stopped without finishing, most likely because the request that started it ended. What the specialists had reported by then is below.</p> : run.error && <p className={`small ${run.status === "error" ? "error" : "muted"}`}>{run.error}</p>}
            {waiting.length > 0 && (
              <Link className="link small" href="/approvals">
                Waiting for your OK: {waiting.map((a) => a.code).join(", ")} →
              </Link>
            )}
            {run.answer && (
              <details open={i === 0}>
                <summary className="small link">Answer</summary>
                <p className="prose small">{run.answer}</p>
              </details>
            )}
            {run.reports.length > 0 && (
              <ul className="sources">
                {run.reports.map((r, n) => (
                  <li key={n}>
                    <details>
                      <summary className="source">
                        <span className="mark">{r.specialist.slice(0, 2)}</span>
                        <span className="source-text">
                          <span className="source-name">{r.specialist}</span>
                          <span className="muted small truncate">{r.task}</span>
                        </span>
                        {r.tokens !== undefined && <span className="muted small nowrap">{r.tokens.toLocaleString("en")} tokens</span>}
                        {r.status === "failed" ? <span className="tag warn">didn&apos;t finish</span> : <span className="tag">reported</span>}
                      </summary>
                      <p className={`prose small connect-form${r.status === "failed" ? " error" : ""}`}>{r.report}</p>
                    </details>
                  </li>
                ))}
              </ul>
            )}
            {run.status === "running" && !run.stuck && run.reports.length === 0 && <p className="muted small">The lead is planning; specialists appear here as they report.</p>}
          </article>
        );
      })}
    </section>
  );
}
