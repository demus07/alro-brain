import { emailsToBatch } from "@/ingest/parsers/email";
import type { NormalizedBatch } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import { emailAction, rfc822 } from "./email-actions";
import { PushNotConfigured, type Provider } from "./provider";

const BACKFILL_DAYS = 90;
const MAX_MESSAGES = 500;
const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT"]);

export interface GmailCursor {
  /** Gmail's change counter: the next sync asks for everything after it. */
  historyId?: string;
}

interface HistoryChange {
  message: { id: string; labelIds?: string[] };
  labelIds?: string[];
}
interface History {
  messagesAdded?: HistoryChange[];
  labelsAdded?: HistoryChange[];
  labelsRemoved?: HistoryChange[];
}

const notFound = (e: unknown) => {
  if (e instanceof ProviderError && e.status === 404) return undefined;
  throw e;
};

/**
 * New mail since the last sync (Gmail history), or the last 90 days on the first one.
 * Each message is fetched raw and read by the same parser as .eml uploads.
 *
 * The same history says what was moved to the bin since: those come back as `deletedMessageIds`, and one
 * taken out of the bin again is fetched like new mail, which brings it back. Mail deleted for good without
 * passing through the bin between two syncs can't be matched (Gmail no longer gives its Message-ID) and stays.
 */
export async function fetchGmail(api: Api, cursor: GmailCursor = {}): Promise<{ batch: NormalizedBatch; cursor: GmailCursor; mailbox: string }> {
  const profile = await api<{ emailAddress: string; historyId: string }>("GET", "gmail/v1/users/me/profile");
  const mailbox = profile.emailAddress.toLowerCase();

  let ids: string[] | undefined;
  const binned = new Set<string>();
  if (cursor.historyId) {
    try {
      ids = [];
      let pageToken: string | undefined;
      do {
        const r = await api<{ history?: History[]; nextPageToken?: string }>("GET", "gmail/v1/users/me/history", {
          query: { startHistoryId: cursor.historyId, maxResults: 500, pageToken },
        });
        // In order, so binned-then-restored ends up restored.
        for (const h of r.history ?? []) {
          for (const a of h.messagesAdded ?? []) if (!a.message.labelIds?.some((l) => SKIP_LABELS.has(l))) ids.push(a.message.id);
          for (const a of h.labelsAdded ?? []) if (a.labelIds?.includes("TRASH")) binned.add(a.message.id);
          for (const a of h.labelsRemoved ?? []) {
            if (!a.labelIds?.includes("TRASH")) continue;
            binned.delete(a.message.id);
            if (!a.message.labelIds?.some((l) => SKIP_LABELS.has(l))) ids.push(a.message.id);
          }
        }
        pageToken = r.nextPageToken;
      } while (pageToken && ids.length < MAX_MESSAGES);
    } catch (e) {
      // History older than about a week is gone (404); fall back to a date search.
      notFound(e);
      ids = undefined;
      binned.clear();
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
  for (const id of [...new Set(ids)].filter((id) => !binned.has(id)).slice(0, MAX_MESSAGES)) {
    // Gone for good since it was listed: nothing to read.
    const m = await api<{ raw: string }>("GET", `gmail/v1/users/me/messages/${id}`, { query: { format: "raw" } }).catch(notFound);
    if (m) files.push({ name: `${id}.eml`, content: Buffer.from(m.raw, "base64url").toString("utf8") });
  }

  // Mail is stored under its Message-ID header (see the email parser), which a binned message still has.
  const deletedMessageIds: string[] = [];
  for (const id of binned) {
    const m = await api<{ payload?: { headers?: { name: string; value: string }[] } }>("GET", `gmail/v1/users/me/messages/${id}`, { query: { format: "metadata", metadataHeaders: "Message-ID" } }).catch(notFound);
    if (!m) continue;
    const header = m.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value;
    deletedMessageIds.push(header?.match(/<[^>]+>/)?.[0] ?? `<${id}.eml>`);
  }
  return { batch: { ...emailsToBatch(files, mailbox), deletedMessageIds }, cursor: { historyId: profile.historyId }, mailbox };
}

export const gmail: Provider = {
  id: "gmail",
  scope: "personal",
  // gmail.send only sends: it can't read, change or delete anything. ALRO sends only what the person approved.
  auth: { kind: "oauth", app: "google", scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"], baseUrl: "https://gmail.googleapis.com/" },
  async identify(api) {
    const profile = await api<{ emailAddress: string }>("GET", "gmail/v1/users/me/profile");
    return { accountId: profile.emailAddress.toLowerCase(), label: profile.emailAddress.toLowerCase() };
  },
  async sync(api, cursor) {
    const { batch, cursor: next } = await fetchGmail(api, cursor as GmailCursor | undefined);
    return { ...batch, cursor: next as Record<string, unknown> };
  },
  push: {
    // One Pub/Sub topic for the deployment (GMAIL_PUBSUB_TOPIC) carries every mailbox's changes to /api/hooks/gmail; a watch lasts seven days.
    async register(api) {
      const topicName = process.env.GMAIL_PUBSUB_TOPIC;
      if (!topicName) throw new PushNotConfigured("Set GMAIL_PUBSUB_TOPIC to a Google Pub/Sub topic that gmail-api-push@system.gserviceaccount.com may publish to.");
      const watch = await api<{ expiration: string }>("POST", "gmail/v1/users/me/watch", { body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" } });
      return { expiresAt: new Date(Number(watch.expiration)) };
    },
  },
  actions: {
    gmail_send_email: emailAction("Gmail", async (api, input) => {
      const sent = await api<{ id: string }>("POST", "gmail/v1/users/me/messages/send", { body: { raw: Buffer.from(rfc822(input)).toString("base64url") } });
      return { url: `https://mail.google.com/mail/#all/${sent.id}`, detail: "Sent from Gmail" };
    }),
  },
};
