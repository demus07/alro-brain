import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { askHref } from "@/insights/read";
import { loadSubject, type Subject } from "@/insights/profile";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { departmentLabel } from "@/team/presets";
import { NeedsAttention } from "../../overview/needs-attention";

export const metadata: Metadata = { title: "Profile · ALRO" };

/** A person or company: who they are, what is open with them and where they come up. The id is an entity's or a person's. */
export default function SubjectPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      {params.then(({ id }) => (
        <Profile id={id} />
      ))}
    </Suspense>
  );
}

async function Profile({ id }: { id: string }) {
  await connection();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const s = await loadSubject(db, viewer, id);
  // Not there, or nothing about them is visible to this person: the same answer either way.
  if (!s) notFound();
  const when = (d: Date) => formatShort(d, org.timezone);
  const first = s.name.split(/\s+/)[0];
  const who = [
    s.person?.isMember ? `On your team${s.person.department ? ` · ${departmentLabel(s.person.department)}` : ""}` : s.type === "person" ? "Outside the company" : s.type,
    s.person?.email,
  ].filter(Boolean);

  return (
    <div className="stack">
      <div>
        <Link className="link small" href="/overview">
          ← Overview
        </Link>
        <h1>{s.name}</h1>
        <p className="muted small">
          {who.join(" · ")}
          {s.company && (
            <>
              {" · works at "}
              <Link className="link" href={`/people/${s.company.id}`}>
                {s.company.name}
              </Link>
            </>
          )}
        </p>
        {s.summary && <p className="prose">{s.summary}</p>}
        {s.role && <p className="small">{s.role}</p>}
        {s.aliases.length > 0 && <p className="muted small">Also known as {s.aliases.join(", ")}</p>}
        <p className="chips">
          <Link className="chip-button" href={askHref(`Catch me up on ${s.name}: what's open, what changed and what to do next`)}>
            Catch me up on {first}
          </Link>
          <Link className="chip-button" href={askHref(`Draft a short check-in message to ${s.name}`)}>
            Draft a check-in
          </Link>
        </p>
      </div>

      {s.attention.length > 0 && (
        <>
          <p className="label">Needs attention</p>
          <NeedsAttention items={s.attention} />
        </>
      )}

      <div className="split">
        <section className="column">
          <p className="label">Open with {first}</p>
          <article className="card">
            <Promises title={`${s.name} owes`} list={s.theyOwe} who="to" when={when} />
            <Promises title={`Owed to ${s.name}`} list={s.owedToThem} who="by" when={when} />
            {s.theyOwe.length + s.owedToThem.length === 0 && <p className="muted small">Nothing open either way.</p>}
          </article>

          <p className="label">Recent conversations</p>
          {s.conversations.length === 0 ? (
            <p className="muted small">No conversations you can see mention {first}.</p>
          ) : (
            <ul className="timeline">
              {s.conversations.map((c) => (
                <li key={c.id}>
                  <span className="small">{c.kind.replace("_", " ")}</span>
                  <span className="truncate">{c.messageId ? <Link href={`/m/${c.messageId}`}>{c.title ?? "Untitled"}</Link> : (c.title ?? "Untitled")}</span>
                  <span className="muted small mono nowrap">{when(c.lastAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="label">Meetings</p>
          <article className="card">
            {s.nextMeeting ? (
              <p className="small">
                Next: <strong>{s.nextMeeting.title}</strong> <span className="muted mono">{when(s.nextMeeting.startsAt)}</span>
              </p>
            ) : (
              <p className="muted small">Nothing coming up on your calendar with {first}.</p>
            )}
            {s.lastMeeting && (
              <p className="small">
                Last: <strong>{s.lastMeeting.title}</strong> <span className="muted mono">{when(s.lastMeeting.startsAt)}</span>
              </p>
            )}
            {!s.nextMeeting && !s.lastMeeting && (
              <p className="muted small">
                Meetings come from your own calendar.{" "}
                <Link className="link" href="/settings">
                  Connect Google or Microsoft
                </Link>{" "}
                to see them here.
              </p>
            )}
          </article>
        </section>

        <section className="column">
          {s.staff.length > 0 && (
            <>
              <p className="label">People there</p>
              <p className="chips">
                {s.staff.map((p) => (
                  <Link key={p.id} className="chip-button" href={`/people/${p.id}`}>
                    {p.name}
                  </Link>
                ))}
              </p>
            </>
          )}

          <p className="label">Connected to</p>
          {s.related.length === 0 ? (
            <p className="muted small">No connections known yet.</p>
          ) : (
            <ul className="sources">
              {s.related.map((r) => (
                <li key={r.id}>
                  <Link href={`/people/${r.id}`} className="source">
                    <span className="mark">{r.name.slice(0, 2)}</span>
                    <span className="source-text">
                      <span className="source-name">
                        {r.name} <span className="tag">{r.type}</span>
                      </span>
                      <span className="muted small clamp">{r.latest}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <p className="label">What ALRO believes now</p>
          <Facts facts={s.facts} when={when} />
        </section>
      </div>
    </div>
  );
}

function Promises({ title, list, who, when }: { title: string; list: Subject["theyOwe"]; who: "to" | "by"; when: (d: Date) => string }) {
  if (!list.length) return null;
  return (
    <>
      <strong className="small">
        {title} · {list.length}
      </strong>
      {list.map((p) => {
        const other = who === "to" ? p.to : p.owner;
        return (
          <div key={p.id} className="todo">
            <Link href={`/m/${p.messageId}`}>{p.title}</Link>
            <div className="muted small">
              {other ? `${who === "to" ? "To" : "By"} ${other} · ` : ""}
              <span className={p.status === "overdue" ? "error" : ""}>
                {p.status === "overdue" ? "Overdue" : p.status === "due_soon" ? "Due soon" : "Open"}
                {p.dueAt ? ` · ${when(p.dueAt)}` : p.dueText ? ` · ${p.dueText}` : ""}
              </span>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Facts({ facts, when }: { facts: Subject["facts"]; when: (d: Date) => string }) {
  if (!facts.length) return <p className="muted small">No facts yet. They build up as ALRO reads conversations that mention them.</p>;
  return (
    <article className="card">
      {facts.map((f) => (
        <div key={f.id} className="todo">
          <span>{f.messageId ? <Link href={`/m/${f.messageId}`}>{f.fact}</Link> : f.fact}</span>
          <span className="chips">
            {f.disputed && <span className="tag warn">sources disagree</span>}
            {f.verified && <span className="tag">checked by a person</span>}
            {f.stale && <span className="tag warn">may be out of date</span>}
            {f.confidence !== null && !f.verified && <span className="tag">{Math.round(f.confidence * 100)}% sure</span>}
            {f.validFrom && <span className="muted small mono">since {when(f.validFrom)}</span>}
          </span>
        </div>
      ))}
    </article>
  );
}
