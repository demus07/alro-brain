import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { teamAgents } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { canAdd, canChange } from "@/team/manage";
import { departmentLabel, departmentOf, DEPARTMENTS } from "@/team/presets";
import { addPreset } from "./actions";
import { EditSpecialist, NewSpecialist } from "./forms";
import { Workspace } from "./workspace";

export const metadata: Metadata = { title: "Team · ALRO" };

const ASK: Record<string, string> = {
  finance: "Ask the finance team for this week's cash report and the five biggest overdue payments",
  sales: "Ask the sales team to review the pipeline and draft follow-ups for anything waiting on us",
  operations: "Ask the operations team what slipped this week",
  marketing: "Ask the marketing team what customers complained about most this month",
  tech: "Ask the tech team what shipped and what's late",
};

export default function TeamPage() {
  return (
    <>
      <h1>Team</h1>
      <p className="muted">
        Departments of agents. Each lead plans the work and hands parts to its specialists, who work at the same time, each with only the tools its job needs. The lead checks their reports against each other and says so when a part is missing or two of them disagree. They work with the access of whoever asks, and anything they want to send waits in Approvals.
      </p>
      <div className="card-head">
        <p className="label truncate">What the team is doing</p>
        <Link className="link small" href="/team/runs">
          All runs →
        </Link>
      </div>
      <Suspense fallback={<p className="muted small">Loading…</p>}>
        <Workspace limit={3} />
      </Suspense>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Team />
      </Suspense>
    </>
  );
}

async function Team() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [rows, mayAdd] = await Promise.all([db.select().from(teamAgents).where(eq(teamAgents.orgId, viewer.orgId)).orderBy(asc(teamAgents.department), asc(teamAgents.createdAt)), canAdd(db, viewer)]);
  const departments = [...new Set(rows.map((r) => r.department))];
  const missing = DEPARTMENTS.filter((d) => !departments.includes(d.id));
  return (
    <div className="split">
      <section className="column">
        <p className="label">Departments</p>
        {departments.length === 0 && <p className="muted">{mayAdd ? "No agent team yet. Add a department to start." : "No agent team yet. An admin can add one."}</p>}
        {departments.map((d) => (
          <article key={d} className="card">
            <header className="card-head">
              <strong>{departmentLabel(d)}</strong>
              <span className="muted small">led by the {departmentOf(d)?.lead ?? `${departmentLabel(d)} lead`}</span>
            </header>
            {ASK[d] && (
              <Link className="link small" href={`/?ask=${encodeURIComponent(ASK[d])}`}>
                {ASK[d]} →
              </Link>
            )}
            <ul className="sources">
              {rows
                .filter((r) => r.department === d)
                .map((r) => (
                  <li key={r.id} className={r.enabled ? "" : "dim"}>
                    <details>
                      <summary className="source">
                        <span className="mark">{r.name.slice(0, 2)}</span>
                        <span className="source-text">
                          <span className="source-name">{r.name}</span>
                          <span className="muted small clamp">{r.job}</span>
                        </span>
                        {!r.enabled && <span className="tag">off</span>}
                      </summary>
                      {canChange(viewer, r) ? (
                        <EditSpecialist specialist={{ id: r.id, name: r.name, job: r.job, tools: r.tools, enabled: r.enabled }} />
                      ) : (
                        <p className="muted small connect-form">
                          Only an admin or whoever added it can change this specialist. Tools: {r.tools.length ? r.tools.join(", ") : "company memory only"}
                        </p>
                      )}
                    </details>
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </section>
      <section className="column">
        {!mayAdd && <p className="muted small">Specialists run with the access of whoever asks them, so only an admin can add departments or specialists.</p>}
        {mayAdd && missing.length > 0 && (
          <article className="card">
            <h2>Add a department</h2>
            <p className="muted small">Ready-made specialists you can edit afterwards.</p>
            <ul className="sources">
              {missing.map((d) => (
                <li key={d.id} className="source">
                  <span className="mark">{d.label.slice(0, 2)}</span>
                  <span className="source-text">
                    <span className="source-name">
                      {d.label} <span className="muted small">led by the {d.lead}</span>
                    </span>
                    <span className="muted small truncate">{d.specialists.map((s) => s.name).join(", ")}</span>
                  </span>
                  <form action={addPreset} className="actions">
                    <input type="hidden" name="department" value={d.id} />
                    <button className="chip-button">Add</button>
                  </form>
                </li>
              ))}
            </ul>
          </article>
        )}
        {mayAdd && <NewSpecialist departments={[...new Set([...departments, ...DEPARTMENTS.map((d) => d.id)])]} />}
      </section>
    </div>
  );
}
