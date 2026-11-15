import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before a chat's cursor, in case a message surfaced late. */
const OVERLAP_MS = 5 * 60_000;
/** 50 chats a page, 50 messages a page (Graph's maximums). */
const MAX_CHAT_PAGES = 10;
const MAX_MESSAGE_PAGES = 10;
/** Past this many messages the sync stops opening chats; the ones it didn't reach keep their cursor for the next sync. */
const MAX_MESSAGES = 2000;

export interface TeamsCursor {
  /** Newest lastModifiedDateTime seen, per chat. */
  latest?: Record<string, string>;
}

interface Member {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
}
interface Chat {
  id: string;
  topic?: string | null;
  chatType?: string;
  webUrl?: string | null;
  members?: Member[];
}
interface ChatMessage {
  id: string;
  messageType?: string;
  createdDateTime: string;
  lastModifiedDateTime?: string | null;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  from?: { user?: { id?: string | null; displayName?: string | null } | null } | null;
  body?: { contentType?: string; content?: string | null } | null;
  attachments?: { name?: string | null; contentType?: string | null; contentUrl?: string | null }[] | null;
}
interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A Teams message body as plain text: tags dropped, line breaks, emoji and @mentions kept, file and card placeholders removed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, "")
    .replace(/<emoji\b[^>]*\balt="([^"]*)"[^>]*>/gi, "$1")
    .replace(/\s*\n\s*/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pages<T>(api: Api, path: string, query: Record<string, string | number>, maxPages: number): Promise<T[]> {
  const all: T[] = [];
  let next: string | undefined = path;
  let q: Record<string, string | number> | undefined = query;
  for (let page = 0; next && page < maxPages; page++) {
    const r: Page<T> = await api("GET", next, { query: q });
    all.push(...r.value);
    // The next link already carries the query.
    next = r["@odata.nextLink"];
    q = undefined;
  }
  return all;
}

/**
 * The signed-in person's Teams chats (one-to-one, group and meeting chats): what changed in each since
 * the last sync, or in the last 90 days on the first one. One thread per chat, visible to its members.
 * Channel messages are not read: they need an admin to consent for the whole organisation.
 */
export async function fetchTeams(
  api: Api,
  self: string,
  cursor: TeamsCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: TeamsCursor }> {
  const chats = await pages<Chat>(api, "me/chats", { $expand: "members", $top: 50 }, MAX_CHAT_PAGES);
  const floor = now.getTime() - BACKFILL_DAYS * 86_400_000;
  const latest = { ...cursor.latest };
  const people = new Map<string, NormalizedPerson>();
  const personKey = (id: string, name?: string | null, email?: string | null) => {
    const key = `teams:${id}`;
    const known = people.get(key);
    if (!known || (!known.email && email)) people.set(key, { key, provider: "teams", externalId: id, displayName: name || known?.displayName || email || "Teams user", email: email?.toLowerCase() || undefined });
    return key;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  for (const chat of chats) {
    if (messages.length >= MAX_MESSAGES) break;
    const since = new Date(latest[chat.id] ? Date.parse(latest[chat.id]) - OVERLAP_MS : floor).toISOString();
    let found: ChatMessage[];
    try {
      found = await pages<ChatMessage>(
        api,
        `me/chats/${encodeURIComponent(chat.id)}/messages`,
        // Graph applies the filter only when the results are ordered by the same property.
        { $top: 50, $orderby: "lastModifiedDateTime desc", $filter: `lastModifiedDateTime gt ${since}` },
        MAX_MESSAGE_PAGES,
      );
    } catch (e) {
      // A chat can be listed but not readable (the person left it, or a meeting chat was closed); skip it.
      if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) continue;
      throw e;
    }
    for (const m of found) {
      const changed = m.lastModifiedDateTime ?? m.createdDateTime;
      if (!latest[chat.id] || Date.parse(changed) > Date.parse(latest[chat.id])) latest[chat.id] = changed;
    }

    const written = found
      .filter((m) => m.messageType === "message" && !m.deletedDateTime)
      .map((m) => ({ m, text: (m.body?.contentType === "html" ? htmlToText(m.body.content ?? "") : (m.body?.content ?? "")).trim() }))
      .filter((x) => x.text)
      .sort((a, b) => Date.parse(a.m.createdDateTime) - Date.parse(b.m.createdDateTime));
    if (!written.length) continue;

    const members = (chat.members ?? []).filter((m) => m.userId);
    const others = members.filter((m) => m.email?.toLowerCase() !== self).map((m) => m.displayName || m.email);
    threads.push({
      externalId: chat.id,
      kind: chat.chatType === "oneOnOne" ? "dm" : "group_dm",
      title: chat.topic || others.filter(Boolean).join(", ") || "Teams chat",
      url: chat.webUrl ?? undefined,
      visibility: "members",
      memberKeys: members.map((m) => personKey(m.userId!, m.displayName, m.email)),
      metadata: { chatType: chat.chatType },
    });
    for (const { m, text } of written) {
      const author = m.from?.user;
      const files = (m.attachments ?? []).filter((a) => a.contentType === "reference" && a.name).map((a) => ({ name: a.name!, url: a.contentUrl ?? undefined }));
      messages.push({
        threadExternalId: chat.id,
        externalId: `${chat.id}:${m.id}`,
        kind: "chat",
        authorKey: author?.id ? personKey(author.id, author.displayName) : undefined,
        sentAt: new Date(m.createdDateTime),
        text,
        attachments: files.length ? files : undefined,
        editedAt: m.lastEditedDateTime ? new Date(m.lastEditedDateTime) : undefined,
      });
    }
  }
  return { people: [...people.values()], threads, messages, cursor: { latest } };
}

/** The person's Microsoft Teams chats. */
export const teams: Provider = {
  id: "teams",
  scope: "personal",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Chat.Read"], baseUrl: "https://graph.microsoft.com/v1.0/" },
  async identify(api) {
    const me = await api<{ mail?: string | null; userPrincipalName: string }>("GET", "me", { query: { $select: "mail,userPrincipalName" } }).catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Microsoft didn't allow access to Teams. Sign in again and allow ALRO to read your chats.");
      throw e;
    });
    const account = (me.mail ?? me.userPrincipalName).toLowerCase();
    return { accountId: account, label: account };
  },
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchTeams(api, ctx.accountId, cursor as TeamsCursor | undefined, ctx.now);
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
