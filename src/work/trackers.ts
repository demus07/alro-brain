import { generateText, Output } from "ai";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { messages, trackerRows, trackers, type TrackerColumn } from "@/db/schema";
import type { Viewer } from "@/db/scope";
import { batches, render, visibleMessages } from "./messages";

type Tracker = typeof trackers.$inferSelect;

/** First scan reaches back this far. */
const FIRST_SCAN_DAYS = 30;
const MAX_MESSAGES = 400;
const BATCH_CHARS = 16_000;

export const TRACKER_PRESETS: { name: string; description: string; columns: TrackerColumn[] }[] = [
  {
    name: "Sales log",
    description: "Every sale or confirmed order mentioned: who bought what, how much, at what price.",
    columns: [
      { name: "Customer", type: "text" },
      { name: "Product", type: "text", description: "Product, grade or service" },
      { name: "Quantity", type: "number" },
      { name: "Unit", type: "text" },
      { name: "Price", type: "number", description: "Per unit" },
      { name: "Value", type: "number", description: "Total" },
    ],
  },
  {
    name: "Receivables",
    description: "Money customers owe us: invoices raised, promised payment dates, payments received.",
    columns: [
      { name: "Customer", type: "text" },
      { name: "Invoice", type: "text" },
      { name: "Amount", type: "number" },
      { name: "Due", type: "date" },
      { name: "Status", type: "text", description: "raised, promised, part paid, paid, disputed" },
    ],
  },
  {
    name: "Stock by grade",
    description: "Stock levels reported for each product or grade, with where it is.",
    columns: [
      { name: "Grade", type: "text" },
      { name: "Quantity", type: "number" },
      { name: "Unit", type: "text" },
      { name: "Location", type: "text" },
    ],
  },
  {
    name: "Truck turnaround",
    description: "Trucks arriving and leaving: which truck, where, when it came in and when it left, from messages or weighment slips.",
    columns: [
      { name: "Truck", type: "text", description: "Vehicle number" },
      { name: "Site", type: "text" },
      { name: "Arrived", type: "date", description: "Date and time, ISO" },
      { name: "Left", type: "date", description: "Date and time, ISO" },
      { name: "Net weight", type: "number", description: "From the weighment slip, in kg" },
    ],
  },
];

export const columnsSchema = z
  .array(z.object({ name: z.string().trim().min(1).max(60), type: z.enum(["text", "number", "date"]), description: z.string().trim().max(200).optional() }))
  .min(1)
  .max(12);

/** The row shape the model fills: one nullable field per column. */
function rowSchema(columns: TrackerColumn[]) {
  const values = Object.fromEntries(
    columns.map((c) => [c.name, (c.type === "number" ? z.number() : z.string()).nullable().describe([c.type === "date" ? "ISO date or date-time" : "", c.description ?? ""].filter(Boolean).join(". "))]),
  );
  return z.object({ rows: z.array(z.object({ line: z.number().int().describe("The line it came from"), values: z.object(values) })) });
}

export async function createTracker(db: Db, viewer: Viewer, input: { name: string; description: string; columns: TrackerColumn[] }) {
  const [row] = await db
    .insert(trackers)
    .values({ orgId: viewer.orgId, personId: viewer.personId, name: input.name.trim(), description: input.description.trim(), columns: columnsSchema.parse(input.columns) })
    .returning();
  return row;
}

/**
 * Reads messages its owner can see that arrived since the last scan and adds a row for
 * each one that matches. Each row keeps the message it came from.
 */
export async function scanTracker(db: Db, tracker: Tracker, models: Models, now = new Date()): Promise<number> {
  const viewer = { orgId: tracker.orgId, personId: tracker.personId };
  // The first scan reads the most recent month by when things were said; after that, whatever has
  // arrived since (by when ALRO stored it), so a backfill or a late sync is still read.
  const first = !tracker.scannedUntil;
  const lines = first
    ? await visibleMessages(db, viewer, { after: new Date(now.getTime() - FIRST_SCAN_DAYS * 86_400_000), limit: MAX_MESSAGES, newest: true })
    : await visibleMessages(db, viewer, { after: tracker.scannedUntil!, limit: MAX_MESSAGES, byArrival: true });
  const schema = rowSchema(tracker.columns);
  let added = 0;
  for (const batch of batches(lines, BATCH_CHARS)) {
    const { output, usage } = await generateText({
      model: models.extract,
      instructions: `You keep a running table called "${tracker.name}" from a company's messages. A row is: ${tracker.description}
Columns: ${tracker.columns.map((c) => `${c.name} (${c.type}${c.description ? `: ${c.description}` : ""})`).join("; ")}.
Add a row only for what a message actually states; leave a value null when it isn't said. Numbers without units or commas. One row per item; a message can give several rows or none. Most messages give none.`,
      output: Output.object({ schema }),
      prompt: render(batch),
    });
    await recordRun(db, { orgId: tracker.orgId, stage: "trackers", model: models.extract, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    const rows = output.rows.flatMap((r) => {
      const line = batch[r.line - 1];
      return line && Object.values(r.values).some((v) => v !== null && v !== "") ? [{ orgId: tracker.orgId, trackerId: tracker.id, personId: tracker.personId, values: r.values, messageId: line.id, at: line.at }] : [];
    });
    // The rows and how far the scan got are saved together, so a failure can't leave one without the other.
    added += await db.transaction(async (tx) => {
      // A scan that failed part-way (the first one starts over) reads some messages again: one that
      // already gave this tracker its rows is never given them twice.
      const seen = rows.length
        ? await tx.selectDistinct({ id: trackerRows.messageId }).from(trackerRows).where(and(eq(trackerRows.trackerId, tracker.id), inArray(trackerRows.messageId, [...new Set(rows.map((r) => r.messageId))])))
        : [];
      const fresh = rows.filter((r) => !seen.some((s) => s.id === r.messageId));
      if (fresh.length) await tx.insert(trackerRows).values(fresh);
      // Saved per batch after the first scan, so a failure part-way doesn't read the same messages twice.
      if (!first) await tx.update(trackers).set({ scannedUntil: batch.at(-1)!.stored, updatedAt: now }).where(eq(trackers.id, tracker.id));
      return fresh.length;
    });
  }
  if (first) {
    const newest = lines.reduce((max, l) => (l.stored > max ? l.stored : max), new Date(0));
    await db.update(trackers).set({ scannedUntil: lines.length ? newest : now, updatedAt: now }).where(eq(trackers.id, tracker.id));
  }
  return added;
}

/** Scans every tracker in the org; one failing tracker doesn't stop the rest. */
export async function scanTrackers(db: Db, orgId: string, models: Models, now = new Date()): Promise<number> {
  const all = await db.select().from(trackers).where(eq(trackers.orgId, orgId));
  let added = 0;
  for (const t of all) {
    try {
      added += await scanTracker(db, t, models, now);
    } catch (e) {
      console.error(`tracker ${t.id} scan failed`, e instanceof Error ? e.message : e);
    }
  }
  return added;
}

export const trackersOf = (db: Db, viewer: Viewer) =>
  db
    .select()
    .from(trackers)
    .where(and(eq(trackers.orgId, viewer.orgId), eq(trackers.personId, viewer.personId)))
    .orderBy(asc(trackers.name));

/** A tracker's rows, newest first, with the message each came from. */
export async function rowsOf(db: Db, viewer: Viewer, trackerId: string, opts: { since?: Date; limit?: number } = {}) {
  return db
    .select({ id: trackerRows.id, values: trackerRows.values, at: trackerRows.at, messageId: trackerRows.messageId, url: messages.url })
    .from(trackerRows)
    .leftJoin(messages, eq(messages.id, trackerRows.messageId))
    .where(and(eq(trackerRows.trackerId, trackerId), eq(trackerRows.personId, viewer.personId), opts.since ? gte(trackerRows.at, opts.since) : undefined))
    .orderBy(desc(trackerRows.at))
    .limit(opts.limit ?? 500);
}

/** Sum of each number column, for "how much this month" questions. */
export function totals(columns: TrackerColumn[], rows: { values: Record<string, string | number | null> }[]): Record<string, number> {
  return Object.fromEntries(columns.filter((c) => c.type === "number").map((c) => [c.name, rows.reduce((sum, r) => sum + (typeof r.values[c.name] === "number" ? (r.values[c.name] as number) : 0), 0)]));
}

/** As CSV, for spreadsheets. */
export function toCsv(columns: TrackerColumn[], rows: { values: Record<string, string | number | null>; at: Date }[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Values come from outside messages: never let one run as a spreadsheet formula.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [["Date", ...columns.map((c) => c.name)], ...rows.map((r) => [r.at.toISOString(), ...columns.map((c) => r.values[c.name])])].map((r) => r.map(cell).join(",")).join("\n");
}
