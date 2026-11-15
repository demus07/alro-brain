import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { basic, httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** When the export has to restart by time instead of from its cursor, it re-reads this much (seconds). */
const OVERLAP_SECONDS = 300;
const PAGE_SIZE = 100;
/** Zendesk allows 10 export requests a minute; three pages is 300 tickets a sync. */
const MAX_PAGES = 3;
/** Pages of 100 read for one ticket's comments or one group's agents. */
const MAX_LIST_PAGES = 5;
/** Wait between comment requests, to stay under the smallest plan's 200 requests a minute. */
const PAUSE_MS = 150;

export interface ZendeskCursor {
  /** Where the ticket export continues: Zendesk's own cursor. */
  cursor?: string;
  /** updated_at (Unix seconds) of the newest ticket read; the export restarts from here if Zendesk refuses the cursor. */
  since?: number;
}

interface User {
  id: number;
  name?: string | null;
  email?: string | null;
}
interface Group {
  id: number;
  name?: string;
  /** False for a private group: only its members see its tickets. */
  is_public?: boolean;
}
interface Ticket {
  id: number;
  subject?: string | null;
  raw_subject?: string | null;
  /** The first comment, as plain text. */
  description?: string | null;
  status?: string;
  priority?: string | null;
  type?: string | null;
  tags?: string[];
  group_id?: number | null;
  organization_id?: number | null;
  requester_id?: number | null;
  assignee_id?: number | null;
  due_at?: string | null;
  created_at: string;
  updated_at: string;
}
interface Export {
  tickets?: Ticket[];
  users?: User[];
  groups?: Group[];
  organizations?: { id: number; name?: string }[];
  after_cursor?: string | null;
  end_of_stream?: boolean;
}
interface Comment {
  id: number;
  author_id?: number | null;
  body?: string | null;
  plain_body?: string | null;
  /** False for an internal note. */
  public?: boolean;
  created_at: string;
}
interface Paged {
  meta?: { has_more?: boolean; after_cursor?: string | null };
}

/** "acme", "acme.zendesk.com" or a pasted URL, as the subdomain. */
function subdomainOf(credentials: Record<string, string>): string {
  const sub = (credentials.subdomain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[./].*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) throw new Error("Enter your Zendesk subdomain: the first part of acme.zendesk.com.");
  return sub;
}

const missing = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);

/**
 * Tickets changed since the last sync, from Zendesk's incremental export, each as one
 * document thread: the fields and first comment as a versioned note, then every later
 * comment, public replies and internal notes alike. Tickets in a private group are
 * visible to that group's agents only.
 */
export async function fetchZendesk(api: Api, subdomain: string, cursor: ZendeskCursor = {}, now = new Date(), pauseMs = PAUSE_MS): Promise<Fetched> {
  const users = new Map<number, User>();
  const groups = new Map<number, Group>();
  const organizations = new Map<number, string | undefined>();
  const people = new Map<string, NormalizedPerson>();
  const person = (id: number | null | undefined) => {
    const u = id ? users.get(id) : undefined;
    if (!u) return undefined;
    const key = `zendesk:${u.id}`;
    if (!people.has(key)) people.set(key, { key, provider: "zendesk", externalId: String(u.id), displayName: u.name || u.email || "Zendesk user", email: u.email?.toLowerCase() || undefined });
    return key;
  };
  const user = (id: number | null | undefined) => (id ? users.get(id) : undefined);

  const audiences = new Map<number, string[] | undefined>();
  /** The agents in a private group, or undefined when they can't be read. */
  const membersOf = async (groupId: number) => {
    if (!audiences.has(groupId)) {
      const keys: string[] = [];
      let after: string | undefined;
      let complete = false;
      for (let i = 0; i < MAX_LIST_PAGES && !complete; i++) {
        const r = await api<Paged & { users?: User[] }>("GET", `groups/${groupId}/users.json`, { query: { "page[size]": 100, "page[after]": after } }).catch((e) => {
          if (missing(e)) return undefined;
          throw e;
        });
        if (!r) break;
        for (const u of r.users ?? []) {
          users.set(u.id, u);
          keys.push(person(u.id)!);
        }
        after = r.meta?.after_cursor ?? undefined;
        complete = !r.meta?.has_more || !after;
      }
      audiences.set(groupId, complete && keys.length ? keys : undefined);
    }
    return audiences.get(groupId);
  };

  const commentsOf = async (ticketId: number) => {
    const all: Comment[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      const r = await api<Paged & { comments?: Comment[]; users?: User[] }>("GET", `tickets/${ticketId}/comments.json`, { query: { include: "users", "page[size]": 100, "page[after]": after } });
      for (const u of r.users ?? []) users.set(u.id, u);
      all.push(...(r.comments ?? []));
      after = r.meta?.after_cursor ?? undefined;
      if (!r.meta?.has_more || !after) break;
    }
    return all;
  };

  const floor = Math.floor(now.getTime() / 1000) - BACKFILL_DAYS * 86_400;
  // Zendesk refuses a start time less than a minute old.
  const restart = Math.min(cursor.since ? cursor.since - OVERLAP_SECONDS : floor, Math.floor(now.getTime() / 1000) - 120);
  const page = (from: { cursor: string } | { start_time: number }) =>
    api<Export>("GET", "incremental/tickets/cursor.json", { query: { ...from, per_page: PAGE_SIZE, include: "users,groups,organizations", exclude_deleted: "true" } });

  let position = cursor.cursor;
  let since = cursor.since;
  const tickets = new Map<number, Ticket>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await (position ? page({ cursor: position }) : page({ start_time: restart })).catch((e) => {
      // A saved cursor Zendesk no longer accepts: restart the export from the newest ticket read.
      if (i > 0 || !position || !(e instanceof ProviderError) || ![400, 404, 422].includes(e.status)) throw e;
      return page({ start_time: restart });
    });
    for (const u of r.users ?? []) users.set(u.id, u);
    for (const g of r.groups ?? []) groups.set(g.id, g);
    for (const o of r.organizations ?? []) organizations.set(o.id, o.name);
    for (const t of r.tickets ?? []) {
      tickets.set(t.id, t);
      since = Math.max(since ?? 0, Math.floor(Date.parse(t.updated_at) / 1000) || 0);
    }
    position = r.after_cursor ?? position;
    if (r.end_of_stream !== false || !r.after_cursor) break;
  }

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const t of tickets.values()) {
    const subject = (t.subject || t.raw_subject || "").trim();
    if (t.status === "deleted" || (!subject && !t.description?.trim())) continue;
    const group = t.group_id ? groups.get(t.group_id) : undefined;
    const members = group?.is_public === false ? await membersOf(group.id) : [];
    if (!members) continue;

    const id = String(t.id);
    const title = `#${id} ${subject || "(no subject)"}`;
    const url = `https://${subdomain}.zendesk.com/agent/tickets/${id}`;
    const [first, ...replies] = await commentsOf(t.id);
    const requester = user(t.requester_id);
    const assignee = user(t.assignee_id);
    const head = [
      title,
      `Status: ${t.status ?? "unknown"}`,
      t.priority && `Priority: ${t.priority}`,
      t.type && `Type: ${t.type}`,
      requester && `Requester: ${requester.name && requester.email ? `${requester.name} (${requester.email.toLowerCase()})` : requester.name || requester.email}`,
      t.organization_id && organizations.get(t.organization_id) && `Organization: ${organizations.get(t.organization_id)}`,
      assignee && `Assignee: ${assignee.name || assignee.email}`,
      group?.name && `Group: ${group.name}`,
      t.tags?.length && `Tags: ${t.tags.join(", ")}`,
      t.due_at && `Due: ${t.due_at.slice(0, 10)}`,
      `Created: ${t.created_at.slice(0, 10)}`,
    ].filter((l): l is string => !!l);
    const externalId = `${id}@${t.updated_at}`;
    versions.set(id, externalId);
    person(t.requester_id);
    person(t.assignee_id);
    threads.push({ externalId: id, kind: "doc", title, url, visibility: members.length ? "members" : "org", memberKeys: members });
    messages.push({
      threadExternalId: id,
      externalId,
      kind: "note",
      authorKey: person(first?.author_id ?? t.requester_id),
      sentAt: new Date(t.updated_at),
      subject: title,
      text: [head.join("\n"), (t.description ?? first?.plain_body ?? first?.body ?? "").trim()].filter(Boolean).join("\n\n"),
      url,
    });
    for (const c of replies) {
      const text = (c.plain_body ?? c.body ?? "").trim();
      if (!text) continue;
      messages.push({ threadExternalId: id, externalId: String(c.id), kind: "chat", authorKey: person(c.author_id), sentAt: new Date(c.created_at), text: c.public === false ? `Internal note: ${text}` : text, url });
    }
  }

  return { people: [...people.values()], threads, messages, versions, cursor: { cursor: position, since } };
}

/** Zendesk Support tickets and their comments, read with an admin's API token. */
export const zendesk: Provider = {
  id: "zendesk",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "subdomain", label: "Zendesk subdomain", placeholder: "acme (from acme.zendesk.com)" },
      { name: "email", label: "Admin email", placeholder: "you@company.com" },
      { name: "token", label: "API token", secret: true },
    ],
    setup:
      "In Zendesk Admin Center, open Apps and integrations → APIs → API tokens, add a token and paste it with your subdomain and the email of an admin (Zendesk only lets admins export tickets). ALRO only reads tickets and their comments.",
    docsUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858",
    api: (c) => httpApi({ baseUrl: `https://${subdomainOf(c)}.zendesk.com/api/v2/`, headers: basic(`${(c.email ?? "").trim()}/token`, (c.token ?? "").trim()) }),
  },
  async identify(api, credentials) {
    const subdomain = subdomainOf(credentials);
    const refused = "Zendesk didn't accept that email and API token.";
    const me = await api<{ user?: { id?: number | null; role?: string } }>("GET", "users/me.json").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error(refused);
      if (e instanceof ProviderError && e.status === 404) throw new Error(`There is no Zendesk account at ${subdomain}.zendesk.com.`);
      throw e;
    });
    // Zendesk answers this call for anyone; a refused token comes back as the anonymous user.
    if (!me.user?.id) throw new Error(refused);
    if (me.user.role !== "admin") throw new Error("That Zendesk user isn't an admin, and Zendesk only lets admins export tickets. Use an admin's email and API token.");
    return { accountId: `zendesk:${subdomain}`, label: `${subdomain}.zendesk.com` };
  },
  async sync(api, cursor, ctx) {
    return fetchZendesk(api, subdomainOf(ctx.credentials), cursor as ZendeskCursor | undefined, ctx.now);
  },
};
