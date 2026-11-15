import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { basic, httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before the previous one began: Jira's search index trails writes a little. */
const OVERLAP_MS = 10 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_ISSUES = 500;
const MAX_COMMENT_PAGES = 5;
const FIELDS = "summary,description,status,issuetype,assignee,reporter,priority,labels,duedate,project,security,created,updated,comment";

export interface JiraCursor {
  /** Issues updated at or after this (ISO) are read. */
  since?: string;
  /** Set while a pass was cut short by the cap: when it began, and the page to continue from. */
  started?: string;
  next?: string;
}

/** A node of Atlassian Document Format, the JSON Jira stores rich text in. */
export interface Adf {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: Adf[];
}
interface User {
  accountId?: string;
  displayName?: string;
  emailAddress?: string | null;
  accountType?: string;
}
interface Comment {
  id: string;
  author?: User | null;
  body?: Adf | string | null;
  created: string;
  updated?: string;
  /** Present when the comment is limited to a group or project role. */
  visibility?: { type: string; value?: string } | null;
}
interface Issue {
  id: string;
  key: string;
  fields: {
    summary?: string | null;
    description?: Adf | string | null;
    status?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    assignee?: User | null;
    reporter?: User | null;
    priority?: { name?: string } | null;
    labels?: string[] | null;
    duedate?: string | null;
    project: { id: string; key: string; name?: string };
    /** The issue security level, when one is set. */
    security?: { id: string } | null;
    created: string;
    updated: string;
    comment?: { comments?: Comment[]; total?: number } | null;
  };
}
interface Search {
  issues?: Issue[];
  nextPageToken?: string | null;
  isLast?: boolean;
}

/** Atlassian Document Format as plain text: paragraphs on their own lines, light marks for headings, lists and tasks. */
export function adfToText(doc: Adf | string | null | undefined): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc.trim();
  const walk = (n: Adf): string => {
    const inner = () => (n.content ?? []).map(walk).join("");
    switch (n.type) {
      case "text":
        return n.text ?? "";
      case "hardBreak":
        return "\n";
      case "mention":
      case "emoji":
      case "status":
        return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
      case "inlineCard":
        return String(n.attrs?.url ?? "");
      case "blockCard":
      case "embedCard":
        return n.attrs?.url ? `${String(n.attrs.url)}\n` : "";
      case "date":
        return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
      case "heading":
        return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inner()}\n`;
      case "listItem":
        return `- ${inner().trim()}\n`;
      case "taskItem":
        return `- [${n.attrs?.state === "DONE" ? "x" : " "}] ${inner().trim()}\n`;
      case "tableCell":
      case "tableHeader":
        return `${inner().trim()} | `;
      case "tableRow":
        return `${inner().replace(/ \| $/, "")}\n`;
      case "paragraph":
      case "codeBlock":
      case "decisionItem":
      case "rule":
        return `${inner()}\n`;
      default:
        return inner();
    }
  };
  return walk(doc)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "acme", "acme.atlassian.net" or a pasted URL, as the site's host. */
function siteOf(credentials: Record<string, string>): string {
  const host = (credentials.site ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host)) throw new Error("Enter your Atlassian site, like acme.atlassian.net.");
  return host.includes(".") ? host : `${host}.atlassian.net`;
}

/**
 * Issues changed since the last pass, oldest change first, each as one document thread:
 * the fields and description as a versioned note, then its comments. Issues with a
 * security level, issues in private projects and comments limited to a group or role
 * are left out, because who may see them can't be read with an API token.
 */
export async function fetchJira(api: Api, site: string, cursor: JiraCursor = {}, now = new Date()): Promise<Fetched> {
  const people = new Map<string, NormalizedPerson>();
  const person = (u: User | null | undefined) => {
    if (!u?.accountId || u.accountType === "app") return undefined;
    const key = `jira:${u.accountId}`;
    if (!people.has(key)) people.set(key, { key, provider: "jira", externalId: u.accountId, displayName: u.displayName || u.emailAddress || "Jira user", email: u.emailAddress?.toLowerCase() || undefined });
    return key;
  };

  const privacy = new Map<string, boolean>();
  const isPrivate = async (projectId: string) => {
    if (!privacy.has(projectId)) {
      const p = await api<{ isPrivate?: boolean }>("GET", `rest/api/3/project/${projectId}`).catch((e) => {
        if (e instanceof ProviderError && (e.status === 403 || e.status === 404)) return { isPrivate: true };
        throw e;
      });
      privacy.set(projectId, p.isPrivate === true);
    }
    return privacy.get(projectId)!;
  };

  const commentsOf = async (issue: Issue) => {
    const embedded = issue.fields.comment;
    if (embedded?.comments && embedded.total !== undefined && embedded.total <= embedded.comments.length) return embedded.comments;
    const all: Comment[] = [];
    for (let i = 0; i < MAX_COMMENT_PAGES; i++) {
      const r = await api<{ comments?: Comment[]; total?: number }>("GET", `rest/api/3/issue/${issue.id}/comment`, { query: { startAt: all.length, maxResults: 100, orderBy: "created" } });
      all.push(...(r.comments ?? []));
      if (!r.comments?.length || all.length >= (r.total ?? 0)) break;
    }
    return all;
  };

  const since = cursor.since ?? new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const resuming = !!cursor.next && !!cursor.started;
  let started = resuming ? cursor.started! : now.toISOString();
  let next = resuming ? cursor.next : undefined;
  let more = false;
  let read = 0;

  // A bare number in JQL is milliseconds since the epoch; a quoted date would be read in the token owner's time zone.
  const jql = `updated >= ${Date.parse(since)} ORDER BY updated ASC`;
  const search = (token?: string) => api<Search>("GET", "rest/api/3/search/jql", { query: { jql, fields: FIELDS, maxResults: PAGE_SIZE, nextPageToken: token } });

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await search(next).catch((e) => {
      // A saved page token Jira no longer accepts (they expire after 7 days): begin the pass again.
      if (i > 0 || !next || !(e instanceof ProviderError) || e.status !== 400) throw e;
      started = now.toISOString();
      return search();
    });
    const issues = r.issues ?? [];
    for (const issue of issues) {
      const f = issue.fields;
      if (!f.summary?.trim() || f.security || (await isPrivate(f.project.id))) continue;

      const title = `${issue.key} ${f.summary.trim()}`;
      const url = `https://${site}/browse/${issue.key}`;
      const head = [
        title,
        `Status: ${f.status?.name ?? "Unknown"}`,
        f.issuetype?.name && `Type: ${f.issuetype.name}`,
        f.assignee && `Assignee: ${f.assignee.displayName ?? "Unknown"}`,
        f.reporter && `Reporter: ${f.reporter.displayName ?? "Unknown"}`,
        f.priority?.name && `Priority: ${f.priority.name}`,
        f.labels?.length && `Labels: ${f.labels.join(", ")}`,
        f.duedate && `Due: ${f.duedate}`,
        `Project: ${f.project.name ?? f.project.key}`,
        `Created: ${f.created.slice(0, 10)}`,
      ].filter((l): l is string => !!l);
      const externalId = `${issue.id}@${f.updated}`;
      versions.set(issue.id, externalId);
      person(f.assignee);
      threads.push({ externalId: issue.id, kind: "doc", title, url, visibility: "org", memberKeys: [] });
      messages.push({
        threadExternalId: issue.id,
        externalId,
        kind: "note",
        authorKey: person(f.reporter),
        sentAt: new Date(f.updated),
        subject: title,
        text: [head.join("\n"), adfToText(f.description)].filter(Boolean).join("\n\n"),
        url,
      });
      for (const c of await commentsOf(issue)) {
        const text = adfToText(c.body);
        if (!text || c.visibility) continue;
        messages.push({
          threadExternalId: issue.id,
          externalId: c.id,
          kind: "chat",
          authorKey: person(c.author),
          sentAt: new Date(c.created),
          text,
          url: `${url}?focusedCommentId=${c.id}`,
          editedAt: c.updated && c.updated !== c.created ? new Date(c.updated) : undefined,
        });
      }
    }
    read += issues.length;
    next = r.nextPageToken ?? undefined;
    more = !!next && r.isLast !== true;
    if (!more || read >= MAX_ISSUES) break;
  }

  const after: JiraCursor = more ? { since, started, next } : { since: new Date(Date.parse(started) - OVERLAP_MS).toISOString() };
  return { people: [...people.values()], threads, messages, versions, cursor: after as Record<string, unknown> };
}

/** Jira Cloud issues and their comments, read with an Atlassian API token. */
export const jira: Provider = {
  id: "jira",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "site", label: "Jira site", placeholder: "acme.atlassian.net" },
      { name: "email", label: "Account email", placeholder: "you@company.com" },
      { name: "token", label: "API token", secret: true },
    ],
    setup:
      "Create an API token at id.atlassian.com (Security → API tokens) and paste it with your Jira site address and the email you sign in to Jira with. ALRO only reads, and it reads every project that account can open, so use an account that sees what the whole team may see.",
    docsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    api: (c) => httpApi({ baseUrl: `https://${siteOf(c)}/`, headers: basic((c.email ?? "").trim(), (c.token ?? "").trim()) }),
  },
  async identify(api, credentials) {
    const site = siteOf(credentials);
    const me = await api<{ accountId?: string }>("GET", "rest/api/3/myself").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Jira didn't accept that email and API token.");
      if (e instanceof ProviderError && e.status === 404) throw new Error(`There is no Jira site at ${site}.`);
      throw e;
    });
    if (!me.accountId) throw new Error("Jira didn't accept that email and API token.");
    return { accountId: `jira:${site}`, label: site };
  },
  async sync(api, cursor, ctx) {
    return fetchJira(api, siteOf(ctx.credentials), cursor as JiraCursor | undefined, ctx.now);
  },
};
