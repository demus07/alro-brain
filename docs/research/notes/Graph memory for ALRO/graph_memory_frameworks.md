# Open-source knowledge-graph / temporal-graph memory and GraphRAG frameworks: profiles and fit for ALRO

Research date: 2026-10-27. GitHub figures (stars, last push, latest release, license) were pulled live from the GitHub REST API (`api.github.com/repos/<owner>/<repo>`) on 2026-10-27, and each repo URL below is the source for them. The GitHub API rate-limited me partway through, so some issue threads were only read through search-result titles.

**Provenance note.** Facts tagged **[repo-meta]** come from the live API pull. Facts tagged **[training knowledge, unverified this session]** come from prior knowledge and were not re-checked against a live page this session; the report writer should treat them as lower confidence.

## Q0. Project profiles (what each project is, how memory is structured, ingestion, updates and time, retrieval, license, activity, SDKs, infrastructure, cost, tenancy, maturity, fit)

### Takeaway
Graphiti (the open-source engine behind Zep) is the only mature, actively maintained framework built around bi-temporal fact validity and automatic invalidation, which is the core requirement for tracking commitments. However, it is Python-only and needs a graph database (Neo4j, FalkorDB or Neptune). Postgres is not supported, and Kuzu is deprecated. LightRAG has the most production-ready Postgres-only backend, but it has no temporal model. Microsoft GraphRAG and its relatives are batch, corpus-level summarisers and are a poor fit for streaming chat or email.

### Cited Findings

#### Live GitHub snapshot (2026-10-27) [repo-meta]

| Project | Stars | Last push | Latest release | License | Language |
|---|---|---|---|---|---|
| [getzep/graphiti](https://github.com/getzep/graphiti) | 32,268 | 2026-10-26 | v0.31.2 (2026-10-20) | Apache-2.0 | Python |
| [getzep/zep](https://github.com/getzep/zep) | 4,974 | 2026-10-20 | zep-ingest-v0.4.0 (2026-10-14) | Apache-2.0 | Python |
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | 36,460 | 2026-10-27 | v3.3.0 (2026-10-08) | MIT | Python |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 40,366 | 2026-10-22 | v1.5.7 (2026-09-02) | MIT | Python |
| [OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) | 4,081 | 2026-10-06 | v1.0.0 (2025-02-27); README references 2.0.0a5 | MIT | Python |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 32,806 | 2026-10-27 | v1.6.6rc1 (2026-10-23) | Apache-2.0 | Python (+ Rust core / TS bindings) |
| [gusye1234/nano-graphrag](https://github.com/gusye1234/nano-graphrag) | 4,006 | 2026-01-27 | v0.0.8 (2024-10-01) | MIT | Python |
| [circlemind-ai/fast-graphrag](https://github.com/circlemind-ai/fast-graphrag) | 3,964 | 2025-11-01 | no GitHub releases | MIT | Python |
| [OpenSPG/KAG](https://github.com/OpenSPG/KAG) | 9,128 | 2026-01-28 | v0.8.0 (2025-06-28) | Apache-2.0 | Python |
| [neo4j-labs/llm-graph-builder](https://github.com/neo4j-labs/llm-graph-builder) | 5,283 | 2026-10-27 | v0.8.7 (2026-07-23) | Apache-2.0 | Python/JS |
| [neo4j/neo4j-graphrag-python](https://github.com/neo4j/neo4j-graphrag-python) | 1,320 | 2026-10-27 | 1.22.0 (2026-10-01) | NOASSERTION in API | Python |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | 52,688 | 2026-10-26 | v0.14.25 (2026-09-21) | MIT | Python |
| [langchain-ai/langchain-experimental](https://github.com/langchain-ai/langchain-experimental) | 104 | 2026-05-22 | libs/experimental/v0.4.2 (2026-05-22) | MIT | Python; **archived = true** |
| [SciPhi-AI/R2R](https://github.com/SciPhi-AI/R2R) | 8,045 | 2025-11-07 | v3.6.5 (2025-06-06) | MIT | Python |
| [neuml/txtai](https://github.com/neuml/txtai) | 13,040 | 2026-10-26 | v9.14.0 (2026-10-06) | Apache-2.0 | Python |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 67,914 | 2026-10-26 | ts-v3.3.1 (2026-09-25) | Apache-2.0 | Python + TS |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 25,265 | 2026-10-18 | 0.16.8 (2026-05-14) | Apache-2.0 | — |
| [FalkorDB/GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK) | 1,027 | 2026-10-26 | v1.5.0 (2026-10-22) | Apache-2.0 | Python |

#### Graphiti (getzep/graphiti) and Zep
- **What it is.** Graphiti is a "temporal context graph" made of entities, facts with validity windows, episodes and communities. — [Graphiti README](https://github.com/getzep/graphiti)
- **Provenance and history.**
  - Episodes are the raw ingested data, the "ground truth stream", and every derived fact traces back to an episode. — [Graphiti README](https://github.com/getzep/graphiti)
  - When facts change they are "invalidated — not deleted", so you can "query what's true now, or what was true at any point in time." — [Graphiti README](https://github.com/getzep/graphiti)
- **Ingestion.** Ingestion is incremental, with no batch recompute. The README advertises "explicit bi-temporal tracking with automatic fact invalidation" and contrasts this with GraphRAG's "basic timestamp tracking" and "LLM-driven summarization judgments". — [Graphiti README](https://github.com/getzep/graphiti)
- **Retrieval.** Hybrid: semantic embeddings, BM25 keyword search and graph traversal. Search results can be reranked by graph distance. — [Graphiti README](https://github.com/getzep/graphiti)
- **Infrastructure.**
  - Supported backends: Neo4j 5.26, FalkorDB 1.1.2, Amazon Neptune (with OpenSearch Serverless for full-text search), and Kuzu 0.11.2.
  - **Kuzu is deprecated** ("upstream Kuzu project is no longer maintained") and emits a DeprecationWarning.
  - There is no Postgres backend.
  - Graphiti works best with LLMs that support Structured Output (OpenAI, Anthropic, Gemini).

  — [Graphiti README](https://github.com/getzep/graphiti)
- **Concurrency and rate limits.** The default `SEMAPHORE_LIMIT=10` is set to avoid HTTP 429 errors from the LLM provider. The README says that if Graphiti feels slow, you should raise it. — [Graphiti README](https://github.com/getzep/graphiti)
- **MCP server security.** The MCP server "do[es] not authenticate callers. Any caller can read, change, or delete data in any `group_id`", and it does not block prompt injection. — [Graphiti README](https://github.com/getzep/graphiti)
- **Multi-tenancy.** `group_id` is Graphiti's namespacing mechanism. Multi-tenant apps are a documented use case, and `group_id` is passed to `add_episode`. — [Zep docs: Graph Namespacing](https://help.getzep.com/graphiti/graphiti/graph-namespacing)
  - This is a logical partition only. There is no per-user ACL inside a namespace. That limit is inferred from the docs and the MCP warning above.
- **Zep Community Edition is not maintained.**
  - The getzep/zep repo now says it is "**not** Zep's product". It holds examples, integrations, a `zep-ingest` bulk ingestion pipeline (Slack, documents, email, JSON/CSV, fact triples) and benchmarks.
  - `legacy/` contains the "Deprecated Zep Community Edition (unsupported)".
  - Zep Cloud SDKs exist for Python (`zep-cloud`), **TypeScript (`@getzep/zep-cloud`)** and Go.
  - Zep ships TypeScript integrations for Mastra and the Vercel AI SDK.

  — [getzep/zep README](https://github.com/getzep/zep)
- **Zep Cloud versus self-hosting.** Zep Cloud runs on "Konig", Zep's own graph database service. Self-hosted Graphiti means bringing your own Neo4j, FalkorDB or Neptune. Zep Cloud also provides a dashboard and SDKs for Python, TypeScript and Go. — [Graphiti README](https://github.com/getzep/graphiti)
- **Zep paper (arXiv 2501.13956; Rasmussen, Paliychuk, Beauvais, Ryan, Chalef; 20 Jan 2025).** — [arXiv](https://arxiv.org/abs/2501.13956), [HTML](https://arxiv.org/html/2501.13956v1)
  - *Memory tiers.* Three subgraph tiers:
    - an episode subgraph holding lossless raw messages or JSON;
    - a semantic entity subgraph of entities and relations;
    - a community subgraph of summarised clusters.
  - *Bi-temporal model.* Timeline T records when facts were true (`t_valid`, `t_invalid`). Timeline T′ is the transactional ingestion order (`t′created`, `t′expired`).
  - *Invalidation.* An LLM compares each new edge against semantically related existing edges. When the two overlap in time and contradict, the old edge's `t_invalid` is set to the new edge's `t_valid`. Under T′, new information is favoured.
  - *Entity resolution.* Context is the current message plus the last 4 messages. Candidates are found by cosine similarity on 1024-dimension name embeddings plus full-text search on names and summaries. An LLM then judges duplicates and rewrites the name and summary.
  - *Graph writes.* Writes use predefined Cypher, not LLM-generated Cypher.
  - *Edge deduplication.* Restricted to edges between the same entity pair.
  - *Retrieval.* Search uses cosine similarity, BM25 (Neo4j Lucene) and breadth-first search. Rerankers are RRF, MMR, episode-mentions, node distance and cross-encoder.
  - *Communities.* Detected with label propagation, not Leiden, and extended incrementally. The authors say periodic full refreshes are still needed because incremental communities drift from a full run.
  - *Results.* DMR 94.8% vs MemGPT 93.4%. On LongMemEval with gpt-4o: 71.2% vs 60.2% full-context, latency 2.58 s vs 28.9 s, and about 1.6k vs 115k context tokens. The claimed "18.5% improvement" is relative; the table gap is 11.0 points.
- **Ingestion cost.**
  - A user reported about $0.80 for 40 short chats (150–250 words each) on default OpenAI models, about **$0.018 per episode**. The largest share went to the entity-properties prompt. — [graphiti#467](https://github.com/getzep/graphiti/issues/467)
  - The maintainer (danielchalef) replied that token usage had since been reduced and that a cheap "small model" classifier was added; Zep uses gpt-4.1-nano for it. — [graphiti#467](https://github.com/getzep/graphiti/issues/467)
- **Ingestion latency.** `add_episode` issues "N₁ + N_entities + N_edges + N_dedup serial LLM calls per episode". On a rate-limited endpoint, one sentence took about 626 s and a 5 KB document was projected at 30–50 minutes. The issue proposes a `skip_extraction` parameter and was still open. — [graphiti#1516](https://github.com/getzep/graphiti/issues/1516)
  - This is an extreme case: concurrency was set to 1 and each call took 8–30 s.
- **Reliability and backend issues.**
  - `add_memory` reportedly returns success while episodes are silently dropped. — [graphiti#1707](https://github.com/getzep/graphiti/issues/1707), title only
  - FalkorDB edge full-text search can cause a full graph scan or time out. — [graphiti#1272](https://github.com/getzep/graphiti/issues/1272), [graphiti#1506](https://github.com/getzep/graphiti/issues/1506), titles only
  - `extract_edges` hard-codes `max_tokens=16384`, which truncates JSON output. — [graphiti#1869](https://github.com/getzep/graphiti/issues/1869), title only
- **TypeScript.** Graphiti core has no official TypeScript port. GitHub search found only a 0-star community port. — [2b3pro/graphiti-ts](https://github.com/2b3pro/graphiti-ts)
- **Postgres and Rust alternatives.**
  - A Rust "successor to the Python graphiti" exists over LadybugDB. — [liminisapp/liminis-context-graph](https://github.com/liminisapp/liminis-context-graph) (6 stars)
  - None found for Postgres.

#### Microsoft GraphRAG
- **What it is.** A modular graph-based RAG system, currently at v3.3.0 (2026-10-08). — [repo](https://github.com/microsoft/graphrag) [repo-meta]
- **Query modes.** — [GraphRAG docs](https://microsoft.github.io/graphrag/)
  - Global search over community summaries, for holistic questions.
  - Local search, which fans out from an entity to its neighbours.
  - DRIFT search, which is local search plus community context.
  - Basic search, which is plain top-k vector search.
- **Indexing methods and cost.** — [Indexing methods](https://microsoft.github.io/graphrag/index/methods/)
  - *Standard* uses an LLM for extraction, summarisation, claims and community reports.
  - *FastGraphRAG* uses NLTK/spaCy noun phrases plus co-occurrence, and only uses an LLM for community reports.
  - Graph extraction is about 75% of indexing cost. The fast method is "much cheaper" but "quite a bit noisier".
- **Incremental update.**
  - GraphRAG 1.0 added an `update` CLI command that "computes the deltas between an existing index and newly added content". Re-indexing relies on the LLM cache. — [MSR GraphRAG 1.0 blog](https://www.microsoft.com/en-us/research/blog/moving-to-graphrag-1-0-streamlining-ergonomics-for-developers-and-users/)
  - Vector stores supported at 1.0 were LanceDB (default) and Azure AI Search. — [MSR GraphRAG 1.0 blog](https://www.microsoft.com/en-us/research/blog/moving-to-graphrag-1-0-streamlining-ergonomics-for-developers-and-users/)
  - The incremental-indexing feature request thread has 35 comments. — [graphrag#741](https://github.com/microsoft/graphrag/issues/741)
  - Document delete support was raised as a feature request in Sep 2025. — [graphrag#2078](https://github.com/microsoft/graphrag/issues/2078), title only
- **Time.** GraphRAG has no temporal or validity model. It is a batch pipeline producing parquet files, and the README frames it as having only "basic timestamp tracking". — [Graphiti README comparison table](https://github.com/getzep/graphiti)
- **LazyGraphRAG.** — [MSR LazyGraphRAG blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
  - Published 25 Nov 2024. Indexing cost is "identical to vector RAG and 0.1% of the costs of full GraphRAG", because it uses NLP noun-phrase extraction and defers LLM work to query time under a "relevance test budget".
  - A June 2025 editor's note says it was integrated into **Microsoft Discovery** (Azure) and Azure Local, in preview.
  - **No confirmed open-source release in the graphrag repo.** A third-party guide reports that the word "lazy" appeared zero times in the GraphRAG docs as of July 2026. — [techsy.io guide](https://techsy.io/es/blog/guia-graphrag) (secondary)
- **Multi-tenancy.** None built in; you get one index per root/config. [training knowledge, unverified this session]

#### LightRAG (HKUDS)
- **What it is.** A dual-layer knowledge graph plus vector store, marketed as a lightweight alternative to GraphRAG (EMNLP 2025). — [LightRAG README](https://github.com/HKUDS/LightRAG)
- **Incremental updates and deletion.** The README advertises "Incremental Updates & Selective Deletion". Document deletion with automatic knowledge-graph regeneration was added in Aug 2025. — [LightRAG README](https://github.com/HKUDS/LightRAG)
- **Storage.**
  - **PostgreSQL is "the recommended backend" for production and can serve all four storage types** (KV, vector, graph and doc-status) on its own, added in Jan 2025.
  - MongoDB and OpenSearch (Mar 2026) are the other single-backend options. Neo4j is also supported.
  - The defaults are in-memory with file persistence, which the README says is "not for production".

  — [LightRAG README](https://github.com/HKUDS/LightRAG)
  - The Postgres graph store uses the Apache AGE extension. [training knowledge, unverified this session]
  - Neon does not offer AGE as far as I know. [unverified this session — needs checking]
- **Query modes.** local, global, hybrid, naive and mix. **mix is the default**, and a reranker is supported (Aug 2025), adding 1–2 s of latency. — [LightRAG README](https://github.com/HKUDS/LightRAG)
- **LLM configuration.** — [LightRAG README](https://github.com/HKUDS/LightRAG)
  - LightRAG uses role-specific LLMs (EXTRACT, QUERY, KEYWORD, VLM). Extraction "runs on every text chunk", and a cheap non-thinking model is recommended for it.
  - Concurrency is tuned with `MAX_ASYNC_LLM`, `MAX_PARALLEL_INSERT` and related settings.
  - Merging a new entity or relation into an existing one can trigger LLM re-summarisation (`FORCE_LLM_SUMMARY_ON_MERGE`).
- **Time.** No temporal or validity model. Entity and relation descriptions are merged and re-summarised, so contradictions are blended into the summary text rather than invalidated. This is inferred from the README design.
- **Ingestion speed complaints.** Users report slow indexing and merge-scale performance problems. — [LightRAG#174](https://github.com/HKUDS/LightRAG/issues/174), [#212](https://github.com/HKUDS/LightRAG/issues/212), [#1957](https://github.com/HKUDS/LightRAG/issues/1957), titles only
- **Multi-tenancy and access control.**
  - An RFC for "Authorized API access" was opened in Jul 2026. — [LightRAG#3516](https://github.com/HKUDS/LightRAG/issues/3516), title only
  - A `workspace` parameter isolates data per instance. [training knowledge, unverified this session]
- **SDKs.** Python only, plus a REST server and web UI. — [LightRAG README](https://github.com/HKUDS/LightRAG)

#### HippoRAG 2 (OSU-NLP)
- **What it is.** "HippoRAG 2: From RAG to Memory". — [README](https://github.com/OSU-NLP-Group/HippoRAG); paper [arXiv 2502.14802](https://arxiv.org/abs/2502.14802)
  - It builds an OpenIE triple graph over passages and retrieves with Personalized PageRank. [training knowledge, unverified this session]
  - It claims gains on multi-hop "associativity" and sense-making benchmarks, with "significantly fewer resources for offline indexing" than GraphRAG, RAPTOR or LightRAG. — [README](https://github.com/OSU-NLP-Group/HippoRAG)
- **Activity.** The README references v2.0.0a5 and an MCP server. — [README](https://github.com/OSU-NLP-Group/HippoRAG)
  - The last GitHub release is v1.0.0 (Feb 2025), with a push on 2026-10-06. [repo-meta]
- **Operations.**
  - Supports `delete` by text or `source_id`. Integration tests cover "incremental updates, and deletion". — [README](https://github.com/OSU-NLP-Group/HippoRAG)
  - The HTTP MCP server has no authentication. — [README](https://github.com/OSU-NLP-Group/HippoRAG)
- **Fit.** It is a research library: no temporal model, no multi-tenancy, Python only, with file-based storage. The storage point is training knowledge, unverified this session.

#### Cognee (topoteretes/cognee)
- **What it is.** An "open-source AI memory platform for agents". Its operations are add/cognify/search plus `remember`/`recall`/`improve`/`forget`/memify. You can define custom data models and ontologies. — [README](https://github.com/topoteretes/cognee)
- **Multi-tenancy.** The API **defaults to multi-tenant mode, where every `/api/v1` call requires an authenticated user**. `ENABLE_BACKEND_ACCESS_CONTROL=false` switches to single-user mode. A permissions guide exists. — [README](https://github.com/topoteretes/cognee)
  - This is the most explicit built-in ACL of any project here, with dataset-level permissions.
- **Postgres.** You can "Run the Whole Memory Layer on Postgres" (relational, pgvector and graph). However, **"Using Postgres as a graph store is currently released as a demo feature. The production-ready version is available as a licensed product."** — [README](https://github.com/topoteretes/cognee)
- **TypeScript SDK.** `@cognee/cognee-ts` is described as "Node.js bindings for the cognee-rs AI-memory SDK" (a Rust core). It supports remember/recall/improve/forget, datasets, sessions and user administration. — [Cognee TS docs](https://docs.cognee.ai/typescript/getting-started)
  - Native Node bindings may not run on Vercel serverless; that is an inference.
- **Releases.** v1.6.0 (18 Sep 2026) added keyless workflows with local models, and GLiNER extraction is built into Docker. — [README](https://github.com/topoteretes/cognee)
  - GLiNER means entities can be extracted without an LLM, which lowers cost.
- **Performance.** Community "hackathon" issues target ingestion speed and LLM-call optimisation in cognify. — [cognee#3516](https://github.com/topoteretes/cognee/issues/3516), [#3626](https://github.com/topoteretes/cognee/issues/3626), titles only
- **Time.** I found no explicit bi-temporal edge validity in the README. A "temporal" mode or temporal cognify exists but I did not verify it this session; that is a gap.

#### nano-graphrag and fast-graphrag
- **nano-graphrag.** A small, hackable GraphRAG reimplementation. — [repo](https://github.com/gusye1234/nano-graphrag)
  - Last push 2026-01-27; last release v0.0.8 (Oct 2024). Effectively low activity. [repo-meta]
- **fast-graphrag (Circlemind).** — [README](https://github.com/circlemind-ai/fast-graphrag)
  - Uses Personalized PageRank exploration and "incremental updates".
  - Claims $0.08 vs $0.48 for GraphRAG on *The Wizard of Oz*, a 6x saving.
  - Steers users toward a managed service (100 free requests a month).
  - Last push 2025-11-01 and no releases, so it looks **stale**. [repo-meta]
  - No temporal model and no multi-tenancy.

#### KAG (OpenSPG / Ant Group)
- **What it is.** Knowledge-augmented generation built on the OpenSPG semantic knowledge-graph engine. It targets professional-domain logical reasoning: schema-constrained knowledge plus a hybrid reasoning solver. [training knowledge, unverified this session] — [repo](https://github.com/OpenSPG/KAG)
- **Activity.** Last release v0.8.0 (Jun 2025), last push Jan 2026. Activity is slowing. [repo-meta]
- **Infrastructure.** Needs the OpenSPG server (a Java stack with Neo4j/TuGraph-style storage) and Docker. Heavy, and a poor fit for ALRO. [training knowledge, unverified this session]

#### Neo4j LLM Graph Builder and neo4j-graphrag-python
- **LLM Graph Builder.** A Neo4j Labs app (React frontend and FastAPI) that extracts graphs from documents into Neo4j. Actively maintained; v0.8.7 (Jul 2026). [repo-meta] — [repo](https://github.com/neo4j-labs/llm-graph-builder)
  - It is a demo or tool rather than a memory engine. [training knowledge, unverified this session]
- **neo4j-graphrag-python.** The official Neo4j package (1.22.0, Oct 2026). [repo-meta] — [repo](https://github.com/neo4j/neo4j-graphrag-python)
  - It provides a SimpleKGPipeline (extraction, entity resolution, writer) and retrievers: Vector, VectorCypher, Hybrid, Text2Cypher. [training knowledge, unverified this session]
  - Neo4j only. No temporal model. Tenancy is up to you (separate databases or properties).

#### LlamaIndex PropertyGraphIndex
- **What it is.** Part of llama_index (52.7k stars, v0.14.25, Sep 2026). [repo-meta] — [repo](https://github.com/run-llama/llama_index)
  - Uses pluggable extractors (SimpleLLMPathExtractor, SchemaLLMPathExtractor, DynamicLLMPathExtractor) and retrievers (vector, synonym, Text2Cypher). [training knowledge, unverified this session]
  - Graph stores include Neo4j, Memgraph, Nebula, FalkorDB and Kuzu. [training knowledge, unverified this session]
  - `insert()` adds nodes incrementally, but there is no entity resolution beyond what you write yourself, and no temporal invalidation. [training knowledge, unverified this session]
- **TypeScript.** LlamaIndex.TS exists, but PropertyGraphIndex parity in TS is unverified (gap).

#### LangChain LLMGraphTransformer
- **What it is.** It lives in `langchain_experimental.graph_transformers`, and turns documents into GraphDocuments (nodes and relationships) for Neo4j and similar stores. It is a one-shot extractor with no memory, dedup or time handling. [training knowledge, unverified this session]
- **Status.** **The `langchain-ai/langchain-experimental` repo is archived** (archived = true; last release v0.4.2, 2026-05-22). [repo-meta] — [repo](https://github.com/langchain-ai/langchain-experimental)
  - A JS equivalent existed in `@langchain/community/experimental/graph_transformers`. [training knowledge, unverified this session]

#### R2R (SciPhi)
- **What it is.** A RAG server with Postgres and pgvector at its core. It also does knowledge-graph extraction, entity/relationship storage in Postgres, and community building. It supports users and collections (document-level access control), has a REST API, and ships Python and **JS SDKs**. [training knowledge, unverified this session] — [repo](https://github.com/SciPhi-AI/R2R)
  - It was architecturally the closest to "Postgres-only GraphRAG with ACLs".
- **Activity.** **Last push 2025-11-07 and last release v3.6.5 (Jun 2025): appears unmaintained or stalled.** [repo-meta]
  - The README fetch returned a 15-byte file, so README content was not verified this session.

#### txtai graph
- **What it is.** txtai (13k stars, v9.14.0, Oct 2026, active) is an all-in-one embeddings database. [repo-meta] — [repo](https://github.com/neuml/txtai)
  - It includes a semantic graph (NetworkX, or Postgres through its graph SQL backend) that builds automatic similarity edges and supports topic modelling, graph path traversal and "graph RAG" queries. It can store embeddings, content and graph in Postgres plus pgvector. [training knowledge, unverified this session]
  - Edges are similarity-based, not LLM-extracted facts, and there is no temporal model.
- **SDKs.** Python, plus API clients in JS, Java, Rust and Go. [training knowledge, unverified this session]

#### Other notable repos found via GitHub topic search (2026)

**Agent-memory platforms**

| Repo | Stars, last push | Notes |
|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 67.9k, active | Native TS SDK (release ts-v3.3.1, Sep 2026). [repo-meta] Memory is facts plus an optional graph store (Neo4j and others). `user_id`/`agent_id`/`run_id` scoping. LLM-driven ADD/UPDATE/DELETE fact reconciliation. Supports pgvector. [training knowledge, unverified this session] Simpler than Graphiti, with weaker temporal history. |
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | 40.9k, active | "Self-evolving Context Database for AI Agents". [repo-meta] Not investigated further. |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | 31.4k, **TypeScript**, active | Memory and context engine. [repo-meta] Worth a separate look for TS-native fit. |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 25.3k | MemGPT lineage. Agent-centric, not a knowledge graph. [repo-meta] |
| [MemoriLabs/Memori](https://github.com/MemoriLabs/Memori) | 17.1k | [repo-meta] Not investigated further. |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | 14.6k | [repo-meta] Not investigated further. |
| [semantica-agi/semantica](https://github.com/semantica-agi/semantica) | 14.3k | "Graph-Native Infrastructure for Context and Accountable AI". [repo-meta] |

**GraphRAG and graph tooling**

| Repo | Stars, last push | Notes |
|---|---|---|
| [pipeshub-ai/pipeshub-ai](https://github.com/pipeshub-ai/pipeshub-ai) | 3.9k, active | "Turns your company's knowledge (Slack…)" into an agent context layer. A direct ALRO competitor or reference. [repo-meta] |
| [pingcap/autoflow](https://github.com/pingcap/autoflow) | 3.0k, TS | Graph RAG on TiDB. [repo-meta] |
| [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | 136.7k | Codebase/doc knowledge graph. Not aimed at communications. [repo-meta] |
| [FalkorDB/GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK) | 1.0k | v1.5.0, Oct 2026. [repo-meta] |
| [memgraph/memgraph](https://github.com/memgraph/memgraph) | 4.6k | Graph database positioned for "AI memory". [repo-meta] |

**Temporal knowledge graphs**

| Repo | Stars, last push | Notes |
|---|---|---|
| [AuvaLab/itext2kg](https://github.com/AuvaLab/itext2kg) | 972 | Incremental KG construction. [repo-meta] |
| [Tencent/RoMem](https://github.com/Tencent/RoMem) | 10 | Temporal-KG agent memory (EMNLP 2026 paper repo). [repo-meta] |
| [deeplethe/utopia](https://github.com/deeplethe/utopia) | 8.6k, Rust | "Enterprise world model" tagged temporal-knowledge-graph. Not investigated. [repo-meta] |

### Inferences
- **Graphiti is the best fit for ALRO's semantics.** For "promised X by Friday → delivered", only Graphiti/Zep has first-class semantics: edge `valid_at`/`invalid_at`, transaction-time history, LLM contradiction detection, and episode provenance back to the source Slack message or email.
- **The adoption options for Graphiti are:**
  - (a) Run Graphiti as a Python microservice with FalkorDB or Neo4j Aura beside Neon. This means two data stores and duplicating ACLs into `group_id`.
  - (b) Use Zep Cloud, which has an official TS SDK. Your data then sits with a vendor.
  - (c) Re-implement Graphiti's schema and algorithms (bi-temporal edges, the dedup pipeline, hybrid search) in TypeScript on Postgres plus pgvector. Apache-2.0 allows this.
- **A Postgres/TS team can borrow from several projects.** LightRAG and Cognee are the most Postgres-friendly, but LightRAG's graph-on-Postgres relies on Apache AGE (an extension Neon may lack — unverified), and Cognee's Postgres graph store is a "demo" with production gated behind a licence. Cognee's built-in multi-tenant auth and dataset permissions are the strongest ACL story among the open-source options.
- **Batch summarisers are a poor fit.** GraphRAG, LazyGraphRAG, nano-graphrag, fast-graphrag, HippoRAG 2 and KAG are optimised for static or slowly changing document corpora and global sense-making. None models fact validity over time. GraphRAG's community reports must be recomputed as data changes, which suits periodic "theme" digests at most.

### Gaps
- The README-claimed defaults for Graphiti's per-episode LLM call count after the token-reduction work were not measured. The only hard number is the user-reported ~$0.018 per episode in mid-2025.
- I could not verify Cognee's temporal capabilities, R2R's current README or maintenance statement, the LightRAG workspace and AGE details, Neon's support for Apache AGE, or KAG and neo4j-graphrag internals this session. Those are marked as training knowledge.
- Production users or customers per project were not verified. Zep publicly lists enterprise customers, but I did not fetch them.
- GitHub API rate limiting stopped me reading the full comment threads on LightRAG#1957, graphrag#741 and graphiti#186.

## Q1. Which handle continuously changing facts over time best (e.g. "promised X by Friday → delivered")?

### Takeaway
Graphiti/Zep is the clear leader. It has bi-temporal edges (valid time plus transaction time), LLM-detected contradictions that invalidate rather than delete old facts, and provenance back to episodes. Mem0 does fact-level UPDATE/DELETE reconciliation but keeps weaker history. LightRAG, GraphRAG, HippoRAG, Cognee and LlamaIndex only merge or append, with no validity windows.

### Cited Findings
- **Graphiti's temporal model.** Graphiti has "explicit bi-temporal tracking with automatic fact invalidation" and "automatic fact invalidation with temporal history preserved". It contrasts this with GraphRAG's "basic timestamp tracking" and "LLM-driven summarization judgments". — [Graphiti README](https://github.com/getzep/graphiti)
- **The Zep paper's mechanism.** Each edge carries `t_valid`/`t_invalid` and `t′created`/`t′expired`. When a contradiction overlaps in time, the old edge's `t_invalid` is set to the new edge's `t_valid`. — [Zep paper HTML](https://arxiv.org/html/2501.13956v1)
- **Point-in-time queries.** "Query what's true now, or what was true at any point in time." — [Graphiti README](https://github.com/getzep/graphiti)
- **LightRAG.** Entity and relation merges trigger LLM re-summarisation (`FORCE_LLM_SUMMARY_ON_MERGE`). There are no validity fields. — [LightRAG README](https://github.com/HKUDS/LightRAG)
- **GraphRAG.** Incremental updates compute deltas over a static index, and there is no temporal concept. — [MSR GraphRAG 1.0 blog](https://www.microsoft.com/en-us/research/blog/moving-to-graphrag-1-0-streamlining-ergonomics-for-developers-and-users/)

### Inferences
- **Commitment tracking needs more than generic edges.** ALRO's commitment tracker likely needs a typed schema beyond generic graph edges: a Commitment entity with owner, recipient, due date and status, plus status-transition events. Graphiti's custom entity and edge types (Pydantic) can model this. The same model is also straightforward in plain Postgres tables, using the Zep paper's bi-temporal columns as the pattern.
- **Contradiction detection is the hard part.** An LLM must recognise that "shipped the deck" in a later email fulfils "I'll send the deck Friday". That is where Graphiti's edge-invalidation prompt (or a custom equivalent) earns its cost.

### Gaps
- I found no public benchmark that specifically measures commitment or promise tracking or temporal-update accuracy across these frameworks. LongMemEval's temporal-reasoning subset is the closest proxy, and Zep reports aggregate results only in the material read.

## Q2. Which are cheap enough to run on every Slack/email message at SMB scale? Known cost and latency complaints?

### Takeaway
Graphiti performs several serial LLM calls per message: extraction, dedup, edge extraction, invalidation and summaries. That cost about $0.018 per short chat on default OpenAI models in 2025; it has since been cut with a small-model classifier, but no figure is published. Latency can reach minutes on rate-limited endpoints. Running it on every raw message is feasible at SMB scale only with a cheap model, and is best combined with batching or pre-filtering. LazyGraphRAG and FastGraphRAG-style NLP extraction, and Cognee's GLiNER mode, are the cheap-ingest options, but they give up temporal semantics.

### Cited Findings
- **Graphiti cost.**
  - About $0.80 for 40 chats, roughly $0.018 per episode. The entity-properties prompt was the largest cost. — [graphiti#467](https://github.com/getzep/graphiti/issues/467)
  - The maintainer said token use was reduced and a "small model" classifier added; Zep uses gpt-4.1-nano. — [graphiti#467](https://github.com/getzep/graphiti/issues/467)
- **Graphiti latency.** `add_episode` makes "N₁ + N_entities + N_edges + N_dedup serial LLM calls per episode". One sentence took about 626 s with concurrency 1 on a slow endpoint. — [graphiti#1516](https://github.com/getzep/graphiti/issues/1516)
  - The original "messages are added very slowly" complaint dates from 2024. — [graphiti#186](https://github.com/getzep/graphiti/issues/186), title only
  - The default `SEMAPHORE_LIMIT=10` guards against 429 errors. — [Graphiti README](https://github.com/getzep/graphiti)
- **GraphRAG.** Graph extraction is about 75% of indexing cost. The fast NLP method is much cheaper but noisier. — [GraphRAG indexing methods](https://microsoft.github.io/graphrag/index/methods/)
- **LazyGraphRAG.** Indexing costs 0.1% of GraphRAG's, but it is not in the open-source repo; it lives in Microsoft Discovery and Azure Local. — [MSR LazyGraphRAG blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/)
- **fast-graphrag.** Claims a 6x cost saving vs GraphRAG ($0.08 vs $0.48 for a novel). — [fast-graphrag README](https://github.com/circlemind-ai/fast-graphrag)
- **LightRAG.** Extraction "runs on every text chunk"; use a cheap non-thinking model. — [LightRAG README](https://github.com/HKUDS/LightRAG)
  - Slow-indexing complaints exist. — [LightRAG#174](https://github.com/HKUDS/LightRAG/issues/174), [#212](https://github.com/HKUDS/LightRAG/issues/212), titles only
- **Cognee.** v1.6.0 adds keyless local-model and GLiNER extraction. — [Cognee README](https://github.com/topoteretes/cognee)
  - Open performance work targets LLM-call usage in cognify. — [cognee#3516](https://github.com/topoteretes/cognee/issues/3516), title only
- **HippoRAG 2.** Claims lower offline indexing resources than GraphRAG, RAPTOR or LightRAG. — [HippoRAG README](https://github.com/OSU-NLP-Group/HippoRAG)

### Inferences
- **Rough Graphiti estimate.** At about $0.005–0.02 per episode, an SMB with 5,000 messages a day would spend roughly $25–100 a day if every message is ingested with gpt-4o-class defaults, and much less with nano or mini-class models. This extrapolates from #467 and is not a measured figure.
- **Practical pattern.** Batch Slack threads or email threads into one episode, pre-classify messages with a cheap model, and only run full graph extraction on "salient" content such as commitments, decisions and changes. Keep everything else in pgvector chunks.

### Gaps
- No current (2026) published per-episode token benchmark for Graphiti or Zep. No comparable per-message cost data for Cognee or Mem0 graph mode.

## Q3. Which can run on Postgres or have TypeScript support?

### Takeaway
- **Postgres:** LightRAG (recommended production backend; graph likely via Apache AGE), Cognee (Postgres graph is a "demo" in open source, licensed for production), R2R (Postgres-native but stalled), txtai (Postgres backend for content and vectors) and Mem0 (pgvector).
- **Not Postgres:** Graphiti (Neo4j, FalkorDB or Neptune), GraphRAG (parquet plus LanceDB or Azure AI Search), neo4j-graphrag and KAG.
- **TypeScript:** official SDKs exist for Zep Cloud, Mem0, Cognee (Rust-core Node bindings) and R2R (JS client). Supermemory and pingcap/autoflow are TS-native. Graphiti core has no official TS port.

### Cited Findings
- **LightRAG.** "PostgreSQL is the recommended backend — it can serve all four storage types on its own." — [LightRAG README](https://github.com/HKUDS/LightRAG)
- **Cognee.** "Using Postgres as a graph store is currently released as a demo feature. The production-ready version is available as a licensed product." — [Cognee README](https://github.com/topoteretes/cognee)
  - Its TS SDK is Node bindings over cognee-rs. — [Cognee TS docs](https://docs.cognee.ai/typescript/getting-started)
- **Graphiti.** Backends are Neo4j, FalkorDB, Neptune and Kuzu (deprecated); there is no Postgres. — [Graphiti README](https://github.com/getzep/graphiti)
  - Zep Cloud has an official TS SDK `@getzep/zep-cloud`, plus a Vercel AI SDK integration. — [getzep/zep README](https://github.com/getzep/zep)
- **Mem0.** Publishes TS releases (ts-v3.3.1). — [mem0 repo](https://github.com/mem0ai/mem0) [repo-meta]
- **TS-native projects.** Supermemory is a TypeScript repo. — [supermemory](https://github.com/supermemoryai/supermemory) [repo-meta]
  - autoflow is TypeScript on TiDB. — [pingcap/autoflow](https://github.com/pingcap/autoflow) [repo-meta]
- **Graphiti TS ports.** Only a community port with 0 stars. — [2b3pro/graphiti-ts](https://github.com/2b3pro/graphiti-ts)

### Inferences
- **ALRO's stack is Next.js/TS on Vercel with Neon.** No open-source temporal graph-memory engine runs natively there today. The realistic options are:
  1. **Zep Cloud via its TS SDK.** Fastest. A vendor handles data residency, and ACLs are mapped to users and graphs.
  2. **A Graphiti Python sidecar** (Fly, Render or ECS) with FalkorDB or Neo4j Aura. This adds infrastructure, and per-user ACL must be enforced in ALRO's own layer because `group_id` is a namespace, not an authorisation system.
  3. **A home-grown "Graphiti-on-Postgres" in TS.** Entities and edges become tables with `valid_at`, `invalid_at`, `created_at` and `expired_at`. Embeddings go in pgvector and BM25 in Postgres full-text search. Traversal uses recursive CTEs. ACLs are enforced with row-level security from source-message permissions.

  Option 3 fits ALRO's per-user ACL needs best, since permissions derive from source Slack channels and mailboxes. It borrows Graphiti's published algorithms from the Zep paper. Commitment volumes are small enough that recursive CTEs suffice.

### Gaps
- I did not verify whether Neon supports the Apache AGE extension, which LightRAG's Postgres graph store requires.
- I did not verify whether Cognee's native Node bindings run in Vercel Functions.
- I did not verify whether LlamaIndex.TS supports PropertyGraphIndex.
