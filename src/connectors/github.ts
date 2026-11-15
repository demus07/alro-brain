import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { bearer, httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** A repository that is up to date is re-read from this long before the sync began, in case GitHub listed a change late. */
const OVERLAP_MS = 2 * 60_000;
/** Issues and pull requests read per sync, across all repositories; the next sync carries on. */
const MAX_ITEMS = 500;
/** Repositories looked at per sync, most recently pushed first. */
const MAX_REPOS = 300;
const MAX_COMMENT_PAGES = 3;
/** Profiles read per sync for people's names and public emails. */
const MAX_PROFILES = 100;
const PER_PAGE = 100;

export interface GithubCursor {
  /** Per repository id: the `since` to ask for next. */
  since?: Record<string, string>;
}

interface Account {
  id: number;
  login: string;
  type?: string;
}
interface Repo {
  id: number;
  name: string;
  full_name: string;
  private?: boolean;
  visibility?: string;
  disabled?: boolean;
}
interface Item {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state: string;
  state_reason?: string | null;
  draft?: boolean;
  user?: Account | null;
  assignees?: Account[] | null;
  labels?: (string | { name?: string })[];
  milestone?: { title: string; due_on?: string | null } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  /** Present when the issue is a pull request. */
  pull_request?: { merged_at?: string | null };
}
interface Comment {
  id: number;
  body?: string | null;
  html_url: string;
  user?: Account | null;
  created_at: string;
  updated_at?: string;
}

/** GitHub's timestamp form: no milliseconds. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const isBot = (u: Account) => u.type === "Bot" || u.login.endsWith("[bot]");
/** Gone, blocked or not allowed for this token: skip it rather than fail the sync. */
const unreadable = (e: unknown) => e instanceof ProviderError && [403, 404, 410, 451].includes(e.status);

/**
 * Issues and pull requests changed since the last sync, in every repository the token
 * can read. Each is one document thread: the description (with repo, status, assignees
 * and labels as its first lines) stored as a version, then its conversation comments.
 * Private repositories are visible to their collaborators only; when the token can't
 * list those, the repository is skipped.
 */
export async function fetchGithub(api: Api, cursor: GithubCursor = {}, now = new Date()): Promise<Fetched> {
  // GitHub answers 403 when rate-limited; report that as 429 so it isn't taken for a refused token.
  const call = async <T>(path: string, query: Record<string, string | number | undefined> = {}) => {
    try {
      return await api<T>("GET", path, { query });
    } catch (e) {
      throw e instanceof ProviderError && e.status === 403 && /rate limit/i.test(e.message) ? new ProviderError(e.message, 429) : e;
    }
  };
  const list = async <T>(path: string, query: Record<string, string | number | undefined>, maxPages: number) => {
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await call<T[]>(path, { ...query, per_page: PER_PAGE, page });
      all.push(...r);
      if (r.length < PER_PAGE) break;
    }
    return all;
  };

  const people = new Map<string, NormalizedPerson>();
  const logins = new Map<string, string>();
  const person = (u: Account | null | undefined) => {
    if (!u || isBot(u)) return undefined;
    const key = `github:${u.id}`;
    if (!people.has(key)) {
      people.set(key, { key, provider: "github", externalId: String(u.id), displayName: u.login });
      logins.set(key, u.login);
    }
    return key;
  };

  const repos = (await list<Repo>("user/repos", { sort: "pushed", direction: "desc" }, Math.ceil(MAX_REPOS / PER_PAGE))).filter((r) => !r.disabled);
  const floor = stamp(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const since = { ...cursor.since };
  const found: { repo: Repo; item: Item; comments: Comment[]; members?: string[] }[] = [];
  let answered = 0;
  let refused = 0;

  for (const repo of repos) {
    const budget = MAX_ITEMS - found.length;
    if (budget <= 0) break;
    const key = String(repo.id);
    const items: Item[] = [];
    let more = true;
    try {
      for (let page = 1; more && items.length < budget; page++) {
        const r = await call<Item[]>(`repos/${repo.full_name}/issues`, { state: "all", since: since[key] ?? floor, sort: "updated", direction: "asc", per_page: PER_PAGE, page });
        items.push(...r);
        more = r.length === PER_PAGE;
      }
    } catch (e) {
      if (!unreadable(e)) throw e;
      refused++;
      continue;
    }
    answered++;
    if (!items.length) continue;

    let members: string[] | undefined;
    if (repo.private && repo.visibility !== "internal") {
      const collaborators = await list<Account>(`repos/${repo.full_name}/collaborators`, { affiliation: "all" }, 10).catch((e) => {
        if (unreadable(e)) return [];
        throw e;
      });
      members = collaborators.map(person).filter((k): k is string => !!k);
      // Restricted, and who has access can't be read: leave it out.
      if (!members.length) continue;
    }

    const read = items.slice(0, budget);
    for (const item of read) {
      const comments = item.comments > 0 ? await list<Comment>(`repos/${repo.full_name}/issues/${item.number}/comments`, {}, MAX_COMMENT_PAGES) : [];
      for (const u of [item.user, ...(item.assignees ?? []), ...comments.map((c) => c.user)]) person(u);
      found.push({ repo, item, comments, members });
    }
    const last = Date.parse(read.at(-1)!.updated_at);
    // Cut short: carry on from the last one read. Otherwise from just after it, but never later than shortly before this sync.
    since[key] = stamp(more || read.length < items.length ? last - 1000 : Math.min(last + 1000, now.getTime() - OVERLAP_MS));
  }
  if (refused && !answered) throw new ProviderError("GitHub wouldn't list issues in any repository. Give the token read access to Issues and Pull requests.", 403);

  // Issues carry only logins; a profile adds the name and public email that link the person to other sources.
  for (const [key, login] of [...logins].slice(0, MAX_PROFILES)) {
    const profile = await call<{ name?: string | null; email?: string | null }>(`users/${login}`).catch((e) => {
      if (unreadable(e)) return undefined;
      throw e;
    });
    if (profile) people.set(key, { ...people.get(key)!, displayName: profile.name || login, email: profile.email?.toLowerCase() || undefined });
  }
  const name = (u: Account) => people.get(`github:${u.id}`)?.displayName ?? u.login;

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const { repo, item, comments, members } of found) {
    if (!item.title?.trim()) continue;
    const id = String(item.id);
    const pr = item.pull_request;
    const title = `${repo.name}#${item.number} ${item.title.trim()}`;
    const status = pr?.merged_at ? "merged" : item.state === "open" && item.draft ? "draft" : item.state === "closed" && item.state_reason ? `closed (${item.state_reason.replace(/_/g, " ")})` : item.state;
    const labels = (item.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
    const head = [
      title,
      `Repo: ${repo.full_name}`,
      `Type: ${pr ? "Pull request" : "Issue"}`,
      `Status: ${status}`,
      item.assignees?.length && `Assignee: ${item.assignees.map(name).join(", ")}`,
      labels.length && `Labels: ${labels.join(", ")}`,
      item.milestone && `Milestone: ${item.milestone.title}`,
      item.milestone?.due_on && `Due: ${item.milestone.due_on.slice(0, 10)}`,
      `Created: ${item.created_at.slice(0, 10)}`,
    ].filter((l): l is string => !!l);
    const externalId = `${id}@${item.updated_at}`;
    versions.set(id, externalId);
    threads.push({ externalId: id, kind: "doc", title, url: item.html_url, visibility: members ? "members" : "org", memberKeys: members ?? [] });
    messages.push({
      threadExternalId: id,
      externalId,
      kind: "note",
      authorKey: person(item.user),
      sentAt: new Date(item.updated_at),
      subject: title,
      text: [head.join("\n"), item.body?.trim()].filter(Boolean).join("\n\n"),
      url: item.html_url,
    });
    for (const c of comments) {
      // Bot comments (CI, coverage, deploy previews) are noise.
      if (!c.body?.trim() || !c.user || isBot(c.user)) continue;
      messages.push({
        threadExternalId: id,
        externalId: String(c.id),
        kind: "chat",
        authorKey: person(c.user),
        sentAt: new Date(c.created_at),
        text: c.body.trim(),
        url: c.html_url,
        editedAt: c.updated_at && c.updated_at !== c.created_at ? new Date(c.updated_at) : undefined,
      });
    }
  }

  const next: GithubCursor = { since };
  return { people: [...people.values()], threads, messages, versions, cursor: next as Record<string, unknown> };
}

/** GitHub issues and pull requests with their comments, read with a personal access token. */
export const github: Provider = {
  id: "github",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "token", label: "Personal access token", placeholder: "github_pat_…", secret: true }],
    setup:
      "On GitHub, open Settings → Developer settings → Personal access tokens → Fine-grained tokens and create one owned by your organization, for the repositories ALRO should read, with read-only access to Metadata, Issues and Pull requests. Paste the token here.",
    docsUrl: "https://github.com/settings/personal-access-tokens",
    api: (c) => httpApi({ baseUrl: "https://api.github.com/", headers: () => ({ ...bearer(c.token)(), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }) }),
  },
  async identify(api) {
    try {
      const me = await api<{ id: number; login: string; name?: string | null }>("GET", "user");
      return { accountId: `github:${me.id}`, label: me.name ? `${me.name} (${me.login})` : me.login };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 401) throw new Error("GitHub didn't accept that token. Check it was copied in full and hasn't expired.");
      throw e;
    }
  },
  sync: (api, cursor, ctx) => fetchGithub(api, cursor as GithubCursor | undefined, ctx.now),
};
