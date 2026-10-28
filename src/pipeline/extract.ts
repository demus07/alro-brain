import { embedMany, generateText, Output } from "ai";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { modelId, recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import {
  commitmentEvents,
  commitments,
  edges,
  entities,
  entityAliases,
  messages,
  orgs,
  people,
  threadMembers,
  threads,
} from "@/db/schema";
import { unionAcl } from "@/db/scope";
import { formatLocal } from "@/lib/time";
import { applyUpdate, type UpdateKind } from "./fulfil";

/** New (flagged) messages per model call, and earlier messages shown for context. */
const TARGETS_PER_CALL = 20;
const CONTEXT_BEFORE = 8;
const MAX_MESSAGE_CHARS = 3000;
const MIN_CONFIDENCE = 0.5;
const MIN_CLOSE_CONFIDENCE = 0.65;

export const EXTRACT_SYSTEM = `You maintain a company's memory from its conversations: promises people make ("commitments"), what happens to them, and facts about the business that change over time.

You get a window of messages from one thread. Messages marked * are new; the rest are earlier context. Extract only from * messages, but use the context to understand them.

COMMITMENTS
A commitment is a specific person promising to do a specific thing. Include:
- first-person promises ("I'll send the deck by Sunday", "kal tak kar deti hoon"),
- an explicit acceptance of a request ("sure, will do", "ok I'll handle it"): the owner is whoever accepts, the quote is the acceptance, the title describes the request.
Do NOT extract:
- vague intentions ("sometime", "someday", "at some point", "we should..."),
- conditionals ("if we raise, I'll hire a designer", "if CASA drags, maybe..."),
- requests or questions nobody accepted,
- past-tense reports of things already done (these may be evidence for an update instead),
- jokes and hyperbole ("I'll never touch Jira again lol"),
- promises by people who aren't in the directory, or reported second-hand ("Neha said they'll share data Friday"),
- plans with no single owner ("we need to look at Outlook").
Rules:
- owner and counterparty: full names exactly as in the directory. The counterparty is who it was promised to (may be null, or a name outside the directory).
- quote: the exact words from the message, copied character for character. The shortest span that carries the promise. No paraphrase, no ellipsis.
- If the same promise is already in OPEN COMMITMENTS, do not create it again; add an update instead.
- Deadlines: resolve against the message's local time. "tonight", "today", "tomorrow", "kal", "by Friday", a date → hard, at 23:59 local that day unless a time is given. "this week", "next week", "weekend", "mid-October", "before the demo" → soft, at the end of that period or the latest sensible day. No deadline → dueKind none and dueAt null. dueAt is ISO 8601 with offset.

UPDATES to commitments in OPEN COMMITMENTS (C1, C2, ...) or to ones you create from this window (N1, N2, ...):
- done: a * message says or shows the promised thing is finished (sent, shared, merged, booked, transferred, a CRM deal stage reaching the promised state). Reassurance such as "haan haan, karta hoon", "on it", "will do soon" is NOT done.
- partial: part is done, the rest is still pending.
- rescheduled: a new deadline is agreed (give newDueAt, and newDueText as said).
- cancelled: explicitly dropped, descoped or no longer needed.
- reaffirmed: promised again with no new deadline.
The quote is the exact words that are the evidence.

ENTITIES AND FACTS
Entities: people, companies, deals, projects, products and topics that matter to the business.
Facts: one relation between two entities, as a sentence. Use snake_case relations (prices_at, customer_of, in_scope_of, decided, owns, status_is, uses).
Only facts likely to matter later: prices, decisions, customer or deal status, scope, ownership, vendors, metrics.
When a new fact replaces a CURRENT FACT (F1, F2, ...), e.g. a new price, a changed status, a dropped feature, list it in invalidates.
Skip facts that are already in CURRENT FACTS unchanged.

Messages may mix English and Hindi (Hinglish). Return empty lists when there is nothing to extract.`;

const ref = z.string().describe("Message label, e.g. M3");

export const extractionSchema = z.object({
  commitments: z.array(
    z.object({
      ref: z.string().describe("N1, N2, ... so updates in this answer can refer to it"),
      message: ref,
      quote: z.string(),
      owner: z.string(),
      counterparty: z.string().nullable(),
      title: z.string().describe("Short imperative, e.g. 'Send Finlo the WhatsApp answer'"),
      details: z.string().nullable(),
      dueText: z.string().nullable().describe("The deadline as said, e.g. 'by Friday'"),
      dueAt: z.string().nullable(),
      dueKind: z.enum(["hard", "soft", "none"]),
      confidence: z.number().describe("0 to 1"),
    }),
  ),
  updates: z.array(
    z.object({
      commitment: z.string().describe("C1... or N1..."),
      message: ref,
      kind: z.enum(["done", "partial", "rescheduled", "cancelled", "reaffirmed"]),
      quote: z.string(),
      newDueAt: z.string().nullable(),
      newDueText: z.string().nullable(),
      confidence: z.number().describe("0 to 1"),
    }),
  ),
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["person", "company", "deal", "project", "product", "topic", "other"]),
      aliases: z.array(z.string()),
    }),
  ),
  facts: z.array(
    z.object({
      source: z.string().describe("Entity name"),
      relation: z.string(),
      target: z.string().describe("Entity name"),
      fact: z.string(),
      message: ref,
      validFrom: z.string().nullable().describe("When it became true, ISO 8601, if different from the message time"),
      invalidates: z.array(z.string()).describe("F labels this fact replaces"),
    }),
  ),
});
export type Extraction = z.infer<typeof extractionSchema>;

interface WindowMessage {
  id: string;
  text: string;
  subject: string | null;
  sentAt: Date;
  acl: string[];
  authorPersonId: string | null;
  author: string | null;
  screenResult: "skip" | "extract" | null;
  extractedAt: Date | null;
}

interface Person {
  id: string;
  displayName: string;
  isMember: boolean;
}

export interface ExtractStats {
  calls: number;
  /** Windows whose model call failed; their messages stay pending for the next run. */
  failed: number;
  /** Why answers were thrown away, e.g. { quote_not_in_message: 3 }. */
  rejectedBy: Record<string, number>;
  messages: number;
  commitments: number;
  updates: number;
  facts: number;
  rejected: number;
}

/**
 * Runs extraction over every screened message waiting for it. Work goes one
 * local day at a time across all threads, oldest first, so a promise made in a
 * meeting exists before the Slack message that closes it is read, even when
 * weeks of history arrive at once.
 */
export async function extractPending(db: Db, orgId: string, models: Models, opts: { maxGroups?: number } = {}): Promise<ExtractStats> {
  const stats: ExtractStats = { calls: 0, failed: 0, messages: 0, commitments: 0, updates: 0, facts: 0, rejected: 0, rejectedBy: {} };
  const [org] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.id, orgId));
  // Each pending message's thread and the end of its local day; one group per (thread, day).
  const pending = db
    .select({
      threadId: messages.threadId,
      sentAt: messages.sentAt,
      until: sql<string>`(date_trunc('day', ${messages.sentAt} at time zone ${org.timezone}) + interval '1 day') at time zone ${org.timezone}`.as("until"),
    })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.screenResult, "extract"), isNull(messages.extractedAt), isNull(messages.deletedAt)))
    .as("pending");
  const groups = await db
    .select({ threadId: pending.threadId, until: pending.until })
    .from(pending)
    .groupBy(pending.threadId, pending.until)
    .orderBy(sql`min(${pending.sentAt})`)
    .limit(opts.maxGroups ?? 300);

  for (const g of groups) await extractThread(db, orgId, g.threadId, new Date(g.until), models, org.timezone, stats);
  return stats;
}

/** Extracts a thread's pending messages sent before `until`. */
async function extractThread(db: Db, orgId: string, threadId: string, until: Date, models: Models, timeZone: string, stats: ExtractStats) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  const all: WindowMessage[] = await db
    .select({
      id: messages.id,
      text: messages.text,
      subject: messages.subject,
      sentAt: messages.sentAt,
      acl: messages.acl,
      authorPersonId: messages.authorPersonId,
      author: people.displayName,
      screenResult: messages.screenResult,
      extractedAt: messages.extractedAt,
    })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.sentAt), asc(messages.externalId));

  const targetIdx = all.flatMap((m, i) => (m.screenResult === "extract" && !m.extractedAt && m.sentAt < until ? [i] : []));
  for (let b = 0; b < targetIdx.length; b += TARGETS_PER_CALL) {
    const idx = targetIdx.slice(b, b + TARGETS_PER_CALL);
    const start = Math.max(0, idx[0] - CONTEXT_BEFORE);
    const window = all.slice(start, idx[idx.length - 1] + 1);
    const targets = new Set(idx.map((i) => all[i].id));
    try {
      await extractWindow(db, orgId, thread, window, targets, models, timeZone, stats);
    } catch (e) {
      // One bad answer shouldn't stop the run; these messages stay pending and are retried next time.
      stats.failed++;
      console.error(`extraction failed for thread ${threadId}`, e instanceof Error ? e.message : e);
    }
  }
}

async function extractWindow(
  db: Db,
  orgId: string,
  thread: typeof threads.$inferSelect,
  window: WindowMessage[],
  targets: Set<string>,
  models: Models,
  timeZone: string,
  stats: ExtractStats,
) {
  // Directory: members, the thread's members and everyone speaking in the window.
  const members = await db.select({ personId: threadMembers.personId }).from(threadMembers).where(eq(threadMembers.threadId, thread.id));
  const involved = [...new Set([...members.map((m) => m.personId), ...window.flatMap((m) => (m.authorPersonId ? [m.authorPersonId] : []))])];
  const directory: Person[] = await db
    .select({ id: people.id, displayName: people.displayName, isMember: people.isMember })
    .from(people)
    .where(and(eq(people.orgId, orgId), involved.length ? or(eq(people.isMember, true), inArray(people.id, involved)) : eq(people.isMember, true)));
  const involvedIds = [...new Set([...involved, ...directory.filter((p) => p.isMember).map((p) => p.id)])];

  const open = await db
    .select()
    .from(commitments)
    .where(
      and(
        eq(commitments.orgId, orgId),
        inArray(commitments.status, ["open", "due_soon", "overdue"]),
        or(inArray(commitments.ownerPersonId, involvedIds), inArray(commitments.counterpartyPersonId, involvedIds)),
      ),
    )
    .orderBy(desc(commitments.createdAt))
    .limit(40);

  const windowText = window.map((m) => m.text).join("\n").toLowerCase();
  const known = await mentionedEntities(db, orgId, windowText);
  const current = known.length
    ? await db
        .select({ id: edges.id, fact: edges.fact, relation: edges.relation, validFrom: edges.validFrom })
        .from(edges)
        .where(
          and(
            eq(edges.orgId, orgId),
            isNull(edges.expiredAt),
            or(inArray(edges.sourceEntityId, known.map((e) => e.id)), inArray(edges.targetEntityId, known.map((e) => e.id))),
          ),
        )
        .orderBy(desc(edges.createdAt))
        .limit(40)
    : [];

  const nameOf = new Map(directory.map((p) => [p.id, p.displayName]));
  const label = new Map(window.map((m, i) => [`M${i + 1}`, m]));
  const prompt = [
    `THREAD: ${thread.title ?? "Untitled"} (${thread.kind})`,
    `DIRECTORY: ${directory.map((p) => `${p.displayName}${p.isMember ? " (team)" : ""}`).join("; ")}`,
    `OPEN COMMITMENTS:\n${
      open
        .map(
          (c, i) =>
            `C${i + 1}. ${nameOf.get(c.ownerPersonId ?? "") ?? "Unknown"} → ${nameOf.get(c.counterpartyPersonId ?? "") ?? c.counterpartyText ?? "?"}: ${c.title}` +
            ` (due ${c.dueAt ? formatLocal(c.dueAt, timeZone) : (c.dueText ?? "none")}; status ${c.status}; said "${c.quote}")`,
        )
        .join("\n") || "(none)"
    }`,
    `CURRENT FACTS:\n${current.map((f, i) => `F${i + 1}. ${f.fact}`).join("\n") || "(none)"}`,
    `MESSAGES:\n${window
      .map((m, i) => {
        const text = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
        const subject = m.subject ? ` [subject: ${m.subject}]` : "";
        return `${targets.has(m.id) ? "*" : " "}M${i + 1} (${formatLocal(m.sentAt, timeZone)}) ${m.author ?? "Unknown"}${subject}: ${text}`;
      })
      .join("\n\n")}`,
  ].join("\n\n");

  const { output, usage } = await generateText({
    model: models.extract,
    instructions: EXTRACT_SYSTEM,
    prompt,
    output: Output.object({ schema: extractionSchema }),
  });
  stats.calls++;
  stats.messages += targets.size;
  await recordRun(db, {
    orgId,
    stage: "extract",
    model: models.extract,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    messageIds: [...targets],
  });

  // Small models sometimes answer 95 for 0.95; schema limits on numbers aren't enforced by every provider.
  for (const item of [...output.commitments, ...output.updates]) item.confidence = normalizeConfidence(item.confidence);

  const newEmbeddings: { table: "entities" | "edges"; id: string; text: string }[] = [];
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    /**
     * The new message an answer refers to. Models sometimes cite the wrong
     * label; the quote must match word for word anyway, so when exactly one
     * new message contains it, that's the one.
     */
    const target = (labelRef: string, quote?: string) => {
      const m = label.get(labelRef.trim());
      if (m && targets.has(m.id) && (!quote || containsQuote(m.text, quote))) return m;
      if (!quote) return undefined;
      const matches = window.filter((w) => targets.has(w.id) && containsQuote(w.text, quote));
      return matches.length === 1 ? matches[0] : undefined;
    };
    const person = (name: string | null) => (name ? resolveName(name, directory) : undefined);
    const reject = (why: string) => {
      stats.rejected++;
      stats.rejectedBy[why] = (stats.rejectedBy[why] ?? 0) + 1;
    };
    const created = new Map<string, string>();

    for (const c of output.commitments) {
      const m = target(c.message, c.quote);
      const owner = person(c.owner);
      const why = !m
        ? "not_a_new_message"
        : !owner
          ? "owner_not_in_directory"
          : !containsQuote(m.text, c.quote)
            ? "quote_not_in_message"
            : c.confidence < MIN_CONFIDENCE
              ? "low_confidence"
              : undefined;
      if (why || !m || !owner) {
        reject(`commitment_${why}`);
        continue;
      }
      const quote = exactQuote(m.text, c.quote);
      const [dupe] = await tx
        .select({ id: commitments.id })
        .from(commitments)
        .where(and(eq(commitments.sourceMessageId, m.id), eq(commitments.quote, quote)));
      if (dupe) {
        created.set(c.ref, dupe.id);
        continue;
      }
      const counterparty = person(c.counterparty);
      const dueAt = parseDate(c.dueAt);
      const [row] = await tx
        .insert(commitments)
        .values({
          orgId,
          ownerPersonId: owner.id,
          counterpartyPersonId: counterparty?.id,
          counterpartyText: counterparty ? undefined : (c.counterparty ?? undefined),
          title: c.title,
          details: c.details ?? undefined,
          quote,
          dueAt,
          dueKind: dueAt ? c.dueKind : "none",
          dueText: c.dueText ?? undefined,
          confidence: c.confidence,
          sourceMessageId: m.id,
          extractor: modelId(models.extract),
          // Visible wherever the promise was made, and always to the two people it's between.
          acl: unionAcl(m.acl, [`p:${owner.id}`], counterparty ? [`p:${counterparty.id}`] : []),
        })
        .returning({ id: commitments.id });
      await tx.insert(commitmentEvents).values({
        orgId,
        commitmentId: row.id,
        type: "created",
        toStatus: "open",
        messageId: m.id,
        actor: "system",
        detail: { quote, confidence: c.confidence },
      });
      created.set(c.ref, row.id);
      stats.commitments++;
    }

    // Oldest evidence first, so "rescheduled" then "done" apply in order.
    const updates = output.updates
      .map((u) => ({ u, m: target(u.message, u.quote) }))
      .sort((a, b) => (a.m?.sentAt.getTime() ?? 0) - (b.m?.sentAt.getTime() ?? 0));
    for (const { u, m } of updates) {
      const commitmentId = /^C\d+$/.test(u.commitment) ? open[Number(u.commitment.slice(1)) - 1]?.id : created.get(u.commitment);
      const closes = u.kind === "done" || u.kind === "cancelled";
      const why = !m
        ? "not_a_new_message"
        : !commitmentId
          ? "unknown_commitment"
          : !containsQuote(m.text, u.quote)
            ? "quote_not_in_message"
            : u.confidence < (closes ? MIN_CLOSE_CONFIDENCE : MIN_CONFIDENCE)
              ? "low_confidence"
              : undefined;
      if (why || !m || !commitmentId) {
        reject(`update_${why}`);
        continue;
      }
      const applied = await applyUpdate(tx, commitmentId, {
        kind: u.kind as UpdateKind,
        message: m,
        quote: exactQuote(m.text, u.quote),
        newDueAt: parseDate(u.newDueAt),
        newDueText: u.newDueText ?? undefined,
        confidence: u.confidence,
        actor: "system",
      });
      if (applied) stats.updates++;
    }

    const entityIds = new Map<string, string>();
    const entityFor = async (name: string, type: Extraction["entities"][number]["type"], aliases: string[], acl: string[]) => {
      const key = name.trim().toLowerCase();
      if (!entityIds.has(key)) {
        const { id, isNew } = await findOrCreateEntity(tx, orgId, { name: name.trim(), type, aliases }, acl, directory);
        entityIds.set(key, id);
        if (isNew) newEmbeddings.push({ table: "entities", id, text: name.trim() });
      }
      return entityIds.get(key)!;
    };
    const windowAcl = unionAcl(...window.filter((m) => targets.has(m.id)).map((m) => m.acl));
    for (const e of output.entities) await entityFor(e.name, e.type, e.aliases, windowAcl);

    for (const f of output.facts) {
      const m = target(f.message);
      if (!m || !f.source.trim() || !f.target.trim()) {
        reject(!m ? "fact_not_a_new_message" : "fact_missing_entity");
        continue;
      }
      const typeOf = (n: string) => output.entities.find((e) => e.name.trim().toLowerCase() === n.trim().toLowerCase())?.type ?? "other";
      const sourceId = await entityFor(f.source, typeOf(f.source), [], m.acl);
      const targetId = await entityFor(f.target, typeOf(f.target), [], m.acl);
      const validFrom = parseDate(f.validFrom) ?? m.sentAt;
      const [edge] = await tx
        .insert(edges)
        .values({
          orgId,
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relation: f.relation.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          fact: f.fact,
          validFrom,
          sourceMessageIds: [m.id],
          acl: m.acl,
        })
        .returning({ id: edges.id });
      newEmbeddings.push({ table: "edges", id: edge.id, text: f.fact });
      stats.facts++;

      const replaced = f.invalidates.map((l) => (/^F\d+$/.test(l) ? current[Number(l.slice(1)) - 1]?.id : undefined)).filter((id): id is string => !!id);
      if (replaced.length) {
        await tx
          .update(edges)
          .set({ validTo: validFrom, expiredAt: new Date(), invalidatedBy: edge.id })
          .where(and(inArray(edges.id, replaced), isNull(edges.expiredAt)));
      }
    }

    await tx.update(messages).set({ extractedAt: new Date() }).where(inArray(messages.id, [...targets]));
  });

  if (newEmbeddings.length) await embedNew(db, orgId, models, newEmbeddings);
}

async function embedNew(db: Db, orgId: string, models: Models, items: { table: "entities" | "edges"; id: string; text: string }[]) {
  const { embeddings, usage } = await embedMany({ model: models.embed, values: items.map((i) => i.text), dimensions: models.embedDimensions });
  await recordRun(db, { orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
  for (const [i, item] of items.entries()) {
    if (item.table === "entities") await db.update(entities).set({ nameEmbedding: embeddings[i] }).where(eq(entities.id, item.id));
    else await db.update(edges).set({ factEmbedding: embeddings[i] }).where(eq(edges.id, item.id));
  }
}

/** Entities whose name or alias appears in the text (for showing their current facts to the model). */
async function mentionedEntities(db: Db, orgId: string, lowerText: string) {
  const names = await db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(eq(entities.orgId, orgId))
    .union(
      db
        .select({ id: entityAliases.entityId, name: entityAliases.alias })
        .from(entityAliases)
        .where(eq(entityAliases.orgId, orgId)),
    );
  const seen = new Map<string, { id: string; name: string }>();
  for (const n of names) {
    if (n.name.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n.name.toLowerCase())}($|[^\\p{L}\\p{N}])`, "u").test(lowerText)) {
      seen.set(n.id, n);
    }
  }
  return [...seen.values()].slice(0, 30);
}

/**
 * Same entity if the name or an alias matches exactly, or a same-type entity's
 * name is very similar (trigram). New evidence widens who can see it.
 */
async function findOrCreateEntity(
  db: Db,
  orgId: string,
  e: { name: string; type: Extraction["entities"][number]["type"]; aliases: string[] },
  acl: string[],
  directory: Person[],
): Promise<{ id: string; isNew: boolean }> {
  const names = [e.name, ...e.aliases].map((n) => n.trim()).filter(Boolean);
  const lower = names.map((n) => n.toLowerCase());
  const [exact] = await db
    .select({ id: entities.id, acl: entities.acl })
    .from(entities)
    .where(
      and(
        eq(entities.orgId, orgId),
        or(
          inArray(sql`lower(${entities.name})`, lower),
          inArray(entities.id, db.select({ id: entityAliases.entityId }).from(entityAliases).where(and(eq(entityAliases.orgId, orgId), inArray(sql`lower(${entityAliases.alias})`, lower)))),
        ),
      ),
    )
    .limit(1);
  const [similar] = exact
    ? [exact]
    : await db
        .select({ id: entities.id, acl: entities.acl })
        .from(entities)
        .where(and(eq(entities.orgId, orgId), eq(entities.type, e.type), sql`similarity(${entities.name}, ${e.name}) > 0.6`))
        .orderBy(sql`similarity(${entities.name}, ${e.name}) desc`)
        .limit(1);

  let id: string;
  let isNew = false;
  if (similar) {
    id = similar.id;
    const merged = unionAcl(similar.acl, acl);
    if (merged.length !== similar.acl.length) await db.update(entities).set({ acl: merged }).where(eq(entities.id, id));
  } else {
    const person = e.type === "person" ? resolveName(e.name, directory) : undefined;
    const [row] = await db.insert(entities).values({ orgId, type: e.type, name: e.name, personId: person?.id, acl }).returning({ id: entities.id });
    id = row.id;
    isNew = true;
  }
  const aliases = names.filter((n) => n.toLowerCase() !== e.name.toLowerCase() || !isNew);
  if (aliases.length) {
    await db
      .insert(entityAliases)
      .values([...new Set(aliases)].map((alias) => ({ orgId, entityId: id, alias })))
      .onConflictDoNothing();
  }
  return { id, isNew };
}

/** A directory person by full name, or by a first name only one person has. */
export function resolveName(name: string, directory: Person[]): Person | undefined {
  const n = name.trim().toLowerCase();
  const exact = directory.filter((p) => p.displayName.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const first = directory.filter((p) => p.displayName.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
  return first.length === 1 ? first[0] : undefined;
}

const normalize = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** The quote appears in the message, ignoring curly quotes and whitespace differences. */
export const containsQuote = (text: string, quote: string) => quote.trim().length >= 3 && normalize(text).includes(normalize(quote));

/** The quote as it appears in the message, so stored quotes are always exact substrings. */
export function exactQuote(text: string, quote: string): string {
  if (text.includes(quote)) return quote;
  const target = normalize(quote);
  // Find the shortest span of the original text that normalizes to the quote.
  for (let start = 0; start < text.length; start++) {
    if (normalize(text[start]) !== target[0]) continue;
    for (let end = start + 1; end <= text.length; end++) {
      const span = normalize(text.slice(start, end));
      if (span === target) return text.slice(start, end);
      if (!target.startsWith(span)) break;
    }
  }
  return quote;
}

export const normalizeConfidence = (x: number) => (x > 1 ? Math.min(1, x / 100) : Math.max(0, x));

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
