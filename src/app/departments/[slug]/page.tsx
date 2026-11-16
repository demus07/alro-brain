import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { DEPARTMENT } from "@/db/scope";
import { askHref } from "@/insights/read";
import { departmentState } from "@/insights/state";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { describeSchedule } from "@/routines/schedule";
import { NeedsAttention } from "../../overview/needs-attention";

export const metadata: Metadata = { title: "Department · ALRO" };

/** Promises listed under each member before "and N more". */
const SHOWN = 5;
const RUN_STATUS: Record<string, string> = { running: "Running", ok: "Done", error: "Failed", over_budget: "Stopped: over budget" };

/** One department: its people and what they owe, what needs attention there, and its agents' work. */
export default function DepartmentPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      {params.then(({ slug }) => (
        <Department slug={slug} />
      ))}
    </Suspense>
  );
}

async function Department({ slug }: { slug: string }) {
  await connection();
  if (!DEPARTMENT.test(slug)) notFound();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const d = await departmentState(db, viewer, slug);
  if (!d) notFound();
  const when = (date: Date) => formatShort(date, org.timezone);

  return (
    <div className="stack">
      <div>
        <Link className="link small" href="/overview">
          ← Overview
        </Link>
        <h1>{d.label}</h1>
        <p className="muted small">
          {d.members.length} {d.members.length === 1 ? "person" : "people"} · {d.members.reduce((n, m) => n + m.open, 0)} open promises · {d.members.reduce((n, m) => n + m.overdue, 0)} overdue
        </p>
      </div>

      {d.attention.length > 0 && (
        <>
          <p className="label">Needs attention</p>
          <NeedsAttention items={d.attention} />
        </>
      )}

      <div className="split">
        <section className="column">
          <p className="label">People and what they owe</p>
          {d.members.length === 0 && <p className="muted small">Nobody is assigned to {d.label} yet. An admin can set each person&apos;s department in Settings.</p>}
          {d.members.map((m) => {
            const theirs = d.promises.filter((p) => p.ownerId === m.id).sort((a, b) => Number(b.status === "overdue") - Number(a.status === "overdue"));
            return (
              <article key={m.id} className="card">
                <header className="card-head">
                  <strong className="truncate">
                    <Link className="link" href={`/people/${m.id}`}>
                      {m.name}
                    </Link>
                  </strong>
                  <span className="muted small">
                    {m.open} open{m.overdue > 0 && <span className="error"> · {m.overdue} overdue</span>}
                  </span>
                </header>
                {theirs.length === 0 && <p className="muted small">Nothing open that you can see.</p>}
                {theirs.slice(0, SHOWN).map((p) => (
                  <div key={p.id} className="todo">
                    <span>{p.title}</span>
                    <span className="muted small">
                      {p.to ? `To ${p.to} · ` : ""}
                      <span className={p.status === "overdue" ? "error" : ""}>
                        {p.status === "overdue" ? "Overdue" : p.status === "due_soon" ? "Due soon" : "Open"}
                        {p.dueAt ? ` · ${when(p.dueAt)}` : p.dueText ? ` · ${p.dueText}` : ""}
                      </span>
                    </span>
                  </div>
                ))}
                {theirs.length > SHOWN && (
                  <Link className="link small" href={askHref(`List everything ${m.name} has promised that is still open`)}>
                    and {theirs.length - SHOWN} more →
                  </Link>
                )}
              </article>
            );
          })}

          <p className="label">Procedures done here</p>
          {d.procedures.length === 0 ? (
            <p className="muted small">
              None of your written-up procedures name this department or its people.{" "}
              <Link className="link" href="/procedures">
                Procedures
              </Link>
            </p>
          ) : (
            <ul className="sources">
              {d.procedures.map((p) => (
                <li key={p.id}>
                  <Link href="/procedures" className="source">
                    <span className="mark">{p.automationScore}</span>
                    <span className="source-text">
                      <span className="source-name">{p.title}</span>
                      <span className="muted small truncate">
                        {p.frequency}
                        {p.owners ? ` · ${p.owners}` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="column">
          <p className="label">Agents</p>
          {d.specialists.length === 0 ? (
            <p className="muted small">
              No agents for this department.{" "}
              <Link className="link" href="/team">
                Add them under Team
              </Link>
            </p>
          ) : (
            <ul className="sources">
              {d.specialists.map((a) => (
                <li key={a.id} className={`source${a.enabled ? "" : " dim"}`}>
                  <span className="mark">{a.name.slice(0, 2)}</span>
                  <span className="source-text">
                    <span className="source-name">
                      {a.name} {!a.enabled && <span className="tag">off</span>}
                    </span>
                    <span className="muted small clamp">{a.job}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="label">Your scheduled tasks for {d.label}</p>
          {d.tasks.length === 0 ? (
            <p className="muted small">
              None yet.{" "}
              <Link className="link" href="/routines">
                Schedule one
              </Link>{" "}
              and give it to this department.
            </p>
          ) : (
            <ul className="timeline">
              {d.tasks.map((t) => (
                <li key={t.id}>
                  <span className="small">{t.enabled ? describeSchedule(t.schedule) : "Off"}</span>
                  <span className="truncate">{t.title}</span>
                  <span className="muted small mono nowrap">{t.nextRunAt ? `next ${when(t.nextRunAt)}` : t.lastRunAt ? `ran ${when(t.lastRunAt)}` : ""}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="label">Recent work you asked this team for</p>
          {d.runs.length === 0 ? (
            <p className="muted small">Nothing yet. Ask the agent to hand something to the {d.label} team.</p>
          ) : (
            d.runs.map((r) => (
              <details key={r.id} className="card">
                <summary className="card-head">
                  <span className={`small${r.status === "error" ? " error" : ""}`}>{RUN_STATUS[r.status] ?? r.status}</span>
                  <span className="truncate">{r.task}</span>
                  <span className="muted small mono nowrap">{when(r.startedAt)}</span>
                </summary>
                <p className="prose small">{r.error ?? r.answer ?? "Still working."}</p>
              </details>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
