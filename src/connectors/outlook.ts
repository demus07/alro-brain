import { emailsToBatch } from "@/ingest/parsers/email";
import type { NormalizedBatch } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before its cursor, in case a message surfaced late. */
const OVERLAP_MS = 5 * 60_000;
const MAX_MESSAGES = 500;
const MAX_PAGES = 20;
/** Well-known folders whose mail is left out. */
const SKIP_FOLDERS = ["junkemail", "deleteditems"];

export interface OutlookCursor {
  /** receivedDateTime of the newest message read. */
  since?: string;
}

interface Listed {
  id: string;
  receivedDateTime: string;
  isDraft?: boolean;
  parentFolderId?: string;
}

const notFound = (e: unknown) => {
  if (e instanceof ProviderError && e.status === 404) return undefined;
  throw e;
};

/**
 * Mail received or sent since the last sync, or in the last 90 days on the first one, from every folder
 * except drafts, junk and deleted items. Each message is fetched as MIME and read by the same parser as .eml uploads.
 */
export async function fetchOutlook(api: Api, mailbox: string, cursor: OutlookCursor = {}, now = new Date()): Promise<{ batch: NormalizedBatch; cursor: OutlookCursor }> {
  const skip = new Set<string>();
  for (const name of SKIP_FOLDERS) {
    const folder = await api<{ id: string }>("GET", `me/mailFolders/${name}`, { query: { $select: "id" } }).catch(notFound);
    if (folder) skip.add(folder.id);
  }

  const from = new Date(cursor.since ? Date.parse(cursor.since) - OVERLAP_MS : now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const listed: Listed[] = [];
  let next: string | undefined = "me/messages";
  let query: Record<string, string | number> | undefined = {
    $select: "id,receivedDateTime,isDraft,parentFolderId",
    $filter: `receivedDateTime ge ${from}`,
    // A first read keeps the newest mail; later reads go oldest first, so a sync that hits the cap resumes where it stopped.
    $orderby: `receivedDateTime ${cursor.since ? "asc" : "desc"}`,
    $top: 100,
  };
  for (let page = 0; next && page < MAX_PAGES && listed.length < MAX_MESSAGES; page++) {
    const r: { value: Listed[]; "@odata.nextLink"?: string } = await api("GET", next, { query });
    listed.push(...r.value.filter((m) => !m.isDraft && !skip.has(m.parentFolderId ?? "")));
    // The next link already carries the query.
    next = r["@odata.nextLink"];
    query = undefined;
  }

  const files: { name: string; content: string }[] = [];
  let since = cursor.since;
  for (const m of listed.slice(0, MAX_MESSAGES)) {
    const content = await api<string>("GET", `me/messages/${encodeURIComponent(m.id)}/$value`, { headers: { accept: "*/*" }, as: "text" }).catch(notFound);
    if (content) files.push({ name: `${m.id}.eml`, content });
    if (!since || Date.parse(m.receivedDateTime) > Date.parse(since)) since = m.receivedDateTime;
  }
  return { batch: emailsToBatch(files, mailbox), cursor: { since } };
}

/** The person's Outlook mailbox (Microsoft 365). */
export const outlook: Provider = {
  id: "outlook",
  scope: "personal",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Mail.Read"], baseUrl: "https://graph.microsoft.com/v1.0/" },
  async identify(api) {
    const me = await api<{ mail?: string | null; userPrincipalName: string }>("GET", "me", { query: { $select: "mail,userPrincipalName" } }).catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Microsoft didn't allow access to this mailbox. Sign in again and allow ALRO to read your mail.");
      throw e;
    });
    const mailbox = (me.mail ?? me.userPrincipalName).toLowerCase();
    return { accountId: mailbox, label: mailbox };
  },
  async sync(api, cursor, ctx) {
    const { batch, cursor: next } = await fetchOutlook(api, ctx.accountId, cursor as OutlookCursor | undefined, ctx.now);
    return { ...batch, cursor: next as Record<string, unknown> };
  },
};
