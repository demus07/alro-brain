"use server";

import { refresh } from "next/cache";
import { ApprovalError, decide, edit, markDone, retry, sendAgain } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";

export interface DecisionState {
  error?: string;
  note?: string;
}

/** Browsers send a textarea's line breaks as CRLF; the stored text uses LF. */
const textOf = (formData: FormData) => {
  const body = formData.get("body");
  return typeof body === "string" ? body.replace(/\r\n/g, "\n") : undefined;
};

/**
 * One waiting proposal's buttons: approve (with any edits, and run it now), save an edit, or
 * drop it. The form carries the revision that was on screen, so approving or saving over a
 * newer edit made in another tab or on another device is refused with a message.
 */
export async function decideWaiting(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const viewer = await getViewer();
  const id = String(formData.get("id") ?? "");
  const revision = Number(formData.get("revision"));
  const intent = String(formData.get("intent") ?? "approve");
  const body = textOf(formData);
  let state: DecisionState = {};
  try {
    if (intent === "reject") await decide(getDb(), viewer, id, "reject");
    else if (intent === "save") {
      if (body !== undefined) await edit(getDb(), viewer, id, body, revision);
      state = { note: "Saved. It still waits for your approval." };
    } else await decide(getDb(), viewer, id, "approve", { body, revision });
  } catch (e) {
    if (!(e instanceof ApprovalError)) throw e;
    state = { error: e.reason === "changed" ? "This changed since you opened it. The latest text is shown now: read it, then approve." : e.message };
  }
  refresh();
  return state;
}

/** A failed one goes back in the queue, e.g. after reconnecting the app. */
export async function tryAgain(formData: FormData) {
  const viewer = await getViewer();
  await retry(getDb(), viewer, String(formData.get("id") ?? ""));
  refresh();
}

/** The app never answered and the owner, having checked it, wants it sent once more. */
export async function sendAgainAnyway(formData: FormData) {
  const viewer = await getViewer();
  // Already settled in another tab: the refreshed page shows how.
  await sendAgain(getDb(), viewer, String(formData.get("id") ?? "")).catch(ignoreSettled);
  refresh();
}

/** The app never answered, but the owner checked and it did go through. */
export async function markAsDone(formData: FormData) {
  const viewer = await getViewer();
  await markDone(getDb(), viewer, String(formData.get("id") ?? "")).catch(ignoreSettled);
  refresh();
}

function ignoreSettled(e: unknown) {
  if (!(e instanceof ApprovalError)) throw e;
}
