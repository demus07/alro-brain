import type { CompleteWindow, NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import type { Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** 100 messages a page is Discord's maximum. */
const PAGE = 100;
/** Pages per channel per sync, so one busy channel can't starve the rest; the cursor carries on next time. */
const MAX_PAGES_PER_CHANNEL = 3;
/** Past this many messages the sync stops opening channels; the ones it didn't reach keep their cursor. */
const MAX_MESSAGES = 1000;
/** 1000 members a page; servers bigger than this get org-wide channels only (see `channelAudience`). */
const MAX_MEMBER_PAGES = 5;
/** Archived threads are checked on the first sync and then once a day, a page per channel. */
const ARCHIVED_EVERY_MS = 86_400_000;
const ARCHIVED_PAGE = 25;
/**
 * Deleted messages are found by reading back from a channel's cursor: this far, and at most this many pages.
 * A channel with new messages is re-read on every sync, a quiet one once an hour.
 */
const REREAD_MS = 7 * 86_400_000;
const REREAD_PAGES = 2;
const REREAD_QUIET_EVERY_MS = 3_600_000;
/** Longest wait for a rate limit before giving up and letting the next sync carry on. */
const MAX_RETRY_AFTER_MS = 60_000;

const DISCORD_EPOCH = BigInt(1420070400000);
const VIEW_CHANNEL = BigInt(1) << BigInt(10);
const ADMINISTRATOR = BigInt(1) << BigInt(3);
const MANAGE_THREADS = BigInt(1) << BigInt(34);

/** Channel types (https://docs.discord.com/developers/resources/channel). */
const TEXT = 0;
const ANNOUNCEMENT = 5;
const ANNOUNCEMENT_THREAD = 10;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
const FORUM = 15;
const MEDIA = 16;
/** Channels whose messages (or threads) we read. */
const READABLE = new Set([TEXT, ANNOUNCEMENT, FORUM, MEDIA]);
/** Forum and media channels hold only threads; there are no messages of their own to read. */
const THREADS_ONLY = new Set([FORUM, MEDIA]);
/** Messages people write: default, reply, slash-command and context-menu output. Joins, pins, boosts and thread starters are skipped. */
const WRITTEN = new Set([0, 19, 20, 23]);

export interface DiscordCursor {
  /** Newest message id (a snowflake) seen, per channel or thread. */
  after?: Record<string, string>;
  /** When archived threads were last checked (ISO). */
  archivedAt?: string;
  /** When quiet channels were last re-read for deleted messages (ISO). */
  rereadAt?: string;
}

interface User {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
interface Overwrite {
  id: string;
  /** 0 role, 1 member. */
  type: 0 | 1;
  allow: string;
  deny: string;
}
interface Channel {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  parent_id?: string | null;
  last_message_id?: string | null;
  permission_overwrites?: Overwrite[];
  thread_metadata?: { archived?: boolean; archive_timestamp?: string };
}
interface Role {
  id: string;
  name: string;
  permissions: string;
}
interface Member {
  user?: User;
  nick?: string | null;
  roles: string[];
}
interface Message {
  id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author: User;
  webhook_id?: string;
  mentions?: User[];
  attachments?: { filename: string; content_type?: string; url?: string; size?: number }[];
  message_reference?: { type?: number; message_id?: string; channel_id?: string };
}

/** The snowflake for a moment: messages `after` it were sent later. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << BigInt(22)).toString();
}
const newer = (a: string, b: string) => BigInt(a) > BigInt(b);
/** When a snowflake was made, in milliseconds. */
const timeOf = (id: string) => Number((BigInt(id) >> BigInt(22)) + DISCORD_EPOCH);
const refused = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);

/**
 * Waits as long as Discord's 429 says (`retry_after`, in seconds) and tries again. `withRetries` also retries
 * 429s, but on a fixed 1s/4s/16s schedule that ignores what Discord asked for. The wait is read from the
 * error text because `ProviderError` keeps only the status.
 */
export function honourRetryAfter(api: Api, tries = 3, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Api {
  return async (method, path, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(method, path, opts);
      } catch (e) {
        const seconds = e instanceof ProviderError && e.status === 429 ? Number(/"retry_after"\s*:\s*([\d.]+)/.exec(e.message)?.[1] ?? 1) : NaN;
        if (Number.isNaN(seconds) || attempt >= tries || seconds * 1000 > MAX_RETRY_AFTER_MS) throw e;
        await sleep(Math.ceil(seconds * 1000) + 100);
      }
    }
  };
}

/** Discord channel text as plain text: user, role and channel mentions named. */
export function renderDiscord(text: string, names: { user: (id: string) => string; role: (id: string) => string; channel: (id: string) => string }): string {
  return text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.user(id)}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${names.role(id)}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${names.channel(id)}`)
    .replace(/<a?(:\w+:)\d+>/g, "$1")
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, s: string) => new Date(Number(s) * 1000).toISOString())
    .trim();
}

type Audience = { visibility: "org" } | { visibility: "members"; userIds: string[] } | { skip: string };

/**
 * Everything new in a Discord server's text, announcement and forum channels and their threads since the last
 * sync (or the last 90 days). Each channel and each thread is one thread in memory.
 *
 * Who can see a channel is worked out from Discord's own permission rules: it's "org" when @everyone can view
 * it and no role or member overwrite takes that away. Otherwise the members who can view it are computed from
 * the server's member list, which needs the Server Members intent; without it (or on servers past 5,000
 * members) those channels are skipped rather than guessed at.
 *
 * A channel read before is reported on every sync with its audience as it is now, even when nothing new was
 * said, so a channel made private or a role taken away reaches ALRO; if its audience can no longer be worked
 * out it is reported with nobody in it. The week before each cursor is read again, so a stored message that
 * is no longer there was deleted.
 */
export async function fetchDiscord(
  api: Api,
  guildId: string,
  cursor: DiscordCursor = {},
  now = new Date(),
): Promise<{ people: NormalizedPerson[]; threads: NormalizedThread[]; messages: NormalizedMessage[]; cursor: DiscordCursor; skipped: { id: string; name?: string; why: string }[] }> {
  const guild = await api<{ id: string; name: string; owner_id: string; roles?: Role[] }>("GET", `guilds/${guildId}`);
  const roles = guild.roles?.length ? guild.roles : await api<Role[]>("GET", `guilds/${guildId}/roles`);
  const rolePerms = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  // The @everyone role's id is the server's id.
  const everyone = rolePerms.get(guildId) ?? BigInt(0);

  const channels = await api<Channel[]>("GET", `guilds/${guildId}/channels`);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const active = await api<{ threads: Channel[] }>("GET", `guilds/${guildId}/threads/active`);
  const threadsFound = new Map(active.threads.map((t) => [t.id, t]));

  const after = { ...cursor.after };
  const floor = snowflakeAt(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const checkArchived = !cursor.archivedAt || now.getTime() - Date.parse(cursor.archivedAt) >= ARCHIVED_EVERY_MS;
  if (checkArchived) {
    for (const c of channels.filter((c) => READABLE.has(c.type))) {
      try {
        const r = await api<{ threads: Channel[] }>("GET", `channels/${c.id}/threads/archived/public`, { query: { limit: ARCHIVED_PAGE } });
        for (const t of r.threads) if (!threadsFound.has(t.id)) threadsFound.set(t.id, t);
      } catch (e) {
        if (!refused(e)) throw e;
      }
    }
  }
  for (const t of threadsFound.values()) byId.set(t.id, t);

  // The member list, fetched only when a restricted channel needs it. `null`: not available.
  let members: Member[] | null | undefined;
  const memberList = async () => {
    if (members !== undefined) return members;
    const all: Member[] = [];
    let last = "0";
    try {
      for (let page = 0; ; page++) {
        const r = await api<Member[]>("GET", `guilds/${guildId}/members`, { query: { limit: 1000, after: last } });
        all.push(...r);
        if (r.length < 1000) break;
        if (page + 1 >= MAX_MEMBER_PAGES) return (members = null);
        last = r.at(-1)!.user!.id;
      }
    } catch (e) {
      // 403 "Missing Access" when the Server Members intent is off.
      if (refused(e)) return (members = null);
      throw e;
    }
    members = all.filter((m) => m.user && !m.user.bot);
    for (const m of members) memberUsers.set(m.user!.id, m.user!);
    return members;
  };
  const memberUsers = new Map<string, User>();

  /** A member's permissions in a channel, by Discord's documented order: base, @everyone overwrite, role overwrites, member overwrite. */
  const permsIn = (m: Member, c: Channel): bigint => {
    if (m.user!.id === guild.owner_id) return ~BigInt(0);
    let p = everyone;
    for (const r of m.roles) p |= rolePerms.get(r) ?? BigInt(0);
    if (p & ADMINISTRATOR) return ~BigInt(0);
    const ow = c.permission_overwrites ?? [];
    const own = ow.find((o) => o.type === 0 && o.id === guildId);
    if (own) p = (p & ~BigInt(own.deny)) | BigInt(own.allow);
    let allow = BigInt(0);
    let deny = BigInt(0);
    for (const o of ow) {
      if (o.type !== 0 || o.id === guildId || !m.roles.includes(o.id)) continue;
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
    p = (p & ~deny) | allow;
    const mine = ow.find((o) => o.type === 1 && o.id === m.user!.id);
    if (mine) p = (p & ~BigInt(mine.deny)) | BigInt(mine.allow);
    return p;
  };

  const audiences = new Map<string, Audience>();
  const channelAudience = async (c: Channel): Promise<Audience> => {
    const known = audiences.get(c.id);
    if (known) return known;
    let a: Audience;
    const ow = c.permission_overwrites ?? [];
    const own = ow.find((o) => o.type === 0 && o.id === guildId);
    const forEveryone = everyone & ADMINISTRATOR ? ~BigInt(0) : own ? (everyone & ~BigInt(own.deny)) | BigInt(own.allow) : everyone;
    const takenAway = ow.some((o) => o.id !== guildId && BigInt(o.deny) & VIEW_CHANNEL);
    if (forEveryone & VIEW_CHANNEL && !takenAway) a = { visibility: "org" };
    else {
      const list = await memberList();
      a = list
        ? { visibility: "members", userIds: list.filter((m) => permsIn(m, c) & VIEW_CHANNEL).map((m) => m.user!.id) }
        : { skip: "restricted channel, and the bot can't read the member list (turn on the Server Members intent)" };
    }
    audiences.set(c.id, a);
    return a;
  };

  /** A thread is seen by whoever sees its channel; a private one only by its members and those who can manage threads there. */
  const threadAudience = async (t: Channel, parent: Channel): Promise<Audience> => {
    const base = await channelAudience(parent);
    if (t.type !== PRIVATE_THREAD || "skip" in base) return base;
    const list = await memberList();
    if (!list) return { skip: "private thread, and the bot can't read the member list (turn on the Server Members intent)" };
    let joined: { user_id: string }[];
    try {
      joined = await api<{ user_id: string }[]>("GET", `channels/${t.id}/thread-members`, { query: { limit: 100 } });
    } catch (e) {
      if (refused(e)) return { skip: "private thread the bot can't list the members of" };
      throw e;
    }
    const inThread = new Set(joined.map((j) => j.user_id));
    const viewers = list.filter((m) => permsIn(m, parent) & VIEW_CHANNEL);
    return { visibility: "members", userIds: viewers.filter((m) => inThread.has(m.user!.id) || permsIn(m, parent) & MANAGE_THREADS).map((m) => m.user!.id) };
  };

  const people = new Map<string, NormalizedPerson>();
  const personKey = (u: User) => {
    const key = `discord:${u.id}`;
    if (!people.has(key)) people.set(key, { key, provider: "discord", externalId: u.id, displayName: u.global_name || u.username });
    return key;
  };
  const userNames = new Map<string, string>();
  const names = {
    user: (id: string) => userNames.get(id) ?? id,
    role: (id: string) => (id === guildId ? "everyone" : (roleName.get(id) ?? id)),
    channel: (id: string) => byId.get(id)?.name ?? id,
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const skipped: { id: string; name?: string; why: string }[] = [];
  const link = (id: string, msg?: string) => `https://discord.com/channels/${guildId}/${id}${msg ? `/${msg}` : ""}`;
  const rereadQuiet = !cursor.rereadAt || now.getTime() - Date.parse(cursor.rereadAt) >= REREAD_QUIET_EVERY_MS;
  /** New messages read so far; re-read ones don't count against the budget. */
  let fresh = 0;

  /**
   * Reads back from a channel's cursor and says which stretch it read to the end. Discord pages backwards
   * from an id, so whatever was read is whole however busy the channel is; the stretch just gets shorter.
   */
  const reread = async (channelId: string, seen: string): Promise<{ found: Message[]; complete?: CompleteWindow }> => {
    const floorMs = timeOf(seen) - REREAD_MS;
    const found: Message[] = [];
    let before = (BigInt(seen) + BigInt(1)).toString();
    let lowestMs = 0;
    try {
      for (let page = 0; page < REREAD_PAGES; page++) {
        const r = await api<Message[]>("GET", `channels/${channelId}/messages`, { query: { before, limit: PAGE } });
        found.push(...r.filter((m) => !newer(m.id, seen)));
        // Without Read Message History Discord answers with an empty list, not an error: that proves nothing.
        if (!found.length) return { found };
        // A short page is the start of the channel.
        if (r.length < PAGE) return { found, complete: { from: new Date(floorMs), to: new Date(timeOf(seen)) } };
        before = r.reduce((min, m) => (newer(min, m.id) ? m.id : min), before);
        lowestMs = timeOf(before);
        if (lowestMs < floorMs) break;
      }
    } catch (e) {
      if (refused(e)) return { found: [] };
      throw e;
    }
    // A second's margin above the oldest message read, so one sharing its millisecond on an unread page is never taken for deleted.
    return { found, complete: { from: new Date(Math.max(floorMs, lowestMs + 1000)), to: new Date(timeOf(seen)) } };
  };

  const readable = [
    ...channels.filter((c) => READABLE.has(c.type) && !THREADS_ONLY.has(c.type)),
    ...[...threadsFound.values()].filter((t) => [ANNOUNCEMENT_THREAD, PUBLIC_THREAD, PRIVATE_THREAD].includes(t.type) && t.parent_id && byId.has(t.parent_id)),
  ];
  for (const c of readable) {
    /** The cursor from the last sync: set when this channel was read before. */
    const seen = cursor.after?.[c.id];
    const start = seen ?? floor;
    // Nothing newer than what we have (or than the backfill floor), or the budget is spent: no request for new messages.
    const hasNew = fresh < MAX_MESSAGES && !(c.last_message_id && !newer(c.last_message_id, start));
    if (!seen && !hasNew) continue;
    const parent = c.parent_id && c.type !== TEXT && c.type !== ANNOUNCEMENT ? byId.get(c.parent_id) : undefined;
    const title = parent ? `#${parent.name} › ${c.name}` : `#${c.name}`;
    const metadata = { topic: c.topic ?? undefined, parentId: parent?.id, thread: parent ? true : undefined };
    const audience = parent ? await threadAudience(c, parent) : await channelAudience(c);
    if ("skip" in audience) {
      skipped.push({ id: c.id, name: c.name, why: audience.skip });
      // Read before, and who may see it can no longer be worked out: nobody, rather than whoever could last time.
      if (seen) threads.push({ externalId: c.id, kind: "channel", title, url: link(c.id), visibility: "members", memberKeys: [], membersComplete: true, metadata });
      continue;
    }

    const found: Message[] = [];
    let from = start;
    try {
      for (let page = 0; hasNew && page < MAX_PAGES_PER_CHANNEL && fresh + found.length < MAX_MESSAGES; page++) {
        const r = await api<Message[]>("GET", `channels/${c.id}/messages`, { query: { after: from, limit: PAGE } });
        // Discord answers newest first; the page is the 100 just after `from`.
        r.sort((a, b) => (newer(a.id, b.id) ? 1 : -1));
        found.push(...r);
        if (r.length) from = r.at(-1)!.id;
        if (r.length < PAGE) break;
      }
    } catch (e) {
      // Listed but not readable by the bot (no View Channel / Read Message History there): nothing new from it.
      if (!refused(e)) throw e;
      skipped.push({ id: c.id, name: c.name, why: "the bot can't read it" });
      if (!seen) continue;
    }
    if (found.length) after[c.id] = found.at(-1)!.id;
    const again = seen && (found.length || rereadQuiet) ? await reread(c.id, seen) : { found: [] };

    for (const m of [...again.found, ...found]) {
      userNames.set(m.author.id, m.author.global_name || m.author.username);
      for (const u of m.mentions ?? []) userNames.set(u.id, u.global_name || u.username);
    }
    const isWritten = (m: Message) => WRITTEN.has(m.type) && (m.content.trim() || m.attachments?.length);
    const newlyWritten = found.filter(isWritten);
    fresh += newlyWritten.length;
    const reSent = again.complete ? again.found.filter(isWritten).sort((a, b) => (newer(a.id, b.id) ? 1 : -1)) : [];
    const written = [...reSent, ...newlyWritten];
    if (!written.length && !seen) continue;

    const memberKeys = audience.visibility === "members" ? audience.userIds.map((id) => personKey(memberUsers.get(id) ?? { id, username: userNames.get(id) ?? id })) : [];
    threads.push({
      externalId: c.id,
      kind: "channel",
      title,
      url: link(c.id),
      visibility: audience.visibility,
      memberKeys,
      // Worked out from the server's whole member list, so anyone not on it has lost the channel.
      membersComplete: audience.visibility === "members" ? true : undefined,
      complete: again.complete,
      metadata,
    });
    for (const m of written) {
      const human = !m.author.bot && !m.webhook_id;
      const ref = m.message_reference;
      messages.push({
        threadExternalId: c.id,
        externalId: `${c.id}:${m.id}`,
        kind: "chat",
        authorKey: human ? personKey(m.author) : undefined,
        recipientKeys: (m.mentions ?? []).filter((u) => !u.bot).map(personKey),
        sentAt: new Date(m.timestamp),
        text: renderDiscord(m.content, names) || (m.attachments ?? []).map((a) => a.filename).join(", "),
        // Type 0 references are replies; forwards (type 1) point elsewhere.
        replyToExternalId: ref?.message_id && (ref.type ?? 0) === 0 ? `${ref.channel_id ?? c.id}:${ref.message_id}` : undefined,
        attachments: m.attachments?.length ? m.attachments.map((a) => ({ name: a.filename, mimeType: a.content_type, url: a.url, size: a.size })) : undefined,
        url: link(c.id, m.id),
        editedAt: m.edited_timestamp ? new Date(m.edited_timestamp) : undefined,
        raw: human ? undefined : { bot: m.author.username },
      });
    }
  }

  return {
    people: [...people.values()],
    threads,
    messages,
    cursor: { after, archivedAt: checkArchived ? now.toISOString() : cursor.archivedAt, rereadAt: rereadQuiet ? now.toISOString() : cursor.rereadAt },
    skipped,
  };
}

const guildIdOf = (c: Record<string, string>) => (c.guildId ?? "").trim();

export const discord: Provider = {
  id: "discord",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "token", label: "Bot token", placeholder: "MTI…", secret: true },
      { name: "guildId", label: "Server ID", placeholder: "123456789012345678" },
    ],
    setup:
      "In the Discord Developer Portal, create an application, open Bot, turn on the Message Content intent (and Server Members, so private channels can be read with the right audience), and copy the bot token. Under OAuth2 → URL Generator pick the bot scope with View Channels and Read Message History, open the link to add the bot to your server, then right-click the server (with Developer Mode on) → Copy Server ID.",
    docsUrl: "https://discord.com/developers/applications",
    api: (c) =>
      honourRetryAfter(
        httpApi({
          baseUrl: "https://discord.com/api/v10/",
          headers: () => ({
            authorization: `Bot ${(c.token ?? "").trim().replace(/^Bot\s+/i, "")}`,
            // Discord asks bots to identify themselves this way.
            "user-agent": "DiscordBot (https://github.com/alro, 1.0)",
          }),
        }),
      ),
  },
  async identify(api, credentials) {
    const guildId = guildIdOf(credentials);
    if (!/^\d{15,22}$/.test(guildId)) throw new Error("That server ID doesn't look right: it's a long number. Turn on Developer Mode in Discord, then right-click the server and choose Copy Server ID.");
    try {
      await api("GET", "users/@me");
    } catch (e) {
      if (e instanceof ProviderError && e.status === 401) throw new Error("Discord didn't accept that bot token. Copy it again from the Bot page of your application.");
      throw e;
    }
    try {
      const g = await api<{ id: string; name: string }>("GET", `guilds/${guildId}`);
      return { accountId: g.id, label: g.name };
    } catch (e) {
      if (refused(e)) throw new Error("The bot isn't in that server yet. Invite it with the OAuth2 link (bot scope, View Channels and Read Message History), then try again.");
      throw e;
    }
  },
  async sync(api, cursor, ctx) {
    const { people, threads, messages, cursor: next } = await fetchDiscord(api, guildIdOf(ctx.credentials) || ctx.accountId, cursor as DiscordCursor | undefined, ctx.now);
    return { people, threads, messages, cursor: next as Record<string, unknown> };
  },
};
