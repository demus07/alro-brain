"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { dismissInsight } from "@/insights/read";
import { getViewer } from "@/lib/viewer";

/** Hides an insight until it changes materially. Recorded in the audit log. */
export async function dismiss(formData: FormData) {
  const viewer = await getViewer();
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Bad request");
  await dismissInsight(getDb(), viewer, id);
  refresh();
}
