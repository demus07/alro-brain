import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { bearer, httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before the previous one began, to cover clock differences with Asana. */
const OVERLAP_MS = 10 * 60_000;
/** Tasks read per sync (each costs one more call for its comments); the next sync carries on. */
const MAX_TASKS = 300;
const MAX_PAGES = 20;
const MAX_COMMENT_PAGES = 3;
const PER_PAGE = 100;
const TASK_FIELDS = "name,notes,completed,completed_at,assignee.name,due_on,due_at,created_at,modified_at,created_by.name,permalink_url,projects,memberships.project.name,memberships.section.name,tags.name";

export interface AsanaCursor {
  /** Tasks modified after this are read. */
  since?: string;
  /** Set while a pass was cut short by the cap: when it began, the project to continue from (they are read in id order) and the page within it. */
  started?: string;
  project?: string;
  offset?: string;
}

interface Paged<T> {
  data: T;
  next_page?: { offset?: string } | null;
}
interface User {
  gid: string;
  name?: string;
  email?: string | null;
}
interface Project {
  gid: string;
  name?: string;
  privacy_setting?: "public_to_workspace" | "private_to_team" | "private";
  team?: { gid: string } | null;
}
interface Task {
  gid: string;
  name?: string;
  notes?: string | null;
  completed?: boolean;
  completed_at?: string | null;
  assignee?: User | null;
  due_on?: string | null;
  due_at?: string | null;
  created_at: string;
  modified_at: string;
  created_by?: User | null;
  permalink_url?: string;
  projects?: { gid: string }[];
  memberships?: { project?: { gid: string; name?: string } | null; section?: { name?: string } | null }[];
  tags?: { name?: string }[];
}
interface Story {
  gid: string;
  resource_subtype?: string;
  text?: string | null;
  created_at: string;
  created_by?: User | null;
}

/** Gone or not shared with this account: skip it rather than fail the sync. */
const unreadable = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);
/** Asana ids are numbers too long for a JS number; shorter is smaller, then digit by digit. */
const byGid = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Tasks changed since the last sync, in every project of one workspace that the token's
 * owner can see. Each task is one document thread: its notes (with status, assignee,
 * due date and project as the first lines) stored as a version, then its comments.
 * A task is visible to the workspace when any of its projects is; otherwise only to
 * the members of its projects.
 */
export async function fetchAsana(api: Api, workspace: string, cursor: AsanaCursor = {}, now = new Date()): Promise<Fetched> {
  const page = <T>(path: string, query: Record<string, string | number | undefined>) => api<Paged<T[]>>("GET", path, { query: { ...query, limit: PER_PAGE } });
  const list = async <T>(path: string, query: Record<string, string | number | undefined>, maxPages = MAX_PAGES) => {
    const all: T[] = [];
    for (let i = 0, offset: string | undefined; i < maxPages; i++) {
      const r = await page<T>(path, { ...query, offset });
      all.push(...r.data);
      offset = r.next_page?.offset;
      if (!offset) break;
    }
    return all;
  };

  const directory = new Map((await list<User>("users", { workspace, opt_fields: "name,email" })).map((u) => [u.gid, u]));
  const people = new Map<string, NormalizedPerson>();
  const person = (u: User | null | undefined) => {
    if (!u) return undefined;
    const key = `asana:${u.gid}`;
    const known = directory.get(u.gid) ?? u;
    if (!people.has(key)) people.set(key, { key, provider: "asana", externalId: u.gid, displayName: known.name || known.email || "Asana user", email: known.email?.toLowerCase() || undefined });
    return key;
  };
  const nameOf = (u: User) => directory.get(u.gid)?.name || u.name || "Someone";

  const projects = new Map((await list<Project>("projects", { workspace, archived: "false", opt_fields: "name,privacy_setting,team" })).map((p) => [p.gid, p]));
  const members = new Map<string, Promise<string[] | undefined>>();
  /** Who can see a project that isn't open to the workspace: its members, plus the team's for a team-private one. Undefined when they can't be listed. */
  const membersOf = (p: Project) => {
    if (!members.has(p.gid))
      members.set(
        p.gid,
        (async () => {
          const full = await api<{ data: { members?: User[] } }>("GET", `projects/${p.gid}`, { query: { opt_fields: "members.name" } });
          const team = p.privacy_setting === "private_to_team" && p.team ? await list<User>(`teams/${p.team.gid}/users`, { opt_fields: "name,email" }) : [];
          const keys = [...(full.data.members ?? []), ...team].map((u) => person(u)!);
          return keys.length ? [...new Set(keys)] : undefined;
        })().catch((e) => {
          if (unreadable(e)) return undefined;
          throw e;
        }),
      );
    return members.get(p.gid)!;
  };

  const since = cursor.since ?? new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const started = cursor.started ?? now.toISOString();
  const from = cursor.started ? cursor.project : undefined;
  const todo = [...projects.keys()].sort(byGid).filter((gid) => !from || byGid(gid, from) >= 0);
  const tasks = new Map<string, Task>();
  let count = 0;
  let next: AsanaCursor | undefined;
  for (const project of todo) {
    if (!next && count >= MAX_TASKS) next = { since, started, project };
    if (next) break;
    for (let offset = project === from ? cursor.offset : undefined; ; ) {
      const query = { project, modified_since: since, opt_fields: TASK_FIELDS };
      let r: Paged<Task[]>;
      try {
        r = await page<Task>("tasks", { ...query, offset }).catch((e) => {
          // A saved page marker Asana has expired: read the project from its start.
          if (!offset || !(e instanceof ProviderError && e.status === 400)) throw e;
          return page<Task>("tasks", query);
        });
      } catch (e) {
        if (unreadable(e)) break;
        throw e;
      }
      for (const t of r.data) tasks.set(t.gid, t);
      count += r.data.length;
      offset = r.next_page?.offset;
      if (!offset) break;
      if (count >= MAX_TASKS) {
        next = { since, started, project, offset };
        break;
      }
    }
  }

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const task of tasks.values()) {
    const title = task.name?.trim();
    if (!title) continue;
    const homes = (task.projects ?? []).map((p) => projects.get(p.gid)).filter((p): p is Project => !!p);
    let memberKeys: string[] | undefined;
    if (!homes.some((p) => p.privacy_setting === "public_to_workspace")) {
      memberKeys = [...new Set((await Promise.all(homes.map(membersOf))).flatMap((keys) => keys ?? []))];
      // Restricted, and who has access can't be read: leave it out.
      if (!memberKeys.length) continue;
    }

    const url = task.permalink_url;
    const where = (task.memberships ?? [])
      .filter((m) => m.project?.name)
      .map((m) => (m.section?.name && !/^untitled section$/i.test(m.section.name) ? `${m.project!.name} › ${m.section.name}` : m.project!.name));
    const tags = (task.tags ?? []).map((t) => t.name).filter(Boolean);
    const due = task.due_on ?? task.due_at?.slice(0, 10);
    const head = [
      title,
      `Status: ${task.completed ? `Completed${task.completed_at ? ` ${task.completed_at.slice(0, 10)}` : ""}` : "Open"}`,
      task.assignee && `Assignee: ${nameOf(task.assignee)}`,
      due && `Due: ${due}`,
      where.length && `Project: ${where.join(", ")}`,
      tags.length && `Tags: ${tags.join(", ")}`,
      `Created: ${task.created_at.slice(0, 10)}`,
    ].filter((l): l is string => !!l);
    person(task.assignee);
    const externalId = `${task.gid}@${task.modified_at}`;
    versions.set(task.gid, externalId);
    threads.push({ externalId: task.gid, kind: "doc", title, url, visibility: memberKeys ? "members" : "org", memberKeys: memberKeys ?? [] });
    messages.push({
      threadExternalId: task.gid,
      externalId,
      kind: "note",
      authorKey: person(task.created_by),
      sentAt: new Date(task.modified_at),
      subject: title,
      text: [head.join("\n"), task.notes?.trim()].filter(Boolean).join("\n\n"),
      url,
    });

    const stories = await list<Story>(`tasks/${task.gid}/stories`, { resource_subtype: "comment_added", opt_fields: "resource_subtype,text,created_at,created_by.name" }, MAX_COMMENT_PAGES);
    for (const s of stories) {
      if (s.resource_subtype !== "comment_added" || !s.text?.trim()) continue;
      messages.push({ threadExternalId: task.gid, externalId: s.gid, kind: "chat", authorKey: person(s.created_by), sentAt: new Date(s.created_at), text: s.text.trim(), url });
    }
  }

  next ??= { since: new Date(Date.parse(started) - OVERLAP_MS).toISOString() };
  return { people: [...people.values()], threads, messages, versions, cursor: next as Record<string, unknown> };
}

/** Asana tasks and their comments, read with a personal access token, for one workspace. */
export const asana: Provider = {
  id: "asana",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "token", label: "Personal access token", placeholder: "2/1200…", secret: true },
      { name: "workspace", label: "Workspace name", placeholder: "Only if you belong to more than one", optional: true },
    ],
    setup:
      "In Asana, open the developer console (app.asana.com/0/my-apps), create a personal access token and paste it here. Asana tokens can't be limited to read-only, but ALRO only reads: the tasks and comments in projects the token's owner can see.",
    docsUrl: "https://developers.asana.com/docs/personal-access-token",
    api: (c) => httpApi({ baseUrl: "https://app.asana.com/api/1.0/", headers: bearer(c.token) }),
  },
  async identify(api, credentials) {
    let workspaces: { gid: string; name: string }[];
    try {
      workspaces = (await api<{ data: { workspaces?: { gid: string; name: string }[] } }>("GET", "users/me", { query: { opt_fields: "name,workspaces.name" } })).data.workspaces ?? [];
    } catch (e) {
      if (e instanceof ProviderError && e.status === 401) throw new Error("Asana didn't accept that token. Check it was copied in full and hasn't been revoked.");
      throw e;
    }
    const wanted = credentials.workspace?.trim().toLowerCase();
    const names = workspaces.map((w) => w.name).join(", ");
    const matches = wanted ? workspaces.filter((w) => w.name.toLowerCase() === wanted || w.gid === wanted) : workspaces;
    if (!matches.length) throw new Error(wanted ? `That token can't see a workspace called "${credentials.workspace}". It can see: ${names}.` : "That Asana account isn't in any workspace.");
    if (matches.length > 1) throw new Error(`That account is in more than one Asana workspace (${names}). Fill in the workspace name to pick one.`);
    return { accountId: `asana:${matches[0].gid}`, label: matches[0].name };
  },
  sync: (api, cursor, ctx) => fetchAsana(api, ctx.accountId.replace(/^asana:/, ""), cursor as AsanaCursor | undefined, ctx.now),
};
