# Open-source long-term agent memory frameworks and memory-as-a-service (as of 2026-10-27)

Scope note: about 16 tool calls. Primary sources (GitHub READMEs, arXiv, official docs) were fetched for Mem0, supermemory, supermemoryai/company-brain, the Mem0 paper abstract and MIRIX. Everything else comes from search snippets and third-party comparison articles, mostly Atlan's 2026 ranking, which reads stars and pricing as of 18 Sep 2026. Several of those articles are written by vendors (Cognee, Vectorize/Hindsight, supermemory, HydraDB), so treat their claims as marketing. Statements marked "[background, unverified this session]" come from the researcher's prior knowledge and were not re-checked. They are flagged so the report writer can drop them or verify them.

## Q0. Project profiles (what it does, memory model, update logic, license, stars, TS, infra, pricing, tenancy, benchmarks)

### Takeaway
Mem0, supermemory, Zep/Graphiti and Letta are the four mature, actively maintained options with commercial clouds. Of these, only Mem0 and supermemory have first-class TypeScript SDKs and AI SDK providers. supermemory's newly open-sourced `company-brain` is the closest existing analogue to ALRO: a Slack company brain with a permissions graph. The academic systems (A-MEM, MemoryOS, MIRIX, MemOS) are Python research code aimed at personal or chatbot memory.

### Cited Findings

#### Mem0 (mem0ai/mem0), Mem0g, OpenMemory
- The repo shows 67.9k stars and 8.0k forks under Apache-2.0. Python lives in `mem0/` and TypeScript in `mem0-ts/` (`npm install mem0ai`). — [GitHub mem0ai/mem0](https://github.com/mem0ai/mem0)
- **New algorithm (April 2026, "v3"):** extraction is now a single LLM call that only adds, with no UPDATE or DELETE, so "memories accumulate rather than being overwritten". It also adds entity linking, parallel semantic + BM25 + entity retrieval fused together, and "time-aware retrieval". — [GitHub mem0ai/mem0](https://github.com/mem0ai/mem0)
- The original paper (arXiv 2504.19413) describes Mem0 as "dynamically extracting, consolidating, and retrieving salient information". Mem0g adds a graph of relationships between conversational elements. On LOCOMO it reports +26% relative over OpenAI memory (LLM-as-judge), 91% lower p95 latency and over 90% token savings versus full context. The graph variant adds about 2% overall. — [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)
- 2026 self-reported scores: LoCoMo 71.4 → 92.5, LongMemEval 67.8 → 94.4, BEAM-1M 64.1, BEAM-10M 48.6. These reflect the managed platform with "proprietary optimizations not available in the open-source SDK". — [GitHub mem0ai/mem0](https://github.com/mem0ai/mem0)
- Atlan cites an independent evaluation (arXiv 2603.04814) that puts Mem0 at 49.0% on LongMemEval. Competitors have disputed Mem0's LOCOMO claims. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/) via search summary; the 49.0% figure was not verified against the paper.
- Graph memory is now a Platform-only (Pro) feature, and the open-source SDK dropped its external graph drivers. Atlan counts 27 documented vector-store backends. Scopes are user, session and agent. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [Atlan Mem0 alternatives](https://atlan.com/know/mem0-alternatives/)
- **Pricing:** Hobby is free (10K adds and 1K retrievals per month). Starter is $19/mo (50K adds). Pro is $249/mo (500K adds, 50K retrievals, graph memory). Enterprise is custom. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [Cognee Mem0 pricing page (competitor)](https://www.cognee.ai/mem0-pricing)
- Atlan reported 65,589 stars on 18 Sep 2026. The repo showed 67.9k at fetch time. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [GitHub](https://github.com/mem0ai/mem0)
- Mem0 raised $24M from YC, Peak XV and Basis Set in Oct 2025. — [TechCrunch](https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps)
- Vercel AI SDK provider: `@mem0/vercel-ai-provider`, maintained by Mem0. — [AI SDK docs: Mem0](https://ai-sdk.dev/providers/community-providers/mem0); [npm](https://www.npmjs.com/package/@mem0/vercel-ai-provider)
- **OpenMemory MCP:** a local-only MCP memory server from Mem0 with a dashboard. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)

#### supermemory (supermemoryai/supermemory) and company-brain
- The repo has 31.4k stars, 2.8k forks and 1,986 commits, under MIT. SDKs: TypeScript (`npm install supermemory`) and Python. — [GitHub supermemory](https://github.com/supermemoryai/supermemory)
- The engine "extracts facts from conversations, handles temporal changes and contradictions, and automatically forgets expired information". It also maintains user profiles split into `static` long-term facts and `dynamic` recent context. — [GitHub supermemory](https://github.com/supermemoryai/supermemory); [What is Supermemory](https://supermemory.ai/docs/overview/what-is-supermemory)
- Connectors: Google Drive, Gmail, Notion, OneDrive, GitHub and a web crawler, with real-time webhooks. The README does not list Slack. — [GitHub supermemory](https://github.com/supermemoryai/supermemory)
- **Self-host:** `npx supermemory local` or Docker; the API runs on localhost:6767 and still needs an API key. Embeddings default to local `bge-base-en-v1.5` and data lives in `~/.supermemory`. URL ingestion uses a hosted reader. — [GitHub supermemory](https://github.com/supermemoryai/supermemory)
- **Scoping:** "Namespaces" were called container tags in v3/v4. In v5 the namespace moves into the URL (`/ns/{namespace}`), a request can target only one namespace, and each namespace has its own vector index. — [supermemory docs: Namespaces](https://supermemory.ai/docs/concepts/container-tags)
- **Memory graph UI:** the React package `@supermemory/memory-graph` (v0.2.5) shows documents and memories as nodes. — [docs](https://supermemory.ai/docs/integrations/memory-graph); [npm](https://www.npmjs.com/package/@supermemory/memory-graph)
- **Benchmarks (self-reported):** the project claims #1 on LongMemEval, LoCoMo and ConvoMem, and 95% Recall@15 on LongMemEval with 99.4% context reduction. Atlan flags these as unverified. — [GitHub](https://github.com/supermemoryai/supermemory); [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Pricing:** there is a free tier. Atlan says Pro and Enterprise prices are "not publicly disclosed". — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- Integrations: an AI SDK tools package (`@supermemory/tools`, v3.1+ supports AI SDK 5/6/7) and an Anthropic memory-tool backend. — [AI SDK memory docs](https://ai-sdk.dev/docs/agents/memory); [supermemory blog](https://supermemory.ai/blog/how-to-use-supermemory-with-ai-sdk/); [supermemory Claude memory docs](https://supermemory.ai/docs/memory-api/sdks/anthropic-claude-memory)
- Production user: Scira AI moved its memory layer from Mem0 to supermemory. This comes from a vendor-sourced case study. — [AI SDK/supermemory search summary](https://supermemory.ai/blog/best-memory-apis-stateful-ai-agents)
- **company-brain (supermemoryai/company-brain):**
  - What it is: a Slack teammate that "truly knows and understands your company". It was formerly a paid product, discontinued and then open-sourced.
  - License and activity: Apache-2.0, about 1.1k stars, 147 forks, 42 commits.
  - Stack: TypeScript, Bun, Drizzle, Cloudflare Workers, Durable Objects, D1 (SQLite), KV and Workers AI, with a Daytona sandbox. It connects tools over MCP (GitHub, Linear, Notion, Google Workspace).
  - Memory is a **permissions graph** with three scopes: org-wide shared brain, per-private-channel and personal DM. The memory itself is stored in supermemory.
  - Access control: reads use the asker's own access, writes run under the user's connection, and tool actions need teammate approval. Each instance serves one org, in the owner's Cloudflare account. — [GitHub company-brain](https://github.com/supermemoryai/company-brain)

#### Letta (formerly MemGPT)
- **Memory model:** agents keep named, editable memory blocks (for example persona and human, each with a character limit) and manage memory themselves through tool calls. Atlan describes four tiers: blocks, files, archival memory and external RAG. — [Beetlix review](https://swarm.beetlix.com/reviews/letta-review-2026); [mr.technology](https://mr.technology/payloads/open_source_letta_memgpt_agent_framework_june_2026); [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Sleep-time compute** (April 2025): a background agent reorganizes memory while the user is idle. It has reportedly been rebranded as "dreaming", configured with `/sleeptime` in Letta Code. — [YesPress](https://yespress.io/letta); [innfactory](https://innfactory.ai/en/ai-harness/letta-code/)
- Atlan reports a March 2026 shift away from server-side memory tools toward git-backed memory files (Letta Code). — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- 24,786 stars (18 Sep 2026); Apache-2.0. The last version found was v0.16.7 (31 Mar 2026), which may now be out of date. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [ChatForest](https://chatforest.com/reviews/letta-memgpt-stateful-agent-framework/)
- Python and TypeScript client SDKs. The AI SDK provider `@letta-ai/vercel-ai-sdk-provider` requires agents to be created on the Letta server. — [Stork](https://www.stork.ai/en/letta-agent); [AI SDK memory docs](https://ai-sdk.dev/docs/agents/memory)
- **Pricing:** Free $0; Pro $20/project/mo plus usage; Max $200/project/mo; Enterprise custom; self-host free. Atlan instead lists Pro $20/mo for up to 20 agents and Teams $20/seat. The two sources conflict. — [myaiexp (Aug 2026)](https://www.myaiexp.com/en/items/agent-infra/letta); [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Benchmark:** 74.0% on LoCoMo with GPT-4o-mini using a plain filesystem agent (Letta, Aug 2025). — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)

#### Zep / Graphiti (added; most relevant temporal-graph option)
- Graphiti is an open-source temporal knowledge graph engine, and Zep is the managed service built on it. Facts carry validity windows and are **invalidated, not deleted** (bi-temporal). — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- Graphiti has 30,985 stars. Self-hosting needs Neo4j, FalkorDB or Amazon Neptune, and the managed Zep runs a proprietary engine. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Pricing:** Free (10K credits, 2 projects); Flex $125/mo; Flex Plus $375/mo; Enterprise. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Benchmarks:**
  - Zep paper: 71.2% on LongMemEval with GPT-4o vs a 60.2% full-context baseline.
  - Later self-report: 90.2% with gpt-5.4.
  - Another list gives 63.8%, which conflicts. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [search summary of Vectorize/Atlan](https://vectorize.io/articles/best-ai-agent-memory-systems)

#### LangMem (LangChain)
- MIT. It provides episodic, semantic and procedural memory on LangGraph's store, and procedural memory lets agents rewrite their own instructions. It is namespaced by user_id, team_id or app_id and can use Postgres/pgvector or MongoDB. There is no managed memory hosting; LangSmith costs $39 to $259/mo. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)

#### Cognee (added)
- Cognee is a poly-store memory layer combining graph, vector and relational storage. Its v1.0 API is `.remember`, `.recall`, `.improve` and `.forget`, on Neo4j, FalkorDB, Kuzu, NetworkX or SQLite/Postgres.
- Stars: 30,809.
- Pricing: self-host is free; managed is free up to 1M tokens, then $1 per 1M tokens plus $5 per workspace; BYOC for enterprise. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- Cognee is reportedly Python-only. — search summary of [Vectorize](https://vectorize.io/articles/best-ai-agent-memory-systems)

#### MemOS (MemTensor)
- It calls itself a "self-evolving memory OS" with hybrid retrieval and cross-task skill reuse, and claims 35.24% token savings. Version 2.0 "Stardust" was released, and v2.0.33 was announced on 3 Sep 2026. The README carries news up to 17 Aug 2026 (DeepSeek Harness plugins). — [GitHub MemOS](https://github.com/MemTensor/MemOS); [Discussions](https://github.com/MemTensor/MemOS/discussions/categories/announcements)
- The paper is "MemOS: A Memory OS for AI System". — [arXiv 2507.03724](https://arxiv.org/abs/2507.03724)
- **SECURITY:** on 23 Sep 2026, four MemTensor packages were published carrying a Go implant. They include npm `@memtensor/memos-cloud-openclaw-plugin` and the PyPI `MemoryOS` package. — [OrcaRouter blog](https://www.orcarouter.ai/blog/2026-09-23-memtensor-sckit-supply-chain). This is a single source; verify it before relying on it.
- The star count is unverified. The org page shows "12,076" next to MemOS, but the label is unclear. — [MemTensor org](https://github.com/MemTensor)

#### A-MEM (agiresearch/A-mem)
- Zettelkasten-style memory: each note carries LLM-generated keywords, tags and a context description. New memories link to old ones, and old notes get **revised ("memory evolution")** when new information arrives. It uses ChromaDB.
- The authors report 2–6× gains on multi-hop reasoning and 85–93% lower token use for memory operations.
- It was reportedly published at NeurIPS 2025, which was not confirmed. — [arXiv 2502.12110](https://arxiv.org/abs/2502.12110); [alphaxiv overview](https://www.alphaxiv.org/overview/2502.12110); [alphasmanifesto blog](https://blog.alphasmanifesto.com/2026/04/11/a-mem-zettelkasten-for-agents/)

#### MIRIX
- Six memory types (Core, Episodic, Semantic, Procedural, Resource, Knowledge Vault), coordinated by multiple agents. It reports 85.4% on LOCOMO. — [arXiv 2507.07957](https://arxiv.org/abs/2507.07957)

#### Memobase (memodb-io)
- User-**profile**-based long-term memory that also records user events, which supports time-related questions. Apache-2.0; registry version 0.0.27 dated 8 Nov 2025. — [i-programmer](https://www.i-programmer.info/news/105-artificial-intelligence/18295-memobase-add-memory-to-your-ai-agents.html); [os-ai-map PR](https://github.com/currentai-org/os-ai-map/pull/861)
- It is a baseline in the MIRIX paper, scoring 70.91 overall on LOCOMO. — [arXiv 2507.07957](https://arxiv.org/html/2507.07957v1)

#### MemoryOS (BAI-LAB), Memary, Basic Memory, Motorhead, Redis Agent Memory Server
- **MemoryOS (BAI-LAB):** an OS-like stack with short-, mid- and long-term layers. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
  - Note: the PyPI package named `MemoryOS` was among the packages compromised in the MemTensor supply-chain incident. — [OrcaRouter](https://www.orcarouter.ai/blog/2026-09-23-memtensor-sckit-supply-chain)
  - Which project owns that PyPI name is unclear, so check it before any install.
- **Memary:** persona-aware graphs on FalkorDB or Neo4j. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **Basic Memory:** a local-first Markdown knowledge base over MCP with two-way editing. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **Motorhead (getmetal):** deprecated; the README says "Support is no longer maintained for this project". — [GitHub getmetal/motorhead](https://github.com/getmetal/motorhead)
- **Redis Agent Memory Server:**
  - Features: REST and MCP, two tiers (working memory plus long-term vector search), pluggable vector backends. Atlan says it provides storage rather than memory logic and notes no native multi-tenancy. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory); [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
  - Size: about 1K stars.
  - Pricing: Redis Cloud is free up to 30MB, then about $0.07/GB-hr. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)

#### Cloud-native managed memory
- **AWS Bedrock AgentCore Memory:**
  - Short-term memory reportedly moved to volume billing on 6 Oct 2026: $1.00/GB ingested, $0.20/GB retrieved, $0.10/GB-month stored. It was previously $0.25 per 1K events.
  - Long-term memory with built-in strategies costs $0.75 per 1K records per month and $0.50 per 1K retrievals. Self-managed strategies cost $0.25 per 1K records. — [BetterClaw (Oct 2026)](https://www.betterclaw.io/blog/aws-bedrock-agentcore-pricing-alternatives); [akalcloud](https://akalcloud.ai/blog/bedrock-agentcore-pricing/)
  - These are third-party sources; verify them on the AWS pricing page.
- **Google Vertex AI Agent Engine Memory Bank:**
  - Storage for Sessions and Memory Bank is $0.30/GiB-month with the first GiB free, billed this way since 1 Sep 2026.
  - Reads and writes are metered as vCPU-hours.
  - It was previously $0.25 per 1K events. — [BetterClaw Vertex](https://www.betterclaw.io/blog/google-vertex-ai-agent-builder); [CloudZero](https://www.cloudzero.com/blog/google-vertex-ai-pricing/); [Vertex release notes](https://docs.cloud.google.com/agent-builder/release-notes)
- **Anthropic memory tool (`memory_20250818`):**
  - A file-directory memory that Claude edits with view, create, str_replace, insert, delete and rename.
  - **The application stores the files and executes each operation**; it must reject paths outside `/memories`.
  - Sources disagree on whether the beta header `context-management-2025-06-27` is required. — [Claude docs: Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- **OpenAI:** no official developer memory API was found. ChatGPT consumer memory was rebuilt in June 2026, with an editable memory summary and automatic revision of time-sensitive memories. — [letsdatascience](https://letsdatascience.com/news/openai-upgrades-chatgpt-memory-architecture-for-fresher-pers-b26b51d5); [IT Brief](https://itbrief.news/story/openai-rolls-out-chatgpt-memory-system-to-us-users)
  - aimemory.pro claims there is a "ChatGPT Memory API". It is a competitor's marketing page and is treated as unreliable. — [aimemory.pro](https://aimemory.pro/blog/chatgpt-memory-api)
- **Vercel AI SDK:** it does not persist anything between requests. Its memory guide offers three routes: a provider-defined memory tool (e.g. Anthropic's), a memory provider (Mem0, Letta, Supermemory) or a custom tool. — [AI SDK: Memory](https://ai-sdk.dev/docs/agents/memory)

#### Other notable 2025–2026 projects discovered
- **Mastra** (TypeScript-only agent framework) has memory backed by LibSQL or Postgres. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Microsoft Semantic Kernel / Kernel Memory:** MIT, C#/Python/Java with no TS, document-centric. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Agent memory libraries:** MemMachine (graph DB for episodic memory, SQL DB for profiles), MemU (adaptive forgetting), Nemori (episode segmentation), Memori (retention policies, multi-agent sync), O-Mem by OPPO (persona/event/message layers, Apache-2.0), CaviraOSS OpenMemory (decay), ReMe. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **RL-trained memory managers:** Memory-R1 (arXiv 2508.19828) and Mem-α (arXiv 2509.25911). — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **New arXiv work (2026):**
  - SodaMem: evidence-grounded temporal graph memory. — [arXiv 2608.08055](https://arxiv.org/pdf/2608.08055)
  - RippleMem: associative recollection. — [arXiv 2608.13334](https://arxiv.org/pdf/2608.13334)
  - Memanto: typed semantic memory. — [arXiv 2604.22085](https://arxiv.org/pdf/2604.22085)
  - VikingMem: a memory base management system. — [arXiv 2605.29640](https://arxiv.org/html/2605.29640v1)
  - Agentic Context Management. — [arXiv 2607.21503](https://arxiv.org/pdf/2607.21503)
- MemTensor's MemT-1.0 (Oct 2026) builds persistent neural memory into MoE models. It was not verified beyond one blog. — [aicybr](https://aicybr.com/blog/memt-1-memory-native-models-benchmarks-sglang-gpu-licenses)
- **Benchmarks:** newer long-memory benchmarks are BEAM (up to 10M tokens) and LongMemEval-V2. Atlan states that none of the 8 frameworks it reviewed has independently verified benchmarks. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)

### Inferences
- Benchmark numbers cannot be compared across vendors. Mem0's LongMemEval result ranges from 94.4% (self-reported) to 49.0% (independent), so ALRO should run its own evaluation on its own data, for example promise-tracking questions.
- For ALRO, the realistic candidates are:
  1. **Mem0 OSS (TS) on pgvector**, with ALRO's own graph and temporal layer.
  2. **supermemory** (cloud, or local self-host), using company-brain as a reference design.
  3. **Graphiti** for temporal facts, but that requires running Neo4j or FalkorDB alongside Neon.
  4. **Building in-house** on Postgres, borrowing Zep's bi-temporal fact model and Mem0's extraction prompts.

### Gaps
- Exact current stars and latest-release dates for Letta, Graphiti, LangMem, MemOS, A-MEM, MemoryOS, Memary, Basic Memory, Second Me and Redis AMS were not fetched directly; Atlan's 18 Sep 2026 figures are the best available.
- **Second Me** (mindverse) was not researched. [background, unverified this session] It is a personal "AI self" or digital twin trained on one person's data, and is irrelevant to org memory.
- Basic Memory's license was not confirmed. [background, unverified] It is believed to be AGPL-3.0, Markdown plus SQLite.
- MIRIX's license, repo and stars were not fetched.
- Mem0 org/project-level scoping: Mem0 Platform's `org_id`/`project_id` parameters were not verified this session. [background, unverified] The Mem0 API scopes by user_id, agent_id and run_id, and the Platform adds org and project.

## Q1. Which are "personal/chatbot memory" vs suitable for organisation-wide, multi-source knowledge?

### Takeaway
Most frameworks remember one user's conversations with an agent (user_id-scoped facts and profiles). Only supermemory (connectors plus company-brain's permissions graph), Zep/Graphiti and Cognee (document and graph ingestion) are designed for multi-source organisational knowledge. Even these leave per-user ACL mostly to the application.

### Cited Findings
- Mem0's scopes are user, session and agent, and its benchmarks are conversational (LoCoMo, LongMemEval). — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [GitHub mem0](https://github.com/mem0ai/mem0)
- supermemory has connectors for Drive, Gmail, Notion, OneDrive and GitHub plus a crawler, with webhooks. — [GitHub supermemory](https://github.com/supermemoryai/supermemory)
- company-brain has three memory scopes: org-wide, per private channel and per DM. Reads use the asker's own access. — [GitHub company-brain](https://github.com/supermemoryai/company-brain)
- Memobase, MIRIX, A-MEM and MemoryOS describe user- or persona-centric memory (profiles, persona layers, core and episodic memory of a user). — [i-programmer](https://www.i-programmer.info/news/105-artificial-intelligence/18295-memobase-add-memory-to-your-ai-agents.html); [arXiv 2507.07957](https://arxiv.org/abs/2507.07957); [arXiv 2502.12110](https://arxiv.org/abs/2502.12110)
- Kernel Memory is document-centric (RAG) with Azure IAM/RBAC. Atlan notes no native multi-tenancy in Redis AMS. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- Atlan's sources agree that temporal knowledge graphs (Zep/Graphiti) suit facts that change over time, while extract-and-retrieve systems (Mem0) suit personalization. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [Vectorize Mem0 vs Zep](https://vectorize.io/articles/mem0-vs-zep)
- Anthropic's memory tool is a file-based, application-hosted scratchpad, and ChatGPT's memory is a consumer feature. — [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool); [letsdatascience](https://letsdatascience.com/news/openai-upgrades-chatgpt-memory-architecture-for-fresher-pers-b26b51d5)

### Inferences
- **Personal/chatbot:** Mem0 (OSS), Letta, LangMem, Memobase, MIRIX, A-MEM, MemoryOS, Second Me, Basic Memory, Motorhead (dead), Anthropic and OpenAI native memory.
- **Usable for org-wide knowledge:** supermemory, Zep/Graphiti, Cognee, Mem0 Platform (graph), and the hyperscaler Memory Banks, though those are still keyed per user or session.
- **ACL caveat:** none of these provides document-level ACL inherited from the source system (for example, who could see a given Slack channel). company-brain gets this by querying with the user's own token and partitioning memory by scope. ALRO will need its own ACL layer: memory items tagged with source permissions and filtered at query time, or partitioned per scope as company-brain does.
- **Namespace limit:** supermemory v5's one-namespace-per-request rule makes "union of the scopes a user can see" queries awkward. ALRO would either fan out queries or merge results itself.

### Gaps
- Mem0 Platform and Zep documentation on org- or group-level memory (shared memory across users with per-user filtering) was not fetched.
- No evidence was found of any framework mapping source-system ACLs (Slack, Google, Salesforce) into memory items automatically.

## Q2. Which have strong TypeScript support and/or can store into Postgres (Neon + pgvector)?

### Takeaway
For a Next.js/Vercel stack, Mem0 (`mem0ai` TS SDK, pgvector among its many vector backends, AI SDK provider) and supermemory (TS SDK, AI SDK tools, TS codebase) are the strongest. LangMem (via LangGraph store), Mastra and Cognee can use Postgres. Graphiti needs a graph DB, and most research systems are Python only.

### Cited Findings
- Mem0 has a TS SDK in `mem0-ts/` (`npm install mem0ai`) and 27 vector-store backends. — [GitHub mem0](https://github.com/mem0ai/mem0); [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- supermemory has a TS SDK (`npm install supermemory`), `@supermemory/tools` for AI SDK 5/6/7 and a React memory-graph component. — [GitHub](https://github.com/supermemoryai/supermemory); [supermemory blog](https://supermemory.ai/blog/how-to-use-supermemory-with-ai-sdk/); [npm](https://www.npmjs.com/package/@supermemory/memory-graph)
- company-brain is written in TS (Bun, Drizzle) but stores data in D1/SQLite, not Postgres. — [GitHub company-brain](https://github.com/supermemoryai/company-brain)
- Letta has a TS client SDK and an AI SDK provider, but memory lives on the Letta server. — [Stork](https://www.stork.ai/en/letta-agent); [AI SDK memory](https://ai-sdk.dev/docs/agents/memory)
- LangMem can use Postgres via pgvector; Mastra is TS-only with LibSQL/Postgres storage; Cognee can use SQLite or Postgres; Graphiti uses Neo4j, FalkorDB or Neptune. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- LangChain JS exposes Anthropic's memory tool (`@langchain/anthropic` `tools/memory`). Because that tool is app-executed, its files can be stored in Postgres. — [LangChain JS docs](https://docs.langchain.com/oss/javascript/integrations/tools/anthropic); [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

### Inferences
- **Mem0 TS OSS on Neon pgvector** is the lowest-friction "drop-in memory" for ALRO. The cost: graph memory is now Pro-only, and v3 is ADD-only, so ALRO must build its own supersession and contradiction logic.
- **Self-hosting supermemory on Neon** is unclear. Local mode stores data in `~/.supermemory`, so it is probably not Postgres-backed. That would mean cloud use, or a separate store outside Neon.
- **Building on Postgres yourself is very feasible:** use a bi-temporal facts table (valid_from, valid_to, invalidated_by, source_ref, acl_scope), pgvector embeddings, and entity and edge tables for a graph. It mirrors Zep's model without Neo4j.

### Gaps
- Whether the Mem0 TS SDK's pgvector support matches the Python SDK's was not verified.
- supermemory's self-host storage backend and whether the TS server can run against Postgres were not verified.
- Graphiti TS or Postgres support was not checked; [background, unverified] Graphiti is Python.

## Q3. How do they handle contradiction and change over time?

### Takeaway
There are four distinct strategies:
1. LLM-decided in-place edits: Mem0 v1/v2 (ADD/UPDATE/DELETE/NOOP) and A-MEM "evolution".
2. Append-only with time-aware retrieval: Mem0 v3 since April 2026.
3. Bi-temporal invalidation: Zep/Graphiti, and supermemory's "temporal changes, contradictions, auto-forget".
4. Agent self-editing plus background consolidation: Letta memory blocks and sleep-time compute; OpenAI's 2026 "auto-revise time-sensitive memories".

### Cited Findings
- **Mem0 paper:** Mem0 "dynamically extract[s], consolidat[es], and retriev[es]" memories. — [arXiv 2504.19413](https://arxiv.org/abs/2504.19413)
  - [background, unverified this session; the abstract fetch did not include it] The paper body describes an update phase. For each candidate fact, an LLM tool-call chooses ADD, UPDATE, DELETE or NOOP against the top-similar existing memories.
  - [same caveat] Mem0g uses a conflict detector that marks contradicted graph relationships invalid rather than deleting them. The [full paper PDF](https://arxiv.org/pdf/2504.19413) should be checked.
- **Mem0's April 2026 algorithm** removes this. It is "ADD-only extraction… no UPDATE/DELETE, so memories accumulate rather than being overwritten", and handles change with "time-aware retrieval". — [GitHub mem0](https://github.com/mem0ai/mem0)
- Atlan's characterization of Mem0 ("self-edits on conflict; no temporal model") predates or contradicts the v3 change. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/) vs [GitHub mem0](https://github.com/mem0ai/mem0)
- **Zep/Graphiti:** facts have validity windows, and superseded facts are invalidated, not deleted (bi-temporal). — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/); [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **supermemory:** "handles temporal changes, contradictions, and automatically forgets expired information". The profile is split into static and dynamic parts. — [GitHub](https://github.com/supermemoryai/supermemory)
- **A-MEM:** new notes trigger LLM updates to the context, keywords and tags of linked older notes. — [alphaxiv](https://www.alphaxiv.org/overview/2502.12110)
- **Letta:** agents edit their own memory blocks through tool calls, and a sleep-time agent reorganizes memory offline. — [mr.technology](https://mr.technology/payloads/open_source_letta_memgpt_agent_framework_june_2026); [YesPress](https://yespress.io/letta)
- **Cognee:** has an explicit `.improve` and `.forget` API. — [Atlan](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- **Memobase:** records timestamped user events alongside profiles for temporal questions. — [i-programmer](https://www.i-programmer.info/news/105-artificial-intelligence/18295-memobase-add-memory-to-your-ai-agents.html)
- **Forgetting/decay:** MemU uses adaptive forgetting, CaviraOSS OpenMemory uses auto-decay, and Memori uses retention policies. — [awesome-agent-memory](https://github.com/samvallad33/awesome-agent-memory)
- **OpenAI ChatGPT memory (2026):** automatically revises time-sensitive memories, with a user-editable summary. — [letsdatascience](https://letsdatascience.com/news/openai-upgrades-chatgpt-memory-architecture-for-fresher-pers-b26b51d5)
- **SodaMem (2026):** proposes "evidence-grounded temporal graph memory", in which facts are linked to source evidence. — [arXiv 2608.08055](https://arxiv.org/pdf/2608.08055)

### Inferences
- **Mem0 dropping in-place UPDATE/DELETE is a notable signal:** destructive LLM edits were apparently hurting accuracy. Even the leading vendor now prefers append plus time-aware retrieval, which is also what bi-temporal designs do.
- **ALRO's commitments and promises need provenance** (who promised what, in which message, when, and whether it was fulfilled or superseded). That fits the Zep/SodaMem pattern better than Mem0's:
  - **Append-only:** keep an immutable evidence log of messages and transcripts.
  - **Derived facts:** each fact carries valid_from/valid_to, a status (active, superseded, fulfilled, cancelled) and a source_message_id.
  - **Contradiction:** handled by marking the old fact superseded and linking it to the new evidence, never deleting it.
  - **Consolidation:** a nightly "sleep-time" job, as in Letta, rebuilds the summaries.
- **Audit and ACL:** append-only storage with invalidation also simplifies both. Deleted or redacted sources can cascade invalidations to every fact derived from them.

### Gaps
- No independent head-to-head evaluation of contradiction handling (knowledge-update questions) across frameworks was found. LongMemEval has a "knowledge update" category, but per-category vendor scores were not collected.
- supermemory's exact contradiction mechanism (LLM-judged supersession? versioning?) is not documented in the fetched pages.
- How forgetting interacts with legal retention and deletion requests (GDPR erasure of derived memories) was not documented by any project reviewed.
