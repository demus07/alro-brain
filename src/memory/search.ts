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
}

/** Reciprocal rank fusion constant (Cormack et al.); 60 is the usual default. */
const RRF_K = 60;
const CANDIDATES = 50;

/**
 * Hybrid search over chunks: vector similarity, keyword match and (when given)
 * graph-linked chunks, merged by reciprocal rank fusion. Call it with the transaction from withScope(), so
 * row-level security drops anything the asker couldn't see in the source.
 */
export async function searchChunks(
  tx: Db,
  query: { text: string; embedding: number[] },
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const vector = `[${query.embedding.join(",")}]`;
  const since = opts.since?.toISOString() ?? null;
  const until = opts.until?.toISOString() ?? null;
  const graphIds = `{${(opts.graphChunkIds ?? []).join(",")}}`;
  const timeFilter = sql`(${since}::timestamptz is null or c.end_at >= ${since}::timestamptz)
    and (${until}::timestamptz is null or c.start_at <= ${until}::timestamptz)`;

  // HNSW returns a fixed number of candidates before row-level security filters
  // them; iterative scans keep searching until enough visible rows are found.
  await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);

  const result = await tx.execute(sql`
    with vec as (
      select c.id, row_number() over (order by c.embedding <=> ${vector}::halfvec) as rank
      from chunks c
      where c.embedding is not null and ${timeFilter}
      order by c.embedding <=> ${vector}::halfvec
      limit ${CANDIDATES}
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
           c.text, f.score::float8 as score
    from fused f
    join chunks c on c.id = f.id
    join threads t on t.id = c.thread_id
    order by f.score desc, c.end_at desc
    limit ${opts.limit ?? 10}
  `);
  return (rowsOf(result) as Record<string, unknown>[]).map((r) => ({
    ...(r as unknown as SearchHit),
    messageIds: parseUuidArray(r.messageIds),
    startAt: new Date(r.startAt as string),
    endAt: new Date(r.endAt as string),
  }));
}

/** Embeds a question (with the model's query instruction, if it has one). */
export async function embedQuery(models: Models, text: string): Promise<number[]> {
  const { embedding } = await embed({ model: models.embed, value: `${models.queryPrefix ?? ""}${text}`, dimensions: models.embedDimensions });
  return embedding;
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
  const embedding = await embedQuery(models, text);
  const graph = await searchGraph(tx, { text, embedding });
  const hits = await searchChunks(tx, { text, embedding }, { ...opts, graphChunkIds: graph.chunkIds });

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
