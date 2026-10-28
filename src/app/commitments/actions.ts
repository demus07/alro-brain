"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { recordVerdict, type Verdict } from "@/memory/verdicts";

const VERDICTS: Verdict[] = ["done", "not_a_promise", "reopen"];

export async function setVerdict(formData: FormData) {
  const viewer = await getViewer();
  const id = String(formData.get("id") ?? "");
  const verdict = String(formData.get("verdict") ?? "") as Verdict;
  if (!/^[0-9a-f-]{36}$/.test(id) || !VERDICTS.includes(verdict)) throw new Error("Bad request");
  await recordVerdict(getDb(), viewer, id, verdict);
  refresh();
}
