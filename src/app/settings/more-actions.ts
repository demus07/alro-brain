"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { forgetNote, learnStyle, NOTE_CATEGORIES, rememberNote, type NoteCategory } from "@/agent/profile";
import { defaultModels } from "@/ai/models";
import { createLinkCode } from "@/channels/links";
import { getDb } from "@/db/client";
import { channelLinks } from "@/db/schema";
import { audit } from "@/lib/audit";
import { appOrigin } from "@/lib/origin";
import { getViewer } from "@/lib/viewer";
import { isAdmin } from "@/platform/roles";
import { addServer, refreshServer, listServers, removeServer, setToolEnabled } from "@/tools/mcp";

export interface FormState {
  error?: string;
  ok?: string;
}

const origin = appOrigin;

// ---- Live tools -------------------------------------------------------------

/** Adds a live-tool server. If it wants a sign-in, the member is sent there and comes back connected. */
export async function addLiveTools(_prev: FormState, formData: FormData): Promise<FormState> {
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return { error: "Paste the server's URL." };
  let signIn: string | undefined;
  try {
    const viewer = await getViewer();
    const scope = formData.get("scope") === "personal" ? "personal" : "org";
    // Tools the whole team's agent can call are an admin's decision.
    if (scope === "org" && !isAdmin(viewer)) return { error: "Only an admin can add a live-tool server for the whole team. Choose \"Only me\" to add it for yourself." };
    ({ signIn } = await addServer(getDb(), viewer, { name: String(formData.get("name") ?? ""), url, token: String(formData.get("token") ?? "").trim() || undefined, scope }, await origin()));
    await audit(getDb(), { orgId: viewer.orgId, personId: viewer.personId, action: "source.connect", target: `live tools at ${new URL(url).host}`, detail: { scope } });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't add that server." };
  }
  if (signIn) redirect(signIn);
  refresh();
  return { ok: "Added." };
}

export async function removeLiveTools(formData: FormData) {
  await removeServer(getDb(), await getViewer(), String(formData.get("id") ?? ""));
  refresh();
}

/** Re-reads what a server offers; sends the member to sign in again if it asks. */
export async function reloadLiveTools(formData: FormData) {
  const viewer = await getViewer();
  const server = (await listServers(getDb(), viewer)).find((s) => s.id === String(formData.get("id") ?? ""));
  if (!server) throw new Error("Not found");
  const { signIn } = await refreshServer(getDb(), server, await origin()).catch(() => ({ signIn: undefined }));
  if (signIn) redirect(signIn);
  refresh();
}

export async function toggleLiveTool(formData: FormData) {
  await setToolEnabled(getDb(), await getViewer(), String(formData.get("id") ?? ""), String(formData.get("tool") ?? ""), formData.get("enabled") === "true");
  refresh();
}

// ---- About you ----------------------------------------------------------------

export async function addProfileNote(_prev: FormState, formData: FormData): Promise<FormState> {
  const text = String(formData.get("text") ?? "").trim();
  const category = String(formData.get("category") ?? "") as NoteCategory;
  if (!text) return { error: "Write something first." };
  if (!NOTE_CATEGORIES.includes(category)) return { error: "Pick what kind of note this is." };
  await rememberNote(getDb(), await getViewer(), { category, text, source: "manual" });
  refresh();
  return { ok: "Saved." };
}

export async function deleteProfileNote(formData: FormData) {
  await forgetNote(getDb(), await getViewer(), String(formData.get("id") ?? ""));
  refresh();
}

export async function learnMyStyle(): Promise<FormState> {
  try {
    const learned = await learnStyle(getDb(), await getViewer(), defaultModels());
    if (!learned) return { error: "Not enough of your own messages yet. Connect a source where you write (Slack, email, WhatsApp)." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't do that just now." };
  }
  refresh();
  return { ok: "Updated." };
}

// ---- Messaging ----------------------------------------------------------------

/** A one-time code to send from WhatsApp, Telegram or Slack, proving that account is yours. */
export async function newLinkCode(): Promise<FormState> {
  return { ok: await createLinkCode(getDb(), await getViewer()) };
}

export async function unlinkChannel(formData: FormData) {
  const viewer = await getViewer();
  await getDb().delete(channelLinks).where(and(eq(channelLinks.id, String(formData.get("id") ?? "")), eq(channelLinks.personId, viewer.personId)));
  refresh();
}
