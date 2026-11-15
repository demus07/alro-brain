import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before the previous one began, to cover clock differences with Linear. */
const OVERLAP_MS = 10 * 60_000;
/** 25 issues with 50 comments each stays well under Linear's 10,000-point limit per query. */
const PAGE_SIZE = 25;
const MAX_PAGES = 20;
const MAX_COMMENTS = 250;

export interface LinearCursor {
  /** Issues updated after this are read. */
  since?: string;
  /** Set while a pass was cut short by the cap: when it began, and the page to continue from. */
  started?: string;
  after?: string;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}
interface User {
  id: string;
  name?: string | null;
  email?: string | null;
  active?: boolean;
}
interface Team {
  id: string;
  private?: boolean;
  parent?: { id: string } | null;
}
interface Comment {
  id: string;
  body?: string | null;
  url?: string;
  createdAt: string;
  editedAt?: string | null;
  user?: User | null;
  parent?: { id: string } | null;
}
interface Issue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  dueDate?: string | null;
  priorityLabel?: string | null;
  state?: { name: string } | null;
  assignee?: User | null;
  creator?: User | null;
  team: { id: string; name: string };
  project?: { name: string } | null;
  labels?: { nodes: { name: string }[] };
  comments: { nodes: Comment[]; pageInfo: PageInfo };
}

const USER = "id name email";
const COMMENTS = `nodes { id body url createdAt editedAt user { ${USER} } parent { id } } pageInfo { hasNextPage endCursor }`;
const ISSUES_QUERY = `query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter) {
    nodes {
      id identifier title description url createdAt updatedAt dueDate priorityLabel
      state { name } assignee { ${USER} } creator { ${USER} } team { id name } project { name }
      labels(first: 20) { nodes { name } }
      comments(first: 50) { ${COMMENTS} }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
const COMMENTS_QUERY = `query IssueComments($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { ${COMMENTS} } } }`;
const TEAMS_QUERY = `query Teams($after: String) { teams(first: 100, after: $after) { nodes { id private parent { id } } pageInfo { hasNextPage endCursor } } }`;
const MEMBERS_QUERY = `query TeamMembers($id: String!, $after: String) { team(id: $id) { members(first: 100, after: $after) { nodes { ${USER} active } pageInfo { hasNextPage endCursor } } } }`;
const ACCOUNT_QUERY = `query Account { viewer { id name } organization { id name urlKey } }`;

/** One GraphQL call. Linear reports most failures in an `errors` array on a 200. */
async function gql<T>(api: Api, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await api<{ data?: T; errors?: { message: string }[] }>("POST", "graphql", { body: { query, variables } });
  if (r.errors?.length || !r.data) throw new Error(`Linear: ${r.errors?.map((e) => e.message).join("; ") || "empty response"}`);
  return r.data;
}

/**
 * Issues changed since the last sync, each as one document thread: the description
 * (with status, assignee, labels and so on as its first lines) stored as a version,
 * then its comments. Issues of private teams are visible to those teams' members only.
 */
export async function fetchLinear(api: Api, cursor: LinearCursor = {}, now = new Date()): Promise<Fetched> {
  const people = new Map<string, NormalizedPerson>();
  const person = (u: User | null | undefined) => {
    if (!u) return undefined;
    const key = `linear:${u.id}`;
    if (!people.has(key)) people.set(key, { key, provider: "linear", externalId: u.id, displayName: u.name || u.email || "Linear user", email: u.email?.toLowerCase() || undefined });
    return key;
  };

  const teams = new Map<string, Team>();
  for (let i = 0, after: string | undefined; i < 10; i++) {
    const r = await gql<{ teams: { nodes: Team[]; pageInfo: PageInfo } }>(api, TEAMS_QUERY, { after });
    for (const t of r.teams.nodes) teams.set(t.id, t);
    if (!r.teams.pageInfo.hasNextPage || !r.teams.pageInfo.endCursor) break;
    after = r.teams.pageInfo.endCursor;
  }
  const members = new Map<string, Promise<string[]>>();
  const membersOf = (teamId: string) => {
    if (!members.has(teamId))
      members.set(
        teamId,
        (async () => {
          const keys: string[] = [];
          for (let i = 0, after: string | undefined; i < 10; i++) {
            const r = await gql<{ team: { members: { nodes: User[]; pageInfo: PageInfo } } }>(api, MEMBERS_QUERY, { id: teamId, after });
            for (const u of r.team.members.nodes) if (u.active !== false) keys.push(person(u)!);
            if (!r.team.members.pageInfo.hasNextPage || !r.team.members.pageInfo.endCursor) break;
            after = r.team.members.pageInfo.endCursor;
          }
          return keys;
        })(),
      );
    return members.get(teamId)!;
  };
  /**
   * Who can see a team's issues: "org", or the members of the team and of its parents
   * up to the private one (a team inside a private team is restricted too).
   * Undefined when the members can't be read.
   */
  const audience = async (teamId: string): Promise<"org" | string[] | undefined> => {
    const chain: string[] = [];
    let restricted = false;
    for (let id: string | undefined = teamId; id && !chain.includes(id); id = teams.get(id)?.parent?.id) {
      const t = teams.get(id);
      if (t) chain.push(id);
      if (!t || t.private) {
        restricted = true;
        break;
      }
    }
    if (!restricted) return "org";
    try {
      const keys = (await Promise.all(chain.map(membersOf))).flat();
      return keys.length ? [...new Set(keys)] : undefined;
    } catch {
      return undefined;
    }
  };

  const since = cursor.since ?? new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  let started = cursor.after && cursor.started ? cursor.started : now.toISOString();
  let after = cursor.after;
  let more = false;

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  // Linear lists newest-created first; filtering by updatedAt keeps the pages stable while they are read.
  const read = (from?: string) => gql<{ issues: { nodes: Issue[]; pageInfo: PageInfo } }>(api, ISSUES_QUERY, { first: PAGE_SIZE, after: from, filter: { updatedAt: { gt: since } } });
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await read(after).catch((e) => {
      // A saved page marker Linear no longer accepts: begin the pass again.
      if (i > 0 || !after || (e instanceof ProviderError && e.status !== 400)) throw e;
      started = now.toISOString();
      return read();
    });
    for (const issue of r.issues.nodes) {
      const who = await audience(issue.team.id);
      if (!who || !issue.title?.trim()) continue;

      let comments = issue.comments.nodes;
      for (let info = issue.comments.pageInfo; info.hasNextPage && info.endCursor && comments.length < MAX_COMMENTS; ) {
        const next = await gql<{ issue: { comments: { nodes: Comment[]; pageInfo: PageInfo } } }>(api, COMMENTS_QUERY, { id: issue.id, after: info.endCursor });
        comments = [...comments, ...next.issue.comments.nodes];
        info = next.issue.comments.pageInfo;
      }

      const title = `${issue.identifier} ${issue.title.trim()}`;
      const labels = issue.labels?.nodes.map((l) => l.name) ?? [];
      const head = [
        title,
        `Status: ${issue.state?.name ?? "Unknown"}`,
        issue.assignee && `Assignee: ${issue.assignee.name || issue.assignee.email}`,
        issue.priorityLabel && issue.priorityLabel !== "No priority" && `Priority: ${issue.priorityLabel}`,
        labels.length && `Labels: ${labels.join(", ")}`,
        issue.dueDate && `Due: ${issue.dueDate}`,
        issue.project && `Project: ${issue.project.name}`,
        `Team: ${issue.team.name}`,
        `Created: ${issue.createdAt.slice(0, 10)}`,
      ].filter((l): l is string => !!l);
      const externalId = `${issue.id}@${issue.updatedAt}`;
      versions.set(issue.id, externalId);
      threads.push({ externalId: issue.id, kind: "doc", title, url: issue.url, visibility: who === "org" ? "org" : "members", memberKeys: who === "org" ? [] : who });
      messages.push({
        threadExternalId: issue.id,
        externalId,
        kind: "note",
        authorKey: person(issue.creator),
        sentAt: new Date(issue.updatedAt),
        subject: title,
        text: [head.join("\n"), issue.description?.trim()].filter(Boolean).join("\n\n"),
        url: issue.url,
      });
      for (const c of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!c.body?.trim()) continue;
        messages.push({
          threadExternalId: issue.id,
          externalId: c.id,
          kind: "chat",
          authorKey: person(c.user),
          sentAt: new Date(c.createdAt),
          text: c.body.trim(),
          url: c.url ?? issue.url,
          replyToExternalId: c.parent?.id,
          editedAt: c.editedAt ? new Date(c.editedAt) : undefined,
        });
      }
    }
    more = r.issues.pageInfo.hasNextPage && !!r.issues.pageInfo.endCursor;
    after = r.issues.pageInfo.endCursor ?? undefined;
    if (!more) break;
  }

  const next: LinearCursor = more ? { since, started, after } : { since: new Date(Date.parse(started) - OVERLAP_MS).toISOString() };
  return { people: [...people.values()], threads, messages, versions, cursor: next as Record<string, unknown> };
}

/** Linear issues and their comments, read with a personal API key. */
export const linear: Provider = {
  id: "linear",
  scope: "org",
  auth: {
    kind: "token",
    fields: [{ name: "token", label: "API key", placeholder: "lin_api_…", secret: true }],
    setup: "In Linear, open Settings → Security & access → Personal API keys, create a key (Read permission is all it needs) and paste it here. ALRO reads the issues and comments of every team that key's owner can see.",
    docsUrl: "https://linear.app/developers/graphql",
    // Linear takes a personal API key bare, without "Bearer".
    api: (c) => httpApi({ baseUrl: "https://api.linear.app/", headers: () => ({ authorization: c.token }) }),
  },
  async identify(api) {
    try {
      const r = await gql<{ viewer: { id: string; name?: string }; organization: { id: string; name?: string; urlKey?: string } }>(api, ACCOUNT_QUERY);
      return { accountId: `linear:${r.organization.id}`, label: r.organization.name ?? r.organization.urlKey };
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Linear didn't accept that API key. Check it was copied in full and hasn't been revoked.");
      throw e;
    }
  },
  sync: (api, cursor, ctx) => fetchLinear(api, cursor as LinearCursor | undefined, ctx.now),
};
