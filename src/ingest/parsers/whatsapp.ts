import { createHash } from "node:crypto";
import type { NormalizedBatch, NormalizedMessage, NormalizedPerson } from "../types";

export interface WhatsAppMessage {
  /** Wall-clock time as written in the export (the exporting phone's timezone). */
  local: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  author?: string;
  text: string;
  system: boolean;
  media: boolean;
  deleted: boolean;
  edited: boolean;
}

// Android: "05/09/2026, 21:14 - Name: text" (also "5/9/26, 9:14 pm - ...")
const ANDROID = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]\.?\s?m\.?))?\s+-\s+(.*)$/i;
// iOS: "[05/09/26, 9:14:03 PM] Name: text"
const IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]\.?\s?m\.?))?\]\s+(.*)$/i;

const MEDIA = /^(<Media omitted>|(image|video|audio|sticker|GIF|document|Contact card) omitted|<attached: .+>)$/i;
const DELETED = /^(This message was deleted|You deleted this message)\.?$/i;
const EDITED = /\s*<This message was edited>$/;
const INVISIBLE = /[‎‏‪-‮]/g;

/**
 * Parses a WhatsApp "Export chat" .txt (Android or iOS). Dates are read as
 * day/month unless a value proves otherwise (WhatsApp follows the phone's locale).
 */
export function parseWhatsApp(source: string, chatTitle?: string): WhatsAppMessage[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/^﻿/, "").split("\n");
  const raw: { d: string[]; rest: string; marked: boolean }[] = [];
  for (const line of lines) {
    const clean = line.replace(INVISIBLE, "");
    const m = clean.match(IOS) ?? clean.match(ANDROID);
    // iOS writes system notices as "<chat name>: \u200e<notice>"; the mark is what tells them apart
    // from a 1:1 chat, where the chat name is also the other person's name.
    const sep = line.indexOf(": ");
    if (m) raw.push({ d: m.slice(1, 8), rest: m[8], marked: sep > 0 && line[sep + 2] === "\u200e" });
    else if (raw.length) raw[raw.length - 1].rest += `\n${clean}`;
  }

  const monthFirst = raw.some((r) => Number(r.d[1]) > 12);
  return raw.map(({ d, rest, marked }) => {
    const [a, b, y, h, min, s, ampm] = d;
    let hour = Number(h);
    if (ampm) {
      const pm = ampm.toLowerCase().startsWith("p");
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const [month, day] = monthFirst ? [Number(a), Number(b)] : [Number(b), Number(a)];

    const sep = rest.indexOf(": ");
    let author: string | undefined = sep > 0 ? rest.slice(0, sep).trim() : undefined;
    let text = sep > 0 ? rest.slice(sep + 2) : rest;
    // System lines have no author (Android) or carry the chat name plus the mark (iOS).
    let system = !author || (!!chatTitle && author === chatTitle && marked);
    if (system) {
      author = undefined;
      text = rest.slice(sep > 0 && chatTitle && rest.startsWith(`${chatTitle}: `) ? chatTitle.length + 2 : 0);
    }
    if (/end-to-end encrypted/i.test(text)) system = true;

    const edited = EDITED.test(text);
    text = text.replace(EDITED, "").trim();
    return {
      local: { year, month, day, hour, minute: Number(min), second: Number(s ?? 0) },
      author,
      text,
      system,
      media: MEDIA.test(text),
      deleted: DELETED.test(text),
      edited,
    };
  });
}

/** "+05:30" → minutes. */
const offsetMinutes = (offset: string) => {
  const m = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) throw new Error(`Bad UTC offset ${offset}`);
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
};

export interface WhatsAppChatInput {
  /** Chat or group name. */
  title: string;
  content: string;
  /** Display name of whoever exported it, as it appears in the chat. */
  exportedBy: string;
  /** UTC offset of the exporting phone, e.g. "+05:30". */
  utcOffset: string;
}

/**
 * Each export becomes one members-only thread. Pass one call per exporting
 * phone (`account`). People are matched by name until phone numbers are known.
 */
export function whatsAppToBatch(chats: WhatsAppChatInput[], account: string): NormalizedBatch {
  const people = new Map<string, NormalizedPerson>();
  const keyFor = (name: string) => {
    const key = `whatsapp:${name.toLowerCase()}`;
    if (!people.has(key)) people.set(key, { key, provider: "whatsapp", externalId: name.toLowerCase(), displayName: name });
    return key;
  };

  const threads: NormalizedBatch["threads"] = [];
  const messages: NormalizedMessage[] = [];
  for (const chat of chats) {
    const parsed = parseWhatsApp(chat.content, chat.title);
    const threadId = `whatsapp:${chat.title}`;
    const members = new Set([keyFor(chat.exportedBy)]);
    const seen = new Map<string, number>();
    const offset = offsetMinutes(chat.utcOffset);

    for (const m of parsed) {
      if (m.system || !m.author) continue;
      const authorKey = keyFor(m.author);
      members.add(authorKey);
      const { year, month, day, hour, minute, second } = m.local;
      const sentAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000);
      // Exports have no message ids; derive a stable one so re-imports don't duplicate.
      const base = createHash("sha1").update(`${sentAt.toISOString()}|${m.author}|${m.text}`).digest("hex").slice(0, 16);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      messages.push({
        threadExternalId: threadId,
        externalId: `${threadId}:${base}:${n}`,
        kind: "chat",
        authorKey,
        sentAt,
        text: m.media ? "[media]" : m.text,
        attachments: m.media ? [{ name: m.text.replace(/^<attached:\s*|>$/g, "") }] : undefined,
        deleted: m.deleted,
        editedAt: m.edited ? sentAt : undefined,
        raw: { local: m.local },
      });
    }
    threads.push({ externalId: threadId, kind: "whatsapp", title: chat.title, visibility: "members", memberKeys: [...members] });
  }

  return {
    connection: {
      provider: "upload:whatsapp",
      scope: "personal",
      externalAccountId: account,
      ownerKey: chats[0] ? keyFor(chats[0].exportedBy) : undefined,
    },
    people: [...people.values()],
    threads,
    messages,
  };
}
