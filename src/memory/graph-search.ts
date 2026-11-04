import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rowsOf } from "./search";

export interface GraphEntity {
  id: string;
  name: string;
  type: string;
  summary: string | null;
}

export interface GraphFact {
  id: string;
  fact: string;
  relation: string;
  source: string;
  target: string;
  current: boolean;
  validFrom: Date | null;
  validTo: Date | null;
  messageId: string | null;
}

export interface GraphContext {
  entities: GraphEntity[];
  facts: GraphFact[];
  /** Chunks the graph points at, best first: where the matched entities and facts come from. */
  chunkIds: string[];
  /** Each of those chunks' thread. */
  chunkThreads: Record<string, string>;
}

const SEED_ENTITIES = 6;
const SEED_FACTS = 12;
const NEIGHBOUR_FACTS = 24;
const CHUNKS = 20;
/** Chunks per thread ranked ahead of the rest, so several sources get a say. */
const PER_THREAD = 3;
const RRF_K = 60;

/**
 * Local graph search (as in LightRAG / Microsoft GraphRAG's local search):
 *   1. seed entities: closest by meaning to the question, plus any named in it;
 *   2. seed facts: relations whose sentence is closest to the question;
 *   3. expand one hop from the seed entities, keeping the facts most relevant to the question;
 *   4. the conversations those entities are mentioned in and those facts were read from.
 * Run it inside withScope(): row-level security hides entities, facts and chunks the asker can't see.
 */
export async function searchGraph(tx: Db, query: { text: string; embedding: number[] }): Promise<GraphContext> {
  const vector = `[${query.embedding.join(",")}]`;
  await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);

  const entityRows = rowsOf(
    await tx.execute(sql`
      with vec as (
        select e.id, row_number() over (order by e.name_embedding <=> ${vector}::halfvec) as rank
        from entities e
        where e.name_embedding is not null
        order by e.name_embedding <=> ${vector}::halfvec
        limit 20
      ),
      named as (
        select id, row_number() over (order by sim desc) as rank
        from (
          select e.id, max(greatest(word_similarity(lower(e.name), lower(${query.text})), coalesce(word_similarity(lower(a.alias), lower(${query.text})), 0))) as sim
          from entities e left join entity_aliases a on a.entity_id = e.id
          group by e.id
        ) s
        where sim >= 0.8
        order by sim desc
        limit 10
      ),
      fused as (
        select id, sum(1.0 / (${RRF_K} + rank)) as score from (select * from vec union all select * from named) r group by id
      )
      select e.id, e.name, e.type, e.summary from fused f join entities e on e.id = f.id
      order by f.score desc limit ${SEED_ENTITIES}
    `),
  ) as GraphEntity[];
  const seedIds = entityRows.map((e) => e.id);
  const seedArray = sql`${`{${seedIds.join(",")}}`}::uuid[]`;

  const factRows = rowsOf(
    await tx.execute(sql`
      with seed_facts as (
        select g.id, 1 as tier, g.fact_embedding <=> ${vector}::halfvec as distance
        from edges g
        where g.fact_embedding is not null and g.expired_at is null
        order by g.fact_embedding <=> ${vector}::halfvec
        limit ${SEED_FACTS}
      ),
      neighbours as (
        select g.id, 2 as tier, coalesce(g.fact_embedding <=> ${vector}::halfvec, 1) as distance
        from edges g
        where (g.source_entity_id = any(${seedArray}) or g.target_entity_id = any(${seedArray}))
        order by g.expired_at is null desc, coalesce(g.fact_embedding <=> ${vector}::halfvec, 1)
        limit ${NEIGHBOUR_FACTS}
      ),
      picked as (
        select id, min(tier) as tier, min(distance) as distance from (select * from seed_facts union all select * from neighbours) x group by id
      )
      select g.id, g.fact, g.relation, s.name as source, t.name as target, g.expired_at is null as current,
             g.valid_from as "validFrom", g.valid_to as "validTo", g.source_message_ids[1] as "messageId", g.source_chunk_id as "chunkId"
      from picked p
      join edges g on g.id = p.id
      join entities s on s.id = g.source_entity_id
      join entities t on t.id = g.target_entity_id
      order by p.distance asc, g.valid_from desc nulls last
    `),
  ) as (GraphFact & { chunkId: string | null })[];

  // Conversations the graph points at. Each scores by how central the seed entities it mentions are
  // and how much it says about them (a detailed email beats a one-line chat), plus holding a seed fact.
  // Then at most a few per thread first, so detail from another source isn't crowded out by one busy chat.
  const factChunks = [...new Set(factRows.flatMap((f) => (f.chunkId ? [f.chunkId] : [])))];
  const weights = `{${seedIds.map((_, i) => (1 / (i + 1)).toFixed(4)).join(",")}}`;
  const chunkRows = seedIds.length || factChunks.length
    ? (rowsOf(
        await tx.execute(sql`
          with seeds as (
            select id, weight from unnest(${seedArray}, ${weights}::float8[]) as s(id, weight)
          ),
          scored as (
            select c.id, c.thread_id,
                   coalesce(sum(s.weight * (1 + least(length(coalesce(m.description, '')), 400) / 200.0)), 0)
                   + case when c.id = any(${`{${factChunks.join(",")}}`}::uuid[]) then 1 else 0 end as score,
                   c.end_at
            from chunks c
            left join entity_mentions m on m.chunk_id = c.id and m.entity_id = any(${seedArray})
            left join seeds s on s.id = m.entity_id
            where m.entity_id is not null or c.id = any(${`{${factChunks.join(",")}}`}::uuid[])
            group by c.id
          )
          select id, thread_id as "threadId"
          from (select *, row_number() over (partition by thread_id order by score desc, end_at desc) as in_thread from scored) r
          order by (in_thread <= ${PER_THREAD}) desc, score desc, end_at desc
          limit ${CHUNKS}
        `),
      ) as { id: string; threadId: string }[])
    : [];

  return {
    entities: entityRows,
    facts: factRows.map((f) => ({
      ...f,
      current: f.current === true || (f.current as unknown) === "t",
      validFrom: f.validFrom ? new Date(f.validFrom) : null,
      validTo: f.validTo ? new Date(f.validTo) : null,
    })),
    chunkIds: chunkRows.map((c) => c.id),
    chunkThreads: Object.fromEntries(chunkRows.map((c) => [c.id, c.threadId])),
  };
}
