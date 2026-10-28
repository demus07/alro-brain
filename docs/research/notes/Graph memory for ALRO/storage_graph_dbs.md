# Storage options for ALRO graph + vector memory (Next.js / TypeScript / Vercel / Neon Postgres)

Research date: 2026-10-27. About 20 search/fetch calls. Many vendor pricing and benchmark figures come from vendor pages or secondary aggregators, and are flagged where that applies. Where these notes give no URL, the claim is an inference or a gap, not a sourced fact.

## Q1. Can ALRO do "graph memory" with just Postgres (Neon) for Phase 1, and what are the limits?

### Takeaway
Yes, most likely. The workload for a company brain is mostly 1–3 hop lookups ("who at Acme owns Deal X, what did they promise"), and a well-indexed adjacency-table model with recursive CTEs, pgvector and tsvector performs competitively at that depth. Neon offers pgvector (0.8.x), pg_trgm, ltree, pg_graphql and pgrouting. It does **not** list Apache AGE or pgvectorscale, so on Neon "graph in Postgres" means plain relational modelling, not Cypher. The risks are deep or unbounded traversals (recursive CTEs materialise intermediate results and have no visited set) and analytics across the whole graph (community detection, PageRank), which belong in application code or a later dedicated engine.

### Cited Findings
**Neon extension availability**
- Neon's extension list includes `vector` (pgvector) 0.8.0 on PG14–17 and **0.8.6 on PG18**. It also lists pg_trgm 1.6, ltree 1.2/1.3, pg_graphql 1.5.x, pgrouting 3.4–3.8 (needs PostGIS) and rum 1.3 (not on PG18). — [Neon Postgres extensions](https://neon.com/docs/extensions/pg-extensions)
- On Neon, timescaledb is limited to Apache-2 features (no compression). **pg_search (ParadeDB BM25) is unavailable on all versions.** The page points to "Lakebase Search" for full-text search and marks the pg_search preload library as deprecated. — [Neon Postgres extensions](https://neon.com/docs/extensions/pg-extensions)
- **Apache AGE and pgvectorscale do not appear** in Neon's extension list. — [Neon Postgres extensions](https://neon.com/docs/extensions/pg-extensions)
- Databricks agreed to acquire Neon in May 2025. The "Lakebase" branding on Neon's docs suggests integration with Databricks has gone ahead. — [Sacra on Neon](https://sacra.com/c/neon/), [Neon extensions page](https://neon.com/docs/extensions/pg-extensions)

**Neon pricing, branching and driver (secondary sources only)**
- Neon has used usage-based plans since August 2025. Paid tiers have a $5/month minimum. Compute costs $0.106/CU-hour on Launch and $0.222/CU-hour on Scale; storage costs $0.35/GB-month and extra branches $1.50/branch-month. — [Sacra](https://sacra.com/research/neon). A reseller page gives conflicting figures ($19/mo for 10 GB) and is probably out of date. — [subger.com](https://subger.com/en/service/neon-db)
- Copy-on-write branching is described as Neon's main differentiator, creating a branch per pull request in milliseconds. — [metavert.io comparison](https://metavert.io/compare/neon-vs-supabase)
- The serverless driver supports WebSocket and HTTP connections for edge/serverless platforms, including Vercel. — [pulse.support](https://pulse.support/kb/neon-postgres) (secondary)

**Recursive CTE vs graph DB performance**
- A self-run test reports a 6-hop traversal on a 200K-node graph finishing in under 2 ms on PG16. It argues the common "100x faster" Neo4j claims compare an indexed Neo4j model against an unindexed CTE. — [markaicode Neo4j vs Postgres](https://markaicode.com/vs/neo4j-vs-postgres/) (blog, low rigour)
- On pgsql-hackers, a naive recursive CTE took 299 ms against 528 ms for Neo4j even after a Neo4j index was added (down from 819 ms). Neo4j did not finish for the most-connected user. — [PostgreSQL mailing list](https://postgresql.org/message-id/0e98dbc4-4116-4e15-bf72-3a7d4ab0d27d%40app.fastmail.com)
- The README of the pg_igraph extension reports a 47 s recursive CTE against 227 ms with the extension on a 335K-node tree. It blames the recursive executor for materialising intermediate results without a visited set across iterations. — [pg_igraph on PGXN](https://pgxn.org/dist/pg_igraph/) (the extension author's own claim)
- Graph-DB vendors argue that index-free adjacency makes traversal cost depend on the part of the graph touched, not total size, so the gap grows with depth. This is an architectural argument, not a measurement. — [PuppyGraph Postgres vs Neo4j](https://www.puppygraph.com/learn/postgres-vs-neo4j)
- A worked example of graph retrieval for RAG built on recursive CTEs. — [sheshbabu.com](https://www.sheshbabu.com/posts/graph-retrieval-using-postgres-recursive-ctes/)

**pgvector at millions of messages**
- pgvector 0.8+ adds iterative index scans (`hnsw.iterative_scan` = `strict_order` / `relaxed_order`, bounded by `hnsw.max_scan_tuples`). They are off by default. Without them, a filter matching 10% of rows with `ef_search=40` leaves about 4 results for LIMIT 10. — [Render: multi-tenant RAG with pgvector](https://render.com/articles/multi-tenant-rag-postgresql-pgvector), [Crunchy Data hybrid search](https://www.crunchydata.com/blog/hybrid-vector-search)
- The HNSW index needs to fit in RAM. One independent test found that 1M × 1536-dim vectors did not fit. — [thebuild.com on pgvectorscale](https://thebuild.com/blog/on-pgvectorscale-and-hybrid-search-without-an-elasticsearch-sidecar/), [ClickHouse on scaling pgvector](https://clickhouse.com/resources/engineering/scale-vector-search-postgres)
- pgvectorscale (StreamingDiskANN, from Timescale/Tiger Data) claims **28x lower p95 latency and 16x higher QPS than Pinecone s1** at 99% recall on 50M × 768-dim Cohere vectors. This is a vendor benchmark. The current version is 0.9.0 (Nov 2025, parallel index builds). — [pgvectorscale GitHub](https://github.com/timescale/pgvectorscale), [aicoolies review](https://aicoolies.com/reviews/pgvectorscale-review)
- pgvectorscale is available on Tiger Data (Timescale) Cloud and DigitalOcean managed Postgres, but **not on Neon**. — [Tiger docs](https://www.tigerdata.com/docs/reference/pgvectorscale), [DigitalOcean docs](https://docs.digitalocean.com/products/vector-databases/postgresql/how-to/advanced-workloads/), [Neon extensions](https://neon.com/docs/extensions/pg-extensions)

### Inferences
- A practical Phase 1 schema: `entities(id, tenant_id, type, name, attrs jsonb, embedding vector, tsv tsvector)`, `edges(src, dst, type, tenant_id, valid_from, valid_to, invalidated_at, source_msg_id, acl…)`, `facts`/`commitments` tables with bitemporal columns, and `messages(…, embedding)`. With B-tree indexes on `(tenant_id, src, type)` and `(tenant_id, dst, type)`, 1–3 hop CTEs (or simply 2–3 chained joins) stay fast. Cap the depth explicitly, add a cycle guard (`CYCLE` clause in PG14+), and set `statement_timeout`.
- This is the same model Graphiti/Zep use (episodes, entity nodes, edges with `valid_at`/`invalid_at`), so moving to Neo4j or FalkorDB later is mostly an ETL job. That holds only if edges keep provenance (source message id) and validity time from day one.
- Limits to expect: more than ~4 hops or unbounded path queries; graph algorithms (community detection, as in GraphRAG/LightRAG global search); and super-nodes (e.g. a "company" node linked to millions of messages). All of these get slow in plain SQL. Mitigate with precomputed summaries and materialised neighbourhoods, or move to a graph engine.
- Without pg_search (BM25) on Neon, hybrid search has to use native `tsvector`/`ts_rank` plus pgvector, fused with RRF in SQL. This works but ranks worse than BM25.
- At "millions of messages" (say 5–20M chunks × 1536 dims ≈ 30–120 GB of raw vectors), pgvector HNSW on Neon needs a large compute size to keep the index in memory. Ways to keep costs down: smaller dimensions (512–1024 via Matryoshka truncation), `halfvec` (pgvector ≥0.7), or partitioning by tenant. Without pgvectorscale, Neon has no disk-based ANN option.

### Gaps
- No rigorous independent benchmark of recursive CTEs against Neo4j or FalkorDB at depths above 3 on realistic knowledge-graph data.
- Could not confirm current Neon pricing on neon.com itself. The Sacra figures are secondary.
- Could not verify whether Neon plans to add pgvectorscale or AGE, or what "Lakebase Search" offers for BM25 on standard Neon projects.
- No current details found on `@neondatabase/serverless` and Vercel Fluid compute. My understanding is that with Fluid's long-lived Node functions, a standard `pg` pool or the Neon WebSocket Pool is preferred over HTTP for transactions, and RLS needs `SET LOCAL` inside a transaction. This was not verified this session.

## Q2. Graph DB options compared (Neo4j, FalkorDB, Kuzu/LadybugDB, Memgraph, AGE, SurrealDB, ArangoDB, TigerGraph, Neptune)

### Takeaway
If ALRO adds a dedicated graph DB later, the realistic choices are **Neo4j AuraDB** (most mature, best supported by memory frameworks, but expensive per GB and multi-database only on Business Critical) and **FalkorDB** (SSPL, built for many small graphs per tenant, official TS client, supported by Graphiti). **Kuzu was archived in October 2025** after Apple acquired its developer. **LadybugDB** is the MIT fork, and Cognee now defaults to it, but it is embedded and single-writer, which fits Vercel functions poorly. Apache AGE is not available on Neon, Supabase or (apparently) RDS; it is GA on Azure Database for PostgreSQL.

### Cited Findings
**Neo4j AuraDB**
- Free tier: $0, 1 GB, up to 200K nodes / 400K relationships. Free DBs are deleted after 30 days without activity. — [Neo4j Aura quotas and limits](https://neo4j.com/docs/aura/quotas-and-limits/), [Aura FAQ](https://neo4j.com/cloud/platform/aura-graph-database/faq/)
- Professional: from $0.09/GB/hour (~$65/GB/month), 1 GB minimum, up to 128 GB RAM, single zone, 7-day backups. — [Neo4j pricing](https://neo4j.com/pricing/)
- Business Critical: from $0.20/GB/hour, 2 GB minimum, up to 512 GB (AWS/Azure) or 2 TB (GCP), multi-zone, 99.95% SLA, 30-day backups. **Multiple databases per instance are listed explicitly for this tier.** — [Neo4j pricing](https://neo4j.com/pricing/). Note that a secondary rendering of the same page gives ~$146/GB/month, which does not exactly match $0.20/GB/h (~$146/mo). They are consistent once rounded. — [search snapshot of the pricing page](https://neo4j.com/cloud/aura/pricing/)
- Paused paid databases are billed at 20%. — [Aura pricing / FAQ](https://neo4j.com/cloud/platform/aura-graph-database/faq/)
- Aura Graph Analytics costs $0.40/GB/hour. — [Neo4j pricing](https://neo4j.com/pricing/)
- Graphiti requires Neo4j ≥5.26 for full functionality. — [Graphiti graph-driver docs](https://mintlify.com/getzep/graphiti/guides/graph-drivers)
- In Cognee, Neo4j Community supports only one database per server, so per-dataset isolation means one Docker container per dataset (default cap: 6). On Aura, the `neo4j_aura_dev` handler provisions a separate Aura instance per dataset. — [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores)

**FalkorDB**
- License: **SSPLv1** (source-available). Official Node.js client `falkordb-ts` (MIT, on npm). It describes itself as an "Ultra-fast, Multi-tenant Graph Database" and supports named graphs. — [FalkorDB GitHub](https://github.com/FalkorDB/FalkorDB)
- Vendor claims: multi-tenancy on all plans, with "over 10,000 multi-graphs". Neo4j offers multi-tenancy only in enterprise. Latency "up to 496x faster" and 6x better memory efficiency than Neo4j (82/18 read/write mix; benchmark.falkordb.com). — [FalkorDB vs Neo4j](https://www.falkordb.com/falkordb-vs-neo4j/). These are **vendor marketing claims and were not independently verified.**
- Graphiti supports FalkorDB (`graphiti-core[falkordb]`, FalkorDB ≥1.1.2). — [Zep Graphiti DB config](https://help.getzep.com/graphiti/configuration/graph-db-configuration)
- FalkorDB Cloud has a free instance, but no cloud prices were found. — [FalkorDB try-free](https://falkordb.com/try-free/)

**Kuzu / LadybugDB**
- The Kuzu repo was **archived on 10 Oct 2025** (read-only). Its last release was v0.11.3. — [OneUptime: Kuzu archived](https://oneuptime.com/blog/post/2026-08-12-kuzu-archived-pin-0-11-3-fork-or-migrate/view)
- The archiving followed Apple's acquisition of Kùzu Inc. — [PuppyGraph: what is KuzuDB](https://www.puppygraph.com/blog/what-is-kuzudb), [DBDB LadybugDB](https://dbdb.io/db/ladybugdb)
- LadybugDB is an MIT-licensed C++ fork ("the database formerly known as Kuzu") and is active. Migrating from Kuzu needs work on package names and extensions. — [DBDB LadybugDB](https://dbdb.io/db/ladybugdb), [OneUptime: Kuzu to LadybugDB](https://oneuptime.com/blog/post/2026-08-12-kuzu-to-ladybugdb-packages-apis-extensions-database-files/markdown)
- Cognee's default graph store is now Ladybug (`kuzu` is an alias), with a `ladybug-remote` HTTP mode. Cognee says Ladybug is single-writer, single-machine and **not suited to production scale**. — [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores)

**Apache AGE (Cypher on Postgres)**
- GA on **Azure Database for PostgreSQL** since May 2025. AGE 1.6.0 on PG16 was added in Jan 2026 and PG18 support in Apr 2026. — [Microsoft Tech Community GA post](https://techcommunity.microsoft.com/blog/adforpostgresql/-/4413894), [Azure Jan 2026 notes](https://docs.azure.cn/en-us/postgresql/release-notes-maintenance/2026-january), [Azure Apr 2026 notes](https://docs.azure.cn/en-us/postgresql/release-notes-maintenance/2026-april). One user could not enable it on PG 17.6 in March 2026. — [Microsoft Q&A](https://learn.microsoft.com/en-za/answers/questions/5817689/unable-to-enable-apache-age-extension-on-azure-pos)
- **Not on Neon** (absent from the list). — [Neon extensions](https://neon.com/docs/extensions/pg-extensions)
- **Not directly supported on Amazon RDS** (GitHub feature request; the date is unclear). — [apache/age #998](https://github.com/apache/age/issues/998)
- No evidence of support on Supabase. AGE is classed as an "untrusted" extension that needs superuser, which is a plausible reason managed hosts leave it out. — [Pigsty extension list](https://cc.pigsty.io/ext/feat/_print/), [Supabase extension vote #679](https://github.com/orgs/supabase/discussions/679). Requests are also open at Aiven, DigitalOcean and Render. — [Aiven ideas](https://ideas.aiven.io/forums/951280-operational-databases/suggestions/47151826-support-for-apache-age-postgresql-extension), [DO ideas](https://ideas.digitalocean.com/managed-database/p/support-apache-age-postgresql-extension), [Render community](https://community.render.com/t/does-managed-postgres-support-apache-age/3557)
- VMware Tanzu for Postgres planned to bundle AGE from 18.4 (expected end of May 2026). — [Broadcom KB](https://knowledge.broadcom.com/external/article/442082/apache-age-extension-availability-in-vmw.html)

**Amazon Neptune**
- Neptune Analytics is billed in memory-optimised NCUs (1 GB memory plus compute per hour). It can be paused at 10% of the compute price. Database Savings Plans have covered it since 5 Mar 2026. — [usage.ai Neptune pricing](https://www.usage.ai/blogs/aws/database-savings-plans/neptune-pricing/) (third-party)
- Supported by Graphiti, Mem0 (Neptune Analytics and Neptune DB) and Cognee. In Cognee, Neptune has **no per-dataset isolation**: all datasets share one graph. — [Graphiti drivers](https://www.mintlify.com/getzep/graphiti/api/drivers/overview), [Mem0 graph memory](https://docs.mem0.ai/open-source/features/graph-memory), [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores)

**Memgraph**
- Prices for Memgraph Cloud (beta) and Enterprise are not published. Enterprise is reported to start around $25K/yr (unverified aggregator). — [apis.io Memgraph plans](https://apis.io/plans/memgraph/memgraph-plans-pricing/)
- Supported by Mem0, LightRAG and Cognee (community adapter). — [Mem0 docs](https://docs.mem0.ai/open-source/features/graph-memory), [LightRAG GitHub](https://github.com/HKUDS/LightRAG), [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores)

**SurrealDB, ArangoDB, TigerGraph**
- No current pricing or status found for SurrealDB Cloud. DB-Engines only confirms it is open source and multi-model. — [DB-Engines comparison](https://db-engines.com/en/system/Amazon+Neptune%3BElasticsearch%3BMemgraph%3BSurrealDB)
- ArangoDB / TigerGraph: not researched in depth this session (call budget). None of the four memory frameworks reviewed lists them as a backend. ArcadeDB has a community Cognee adapter. — [ArcadeDB blog](https://arcadedb.com/blog/cognee-arcadedb-ai-memory-meets-multi-model/)

### Inferences
- From Vercel serverless functions, a networked graph DB (Aura, FalkorDB Cloud, Neptune) means an extra network hop and connection management. Neo4j's JS driver uses Bolt over a long-lived TCP connection, which suits Fluid compute better than classic Lambda-style functions. Embedded LadybugDB is a poor fit for stateless, multi-instance functions.
- For per-tenant graph isolation, FalkorDB's "graph per tenant" model costs much less than Neo4j (multi-database only on Business Critical at 2 GB min ≈ $290+/mo, or one Aura instance per tenant).
- SSPL (FalkorDB) is fine for using the managed cloud or self-hosting internally. Legal review is needed only if ALRO offered FalkorDB itself as a service.

### Gaps
- Not verified: Neo4j's vector index details on Aura (dimension limits, filtered vector search) and the current JS driver version. My prior knowledge (Neo4j 5.x native HNSW vector indexes; `neo4j-driver` npm) is unverified this session.
- No FalkorDB Cloud prices; no SurrealDB Cloud, ArangoDB (ArangoGraph) or TigerGraph Savanna prices found.
- No independent FalkorDB benchmark found.
- Apache AGE on Supabase/RDS is "no evidence of support" rather than an official "unsupported".

## Q3. Which graph backends do Graphiti, Cognee, Mem0 and LightRAG support (incl. Postgres)?

### Takeaway
Only **LightRAG** (PostgreSQL as an all-in-one KV, vector and graph store) and **Cognee** (a "postgres_demo" graph adapter, described as a demo) can store the graph in Postgres. **Graphiti** (Neo4j, FalkorDB, Kuzu, Neptune) and **Mem0** (Neo4j, Memgraph, Neptune Analytics/DB, Kuzu) need a dedicated graph DB. ALRO staying on Postgres alone therefore implies building its own Graphiti-style temporal graph layer in TypeScript, or using LightRAG's Postgres mode.

### Cited Findings
- **Graphiti:** Neo4j (default, ≥5.26), FalkorDB, Kuzu (embedded) and Amazon Neptune. — [Graphiti drivers overview](https://www.mintlify.com/getzep/graphiti/api/drivers/overview), [graph-drivers guide](https://mintlify.com/getzep/graphiti/guides/graph-drivers). Zep's help centre lists only Neo4j and FalkorDB, which looks outdated. — [Zep help](https://help.getzep.com/graphiti/configuration/graph-db-configuration). The Kuzu driver depends on an archived project.
- **Mem0 (OSS graph memory):** Neo4j, Memgraph, Neptune Analytics, Neptune DB Cluster and Kuzu. No Apache AGE or Postgres graph store. — [Mem0 graph memory docs](https://docs.mem0.ai/open-source/features/graph-memory), [DeepWiki Mem0 graph providers](https://deepwiki.com/mem0ai/mem0/4.2-graph-store-providers)
- **Cognee:** Ladybug (default; alias kuzu), Ladybug-remote, Neo4j (self-hosted / Desktop / Aura), **Postgres (`postgres_demo` "demo adapter" storing graph data in tables)**, Neptune, Neptune Analytics, and Memgraph (community). `ENABLE_BACKEND_ACCESS_CONTROL=true` turns on per-dataset isolation. — [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores). ArcadeDB is also available through a community adapter. — [ArcadeDB blog](https://arcadedb.com/blog/cognee-arcadedb-ai-memory-meets-multi-model/)
- **LightRAG:** graph storage options are NetworkX (default), Neo4j, Memgraph, and PostgreSQL/MongoDB/OpenSearch as all-in-one backends. Vector storage: NanoVectorDB (default), Milvus, Qdrant, PG/Mongo/OpenSearch. KV: JSON (default) or PG/Mongo/OpenSearch. The README does not say which mechanism the PG graph uses (Apache AGE vs tables). — [LightRAG GitHub](https://github.com/HKUDS/LightRAG)

### Inferences
- If LightRAG's PG graph storage relies on Apache AGE (my recollection is that `PGGraphStorage` did, at least historically), it **would not run on Neon**. Verify before relying on it.
- All four frameworks are Python. A Next.js/TS app would run them as a sidecar service (Vercel Python functions or a separate container) or reimplement the patterns in TS.

### Gaps
- Not confirmed: whether LightRAG's `PGGraphStorage` currently requires Apache AGE.
- Mem0 Platform (hosted) graph backend internals were not checked.

## Q4. Row-level security and per-tenant isolation for ACL-filtered retrieval: Postgres vs graph DBs

### Takeaway
Postgres has the strongest built-in isolation: RLS policies enforced by the database using a transaction-local tenant/user setting, combined with pgvector 0.8 iterative scans or per-tenant partitioning to keep recall when filtering. Graph DBs mostly give **database- or graph-level isolation** (Neo4j multi-database on Business Critical, FalkorDB graph per tenant). Per-user ACL filtering inside a tenant must be done in the query (property filters on edges/nodes). Neo4j's fine-grained RBAC is an enterprise feature.

### Cited Findings
- Recommended pattern: RLS with a transaction-local tenant setting. Iterative scans make sense only with a single shared HNSW index that must fill LIMIT. For many tenants, partition by `tenant_id` or use separate tables; for large tenants, use partial HNSW indexes; for small tenants, a B-tree on `tenant_id` with an exact scan. — [Render: multi-tenant RAG with pgvector](https://render.com/articles/multi-tenant-rag-postgresql-pgvector)
- Filtered vector search can silently lose recall unless it is measured with the filter applied. — [Hashnode: filtered vector search loses recall](https://hashnode.com/posts/filtered-vector-search-in-pgvector-can-silently-lose-recall/6a5ea5bf7934007949197ec0), [Hackernoon: isolation is a filtering problem](https://hackernoon.com/multi-tenant-agent-memory-isolation-is-a-filtering-problem-not-a-ranking-problem)
- An RLS pattern for multi-tenant vector search. — [pg_trickle blog on PGXN](https://pgxn.org/dist/pg_trickle/0.36.0/blog/multi-tenant-vector-search-rls.html)
- Neo4j: multiple databases per instance only on Business Critical (and VDC). — [Neo4j pricing](https://neo4j.com/pricing/)
- FalkorDB: multi-tenancy (10K+ graphs) on all plans (vendor claim). — [FalkorDB vs Neo4j](https://www.falkordb.com/falkordb-vs-neo4j/)
- Cognee's per-dataset isolation relies on one graph DB (or container/instance) per dataset. Neptune cannot isolate per dataset. — [Cognee graph stores](https://docs.cognee.ai/setup-configuration/graph-stores)

### Inferences
- The ALRO ACL is per user, not just per tenant: a Slack DM, a private channel and an email thread each have their own audience. Model it as `source_acl` (sets of principal ids) on messages and chunks, and propagate it to derived facts and edges. A derived fact is visible only if the user can see **at least one** supporting source; an alternative is to store the facts per ACL-scope. An RLS policy such as `acl_principals && current_setting('app.principals')::uuid[]`, with a GIN index, enforces this in the database for both vector and graph queries. That is a strong reason to keep the graph in Postgres for Phase 1.
- With a separate graph DB, ACL logic is duplicated in Cypher and there is a leakage risk through traversals: a path can pass through a node the user cannot see. Every hop needs a filter.
- On Neon with the serverless HTTP driver, `SET LOCAL` needs an explicit transaction (or the WebSocket Pool / `pg`) so the RLS setting is in effect for each query.

### Gaps
- No benchmarks of RLS combined with HNSW iterative scans at multi-million-row scale.
- Neo4j fine-grained access control (property/label-level RBAC) availability on Aura tiers was not checked.

## Q5. Cost at SMB scale

### Takeaway
Postgres alone on Neon is the cheapest by far. A tenant with tens of GB of messages and vectors probably costs tens to low hundreds of dollars a month, driven by compute size and RAM for the HNSW index. Adding Neo4j Aura adds about $65/GB/month (Professional, no multi-DB) or about $146/GB/month (Business Critical, needed for multi-database), so a modest 8–16 GB graph is roughly $500–2,300/month. FalkorDB and Memgraph cloud prices are unpublished.

### Cited Findings
- Neon: $0.106 (Launch) or $0.222 (Scale) per CU-hour; $0.35/GB-month storage; $1.50 per extra branch-month. — [Sacra](https://sacra.com/research/neon) (secondary)
- Neo4j Aura Professional at $0.09/GB/h (~$65/GB/mo); Business Critical at $0.20/GB/h (~$146/GB/mo, 2 GB min). — [Neo4j pricing](https://neo4j.com/pricing/)
- Neptune Analytics: per m-NCU-hour (1 GB memory), 10% while paused. — [usage.ai](https://www.usage.ai/blogs/aws/database-savings-plans/neptune-pricing/)
- pgvectorscale claims about 75% lower cost than Pinecone when self-hosted on EC2 (vendor). — [pgvectorscale GitHub](https://github.com/timescale/pgvectorscale)
- Memgraph Enterprise is reported at around $25K/yr (unverified). — [apis.io](https://apis.io/plans/memgraph/memgraph-plans-pricing/)

### Inferences
- Example: an always-on Neon Scale endpoint at 4 CU ≈ 4 × 0.222 × 730 ≈ $650/mo, or ≈ $310 on Launch rates, if those plan limits allow. With autoscaling and scale-to-zero for idle tenants, costs are much lower. A 2 CU (~8 GB RAM) endpoint holds an HNSW index of about 1–2M × 1536-dim vectors; larger corpora need bigger compute, `halfvec`/lower dimensions, or a move to a host with pgvectorscale (Tiger Data) or a dedicated vector DB.
- Dedicated vector DBs (Pinecone, Qdrant, Turbopuffer, etc.) are worth considering only once ALRO is past roughly 10–50M vectors per database or needs cheap object-storage-backed namespaces per tenant. ACL filtering then has to be duplicated as metadata filters.

### Gaps
- No official current prices for Neon (from neon.com), FalkorDB Cloud, Memgraph Cloud, SurrealDB Cloud, ArangoGraph or TigerGraph Savanna.
- The dedicated vector DBs (Pinecone/Qdrant/Turbopuffer) were not researched this session.
