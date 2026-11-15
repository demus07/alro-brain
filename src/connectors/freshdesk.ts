import { tool } from "ai";
import { z } from "zod";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { basic, httpApi, ProviderError, type Api } from "./api";
import type { ActionDef, Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** A later sync re-reads this much before the newest ticket it saw (seconds). */
const OVERLAP_SECONDS = 300;
const PAGE_SIZE = 100;
/** Growth plans allow 40 ticket-list calls and 100 calls in all a minute; two pages is 200 tickets a sync. */
const MAX_PAGES = 2;
/** Freshdesk returns at most 300 pages of one listing. */
const PAGE_LIMIT = 300;
/** Pages of 100 read for one ticket's conversations, or for the agent and group lists. */
const MAX_LIST_PAGES = 5;
/** Wait between conversation requests, to stay under the Growth plan's 100 calls a minute. */
const PAUSE_MS = 700;

export interface FreshdeskCursor {
  /** updated_at of the newest ticket read (ISO). */
  since?: string;
  /** The last sync stopped at its cap with more tickets waiting: continue from `since` without the overlap. */
  more?: boolean;
  /** Only when a whole capped sync read tickets changed in the same second: the page to continue from. */
  page?: number;
}

interface Contact {
  id: number;
  name?: string | null;
  email?: string | null;
}
interface Agent {
  id: number;
  contact?: { name?: string | null; email?: string | null };
}
interface Ticket {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  status?: number;
  priority?: number;
  type?: string | null;
  tags?: string[];
  group_id?: number | null;
  responder_id?: number | null;
  requester_id?: number | null;
  company_id?: number | null;
  due_by?: string | null;
  spam?: boolean;
  deleted?: boolean;
  created_at: string;
  updated_at: string;
  /** With include=requester. */
  requester?: Contact | null;
  /** With include=company (one ticket only). */
  company?: { id: number; name?: string | null } | null;
}
interface Conversation {
  id: number;
  body_text?: string | null;
  /** True for a private note: agents only. */
  private?: boolean;
  /** True when the customer wrote it. */
  incoming?: boolean;
  /** 0 a reply, 2 a note; other numbers for tweets, surveys, forwards and calls. */
  source?: number;
  user_id?: number | null;
  from_email?: string | null;
  created_at: string;
}

const STATUS: Record<number, string> = { 2: "open", 3: "pending", 4: "resolved", 5: "closed" };
const PRIORITY: Record<number, string> = { 1: "low", 2: "medium", 3: "high", 4: "urgent" };
const statusName = (n?: number) => (n === undefined ? "unknown" : (STATUS[n] ?? `custom status ${n}`));
const done = (n?: number) => n === 4 || n === 5;

/** "acme", "acme.freshdesk.com" or a pasted URL, as the helpdesk's host. */
export function domainOf(credentials: Record<string, string>): string {
  let d = (credentials.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(d)) d += ".freshdesk.com";
  if (!/^[a-z0-9][a-z0-9-]*\.freshdesk\.com$/.test(d)) throw new Error("Enter your Freshdesk address, like acme.freshdesk.com (not a custom support domain).");
  return d;
}

const missing = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);
/** Freshdesk wants seconds, not milliseconds. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** `"Priya Shah" <priya@x.com>` or `priya@x.com`, as a lower-cased address. */
const emailIn = (s?: string | null) => s?.match(/[^\s<>"]+@[^\s<>"]+/)?.[0].toLowerCase();
const ticketUrl = (domain: string, id: number | string) => `https://${domain}/a/tickets/${id}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain text as HTML paragraphs, for reply and note bodies. */
export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Every page of a Freshdesk listing (arrays with no "next" in the body), up to `maxPages`. */
async function listAll<T>(api: Api, path: string, maxPages = MAX_LIST_PAGES, pauseMs = 0): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    const r = await api<T[]>("GET", path, { query: { per_page: PAGE_SIZE, page } });
    all.push(...(Array.isArray(r) ? r : []));
    if (!Array.isArray(r) || r.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Tickets changed since the last sync, each as one document thread: the fields and description
 * as a versioned note, then every reply and private note. Freshdesk has no private groups: an
 * agent's ticket scope limits what that agent sees, not who a ticket belongs to, and private notes
 * are shown to every agent on the ticket. So, like Zendesk tickets in public groups, tickets and
 * their notes are visible to the whole company; notes are marked "Internal note".
 */
export async function fetchFreshdesk(api: Api, domain: string, cursor: FreshdeskCursor = {}, now = new Date(), pauseMs = PAUSE_MS): Promise<Fetched> {
  const people = new Map<string, NormalizedPerson>();
  const known = new Map<number, { name?: string | null; email?: string | null }>();
  const person = (id: number | null | undefined, fallbackEmail?: string) => {
    const u = id ? known.get(id) : undefined;
    const email = u?.email?.toLowerCase() || fallbackEmail;
    if (!id || (!u && !email)) return undefined;
    const key = `freshdesk:${id}`;
    if (!people.has(key)) people.set(key, { key, provider: "freshdesk", externalId: String(id), displayName: u?.name || email || "Freshdesk user", email: email || undefined });
    return key;
  };

  for (const a of await listAll<Agent>(api, "agents").catch((e) => (missing(e) ? [] : Promise.reject(e)))) known.set(a.id, { name: a.contact?.name, email: a.contact?.email });
  const groups = new Map((await listAll<{ id: number; name?: string }>(api, "groups").catch((e) => (missing(e) ? [] : Promise.reject(e)))).map((g) => [g.id, g.name]));
  const companies = new Map<number, string | undefined>();
  const companyName = async (id: number) => {
    if (!companies.has(id)) {
      const c = await api<{ name?: string }>("GET", `companies/${id}`).catch((e) => (missing(e) ? undefined : Promise.reject(e)));
      companies.set(id, c?.name || undefined);
    }
    return companies.get(id);
  };

  const floor = now.getTime() - BACKFILL_DAYS * 86_400_000;
  const since = cursor.since ? Date.parse(cursor.since) : undefined;
  const from = since === undefined ? floor : cursor.more ? since : since - OVERLAP_SECONDS * 1000;
  const first = cursor.page ?? 1;

  const tickets = new Map<number, Ticket>();
  let page = first;
  let more = false;
  for (; page < first + MAX_PAGES && page <= PAGE_LIMIT; page++) {
    const r = await api<Ticket[]>("GET", "tickets", { query: { updated_since: iso(from), order_by: "updated_at", order_type: "asc", per_page: PAGE_SIZE, page, include: "requester,description" } });
    for (const t of r ?? []) tickets.set(t.id, t);
    more = (r?.length ?? 0) >= PAGE_SIZE && page < PAGE_LIMIT;
    if (!more) break;
  }
  const newest = Math.max(since ?? 0, ...[...tickets.values()].map((t) => Date.parse(t.updated_at) || 0));
  // Every ticket read changed in the same second as the start: page on, or the next sync would read them again.
  const stuck = more && newest <= from;
  const next: Record<string, unknown> = stuck ? { since: iso(from), more: true, page } : { since: newest ? iso(newest) : cursor.since, ...(more ? { more: true } : {}) };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const t of tickets.values()) {
    const subject = (t.subject ?? "").trim();
    if (t.spam || t.deleted || (!subject && !t.description_text?.trim())) continue;
    if (t.requester) known.set(t.requester.id, t.requester);

    const id = String(t.id);
    const title = `#${id} ${subject || "(no subject)"}`;
    const url = ticketUrl(domain, id);
    const requester = t.requester_id ? known.get(t.requester_id) : undefined;
    const agent = t.responder_id ? known.get(t.responder_id) : undefined;
    const company = t.company_id ? await companyName(t.company_id) : undefined;
    const head = [
      title,
      `Status: ${statusName(t.status)}`,
      t.priority && PRIORITY[t.priority] && `Priority: ${PRIORITY[t.priority]}`,
      t.type && `Type: ${t.type}`,
      requester && `Requester: ${requester.name && requester.email ? `${requester.name} (${requester.email.toLowerCase()})` : requester.name || requester.email}`,
      company && `Company: ${company}`,
      agent && `Agent: ${agent.name || agent.email}`,
      t.group_id && groups.get(t.group_id) && `Group: ${groups.get(t.group_id)}`,
      t.tags?.length && `Tags: ${t.tags.join(", ")}`,
      t.due_by && `Due: ${t.due_by.slice(0, 10)}`,
      `Created: ${t.created_at.slice(0, 10)}`,
    ].filter((l): l is string => !!l);

    const conversations = await listAll<Conversation>(api, `tickets/${t.id}/conversations`, MAX_LIST_PAGES, pauseMs);
    const externalId = `${id}@${t.updated_at}`;
    versions.set(id, externalId);
    person(t.responder_id);
    threads.push({ externalId: id, kind: "doc", title, url, visibility: "org", memberKeys: [] });
    messages.push({
      threadExternalId: id,
      externalId,
      kind: "note",
      authorKey: person(t.requester_id),
      sentAt: new Date(t.updated_at),
      subject: title,
      text: [head.join("\n"), (t.description_text ?? "").trim()].filter(Boolean).join("\n\n"),
      url,
    });
    for (const c of conversations) {
      const text = (c.body_text ?? "").trim();
      if (!text) continue;
      messages.push({ threadExternalId: id, externalId: String(c.id), kind: "chat", authorKey: person(c.user_id, c.incoming ? emailIn(c.from_email) : undefined), sentAt: new Date(c.created_at), text: c.private ? `Internal note: ${text}` : text, url });
    }
  }

  return { people: [...people.values()], threads, messages, versions, cursor: next };
}

/** A ticket in a list, trimmed for the agent. */
const brief = (domain: string, t: Ticket) => ({
  id: t.id,
  subject: t.subject ?? "",
  status: statusName(t.status),
  priority: t.priority ? PRIORITY[t.priority] : undefined,
  requester: t.requester ? { name: t.requester.name ?? undefined, email: t.requester.email?.toLowerCase() ?? undefined } : undefined,
  due: t.due_by ?? undefined,
  overdue: !!t.due_by && Date.parse(t.due_by) < Date.now() && !done(t.status),
  updated: t.updated_at,
  url: ticketUrl(domain, t.id),
});

const ticketId = z.number().int().positive().describe("The Freshdesk ticket number, e.g. 123 for #123.");
const textBody = z.string().min(1);

interface Post {
  ticket_id: number;
  body: string;
}

/** Post a public reply or a private note on a ticket, as the connected agent. */
function post(kind: "reply" | "note"): ActionDef<Post> {
  const reply = kind === "reply";
  return {
    description: reply
      ? "Send a public reply on a Freshdesk ticket. The requester gets it by email. Write the reply text a support agent would send."
      : "Add a private note to a Freshdesk ticket: only agents see it, the customer doesn't.",
    input: z.object({ ticket_id: ticketId, body: textBody.describe(reply ? "The reply to the customer, as plain text." : "The note, as plain text.") }),
    audience: () => (reply ? "external" : "internal"),
    summary: (i) => `${reply ? "Freshdesk reply to the requester" : "Private Freshdesk note"} on ticket #${i.ticket_id}`,
    body: (i) => i.body,
    withBody: (i, body) => ({ ...i, body }),
    async run(api, i, ctx) {
      const domain = domainOf(ctx.credentials);
      await api("POST", `tickets/${i.ticket_id}/${reply ? "reply" : "notes"}`, { body: reply ? { body: toHtml(i.body) } : { body: toHtml(i.body), private: true } });
      return { url: ticketUrl(domain, i.ticket_id), detail: reply ? `Replied on Freshdesk ticket #${i.ticket_id}.` : `Added a private note to Freshdesk ticket #${i.ticket_id}.` };
    },
  };
}

/** Freshdesk tickets with their replies and private notes, read with an agent's API key; live ticket lookups; replies and notes after approval. */
export const freshdesk: Provider = {
  id: "freshdesk",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "domain", label: "Helpdesk address", placeholder: "acme.freshdesk.com" },
      { name: "key", label: "API key", secret: true },
    ],
    setup:
      "In Freshdesk, click your profile picture → Profile settings → View API key, and paste it with your helpdesk address (acme.freshdesk.com). Use an agent with Global ticket access so ALRO sees every ticket; it only reads, and posts a reply or private note as that agent only after someone approves it.",
    docsUrl: "https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key",
    api: (c) => httpApi({ baseUrl: `https://${domainOf(c)}/api/v2/`, headers: basic((c.key ?? "").trim(), "X") }),
  },
  async identify(api, credentials) {
    const domain = domainOf(credentials);
    const me = await api<{ id?: number; ticket_scope?: number; contact?: { name?: string; email?: string } }>("GET", "agents/me").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Freshdesk didn't accept that API key.");
      if ((e instanceof ProviderError && e.status === 404) || e instanceof SyntaxError) throw new Error(`There is no Freshdesk helpdesk at ${domain}.`);
      throw e;
    });
    if (!me?.id) throw new Error("Freshdesk didn't accept that API key.");
    // 1 is Global access; 2 (group) and 3 (restricted) would leave tickets out.
    if (me.ticket_scope && me.ticket_scope !== 1)
      throw new Error("That Freshdesk agent can only see some tickets. Use the API key of an agent with Global ticket access, such as an admin.");
    return { accountId: `freshdesk:${domain.replace(/\.freshdesk\.com$/, "")}`, label: domain };
  },
  async sync(api, cursor, ctx) {
    return fetchFreshdesk(api, domainOf(ctx.credentials), cursor as FreshdeskCursor | undefined, ctx.now);
  },
  tools(api, ctx) {
    const domain = domainOf(ctx.credentials);
    return {
      freshdesk_tickets: tool({
        description:
          "List Freshdesk support tickets that still need work, live: open, pending or overdue, optionally for one requester's email or one company. Use for 'what's open for Acme', 'overdue tickets', 'has Priya raised anything'. Say the answer came from Freshdesk.",
        inputSchema: z.object({
          status: z.enum(["unresolved", "open", "pending", "overdue"]).nullish().describe("unresolved (default) is anything not resolved or closed."),
          requester_email: z.string().nullish().describe("Only tickets raised by this email address."),
          company: z.string().nullish().describe("Only tickets from this company (its name in Freshdesk)."),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ status, requester_email, company, limit }) => {
          const want = status ?? "unresolved";
          const keep = (t: Ticket) =>
            want === "open" ? t.status === 2 : want === "pending" ? t.status === 3 : want === "overdue" ? !done(t.status) && !!t.due_by && Date.parse(t.due_by) < Date.now() : !done(t.status);
          const max = limit ?? 15;
          let found: Ticket[];
          if (requester_email || company) {
            let filter: Record<string, string | number>;
            if (requester_email) filter = { email: requester_email.trim().toLowerCase() };
            else {
              const r = await api<{ companies?: { id: number; name?: string }[] }>("GET", "companies/autocomplete", { query: { name: company!.trim() } });
              const match = r.companies?.[0];
              if (!match) return { tickets: [], note: `No Freshdesk company matches "${company}".` };
              filter = { company_id: match.id };
            }
            // Without updated_since Freshdesk lists only tickets created in the last 30 days.
            const query = { ...filter, order_by: "updated_at", order_type: "desc", per_page: 100, include: "requester" };
            const yearAgo = iso(Date.now() - 365 * 86_400_000);
            found = await api<Ticket[]>("GET", "tickets", { query: { ...query, updated_since: yearAgo } }).catch((e) =>
              e instanceof ProviderError && e.status === 400 ? api<Ticket[]>("GET", "tickets", { query }) : Promise.reject(e),
            );
          } else {
            const statuses = want === "open" ? "status:2" : want === "pending" ? "status:3" : "status:2 OR status:3";
            const query = want === "overdue" ? `(${statuses}) AND due_by:<'${new Date().toISOString().slice(0, 10)}'` : statuses;
            const r = await api<{ total?: number; results?: Ticket[] }>("GET", "search/tickets", { query: { query: `"${query}"` } });
            found = r.results ?? [];
          }
          const tickets = found.filter(keep);
          return { total: tickets.length, tickets: tickets.slice(0, max).map((t) => brief(domain, t)) };
        },
      }),
      freshdesk_ticket: tool({
        description:
          "Read one Freshdesk ticket, live: its fields, requester, company and the latest replies and private notes. Use when someone asks about a specific ticket number or what was last said on it. Say the answer came from Freshdesk.",
        inputSchema: z.object({ ticket_id: ticketId }),
        execute: async ({ ticket_id }) => {
          const t = await api<Ticket>("GET", `tickets/${ticket_id}`, { query: { include: "requester,company" } });
          const conversations = await listAll<Conversation>(api, `tickets/${ticket_id}/conversations`, 3);
          return {
            ...brief(domain, t),
            type: t.type ?? undefined,
            tags: t.tags?.length ? t.tags : undefined,
            company: t.company?.name ?? undefined,
            created: t.created_at,
            description: clip((t.description_text ?? "").trim(), 1000),
            conversation_count: conversations.length,
            latest: conversations.slice(-10).map((c) => ({
              at: c.created_at,
              by: c.incoming ? "customer" : "agent",
              from: emailIn(c.from_email),
              private_note: !!c.private,
              text: clip((c.body_text ?? "").trim(), 500),
            })),
          };
        },
      }),
    };
  },
  actions: {
    freshdesk_reply: post("reply"),
    freshdesk_add_note: post("note"),
  },
};
