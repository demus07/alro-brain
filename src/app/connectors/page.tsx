import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db/client";
import { chunks, connections, llmRuns, messages, orgs, people, syncRuns } from "@/db/schema";
import { withScope } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { sourceOf } from "@/lib/sources";
import { Ops } from "./ops";
import { Pipeline } from "./pipeline";

export const metadata: Metadata = { title: "Health · ALRO" };

/** A source counts as stale when it hasn't synced in this long. */
const STALE_MS = 24 * 60 * 60 * 1000;

export default function ConnectorsPage() {
  return (
    <>
      <h1>Health</h1>
      <p className="muted">
        Where ALRO&apos;s memory comes from, whether it&apos;s up to date, and what is failing behind the scenes. Connect sources in{" "}
        <Link className="link" href="/settings">Settings</Link> or <Link className="link" href="/upload">upload exports</Link>.
      </p>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Pipeline />
      </Suspense>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Ops />
      </Suspense>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Health />
      </Suspense>
    </>
  );
}

async function Health() {
  await connection();
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const when = (d: Date | null) => (d ? formatShort(d, org.timezone) : "never");

  // Connection details and runs are visible to the whole org (same_org policies).
  const { sources, runs, usage } = await withScope(db, viewer, async (tx) => ({
    sources: await tx
      .select({
        id: connections.id,
        provider: connections.provider,
        scope: connections.scope,
        account: connections.externalAccountId,
        status: connections.status,
        lastSyncedAt: connections.lastSyncedAt,
        lastError: connections.lastError,
        stale: sql<boolean>`coalesce(${connections.lastSyncedAt} < now() - make_interval(secs => ${STALE_MS / 1000}), true)`,
        owner: people.displayName,
      })
      .from(connections)
      .leftJoin(people, eq(people.id, connections.ownerPersonId))
      .orderBy(connections.provider),
    runs: await tx
      .selectDistinctOn([syncRuns.connectionId], {
        connectionId: syncRuns.connectionId,
        kind: syncRuns.kind,
        status: syncRuns.status,
        counts: syncRuns.counts,
        error: syncRuns.error,
        startedAt: syncRuns.startedAt,
      })
      .from(syncRuns)
      .orderBy(syncRuns.connectionId, desc(syncRuns.startedAt)),
    usage: await tx
      .select({
        stage: llmRuns.stage,
        model: llmRuns.model,
        calls: count(),
        input: sql<number>`sum(${llmRuns.inputTokens})::int`,
        output: sql<number>`sum(${llmRuns.outputTokens})::int`,
      })
      .from(llmRuns)
      .where(gt(llmRuns.createdAt, sql`now() - interval '7 days'`))
      .groupBy(llmRuns.stage, llmRuns.model)
      .orderBy(llmRuns.stage),
  }));

  // Backlog counts are org-wide numbers (no content), so they're read as the owner, filtered by org.
  const orgMessages = and(eq(messages.orgId, viewer.orgId), isNull(messages.deletedAt));
  const [backlog] = await db
    .select({
      total: count(),
      unscreened: sql<number>`count(*) filter (where ${messages.screenResult} is null)::int`,
      unextracted: sql<number>`count(*) filter (where ${messages.screenResult} = 'extract' and ${messages.extractedAt} is null)::int`,
    })
    .from(messages)
    .where(orgMessages);
  // In a WHERE clause the outer messages.id is table-qualified, so the subquery can't mistake it for chunks.id.
  const [{ unchunked }] = await db
    .select({ unchunked: count() })
    .from(messages)
    .where(and(orgMessages, sql`not exists (select 1 from ${chunks} c where ${messages.id} = any(c.message_ids))`));
  const perConnection = await db
    .select({ connectionId: messages.connectionId, n: count() })
    .from(messages)
    .where(orgMessages)
    .groupBy(messages.connectionId);
  const messageCount = new Map(perConnection.map((r) => [r.connectionId, r.n]));
  const lastRun = new Map(runs.map((r) => [r.connectionId, r]));

  return (
    <>
      <section>
        <h2 style={{ fontSize: 17, margin: "8px 0" }}>Sources</h2>
        {sources.length === 0 ? (
          <p className="muted">No sources yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Health</th>
                  <th>Last sync</th>
                  <th>Messages</th>
                  <th>Last run</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const run = lastRun.get(s.id);
                  const upload = s.provider.startsWith("upload:") || run?.kind === "upload";
                  // What's wrong and what to do about it, per connection.
                  const health =
                    s.status === "error"
                      ? { text: "Needs reconnecting", dot: "bad", cls: "error", hint: "Reconnect it in Settings → Sources." }
                      : run?.status === "error" || s.lastError
                        ? { text: "Last sync failed", dot: "bad", cls: "error", hint: upload ? undefined : "It is tried again every 15 minutes." }
                        : s.status === "revoked"
                          ? { text: "Disconnected", dot: "bad", cls: "error", hint: undefined }
                          : s.stale && !upload
                            ? { text: "Not synced in a day", dot: "stale", cls: "error", hint: undefined }
                            : { text: upload ? "Uploaded" : "Working", dot: upload ? "upload" : "ok", cls: "", hint: undefined };
                  return (
                    <tr key={s.id}>
                      <td>
                        <strong>{sourceOf(s.provider).label}</strong>
                        <div className="muted" style={{ fontSize: 13 }}>
                          {s.account ?? ""} · {s.scope === "personal" ? `personal (${s.owner ?? "?"})` : "whole org"}
                        </div>
                      </td>
                      <td className={health.cls}>
                        <span className={`dot ${health.dot}`} /> {health.text}
                        {(s.lastError || run?.error) && (
                          <div style={{ fontSize: 13 }}>{s.lastError ?? run?.error}</div>
                        )}
                        {health.hint && <div className="muted small">{health.hint}</div>}
                      </td>
                      <td>{when(s.lastSyncedAt)}</td>
                      <td>{messageCount.get(s.id) ?? 0}</td>
                      <td className="muted" style={{ fontSize: 13 }}>
                        {run ? `${run.kind}, ${when(run.startedAt)}: ${Object.entries(run.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 17, margin: "8px 0" }}>Processing</h2>
        <p>
          {backlog.total} messages · {unchunked} waiting to be searchable · {backlog.unscreened} waiting to be screened ·{" "}
          {backlog.unextracted} waiting for extraction
        </p>
        <p className="muted" style={{ fontSize: 13 }}>
          New messages are processed every 10 minutes, and right after an upload.
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 17, margin: "8px 0" }}>Model use, last 7 days</h2>
        {usage.length === 0 ? (
          <p className="muted">No model calls yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Input tokens</th>
                  <th>Output tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={`${u.stage}-${u.model}`}>
                    <td>{u.stage}</td>
                    <td>{u.model}</td>
                    <td>{u.calls}</td>
                    <td>{u.input.toLocaleString("en-US")}</td>
                    <td>{u.output.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
