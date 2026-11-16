"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { audit } from "@/lib/audit";
import { getViewer } from "@/lib/viewer";
import { retryHandlers } from "@/ops/handlers";
import { runJob } from "@/ops/jobs";
import { processAndRepair } from "@/ops/repair";
import { dismissLetter, retryNow } from "@/ops/retry";
import { liveWebhookDeps } from "@/ops/webhooks";
import { requireAdmin } from "@/platform/roles";

/** Runs a processing pass now, in the background, recorded like the scheduled ones. */
export async function processNow() {
  const viewer = await getViewer();
  after(() => runJob(getDb(), { job: "process", orgId: viewer.orgId }, () => processAndRepair(getDb(), viewer.orgId, defaultModels())));
  refresh();
}

/** An admin retries something that failed, whether it's waiting for its next try or was given up on. */
export async function retryFailed(formData: FormData) {
  const viewer = await getViewer();
  requireAdmin(viewer);
  const db = getDb();
  const id = String(formData.get("id") ?? "");
  const { ok } = await retryNow(db, viewer.orgId, id, retryHandlers(db, defaultModels(), liveWebhookDeps()));
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "ops.retry", target: id, detail: { ok } });
  refresh();
}

/** An admin clears something that failed and no longer matters. */
export async function dismissFailed(formData: FormData) {
  const viewer = await getViewer();
  requireAdmin(viewer);
  const db = getDb();
  const id = String(formData.get("id") ?? "");
  await dismissLetter(db, viewer.orgId, id);
  await audit(db, { orgId: viewer.orgId, personId: viewer.personId, action: "ops.dismiss", target: id });
  refresh();
}
