import { tool } from "ai";
import { aliasedTable, and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { commitmentEvents, commitments, edges, entities, entityAliases, messages, people, rollups, threads } from "@/db/schema";
import { withScope, type Viewer } from "@/db/scope";
import { formatShort } from "@/lib/time";
import { search } from "@/memory/search";

/** Something an answer can cite as [S1], [S2], ... The UI renders these as links. */
export interface Source {
  ref: string;
  thread: string;
  kind: string;
  at: string;
  author?: string;
  text: string;
  url?: string;
  messageId?: string;
}

const STATUSES = ["open", "due_soon", "overdue", "done", "cancelled", "dismissed"] as const;
const MAX_TEXT = 1500;

/**
 * The agent's tools. Each call runs in its own withScope() transaction, so the
 * agent can only ever read what the asker could see in the source tools.
 */
export function agentTools(db: Db, viewer: Viewer, models: Models, timeZone: string) {
  let next = 1;
  const cite = (s: Omit<Source, "ref">): Source => ({ ref: `S${next++}`, ...s, text: clip(s.text) });
  const scoped = <T>(fn: (tx: Db) => Promise<T>) => withScope(db, viewer, (tx) => fn(tx as unknown as Db));
  const when = (d: Date) => formatShort(d, timeZone);
  const owner = aliasedTable(people, "owner");
  const counterparty = aliasedTable(people, "counterparty");

  return {
    searchMemory: tool({
      description:
        "Search everything the user can see (chats, emails, meeting transcripts, CRM changes) by meaning and keywords. Returns conversation excerpts with sources to cite.",
      inputSchema: z.object({
        query: z.string().describe("What to look for, in natural language"),
        since: z.string().nullish().describe("Only after this date, ISO 8601"),
        until: z.string().nullish().describe("Only before this date, ISO 8601"),
        limit: z.number().int().min(1).max(15).nullish(),
      }),
      execute: async ({ query, since, until, limit }) => {
        const hits = await scoped((tx) =>
          search(tx, models, query, { since: date(since), until: date(until), limit: limit ?? 8 }),
        );
        return {
          results: hits.map((h) =>
            cite({
              thread: h.threadTitle ?? "Untitled",
              kind: h.threadKind,
              at: `${when(h.startAt)} – ${when(h.endAt)}`,
              text: h.text,
              url: h.threadUrl ?? undefined,
              messageId: h.messageIds[0],
            }),
          ),
        };
      },
    }),

    readThread: tool({
      description: "Read messages from one thread around a time, to see the full context of a search result.",
      inputSchema: z.object({
        thread: z.string().describe("Thread title as shown in a source, e.g. '#eng' or 'Ananya Desai'"),
        around: z.string().nullish().describe("ISO 8601 time to centre on; latest messages if omitted"),
        limit: z.number().int().min(1).max(40).nullish(),
      }),
      execute: async ({ thread, around, limit }) =>
        scoped(async (tx) => {
          const [t] = await tx.select().from(threads).where(eq(threads.title, thread)).limit(1);
          if (!t) return { error: `No thread called "${thread}" that you can see.` };
          const n = limit ?? 20;
          const centre = date(around);
          const cols = { id: messages.id, sentAt: messages.sentAt, text: messages.text, url: messages.url, author: people.displayName };
          const base = () =>
            tx.select(cols).from(messages).leftJoin(people, eq(people.id, messages.authorPersonId)).$dynamic();
          const rows = centre
            ? [
                ...(await base()
                  .where(and(eq(messages.threadId, t.id), isNull(messages.deletedAt), lte(messages.sentAt, centre)))
                  .orderBy(desc(messages.sentAt))
                  .limit(Math.ceil(n / 2))).reverse(),
                ...(await base()
                  .where(and(eq(messages.threadId, t.id), isNull(messages.deletedAt), sql`${messages.sentAt} > ${centre.toISOString()}`))
                  .orderBy(asc(messages.sentAt))
                  .limit(Math.floor(n / 2))),
              ]
            : (await base().where(and(eq(messages.threadId, t.id), isNull(messages.deletedAt))).orderBy(desc(messages.sentAt)).limit(n)).reverse();
          return {
            thread: t.title,
            messages: rows.map((m) =>
              cite({ thread: t.title ?? "Untitled", kind: t.kind, at: when(m.sentAt), author: m.author ?? undefined, text: m.text, url: m.url ?? t.url ?? undefined, messageId: m.id }),
            ),
          };
        }),
    }),

    listCommitments: tool({
      description:
        "List promises people made, with status (open, due_soon, overdue, done, cancelled), deadline and the exact words. Use for 'what do I owe', 'who am I waiting on', 'what's overdue', 'did X do Y'.",
      inputSchema: z.object({
        person: z.string().nullish().describe("Name of the owner or counterparty; 'me' for the asker"),
        role: z.enum(["owner", "counterparty", "either"]).nullish().describe("How `person` is involved; default either"),
        status: z.array(z.enum(STATUSES)).nullish().describe("Default: open, due_soon, overdue"),
        dueBefore: z.string().nullish(),
        dueAfter: z.string().nullish(),
        about: z.string().nullish().describe("Words in the title or quote"),
        limit: z.number().int().min(1).max(50).nullish(),
      }),
      execute: async ({ person, role, status, dueBefore, dueAfter, about, limit }) =>
        scoped(async (tx) => {
          let personIds: string[] | undefined;
          if (person) {
            personIds =
              person.trim().toLowerCase() === "me"
                ? [viewer.personId]
                : (await tx.select({ id: people.id }).from(people).where(ilike(people.displayName, `%${person.trim()}%`))).map((p) => p.id);
            if (!personIds.length) return { error: `Nobody called "${person}".` };
          }
          const byPerson = personIds
            ? role === "owner"
              ? inArray(commitments.ownerPersonId, personIds)
              : role === "counterparty"
                ? inArray(commitments.counterpartyPersonId, personIds)
                : or(inArray(commitments.ownerPersonId, personIds), inArray(commitments.counterpartyPersonId, personIds))
            : undefined;
          const rows = await tx
            .select({
              id: commitments.id,
              title: commitments.title,
              quote: commitments.quote,
              status: commitments.status,
              dueAt: commitments.dueAt,
              dueText: commitments.dueText,
              owner: owner.displayName,
              counterparty: counterparty.displayName,
              counterpartyText: commitments.counterpartyText,
              closedAt: commitments.closedAt,
              sentAt: messages.sentAt,
              messageId: messages.id,
              url: messages.url,
              thread: threads.title,
              kind: threads.kind,
            })
            .from(commitments)
            .leftJoin(owner, eq(owner.id, commitments.ownerPersonId))
            .leftJoin(counterparty, eq(counterparty.id, commitments.counterpartyPersonId))
            .innerJoin(messages, eq(messages.id, commitments.sourceMessageId))
            .innerJoin(threads, eq(threads.id, messages.threadId))
            .where(
              and(
                inArray(commitments.status, status?.length ? status : ["open", "due_soon", "overdue"]),
                byPerson,
                date(dueBefore) ? lte(commitments.dueAt, date(dueBefore)!) : undefined,
                date(dueAfter) ? gte(commitments.dueAt, date(dueAfter)!) : undefined,
                about ? or(ilike(commitments.title, `%${about}%`), ilike(commitments.quote, `%${about}%`)) : undefined,
              ),
            )
            .orderBy(sql`${commitments.dueAt} asc nulls last`)
            .limit(limit ?? 25);
          return {
            commitments: rows.map((c) => ({
              id: c.id,
              title: c.title,
              owner: c.owner,
              to: c.counterparty ?? c.counterpartyText,
              status: c.status,
              due: c.dueAt ? when(c.dueAt) : (c.dueText ?? "no deadline"),
              closed: c.closedAt ? when(c.closedAt) : undefined,
              source: cite({ thread: c.thread ?? "Untitled", kind: c.kind, at: when(c.sentAt), author: c.owner ?? undefined, text: c.quote, url: c.url ?? undefined, messageId: c.messageId }),
            })),
          };
        }),
    }),

    commitmentHistory: tool({
      description: "Everything that happened to one commitment (created, rescheduled, done...) with the evidence for each change.",
      inputSchema: z.object({ commitmentId: z.string().uuid() }),
      execute: async ({ commitmentId }) =>
        scoped(async (tx) => {
          const events = await tx
            .select({
              type: commitmentEvents.type,
              toStatus: commitmentEvents.toStatus,
              detail: commitmentEvents.detail,
              at: commitmentEvents.createdAt,
              text: messages.text,
              sentAt: messages.sentAt,
              messageId: messages.id,
              url: messages.url,
              thread: threads.title,
              kind: threads.kind,
              author: people.displayName,
            })
            .from(commitmentEvents)
            .leftJoin(messages, eq(messages.id, commitmentEvents.messageId))
            .leftJoin(threads, eq(threads.id, messages.threadId))
            .leftJoin(people, eq(people.id, messages.authorPersonId))
            .where(eq(commitmentEvents.commitmentId, commitmentId))
            .orderBy(asc(commitmentEvents.createdAt));
          if (!events.length) return { error: "No such commitment, or you can't see it." };
          return {
            events: events.map((e) => ({
              type: e.type,
              status: e.toStatus,
              detail: e.detail,
              // Evidence in a thread the asker can't see comes back empty and isn't cited.
              evidence:
                e.messageId && e.text != null
                  ? cite({ thread: e.thread ?? "Untitled", kind: e.kind ?? "", at: when(e.sentAt!), author: e.author ?? undefined, text: e.text, url: e.url ?? undefined, messageId: e.messageId })
                  : undefined,
            })),
          };
        }),
    }),

    dailySummaries: tool({
      description:
        "Daily summaries of each active conversation. Use for big-picture questions like 'what happened last week' or 'catch me up on #eng'.",
      inputSchema: z.object({
        since: z.string().describe("ISO 8601"),
        until: z.string().nullish().describe("ISO 8601; default now"),
        thread: z.string().nullish().describe("Only this thread, by title"),
      }),
      execute: async ({ since, until, thread }) =>
        scoped(async (tx) => {
          const rows = await tx
            .select({ summary: rollups.summary, start: rollups.periodStart, thread: threads.title, kind: threads.kind, url: threads.url })
            .from(rollups)
            .innerJoin(threads, eq(threads.id, rollups.scopeId))
            .where(
              and(
                eq(rollups.scopeType, "thread"),
                gte(rollups.periodEnd, date(since) ?? new Date(0)),
                lte(rollups.periodStart, date(until) ?? new Date()),
                thread ? eq(threads.title, thread) : undefined,
              ),
            )
            .orderBy(asc(rollups.periodStart))
            .limit(60);
          return {
            summaries: rows.map((r) =>
              cite({ thread: r.thread ?? "Untitled", kind: r.kind, at: when(r.start), text: r.summary, url: r.url ?? undefined }),
            ),
          };
        }),
    }),

    lookupEntity: tool({
      description:
        "Look up a company, person, deal, project or product: what is true about it now, how that changed over time, and what it's connected to (up to 3 hops).",
      inputSchema: z.object({
        name: z.string(),
        includeHistory: z.boolean().nullish().describe("Also return facts that are no longer true"),
        hops: z.number().int().min(1).max(3).nullish(),
      }),
      execute: async ({ name, includeHistory, hops }) =>
        scoped(async (tx) => {
          const [entity] = await tx
            .select({ id: entities.id, name: entities.name, type: entities.type, summary: entities.summary })
            .from(entities)
            .where(
              or(
                ilike(entities.name, name),
                inArray(entities.id, tx.select({ id: entityAliases.entityId }).from(entityAliases).where(ilike(entityAliases.alias, name))),
                sql`similarity(${entities.name}, ${name}) > 0.4`,
              ),
            )
            .orderBy(sql`similarity(${entities.name}, ${name}) desc`)
            .limit(1);
          if (!entity) return { error: `Nothing known about "${name}".` };

          // Breadth-first over current facts, up to `hops` away. RLS hides edges from unseen sources.
          const seen = new Set([entity.id]);
          let frontier = [entity.id];
          const facts: { fact: string; relation: string; validFrom: Date | null; validTo: Date | null; current: boolean; hop: number; messageId: string }[] = [];
          for (let hop = 1; hop <= (hops ?? 1) && frontier.length; hop++) {
            const rows = await tx
              .select()
              .from(edges)
              .where(
                and(
                  or(inArray(edges.sourceEntityId, frontier), inArray(edges.targetEntityId, frontier)),
                  hop === 1 && includeHistory ? undefined : isNull(edges.expiredAt),
                ),
              )
              .orderBy(asc(edges.validFrom))
              .limit(60);
            const nextFrontier: string[] = [];
            for (const e of rows) {
              facts.push({ fact: e.fact, relation: e.relation, validFrom: e.validFrom, validTo: e.validTo, current: !e.expiredAt, hop, messageId: e.sourceMessageIds[0] });
              for (const id of [e.sourceEntityId, e.targetEntityId]) {
                if (!seen.has(id)) {
                  seen.add(id);
                  nextFrontier.push(id);
                }
              }
            }
            frontier = nextFrontier;
          }

          const evidence = facts.length
            ? await tx
                .select({ id: messages.id, sentAt: messages.sentAt, url: messages.url, text: messages.text, thread: threads.title, kind: threads.kind, author: people.displayName })
                .from(messages)
                .innerJoin(threads, eq(threads.id, messages.threadId))
                .leftJoin(people, eq(people.id, messages.authorPersonId))
                .where(inArray(messages.id, [...new Set(facts.map((f) => f.messageId))]))
            : [];
          const byId = new Map(evidence.map((m) => [m.id, m]));
          return {
            entity: { name: entity.name, type: entity.type, summary: entity.summary },
            facts: [...new Set(facts)].map((f) => {
              const m = byId.get(f.messageId);
              return {
                fact: f.fact,
                relation: f.relation,
                current: f.current,
                hop: f.hop,
                validFrom: f.validFrom ? when(f.validFrom) : undefined,
                validTo: f.validTo ? when(f.validTo) : undefined,
                source: m
                  ? cite({ thread: m.thread ?? "Untitled", kind: m.kind, at: when(m.sentAt), author: m.author ?? undefined, text: m.text, url: m.url ?? undefined, messageId: m.id })
                  : undefined,
              };
            }),
          };
        }),
    }),
  };
}

export type AgentTools = ReturnType<typeof agentTools>;

function date(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
