"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import * as team from "@/team/manage";

export interface TeamState {
  error?: string;
}

const toolList = (raw: FormDataEntryValue | null) =>
  String(raw ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "");

/** Runs a change to the team (who may make it is decided in @/team/manage) and hands a refusal back to the form as a message. */
async function change(fn: () => Promise<void>): Promise<TeamState> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof team.TeamError) return { error: e.message };
    throw e;
  }
  refresh();
  return {};
}

export async function addPreset(formData: FormData) {
  await team.addDepartment(getDb(), await getViewer(), field(formData, "department"));
  refresh();
}

export async function addSpecialist(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const viewer = await getViewer();
  return change(() => team.addSpecialist(getDb(), viewer, { department: field(formData, "department"), name: field(formData, "name"), job: field(formData, "job"), tools: toolList(formData.get("tools")) }));
}

export async function updateSpecialist(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const viewer = await getViewer();
  return change(() => team.updateSpecialist(getDb(), viewer, field(formData, "id"), { name: field(formData, "name"), job: field(formData, "job"), tools: toolList(formData.get("tools")) }));
}

export async function toggleSpecialist(formData: FormData) {
  await team.toggleSpecialist(getDb(), await getViewer(), field(formData, "id"));
  refresh();
}

export async function removeSpecialist(formData: FormData) {
  await team.removeSpecialist(getDb(), await getViewer(), field(formData, "id"));
  refresh();
}
