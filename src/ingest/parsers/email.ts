import type { NormalizedBatch, NormalizedMessage, NormalizedPerson, NormalizedThread } from "../types";

interface ParsedEmail {
  headers: Map<string, string>;
  body: string;
}

/** Minimal RFC 5322 parser for single-part text emails (.eml). */
export function parseEml(source: string): ParsedEmail {
  const normalized = source.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const head = split === -1 ? normalized : normalized.slice(0, split);
  const body = split === -1 ? "" : normalized.slice(split + 2);

  const headers = new Map<string, string>();
  // Unfold continuation lines, then split "Name: value".
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }

  const encoding = headers.get("content-transfer-encoding")?.toLowerCase();
  let text = body;
  if (encoding === "base64") text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") {
    text = Buffer.from(
      body.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    ).toString("utf8");
  }
  return { headers, body: text };
}

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
