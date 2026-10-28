import type { NormalizedBatch } from "./types";
import { crmCsvToBatch } from "./parsers/crm-csv";
import { emailsToBatch } from "./parsers/email";
import { mboxToBatch } from "./parsers/mbox";
import { slackExportToBatch, unzipSlackExport } from "./parsers/slack-export";
import { transcriptsToBatch } from "./parsers/vtt";
import { whatsAppToBatch } from "./parsers/whatsapp";

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

/** WhatsApp names its export "WhatsApp Chat with <name>.txt"; iOS zips hold "_chat.txt" and the zip carries the name. */
const whatsAppTitle = (fileName: string) =>
  fileName.replace(/\.txt$/i, "").replace(/^WhatsApp Chat (with|-)\s*/i, "").trim() || fileName;

/**
 * Groups uploaded files by kind and parses each group into one batch. Throws
 * with a message fit for the uploader when a file can't be read.
 */
export function uploadToBatches(files: UploadedFile[], options: UploadOptions): NormalizedBatch[] {
  const groups = new Map<UploadKind, UploadedFile[]>();
  for (const f of files) {
    const kind = uploadKind(f.name);
    if (!kind) throw new Error(`${f.name}: unsupported file type. Upload .zip (Slack export), .txt (WhatsApp), .eml, .mbox, .vtt or .csv.`);
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
            group.map((f) => ({
              title: whatsAppTitle(f.name),
              content: decode(f.bytes),
              exportedBy: options.whatsAppName ?? options.uploader.displayName,
              utcOffset: options.utcOffset ?? "+00:00",
            })),
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
