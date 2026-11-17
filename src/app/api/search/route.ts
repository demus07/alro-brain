import { getDb } from "@/db/client";
import { formatShort } from "@/lib/time";
import { getViewer } from "@/lib/viewer";
import { limitKey, rateLimit } from "@/platform/rate-limit";
import { excerpt, runSearch } from "../../search/run";

/**
 * The ⌘K search: the same search as the Search page (only what the asker can see), as JSON for the
 * pop-up. Each search embeds the question once, so it is rate-limited per person.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 300);
  if (!q) return Response.json({ results: [], facts: [] });
  if (!(await rateLimit(getDb(), limitKey("search", viewer.personId), 30, 60)).ok) {
    return Response.json({ error: "Searching faster than ALRO can keep up. Wait a minute and try again." }, { status: 429 });
  }
  try {
    const { hits, related, graph, timeZone } = await runSearch(q);
    const seen = new Set<string>();
    const results = [...hits, ...related]
      .filter((h) => !seen.has(h.chunkId) && seen.add(h.chunkId))
      .slice(0, 12)
      .map((h) => ({
        id: h.chunkId,
        href: `/m/${h.messageIds[0]}#cited`,
        thread: h.threadTitle ?? "Untitled",
        kind: h.threadKind,
        at: formatShort(h.startAt, timeZone),
        text: excerpt(h, 180),
      }));
    const facts = graph.facts
      .filter((f) => f.current)
      .slice(0, 4)
      .map((f) => ({ id: f.id, text: f.fact, href: f.messageId ? `/m/${f.messageId}#cited` : undefined }));
    return Response.json({ results, facts });
  } catch (e) {
    console.error("search", e);
    return Response.json({ error: "Search failed. Try again in a moment." }, { status: 500 });
  }
}
