import { tool } from "ai";
import { z } from "zod";
import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { bearer, httpApi, ProviderError, type Api } from "./api";
import type { ActionDef, Fetched, Provider } from "./provider";
import { htmlToText } from "./teams";

/** Pinned so a new Intercom release can't change the shapes read here. */
export const INTERCOM_VERSION = "2.18";
/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** A later sync re-reads this much before the newest conversation it saw (seconds). */
const OVERLAP_SECONDS = 300;
/** Search returns at most 150 a page; two pages is 300 conversations a sync. */
const PAGE_SIZE = 150;
const MAX_PAGES = 2;
/** Wait between conversation reads; private apps may make 10,000 calls a minute, so this is only politeness. */
const PAUSE_MS = 100;

/** Where each region's workspaces live: the API host and the inbox host. */
const REGIONS = {
  us: { api: "api.intercom.io", app: "app.intercom.com" },
  eu: { api: "api.eu.intercom.io", app: "app.eu.intercom.com" },
  au: { api: "api.au.intercom.io", app: "app.au.intercom.com" },
} as const;
type Region = keyof typeof REGIONS;

export interface IntercomCursor {
  /** updated_at (Unix seconds) of the newest conversation read. */
  since?: number;
  /** The last sync stopped at its cap with more waiting: continue from `since` without the overlap. */
  more?: boolean;
  /** Only when a whole capped sync read conversations changed in the same second: where the search continues. */
  after?: string;
}

interface Author {
  id?: string | number | null;
  /** "admin", "bot", "team", "user", "lead" or "contact". */
  type?: string;
  name?: string | null;
  email?: string | null;
}
interface Part {
  id: string;
  /** "comment", "note", "assignment", "open", "close", "snoozed", "unknown"... */
  part_type?: string;
  body?: string | null;
  created_at: number;
  author?: Author | null;
}
interface Conversation {
  id: string;
  title?: string | null;
  state?: string;
  priority?: string;
  created_at: number;
  updated_at: number;
  waiting_since?: number | null;
  admin_assignee_id?: number | string | null;
  source?: { type?: string; subject?: string | null; body?: string | null; author?: Author | null; delivered_as?: string } | null;
  contacts?: { contacts?: { id: string; email?: string | null }[] } | null;
  tags?: { tags?: { name?: string }[] } | null;
  conversation_parts?: { conversation_parts?: Part[] } | null;
}
interface Search {
  conversations?: Conversation[];
  total_count?: number;
  pages?: { next?: { starting_after?: string } | null };
}
interface Contact {
  id: string;
  role?: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: number;
  last_seen_at?: number | null;
  location?: { city?: string | null; country?: string | null } | null;
}

/** "", "US", "eu", "AU" or an API host, as a region; anything else is refused. */
export function regionOf(credentials: Record<string, string>): Region {
  const r = (credentials.region ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!r || r === "us" || r === "api.intercom.io") return "us";
  if (r === "eu" || r === "api.eu.intercom.io") return "eu";
  if (r === "au" || r === "api.au.intercom.io") return "au";
  throw new Error("Region must be US, EU or AU (where your Intercom workspace is hosted). Leave it empty for US.");
}

const missing = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);
const date = (s?: number | null) => (s ? new Date(s * 1000).toISOString() : undefined);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Bodies are read as plain text (display_as=plaintext); search results still come as HTML. */
const plain = (s?: string | null) => (s ? (/<\/?(p|br|div|a|b|i|span|img)\b/i.test(s) ? htmlToText(s) : s.trim()) : "");
const appIdOf = (accountId: string) => accountId.replace(/^intercom:/, "");
const inboxUrl = (region: Region, appId: string, id: string) => `https://${REGIONS[region].app}/a/inbox/${appId}/inbox/conversation/${id}`;
const isAdmin = (a?: Author | null) => a?.type === "admin" || a?.type === "bot" || a?.type === "team";
const isNote = (p: Part) => p.part_type === "note" || !!p.part_type?.startsWith("note_");

/** Plain text as HTML paragraphs, for reply and note bodies. */
export function toHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Conversations changed since the last sync, each as one document thread, the same shape as a
 * Zendesk ticket: the state, contact, assignee and first message as a versioned note, then every
 * later message (customer messages, teammate replies and internal notes) as chat. Intercom has no
 * per-conversation audience: a teammate's inbox permissions limit what they see, and notes are
 * shown to every teammate on the conversation. So conversations are visible to the whole company
 * and notes are marked "Internal note". Conversations the token's teammate can't open are skipped.
 */
export async function fetchIntercom(api: Api, appId: string, region: Region, cursor: IntercomCursor = {}, now = new Date(), pauseMs = PAUSE_MS): Promise<Fetched> {
  const people = new Map<string, NormalizedPerson>();
  const add = (key: string, externalId: string, name?: string | null, email?: string | null) => {
    const prior = people.get(key);
    const mail = email?.toLowerCase() || prior?.email;
    people.set(key, { key, provider: "intercom", externalId, displayName: name || prior?.displayName || mail || "Intercom user", email: mail || undefined });
    return key;
  };
  const admins = new Map<string, { name?: string; email?: string }>();
  const listed = await api<{ admins?: { id: string | number; name?: string; email?: string }[] }>("GET", "admins").catch((e) => (missing(e) ? undefined : Promise.reject(e)));
  for (const a of listed?.admins ?? []) admins.set(String(a.id), a);
  const adminKey = (id?: string | number | null) => {
    if (id === undefined || id === null || id === "" || String(id) === "0") return undefined;
    const a = admins.get(String(id));
    return a ? add(`intercom:admin:${id}`, `admin:${id}`, a.name, a.email) : undefined;
  };
  const authorKey = (a?: Author | null) => {
    if (!a?.id) return undefined;
    if (isAdmin(a)) return adminKey(a.id) ?? (a.type === "admin" ? add(`intercom:admin:${a.id}`, `admin:${a.id}`, a.name, a.email) : undefined);
    return add(`intercom:contact:${a.id}`, `contact:${a.id}`, a.name, a.email);
  };

  const floor = Math.floor(now.getTime() / 1000) - BACKFILL_DAYS * 86_400;
  const from = cursor.since === undefined ? floor : cursor.more ? cursor.since : cursor.since - OVERLAP_SECONDS;
  const search = (after?: string) =>
    api<Search>("POST", "conversations/search", {
      // ">" is strict: one second earlier includes conversations changed at `from` itself.
      body: { query: { field: "updated_at", operator: ">", value: from - 1 }, sort: { field: "updated_at", order: "ascending" }, pagination: { per_page: PAGE_SIZE, ...(after ? { starting_after: after } : {}) } },
    });

  const found = new Map<string, Conversation>();
  let after = cursor.after;
  let more = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await search(after).catch((e) => {
      // A saved position Intercom no longer accepts: start the search again.
      if (i > 0 || !after || !(e instanceof ProviderError) || ![400, 404, 422].includes(e.status)) throw e;
      return search();
    });
    for (const c of page.conversations ?? []) found.set(c.id, c);
    after = page.pages?.next?.starting_after ?? undefined;
    more = !!after;
    if (!more) break;
  }
  const newest = Math.max(cursor.since ?? 0, ...[...found.values()].map((c) => c.updated_at || 0));
  // Every conversation read changed in the same second as the start: page on, or the next sync would read them again.
  const next: Record<string, unknown> = more && newest <= from ? { since: from, more: true, after } : { since: newest || cursor.since, ...(more ? { more: true } : {}) };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const { id } of found.values()) {
    if (pauseMs) await new Promise((res) => setTimeout(res, pauseMs));
    const c = await api<Conversation>("GET", `conversations/${id}`, { query: { display_as: "plaintext" } }).catch((e) => (missing(e) ? undefined : Promise.reject(e)));
    if (!c) continue;
    for (const ref of c.contacts?.contacts ?? []) if (ref.email) add(`intercom:contact:${ref.id}`, `contact:${ref.id}`, undefined, ref.email);
    const first = plain(c.source?.body);
    const author = c.source?.author;
    const customer = author && !isAdmin(author) ? author : undefined;
    const name = customer?.name || customer?.email || (c.contacts?.contacts?.[0]?.email ?? undefined);
    const subject = plain(c.title) || plain(c.source?.subject) || clip(first.split("\n")[0] ?? "", 80);
    if (!subject && !first) continue;
    const title = subject || `Conversation with ${name ?? "a customer"}`;
    const url = inboxUrl(region, appId, c.id);
    const assignee = c.admin_assignee_id ? admins.get(String(c.admin_assignee_id)) : undefined;
    const tags = (c.tags?.tags ?? []).map((t) => t.name).filter(Boolean);
    const head = [
      title,
      `State: ${c.state ?? "unknown"}`,
      c.priority && c.priority !== "none" && c.priority !== "not_priority" && `Priority: ${c.priority}`,
      customer && `Contact: ${customer.name && customer.email ? `${customer.name} (${customer.email.toLowerCase()})` : customer.name || customer.email}`,
      assignee && `Assignee: ${assignee.name || assignee.email}`,
      tags.length && `Tags: ${tags.join(", ")}`,
      c.source?.type && `Channel: ${c.source.type}`,
      `Started: ${date(c.created_at)!.slice(0, 10)}`,
    ].filter((l): l is string => !!l);

    const externalId = `${c.id}@${c.updated_at}`;
    versions.set(c.id, externalId);
    adminKey(c.admin_assignee_id);
    threads.push({ externalId: c.id, kind: "doc", title, url, visibility: "org", memberKeys: [] });
    messages.push({ threadExternalId: c.id, externalId, kind: "note", authorKey: authorKey(author), sentAt: new Date(c.updated_at * 1000), subject: title, text: [head.join("\n"), first].filter(Boolean).join("\n\n"), url });
    for (const p of c.conversation_parts?.conversation_parts ?? []) {
      // 2.18 reports part types it doesn't recognise as "unknown": what they are, and who saw them, isn't known.
      const text = p.part_type === "unknown" ? "" : plain(p.body);
      if (!text) continue;
      messages.push({ threadExternalId: c.id, externalId: String(p.id), kind: "chat", authorKey: authorKey(p.author), sentAt: new Date(p.created_at * 1000), text: isNote(p) ? `Internal note: ${text}` : text, url });
    }
  }

  return { people: [...people.values()], threads, messages, versions, cursor: next };
}

/** A conversation in a list, trimmed for the agent. */
function brief(region: Region, appId: string, c: Conversation, admins: Map<string, string>) {
  const who = c.source?.author && !isAdmin(c.source.author) ? c.source.author : undefined;
  return {
    id: c.id,
    title: plain(c.title) || plain(c.source?.subject) || undefined,
    state: c.state,
    contact: who ? { name: who.name ?? undefined, email: who.email?.toLowerCase() ?? undefined } : undefined,
    assignee: c.admin_assignee_id && String(c.admin_assignee_id) !== "0" ? (admins.get(String(c.admin_assignee_id)) ?? String(c.admin_assignee_id)) : undefined,
    waiting_since: date(c.waiting_since),
    updated: date(c.updated_at),
    first_message: clip(plain(c.source?.body), 200),
    url: inboxUrl(region, appId, c.id),
  };
}

const conversationId = z.string().min(1).describe("The Intercom conversation id.");

interface Post {
  conversation_id: string;
  body: string;
}

/** Post a reply or an internal note in a conversation, as the teammate whose token this is. */
function post(kind: "comment" | "note"): ActionDef<Post> {
  const reply = kind === "comment";
  return {
    description: reply
      ? "Reply to a customer in an Intercom conversation, as the connected teammate. The customer sees it in Messenger or by email."
      : "Add an internal note to an Intercom conversation: only teammates see it, the customer doesn't.",
    input: z.object({ conversation_id: conversationId, body: z.string().min(1).describe(reply ? "The reply to the customer, as plain text." : "The note, as plain text.") }),
    audience: () => (reply ? "external" : "internal"),
    summary: (i) => `${reply ? "Intercom reply to the customer" : "Internal Intercom note"} in conversation ${i.conversation_id}`,
    body: (i) => i.body,
    withBody: (i, body) => ({ ...i, body }),
    async run(api, i, ctx) {
      // Replies need an author: the teammate the access token belongs to.
      const me = await api<{ id?: string | number; name?: string }>("GET", "me");
      if (!me.id) throw new Error("Intercom didn't say which teammate this access token belongs to.");
      await api("POST", `conversations/${encodeURIComponent(i.conversation_id)}/reply`, { body: { message_type: kind, type: "admin", admin_id: String(me.id), body: toHtml(i.body) } });
      const where = `conversation ${i.conversation_id}`;
      return { url: inboxUrl(regionOf(ctx.credentials), appIdOf(ctx.accountId), i.conversation_id), detail: reply ? `Replied in Intercom ${where} as ${me.name ?? "the connected teammate"}.` : `Added an internal note to Intercom ${where}.` };
    },
  };
}

/** Intercom conversations (customer messages, replies and internal notes), read with a workspace access token; live lookups; replies and notes after approval. */
export const intercom: Provider = {
  id: "intercom",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "token", label: "Access token", secret: true },
      { name: "region", label: "Region", placeholder: "US (default), EU or AU", optional: true },
    ],
    setup:
      "In Intercom, open Settings → Integrations → Developer Hub, create an app for your workspace and paste its access token. Give it Read conversations, Read and list users and companies and Read admins; add Write conversations only if ALRO may post replies and notes you approve. Enter EU or AU only if your workspace is hosted there.",
    docsUrl: "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication",
    api: (c) => {
      const auth = bearer((c.token ?? "").trim());
      return httpApi({ baseUrl: `https://${REGIONS[regionOf(c)].api}/`, headers: () => ({ ...auth(), "intercom-version": INTERCOM_VERSION }) });
    },
  },
  async identify(api, credentials) {
    regionOf(credentials);
    const me = await api<{ id?: string | number; app?: { id_code?: string; name?: string } }>("GET", "me").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Intercom didn't accept that access token. Check it, and that the region matches where your workspace is hosted.");
      throw e;
    });
    if (!me.app?.id_code) throw new Error("Intercom didn't accept that access token.");
    return { accountId: `intercom:${me.app.id_code}`, label: me.app.name || me.app.id_code };
  },
  async sync(api, cursor, ctx) {
    return fetchIntercom(api, appIdOf(ctx.accountId), regionOf(ctx.credentials), cursor as IntercomCursor | undefined, ctx.now);
  },
  tools(api, ctx) {
    const region = regionOf(ctx.credentials);
    const appId = appIdOf(ctx.accountId);
    const adminNames = async () => {
      const r = await api<{ admins?: { id: string | number; name?: string; email?: string }[] }>("GET", "admins").catch(() => ({ admins: [] }));
      return new Map((r.admins ?? []).map((a) => [String(a.id), a.name || a.email || String(a.id)]));
    };
    const contactsBy = async (email: string) => {
      const r = await api<{ data?: Contact[] }>("POST", "contacts/search", { body: { query: { field: "email", operator: "=", value: email.trim().toLowerCase() }, pagination: { per_page: 5 } } });
      return r.data ?? [];
    };
    const byContacts = (ids: string[]) => (ids.length === 1 ? { field: "contact_ids", operator: "=", value: ids[0] } : { operator: "OR", value: ids.map((v) => ({ field: "contact_ids", operator: "=", value: v })) });
    return {
      intercom_conversations: tool({
        description:
          "List Intercom support conversations, live: open or snoozed ones by default, for one customer's email or the most recently active. Use for 'what's open in Intercom', 'is Priya waiting on us', 'recent chats from Acme's contact'. Say the answer came from Intercom.",
        inputSchema: z.object({
          contact_email: z.string().nullish().describe("Only conversations with the contact who has this email."),
          state: z.enum(["open_or_snoozed", "open", "snoozed", "closed", "any"]).nullish().describe("open_or_snoozed (default) is everything still waiting."),
          limit: z.number().int().min(1).max(25).nullish(),
        }),
        execute: async ({ contact_email, state, limit }) => {
          const filters: unknown[] = [];
          if (contact_email) {
            const contacts = await contactsBy(contact_email);
            if (!contacts.length) return { conversations: [], note: `No Intercom contact has the email ${contact_email}.` };
            filters.push(byContacts(contacts.map((c) => c.id)));
          }
          const want = state ?? "open_or_snoozed";
          if (want === "open_or_snoozed")
            filters.push({
              operator: "OR",
              value: [
                { field: "state", operator: "=", value: "open" },
                { field: "state", operator: "=", value: "snoozed" },
              ],
            });
          else if (want !== "any") filters.push({ field: "state", operator: "=", value: want });
          if (!filters.length) filters.push({ field: "updated_at", operator: ">", value: Math.floor(Date.now() / 1000) - 30 * 86_400 });
          const query = filters.length === 1 ? filters[0] : { operator: "AND", value: filters };
          const r = await api<Search>("POST", "conversations/search", { body: { query, sort: { field: "updated_at", order: "descending" }, pagination: { per_page: limit ?? 15 } } });
          const admins = await adminNames();
          return { total: r.total_count ?? r.conversations?.length ?? 0, conversations: (r.conversations ?? []).map((c) => brief(region, appId, c, admins)) };
        },
      }),
      intercom_contact: tool({
        description:
          "Look up a customer in Intercom by email, live: who they are, their company and their latest support conversations. Use when someone asks about a customer's Intercom history or what they last wrote in. Say the answer came from Intercom.",
        inputSchema: z.object({ email: z.string().min(3).describe("The contact's email address.") }),
        execute: async ({ email }) => {
          const contacts = await contactsBy(email);
          const c = contacts.find((x) => x.role === "user") ?? contacts[0];
          if (!c) return { found: false, note: `No Intercom contact has the email ${email}.` };
          const companies = await api<{ data?: { name?: string; website?: string | null; plan?: { name?: string } | null; size?: number | null; monthly_spend?: number | null }[] }>(
            "GET",
            `contacts/${c.id}/companies`,
          ).catch((e) => (missing(e) ? { data: [] } : Promise.reject(e)));
          const recent = await api<Search>("POST", "conversations/search", {
            body: { query: byContacts([c.id]), sort: { field: "updated_at", order: "descending" }, pagination: { per_page: 5 } },
          });
          const admins = await adminNames();
          return {
            found: true,
            id: c.id,
            name: c.name ?? undefined,
            email: c.email?.toLowerCase() ?? undefined,
            role: c.role,
            phone: c.phone ?? undefined,
            location: [c.location?.city, c.location?.country].filter(Boolean).join(", ") || undefined,
            signed_up: date(c.created_at),
            last_seen: date(c.last_seen_at),
            companies: (companies.data ?? []).slice(0, 5).map((co) => ({ name: co.name, website: co.website ?? undefined, plan: co.plan?.name, size: co.size ?? undefined })),
            other_matches: contacts.length - 1 || undefined,
            recent_conversations: (recent.conversations ?? []).map((x) => brief(region, appId, x, admins)),
            url: `https://${REGIONS[region].app}/a/apps/${appId}/users/${c.id}/all-conversations`,
          };
        },
      }),
    };
  },
  actions: {
    intercom_reply: post("comment"),
    intercom_add_note: post("note"),
  },
};
