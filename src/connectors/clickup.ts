import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each sync re-reads this much before the newest task it has seen, in case ClickUp listed a change late. */
const OVERLAP_MS = 10 * 60_000;
/** ClickUp returns 100 tasks a page. */
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
/** Comments come 25 at a time, newest first. */
const MAX_COMMENT_PAGES = 4;
/** Wait between requests: most ClickUp plans allow 100 a minute per token. */
const PAUSE_MS = 650;

export interface ClickupCursor {
  /** date_updated (Unix ms) of the newest task read. */
  since?: number;
  /** Set when a sync stopped at the cap: the next one carries on from `since` without the overlap. */
  more?: boolean;
}

interface User {
  id: number | string;
  username?: string | null;
  email?: string | null;
}
interface Space {
  id: string;
  name?: string;
  private?: boolean;
  /** Listed for private spaces only: the people the space is shared with. */
  members?: { user?: User }[];
}
interface Task {
  id: string;
  custom_id?: string | null;
  name?: string | null;
  text_content?: string | null;
  description?: string | null;
  status?: { status?: string } | null;
  /** Unix ms, as strings. */
  date_created?: string | null;
  date_updated: string;
  due_date?: string | null;
  creator?: User | null;
  assignees?: User[] | null;
  tags?: { name?: string }[] | null;
  priority?: { priority?: string } | null;
  list?: { id: string; name?: string } | null;
  folder?: { id: string; name?: string; hidden?: boolean } | null;
  space?: { id: string } | null;
  url?: string;
}
interface Comment {
  id: string | number;
  comment_text?: string | null;
  user?: User | null;
  /** Unix ms, as a string. */
  date: string;
  reply_count?: number | string | null;
}

const day = (ms: string | null | undefined) => (ms && Number(ms) ? new Date(Number(ms)).toISOString().slice(0, 10) : undefined);

/**
 * Tasks changed since the last sync in one workspace, oldest change first, each as one
 * document thread: the fields and description as a versioned note, then its comments
 * and their replies. Tasks in a private space are visible to that space's members only.
 */
export async function fetchClickup(api: Api, teamId: string, cursor: ClickupCursor = {}, now = new Date(), pauseMs = PAUSE_MS): Promise<Fetched> {
  const get = async <T>(path: string, query?: Record<string, string | number | undefined>) => {
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    return api<T>("GET", path, { query });
  };

  const people = new Map<string, NormalizedPerson>();
  const person = (u: User | null | undefined) => {
    if (u?.id === undefined || u.id === null) return undefined;
    const key = `clickup:${u.id}`;
    const known = people.get(key);
    if (!known || (!known.email && u.email)) people.set(key, { key, provider: "clickup", externalId: String(u.id), displayName: u.username || u.email || known?.displayName || "ClickUp user", email: u.email?.toLowerCase() || undefined });
    return key;
  };

  const spaces = new Map<string, Space>();
  for (const s of (await get<{ spaces?: Space[] }>(`team/${teamId}/space`, { archived: "false" })).spaces ?? []) spaces.set(String(s.id), s);
  /** "org" for an open space, the members of a private one, undefined when they can't be read. */
  const audience = (spaceId: string | undefined): "org" | string[] | undefined => {
    const s = spaceId ? spaces.get(spaceId) : undefined;
    if (!s) return undefined;
    if (!s.private) return "org";
    const keys = (s.members ?? []).map((m) => person(m.user)).filter((k): k is string => !!k);
    return keys.length ? keys : undefined;
  };

  const commentsOf = async (taskId: string) => {
    const all: Comment[] = [];
    let last: Comment | undefined;
    for (let i = 0; i < MAX_COMMENT_PAGES; i++) {
      const r = await get<{ comments?: Comment[] }>(`task/${taskId}/comment`, last && { start: Number(last.date), start_id: String(last.id) });
      const batch = r.comments ?? [];
      all.push(...batch);
      last = batch.at(-1);
      if (batch.length < 25) break;
    }
    return all.reverse();
  };

  const from = cursor.since ? cursor.since - (cursor.more ? 1 : OVERLAP_MS) : now.getTime() - BACKFILL_DAYS * 86_400_000;
  const page = (n: number, reverse: boolean) =>
    get<{ tasks?: Task[]; last_page?: boolean }>(`team/${teamId}/task`, { page: n, order_by: "updated", reverse: String(reverse), subtasks: "true", include_closed: "true", date_updated_gt: from });

  let since = cursor.since;
  let more = true;
  let reverse = true;
  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (let n = 0; n < MAX_PAGES && more; n++) {
    let r = await page(n, reverse);
    // Stopping at the cap is only safe oldest-change-first; if the page came newest-first, ask the other way round.
    if (n === 0 && r.tasks && r.tasks.length > 1 && Number(r.tasks[0].date_updated) > Number(r.tasks.at(-1)!.date_updated)) {
      reverse = false;
      r = await page(0, reverse);
    }
    const tasks = r.tasks ?? [];
    more = !(r.last_page ?? tasks.length < PAGE_SIZE);
    for (const t of tasks) {
      since = Math.max(since ?? 0, Number(t.date_updated) || 0);
      const who = audience(t.space?.id);
      if (!who || !t.name?.trim()) continue;

      const space = spaces.get(t.space!.id)!;
      const title = t.custom_id ? `${t.custom_id} ${t.name.trim()}` : t.name.trim();
      const url = t.url ?? `https://app.clickup.com/t/${t.id}`;
      const assignees = (t.assignees ?? []).map((a) => a.username || a.email).filter(Boolean);
      const tags = (t.tags ?? []).map((tag) => tag.name).filter(Boolean);
      const head = [
        title,
        `Status: ${t.status?.status ?? "unknown"}`,
        assignees.length && `Assignee: ${assignees.join(", ")}`,
        t.priority?.priority && `Priority: ${t.priority.priority}`,
        tags.length && `Tags: ${tags.join(", ")}`,
        day(t.due_date) && `Due: ${day(t.due_date)}`,
        `List: ${[space.name, !t.folder?.hidden && t.folder?.name, t.list?.name].filter(Boolean).join(" / ")}`,
        day(t.date_created) && `Created: ${day(t.date_created)}`,
      ].filter((l): l is string => !!l);
      const externalId = `${t.id}@${t.date_updated}`;
      versions.set(t.id, externalId);
      for (const a of t.assignees ?? []) person(a);
      threads.push({ externalId: t.id, kind: "doc", title, url, visibility: who === "org" ? "org" : "members", memberKeys: who === "org" ? [] : who });
      messages.push({
        threadExternalId: t.id,
        externalId,
        kind: "note",
        authorKey: person(t.creator),
        sentAt: new Date(Number(t.date_updated)),
        subject: title,
        text: [head.join("\n"), (t.text_content ?? t.description ?? "").trim()].filter(Boolean).join("\n\n"),
        url,
      });
      const say = (c: Comment, parent?: Comment) => {
        const text = c.comment_text?.trim();
        if (text) messages.push({ threadExternalId: t.id, externalId: String(c.id), kind: "chat", authorKey: person(c.user), sentAt: new Date(Number(c.date)), text, url: `${url}?comment=${c.id}`, replyToExternalId: parent && String(parent.id) });
      };
      for (const c of await commentsOf(t.id)) {
        say(c);
        if (Number(c.reply_count) > 0) for (const reply of (await get<{ comments?: Comment[] }>(`comment/${c.id}/reply`)).comments ?? []) say(reply, c);
      }
    }
  }

  return { people: [...people.values()], threads, messages, versions, cursor: { since, more: more || undefined } };
}

/** ClickUp tasks and their comments in one workspace, read with a personal API token. */
export const clickup: Provider = {
  id: "clickup",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "token", label: "Personal API token", placeholder: "pk_…", secret: true },
      { name: "workspace", label: "Workspace ID", placeholder: "Only if the token can see several workspaces", optional: true },
    ],
    setup:
      "In ClickUp, open Settings → Apps, generate a personal API token and paste it here. ALRO only reads, and it reads the tasks and comments that person can see, so use an account that sees what the whole team may see.",
    docsUrl: "https://developer.clickup.com/docs/authentication",
    // ClickUp takes a personal token bare, without "Bearer".
    api: (c) => httpApi({ baseUrl: "https://api.clickup.com/api/v2/", headers: () => ({ authorization: (c.token ?? "").trim() }) }),
  },
  async identify(api, credentials) {
    const { teams = [] } = await api<{ teams?: { id: string | number; name?: string }[] }>("GET", "team").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("ClickUp didn't accept that token.");
      throw e;
    });
    const wanted = credentials.workspace?.trim();
    const team = wanted ? teams.find((t) => String(t.id) === wanted) : teams.length === 1 ? teams[0] : undefined;
    if (!team) {
      const names = teams.map((t) => `${t.name ?? "Workspace"} (${t.id})`).join(", ");
      if (!teams.length) throw new Error("That ClickUp token can't see any workspace.");
      throw new Error(wanted ? `That token can't see workspace ${wanted}. It can see: ${names}.` : `That token can see several workspaces: ${names}. Enter the Workspace ID of the one to connect.`);
    }
    return { accountId: `clickup:${team.id}`, label: team.name };
  },
  async sync(api, cursor, ctx) {
    return fetchClickup(api, ctx.accountId.replace(/^clickup:/, ""), cursor as ClickupCursor | undefined, ctx.now);
  },
};
