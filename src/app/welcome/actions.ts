"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { rememberNote } from "@/agent/profile";
import { getDb } from "@/db/client";
import { orgs } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";

/** Saves what the company (or this person) is trying to get done this quarter, as goals in their personal brain. */
export async function saveGoals(form: FormData) {
  const viewer = await getViewer();
  const goals = String(form.get("goals") ?? "")
    .split("\n")
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 8);
  for (const text of goals) await rememberNote(getDb(), viewer, { category: "goal", text: text.slice(0, 400), source: "manual" });
  refresh();
}

/** Marks a setup step as dealt with ("skip for now"), for the whole company. */
export async function skipStep(form: FormData) {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) return;
  const db = getDb();
  const step = String(form.get("step") ?? "");
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, viewer.orgId));
  const done = [...new Set([...(org.settings.onboarding?.done ?? []), step])];
  await db.update(orgs).set({ settings: { ...org.settings, onboarding: { ...org.settings.onboarding, done } } }).where(eq(orgs.id, viewer.orgId));
  refresh();
}

export async function finishSetup() {
  const viewer = await getViewer();
  if (isAdmin(viewer)) {
    const db = getDb();
    const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, viewer.orgId));
    await db.update(orgs).set({ settings: { ...org.settings, onboarding: { ...org.settings.onboarding, finishedAt: new Date().toISOString() } } }).where(eq(orgs.id, viewer.orgId));
  }
  redirect("/");
}
