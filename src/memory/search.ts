import { embed } from "ai";
import { sql } from "drizzle-orm";
import type { Models } from "@/ai/models";
import type { Db } from "@/db/client";

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
}

/** Reciprocal rank fusion constant (Cormack et al.); 60 is the usual default. */
const RRF_K = 60;
const CANDIDATES = 50;

/**
 * Hybrid search over chunks: vector similarity plus keyword match, merged by
 * reciprocal rank fusion. Call it with the transaction from withScope(), so
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
    fused as (
      select id, sum(1.0 / (${RRF_K} + rank)) as score
      from (select * from vec union all select * from kw) ranked
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

/** Embeds the question, then runs hybrid search. */
export async function search(tx: Db, models: Models, text: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const { embedding } = await embed({ model: models.embed, value: text, dimensions: models.embedDimensions });
  return searchChunks(tx, { text, embedding }, opts);
}

/** node-postgres returns { rows }, PGlite returns { rows } too, but drizzle's types differ per driver. */
export const rowsOf = (result: unknown): unknown[] =>
  Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);

/** Raw SQL returns uuid[] as an array (node-postgres) or as the text form '{a,b}' (PGlite). */
const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value) ? (value as string[]) : String(value ?? "").replace(/^{|}$/g, "").split(",").filter(Boolean);
