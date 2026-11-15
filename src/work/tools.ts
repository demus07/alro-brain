import { tool } from "ai";
import { z } from "zod";
import type { Db } from "@/db/client";
import type { Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { listProcedures } from "./procedures";
import { rowsOf, totals, trackersOf } from "./trackers";

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** The asker's written-up procedures and trackers, for the agent. Both are theirs alone. */
export function workTools(db: Db, viewer: Viewer, timeZone: string) {
  return {
    findProcedure: tool({
      description:
        "Find how a recurring piece of work is done here (receiving stock, dispatch, invoicing, onboarding), from procedures written up from the company's own conversations. Returns the steps, who does it, how often, and how worth automating it is. Use searchMemory for the conversations behind it.",
      inputSchema: z.object({ query: z.string().nullish().describe("What the work is; empty lists them all, best to automate first") }),
      execute: async ({ query }) => {
        const all = await listProcedures(db, viewer);
        const q = words(query ?? "");
        const scored = all
          .map((p) => ({ p, hits: q.filter((w) => `${p.title} ${p.summary} ${p.steps.join(" ")}`.toLowerCase().includes(w)).length }))
          .filter((x) => !q.length || x.hits > 0)
          .sort((a, b) => b.hits - a.hits || b.p.automationScore - a.p.automationScore)
          .slice(0, q.length ? 3 : 15);
        if (!all.length) return { procedures: [], note: "No procedures written up yet. They're made on the Procedures page." };
        return {
          procedures: scored.map(({ p }) => ({
            title: p.title,
            summary: p.summary,
            ...(q.length ? { steps: p.steps } : {}),
            owners: p.owners ?? undefined,
            frequency: p.frequency,
            minutesEach: p.minutes ?? undefined,
            judgment: p.judgment,
            automationScore: p.automationScore,
          })),
        };
      },
    }),
    readTracker: tool({
      description:
        "Read one of the asker's trackers: running tables pulled from chats and email (a sales log, receivables, stock by grade, truck turnaround). Returns recent rows and totals of number columns. Call with no name to list the trackers.",
      inputSchema: z.object({
        name: z.string().nullish(),
        since: z.string().nullish().describe("Only rows after this date, ISO 8601"),
        contains: z.string().nullish().describe("Only rows with this text in any column, e.g. a customer"),
      }),
      execute: async ({ name, since, contains }) => {
        const list = await trackersOf(db, viewer);
        const t = name ? list.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? list.find((x) => x.name.toLowerCase().includes(name.toLowerCase())) : undefined;
        if (!t) return { trackers: list.map((x) => ({ name: x.name, about: x.description, columns: x.columns.map((c) => c.name) })) };
        const after = since ? new Date(since) : undefined;
        let rows = await rowsOf(db, viewer, t.id, { since: after && !Number.isNaN(after.getTime()) ? after : undefined });
        if (contains) rows = rows.filter((r) => Object.values(r.values).some((v) => String(v ?? "").toLowerCase().includes(contains.toLowerCase())));
        return {
          tracker: t.name,
          rows: rows.length,
          totals: totals(t.columns, rows),
          recent: rows.slice(0, 40).map((r) => ({ at: formatShort(r.at, timeZone), ...r.values })),
        };
      },
    }),
  };
}
