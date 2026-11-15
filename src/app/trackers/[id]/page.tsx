import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { orgs, trackers } from "@/db/schema";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { rowsOf, totals } from "@/work/trackers";
import { deleteTracker, scanNow } from "../actions";

export const metadata: Metadata = { title: "Tracker · ALRO" };

export default function TrackerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Tracker params={params} />
    </Suspense>
  );
}

const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v === null || v === undefined ? "" : String(v));

async function Tracker({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const viewer = await getViewer();
  const db = getDb();
  const [t] = await db.select().from(trackers).where(and(eq(trackers.id, id), eq(trackers.personId, viewer.personId)));
  if (!t) notFound();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const rows = await rowsOf(db, viewer, t.id);
  const sums = totals(t.columns, rows);
  return (
    <>
      <p className="crumbs small">
        <Link href="/trackers">Trackers</Link> /
      </p>
      <h1>{t.name}</h1>
      <p className="muted">{t.description}</p>
      <div className="row">
        <form action={scanNow} className="actions">
          <input type="hidden" name="id" value={t.id} />
          <button className="chip-button">Read new messages now</button>
        </form>
        <a className="chip-button" href={`/api/trackers/${t.id}/csv`}>
          Download CSV
        </a>
        <Link className="chip-button" href={`/?ask=${encodeURIComponent(`Summarise the "${t.name}" tracker: totals, what changed this week, anything unusual`)}`}>
          Ask about it
        </Link>
        <form action={deleteTracker} className="actions">
          <input type="hidden" name="id" value={t.id} />
          <button className="chip-button danger">Delete</button>
        </form>
      </div>
      <p className="muted small">
        {rows.length.toLocaleString("en-US")} rows{t.scannedUntil ? ` · read up to ${formatShort(t.scannedUntil, org.timezone)}` : " · filling now, refresh in a minute"}
        {Object.entries(sums).map(([k, v]) => ` · total ${k}: ${fmt(v)}`)}
      </p>
      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                {t.columns.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap small">{formatShort(r.at, org.timezone)}</td>
                  {t.columns.map((c) => (
                    <td key={c.name} className={c.type === "number" ? "mono" : undefined}>
                      {fmt(r.values[c.name])}
                    </td>
                  ))}
                  <td className="small">
                    {r.url ? (
                      <a className="link" href={r.url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    ) : r.messageId ? (
                      <Link className="link" href={`/search?q=${encodeURIComponent(String(Object.values(r.values).find((v) => typeof v === "string") ?? ""))}`}>
                        find
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
