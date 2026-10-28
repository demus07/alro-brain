# Open-source company brains, commitment extraction, and memory benchmarks (graph memory vs RAG) — for ALRO

Researched 2026-10-27. GitHub stats pulled live from the public GitHub REST API (`api.github.com/repos/...`) on 2026-10-27; a rate limit stopped the pull for Quivr, Casibase (both returned "Moved Permanently"), Mem0, Letta, microsoft/graphrag, LightRAG and Cognee, so their stats are missing. Vendor-authored claims are labelled **[vendor]**.

## (a) Which open-source company-brain / enterprise-search projects matter, and can ALRO reuse their connectors or design?

### Takeaway
Onyx is the only mature OSS project whose core is connectors plus permission-aware hybrid search, and it is the best reference for ALRO's ingestion and ACL design. However, permission sync is in its Enterprise Edition license, and the project is written in Python. supermemory's Apache-2.0 `company-brain` is the closest in spirit (a Slack teammate with permission-scoped memory, written in TypeScript), but it depends on the hosted supermemory API for memory. None of the projects reviewed do commitment tracking as a first-class feature. That remains ALRO's differentiator.

### Cited Findings

**Live GitHub stats (2026-10-27):**

| Repo | Stars | License (API) | Language | Last push | Notes |
|---|---|---|---|---|---|
| onyx-dot-app/onyx | 33,024 | NOASSERTION (MIT core + EE) | Python | 2026-10-27 | "Open Source AI Platform" |
| supermemoryai/company-brain | 1,062 | Apache-2.0 | TypeScript | 2026-10-02 | Slack teammate |
| supermemoryai/supermemory | 31,429 | MIT | TypeScript | 2026-10-27 | Memory/context engine + API |
| khoj-ai/khoj | 37,847 | AGPL-3.0 | Python | 2026-08-02 | Personal "AI second brain" |
| Mintplex-Labs/anything-llm | 67,630 | MIT | JavaScript | 2026-10-26 | Local-first agent/RAG app |
| zylon-ai/private-gpt | 57,612 | Apache-2.0 | Python | 2026-10-27 | Now "API layer for private AI apps" |
| MODSetter/SurfSense | 16,621 | Apache-2.0 | Python | 2026-10-27 | "NotebookLM alternative" |
| open-webui/open-webui | 156,935 | NOASSERTION (custom) | Python | 2026-10-27 | Chat UI with knowledge |
| airweave-ai/airweave | 6,552 | MIT | Python | 2026-06-05 | **archived = true** |
| morphik-org/morphik-core | 3,719 | NOASSERTION | Python | 2026-10-26 | Multimodal retrieval engine |
| infiniflow/ragflow | 92,960 | Apache-2.0 | Go (primary) | 2026-10-27 | RAG engine + agents |
| Cinnamon/kotaemon | 25,831 | Apache-2.0 | Python | 2026-07-14 | Doc-chat RAG UI |
| langgenius/dify | 159,699 | NOASSERTION (modified Apache) | Python | 2026-10-27 | Agent workflows + RAG |
| aryn-ai/sycamore | 605 | Apache-2.0 | Python | 2026-08-01 | LLM-powered ETL/analytics |
| getzep/graphiti | 32,268 | Apache-2.0 | Python | 2026-10-26 | Temporal knowledge graph |

Source: GitHub repo pages, e.g. [onyx](https://github.com/onyx-dot-app/onyx), [company-brain](https://github.com/supermemoryai/company-brain), [airweave](https://github.com/airweave-ai/airweave), [graphiti](https://github.com/getzep/graphiti), [ragflow](https://github.com/infiniflow/ragflow).

**Onyx (formerly Danswer)**
- The Community Edition is MIT-licensed. The `ee/` directories fall under a separate Onyx Enterprise License — [wz-it overview](https://wz-it.com/en/blog/onyx-self-hosted-installation/); [Onyx EE docs](https://docs.onyx.app/admins/getting_started/enterprise_edition)
- Permission-syncing connectors are an Enterprise Edition feature. A connector set to auto-sync keeps an ACL copied from the source, matched to Onyx users by email. Listed connectors include Confluence, Jira, Google Drive, Gmail, Slack, Salesforce, GitHub and SharePoint. Google sources need service-account or Workspace admin OAuth, and SharePoint needs certificate auth — [Onyx permissioning docs](https://docs.onyx.app/enterprise_edition/permissioning); [Onyx connectors](https://docs.onyx.app/admins/connectors)
- Index backend: one third-party overview (Sept 2026) says the document index is now OpenSearch, with Vespa in earlier versions, and describes a hybrid vector + keyword index storing content and permissions — [wz-it](https://wz-it.com/en/blog/onyx-self-hosted-installation/). This is unverified against the repo.
- Open WebUI's docs treat Onyx as the alternative for teams that need enterprise connectors — [Open WebUI docs: Onyx](https://docs.openwebui.com/alternatives/onyx.md)

**supermemoryai/company-brain**
- A Slack bot that listens to team conversations, answers questions, acts in tools (GitHub, Linear, Notion, Google Workspace, and more via MCP), speaks up unprompted, sends scheduled digests and learns "skills" — [repo](https://github.com/supermemoryai/company-brain)
- Memory goes through the supermemory API (`SUPERMEMORY_API_KEY`). The README mentions a live graph view but does not describe the data model — [repo](https://github.com/supermemoryai/company-brain)
- Stack: TypeScript on Cloudflare Workers, Durable Objects, D1, KV and Workers AI, plus Bun and Drizzle. Models from Anthropic, OpenAI, Google or xAI — [repo](https://github.com/supermemoryai/company-brain)
- **Permission model worth copying:** public channels use shared memory, private channels add that channel's memory, and DMs add personal memory plus the private channels the user is in. Tool writes use the requester's own connection, and borrowing a teammate's connection needs their approval — [repo](https://github.com/supermemoryai/company-brain)
- The hosted Company Brain product was discontinued and the code open-sourced under Apache 2.0 — [supermemory changelog](https://supermemory.ai/changelog/company-brain-is-open-source/)
- It has no explicit commitment or follow-up tracker. It remembers "decisions, projects, owners and context" — [repo](https://github.com/supermemoryai/company-brain)

**Other "company brain" repos (2025-2026)**
- agno-agi/scout: an "open source company brain" that pulls from the web, Slack, Drive, wikis, CRMs and MCP, and builds its own wiki and CRM over time — [GitHub](https://github.com/agno-agi/scout)
- getnao/sylph: company context organized by domain, plus skills, agents and a self-improving loop (~215 stars) — [GitHub](https://github.com/getnao/sylph)
- OpenViking (Volcengine): AGPL-3.0, with team permissions as a paid add-on — [awesome-company-brain](https://github.com/gurusup/awesome-company-brain/blob/main/solutions/openviking.md)
- The GitHub `company-brain` topic lists 66 repos, including inkeep's Open Knowledge and desplega-ai's agent-swarm — [GitHub topic](https://github.com/topics/company-brain)
- Slite surveys 10 company-brain architectures (a vendor source) — [Slite](https://slite.com/learn/company-brain-solutions)

**Airweave**
- The repo was archived (read-only) as of the API check, with its last push on 2026-06-05 — [GitHub](https://github.com/airweave-ai/airweave). Do not build a dependency on it.

### Inferences
- **What ALRO can reuse from Onyx:** connector logic (Slack, Gmail, Salesforce, Teams/SharePoint) and its ACL model (per-document ACL tied to user email, checked at query time) are good reference designs. Copying EE permission-sync code is not allowed under its license. Because Onyx is Python, ALRO would have to port the code rather than import it.
- **What ALRO can reuse from supermemory company-brain:** its channel/DM-scoped memory rule maps cleanly to Postgres row-level filters (scope = public | channel_id | user_id). It is also TypeScript, so it is the easiest codebase to borrow patterns from.
- RAGFlow, Dify, AnythingLLM, Kotaemon, PrivateGPT and Open WebUI are document-RAG platforms. They are not built around connectors and permission sync over chat or email streams, so their ingestion fits ALRO poorly. RAGFlow and Kotaemon do ship GraphRAG/LightRAG-style graph options (general knowledge, not verified this session).
- None of these projects treat commitments or promises as a data type, which supports keeping ALRO's commitment tracker as the core product.

### Gaps
- Per-project connector lists, storage design and ACL support for Khoj, AnythingLLM, PrivateGPT, Quivr, SurfSense, Open WebUI knowledge, Morphik, RAGFlow, Kotaemon, Casibase, Dify and Sycamore were not verified, because of the research tool-call budget. Only stars, license, language and activity above are verified.
- Quivr and Casibase repos returned "Moved Permanently" (renamed or moved), so their stats were not collected.
- Morphik's exact license is unknown: the API returned NOASSERTION, meaning a custom license. Check its LICENSE file.
- No WhatsApp or Zoho connectors were confirmed in any OSS project.

## (b) Commitment / action-item detection: what research and products exist, and what precision is achievable?

### Takeaway
Microsoft has the deepest public body of work: commitment classifiers for email, the Smart To-Do paper, and a shipped Outlook/Viva "commitments" feature. Microsoft cut that feature back in Feb 2024: email and chat commitments were dropped from Viva task suggestions, and Briefing emails are now paused. That suggests precision and usefulness at scale were hard to get. The known failure mode is domain shift: classifiers trained on one corpus degrade on another. Meeting action-item datasets are small (AMI: 381 action items in 101 meetings).

### Cited Findings
- **Azarbonyad, Sim & White (Microsoft Research, WSDM 2019), "Domain Adaptation for Commitment Detection in Email":** commitments are extracted reliably when train and test come from the same corpus, but performance falls when the domain changes. Domain adaptation improves precision and recall — [MSR PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/AzarbonyadWSDM2019.pdf); [MSR page](https://www.microsoft.com/en-us/research/publication/domain-adaptation-for-commitment-detection-in-email/)
- **Smart To-Do (ACL 2020, Microsoft):** a commitment classifier finds the action-intent sentence in an email, then a generation model writes the To-Do item — [ACL Anthology](https://aclanthology.org/2020.acl-main.767.pdf); [arXiv 2005.06282](https://arxiv.org/pdf/2005.06282)
- **SmartMail (MSR, early 2000s):** task-focused email summaries built from detected action items — [ACL W04-1008](https://aclanthology.org/W04-1008.pdf)
- **MAILEX (EMNLP 2023):** email event and argument extraction, a dataset for structured events in email — [ACL Anthology](https://aclanthology.org/anthology-files/pdf/emnlp/2023.emnlp-main.801.pdf)
- **Microsoft Viva Briefing (product):** the email flagged "outstanding commitments, requests, and follow-ups to and from other collaborators". A Commitment is "something you promised or committed to do for someone else in an email". Categories were Commitment, Request, Follow-up and To Do. Teams chats were added in 2022 — [Microsoft Learn Briefing overview](https://learn.microsoft.com/en-us/Briefing/be-overview); [Microsoft Learn Briefing tasks](https://learn.microsoft.com/en-ca/viva/insights/personal/briefing/be-tasks); [handsontek](https://m365admin.handsontek.net/?p=5933)
- **Feature retirement:** Message Center MC713042 (Feb 2024) said Viva Insights suggestions "would no longer include commitments and requests based on email and chat messages". Briefing emails are currently paused — [MC713042](https://mc.merill.net/message/MC713042/v/2024-02-06T00-10-10-407Z); [Microsoft Learn](https://learn.microsoft.com/briefing/be-overview)
- **Meeting datasets:** English AMI has 101 meetings annotated with 381 action items. ICSI has 75 meetings without public action-item annotations. The 2023 paper on regularized context modeling (Context-Drop) also releases a Chinese meeting corpus — [arXiv 2303.16763](https://arxiv.org/pdf/2303.16763)
- Murray & Renals (2008) detected action items on AMI using prosodic, lexical and structural features — [Edinburgh PDF](https://www.cstr.ed.ac.uk/downloads/publications/2008/murray2008b.pdf). AIMU (LREC 2016) annotated actionable items on 22 ICSI meetings — [NTU PDF](https://www.csie.ntu.edu.tw/~yvchen/doc/LREC16_AIMU.pdf)
- OSynth (arXiv 2610.29319, 2026) evaluates meeting understanding over time with LLM-based action-item extraction. It scores assignee accuracy and LLM-judged completeness, not F1 — [arXiv](https://arxiv.org/html/2610.29319v1)

### Inferences
- **Common pitfalls (inferred from the cited work):**
  1. Domain shift between email, Slack and meetings (Azarbonyad 2019).
  2. Action-item sentences are sparse, so classes are heavily imbalanced (381 items in 101 meetings).
  3. Resolving the owner, deadline and counterparty is harder than spotting the sentence (OSynth scores assignee accuracy separately).
  4. Precision matters more than recall for user trust; Microsoft's 2024 retreat is consistent with that.
- **Design implications for ALRO:**
  - Extract commitments as structured records (owner, counterparty, what, due date, source message, status) with an LLM over a per-thread window, not per sentence.
  - Detect fulfilment separately: look for later messages or CRM events that close each commitment.
  - Show confidence, and let users confirm or dismiss. That gives you labeled data for a per-tenant eval set.
  - This is a structured-extraction problem, so a `commitments` table in Postgres is the natural store. It does not need a graph.

### Gaps
- No published precision/recall numbers for modern LLM-based commitment extraction on email, Slack or meetings were found. The WSDM 2019 numbers exist in the PDF but were not extracted this session.
- Products such as Superhuman or Gmail "nudges", Fireflies, Otter, Read.ai and Granola action items were not researched (budget).
- No commitment-tracking OSS tool beyond small repos (e.g. [aifenaike/Action-Items-Detection-In-Email](https://github.com/aifenaike/Action-Items-Detection-In-Email)) was found.
- Cortana's email commitments (the predecessor to Viva Briefing) were not documented in the sources found.

## (c) Do benchmarks show graph memory beats good (hybrid) RAG, and what is the cheapest effective approach for continuously growing memory?

### Takeaway
No. The independent evidence does not show graph memory clearly beating well-tuned RAG or full context for factual recall:
- In Mem0's own paper, full context (72.9) beat every memory system on LoCoMo, and the graph variant gained only about 1.6 points over plain Mem0.
- Letta reached 74.0% on LoCoMo with plain file search plus an agent loop.
- GraphRAG papers find vanilla RAG wins single-hop factual queries, while graphs help multi-hop and global "summarize everything" queries.

Most headline memory-benchmark scores are vendor self-reports with disputed methodology. The cheapest effective design is hybrid retrieval (BM25 + pgvector + metadata/time filters), plus LLM-extracted structured facts in tables (commitments, entities, decisions), plus an agentic search loop. Add graph edges only for specific multi-hop entity questions.

### Cited Findings

**Mem0 paper (arXiv 2504.19413), LoCoMo LLM-judge J score [vendor: Mem0]:**

| Method | J score | Tokens per query | Total latency p50 / p95 |
|---|---|---|---|
| Full-context | 72.90 | 26,031 | 9.87s / 17.12s |
| Mem0g (graph) | 68.44 | 3,616 | 1.09s / 2.59s |
| Mem0 | 66.88 | 1,764 | 0.71s / 1.44s |
| Zep | 65.99 | — | — |
| Best RAG (256-token chunks, k=2) | 60.97 | — | 0.80s / 1.91s |
| LangMem | 58.10 | — | — |
| OpenAI memory | 52.90 | — | — |
| A-Mem | 48.38 | — | — |

- Memory footprint: Mem0 ~7k tokens per conversation, Mem0g ~14k, Zep >600k, versus a raw conversation of ~26k — [arXiv 2504.19413](https://arxiv.org/html/2504.19413)
- Mem0's marketing now claims 92.5 on LoCoMo and 94.4 on LongMemEval (**[vendor]**, unverified) — [Mem0 State of Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026); [Mem0 V3](https://mem0.ai/research-2)

**Zep vs Mem0 dispute (May 2025):**
- Zep originally claimed 84% on LoCoMo. Mem0's CTO opened [getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5) with these objections:
  - Adversarial category-5 questions were counted inconsistently, inflating the score by ~25.6 points.
  - Zep used a modified system prompt and template.
  - Zep reported a single run rather than an average of 10.
  - Mem0's re-run got 58.44% ± 0.20.
- Zep's response:
  - Zep admitted a calculation error and corrected its score to 75.14% ± 0.17, which it says is ~10% better than Mem0g.
  - It stood by its prompt changes and said Mem0 had run Zep's searches sequentially instead of in parallel.
  - It urged evaluation on LongMemEval instead, then closed the issue for inactivity.
  
  Sources: [GitHub issue](https://github.com/getzep/zep-papers/issues/5); [Zep blog "Lies, damn lies, statistics"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)

**Letta, "Is a Filesystem All You Need?" (Aug 12, 2025) [vendor: Letta, a competitor]:**
- A Letta agent using GPT-4o-mini, with the LoCoMo conversations attached as a file and tools grep, search_files, open and answer_question, scored 74.0%. That beats Mem0's best reported 68.5% (graph variant).
- Letta called Mem0's numbers controversial and said Mem0 had not shared its MemGPT implementation. It argued that LoCoMo-style retrieval benchmarks "may not be very meaningful" for agentic memory.

  Source: [Letta blog](https://www.letta.com/blog/benchmarking-ai-agent-memory)

**LongMemEval-S (no official leaderboard; mostly self-reported):**
- With a GPT-4o reader:

  | System | Score | Note |
  |---|---|---|
  | Mastra Observational Memory | 84.23% | [vendor] |
  | Supermemory | 81.6% | [vendor] |
  | Zep | 71.2% | [vendor] |
  | Full-context GPT-4o | 60.2% | baseline |

  Sources: [Hindsight benchmarks repo](https://github.com/vectorize-io/hindsight-benchmarks); [Mastra](https://mastra.ai/research/observational-memory); [Atlan](https://atlan.com/know/mem0-alternatives/)
- With newer readers:
  - Mastra OM 94.87% (gpt-5-mini)
  - Hindsight 91.4% (Gemini-3 Pro) and 83.6% with its 20B open model
  - Supermemory 85.2% (Gemini 3 Pro)
  - Hindsight 94.6% and Mem0 94.4% are also claimed

  Sources: [Mastra blog](https://mastra.ai/blog/observational-memory); [Hindsight arXiv 2512.12818](https://arxiv.org/pdf/2512.12818); [Vectorize](https://vectorize.io/benchmarks); [aiagentmemory leaderboard](https://aiagentmemory.org/articles/agent-memory-leaderboard/)
- Changing only the reader model moves scores by ~10 points: Mastra goes from 84.23 with gpt-4o to 94.87 with gpt-5-mini. Cross-vendor numbers are therefore not comparable — [Mastra](https://mastra.ai/blog/observational-memory)
- Note that Mastra's Observational Memory, the top GPT-4o system, is not a graph. It compresses observations into a text log kept in context.
- A 2026 paper, MemDelta, argues there are "hidden confounds" and a need for controlled baselines in agent-memory evaluation — [arXiv 2606.29914](https://arxiv.org/pdf/2606.29914)
- LongMemEval-V2 (2026) reframes the target as "experienced colleagues", which is close to ALRO's use case — [arXiv 2605.12493](https://arxiv.org/pdf/2605.12493)

**BEAM (ICLR 2026):**
- 100 conversations from 128K up to 10M tokens, with 2,000 human-validated questions covering 10 memory abilities — [arXiv 2510.27246](https://arxiv.org/pdf/2510.27246)
- RAG beats vanilla long context. Example: Llama-4-Maverick scores 0.240 vanilla, 0.323 with RAG and 0.358 with the authors' LIGHT structured memory.
- LIGHT beats baselines by 3.5–12.7% on average. These are the authors' own method's results.
- Absolute scores remain low.

**MemoryAgentBench (arXiv 2507.05257):**
- Argues that long-context benchmarks test static reading, not incremental multi-turn memory — [arXiv](https://arxiv.org/pdf/2507.05257)
- About 2,071 questions over 103k–1.44M tokens — [Cognee guide](https://www.cognee.ai/ai-memory-benchmarks)
- Its RAG vs long-context results tables were not extracted.

**GraphRAG vs RAG:**
- **Han et al., "RAG vs. GraphRAG: A Systematic Evaluation":**
  - RAG consistently performs well on single-hop, fact-centric queries; GraphRAG does better on multi-hop.
  - Community-GraphRAG (Local) scored 71.17 overall vs RAG 65.77.
  - Community-GraphRAG (Global) generally underperforms RAG on the selected datasets.
  
  Source: [arXiv 2502.11371](https://arxiv.org/abs/2502.11371)
- **GraphRAG-Bench, "When to use Graphs in RAG" (ICLR 2026):**
  - Motivated by reports that "GraphRAG frequently underperforms vanilla RAG on many real-world tasks."
  - Evaluates graph construction, retrieval and generation across fact retrieval, complex reasoning, contextual summarization and creative generation.
  - Graph methods help evidence recall on complex and summarization tasks (e.g. 83.1%), while RAG keeps higher context relevance.
  
  Sources: [arXiv 2506.05690](https://arxiv.org/abs/2506.05690); [ICLR PDF](https://proceedings.iclr.cc/paper_files/paper/2026/file/6c9e01d6cefbbf4cdd265032550e767f-Paper-Conference.pdf); [repo](https://github.com/GraphRAG-Bench/GraphRAG-Benchmark)
- **"When Is Graph Structure Worth Its Cost?" (arXiv 2609.18099, 2026)** argues for "structure pricing", weighing graph build cost against gains — [arXiv](https://arxiv.org/pdf/2609.18099) (details not extracted)

**Cost of LLM-based graph extraction:**
- Microsoft's LazyGraphRAG uses NLP noun-phrase co-occurrence instead of LLM summarization. Microsoft reports:
  - Indexing cost equal to vector RAG and 0.1% of full GraphRAG's indexing cost.
  - Global-query quality comparable to GraphRAG at more than 700x lower query cost.
  
  **[vendor: Microsoft]** — [MSR blog](https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/); [The Stack](https://www.thestack.technology/microsoft-lazygraphrag/)
- LightRAG-style systems need about 10K tokens to index one document on average. LiteSemRAG claims ~20x faster indexing than LightRAG — [arXiv 2604.16350](https://arxiv.org/pdf/2604.16350)
- E²GraphRAG and TERAG target graph-RAG efficiency, which signals that indexing cost is a known bottleneck — [arXiv 2505.24226](https://arxiv.org/pdf/2505.24226); [arXiv 2509.18667](https://arxiv.org/pdf/2509.18667)
- Zep's graph footprint was over 600k tokens per LoCoMo conversation, versus ~26k raw — [Mem0 paper](https://arxiv.org/html/2504.19413) (**[vendor: competitor]**)

### Inferences
- **For ALRO's main question types** ("what did we promise Acme?", "what did X say about pricing last week?", "is the invoice follow-up done?"):
  - These are mostly single-hop and time-filtered, which is where hybrid RAG with metadata filters performs as well as or better than graphs.
  - Graphs help multi-hop questions ("which customers did people on Priya's team promise features to that are blocked by the Q3 release?") and global sensemaking ("what are the recurring complaints across all accounts?").
- **Recommended cheapest effective path, on the existing Postgres + pgvector:**
  1. Store raw messages and chunks with rich metadata: source, thread, participants, account, timestamp, and ACL principals. Use hybrid search (tsvector BM25 + pgvector) with a reranker.
  2. Run an incremental LLM extraction pass per thread into typed tables: `commitments`, `entities` (people, companies, deals), `facts` with `valid_from`/`valid_to` (Graphiti's bi-temporal idea, implemented relationally), and `entity_mentions` join rows. This is effectively a property graph in Postgres, and recursive CTEs can answer 2–3-hop questions.
  3. Give the agent tools rather than one retrieval shot: search, open the thread, filter by entity, list open commitments. Letta's 74% on LoCoMo with file search plus an agent loop and Mastra's ~84–95% with compressed observation logs both suggest the agentic loop and good summaries matter more than the graph store.
  4. Use periodic rollups (per account and per week) for global questions instead of GraphRAG community summaries. LazyGraphRAG's evidence says expensive up-front summarization is unnecessary.
- **Do not trust benchmark numbers for vendor selection.** LoCoMo is small and synthetic and has been disputed. Build a ~100–200 question eval from ALRO's own (consented) data, including commitment open/closed questions.
- **A dedicated graph DB (Neo4j/FalkorDB via Graphiti) adds:**
  - a second datastore to keep in sync with ACLs;
  - LLM calls on every ingested message, with large token footprints.
  
  It is justified only if multi-hop questions turn out to dominate real usage.

### Gaps
- No independent, controlled head-to-head of Zep/Graphiti vs well-tuned hybrid RAG on workplace data (email, Slack, CRM) was found. All available numbers are on conversational benchmarks (LoCoMo, LongMemEval), which are personal-assistant chats.
- Supermemory's and Letta's LongMemEval scores under a single controlled harness are not available.
- Graphiti ingestion cost (LLM calls per episode, latency) was not found.
- The Mem0g ingestion cost in dollars was not found.
- MemoryAgentBench and BEAM results for named commercial memory systems were not found.
- DMR (Deep Memory Retrieval, from MemGPT, on which Zep reported ~94.8% vs MemGPT ~93.4%) was not re-verified this session. It is widely considered too easy and near-saturated, but no source was fetched for this.
