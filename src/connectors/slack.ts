import { slackExportToBatch } from "@/ingest/parsers/slack-export";
import type { NormalizedBatch } from "@/ingest/types";
import { bearer, httpApi, type Api } from "./api";
import { z } from "zod";
import type { ActionDef, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before its cursor, so replies to recent threads are picked up. */
const OVERLAP_DAYS = 7;
const MAX_PAGES = 20;

export interface SlackCursor {
  /** Newest message ts seen, per conversation. */
  latest?: Record<string, string>;
}

interface Page {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

/**
 * Fetches what's new in every conversation the connection can read and turns it into
 * the same shape as a Slack export, so the export parser does the mapping.
 */
export async function fetchSlack(api: Api, cursor: SlackCursor = {}, now = new Date()): Promise<{ batch: NormalizedBatch; cursor: SlackCursor }> {
  const call = async <T extends Page>(path: string, query: Record<string, string | number | undefined>) => {
    const r = await api<T>("GET", path, { query });
    if (!r.ok) throw new Error(`Slack ${path}: ${r.error}`);
    return r;
  };
  const pages = async <T extends Page, I>(path: string, query: Record<string, string | number | undefined>, items: (r: T) => I[]) => {
    const all: I[] = [];
    let next: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await call<T>(path, { ...query, cursor: next });
      all.push(...items(r));
      next = r.response_metadata?.next_cursor || undefined;
      if (!next) break;
    }
    return all;
  };

  const team = await call<Page & { team_id: string; url?: string }>("auth.test", {});
  type Conv = { id: string; name?: string; is_channel?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; user?: string; members?: string[] };
  type Msg = { ts: string; thread_ts?: string; reply_count?: number; type: string };
  const users = await pages<Page & { members: unknown[] }, unknown>("users.list", { limit: 200 }, (r) => r.members);
  const convs = await pages<Page & { channels: Conv[] }, Conv>("conversations.list", { types: "public_channel,private_channel,mpim,im", exclude_archived: "true", limit: 200 }, (r) => r.channels);

  const files = new Map<string, string>([["users.json", JSON.stringify(users)]]);
  const groups: Record<"channels" | "groups" | "dms" | "mpims", Conv[]> = { channels: [], groups: [], dms: [], mpims: [] };
  const latest = { ...cursor.latest };
  const floor = (now.getTime() - BACKFILL_DAYS * 86_400_000) / 1000;

  for (const c of convs) {
    const since = cursor.latest?.[c.id] ? Number(cursor.latest[c.id]) - OVERLAP_DAYS * 86_400 : floor;
    let history: Msg[];
    try {
      history = await pages<Page & { messages: Msg[] }, Msg>("conversations.history", { channel: c.id, oldest: since.toFixed(6), limit: 200 }, (r) => r.messages);
    } catch (e) {
      // Channels the app isn't in can be listed but not read; skip them.
      if (/not_in_channel|channel_not_found|missing_scope/.test(String(e))) continue;
      throw e;
    }
    const replies: Msg[] = [];
    for (const parent of history.filter((m) => (m.reply_count ?? 0) > 0)) {
      const thread = await pages<Page & { messages: Msg[] }, Msg>("conversations.replies", { channel: c.id, ts: parent.ts, limit: 200 }, (r) => r.messages);
      replies.push(...thread.filter((m) => m.ts !== parent.ts));
    }
    const all = [...history, ...replies].sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!all.length && cursor.latest?.[c.id]) continue;

    const members = c.is_im ? [c.user!] : c.is_private || c.is_mpim ? await pages<Page & { members: string[] }, string>("conversations.members", { channel: c.id, limit: 200 }, (r) => r.members) : undefined;
    const conv = { ...c, members };
    const folder = c.is_im ? c.id : (c.name ?? c.id);
    if (c.is_im) groups.dms.push(conv);
    else if (c.is_mpim) groups.mpims.push(conv);
    else if (c.is_private) groups.groups.push(conv);
    else groups.channels.push(conv);
    // The export parser reads "<folder>/<date>.json"; one file per conversation is enough.
    files.set(`${folder}/0000-00-00.json`, JSON.stringify(all.map((m) => ({ ...m, type: m.type ?? "message" }))));
    if (all.length) latest[c.id] = all.at(-1)!.ts;
  }
  for (const [name, list] of Object.entries(groups)) files.set(`${name}.json`, JSON.stringify(list));

  const domain = team.url?.match(/^https:\/\/([^.]+)\.slack\.com/)?.[1];
  return { batch: slackExportToBatch(files, { teamId: team.team_id, domain }), cursor: { latest } };
}

const slackPostInput = z.object({
  to: z.string().min(2).describe('"#channel-name" (public channels only), or a person\'s email for a direct message'),
  text: z.string().min(1),
});
type SlackPostInput = z.infer<typeof slackPostInput>;

/** Finds the conversation to post in, then posts. Slack answers errors with `ok: false`, not a status. */
export async function postSlackMessage(api: Api, input: SlackPostInput): Promise<{ url?: string; detail?: string }> {
  const call = async <T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown }) => {
    const r = await api<Page & T>(method, path, opts);
    if (!r.ok) throw new Error(`Slack ${path}: ${r.error}`);
    return r;
  };
  let channel = input.to.trim();
  if (channel.includes("@")) {
    const { user } = await call<{ user: { id: string } }>("GET", "users.lookupByEmail", { query: { email: channel } });
    channel = (await call<{ channel: { id: string } }>("POST", "conversations.open", { body: { users: user.id } })).channel.id;
  } else {
    // A shared connection posts as the app for whoever asks, so only in public channels (or a DM, above):
    // never into a private channel the asker might not be in.
    const name = channel.replace(/^#/, "").toLowerCase();
    let cursor: string | undefined;
    let found: string | undefined;
    do {
      const page = await call<{ channels: { id: string; name: string }[] }>("GET", "conversations.list", { query: { types: "public_channel", limit: "1000", exclude_archived: "true", ...(cursor ? { cursor } : {}) } });
      found = page.channels.find((c) => c.name === name || c.id.toLowerCase() === name)?.id;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (!found && cursor);
    if (!found) throw new Error(`No public Slack channel called #${name}. ALRO posts in public channels and direct messages only.`);
    channel = found;
  }
  const posted = await call<{ channel: string; ts: string }>("POST", "chat.postMessage", { body: { channel, text: input.text } });
  const link = await call<{ permalink?: string }>("GET", "chat.getPermalink", { query: { channel: posted.channel, message_ts: posted.ts } }).catch(() => undefined);
  return { url: link?.permalink, detail: "Posted in Slack" };
}

export const slack: Provider = {
  id: "slack",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "token", label: "Bot token", placeholder: "xoxb-…", secret: true }],
    setup:
      "Create a Slack app for your workspace, add the bot scopes channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read and users:read.email, install it, and paste the Bot User OAuth Token. Invite the bot to each channel it should read. To let ALRO post messages you approve, also add chat:write and im:write.",
    docsUrl: "https://api.slack.com/apps",
    api: (c) => httpApi({ baseUrl: "https://slack.com/api/", headers: bearer(c.token) }),
  },
  async identify(api) {
    const r = await api<{ ok: boolean; error?: string; team_id: string; team?: string }>("GET", "auth.test");
    if (!r.ok) throw new Error(`Slack didn't accept that token (${r.error}).`);
    return { accountId: r.team_id, label: r.team };
  },
  async sync(api, cursor, ctx) {
    const { batch, cursor: next } = await fetchSlack(api, cursor as SlackCursor | undefined, ctx.now);
    return { ...batch, cursor: next as Record<string, unknown> };
  },
  actions: {
    slack_post_message: {
      description: "Post a message in Slack as the ALRO app: in a public channel (\"#general\") or as a direct message to someone (their email).",
      input: slackPostInput,
      audience: () => "internal",
      summary: (i) => `Slack message to ${i.to}`,
      body: (i) => i.text,
      withBody: (i, text) => ({ ...i, text }),
      run: postSlackMessage,
    } satisfies ActionDef<SlackPostInput>,
  },
};
