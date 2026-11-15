import { count, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { trackerRows } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { TRACKER_PRESETS, trackersOf } from "@/work/trackers";
import { createFromPreset } from "./actions";
import { NewTracker } from "./new-tracker";

export const metadata: Metadata = { title: "Trackers · ALRO" };

export default function TrackersPage() {
  return (
    <>
      <h1>Trackers</h1>
      <p className="muted">
        Running tables ALRO keeps from your chats, email and the photos you send it: a sales log, what customers owe, stock by grade, how long each truck took. Every row links to the message it came from, and new messages are added as they arrive.
      </p>
      <div className="split">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Trackers />
        </Suspense>
        <section className="column">
          <article className="card">
            <h2>Start from a template</h2>
            <ul className="sources">
              {TRACKER_PRESETS.map((p) => (
                <li key={p.name} className="source">
                  <span className="mark">{p.name.slice(0, 2)}</span>
                  <span className="source-text">
                    <span className="source-name">{p.name}</span>
                    <span className="muted small clamp">{p.description}</span>
                  </span>
                  <form action={createFromPreset} className="actions">
                    <input type="hidden" name="preset" value={p.name} />
                    <button className="chip-button">Start</button>
                  </form>
                </li>
              ))}
            </ul>
          </article>
          <NewTracker />
        </section>
      </div>
    </>
  );
}

async function Trackers() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const list = await trackersOf(db, viewer);
  if (!list.length) return <p className="muted">No trackers yet.</p>;
  const counts = await db
    .select({ id: trackerRows.trackerId, n: count() })
    .from(trackerRows)
    .where(inArray(trackerRows.trackerId, list.map((t) => t.id)))
    .groupBy(trackerRows.trackerId);
  const rows = new Map(counts.map((c) => [c.id, c.n]));
  return (
    <section className="column">
      <ul className="sources">
        {list.map((t) => (
          <li key={t.id}>
            <Link href={`/trackers/${t.id}`} className="source">
              <span className="mark">{t.name.slice(0, 2)}</span>
              <span className="source-text">
                <span className="source-name">{t.name}</span>
                <span className="muted small truncate">
                  {(rows.get(t.id) ?? 0).toLocaleString("en-US")} rows · {t.columns.map((c) => c.name).join(", ")}
                </span>
              </span>
              {!t.scannedUntil && <span className="tag">filling…</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

