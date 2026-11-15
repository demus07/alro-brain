"use server";

import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { teamAgents } from "@/db/schema";
import { getViewer } from "@/lib/viewer";
import { addDepartment } from "@/team/team";

const toolList = (raw: FormDataEntryValue | null) =>
  String(raw ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

export async function addPreset(formData: FormData) {
  const viewer = await getViewer();
  await addDepartment(getDb(), viewer, String(formData.get("department") ?? ""));
  refresh();
}

export async function addSpecialist(formData: FormData) {
  const viewer = await getViewer();
  const department = String(formData.get("department") ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const name = String(formData.get("name") ?? "").trim();
  const job = String(formData.get("job") ?? "").trim();
  if (!department || !name || !job) throw new Error("Department, name and job are needed");
  await getDb().insert(teamAgents).values({ orgId: viewer.orgId, department, name, job, tools: toolList(formData.get("tools")), createdBy: viewer.personId });
  refresh();
}

/**
 * Specialists run with the access of whoever asks them, so a job description is a set of
 * instructions to everyone's agent: only the member who added it can change it.
 */
const theirs = (id: FormDataEntryValue | null, viewer: { orgId: string; personId: string }) =>
  and(eq(teamAgents.id, String(id ?? "")), eq(teamAgents.orgId, viewer.orgId), eq(teamAgents.createdBy, viewer.personId));

export async function updateSpecialist(formData: FormData) {
  const viewer = await getViewer();
  await getDb()
    .update(teamAgents)
    .set({ name: String(formData.get("name") ?? "").trim(), job: String(formData.get("job") ?? "").trim(), tools: toolList(formData.get("tools")) })
    .where(theirs(formData.get("id"), viewer));
  refresh();
}

export async function toggleSpecialist(formData: FormData) {
  const viewer = await getViewer();
  await getDb()
    .update(teamAgents)
    .set({ enabled: sql`not ${teamAgents.enabled}` })
    .where(theirs(formData.get("id"), viewer));
  refresh();
}

export async function removeSpecialist(formData: FormData) {
  const viewer = await getViewer();
  await getDb().delete(teamAgents).where(theirs(formData.get("id"), viewer));
  refresh();
}
