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
/** Channels have their own budget, so a busy chat list can't starve them (or the other way round). */
const MAX_CHANNEL_MESSAGES = 2000;
/** 50 root posts a page, each with its replies. */
const MAX_CHANNEL_PAGES = 10;
const MAX_REPLY_PAGES = 5;
const MAX_TEAMS = 100;

export interface TeamsCursor {
  /** Newest lastModifiedDateTime seen, per chat. */
  latest?: Record<string, string>;
  /** Newest activity (a post or any reply to it) seen, per channel. */
  channels?: Record<string, string>;
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
interface ChannelPost extends ChatMessage {
  subject?: string | null;
  webUrl?: string | null;
  replies?: (ChatMessage & { webUrl?: string | null })[];
  "replies@odata.nextLink"?: string;
}
interface Team {
  id: string;
  displayName?: string | null;
}
interface Channel {
  id: string;
  displayName?: string | null;
  membershipType?: string | null;
  webUrl?: string | null;
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

const readable = (m: ChatMessage) => m.messageType === "message" && !m.deletedDateTime;
const plainText = (m: ChatMessage) => (m.body?.contentType === "html" ? htmlToText(m.body.content ?? "") : (m.body?.content ?? "")).trim();
const sharedFiles = (m: ChatMessage) => (m.attachments ?? []).filter((a) => a.contentType === "reference" && a.name).map((a) => ({ name: a.name!, url: a.contentUrl ?? undefined }));
const changedAt = (m: ChatMessage) => m.lastModifiedDateTime ?? m.createdDateTime;
const refused = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);

/**
 * The signed-in person's Teams chats (one-to-one, group and meeting chats) and the channels of the teams
 * they belong to: what changed in each since the last sync, or in the last 90 days on the first one.
 * One thread per chat or channel, visible to its members. Channels need permissions an admin consents to
 * for the whole organisation; a connection whose token lacks them (one made before they were added)
 * skips channels and still syncs chats.
 */
export async function fetchTeams(
  api: Api,
  self: string,
  cursor: TeamsCursor = {},
  now = new Date(),
  /** Which half to read: the two are separate sources because channels need an admin's consent. */
  read: { chats?: boolean; channels?: boolean } = {},
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: TeamsCursor }> {
  const chats = read.chats === false ? [] : await pages<Chat>(api, "me/chats", { $expand: "members", $top: 50 }, MAX_CHAT_PAGES);
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
      .filter(readable)
      .map((m) => ({ m, text: plainText(m) }))
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
      const files = sharedFiles(m);
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

  const channels = { ...cursor.channels };
  if (read.channels !== false) await fetchChannels(api, channels, floor, personKey, threads, messages);
  return { people: [...people.values()], threads, messages, cursor: Object.keys(channels).length ? { latest, channels } : { latest } };
}

/**
 * Posts and replies in the channels of every team the person has joined. Graph lists a channel's posts
 * by the latest activity in each reply chain, newest first, so reading stops at the first chain with
 * nothing newer than the channel's cursor. (The channel `messages/delta` function would also work, but its
 * v1.0 reference page is gone and replies to old posts don't surface reliably through it.)
 *
 * Who can see a channel in ALRO, read from Graph rather than assumed:
 * - standard channel: the team's members;
 * - private or shared channel: that channel's own members.
 * A channel is never "org": Graph has no flag for an org-wide team, and an org-wide team's member list
 * is everyone anyway. A channel whose members can't be read is skipped, and its cursor isn't moved, so
 * it is read in full once access is granted.
 */
async function fetchChannels(
  api: Api,
  cursor: Record<string, string>,
  floor: number,
  personKey: (id: string, name?: string | null, email?: string | null) => string,
  threads: NormalizedThread[],
  messages: NormalizedMessage[],
) {
  let teams: Team[];
  try {
    teams = await pages<Team>(api, "me/joinedTeams", {}, 5);
  } catch (e) {
    if (refused(e)) return;
    throw e;
  }
  let budget = MAX_CHANNEL_MESSAGES;
  const teamMembers = new Map<string, Member[] | undefined>();
  const membersOf = async (path: string) => {
    try {
      return await pages<Member>(api, path, { $top: 999 }, 10);
    } catch (e) {
      if (refused(e)) return undefined;
      throw e;
    }
  };

  for (const team of teams.slice(0, MAX_TEAMS)) {
    if (budget <= 0) break;
    let channels: Channel[];
    try {
      channels = await pages<Channel>(api, `teams/${encodeURIComponent(team.id)}/channels`, {}, 5);
    } catch (e) {
      if (refused(e)) continue;
      throw e;
    }
    for (const channel of channels) {
      if (budget <= 0) break;
      const base = `teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(channel.id)}`;
      const since = cursor[channel.id] ? Date.parse(cursor[channel.id]) - OVERLAP_MS : floor;
      const posts: ChannelPost[] = [];
      try {
        let next: string | undefined = `${base}/messages`;
        let query: Record<string, string | number> | undefined = { $top: 50, $expand: "replies" };
        for (let page = 0; next && page < MAX_CHANNEL_PAGES; page++) {
          const r: Page<ChannelPost> = await api("GET", next, { query });
          let older = false;
          for (const post of r.value) {
            // More than the replies that came inline (Graph inlines a few hundred).
            let more = post["replies@odata.nextLink"];
            for (let p = 0; more && p < MAX_REPLY_PAGES; p++) {
              const rest: Page<ChatMessage> = await api("GET", more);
              post.replies = [...(post.replies ?? []), ...rest.value];
              more = rest["@odata.nextLink"];
            }
            const activity = Math.max(...[post, ...(post.replies ?? [])].map((m) => Date.parse(changedAt(m))));
            if (activity <= since) older = true;
            else posts.push(post);
          }
          next = older ? undefined : r["@odata.nextLink"];
          query = undefined;
        }
      } catch (e) {
        // Without the admin-consented permission, or a channel the person was removed from.
        if (refused(e)) continue;
        throw e;
      }

      const latest = posts.flatMap((p) => [p, ...(p.replies ?? [])]).reduce((max, m) => (!max || Date.parse(changedAt(m)) > Date.parse(max) ? changedAt(m) : max), cursor[channel.id] as string | undefined);
      const written: { m: ChatMessage & { subject?: string | null; webUrl?: string | null }; root: string; text: string }[] = [];
      for (const post of posts) {
        for (const m of [post, ...(post.replies ?? [])]) {
          const text = readable(m) && Date.parse(changedAt(m)) > since ? plainText(m) : "";
          if (text) written.push({ m, root: post.id, text });
        }
      }
      if (!written.length) {
        if (latest) cursor[channel.id] = latest;
        continue;
      }

      const shared = channel.membershipType === "private" || channel.membershipType === "shared";
      let members: Member[] | undefined;
      if (shared) members = await membersOf(`${base}/members`);
      else {
        if (!teamMembers.has(team.id)) teamMembers.set(team.id, await membersOf(`teams/${encodeURIComponent(team.id)}/members`));
        members = teamMembers.get(team.id);
      }
      if (!members) continue;
      if (latest) cursor[channel.id] = latest;

      threads.push({
        externalId: channel.id,
        kind: "channel",
        title: `${team.displayName ?? "Team"} / ${channel.displayName ?? "Channel"}`,
        url: channel.webUrl ?? undefined,
        visibility: "members",
        memberKeys: members.filter((m) => m.userId).map((m) => personKey(m.userId!, m.displayName, m.email)),
        metadata: { teamId: team.id, membershipType: channel.membershipType ?? "standard" },
      });
      written.sort((a, b) => Date.parse(a.m.createdDateTime) - Date.parse(b.m.createdDateTime));
      for (const { m, root, text } of written) {
        const author = m.from?.user;
        const files = sharedFiles(m);
        messages.push({
          threadExternalId: channel.id,
          externalId: `${channel.id}:${m.id}`,
          kind: "chat",
          authorKey: author?.id ? personKey(author.id, author.displayName) : undefined,
          sentAt: new Date(m.createdDateTime),
          text,
          subject: m.id === root && m.subject ? m.subject : undefined,
          replyToExternalId: m.id === root ? undefined : `${channel.id}:${root}`,
          attachments: files.length ? files : undefined,
          url: m.webUrl ?? undefined,
          editedAt: m.lastEditedDateTime ? new Date(m.lastEditedDateTime) : undefined,
        });
      }
      budget -= written.length;
    }
  }
}

async function identifyTeams(api: Api) {
  const me = await api<{ mail?: string | null; userPrincipalName: string }>("GET", "me", { query: { $select: "mail,userPrincipalName" } }).catch((e) => {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Microsoft didn't allow access to Teams. Sign in again and allow ALRO to read your chats.");
    throw e;
  });
  const account = (me.mail ?? me.userPrincipalName).toLowerCase();
  return { accountId: account, label: account };
}

/**
 * The channels of the teams the person is in. A separate source from chats: reading channel
 * messages and members needs permissions an admin consents to once for the organisation
 * (Entra admin center → Enterprise applications → ALRO → Permissions), and chats shouldn't wait for that.
 */
export const teamsChannels: Provider = {
  id: "teams-channels",
  scope: "personal",
  auth: {
    kind: "oauth",
    app: "microsoft",
    scopes: ["User.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All", "TeamMember.Read.All", "ChannelMember.Read.All"],
    baseUrl: "https://graph.microsoft.com/v1.0/",
  },
  identify: identifyTeams,
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchTeams(api, ctx.accountId, cursor as TeamsCursor | undefined, ctx.now, { chats: false });
    return { ...found, cursor: next as Record<string, unknown> };
  },
};

/** The person's Microsoft Teams chats: one-to-one, group and meeting chats. */
export const teams: Provider = {
  id: "teams",
  scope: "personal",
  auth: { kind: "oauth", app: "microsoft", scopes: ["User.Read", "Chat.Read"], baseUrl: "https://graph.microsoft.com/v1.0/" },
  identify: identifyTeams,
  async sync(api, cursor, ctx) {
    const { cursor: next, ...found } = await fetchTeams(api, ctx.accountId, cursor as TeamsCursor | undefined, ctx.now, { channels: false });
    return { ...found, cursor: next as Record<string, unknown> };
  },
};
