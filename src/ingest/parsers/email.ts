import type { NormalizedBatch, NormalizedMessage, NormalizedPerson, NormalizedThread } from "../types";

interface ParsedEmail {
  headers: Map<string, string>;
  body: string;
}

/**
 * Minimal RFC 5322 / MIME parser for .eml files. Multipart messages yield
 * their text/plain part (or the text/html part with tags stripped);
 * attachments are skipped.
 */
export function parseEml(source: string): ParsedEmail {
  const { headers, body } = splitPart(source.replace(/\r\n/g, "\n"));
  for (const name of ["subject", "from", "to", "cc"]) {
    const value = headers.get(name);
    if (value) headers.set(name, decodeWords(value));
  }
  return { headers, body: bodyText(headers, body) ?? "" };
}

function splitPart(source: string): ParsedEmail {
  const split = source.indexOf("\n\n");
  const head = split === -1 ? source : source.slice(0, split);
  const body = split === -1 ? "" : source.slice(split + 2);
  const headers = new Map<string, string>();
  // Unfold continuation lines, then split "Name: value".
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { headers, body };
}

/** The readable text of a part, preferring text/plain over text/html in multipart/alternative. */
function bodyText(headers: Map<string, string>, body: string): string | undefined {
  const type = headers.get("content-type") ?? "text/plain";
  const mime = type.split(";")[0].trim().toLowerCase();
  if (/attachment/i.test(headers.get("content-disposition") ?? "")) return undefined;

  if (mime.startsWith("multipart/")) {
    const boundary = param(type, "boundary");
    if (!boundary) return undefined;
    const parts = body
      .split(new RegExp(`^--${escapeRegExp(boundary)}(?:--)?[ \\t]*$`, "m"))
      .slice(1, -1)
      .map((p) => splitPart(p.replace(/^\n/, "")));
    const texts = parts.map((p) => ({ mime: (p.headers.get("content-type") ?? "text/plain").toLowerCase(), text: bodyText(p.headers, p.body) }));
    const plain = texts.find((t) => t.text && !t.mime.startsWith("text/html"));
    return (plain ?? texts.find((t) => t.text))?.text;
  }
  if (!mime.startsWith("text/")) return undefined;

  const charset = (param(type, "charset") ?? "utf-8").toLowerCase();
  let text = decodeTransfer(body, headers.get("content-transfer-encoding"), charset);
  if (mime === "text/html") text = htmlToText(text);
  return text.trimEnd();
}

function decodeTransfer(body: string, encoding: string | undefined, charset: string): string {
  let bytes: Buffer;
  switch (encoding?.toLowerCase()) {
    case "base64":
      bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
      break;
    case "quoted-printable":
      bytes = Buffer.from(
        body.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
        "latin1",
      );
      break;
    default:
      return body;
  }
  return decodeCharset(bytes, charset);
}

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** RFC 2047 encoded words in headers: "=?UTF-8?B?...?=" and "=?utf-8?Q?...?=". */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, enc: string, data: string) => {
      const bytes =
        enc.toLowerCase() === "b"
          ? Buffer.from(data, "base64")
          : Buffer.from(
              data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h: string) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return decodeCharset(bytes, charset.toLowerCase());
    });
}

function htmlToText(html: string): string {
  return html
    .replace(/\s*\n\s*/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const param = (header: string, name: string) =>
  header.match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"))?.slice(1).find(Boolean);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Rohan Kulkarni <rohan@alro.ai>, ananya@alro.ai" → [{ name, email }] */
export function parseAddresses(value: string | undefined): { name?: string; email: string }[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => {
      const angle = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      if (angle) return { name: angle[1].trim() || undefined, email: angle[2].trim().toLowerCase() };
      return { email: part.trim().toLowerCase() };
    })
    .filter((a) => a.email.includes("@"));
}

/** Drops quoted history ("> ..." lines and the "On ... wrote:" line) so each email holds only its own words. */
export function stripQuotedReply(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) continue;
    if (/^On .+wrote:\s*$/.test(line) && lines.slice(i + 1).some((l) => /^\s*>/.test(l))) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const messageIds = (value: string | undefined) => value?.match(/<[^>]+>/g) ?? [];

/** Turns a mailbox's .eml files into one batch: one thread per conversation (by References / In-Reply-To). */
export function emailsToBatch(files: { name: string; content: string }[], mailbox: string): NormalizedBatch {
  const people = new Map<string, NormalizedPerson>();
  const personKey = (a: { name?: string; email: string }) => {
    const key = `email:${a.email}`;
    if (!people.has(key) || (a.name && !people.get(key)!.displayName.includes(" "))) {
      people.set(key, { key, provider: "email", externalId: a.email, displayName: a.name ?? a.email, email: a.email });
    }
    return key;
  };

  const parsed = files
    .map((f) => ({ file: f.name, ...parseEml(f.content) }))
    .sort((a, b) => Date.parse(a.headers.get("date") ?? "") - Date.parse(b.headers.get("date") ?? ""));

  // Thread root = first id in References, else In-Reply-To, else the message itself.
  const rootOf = new Map<string, string>();
  const threads = new Map<string, NormalizedThread>();
  const messages: NormalizedMessage[] = [];

  for (const email of parsed) {
    const id = messageIds(email.headers.get("message-id"))[0] ?? `<${email.file}>`;
    const parent = messageIds(email.headers.get("in-reply-to"))[0];
    const references = messageIds(email.headers.get("references"));
    const root = rootOf.get(references[0] ?? parent ?? "") ?? references[0] ?? parent ?? id;
    rootOf.set(id, root);

    const from = parseAddresses(email.headers.get("from"))[0];
    const to = [...parseAddresses(email.headers.get("to")), ...parseAddresses(email.headers.get("cc"))];
    const fromKey = from ? personKey(from) : undefined;
    const toKeys = to.map(personKey);
    const subject = email.headers.get("subject");

    const thread = threads.get(root) ?? {
      externalId: root,
      kind: "email" as const,
      title: subject?.replace(/^(re|fwd?):\s*/i, ""),
      visibility: "members" as const,
      memberKeys: [],
    };
    thread.memberKeys = [...new Set([...thread.memberKeys, ...(fromKey ? [fromKey] : []), ...toKeys])];
    threads.set(root, thread);

    messages.push({
      threadExternalId: root,
      externalId: id,
      kind: "email",
      authorKey: fromKey,
      recipientKeys: toKeys,
      sentAt: new Date(email.headers.get("date") ?? 0),
      subject,
      text: stripQuotedReply(email.body),
      replyToExternalId: parent,
      raw: { file: email.file, headers: Object.fromEntries(email.headers), body: email.body },
    });
  }

  return {
    connection: { provider: "upload:email", scope: "personal", externalAccountId: mailbox, ownerKey: `email:${mailbox}` },
    people: [...people.values()],
    threads: [...threads.values()],
    messages,
  };
}
