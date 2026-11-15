"use server";

import { refresh } from "next/cache";
import { decide, retry } from "@/approvals/approvals";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";

/** Approves (with any edits to the text) and runs it now. */
export async function approve(formData: FormData) {
  const viewer = await getViewer();
  const body = formData.get("body");
  await decide(getDb(), viewer, String(formData.get("id") ?? ""), "approve", { body: typeof body === "string" ? body : undefined });
  refresh();
}

export async function reject(formData: FormData) {
  const viewer = await getViewer();
  await decide(getDb(), viewer, String(formData.get("id") ?? ""), "reject");
  refresh();
}

/** A failed one goes back in the queue, e.g. after reconnecting the app. */
export async function tryAgain(formData: FormData) {
  const viewer = await getViewer();
  await retry(getDb(), viewer, String(formData.get("id") ?? ""));
  refresh();
}
