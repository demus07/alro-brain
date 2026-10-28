import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { getDb } from "@/db/client";
import { uploadToBatches, type UploadOptions } from "@/ingest/upload";
import { writeBatch, type WriteResult } from "@/ingest/writer";
import { getViewer } from "@/lib/viewer";
import { runPipeline } from "@/pipeline/run";

export const maxDuration = 300;

/**
 * Upload fallback for sources without a live connector: Slack export .zip,
 * WhatsApp .txt, .eml, .mbox, meeting .vtt and CRM .csv. Multipart form fields:
 *   files          one or more files
 *   whatsAppName   (optional) the uploader's name inside WhatsApp exports
 *   utcOffset      (optional) the exporting phone's offset, e.g. +05:30
 *   crm, crmType, crmAccount   (required for .csv)
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  const form = await request.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return Response.json({ error: "Choose at least one file." }, { status: 400 });

  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const crm = field("crm");
  const crmType = field("crmType");
  const utcOffset = field("utcOffset");
  if (utcOffset && !/^[+-]\d{2}:?\d{2}$/.test(utcOffset)) {
    return Response.json({ error: "UTC offset must look like +05:30." }, { status: 400 });
  }
  const options: UploadOptions = {
    uploader: { email: viewer.email, displayName: viewer.displayName },
    whatsAppName: field("whatsAppName"),
    utcOffset,
    crm: crm && crmType ? { crm: crm.toLowerCase(), type: crmType.toLowerCase(), account: field("crmAccount") ?? crm.toLowerCase() } : undefined,
  };

  let batches;
  try {
    batches = uploadToBatches(
      await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))),
      options,
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const db = getDb();
  const results: (WriteResult & { provider: string })[] = [];
  for (const batch of batches) {
    results.push({ provider: batch.connection.provider, ...(await writeBatch(db, viewer.orgId, batch, "upload", viewer.personId)) });
  }
  // Make the upload searchable now rather than at the next scheduled run.
  after(() => runPipeline(db, viewer.orgId, defaultModels()).catch((e) => console.error("pipeline after upload failed", e)));
  return Response.json({ results });
}
