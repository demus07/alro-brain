import { count, eq, inArray, isNull } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { mergeEntity, markFactWrong, resolveDispute, verifyFact } from "@/app/graph/actions";
import { getDb, type Db } from "@/db/client";
import { edges, entities, messages, orgs, people, procedures, threads } from "@/db/schema";
import { withScope } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { factsToCheck, findDuplicates, openDisputes, type FactCard } from "@/memory/facts";

export const metadata: Metadata = { title: "Memory · ALRO" };

export default function MemoryPage() {
  return (
    <>
      <h1>Memory</h1>
      <p className="muted">
        What ALRO believes and how sure it is. When two people say different things, it keeps both until one is confirmed or you pick. Anything you settle here is what ALRO answers with from then on.
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Memory />
      </Suspense>
    </>
  );
}

async function Memory() {
  await connection();
  const viewer = await getViewer();
  const now = new Date();
  const data = await withScope(getDb(), viewer, async (scoped) => {
    const tx = scoped as unknown as Db;
    const [org] = await tx.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
    const disputes = await openDisputes(tx, now);
    const check = await factsToCheck(tx, now);
    const duplicates = await findDuplicates(tx, 12);
    const ids = [...new Set([...disputes.flat(), ...check].flatMap((f) => (f.messageId ? [f.messageId] : [])))];
    const evidence = ids.length
      ? await tx
          .select({ id: messages.id, text: messages.text, thread: threads.title, author: people.displayName })
          .from(messages)
          .innerJoin(threads, eq(threads.id, messages.threadId))
          .leftJoin(people, eq(people.id, messages.authorPersonId))
          .where(inArray(messages.id, ids))
      : [];
    const one = async (query: PromiseLike<{ n: number }[]>) => (await query)[0].n;
    const counts = {
      messages: await one(tx.select({ n: count() }).from(messages).where(isNull(messages.deletedAt))),
      meetings: await one(tx.select({ n: count() }).from(threads).where(eq(threads.kind, "meeting"))),
      facts: await one(tx.select({ n: count() }).from(edges).where(isNull(edges.expiredAt))),
      people: await one(tx.select({ n: count() }).from(entities).where(eq(entities.type, "person"))),
      companies: await one(tx.select({ n: count() }).from(entities).where(eq(entities.type, "company"))),
      procedures: await one(tx.select({ n: count() }).from(procedures)),
    };
    return { timeZone: org.timezone, disputes, check, duplicates, evidence: new Map(evidence.map((m) => [m.id, m])), counts };
  });
  const { counts } = data;

  /** Who said it, when, and the words it came from (when the viewer can open them). */
  const said = (f: FactCard) => {
    const m = f.messageId ? data.evidence.get(f.messageId) : undefined;
    return (
      <span className="muted small clamp">
        {[f.saidBy ?? m?.author ?? "Someone", f.validFrom ? formatShort(f.validFrom, data.timeZone) : null, m?.thread].filter(Boolean).join(" · ")}
        {m && (
          <>
            {" · "}
            <Link className="link" href={`/m/${m.id}#cited`}>
              “{m.text.length > 160 ? `${m.text.slice(0, 160)}…` : m.text}”
            </Link>
          </>
        )}
      </span>
    );
  };

  return (
    <>
      <div className="tiles">
        <div className="tile">
          <span className="tile-value">{counts.messages.toLocaleString("en")}</span>
          <span className="label">What happened</span>
          <span className="muted small">
            Messages, emails and {counts.meetings.toLocaleString("en")} meetings, kept word for word. Everything else points back to these.
          </span>
        </div>
        <div className="tile">
          <span className="tile-value">{counts.facts.toLocaleString("en")}</span>
          <span className="label">What is true</span>
          <span className="muted small">
            Facts about {counts.people.toLocaleString("en")} people and {counts.companies.toLocaleString("en")} companies, each with who said it and how sure it is. When one changes, the old one is kept as history.
          </span>
        </div>
        <div className="tile">
          <span className="tile-value">{counts.procedures.toLocaleString("en")}</span>
          <span className="label">How work is done</span>
          <span className="muted small">
            <Link className="link" href="/procedures">
              Procedures
            </Link>{" "}
            written up from how your team actually does recurring work.
          </span>
        </div>
      </div>

      <div className="split">
        <section className="column">
          <p className="label">Needs settling · {data.disputes.length}</p>
          {data.disputes.length === 0 && <p className="muted">Nothing in dispute.</p>}
          {data.disputes.map((sides) => (
            <article key={sides[0].id} className="card">
              <header className="card-head">
                <strong className="truncate">
                  {sides[0].source} · {sides[0].target}
                </strong>
                <span className="tag warn">not settled</span>
              </header>
              <ul className="sources">
                {sides.map((f) => (
                  <li key={f.id} className="source">
                    <span className="source-text">
                      <span>{f.fact}</span>
                      {said(f)}
                    </span>
                    <form action={resolveDispute.bind(null, f.id)} className="actions">
                      <button className="chip-button">This one is right</button>
                    </form>
                  </li>
                ))}
              </ul>
            </article>
          ))}

          <p className="label">Check these · {data.check.length}</p>
          {data.check.length === 0 && <p className="muted">Nothing shaky or old.</p>}
          {data.check.map((f) => (
            <article key={f.id} className="card">
              <span>{f.fact}</span>
              <div className="chips">
                {f.confidence === "uncertain" && <span className="tag warn">said as a guess or second-hand</span>}
                {f.mayBeOutdated && <span className="tag warn">not mentioned for a while</span>}
              </div>
              {said(f)}
              <div className="row">
                <form action={verifyFact.bind(null, f.id)} className="actions">
                  <button className="chip-button">Yes, that&apos;s right</button>
                </form>
                <form action={markFactWrong.bind(null, f.id)} className="actions">
                  <button className="chip-button danger">Wrong</button>
                </form>
              </div>
            </article>
          ))}
        </section>

        <section className="column">
          <p className="label">Possible duplicates · {data.duplicates.length}</p>
          {data.duplicates.length === 0 && <p className="muted small">No two entries look like the same thing.</p>}
          {data.duplicates.map((d) => (
            <article key={`${d.keep.id}${d.dupe.id}`} className="card">
              <header className="card-head">
                <strong className="truncate">
                  {d.dupe.name} = {d.keep.name}?
                </strong>
                <span className="tag">{d.reason}</span>
              </header>
              {[d.keep, d.dupe].map((e) => (
                <p key={e.id} className="muted small clamp">
                  {e.name} ({e.type}){e.summary ? `: ${e.summary}` : ""}
                </p>
              ))}
              <form action={mergeEntity.bind(null, d.dupe.id, d.keep.id)} className="actions">
                <button className="chip-button">Merge into {d.keep.name}</button>
              </form>
            </article>
          ))}
        </section>
      </div>
    </>
  );
}
