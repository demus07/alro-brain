import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { withScope } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { recall, type SearchHit } from "@/memory/search";
import { orgs } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Search · ALRO" };

/** Sources, not an answer: every match grouped by conversation, plus the people, things and facts it touches. */
export default function SearchPage({ searchParams }: PageProps<"/search">) {
  return (
    <div className="search-page">
      <Suspense fallback={<p className="muted">Searching…</p>}>
        {searchParams.then(({ q }) => (
          <Search q={typeof q === "string" ? q.trim() : ""} />
        ))}
      </Suspense>
    </div>
  );
}

async function run(q: string) {
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const found = await withScope(db, viewer, (tx) => recall(tx as unknown as typeof db, defaultModels(), q, { limit: 20 }));
  return { ...found, timeZone: org.timezone };
}

const excerpt = (hit: SearchHit) => {
  // Lines start with their own timestamp; the hit already shows when it was.
  const body = hit.text.split("\n").slice(1).join("\n").replace(/^\[[^\]]+\]\s*/gm, "");
  return body.length > 320 ? `${body.slice(0, 320)}…` : body;
};

async function Search({ q }: { q: string }) {
  await connection();
  const form = (
    <form action="/search" className="search-form">
      <input name="q" type="search" defaultValue={q} placeholder="Search every conversation" aria-label="Search" autoFocus />
      <button>Search</button>
    </form>
  );
  if (!q) return form;

  const result = await run(q).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  if (result instanceof Error) {
    return (
      <>
        {form}
        <p className="error">Search failed: {result.message}. Is Ollama running (ollama serve)?</p>
      </>
    );
  }
  const { hits, related, graph, timeZone } = result;
  const groups = new Map<string, SearchHit[]>();
  for (const h of [...hits, ...related]) groups.set(h.threadId, [...(groups.get(h.threadId) ?? []), h]);
  const facts = graph.facts.filter((f) => f.current).slice(0, 6);

  return (
    <>
      {form}
      {groups.size === 0 && <p className="muted">Nothing found for “{q}”.</p>}
      {graph.entities.length > 0 && (
        <div className="chips">
          {graph.entities.map((e) => (
            <span key={e.id} className={`entity-pill t-${e.type}`} title={e.summary ?? undefined}>
              <i className="swatch" />
              {e.name}
            </span>
          ))}
        </div>
      )}
      {facts.length > 0 && (
        <section className="card">
          <p className="label">Known facts</p>
          <ul className="detail-list">
            {facts.map((f) => (
              <li key={f.id}>
                {f.messageId ? (
                  <Link className="small" href={`/m/${f.messageId}#cited`}>
                    {f.fact}
                  </Link>
                ) : (
                  <span className="small">{f.fact}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {[...groups.values()].map((list) => (
        <section key={list[0].threadId} className="card">
          <header className="card-head">
            <strong>{list[0].threadTitle ?? "Untitled"}</strong>
            <span className="tag">{list[0].threadKind}</span>
            <span className="muted small">
              {list.length} match{list.length === 1 ? "" : "es"}
            </span>
          </header>
          {list.map((h) => (
            <Link key={h.chunkId} className="search-hit" href={`/m/${h.messageIds[0]}#cited`}>
              <span className="muted small mono">{formatShort(h.startAt, timeZone)}</span>
              <span className="clamp small">{excerpt(h)}</span>
            </Link>
          ))}
        </section>
      ))}
    </>
  );
}
