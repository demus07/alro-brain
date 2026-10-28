import type { NormalizedBatch } from "../types";
import { emailsToBatch } from "./email";

/**
 * Splits an .mbox file (Gmail Takeout, Thunderbird, Apple Mail) into single
 * messages. Each message starts with a "From " line after a blank line; body
 * lines escaped as ">From " (mboxrd) lose one ">".
 */
export function splitMbox(source: string): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const messages: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("From ") && (i === 0 || lines[i - 1] === "")) {
      messages.push([]);
      continue;
    }
    if (!messages.length) continue;
    messages[messages.length - 1].push(/^>+From /.test(line) ? line.slice(1) : line);
  }
  return messages.map((m) => m.join("\n").replace(/\n+$/, "\n")).filter((m) => m.trim());
}

/** An mbox export of one mailbox, as one batch (same threading as .eml uploads). */
export function mboxToBatch(source: string, mailbox: string, fileName = "mailbox.mbox"): NormalizedBatch {
  const files = splitMbox(source).map((content, i) => ({ name: `${fileName}#${i + 1}`, content }));
  return emailsToBatch(files, mailbox);
}
