"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { getViewer } from "@/lib/viewer";
import { runPipeline } from "@/pipeline/run";

/** Runs a processing pass now, in the background. */
export async function processNow() {
  const viewer = await getViewer();
  after(() => runPipeline(getDb(), viewer.orgId, defaultModels()).catch((e) => console.error("manual pipeline run failed", e)));
  refresh();
}
