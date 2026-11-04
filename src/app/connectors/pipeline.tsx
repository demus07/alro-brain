import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/db/client";
import { chunks, connections, evalRuns, messages } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { processNow } from "./actions";

/** What's waiting to be processed, what failed, and the latest answer-quality score. */
export async function Pipeline() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const org = viewer.orgId;
  // Counts and error text only, read as the owner and filtered by org.
  const [m] = await db
    .select({
      unscreened: sql<number>`count(*) filter (where ${messages.screenResult} is null)::int`,
      toExtract: sql<number>`count(*) filter (where ${messages.screenResult} = 'extract' and ${messages.extractedAt} is null)::int`,
    })
    .from(messages)
    .where(and(eq(messages.orgId, org), isNull(messages.deletedAt)));
  const [c] = await db
    .select({ unembedded: sql<number>`count(*) filter (where ${chunks.embedding} is null)::int`, ungraphed: sql<number>`count(*) filter (where ${chunks.graphedAt} is null)::int` })
    .from(chunks)
    .where(eq(chunks.orgId, org));
  const unchunked = await db.$count(messages, and(eq(messages.orgId, org), isNull(messages.deletedAt), sql`not exists (select 1 from chunks c where ${messages.id} = any(c.message_ids))`));
  const failing = await db.select({ provider: connections.provider, error: connections.lastError }).from(connections).where(and(eq(connections.orgId, org), isNotNull(connections.lastError)));
  const [score] = await db.select().from(evalRuns).where(eq(evalRuns.orgId, org)).orderBy(desc(evalRuns.createdAt)).limit(1);

  const rows = [
    ["Not yet searchable", unchunked],
    ["Waiting for embeddings", c.unembedded],
    ["Not yet in the knowledge graph", c.ungraphed],
    ["Not yet screened for promises", m.unscreened],
    ["Waiting for promise extraction", m.toExtract],
  ] as const;
  const backlog = rows.reduce((n, [, v]) => n + v, 0);

  return (
    <section className="stack">
      <div className="section-head">
        <h2>Processing</h2>
        <form action={processNow} className="actions">
          <button className="chip-button">Process now</button>
        </form>
      </div>
      <p className="muted small">
        {backlog ? "Failed steps stay queued and are retried on the next run (every 10 minutes)." : "Everything ingested has been processed."}
      </p>
      <table>
        <tbody>
          {rows.map(([label, n]) => (
            <tr key={label}>
              <td>{label}</td>
              <td className={`mono small ${n ? "warn" : "muted"}`}>{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {failing.length > 0 && (
        <div className="card error-card">
          <strong>Sync problems</strong>
          {failing.map((f, i) => (
            <p key={i} className="small">
              <b>{f.provider}</b>: {f.error}
            </p>
          ))}
        </div>
      )}
      <h2>Answer quality</h2>
      {score ? (
        <p className="small">
          Last check: <b>{Math.round(score.score * 100)}%</b> of expected facts found, citations valid in {Math.round(score.citationRate * 100)}% of answers, ${(score.costUsd / Math.max(score.cases, 1)).toFixed(4)} per answer
          <span className="muted"> · {score.cases} questions · answer model {String((score.models as Record<string, string>).answer)} · {score.createdAt.toISOString().slice(0, 10)}</span>
        </p>
      ) : (
        <p className="muted small">No checks yet. Run npm run eval:answers.</p>
      )}
    </section>
  );
}
