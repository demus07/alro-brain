import { after } from "next/server";
import { defaultModels } from "@/ai/models";
import { fileReader } from "@/ai/read-file";
import { getDb } from "@/db/client";
import { uploadToBatches, type UploadOptions } from "@/ingest/upload";
import { writeBatch, type WriteResult } from "@/ingest/writer";
import { getViewer } from "@/lib/viewer";
import { saveNote } from "@/memory/notes";
import { runPipeline } from "@/pipeline/run";

export const maxDuration = 300;

/**
 * Upload fallback for sources without a live connector: Slack export .zip,
 * WhatsApp .txt, .eml, .mbox, meeting .vtt and CRM .csv. Photos, PDFs and Office documents
 * (a weighment slip, an invoice, a price list) are read and saved to the uploader's notes. Multipart form fields:
 *   files          one or more files
 *   whatsAppName   (optional) the uploader's name inside WhatsApp exports
 *   utcOffset      (optional) the exporting phone's offset, e.g. +05:30
 *   crm, crmType, crmAccount   (required for .csv)
 */
export async function POST(request: Request) {
  const viewer = await getViewer();
  const form = await request.formData();
  const all = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!all.length) return Response.json({ error: "Choose at least one file." }, { status: 400 });
  const isDocument = (f: File) => /\.(jpe?g|png|webp|heic|pdf|docx|pptx|xlsx)$/i.test(f.name);
  const documents = all.filter(isDocument);
  const files = all.filter((f) => !isDocument(f));
  const db = getDb();
  const models = defaultModels();
  const read = fileReader(models);
  const results: (Partial<WriteResult> & { provider: string; file?: string; error?: string })[] = [];
  for (const f of documents) {
    try {
      const type = f.type || (f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
      const text = await read({ data: new Uint8Array(await f.arrayBuffer()), mediaType: type, name: f.name });
      await saveNote(db, viewer, `[${f.name}]\n${text}`, { title: f.name });
      results.push({ provider: "notes", file: f.name });
    } catch (e) {
      results.push({ provider: "notes", file: f.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!files.length) {
    after(() => runPipeline(db, viewer.orgId, models).catch((e) => console.error("pipeline after upload failed", e)));
    return Response.json({ results });
  }

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

  for (const batch of batches) {
    results.push({ provider: batch.connection.provider, ...(await writeBatch(db, viewer.orgId, batch, "upload", viewer.personId)) });
  }
  // Make the upload searchable now rather than at the next scheduled run.
  after(() => runPipeline(db, viewer.orgId, models).catch((e) => console.error("pipeline after upload failed", e)));
  return Response.json({ results });
}
