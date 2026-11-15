import { ImapFlow, type MailboxLockObject } from "imapflow";
import { emailsToBatch } from "@/ingest/parsers/email";
import type { NormalizedBatch } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import type { Provider } from "./provider";
import { isPrivateHost, mustBePublic } from "@/lib/net";

const BACKFILL_DAYS = 90;
const MAX_MESSAGES = 500;
/** Only this much of each message is downloaded: the text parts come first, large attachments after. */
const MAX_SOURCE_BYTES = 2_000_000;

export interface ImapCursor {
  /** Per folder path: the folder's UIDVALIDITY and the highest UID read. A changed UIDVALIDITY means the UIDs were renumbered, so the folder is read afresh. */
  folders?: Record<string, { uidValidity: string; lastUid: number }>;
}

/** The little of IMAP the connector needs, over one read-only connection. */
export interface MailSession {
  folders(): Promise<{ path: string; specialUse?: string }[]>;
  /** Opens a folder read-only; searches and fetches then apply to it. */
  open(path: string): Promise<{ uidValidity: string }>;
  /** UIDs in the open folder above `afterUid`, or received since a date. */
  search(query: { afterUid: number } | { since: Date }): Promise<number[]>;
  /** Raw RFC 822 source of messages in the open folder. */
  fetch(uids: number[]): Promise<{ uid: number; source: string }[]>;
  close(): Promise<void>;
}

/** Signs in to the mailbox over TLS with imapflow. */
export async function openImap(c: Record<string, string>): Promise<MailSession> {
  if (mustBePublic() && isPrivateHost(c.host.trim())) throw new ProviderError("That mail server isn't a public address.", 400);
  const client = new ImapFlow({ host: c.host.trim(), port: Number(c.port) || 993, secure: true, auth: { user: c.email.trim(), pass: c.password }, logger: false, disableAutoIdle: true });
  // Without a listener a dropped connection is an unhandled 'error' event; the pending command rejects anyway.
  client.on("error", () => {});
  await client.connect();
  let lock: MailboxLockObject | undefined;
  return {
    folders: async () => (await client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse })),
    async open(path) {
      lock?.release();
      lock = await client.getMailboxLock(path, { readOnly: true });
      return { uidValidity: client.mailbox ? String(client.mailbox.uidValidity) : "" };
    },
    async search(query) {
      const found = await client.search("afterUid" in query ? { uid: `${query.afterUid + 1}:*` } : { since: query.since }, { uid: true });
      return found || [];
    },
    async fetch(uids) {
      const out: { uid: number; source: string }[] = [];
      // In batches, so the UID list stays well inside a server's command length limit.
      for (let i = 0; i < uids.length; i += 100) {
        for await (const m of client.fetch(uids.slice(i, i + 100), { uid: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true })) {
          if (m.source) out.push({ uid: m.uid, source: m.source.toString("utf8") });
        }
      }
      return out;
    },
    async close() {
      lock?.release();
      await client.logout().catch(() => client.close());
    },
  };
}

async function connect(open: (c: Record<string, string>) => Promise<MailSession>, c: Record<string, string>): Promise<MailSession> {
  if (!c.host?.trim() || !c.email?.trim() || !c.password) throw new Error("Enter the mail server, your email address and an app password.");
  try {
    return await open(c);
  } catch (e) {
    if ((e as { authenticationFailed?: boolean }).authenticationFailed) throw new ProviderError("The mail server didn't accept that email address and app password.", 401);
    const why = e instanceof Error ? e.message || (e as { code?: string }).code || e.name : String(e);
    throw new Error(`Couldn't connect to ${c.host.trim()}: ${why}`);
  }
}

/**
 * New mail in INBOX and the Sent folder since the last sync (by UID), or the last 90 days on the first one.
 * Each message is fetched raw and read by the same parser as .eml uploads.
 */
export async function fetchImap(session: MailSession, mailbox: string, cursor: ImapCursor = {}, now = new Date()): Promise<{ batch: NormalizedBatch; cursor: ImapCursor }> {
  const sent = (await session.folders()).find((f) => f.specialUse === "\\Sent")?.path;
  const paths = ["INBOX", ...(sent && sent.toUpperCase() !== "INBOX" ? [sent] : [])];
  const folders = { ...cursor.folders };
  const files: { name: string; content: string }[] = [];

  for (const [i, path] of paths.entries()) {
    const { uidValidity } = await session.open(path);
    const known = cursor.folders?.[path]?.uidValidity === uidValidity ? cursor.folders[path] : undefined;
    const found = (await session.search(known ? { afterUid: known.lastUid } : { since: new Date(now.getTime() - BACKFILL_DAYS * 86_400_000) }))
      // "n:*" always matches the newest message, even when it is not above n.
      .filter((uid) => uid > (known?.lastUid ?? 0))
      .sort((a, b) => a - b);
    // The folders share the cap. A first read keeps the newest mail; later reads take the oldest unread and resume from there.
    const budget = Math.ceil((MAX_MESSAGES - files.length) / (paths.length - i));
    const uids = known ? found.slice(0, budget) : found.slice(-budget);
    for (const m of await session.fetch(uids)) files.push({ name: `${path}/${m.uid}.eml`, content: m.source });
    const lastUid = uids.at(-1) ?? known?.lastUid;
    if (lastUid !== undefined) folders[path] = { uidValidity, lastUid };
    else delete folders[path];
  }

  const batch = emailsToBatch(files, mailbox);
  // A message to yourself is in both folders; keep one copy.
  const seen = new Set<string>();
  batch.messages = batch.messages.filter((m) => !seen.has(m.externalId) && seen.add(m.externalId));
  return { batch, cursor: { folders } };
}

/** Any mailbox reachable over IMAP with an app password. `open` is the IMAP connection, replaceable in tests. */
export function imapWith(open: (credentials: Record<string, string>) => Promise<MailSession>): Provider {
  return {
    id: "imap",
    scope: "personal",
    auth: {
      kind: "token",
      fields: [
        { name: "host", label: "Mail server", placeholder: "imap.gmail.com" },
        { name: "port", label: "Port", placeholder: "993", optional: true },
        { name: "email", label: "Email address", placeholder: "you@company.com" },
        { name: "password", label: "App password", secret: true },
      ],
      setup: "Create an app password in your mail account's security settings (your normal password usually won't work) and enter your provider's IMAP server. ALRO only reads your Inbox and Sent mail.",
      docsUrl: "https://support.google.com/accounts/answer/185833",
      api: (): Api => async () => {
        throw new Error("IMAP doesn't use HTTP");
      },
    },
    async identify(_api, credentials) {
      const session = await connect(open, credentials);
      await session.close();
      const mailbox = credentials.email.trim().toLowerCase();
      return { accountId: mailbox, label: mailbox };
    },
    async sync(_api, cursor, ctx) {
      const session = await connect(open, ctx.credentials);
      try {
        const { batch, cursor: next } = await fetchImap(session, ctx.accountId || ctx.credentials.email.trim().toLowerCase(), cursor as ImapCursor | undefined, ctx.now);
        return { ...batch, cursor: next as Record<string, unknown> };
      } finally {
        await session.close();
      }
    },
  };
}

export const imap = imapWith(openImap);
