"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { orgs, routines, type Schedule } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { runRoutine } from "@/routines/run";
import { nextRun, scheduleSchema } from "@/routines/schedule";

export interface RoutineState {
  error?: string;
  ok?: boolean;
}

async function mine(id: string) {
  const viewer = await getViewer();
  const [routine] = await getDb().select().from(routines).where(and(eq(routines.id, id), eq(routines.ownerPersonId, viewer.personId)));
  if (!routine) throw new Error("Not found");
  const [org] = await getDb().select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  return { routine, timeZone: org.timezone };
}

export async function createRoutine(_prev: RoutineState, formData: FormData): Promise<RoutineState> {
  const title = String(formData.get("title") ?? "").trim();
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (!title || !instruction) return { error: "Give it a name and say what to do." };
  const kind = String(formData.get("kind") ?? "");
  const time = String(formData.get("time") ?? "");
  const parsed = scheduleSchema.safeParse(
    kind === "once" ? { kind, at: `${formData.get("date")}T${time}` } : kind === "weekly" ? { kind, weekday: Number(formData.get("weekday")), time } : { kind, time },
  );
  if (!parsed.success) return { error: "Pick when it should run." };
  const schedule: Schedule = parsed.data;
  const viewer = await getViewer();
  const db = getDb();
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const nextRunAt = nextRun(schedule, org.timezone, new Date());
  if (!nextRunAt) return { error: "That time has already passed." };
  await db.insert(routines).values({ orgId: viewer.orgId, ownerPersonId: viewer.personId, title, instruction, schedule, nextRunAt });
  refresh();
  return { ok: true };
}

export async function toggleRoutine(formData: FormData) {
  const { routine, timeZone } = await mine(String(formData.get("id") ?? ""));
  const enabled = !routine.enabled;
  await getDb()
    .update(routines)
    .set({ enabled, nextRunAt: enabled ? nextRun(routine.schedule, timeZone, new Date()) : null })
    .where(eq(routines.id, routine.id));
  refresh();
}

export async function deleteRoutine(formData: FormData) {
  const { routine } = await mine(String(formData.get("id") ?? ""));
  await getDb().delete(routines).where(eq(routines.id, routine.id));
  refresh();
}

/** Runs it once now, in the background; the result appears on this page when it's done. */
export async function runRoutineNow(formData: FormData) {
  const { routine } = await mine(String(formData.get("id") ?? ""));
  after(() => runRoutine(getDb(), routine, defaultModels()));
  refresh();
}
