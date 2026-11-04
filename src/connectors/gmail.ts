import { emailsToBatch } from "@/ingest/parsers/email";
import type { NormalizedBatch } from "@/ingest/types";
import { ProviderError, type Api } from "./nango";

const BACKFILL_DAYS = 90;
const MAX_MESSAGES = 500;
const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);

export interface GmailCursor {
  /** Gmail's change counter: the next sync asks for everything after it. */
  historyId?: string;
}

/**
 * New mail since the last sync (Gmail history), or the last 90 days on the first one.
 * Each message is fetched raw and read by the same parser as .eml uploads.
 */
export async function fetchGmail(api: Api, cursor: GmailCursor = {}): Promise<{ batch: NormalizedBatch; cursor: GmailCursor; mailbox: string }> {
  const profile = await api<{ emailAddress: string; historyId: string }>("GET", "gmail/v1/users/me/profile");
  const mailbox = profile.emailAddress.toLowerCase();

  let ids: string[] | undefined;
  if (cursor.historyId) {
    try {
      ids = [];
      let pageToken: string | undefined;
      do {
        const r = await api<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; nextPageToken?: string }>("GET", "gmail/v1/users/me/history", {
          query: { startHistoryId: cursor.historyId, historyTypes: "messageAdded", maxResults: 500, pageToken },
        });
        for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) if (!a.message.labelIds?.some((l) => SKIP_LABELS.has(l))) ids.push(a.message.id);
        pageToken = r.nextPageToken;
      } while (pageToken && ids.length < MAX_MESSAGES);
    } catch (e) {
      // History older than about a week is gone (404); fall back to a date search.
      if (!(e instanceof ProviderError && e.status === 404)) throw e;
      ids = undefined;
    }
  }
  if (!ids) {
    ids = [];
    let pageToken: string | undefined;
    const days = cursor.historyId ? 8 : BACKFILL_DAYS;
    do {
      const r = await api<{ messages?: { id: string }[]; nextPageToken?: string }>("GET", "gmail/v1/users/me/messages", {
        query: { q: `newer_than:${days}d -in:spam -in:trash -in:drafts`, maxResults: 100, pageToken },
      });
      ids.push(...(r.messages ?? []).map((m) => m.id));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < MAX_MESSAGES);
  }

  const files: { name: string; content: string }[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_MESSAGES)) {
    const m = await api<{ raw: string }>("GET", `gmail/v1/users/me/messages/${id}`, { query: { format: "raw" } });
    files.push({ name: `${id}.eml`, content: Buffer.from(m.raw, "base64url").toString("utf8") });
  }
  return { batch: emailsToBatch(files, mailbox), cursor: { historyId: profile.historyId }, mailbox };
}
