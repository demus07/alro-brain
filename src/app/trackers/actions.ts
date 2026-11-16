"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { trackers } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { assertWithin, LimitError } from "@/platform/usage";
import { createTracker, scanTracker, TRACKER_PRESETS } from "@/work/trackers";

export interface TrackerState {
  error?: string;
}

/** "Customer | text | who bought" per line. */
function parseColumns(raw: string) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, type, ...rest] = line.split("|").map((p) => p.trim());
      const t = (type ?? "text").toLowerCase();
      return { name, type: (t === "number" || t === "date" ? t : "text") as "text" | "number" | "date", description: rest.join(" | ") || undefined };
    });
}

async function startScan(id: string) {
  const [t] = await getDb().select().from(trackers).where(eq(trackers.id, id));
  if (t) after(() => scanTracker(getDb(), t, defaultModels()).catch((e) => console.error(`tracker ${id} scan failed`, e)));
}

export async function createFromPreset(formData: FormData) {
  const viewer = await getViewer();
  const preset = TRACKER_PRESETS.find((p) => p.name === formData.get("preset"));
  if (!preset) throw new Error("Unknown tracker");
  await assertWithin(getDb(), viewer.orgId, ["trackers"]);
  const t = await createTracker(getDb(), viewer, preset);
  await startScan(t.id);
  redirect(`/trackers/${t.id}`);
}

export async function createCustom(_prev: TrackerState, formData: FormData): Promise<TrackerState> {
  const viewer = await getViewer();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const columns = parseColumns(String(formData.get("columns") ?? ""));
  if (!name || !description) return { error: "Give it a name and say what counts as a row." };
  if (!columns.length || columns.some((c) => !c.name)) return { error: "List at least one column, one per line." };
  let id: string;
  try {
    await assertWithin(getDb(), viewer.orgId, ["trackers"]);
    id = (await createTracker(getDb(), viewer, { name, description, columns })).id;
  } catch (e) {
    if (e instanceof LimitError) return { error: e.message };
    return { error: "Check the columns: up to 12, each with a name." };
  }
  await startScan(id);
  redirect(`/trackers/${id}`);
}

export async function scanNow(formData: FormData) {
  const viewer = await getViewer();
  const id = String(formData.get("id") ?? "");
  const [t] = await getDb().select({ id: trackers.id }).from(trackers).where(and(eq(trackers.id, id), eq(trackers.personId, viewer.personId)));
  if (!t) throw new Error("Not found");
  await startScan(t.id);
  refresh();
}

export async function deleteTracker(formData: FormData) {
  const viewer = await getViewer();
  await getDb()
    .delete(trackers)
    .where(and(eq(trackers.id, String(formData.get("id") ?? "")), eq(trackers.personId, viewer.personId)));
  redirect("/trackers");
}
