import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { listProcedures } from "@/work/procedures";
import { removeProcedure, writeUp } from "./actions";

export const metadata: Metadata = { title: "Procedures · ALRO" };

export default function ProceduresPage() {
  return (
    <>
      <h1>Procedures</h1>
      <p className="muted">
        How work actually gets done here, written up from your conversations rather than from memory. Each is scored on how often it happens, how long it takes and how much judgment it needs: daily, long and rule-bound work is what to hand to ALRO first. The work that needs your judgment, keep.
      </p>
      <form action={writeUp}>
        <button>Write up procedures from the last 90 days</button>
      </form>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Procedures />
      </Suspense>
    </>
  );
}

const LEVEL: Record<string, string> = { low: "same rules every time", medium: "some judgment", high: "needs judgment" };

async function Procedures() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const list = await listProcedures(db, viewer);
  if (!list.length) return <p className="muted">Nothing written up yet. It takes a minute or two after you press the button; refresh this page.</p>;
  return (
    <section className="column">
      {list.map((p) => (
        <article key={p.id} className="card">
          <header className="card-head">
            <strong className="truncate">{p.title}</strong>
            <span className={`tag${p.automationScore >= 70 ? " ok" : ""}`} title="Often, long and rule-bound scores high">
              {p.automationScore >= 70 ? "hand this over" : p.automationScore >= 45 ? "maybe automate" : "keep"} · {p.automationScore}
            </span>
          </header>
          <p className="small">{p.summary}</p>
          <p className="muted small">
            {[p.frequency, p.minutes ? `~${p.minutes} min each` : null, LEVEL[p.judgment], p.owners ? `done by ${p.owners}` : null, `${p.messageIds.length} sources`, `updated ${formatShort(p.updatedAt, org.timezone)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <details>
            <summary className="small link">Steps</summary>
            <ol className="small prose">
              {p.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
          <div className="row">
            <Link className="chip-button" href={`/?ask=${encodeURIComponent(`Set up a scheduled task that does "${p.title}" for me, following the written-up procedure. Ask me what you need to know first.`)}`}>
              Hand it to ALRO
            </Link>
            <Link className="chip-button" href={`/?ask=${encodeURIComponent(`Show me the conversations behind the procedure "${p.title}" and where people do it differently`)}`}>
              Check the sources
            </Link>
            <form action={removeProcedure} className="actions">
              <input type="hidden" name="id" value={p.id} />
              <button className="chip-button danger">Remove</button>
            </form>
          </div>
        </article>
      ))}
    </section>
  );
}
