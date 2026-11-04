import { unzipSync } from "fflate";
import type { NormalizedBatch } from "./types";
import { crmCsvToBatch } from "./parsers/crm-csv";
import { emailsToBatch } from "./parsers/email";
import { mboxToBatch } from "./parsers/mbox";
import { slackExportToBatch, unzipSlackExport } from "./parsers/slack-export";
import { transcriptsToBatch } from "./parsers/vtt";
import { chatNameOf, parseWhatsApp, whatsAppToBatch } from "./parsers/whatsapp";

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

export interface UploadOptions {
  /** Signed-in uploader. Their mailbox owns .eml/.mbox uploads and their name marks their own WhatsApp messages. */
  uploader: { email: string; displayName: string };
  /** The name the uploader appears under in WhatsApp exports, if not their display name. */
  whatsAppName?: string;
  /** UTC offset of the phone that exported WhatsApp chats, e.g. "+05:30". */
  utcOffset?: string;
  /** Required for .csv: which CRM and which object type the export holds. */
  crm?: { crm: string; type: string; account: string };
}

export type UploadKind = "slack" | "whatsapp" | "email" | "mbox" | "meetings" | "crm";

export function uploadKind(name: string): UploadKind | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ({ zip: "slack", txt: "whatsapp", eml: "email", mbox: "mbox", vtt: "meetings", csv: "crm" } as const)[ext ?? ""];
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

/**
 * WhatsApp names its export "WhatsApp Chat with <name>.txt"; iOS zips hold "_chat.txt" and the
 * zip carries the name. A bare "_chat.txt" (or "_chat 2.txt") takes the name from its own notices.
 */
const whatsAppTitle = (fileName: string, content: string) =>
  (/^_chat( \d+)?\.txt$/i.test(fileName) ? chatNameOf(content) : undefined) ??
  (fileName.replace(/\.txt$/i, "").replace(/^WhatsApp Chat (with|-)\s*/i, "").trim() || fileName);

/**
 * iPhone exports a chat as "WhatsApp Chat - <name>.zip" holding "_chat.txt" (plus
 * media when included). Unwraps it to the .txt, named after the zip so the
 * chat keeps its title. Any other file passes through unchanged.
 */
export function unwrapWhatsAppZip(f: UploadedFile): UploadedFile {
  if (!f.name.toLowerCase().endsWith(".zip")) return f;
  const chat = unzipSync(f.bytes, { filter: (entry) => /(^|\/)_chat\.txt$/.test(entry.name) && !entry.name.startsWith("__MACOSX/") });
  const [bytes] = Object.values(chat);
  return bytes ? { name: f.name.replace(/\.zip$/i, ".txt"), bytes } : f;
}

/**
 * The uploader's name as it appears in the chat. People often type a short form
 * ("Sumedh" for "Sumedh Kudav"); when exactly one author's name starts with it, that's them.
 */
export function exporterName(content: string, given: string): string {
  const authors = new Set(parseWhatsApp(content).flatMap((m) => (m.author && !m.system ? [m.author] : [])));
  if (authors.has(given)) return given;
  const lower = given.trim().toLowerCase();
  const matches = [...authors].filter((a) => a.toLowerCase() === lower || a.toLowerCase().startsWith(`${lower} `));
  return matches.length === 1 ? matches[0] : given;
}

/**
 * Groups uploaded files by kind and parses each group into one batch. Throws
 * with a message fit for the uploader when a file can't be read.
 */
export function uploadToBatches(uploads: UploadedFile[], options: UploadOptions): NormalizedBatch[] {
  const files = uploads.map(unwrapWhatsAppZip);
  const groups = new Map<UploadKind, UploadedFile[]>();
  for (const f of files) {
    const kind = uploadKind(f.name);
    if (!kind) throw new Error(`${f.name}: unsupported file type. Upload .zip (Slack export or iPhone WhatsApp export), .txt (WhatsApp), .eml, .mbox, .vtt or .csv.`);
    groups.set(kind, [...(groups.get(kind) ?? []), f]);
  }

  const mailbox = options.uploader.email.toLowerCase();
  const batches: NormalizedBatch[] = [];
  for (const [kind, group] of groups) {
    switch (kind) {
      case "slack":
        for (const f of group) {
          const files = unzipSlackExport(f.bytes);
          if (!files.has("users.json")) throw new Error(`${f.name}: not a Slack export (no users.json)`);
          const users = JSON.parse(files.get("users.json")!) as { team_id?: string }[];
          const teamId = users.find((u) => u.team_id)?.team_id;
          batches.push(slackExportToBatch(files, { teamId: teamId ?? `upload:${f.name}` }));
        }
        break;
      case "whatsapp":
        batches.push(
          whatsAppToBatch(
            group.map((f) => {
              const content = decode(f.bytes);
              return {
                title: whatsAppTitle(f.name, content),
                content,
                exportedBy: exporterName(content, options.whatsAppName ?? options.uploader.displayName),
                utcOffset: options.utcOffset ?? "+00:00",
              };
            }),
            `whatsapp:${mailbox}`,
          ),
        );
        break;
      case "email":
        batches.push(emailsToBatch(group.map((f) => ({ name: f.name, content: decode(f.bytes) })), mailbox));
        break;
      case "mbox":
        for (const f of group) batches.push(mboxToBatch(decode(f.bytes), mailbox, f.name));
        break;
      case "meetings":
        batches.push(transcriptsToBatch(group.map((f) => ({ name: f.name, content: decode(f.bytes) })), `uploads:${mailbox}`));
        break;
      case "crm":
        if (!options.crm) throw new Error("CSV uploads need the CRM name and object type (deal, contact, account, ...).");
        for (const f of group) batches.push(crmCsvToBatch(decode(f.bytes), options.crm));
        break;
    }
  }
  return batches;
}
