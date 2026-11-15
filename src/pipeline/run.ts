import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { pipelineLeases } from "@/db/schema";
import { chunkPending } from "@/memory/chunks";
import { extractPending, type ExtractStats } from "./extract";
import { graphPending, type GraphStats } from "./graph";
import { notePending } from "./meeting-notes";
import { scanTrackers } from "@/work/trackers";
import { screenPending } from "./screen";

/** Longer than any single run (cron routes allow 300s), so a live run never loses its lease. */
const LEASE_MS = 15 * 60 * 1000;

export interface PipelineResult {
  chunks: number;
  graph: GraphStats;
  screened: number;
  extraction: ExtractStats;
  /** Meetings that got their notes written. */
  notes: number;
  /** Rows added to trackers. */
  trackerRows: number;
}

/**
 * One processing pass for an org: make new messages searchable, add them to
 * the knowledge graph, screen them, extract commitments, updates and facts, write notes for new
 * meetings, then add rows to trackers. Safe to run repeatedly; each
 * stage only picks up what the previous runs haven't done.
 */
export async function runPipeline(db: Db, orgId: string, models: Models): Promise<PipelineResult | { skipped: "already running" }> {
  const holder = randomUUID();
  const expiresAt = new Date(Date.now() + LEASE_MS);
  // Take the lease if it's free or expired; otherwise another run is busy with this org.
  const [lease] = await db
    .insert(pipelineLeases)
    .values({ orgId, holder, expiresAt })
    .onConflictDoUpdate({ target: pipelineLeases.orgId, set: { holder, expiresAt }, setWhere: sql`${pipelineLeases.expiresAt} < now()` })
    .returning({ holder: pipelineLeases.holder });
  if (lease?.holder !== holder) return { skipped: "already running" };
  try {
    const chunks = await chunkPending(db, orgId, models);
    const graph = await graphPending(db, orgId, models);
    const screened = await screenPending(db, orgId, models);
    const extraction = await extractPending(db, orgId, models);
    const notes = await notePending(db, orgId, models);
    const trackerRows = await scanTrackers(db, orgId, models);
    return { chunks, graph, screened, extraction, notes, trackerRows };
  } finally {
    await db.delete(pipelineLeases).where(and(eq(pipelineLeases.orgId, orgId), eq(pipelineLeases.holder, holder)));
  }
}
