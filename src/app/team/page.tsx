import { asc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { teamAgents } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { departmentLabel, departmentOf, DEPARTMENTS } from "@/team/presets";
import { addPreset, addSpecialist, removeSpecialist, toggleSpecialist, updateSpecialist } from "./actions";

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
        Departments of agents. Each lead plans the work and hands parts to its specialists, who work at the same time, each with only the tools its job needs. They work with the access of whoever asks, and anything they want to send waits in Approvals.
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Team />
      </Suspense>
    </>
  );
}

async function Team() {
  await connection();
  const viewer = await getViewer();
  const rows = await getDb().select().from(teamAgents).where(eq(teamAgents.orgId, viewer.orgId)).orderBy(asc(teamAgents.department), asc(teamAgents.createdAt));
  const departments = [...new Set(rows.map((r) => r.department))];
  const missing = DEPARTMENTS.filter((d) => !departments.includes(d.id));
  return (
    <div className="split">
      <section className="column">
        {departments.length === 0 && <p className="muted">No agent team yet. Add a department to start.</p>}
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
                      {r.createdBy !== viewer.personId ? (
                        <p className="muted small connect-form">
                          Added by someone else: only they can change it. Tools: {r.tools.length ? r.tools.join(", ") : "memory only"}
                        </p>
                      ) : (
                      <form action={updateSpecialist} className="connect-form">
                        <input type="hidden" name="id" value={r.id} />
                        <label className="small">
                          Name
                          <input name="name" defaultValue={r.name} required />
                        </label>
                        <label className="small">
                          Job
                          <textarea name="job" defaultValue={r.job} rows={5} required />
                        </label>
                        <label className="small">
                          Tools it may use (names or prefixes like stripe_; empty means company memory only)
                          <input name="tools" defaultValue={r.tools.join(", ")} className="mono" />
                        </label>
                        <div className="row">
                          <button>Save</button>
                          <button formAction={toggleSpecialist} className="ghost">
                            {r.enabled ? "Switch off" : "Switch on"}
                          </button>
                          <button formAction={removeSpecialist} className="ghost">
                            Remove
                          </button>
                        </div>
                      </form>
                      )}
                    </details>
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </section>
      <section className="column">
        {missing.length > 0 && (
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
        <form action={addSpecialist} className="card">
          <h2>New specialist</h2>
          <label className="small">
            Department
            <input name="department" list="departments" placeholder="finance" required />
            <datalist id="departments">
              {[...new Set([...departments, ...DEPARTMENTS.map((d) => d.id)])].map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label className="small">
            Name
            <input name="name" placeholder="Payment matcher" required />
          </label>
          <label className="small">
            Job
            <textarea name="job" rows={4} placeholder="Match each payment received this week to its invoice and list what doesn't match." required />
          </label>
          <label className="small">
            Tools (optional)
            <input name="tools" placeholder="xero_, searchMemory" className="mono" />
          </label>
          <button>Add specialist</button>
        </form>
      </section>
    </div>
  );
}
