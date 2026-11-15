import type { NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import { basic, httpApi, ProviderError, type Api } from "./api";
import type { Fetched, Provider } from "./provider";

/** First sync reaches back this far. */
const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before the previous one began, to cover clock differences with Confluence. */
const OVERLAP_MS = 10 * 60_000;
const PAGE_SIZE = 50;
const MAX_REQUESTS = 20;
const MAX_DOCS = 200;
const MAX_CHARS = 200_000;

export interface ConfluenceCursor {
  /** Pages edited at or after this (ISO) are read. */
  since?: string;
  /** Set while a pass was cut short by the cap: when it began, and the page of results to continue from. */
  started?: string;
  after?: string;
}

interface Listing<T> {
  results?: T[];
  _links?: { next?: string; base?: string };
}
interface Page {
  id: string;
  title?: string;
  spaceId?: string;
  parentId?: string | null;
  authorId?: string;
  /** The current version: its createdAt is when the page was last edited. */
  version?: { createdAt?: string; authorId?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}
interface Space {
  id: string;
  name?: string;
  type?: string;
}
interface User {
  accountId: string;
  displayName?: string;
  publicName?: string;
  email?: string | null;
  accountType?: string;
}

/** Content types that can sit above a page, by the path their restriction state is read from. */
const CONTAINERS: Record<string, string> = { page: "pages", folder: "folders", whiteboard: "whiteboards", database: "databases" };
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  rarr: "→",
  larr: "←",
  bull: "•",
};

/** Confluence storage format (XHTML with macros) as plain text: one line per block, light marks for headings, lists and tasks. */
export function storageToText(storage: string): string {
  return storage
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, code: string) => code.replace(/&/g, "&amp;").replace(/</g, "&lt;"))
    .replace(/<ac:(parameter|task-id)\b[^>]*>[\s\S]*?<\/ac:\1>/g, "")
    .replace(/<ac:task-status>\s*(\w+)\s*<\/ac:task-status>/g, (_, state: string) => `- [${state === "complete" ? "x" : " "}] `)
    .replace(/<ri:page\b[^>]*ri:content-title="([^"]*)"[^>]*>/g, "$1")
    .replace(/<h([1-6])\b[^>]*>/g, (_, level: string) => `\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/g, "\n- ")
    .replace(/<\/t[dh]>/g, " | ")
    .replace(/<[bh]r\s*\/?>|<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre|ac:plain-text-body|ac:task)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/(?: \|)? ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
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

const missing = (e: unknown) => e instanceof ProviderError && (e.status === 403 || e.status === 404);

/**
 * Pages edited since the last pass, newest first, until the last sync's point. Each page
 * is one document thread whose text is stored as a new version when the page is edited.
 * Pages with a view restriction (their own or one above them) and pages in personal
 * spaces are left out, because who may see them can't be read reliably.
 */
export async function fetchConfluence(api: Api, site: string, cursor: ConfluenceCursor = {}, now = new Date()): Promise<Fetched> {
  const since = cursor.since ?? new Date(now.getTime() - BACKFILL_DAYS * 86_400_000).toISOString();
  const resuming = !!cursor.after && !!cursor.started;
  let started = resuming ? cursor.started! : now.toISOString();
  let after = resuming ? cursor.after : undefined;
  let more = false;
  let base = `https://${site}/wiki`;

  const list = (from?: string) => api<Listing<Page>>("GET", "wiki/api/v2/pages", { query: { sort: "-modified-date", status: "current", "body-format": "storage", limit: PAGE_SIZE, cursor: from } });
  const pages: Page[] = [];
  for (let i = 0; i < MAX_REQUESTS && pages.length < MAX_DOCS; i++) {
    const r = await list(after).catch((e) => {
      // A saved page marker Confluence no longer accepts: begin the pass again.
      if (i > 0 || !after || !(e instanceof ProviderError) || e.status !== 400) throw e;
      started = now.toISOString();
      return list();
    });
    const results = r.results ?? [];
    const fresh = results.filter((p) => Date.parse(p.version?.createdAt ?? "") >= Date.parse(since));
    pages.push(...fresh);
    base = r._links?.base ?? base;
    // Only the marker is kept from the "next" link, so every request carries the same filters.
    after = r._links?.next ? (new URL(r._links.next, base).searchParams.get("cursor") ?? undefined) : undefined;
    more = fresh.length === results.length && !!after;
    if (!more) break;
  }

  const spaces = new Map<string, Space>();
  const spaceIds = [...new Set(pages.map((p) => p.spaceId).filter((id): id is string => !!id))];
  for (let i = 0; i < spaceIds.length; i += 100) {
    const r = await api<Listing<Space>>("GET", "wiki/api/v2/spaces", { query: { ids: spaceIds.slice(i, i + 100).join(","), limit: 250 } });
    for (const s of r.results ?? []) spaces.set(String(s.id), s);
  }

  const people = new Map<string, NormalizedPerson>();
  const authorIds = [...new Set(pages.map((p) => p.version?.authorId ?? p.authorId).filter((id): id is string => !!id))];
  for (let i = 0; i < authorIds.length; i += 250) {
    // Profiles can be closed to the token's account; pages are still read, without authors.
    const r = await api<Listing<User>>("POST", "wiki/api/v2/users-bulk", { body: { accountIds: authorIds.slice(i, i + 250) } }).catch((e) => {
      if (missing(e)) return {} as Listing<User>;
      throw e;
    });
    for (const u of r.results ?? []) {
      if (u.accountType === "app") continue;
      const key = `confluence:${u.accountId}`;
      people.set(key, { key, provider: "confluence", externalId: u.accountId, displayName: u.displayName || u.publicName || "Confluence user", email: u.email?.toLowerCase() || undefined });
    }
  }

  const open = new Map<string, boolean>();
  /** Whether a page (or a folder, whiteboard or database above one) has no view restriction of its own. */
  const unrestricted = async (type: string, id: string) => {
    const key = `${type}:${id}`;
    if (!open.has(key)) {
      const r = CONTAINERS[type]
        ? await api<{ state?: string }>("GET", `wiki/api/v2/${CONTAINERS[type]}/${id}/restriction-state`).catch((e) => {
            if (missing(e)) return undefined;
            throw e;
          })
        : undefined;
      open.set(key, r?.state === "OPEN" || r?.state === "EDIT_RESTRICTED");
    }
    return open.get(key)!;
  };
  const chains = new Map<string, boolean>();
  /** A restriction on any ancestor applies to the page too, so the whole chain above it is checked (once per parent). */
  const visible = async (p: Page) => {
    if (!(await unrestricted("page", p.id))) return false;
    if (!p.parentId) return true;
    if (!chains.has(p.parentId)) {
      const r = await api<Listing<{ id: string; type: string }>>("GET", `wiki/api/v2/pages/${p.id}/ancestors`, { query: { limit: 250 } }).catch((e) => {
        if (missing(e)) return undefined;
        throw e;
      });
      let clear = !!r;
      for (const a of r?.results ?? []) clear = clear && (await unrestricted(a.type, String(a.id)));
      chains.set(p.parentId, clear);
    }
    return chains.get(p.parentId)!;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const p of pages) {
    const space = spaces.get(String(p.spaceId));
    const text = storageToText(p.body?.storage?.value ?? "").slice(0, MAX_CHARS);
    if (!text || !space || space.type === "personal" || !(await visible(p))) continue;

    const title = p.title?.trim() || "Untitled";
    const url = `${base}${p._links?.webui ?? `/pages/viewpage.action?pageId=${p.id}`}`;
    const edited = p.version!.createdAt!;
    const author = `confluence:${p.version?.authorId ?? p.authorId}`;
    const externalId = `${p.id}@${edited}`;
    versions.set(p.id, externalId);
    threads.push({ externalId: p.id, kind: "doc", title, url, visibility: "org", memberKeys: [], metadata: { space: space.name } });
    messages.push({ threadExternalId: p.id, externalId, kind: "note", authorKey: people.has(author) ? author : undefined, sentAt: new Date(edited), subject: title, text, url });
  }

  const next: ConfluenceCursor = more ? { since, started, after } : { since: new Date(Date.parse(started) - OVERLAP_MS).toISOString() };
  return { people: [...people.values()], threads, messages, versions, cursor: next as Record<string, unknown> };
}

/** Confluence Cloud pages, read with an Atlassian API token. */
export const confluence: Provider = {
  id: "confluence",
  scope: "org",
  auth: {
    kind: "token",
    fields: [
      { name: "site", label: "Confluence site", placeholder: "acme.atlassian.net" },
      { name: "email", label: "Account email", placeholder: "you@company.com" },
      { name: "token", label: "API token", secret: true },
    ],
    setup:
      "Create an API token at id.atlassian.com (Security → API tokens) and paste it with your Confluence site address and the email you sign in to Confluence with. ALRO only reads, and it reads every space that account can open, so use an account that sees what the whole team may see.",
    docsUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    api: (c) => httpApi({ baseUrl: `https://${siteOf(c)}/`, headers: basic((c.email ?? "").trim(), (c.token ?? "").trim()) }),
  },
  async identify(api, credentials) {
    const site = siteOf(credentials);
    const me = await api<{ accountId?: string; type?: string }>("GET", "wiki/rest/api/user/current").catch((e) => {
      if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) throw new Error("Confluence didn't accept that email and API token.");
      if (e instanceof ProviderError && e.status === 404) throw new Error(`There is no Confluence site at ${site}.`);
      throw e;
    });
    if (!me.accountId || me.type === "anonymous") throw new Error("Confluence didn't accept that email and API token.");
    return { accountId: `confluence:${site}`, label: site };
  },
  async sync(api, cursor, ctx) {
    return fetchConfluence(api, siteOf(ctx.credentials), cursor as ConfluenceCursor | undefined, ctx.now);
  },
};
