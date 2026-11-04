import { embedMany, generateText, Output } from "ai";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordRun, type Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { chunks, edges, entities, entityAliases, entityMentions, messages, people, threadMembers, threads } from "@/db/schema";
import { unionAcl } from "@/db/scope";
import { rowsOf } from "@/memory/search";
import { findOrCreateEntity, mentionedEntities, squashedSql, type Person } from "./extract";

/** Chunks read per model call batch; calls in a batch run in parallel, writes apply in order. */
const PARALLEL_CALLS = 4;
const MAX_CHUNKS_PER_RUN = 400;
/** Past this, an entity's accumulated description is condensed by the model. */
const MAX_SUMMARY_CHARS = 1200;
const MAX_MESSAGE_CHARS = 3000;
/** Existing entities closest in meaning to a chunk, shown to the model so it reuses them. */
const SIMILAR_ENTITIES = 12;

export const GRAPH_SYSTEM = `You build a company's knowledge graph from its conversations (chats, email, meetings).

From one conversation excerpt, extract:
ENTITIES: the people, companies, products, projects, deals, and recurring topics or ideas the conversation is about. Include things the team is planning, building, choosing between or deciding on (a product name being considered, a pricing plan, a feature, a client, a tool). Skip generic words ("meeting", "the call", "website" on its own), one-off small talk, and unnamed speakers ("Speaker 1"): only named people are entities.
- name: the most complete form used (full names for people as they appear in the excerpt). When it is the same thing as a KNOWN ENTITY, even if worded differently here ("the deck" for "Series A pitch deck"), use the KNOWN ENTITY's exact name.
- description: 1-2 sentences on what this excerpt says about it, concrete: numbers, dates, who, what was decided or proposed.
- aliases: other names used for it in the excerpt.

RELATIONS: how two of those entities are connected according to the excerpt.
- relation: snake_case (works_on, proposed, decided, prefers, owns, client_of, uses, competes_with, part_of, priced_at, status_is, responsible_for, considering).
- fact: one self-contained sentence a reader understands without the excerpt, with names and dates.
- evidence: the message label (M1, M2, ...) that shows it.
- If a relation replaces a CURRENT FACT (F1, F2, ...), e.g. a changed decision, price, owner or status, list it in invalidates.
- Skip relations already in CURRENT FACTS unchanged.

Messages may mix English and Hindi (Hinglish); write descriptions and facts in English. Return empty lists for small talk.`;

export const graphSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["person", "company", "deal", "project", "product", "topic", "other"]),
      description: z.string(),
      aliases: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({
      source: z.string().describe("Entity name"),
      relation: z.string(),
      target: z.string().describe("Entity name"),
      fact: z.string(),
      evidence: z.string().describe("Message label, e.g. M3"),
      invalidates: z.array(z.string()).describe("F labels this relation replaces"),
    }),
  ),
});
export type GraphExtraction = z.infer<typeof graphSchema>;

export interface GraphStats {
  chunks: number;
  failed: number;
  entities: number;
  relations: number;
}

interface PendingChunk {
  id: string;
  threadId: string;
  text: string;
  messageIds: string[];
  acl: string[];
}

/**
 * Reads every chunk not yet in the graph and adds what it says: entities with
 * descriptions, where each is mentioned, and relations between them. Old facts
 * a new one contradicts are expired, not deleted (see edges). Safe to rerun.
 */
export async function graphPending(db: Db, orgId: string, models: Models, opts: { maxChunks?: number } = {}): Promise<GraphStats> {
  const stats: GraphStats = { chunks: 0, failed: 0, entities: 0, relations: 0 };
  const pending: PendingChunk[] = await db
    .select({ id: chunks.id, threadId: chunks.threadId, text: chunks.text, messageIds: chunks.messageIds, acl: chunks.acl })
    .from(chunks)
    .where(and(eq(chunks.orgId, orgId), isNull(chunks.graphedAt)))
    .orderBy(asc(chunks.startAt))
    .limit(opts.maxChunks ?? MAX_CHUNKS_PER_RUN);

  const grown = new Set<string>();
  for (let i = 0; i < pending.length; i += PARALLEL_CALLS) {
    const batch = pending.slice(i, i + PARALLEL_CALLS);
    const prepared = await Promise.all(batch.map((c) => prepare(db, orgId, c)));
    const answers = await Promise.allSettled(prepared.map((p) => read(models, p.prompt)));
    for (const [j, answer] of answers.entries()) {
      const p = prepared[j];
      if (answer.status === "rejected") {
        // Stays pending; the next run retries it.
        stats.failed++;
        console.error(`graph extraction failed for chunk ${p.chunk.id}`, answer.reason instanceof Error ? answer.reason.message : answer.reason);
        continue;
      }
      await recordRun(db, { orgId, stage: "graph", model: models.graph, inputTokens: answer.value.usage.inputTokens, outputTokens: answer.value.usage.outputTokens, messageIds: p.chunk.messageIds });
      const touched = await apply(db, orgId, models, p, answer.value.output, stats);
      for (const id of touched) grown.add(id);
      stats.chunks++;
    }
  }
  for (const id of await mergeDuplicates(db, orgId)) grown.add(id);
  const live = grown.size ? await db.select({ id: entities.id }).from(entities).where(inArray(entities.id, [...grown])) : [];
  if (live.length) await refreshEntities(db, models, live.map((e) => e.id));
  return stats;
}

/**
 * Folds entities whose names differ only in case, spacing or punctuation ("360 Labs",
 * "360labs") into the most mentioned one: its facts, mentions and aliases move over.
 * Chunks read in parallel can each create the same new entity, so this runs after every pass.
 * Returns the entities that absorbed others.
 */
export async function mergeDuplicates(db: Db, orgId: string): Promise<string[]> {
  const groups = rowsOf(
    await db.execute(sql`
      select array_agg(entities.id order by (select count(*) from entity_mentions m where m.entity_id = entities.id) desc, entities.created_at) as ids
      from entities
      where entities.org_id = ${orgId} and length(${squashedSql(entities.name)}) >= 3
      group by ${squashedSql(entities.name)}
      having count(*) > 1
    `),
  ) as { ids: string[] | string }[];

  const kept: string[] = [];
  for (const group of groups) {
    const [keep, ...dupes] = Array.isArray(group.ids) ? group.ids : String(group.ids).replace(/^{|}$/g, "").split(",");
    await mergeEntities(db, orgId, keep, dupes);
    kept.push(keep);
  }
  return kept;
}

/** Folds `dupes` into `keep`: their facts, mentions, aliases, names and visibility move over, then they're deleted. */
export async function mergeEntities(db: Db, orgId: string, keep: string, dupes: string[]) {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const rows = await tx.select().from(entities).where(inArray(entities.id, [keep, ...dupes]));
    const survivor = rows.find((r) => r.id === keep)!;
    const others = rows.filter((r) => r.id !== keep);
    await tx.update(edges).set({ sourceEntityId: keep }).where(inArray(edges.sourceEntityId, dupes));
    await tx.update(edges).set({ targetEntityId: keep }).where(inArray(edges.targetEntityId, dupes));
    await tx.delete(edges).where(and(eq(edges.sourceEntityId, keep), eq(edges.targetEntityId, keep)));
    await tx.execute(sql`
      insert into entity_mentions (entity_id, chunk_id, org_id, description)
      select ${keep}, chunk_id, org_id, description from entity_mentions where entity_id = any(${`{${dupes.join(",")}}`}::uuid[])
      on conflict do nothing`);
    await tx.execute(sql`
      insert into entity_aliases (entity_id, org_id, alias)
      select ${keep}, org_id, alias from entity_aliases where entity_id = any(${`{${dupes.join(",")}}`}::uuid[])
      on conflict do nothing`);
    const aliases = others.map((o) => o.name).filter((n) => n !== survivor.name);
    if (aliases.length) await tx.insert(entityAliases).values(aliases.map((alias) => ({ orgId, entityId: keep, alias }))).onConflictDoNothing();
    const summary = [survivor.summary, ...others.map((o) => o.summary)].filter(Boolean).join(" ");
    await tx
      .update(entities)
      .set({ acl: unionAcl(...rows.map((r) => r.acl)), summary: summary || null, personId: survivor.personId ?? others.find((o) => o.personId)?.personId })
      .where(eq(entities.id, keep));
    await tx.delete(entities).where(inArray(entities.id, dupes));
  });
}

async function read(models: Models, prompt: string) {
  const { output, usage } = await generateText({ model: models.graph, instructions: GRAPH_SYSTEM, prompt, output: Output.object({ schema: graphSchema }) });
  return { output, usage };
}

interface Prepared {
  chunk: PendingChunk;
  prompt: string;
  /** M1, M2, ... → message id */
  labels: Map<string, string>;
  directory: Person[];
  current: { id: string }[];
}

async function prepare(db: Db, orgId: string, chunk: PendingChunk): Promise<Prepared> {
  const [thread] = await db.select({ title: threads.title, kind: threads.kind }).from(threads).where(eq(threads.id, chunk.threadId));
  const msgs = await db
    .select({ id: messages.id, sentAt: messages.sentAt, text: messages.text, authorPersonId: messages.authorPersonId, author: people.displayName })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.authorPersonId))
    .where(inArray(messages.id, chunk.messageIds))
    .orderBy(asc(messages.sentAt), asc(messages.externalId));

  const members = await db.select({ personId: threadMembers.personId }).from(threadMembers).where(eq(threadMembers.threadId, chunk.threadId));
  const ids = [...new Set([...members.map((m) => m.personId), ...msgs.flatMap((m) => (m.authorPersonId ? [m.authorPersonId] : []))])];
  const directory: Person[] = ids.length
    ? await db.select({ id: people.id, displayName: people.displayName, isMember: people.isMember }).from(people).where(inArray(people.id, ids))
    : [];

  // Entities this chunk names, plus those closest in meaning to it, so the same thing described differently
  // in another source ("the deck" in a chat, "Series A pitch deck" in an email) is recognised and reused.
  const named = await mentionedEntities(db, orgId, chunk.text.toLowerCase());
  const similar = rowsOf(
    await db.execute(sql`
      select e.id from entities e, chunks c
      where c.id = ${chunk.id} and e.org_id = ${orgId} and e.name_embedding is not null and c.embedding is not null
      order by e.name_embedding <=> c.embedding
      limit ${SIMILAR_ENTITIES}
    `),
  ) as { id: string }[];
  const knownIds = [...new Set([...named.map((k) => k.id), ...similar.map((k) => k.id)])];
  const knownRows = knownIds.length
    ? await db.select({ id: entities.id, name: entities.name, type: entities.type, summary: entities.summary }).from(entities).where(inArray(entities.id, knownIds))
    : [];
  const current = knownRows.length
    ? await db
        .select({ id: edges.id, fact: edges.fact })
        .from(edges)
        .where(and(eq(edges.orgId, orgId), isNull(edges.expiredAt), or(inArray(edges.sourceEntityId, knownRows.map((e) => e.id)), inArray(edges.targetEntityId, knownRows.map((e) => e.id)))))
        .orderBy(desc(edges.createdAt))
        .limit(40)
    : [];

  // One part of a long pasted message: its text is the chunk, not the whole message.
  const single = msgs.length === 1;
  const labels = new Map(msgs.map((m, i) => [`M${i + 1}`, m.id]));
  const body = single
    ? `M1 ${msgs[0].author ?? "Unknown"}: ${chunk.text.split("\n").slice(1).join("\n")}`
    : msgs
        .map((m, i) => `M${i + 1} (${m.sentAt.toISOString().slice(0, 16)}) ${m.author ?? "Unknown"}: ${m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text}`)
        .join("\n");

  const prompt = [
    `CONVERSATION: ${thread?.title ?? "Untitled"} (${thread?.kind ?? "chat"})`,
    `PEOPLE: ${directory.map((p) => p.displayName).join("; ") || "(unknown)"}`,
    `KNOWN ENTITIES:\n${knownRows.map((e) => `- ${e.name} (${e.type})${e.summary ? `: ${e.summary.slice(0, 160)}` : ""}`).join("\n") || "(none)"}`,
    `CURRENT FACTS:\n${current.map((f, i) => `F${i + 1}. ${f.fact}`).join("\n") || "(none)"}`,
    `MESSAGES:\n${body}`,
  ].join("\n\n");
  return { chunk, prompt, labels, directory, current };
}

/** Writes one chunk's entities, mentions and relations. Returns the entities whose description grew. */
async function apply(db: Db, orgId: string, models: Models, p: Prepared, out: GraphExtraction, stats: GraphStats): Promise<string[]> {
  const newEdges: { id: string; text: string }[] = [];
  const touched = new Set<string>();
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const ids = new Map<string, string>();
    const typeOf = (name: string) => out.entities.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase())?.type ?? "other";
    const entityFor = async (name: string, aliases: string[] = []) => {
      const key = name.trim().toLowerCase();
      if (!ids.has(key)) {
        const { id, isNew } = await findOrCreateEntity(tx, orgId, { name: name.trim(), type: typeOf(name), aliases }, p.chunk.acl, p.directory);
        if (isNew) stats.entities++;
        ids.set(key, id);
      }
      return ids.get(key)!;
    };

    for (const e of out.entities) {
      if (!usefulName(e.name)) continue;
      const id = await entityFor(e.name, e.aliases);
      await tx
        .insert(entityMentions)
        .values({ orgId, entityId: id, chunkId: p.chunk.id, description: e.description })
        .onConflictDoUpdate({ target: [entityMentions.entityId, entityMentions.chunkId], set: { description: e.description } });
      await appendDescription(tx, id, e.description);
      touched.add(id);
    }

    for (const r of out.relations) {
      if (!usefulName(r.source) || !usefulName(r.target) || r.source.trim().toLowerCase() === r.target.trim().toLowerCase()) continue;
      const sourceId = await entityFor(r.source);
      const targetId = await entityFor(r.target);
      const relation = r.relation.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "related_to";
      const replaced = r.invalidates.map((l) => (/^F\d+$/.test(l.trim()) ? p.current[Number(l.trim().slice(1)) - 1]?.id : undefined)).filter((id): id is string => !!id);
      const evidence = p.labels.get(r.evidence.trim());
      const [validFrom] = evidence ? await tx.select({ at: messages.sentAt }).from(messages).where(eq(messages.id, evidence)) : [];
      // The same connection again: identical, it adds nothing (a thread's last chunk is rebuilt as it grows).
      // Different, the later evidence wins. Chunks are read in parallel, so the model can't always see the older fact.
      const same = await tx
        .select({ id: edges.id, fact: edges.fact, validFrom: edges.validFrom })
        .from(edges)
        .where(and(eq(edges.sourceEntityId, sourceId), eq(edges.targetEntityId, targetId), eq(edges.relation, relation), isNull(edges.expiredAt)));
      if (same.some((e) => sameFact(e.fact, r.fact))) continue;
      const at = validFrom?.at;
      if (at && same.some((e) => e.validFrom && e.validFrom > at)) continue;
      replaced.push(...same.map((e) => e.id));
      const [edge] = await tx
        .insert(edges)
        .values({
          orgId,
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relation,
          fact: r.fact,
          validFrom: validFrom?.at,
          sourceMessageIds: evidence ? [evidence] : p.chunk.messageIds,
          sourceChunkId: p.chunk.id,
          acl: p.chunk.acl,
        })
        .returning({ id: edges.id });
      newEdges.push({ id: edge.id, text: r.fact });
      stats.relations++;
      if (replaced.length) {
        await tx
          .update(edges)
          .set({ validTo: validFrom?.at ?? new Date(), expiredAt: new Date(), invalidatedBy: edge.id })
          .where(and(inArray(edges.id, replaced), isNull(edges.expiredAt)));
      }
    }
    await tx.update(chunks).set({ graphedAt: new Date() }).where(eq(chunks.id, p.chunk.id));
  });

  if (newEdges.length) {
    const { embeddings, usage } = await embedMany({ model: models.embed, values: newEdges.map((e) => e.text), dimensions: models.embedDimensions });
    await recordRun(db, { orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
    for (const [i, e] of newEdges.entries()) await db.update(edges).set({ factEmbedding: embeddings[i] }).where(eq(edges.id, e.id));
  }
  return [...touched];
}

/** Placeholders models emit for unnamed people and things ("Speaker 1", "Unknown", "User") aren't entities. */
const PLACEHOLDER = /^(speaker|participant|person|user|caller|unknown|someone|anonymous|you|me)\s*\d*$/i;
export const usefulName = (name: string) => name.trim().length >= 2 && !PLACEHOLDER.test(name.trim());

const sameFact = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** Adds a new description to an entity's running summary, unless it's already there. */
async function appendDescription(db: Db, entityId: string, description: string) {
  const text = description.trim();
  if (!text) return;
  await db
    .update(entities)
    .set({
      summary: sql`case when ${entities.summary} is null or ${entities.summary} = '' then ${text}
        when position(${text} in ${entities.summary}) > 0 then ${entities.summary}
        else ${entities.summary} || ' ' || ${text} end`,
      updatedAt: new Date(),
    })
    .where(eq(entities.id, entityId));
}

const CONDENSE_SYSTEM = `You keep one entry of a company's knowledge graph short. Rewrite the notes about this entity as at most 4 sentences (under 600 characters): what it is, who is involved, the latest state, key numbers and dates. When notes disagree, the later note wins. English only, no preamble.`;

/**
 * Condenses overgrown summaries, then re-embeds each touched entity as
 * "name (type): summary", so search matches what an entity is, not just its name.
 */
async function refreshEntities(db: Db, models: Models, ids: string[]) {
  const rows = await db.select({ id: entities.id, orgId: entities.orgId, name: entities.name, type: entities.type, summary: entities.summary }).from(entities).where(inArray(entities.id, ids));
  for (const e of rows) {
    if (!e.summary || e.summary.length <= MAX_SUMMARY_CHARS) continue;
    try {
      const { text, usage } = await generateText({ model: models.graph, instructions: CONDENSE_SYSTEM, prompt: `ENTITY: ${e.name} (${e.type})\nNOTES, oldest first:\n${e.summary}` });
      await recordRun(db, { orgId: e.orgId, stage: "graph", model: models.graph, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      e.summary = text.trim();
      await db.update(entities).set({ summary: e.summary }).where(eq(entities.id, e.id));
    } catch (err) {
      console.error(`condensing entity ${e.id} failed`, err instanceof Error ? err.message : err);
    }
  }
  for (let i = 0; i < rows.length; i += 64) {
    const batch = rows.slice(i, i + 64);
    const { embeddings, usage } = await embedMany({ model: models.embed, values: batch.map(entityText), dimensions: models.embedDimensions });
    await recordRun(db, { orgId: batch[0].orgId, stage: "embed", model: models.embed, inputTokens: usage.tokens });
    for (const [j, e] of batch.entries()) await db.update(entities).set({ nameEmbedding: embeddings[j] }).where(eq(entities.id, e.id));
  }
}

export const entityText = (e: { name: string; type: string; summary: string | null }) => `${e.name} (${e.type})${e.summary ? `: ${e.summary.slice(0, 1500)}` : ""}`;

