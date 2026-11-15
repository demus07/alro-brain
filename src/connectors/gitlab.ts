import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** A project that is up to date is re-read from this long before the sync began, in case GitLab listed a change late. */
const OVERLAP_MS = 2 * 60_000;
/** Issues and merge requests read per sync, across all projects; the next sync carries on. */
const MAX_ITEMS = 500;
/** Projects looked at per sync, most recently active first. */
const MAX_PROJECTS = 300;
const MAX_NOTE_PAGES = 3;
/** Profiles read per sync for people's public emails. */
const MAX_PROFILES = 100;
const PER_PAGE = 100;
/** GitLab access levels: Guest can read a private project, Planner and up can read confidential issues. */
const GUEST = 10;
const PLANNER = 15;

export interface GitlabCursor {
  /** Per "<project id>/issues" and "<project id>/merge_requests": the `updated_after` to ask for next. */
  since?: Record<string, string>;
}

interface User {
  id: number;
  username: string;
  name?: string;
  state?: string;
  bot?: boolean;
  email?: string | null;
  public_email?: string | null;
}
interface Member extends User {
  access_level: number;
  membership_state?: string;
}
interface Project {
  id: number;
  path: string;
  path_with_namespace: string;
  visibility?: "public" | "internal" | "private";
  issues_access_level?: string;
  merge_requests_access_level?: string;
}
interface Item {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  web_url: string;
  author?: User | null;
  assignees?: User[] | null;
  reviewers?: User[] | null;
  labels?: string[];
  milestone?: { title: string; due_date?: string | null } | null;
  due_date?: string | null;
  confidential?: boolean;
  draft?: boolean;
  user_notes_count?: number;
  source_branch?: string;
  target_branch?: string;
  created_at: string;
  updated_at: string;
}
interface Note {
  id: number;
  body?: string | null;
  author?: User | null;
  created_at: string;
  updated_at?: string;
  system?: boolean;
  internal?: boolean;
  confidential?: boolean;
}

const KINDS = [
  { path: "issues", id: "issue", type: "Issue", mark: "#", level: (p: Project) => p.issues_access_level },
  { path: "merge_requests", id: "mr", type: "Merge request", mark: "!", level: (p: Project) => p.merge_requests_access_level },
] as const;

const isBot = (u: User) => u.bot === true || /^(project|group)_\d+_bot/.test(u.username);
/** Gone or not allowed for this token: skip it rather than fail the sync. */
const unreadable = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);

/**
 * The instance's API root: gitlab.com unless a self-hosted URL was given. Only public
 * https hostnames are accepted, so the token can't be pointed at an internal address.
 */
export function gitlabApiRoot(url?: string): string {
  const raw = url?.trim() || "https://gitlab.com";
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("That GitLab URL doesn't look right. It should be like https://gitlab.example.com");
  }
  if (u.protocol !== "https:") throw new Error("The GitLab URL must start with https://");
  if (!u.hostname.includes(".") || /^[\d.]+$/.test(u.hostname) || u.hostname.startsWith("[")) throw new Error("The GitLab URL must be a public hostname, like https://gitlab.example.com");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/api/v4/`;
}

/**
 * Issues and merge requests changed since the last sync, in every project the token's
 * owner is a member of. Each is one document thread: the description (with project,
 * status, assignees and labels as its first lines) stored as a version, then its
 * comments. Private projects and confidential issues are visible only to the members
 * who can see them in GitLab; when those can't be listed, the items are skipped.
 */
export async function fetchGitlab(api: Api, cursor: GitlabCursor = {}, now = new Date()): Promise<Fetched> {
  const list = async <T>(path: string, query: Record<string, string | number | undefined>, maxPages: number) => {
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await api<T[]>("GET", path, { query: { ...query, per_page: PER_PAGE, page } });
      all.push(...r);
      if (r.length < PER_PAGE) break;
    }
    return all;
  };

  const people = new Map<string, NormalizedPerson>();
  const person = (u: User | null | undefined) => {
    if (!u || isBot(u)) return undefined;
    const key = `gitlab:${u.id}`;
    const email = (u.email || u.public_email)?.toLowerCase();
    if (!people.has(key) || (email && !people.get(key)!.email)) people.set(key, { key, provider: "gitlab", externalId: String(u.id), displayName: u.name || u.username, email });
    return key;
  };

  const members = new Map<number, Promise<Member[] | undefined>>();
  /** Everyone with access to a project, inherited and invited included. Undefined when they can't be listed. */
  const membersOf = (p: Project) => {
    if (!members.has(p.id))
      members.set(
        p.id,
        list<Member>(`projects/${p.id}/members/all`, {}, 10).then(
          (all) => {
            const active = all.filter((m) => (m.state ?? "active") === "active" && m.membership_state !== "awaiting" && m.access_level >= GUEST && !isBot(m));
            return active.length ? active : undefined;
          },
          (e) => {
            if (unreadable(e)) return undefined;
            throw e;
          },
        ),
      );
    return members.get(p.id)!;
  };

  const projects = await list<Project>("projects", { membership: "true", archived: "false", order_by: "last_activity_at", sort: "desc" }, Math.ceil(MAX_PROJECTS / PER_PAGE));
  const floor = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const since = { ...cursor.since };
  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  let count = 0;
  let answered = 0;
  let refused = 0;

  for (const project of projects) {
    if (count >= MAX_ITEMS) break;
    for (const kind of KINDS) {
      const budget = MAX_ITEMS - count;
      if (budget <= 0) break;
      const level = kind.level(project);
      if (level === "disabled") continue;
      const key = `${project.id}/${kind.path}`;
      const items: Item[] = [];
      let more = true;
      try {
        for (let page = 1; more && items.length < budget; page++) {
          const r = await api<Item[]>("GET", `projects/${project.id}/${kind.path}`, { query: { updated_after: since[key] ?? floor, order_by: "updated_at", sort: "asc", per_page: PER_PAGE, page } });
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

      const restricted = project.visibility === "private" || level === "private";
      // Restricted, and who has access can't be read: leave it out and try again next time.
      if (restricted && !(await membersOf(project))) continue;

      const read = items.slice(0, budget);
      count += read.length;
      for (const item of read) {
        if (!item.title?.trim()) continue;
        let memberKeys: string[] | undefined;
        if (item.confidential) {
          const allowed = (await membersOf(project))?.filter((m) => m.access_level >= PLANNER);
          if (!allowed) continue;
          memberKeys = [...new Set([...allowed, item.author, ...(item.assignees ?? [])].map(person).filter((k): k is string => !!k))];
        } else if (restricted) {
          memberKeys = (await membersOf(project))!.map(person).filter((k): k is string => !!k);
        }

        const id = `${kind.id}:${item.id}`;
        const title = `${project.path}${kind.mark}${item.iid} ${item.title.trim()}`;
        const names = (users: User[] | null | undefined) => (users ?? []).map((u) => u.name || u.username).join(", ");
        const due = item.due_date ?? item.milestone?.due_date;
        const head = [
          title,
          `Project: ${project.path_with_namespace}`,
          `Type: ${kind.type}`,
          `Status: ${item.state === "opened" && item.draft ? "draft" : item.state}`,
          item.assignees?.length && `Assignee: ${names(item.assignees)}`,
          item.reviewers?.length && `Reviewers: ${names(item.reviewers)}`,
          item.labels?.length && `Labels: ${item.labels.join(", ")}`,
          item.milestone && `Milestone: ${item.milestone.title}`,
          due && `Due: ${due}`,
          item.source_branch && item.target_branch && `Branch: ${item.source_branch} → ${item.target_branch}`,
          `Created: ${item.created_at.slice(0, 10)}`,
        ].filter((l): l is string => !!l);
        for (const u of [...(item.assignees ?? []), ...(item.reviewers ?? [])]) person(u);
        const externalId = `${id}@${item.updated_at}`;
        versions.set(id, externalId);
        threads.push({ externalId: id, kind: "doc", title, url: item.web_url, visibility: memberKeys ? "members" : "org", memberKeys: memberKeys ?? [] });
        messages.push({
          threadExternalId: id,
          externalId,
          kind: "note",
          authorKey: person(item.author),
          sentAt: new Date(item.updated_at),
          subject: title,
          text: [head.join("\n"), item.description?.trim()].filter(Boolean).join("\n\n"),
          url: item.web_url,
        });

        const notes = item.user_notes_count ? await list<Note>(`projects/${project.id}/${kind.path}/${item.iid}/notes`, { order_by: "created_at", sort: "asc" }, MAX_NOTE_PAGES) : [];
        for (const n of notes) {
          // System notes are activity ("changed the milestone"); internal notes are hidden from some members.
          if (n.system || n.internal || n.confidential || !n.body?.trim() || !n.author || isBot(n.author)) continue;
          messages.push({
            threadExternalId: id,
            externalId: String(n.id),
            kind: "chat",
            authorKey: person(n.author),
            sentAt: new Date(n.created_at),
            text: n.body.trim(),
            url: `${item.web_url}#note_${n.id}`,
            editedAt: n.updated_at && n.updated_at !== n.created_at ? new Date(n.updated_at) : undefined,
          });
        }
      }
      const last = Date.parse(read.at(-1)!.updated_at);
      // Cut short: carry on from the last one read. Otherwise from just after it, but never later than shortly before this sync.
      since[key] = new Date(more || read.length < items.length ? last - 1 : Math.min(last + 1, now.getTime() - OVERLAP_MS)).toISOString();
    }
  }

  if (refused && !answered) throw new ProviderError("GitLab wouldn't list issues or merge requests in any project. Give the token the read_api scope.", 403);

  // Issues carry no emails; a profile adds the public one, which links the person to other sources.
  const unknown = [...people.values()].filter((p) => !p.email).slice(0, MAX_PROFILES);
  for (const p of unknown) {
    const profile = await api<User>("GET", `users/${p.externalId}`).catch((e) => {
      if (unreadable(e)) return undefined;
      throw e;
    });
    const email = (profile?.email || profile?.public_email)?.toLowerCase();
    if (email) people.set(p.key, { ...p, email });
  }

  const next: GitlabCursor = { since };
  return { people: [...people.values()], threads, messages, versions, cursor: next as Record<string, unknown> };
}

/** GitLab issues and merge requests with their comments, read with a personal access token; gitlab.com or self-hosted. */
export const gitlab: Provider = {
  id: "gitlab",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "token", label: "Personal access token", placeholder: "glpat-…", secret: true },
      { name: "url", label: "GitLab URL", placeholder: "https://gitlab.com", optional: true },
    ],
    setup:
      "In GitLab, click your avatar → Edit profile → Access tokens, add a token with only the read_api scope, and paste it here. Fill in the GitLab URL only if your company runs its own GitLab.",
    docsUrl: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
    api: (c) => httpApi({ baseUrl: gitlabApiRoot(c.url), headers: () => ({ "private-token": c.token }) }),
  },
  async identify(api, credentials) {
    const host = new URL(gitlabApiRoot(credentials.url)).host;
    try {
      const me = await api<{ id: number; username: string; name?: string }>("GET", "user");
      return { accountId: `gitlab:${host}:${me.id}`, label: `${me.name || me.username} (${host})` };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 401) throw new Error(`${host} didn't accept that token. Check it was copied in full, hasn't expired and has the read_api scope.`);
      throw e;
    }
  },
  sync: (api, cursor, ctx) => fetchGitlab(api, cursor as GitlabCursor | undefined, ctx.now),
};
