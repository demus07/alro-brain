import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { KIND_LABEL } from "@/insights/read";
import { companyState } from "@/insights/state";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { NeedsAttention } from "./needs-attention";

export const metadata: Metadata = { title: "Overview · ALRO" };

/** The state of the business, from what the signed-in person can see. */
export default function OverviewPage() {
  return (
    <>
      <h1>Overview</h1>
      <p className="muted">Where the company stands today, from everything you can see: what is promised, what is late, who is waiting on you and what changed this week.</p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Overview />
      </Suspense>
    </>
  );
}

async function Overview() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const state = await companyState(db, viewer, org.timezone);
  const when = (d: Date) => formatShort(d, org.timezone);
  const { tiles: t, week } = state;
  const tiles = [
    { label: "Open promises", value: t.open, tone: "", href: "/commitments" },
    { label: "Overdue", value: t.overdue, tone: t.overdue ? "bad" : "", href: "/commitments" },
    { label: "Waiting on us", value: t.waitingOnUs, tone: t.waitingOnUs ? "warn" : "", href: "#attention" },
    { label: "Clients at risk", value: t.atRisk, tone: t.atRisk ? "bad" : "", href: "#attention" },
    { label: "Waiting for your OK", value: t.approvals, tone: t.approvals ? "warn" : "", href: "/approvals" },
    { label: "Your meetings this week", value: t.meetings, tone: "", href: "/updates" },
  ];
  const noDepartment = state.members.filter((m) => !m.department);

  if (!state.connected) {
    return (
      <p className="muted">
        Nothing to show yet. Connect Slack, email or your CRM in{" "}
        <Link className="link" href="/settings">
          Settings
        </Link>
        , or{" "}
        <Link className="link" href="/settings#upload">
          upload an export
        </Link>
        , and this page fills in as ALRO reads it.
      </p>
    );
  }

  return (
    <>
      <div className="tiles">
        {tiles.map((x) => (
          <Link key={x.label} href={x.href} className={`tile ${x.tone}`}>
            <span className="tile-value">{x.value}</span>
            <span className="muted small">{x.label}</span>
          </Link>
        ))}
      </div>

      <div className="split">
        <section className="column" id="attention">
          <p className="label">Needs attention{state.attentionTotal > state.attention.length ? ` · ${state.attention.length} of ${state.attentionTotal}` : ""}</p>
          <NeedsAttention items={state.attention} empty="Nothing needs attention right now. ALRO checks for people waiting on a reply, clients going quiet, slipping promises and late payments." />

          <p className="label">Customers and deals</p>
          {state.customers.length === 0 ? (
            <p className="muted small">No companies or deals have come up in the last two months. They appear here once ALRO has read conversations or CRM records that mention them.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Last contact</th>
                  <th>Open</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {state.customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="link" href={`/people/${c.id}`}>
                        {c.name}
                      </Link>{" "}
                      <span className="tag">{c.type}</span>
                    </td>
                    <td className="small mono nowrap">{c.lastAt ? when(new Date(c.lastAt)) : ""}</td>
                    <td className="small">
                      {c.open}
                      {c.overdue > 0 && <span className="error"> · {c.overdue} overdue</span>}
                    </td>
                    <td>
                      <span className="chips">
                        {c.flags.length ? (
                          c.flags.map((k) => (
                            <span key={k} className="tag warn">
                              {KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k}
                            </span>
                          ))
                        ) : (
                          <span className="tag">{c.recent ? "active" : "quiet"}</span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="label">This week</p>
          <article className="card">
            <p className="small">
              {week.kept.length} promises kept, <span className={week.slipped.length ? "error" : ""}>{week.slipped.length} slipped</span>. {week.newFacts} new facts, {week.changedFacts} changed.
            </p>
            {week.decisions.length + week.changed.length + week.kept.length + week.slipped.length === 0 && <p className="muted small">Nothing was decided, changed, kept or missed in the last seven days.</p>}
            <ul className="timeline">
              {week.decisions.map((d) => (
                <li key={d.id}>
                  <span className="small">Decided</span>
                  <span>{d.messageId ? <Link href={`/m/${d.messageId}`}>{d.fact}</Link> : d.fact}</span>
                  <span className="muted small mono nowrap">{when(d.at)}</span>
                </li>
              ))}
              {week.changed.map((c) => (
                <li key={c.id}>
                  <span className="small">Changed</span>
                  <span>
                    {c.became ?? "No longer true"} <span className="muted small">(was: {c.was})</span>
                  </span>
                  <span className="muted small mono nowrap">{c.at ? when(c.at) : ""}</span>
                </li>
              ))}
              {week.slipped.slice(0, 5).map((p) => (
                <li key={`s${p.id}`}>
                  <span className="small error">Slipped</span>
                  <span className="truncate">
                    {p.title}
                    {p.owner && <span className="muted small"> · {p.owner}</span>}
                  </span>
                  <span className="muted small mono nowrap">{when(p.at)}</span>
                </li>
              ))}
              {week.kept.slice(0, 5).map((p) => (
                <li key={`k${p.id}`}>
                  <span className="small">Kept</span>
                  <span className="truncate">
                    {p.title}
                    {p.owner && <span className="muted small"> · {p.owner}</span>}
                  </span>
                  <span className="muted small mono nowrap">{when(p.at)}</span>
                </li>
              ))}
            </ul>
          </article>
        </section>

        <section className="column">
          <p className="label">Who is carrying what</p>
          {state.departments.map((d) => (
            <article key={d.slug} className="card">
              <header className="card-head">
                <strong className="truncate">
                  <Link className="link" href={`/departments/${d.slug}`}>
                    {d.label}
                  </Link>
                </strong>
                <span className="muted small">
                  {d.open} open{d.overdue > 0 && <span className="error"> · {d.overdue} overdue</span>}
                  {d.attention > 0 && ` · ${d.attention} to look at`}
                </span>
              </header>
              <Members members={state.members.filter((m) => m.department === d.slug)} />
              {d.members === 0 && <p className="muted small">Agents only: nobody is assigned to this department yet. An admin can put people in departments on the Admin page.</p>}
            </article>
          ))}
          {noDepartment.length > 0 && (
            <article className="card">
              {state.departments.length > 0 && <strong>No department</strong>}
              <Members members={noDepartment} />
            </article>
          )}

          <p className="label">Trackers</p>
          {state.trackers.length === 0 ? (
            <p className="muted small">
              No trackers yet.{" "}
              <Link className="link" href="/trackers">
                Start a sales log or a receivables list
              </Link>{" "}
              and its totals show here.
            </p>
          ) : (
            <ul className="sources">
              {state.trackers.map((x) => (
                <li key={x.id}>
                  <Link href={`/trackers/${x.id}`} className="source">
                    <span className="mark">{x.name.slice(0, 2)}</span>
                    <span className="source-text">
                      <span className="source-name">{x.name}</span>
                      <span className="muted small truncate">
                        {[`${x.rows.toLocaleString("en-US")} rows`, ...Object.entries(x.totals).map(([name, sum]) => `${name} ${sum.toLocaleString("en-US", { maximumFractionDigits: 0 })}`)].join(" · ")}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function Members({ members }: { members: { id: string; name: string; open: number; overdue: number }[] }) {
  if (!members.length) return null;
  return (
    <ul className="sources">
      {members.map((m) => (
        <li key={m.id}>
          <Link href={`/people/${m.id}`} className="source">
            <span className="mark">{m.name.slice(0, 2)}</span>
            <span className="source-text">
              <span className="source-name">{m.name}</span>
            </span>
            <span className="muted small nowrap">
              {m.open} open{m.overdue > 0 && <span className="error"> · {m.overdue} overdue</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
