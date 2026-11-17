import { embed } from "ai";
import { sql } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";
import { searchGraph, type GraphContext } from "./graph-search";

export interface SearchHit {
  chunkId: string;
  threadId: string;
  threadTitle: string | null;
  threadKind: string;
  threadUrl: string | null;
  messageIds: string[];
  startAt: Date;
  endAt: Date;
  text: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  /** Only chunks overlapping this time range. */
  since?: Date;
  until?: Date;
  /** Chunks the knowledge graph points at, best first; fused in as a third ranking. */
  graphChunkIds?: string[];
  /** The entities the question is about (the graph's matched seeds), most relevant first; chunks that mention them rank higher. */
  entityIds?: string[];
  /** The moment recency is measured from when the question has no time window (defaults to the current time). */
  now?: Date;
}

/** Reciprocal rank fusion constant (Cormack et al.); 60 is the usual default. */
const RRF_K = 60;
const CANDIDATES = 50;

/**
 * Re-ranking, applied to the fused candidates. No model call: five signals, each 0 to 1,
 * weighted (the five weights add up to 1):
 *   fused     its fusion score (rank by meaning, keywords and graph links), relative to the best candidate's
 *   meaning   how close it is to the question in meaning, relative to the closest candidate. Fusion only
 *             knows ranks, so this is what tells a real match from the best of a bad lot
 *   entities  how much it is about the things the question names (the graph's matched seed entities; the first counts most)
 *   recency   how close it is to the end of the question's time window, or to now
 *   source    where it was said (sourceWeight)
 * Fusion scores are nearly flat between neighbouring ranks, so the last three decide between
 * close matches and can't lift a chunk that barely matched over one that matched in every list.
 * Facts are ordered in graph-search.ts by distance from the question, using the last two numbers.
 */
export const RANKING = {
  fused: 0.45,
  meaning: 0.15,
  entities: 0.16,
  recency: 0.12,
  source: 0.12,
  /** Without a time window, a chunk this many days old counts half as recent as one from today. */
  halfLifeDays: 90,
  /** Decisions and detail are in documents, meeting notes and email more than in chat; an unknown kind counts as chat. */
  sourceWeight: { doc: 1, meeting: 0.9, email: 0.85, crm_timeline: 0.7, upload: 0.6, channel: 0.5, group_dm: 0.45, dm: 0.45, whatsapp: 0.45 } as Record<string, number>,
  /** Fused candidates considered per result asked for (at least 30). */
  pool: 3,
  /** Facts: added to a historical fact's distance from the question, so a current one of similar relevance comes first. */
  historicalPenalty: 0.15,
  /** Facts: how far confidence above or below the usual 0.7 moves a fact (a verified one by -0.06, a guess by about +0.05). */
  confidence: 0.2,
};

const DAY = 86_400_000;

export interface RankSignals {
  /** Fusion score. */
  fused: number;
  /** Cosine similarity to the question (0 when the chunk has no embedding). */
  similarity: number;
  /** 0 to 1: share of the question's entities (weighted) this chunk mentions. */
  entities: number;
  threadKind: string;
  endAt: Date;
}

/** The re-ranked score of each candidate, in the order given. Pure, so the weights can be tested without a database. */
export function rerankScores(candidates: RankSignals[], opts: Pick<SearchOptions, "since" | "until" | "now"> = {}): number[] {
  const now = opts.now ?? new Date();
  const end = opts.until && opts.until < now ? opts.until : now;
  const halfLife = opts.since ? Math.max(DAY, (end.getTime() - opts.since.getTime()) / 2) : RANKING.halfLifeDays * DAY;
  const best = Math.max(...candidates.map((c) => c.fused), Number.EPSILON);
  const closest = Math.max(...candidates.map((c) => c.similarity), Number.EPSILON);
  return candidates.map(
    (c) =>
      RANKING.fused * (c.fused / best) +
      RANKING.meaning * (Math.max(0, c.similarity) / closest) +
      RANKING.entities * Math.min(1, c.entities) +
      RANKING.recency * 0.5 ** (Math.max(0, end.getTime() - c.endAt.getTime()) / halfLife) +
      RANKING.source * (RANKING.sourceWeight[c.threadKind] ?? RANKING.sourceWeight.channel),
  );
}

/**
 * Hybrid search over chunks: vector similarity, keyword match and (when given)
 * graph-linked chunks, merged by reciprocal rank fusion, then re-ranked (see RANKING). Call it with
 * the transaction from withScope(): row-level security drops anything the asker couldn't see in the
 * source inside the query, before any ranking happens here.
 */
export async function searchChunks(
  tx: Db,
  query: { text: string; embedding: number[] | null },
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  // Without an embedding (the embedding provider failed), search runs on keywords and graph links alone.
  const vector = query.embedding ? `[${query.embedding.join(",")}]` : null;
  const since = opts.since?.toISOString() ?? null;
  const until = opts.until?.toISOString() ?? null;
  const graphIds = `{${(opts.graphChunkIds ?? []).join(",")}}`;
  const limit = opts.limit ?? 10;
  // The question's entities, the first weighing most; a chunk's share of the total is its entity signal.
  const seeds = opts.entityIds ?? [];
  const seedWeights = seeds.map((_, i) => 1 / (i + 1));
  const totalWeight = seedWeights.reduce((a, b) => a + b, 0) || 1;
  const timeFilter = sql`(${since}::timestamptz is null or c.end_at >= ${since}::timestamptz)
    and (${until}::timestamptz is null or c.start_at <= ${until}::timestamptz)`;

  // HNSW returns a fixed number of candidates before row-level security filters
  // them; iterative scans keep searching until enough visible rows are found.
  await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);

  const result = await tx.execute(sql`
    with vec as (
      ${
        vector
          ? sql`select c.id, row_number() over (order by c.embedding <=> ${vector}::halfvec) as rank
      from chunks c
      where c.embedding is not null and ${timeFilter}
      order by c.embedding <=> ${vector}::halfvec
      limit ${CANDIDATES}`
          : sql`select null::uuid as id, null::bigint as rank where false`
      }
    ),
    kw as (
      select c.id, row_number() over (order by ts_rank_cd(c.tsv, q) desc) as rank
      from chunks c, websearch_to_tsquery('simple', ${query.text}) q
      where c.tsv @@ q and ${timeFilter}
      order by ts_rank_cd(c.tsv, q) desc
      limit ${CANDIDATES}
    ),
    gr as (
      select c.id, g.rank
      from unnest(${graphIds}::uuid[]) with ordinality as g(id, rank)
      join chunks c on c.id = g.id
      where ${timeFilter}
    ),
    fused as (
      select id, sum(1.0 / (${RRF_K} + rank)) as score
      from (select * from vec union all select * from kw union all select * from gr) ranked
      group by id
    )
    select c.id as "chunkId", c.thread_id as "threadId", t.title as "threadTitle", t.kind as "threadKind",
           t.url as "threadUrl", c.message_ids as "messageIds", c.start_at as "startAt", c.end_at as "endAt",
           c.text, f.score::float8 as score,
           ${vector ? sql`coalesce(1 - (c.embedding <=> ${vector}::halfvec), 0)` : sql`0`}::float8 as similarity,
           coalesce((
             select sum(s.weight) from entity_mentions m
             join unnest(${`{${seeds.join(",")}}`}::uuid[], ${`{${seedWeights.map((w) => w.toFixed(4)).join(",")}}`}::float8[]) as s(id, weight) on s.id = m.entity_id
             where m.chunk_id = c.id
           ), 0)::float8 as "entityWeight"
    from fused f
    join chunks c on c.id = f.id
    join threads t on t.id = c.thread_id
    order by f.score desc, c.end_at desc
    limit ${Math.max(30, limit * RANKING.pool)}
  `);
  const candidates = (rowsOf(result) as Record<string, unknown>[]).map(({ entityWeight, similarity, ...r }) => ({
    hit: { ...(r as unknown as SearchHit), messageIds: parseUuidArray(r.messageIds), startAt: new Date(r.startAt as string), endAt: new Date(r.endAt as string) },
    similarity: Number(similarity),
    entities: Number(entityWeight) / totalWeight,
  }));
  const scores = rerankScores(candidates.map((c) => ({ fused: c.hit.score, similarity: c.similarity, entities: c.entities, threadKind: c.hit.threadKind, endAt: c.hit.endAt })), opts);
  return candidates
    .map((c, i) => ({ ...c.hit, score: scores[i] }))
    .sort((a, b) => b.score - a.score || b.endAt.getTime() - a.endAt.getTime())
    .slice(0, limit);
}

/**
 * Embedding a question is on the path of every answer, so it gives up quickly: one retry and a
 * time limit, instead of the default three tries with no limit (a stalled provider used to hold
 * an answer for minutes).
 */
const QUERY_EMBED_TIMEOUT_MS = 10_000;
const QUERY_EMBED_RETRIES = 1;

/** Embeds a question (with the model's query instruction, if it has one). */
export async function embedQuery(models: Models, text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: models.embed,
    value: `${models.queryPrefix ?? ""}${text}`,
    dimensions: models.embedDimensions,
    maxRetries: QUERY_EMBED_RETRIES,
    abortSignal: AbortSignal.timeout(QUERY_EMBED_TIMEOUT_MS),
  });
  return embedding;
}

/** embedQuery, or null when the embedding provider fails, so search can carry on without meaning. */
export async function tryEmbedQuery(models: Models, text: string): Promise<number[] | null> {
  try {
    return await embedQuery(models, text);
  } catch (e) {
    console.warn("question embedding failed; searching by keywords and graph only:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * GraphRAG retrieval: the knowledge graph around the question (entities,
 * facts, where they come from), and conversation chunks ranked by meaning,
 * keywords and graph links together.
 */
export async function recall(
  tx: Db,
  models: Models,
  text: string,
  opts: SearchOptions = {},
): Promise<{ hits: SearchHit[]; related: SearchHit[]; graph: GraphContext }> {
  const embedding = await tryEmbedQuery(models, text);
  const graph = await searchGraph(tx, { text, embedding });
  const hits = await searchChunks(tx, { text, embedding }, { ...opts, graphChunkIds: graph.chunkIds, entityIds: graph.entities.filter((e) => e.matched).map((e) => e.id) });

  // The same things discussed in other conversations the hits didn't reach: a passing mention in
  // WhatsApp often has its detail in an email or a meeting. Always offered, best first.
  const seen = new Set(hits.map((h) => h.threadId));
  const elsewhere = graph.chunkIds.filter((id) => !seen.has(graph.chunkThreads[id])).slice(0, RELATED * 3);
  const related = elsewhere.length ? await chunksById(tx, elsewhere) : [];
  const picked: SearchHit[] = [];
  for (const h of related) {
    if (picked.length >= RELATED) break;
    if (picked.filter((p) => p.threadId === h.threadId).length < 2) picked.push(h);
  }
  return { hits, related: picked, graph };
}

/** How many excerpts from other conversations a search adds. */
const RELATED = 3;

/** Chunks by id, in the given order. Inside withScope(), invisible ones drop out. */
async function chunksById(tx: Db, ids: string[]): Promise<SearchHit[]> {
  const rows = rowsOf(
    await tx.execute(sql`
      select c.id as "chunkId", c.thread_id as "threadId", t.title as "threadTitle", t.kind as "threadKind",
             t.url as "threadUrl", c.message_ids as "messageIds", c.start_at as "startAt", c.end_at as "endAt",
             c.text, 0::float8 as score
      from unnest(${`{${ids.join(",")}}`}::uuid[]) with ordinality as g(id, n)
      join chunks c on c.id = g.id
      join threads t on t.id = c.thread_id
      order by g.n
    `),
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as SearchHit),
    messageIds: parseUuidArray(r.messageIds),
    startAt: new Date(r.startAt as string),
    endAt: new Date(r.endAt as string),
  }));
}

/** Embeds the question, then runs hybrid search. */
export async function search(tx: Db, models: Models, text: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  return (await recall(tx, models, text, opts)).hits;
}

/** node-postgres returns { rows }, PGlite returns { rows } too, but drizzle's types differ per driver. */
export const rowsOf = (result: unknown): unknown[] =>
  Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);

/** Raw SQL returns uuid[] as an array (node-postgres) or as the text form '{a,b}' (PGlite). */
const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value) ? (value as string[]) : String(value ?? "").replace(/^{|}$/g, "").split(",").filter(Boolean);
