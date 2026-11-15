import { generateText } from "ai";
import { officeText } from "@/ingest/office";
import type { Models } from "./models";

/** What can be read: photos (a weighment slip, a whiteboard, an invoice) and documents. */
export const READABLE = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;
const OFFICE = /officedocument|msword|ms-excel|ms-powerpoint/;
const MAX_BYTES = 15 * 1024 * 1024;

const INSTRUCTIONS = `You read a photo or document someone sent to their company assistant.
Write out every piece of text and every number exactly as shown (keep units, dates, vehicle numbers, invoice and lot numbers), as plain lines.
For forms, slips, receipts and invoices, give each field as "Field: value". For tables, one row per line.
Then one line starting "About:" saying what it is (e.g. "Weighment slip from Sai Weighbridge for truck MH12AB1234").
Never guess digits you can't read: write [unclear].`;

export type FileReader = (file: { data: Uint8Array; mediaType: string; name?: string }) => Promise<string>;

/**
 * Text and facts from a photo or document, so it can be saved, searched and turned into
 * tracker rows. Office files are unzipped directly; images and PDFs go to the answer model.
 */
export function fileReader(models: Models): FileReader {
  return async ({ data, mediaType, name }) => {
    if (data.byteLength > MAX_BYTES) throw new Error("That file is too big to read (15 MB at most).");
    if (OFFICE.test(mediaType) || /\.(docx|pptx|xlsx)$/i.test(name ?? "")) {
      const text = officeText(data, name ?? mediaType);
      if (text) return text;
    }
    if (!READABLE.test(mediaType)) throw new Error(`I can't read ${mediaType} files yet.`);
    const { text } = await generateText({
      model: models.answer,
      instructions: INSTRUCTIONS,
      messages: [{ role: "user", content: [{ type: "file", mediaType, data, filename: name }] }],
    });
    return text.trim();
  };
}
