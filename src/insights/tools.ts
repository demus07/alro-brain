import { tool } from "ai";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Source } from "@/agent/tools";
import type { Db } from "@/db/client";
import { messages, people, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { INSIGHT_KINDS } from "./compute";
import { KIND_LABEL, openInsights, SEVERITY_LABEL } from "./read";

/** Evidence cited per insight. */
const MAX_SOURCES = 3;
const MAX_TEXT = 600;

/**
 * The agent's view of what needs attention. Reads in the asker's scope, so it only lists
 * insights whose evidence they can see, and cites that evidence.
 *
 * Pass the memory tools' `cite` to share one run of [S] numbers; on its own it numbers from
 * S501 so its refs never collide with theirs in one answer.
 */
export function insightTools(db: Db, viewer: Viewer, timeZone: string, opts: { cite?: (s: Omit<Source, "ref">) => Source } = {}) {
  let next = 501;
  const cite = opts.cite ?? ((s: Omit<Source, "ref">): Source => ({ ref: `S${next++}`, ...s }));
  const when = (d: Date) => formatShort(d, timeZone);

  return {
    listInsights: tool({
      description:
        "What needs attention right now, worked out ahead of time from everything the asker can see: outside people waiting on a reply from us, clients or deals at risk or gone quiet, people carrying too many overdue promises, outside people late on what they promised us, facts that contradict each other, payments past due, and work worth automating. Each comes with its evidence to cite and a suggested next step. Use for 'what needs my attention', 'which clients are at risk', 'who is waiting on us', 'who is overloaded', 'anything I should worry about'.",
      inputSchema: z.object({
        kind: z.array(z.enum(INSIGHT_KINDS)).nullish().describe("Only these kinds; default all"),
        about: z.string().nullish().describe("Name of a person or company, to list only what concerns them"),
        department: z.string().nullish().describe("Only one department, e.g. finance"),
        limit: z.number().int().min(1).max(30).nullish(),
      }),
      execute: async ({ kind, about, department, limit }) =>
        withScope(db, viewer, async (tx) => {
          const rows = await openInsights(tx as unknown as Db, { kinds: kind ?? undefined, about: about ?? undefined, department: department?.trim().toLowerCase() || undefined, limit: limit ?? 12 });
          if (!rows.length) return { insights: [], note: "Nothing needs attention in what you can see." };
          const ids = [...new Set(rows.flatMap((r) => r.evidenceMessageIds.slice(0, MAX_SOURCES)))];
          // Evidence the asker can't see simply doesn't come back, and isn't cited.
          const evidence = ids.length
            ? await tx
                .select({ id: messages.id, sentAt: messages.sentAt, url: messages.url, text: messages.text, thread: threads.title, kind: threads.kind, author: people.displayName })
                .from(messages)
                .innerJoin(threads, eq(threads.id, messages.threadId))
                .leftJoin(people, eq(people.id, messages.authorPersonId))
                .where(inArray(messages.id, ids))
            : [];
          const byId = new Map(evidence.map((m) => [m.id, m]));
          const cited = new Map<string, Source>();
          const source = (id: string) => {
            const m = byId.get(id);
            if (!m) return [];
            if (!cited.has(id)) {
              cited.set(id, cite({ thread: m.thread ?? "Untitled", kind: m.kind, at: when(m.sentAt), author: m.author ?? undefined, text: m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)}…` : m.text, url: m.url ?? undefined, messageId: m.id }));
            }
            return [cited.get(id)!];
          };
          return {
            insights: rows.map((r) => ({
              kind: KIND_LABEL[r.kind as keyof typeof KIND_LABEL] ?? r.kind,
              urgency: SEVERITY_LABEL[r.severity] ?? "worth knowing",
              title: r.title,
              detail: r.detail,
              suggestedNextStep: r.suggestion ?? undefined,
              department: r.department ?? undefined,
              since: when(r.firstSeenAt),
              sources: r.evidenceMessageIds.slice(0, MAX_SOURCES).flatMap(source),
            })),
          };
        }),
    }),
  };
}
