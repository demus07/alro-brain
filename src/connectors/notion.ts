import type { NormalizedBatch, NormalizedMessage, NormalizedPerson, NormalizedThread } from "@/ingest/types";
import type { Api } from "./nango";

const MAX_PAGES = 200;
const MAX_BLOCKS = 400;
const NOTION_VERSION = "2022-06-28";

export interface NotionCursor {
  /** last_edited_time of the newest page read. */
  since?: string;
}

type RichText = { plain_text: string }[];
interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  [type: string]: unknown;
}
interface Page {
  id: string;
  url: string;
  last_edited_time: string;
  created_by?: { id: string };
  last_edited_by?: { id: string };
  properties: Record<string, { type: string; title?: RichText }>;
}

const plain = (rt: RichText | undefined) => (rt ?? []).map((t) => t.plain_text).join("");

/** A block as a line of text: headings, bullets, to-dos and quotes keep a light Markdown mark. */
function blockText(b: Block): string {
  const v = b[b.type] as { rich_text?: RichText; checked?: boolean } | undefined;
  const text = plain(v?.rich_text);
  if (!text) return "";
  switch (b.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
    case "numbered_list_item":
      return `- ${text}`;
    case "to_do":
      return `- [${v?.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    default:
      return text;
  }
}

/**
 * Pages shared with the integration, newest edits first, until the last sync's
 * point. Each page is one document thread; an edited page is stored as a new
 * version (messages are never changed), and the caller retires older versions.
 */
export async function fetchNotion(api: Api, connectionId: string, cursor: NotionCursor = {}): Promise<{ batch: NormalizedBatch; cursor: NotionCursor; versions: Map<string, string> }> {
  const call = <T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}) =>
    api<T>(method, path, { ...opts, headers: { "Notion-Version": NOTION_VERSION } });

  const pages: Page[] = [];
  let start: string | undefined;
  for (let i = 0; i < 20 && pages.length < MAX_PAGES; i++) {
    const r = await call<{ results: Page[]; next_cursor: string | null; has_more: boolean }>("POST", "v1/search", {
      body: { filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100, start_cursor: start },
    });
    const fresh = r.results.filter((p) => !cursor.since || p.last_edited_time > cursor.since);
    pages.push(...fresh);
    if (fresh.length < r.results.length || !r.has_more || !r.next_cursor) break;
    start = r.next_cursor;
  }

  const people = new Map<string, NormalizedPerson>();
  const personKey = async (id: string | undefined) => {
    if (!id) return undefined;
    const key = `notion:${id}`;
    if (!people.has(key)) {
      const u = await call<{ name?: string; type?: string; person?: { email?: string } }>("GET", `v1/users/${id}`).catch(() => undefined);
      if (!u || u.type === "bot") return undefined;
      people.set(key, { key, provider: "notion", externalId: id, displayName: u.name ?? "Notion user", email: u.person?.email?.toLowerCase() });
    }
    return key;
  };

  const threads: NormalizedThread[] = [];
  const messages: NormalizedMessage[] = [];
  const versions = new Map<string, string>();
  for (const p of pages) {
    const title = plain(Object.values(p.properties).find((x) => x.type === "title")?.title) || "Untitled";
    const lines: string[] = [];
    const walk = async (blockId: string, depth: number) => {
      let next: string | undefined;
      do {
        const r = await call<{ results: Block[]; next_cursor: string | null; has_more: boolean }>("GET", `v1/blocks/${blockId}/children`, { query: { page_size: 100, start_cursor: next } });
        for (const b of r.results) {
          if (lines.length >= MAX_BLOCKS) return;
          const t = blockText(b);
          if (t) lines.push(`${"  ".repeat(depth)}${t}`);
          if (b.has_children && depth < 2 && b.type !== "child_page") await walk(b.id, depth + 1);
        }
        next = r.has_more ? (r.next_cursor ?? undefined) : undefined;
      } while (next);
    };
    await walk(p.id, 0);

    const author = await personKey(p.last_edited_by?.id ?? p.created_by?.id);
    const externalId = `${p.id}@${p.last_edited_time}`;
    versions.set(p.id, externalId);
    threads.push({ externalId: p.id, kind: "doc", title, url: p.url, visibility: "org", memberKeys: [] });
    messages.push({ threadExternalId: p.id, externalId, kind: "note", authorKey: author, sentAt: new Date(p.last_edited_time), subject: title, text: lines.join("\n") || title, url: p.url });
  }

  const since = pages.reduce((max, p) => (p.last_edited_time > max ? p.last_edited_time : max), cursor.since ?? "");
  return {
    batch: { connection: { provider: "notion", scope: "org", externalAccountId: `notion:${connectionId}` }, people: [...people.values()], threads, messages },
    cursor: { since: since || undefined },
    versions,
  };
}
