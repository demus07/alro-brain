# 360labs Reference Products and the Commercial "Company Brain" / Enterprise AI Memory Landscape

Research date: 2026-10-27. Most third-party pricing comes from aggregators or competitor blogs. Those figures are flagged and should be checked against vendor pages before anyone relies on them.

## What do the two 360labs pages actually say, and what architecture do they imply?

### Takeaway
360labs (Lightyear 360 Labs Pvt Ltd, India) is an AI product studio and agency, not a funded product company. OmniAgent and Enterprise Brain are pitched as a self-hosted, privacy-first "semantic memory graph". OmniAgent's claims overlap ALRO's almost exactly: it ingests WhatsApp, Gmail and Slack, tracks "promises and deadlines", asks "who am I waiting on", and acts only after the user confirms. Neither page gives pricing, connector depth, models, a permissions model or any technical detail. The pages are marketing, and no evidence of a shipped product is publicly verifiable.

### Cited Findings
**OmniAgent** ([page](https://www.360labs.ai/products/omniagent))
- Tagline: "Your personal AI companion, omnipresent, omniscient, and omnipotent". It is a self-hosted, privacy-first personal assistant that runs 24/7 on the user's own server and keeps context across the day.
- "Omnipresent": channels are WhatsApp, Telegram, Gmail, Slack, Discord "+15 more".
- "Omniscient": it keeps conversations, sentiment, **promises and deadlines** in a **semantic memory graph**.
- "Omnipotent": it sends emails, books meetings, replies on the user's behalf, finds leads and sets reminders, with **confirmation required for every action**.
- A dashboard grounds answers in the memory graph. Suggested prompts include today's commitments, **overdue items**, top priorities and **"who am I waiting on"**. Sections are Home, **Brain (graph visualisation)**, Meetings, "Plyd", Scratchpad, Workflows (agents) and Settings.
- "Omni Hardware" bundle: an e-ink notebook, a compact home server, a companion phone and a portable power core. Data is "encrypted at rest and linked over a private mesh". The page also claims "Your data never leaves it".
- The page describes Enterprise Brain as the same memory graph scaled for teams: a "shared, permissioned knowledge layer" that remembers people, projects and commitments and runs on infrastructure the business owns.
- Not stated: pricing, AI models, hardware specs, certifications.

**Enterprise Brain** ([page](https://www.360labs.ai/products/enterprise-brain))
- A self-hosted knowledge layer that scales from a personal "Second Brain" to company-wide use. Tagline: "One private intelligence stack."
- It builds knowledge graphs from messy departmental spreadsheets and documents, with **multi-hop relationships among people, decisions, deadlines, metrics, processes**.
- "Grounded answers: every answer traces back to a source in your own data". It is described as database-first with "nothing to hallucinate". No benchmarks or evidence support these claims.
- Search and graphs run on the customer's hardware, and data stays in the network "unless you push it yourself".
- The page names no connectors, no permission model and no models. Pricing is not listed.

**Company background** ([homepage/FAQ](https://www.360labs.ai/))
- Lightyear 360 Labs Pvt Ltd calls itself "India's first AI-native Product Studio & AI Engineering Lab". It sells custom software, AI agents, enterprise automation and WhatsApp/email automation, and says it works "like an in-house tech team".
- FAQ pricing is for services, not products: AI agents and automations from about $10k, mid-complexity apps about $25k–75k, enterprise platforms about $100k–500k. It promises prototypes in 24–48 hours and production in 2–8 weeks.
- The portfolio covers government, defence and healthcare, and includes a "BusinessBrain" screenshot. Logos appear under "Humans from and affiliated with" (OpenAI, Google, Anthropic, NVIDIA, Palantir, IIT Delhi, Sarvam, and others), but the page doesn't say whether these are clients or alumni. No founders are named on the homepage. Contact is pra@360labs.ai.
- A web search found nothing independent about 360labs.ai. It mostly returned the unrelated Portland VR studio 360labs.net ([Igloo](https://www.igloovision.com/about/content-partners/360Labs), [Crunchbase](https://crunchbase.com/organization/360-labs)).

### Inferences
- The implied architecture is LLM extraction from messages into a typed entity graph (people, projects, commitments, deadlines, sentiment), plus retrieval with citations, plus an agent layer gated by human confirmation. All of it is on-prem or self-hosted, which suggests an Indian SMB/enterprise market that is sensitive to data residency.
- 360labs looks like an agency showcasing a reference product, probably built on open components such as a graph DB plus an LLM. It is a useful **feature checklist and UX reference** (graph view, "who am I waiting on", overdue items), not evidence of a defensible technical moat.
- Its WhatsApp-first channel list and India base make it the closest direct analogue to ALRO's positioning. ALRO's likely differentiators would be cloud SaaS ease of onboarding, CRM/Zoho depth and verified commitment-closure detection.

### Gaps
- The team, R&D and brochure PDF pages (/team, /research, /case-studies.pdf) were not fetched. Founder identity and real deployments are unknown.
- I found no pricing, customer count, demo, GitHub repo or third-party review for OmniAgent or Enterprise Brain.

## Which commercial products use knowledge graphs, and how?

### Takeaway
"Graph" is now the standard marketing word at the top end. Glean has its Knowledge Graph, Personal Graph and Enterprise Graph, Microsoft has Microsoft Graph plus Copilot connectors, Atlassian has the Teamwork Graph, and Day.ai has a CRM "context graph". In practice these are mostly **content + people + activity signal graphs** used to rank and personalise search and RAG, enforced by permissions mirrored from source systems. They are not temporal fact graphs that capture commitments. Developer memory layers (Zep/Graphiti, Mem0 graph, Supermemory) provide the temporal, entity-level graph memory that ALRO's founder is describing.

### Cited Findings
**Glean**
- The Knowledge Graph has three pillars, Content (documents, messages, tickets), People (identities, roles, teams, relationships) and Activity (interactions, document history, engagement), which "combine … to connect content, people, and activity signals". It is organised "in real time". The page also states that "Individual data remains isolated to each user" — [Glean docs](https://docs.glean.com/security/knowledge-graph)
- There are 100+ connectors, each built for one application's data model. The crawler handles content analysis, metadata extraction, **permissions management** and faceted indexing. Admins can set item-level access and inclusion/exclusion rules — [Glean docs](https://docs.glean.com/security/knowledge-graph). Another Glean page claims 275+ connectors, so the count conflicts across sources — [search summary of glean.com pages](https://www.glean.com/product/knowledge-graph)
- The Personal Graph profiles a user's communication style in up to 5 profiles. The Enterprise Graph combines org knowledge with each employee's personal graph, and launched with the third-generation Assistant in September 2025 — [Glean personal graph](https://www.glean.com/enterprise-context/personal-graph), [Glean enterprise graph](https://www.glean.com/enterprise-context/enterprise-graph), [Futurum](https://futurumgroup.com/insights/glean-doubles-arr-to-200m-can-its-knowledge-graph-beat-copilot/)
- ARR is reported at about $200M by Futurum, and other sources say $250M+ by early 2026 — [Futurum](https://futurumgroup.com/insights/glean-doubles-arr-to-200m-can-its-knowledge-graph-beat-copilot/)
- Pricing is not public. Third-party estimates are about $45–50/user/month plus about $15 for an AI add-on, or about $75/user/month with a roughly 100-seat minimum. A Vendr median contract is about $98.9k/year across 174 deals — [GoSearch](https://www.gosearch.ai/blog/glean-pricing-explained/), [Macha](https://www.getmacha.com/blog/glean-ai-complete-guide), [insearch](https://insearch.ai/glean-pricing). These sources are competitors and aggregators.

**Microsoft 365 Copilot / Microsoft Graph**
- Copilot Chat in Outlook is expanding from single-thread reasoning to the whole inbox, calendar and meetings. Its supported prompts include "surfacing follow-ups across email and meetings" and "spotting upcoming commitments" — [MS Copilot release notes](https://learn.microsoft.com/en-us/microsoft-365/copilot/release-notes). The related Outlook roadmap item (554934) was still listed as "on the horizon" in October 2026 — [aguidetocloud Oct 2026](https://www.aguidetocloud.com/blog/microsoft-365-copilot-october-2026-updates/)
- Planner Agent claims to "unify commitments across Microsoft 365" and to turn meeting follow-ups into Planner tasks — [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/plannerblog/planner-agent-brings-work-management-directly-into-microsoft-365-copilot/4511720)

**Atlassian Rovo / Teamwork Graph**
- Native connectors (Google Drive, SharePoint, Slack, etc.) are reported as included in Teamwork Collection, with no per-connector fee. Indexed objects don't consume Rovo credits, and Atlassian has not yet billed for credit overage. It promises 90 days' notice and opt-in before doing so — [Redress Compliance](https://redresscompliance.com/atlassian-teamwork-graph-pricing-explained.html), [eesel.ai](https://www.eesel.ai/blog/atlassian-intelligence-and-rovo-pricing-explained). These are secondary sources, and eesel is a competitor.
- Reported connector counts conflict at 30+, 50+ and 100+ — [eesel](https://www.eesel.ai/blog/rovo-ai-connectors), [Quartr](https://quartr.com/events/atlassian-corporation-plc-team-investor-update_3P6NSz4P). The CEO describes a "hybrid" seat-plus-credits pricing model — [ITEuropa](https://www.iteuropa.com/news/atlassian-gives-partners-more-meat-ai-services-space)

**Day.ai (AI-native CRM, "CRMx")**
- It builds a **context graph** that agents navigate and stores "decision traces", such as why deals closed and what objections arose, rather than discrete events — [Lightfield review (competitor)](https://lightfield.com/blog/day-ai-review), [Ramp AI Digest](https://ramp.com/leading-indicators/the-ai-digest-february-3-2026)
- It raised a $20M Series A led by Sequoia in February 2026, about $24M in total — [Dealroom](https://dealroom.co/companies/day-ai/), [fundup](https://fundup.ai/recently-funded-startups/company/o7869vekD4pVGIC2LA5m/day-ai)

**Dust**
- Its "Spaces" provide dual-layer permissions that segment knowledge for agents. One review says **per-user source-ACL mirroring is not documented** and that permissions are additive — [yespress/aggregator](https://yespress.io/products/dust.md), [everydev](https://www.everydev.ai/tools/dust)
- Pricing is about $29–30/user/month for Pro, with credits, no seat minimum and custom Enterprise pricing. It supports 20+ models and MCP — [Dust's own Glean comparison](https://dust.tt/landing/glean), [usecarly](https://www.usecarly.com/blog/glean-vs-dust/)

**Notion AI Enterprise Search**
- It is bundled in the Business tier (about $20/member/month annual) and includes connectors to Slack, Google Drive, GitHub, Jira, Teams, OneDrive, SharePoint, Salesforce and Box. It "maintains each connector's existing permission structure". Agents are metered separately at about $10 per 1,000 credits — [eesel](https://eesel.ai/blog/notion-ai-review), [gend.co](https://www.gend.co/blog/notion-pricing) (2026 pricing; sources differ on dates)

**Sana (Workday)**
- Workday agreed to acquire Sana for about $1.1B in September 2025 — [Workday newsroom](https://newsroom.workday.com/2025-09-16-Workday-Signs-Definitive-Agreement-to-Acquire-Sana). Sana launched as a standalone Workday product in March 2026 with a Self-Service Agent of 300+ HR and finance skills, connecting to Gmail, Slack and Salesforce — [SiliconANGLE](https://siliconangle.com/2026/03/17/workday-introduces-ai-knowledge-discovery-work-automation-platform-sana/)

**Developer memory layers (the "graph memory" building blocks)**
- Zep is a managed temporal knowledge graph built on Graphiti, which is open source (Apache-2.0) and self-hosted on Neo4j — [renezander](https://renezander.com/guides/zep-vs-graphiti/). Pricing sources conflict. One, citing the September 2026 page, gives free at 10k credits/month, Flex at $125/month (50k credits) and Flex Plus at $375 — [Wallaby](https://wallabytoken.com/blog/p/ai-memory-pricing-compared). Others give $25/month and $475 — [atlan](https://atlan.com/know/zep-vs-mem0/)
- Supermemory offers free ($5 credits), Pro $19, Max $100 and Scale $399/month, and is MCP-native — [Wallaby](https://wallabytoken.com/blog/p/ai-memory-pricing-compared), [atlan](https://atlan.com/know/mem0-alternatives/)
- Mem0's graph memory is gated to its $249/month Pro tier — [atlan](https://atlan.com/know/mem0-alternatives/)

### Inferences
- Glean, Microsoft and Atlassian graphs are **retrieval-relevance and permission graphs** (who is related to which content, and who can see what). They don't model commitments, so a promise is not a first-class node with an owner, counterparty, due date and status.
- Permission handling splits two ways. Enterprise tools (Glean, Notion, Microsoft) mirror source ACLs per item and per user. Lighter tools (Dust) use admin-defined spaces. If ALRO ingests personal channels such as WhatsApp and Gmail, it needs per-user ACL mirroring, or it will leak private messages into a "company brain".
- ALRO can build the temporal, bi-temporal fact-graph pattern on Graphiti/Zep or similar instead of inventing one.

### Gaps
- Glean's engineering-blog detail on graph schema and query-time permission enforcement wasn't retrieved. The docs page doesn't document edge types or query-time ACL checks.
- No primary source was retrieved for Hebbia (Matrix; only a competitor's estimate of about $3k–15k/seat/year exists — [agent.nexus](https://agent.nexus/blog/hebbia-vs-glean)), Guru, Slack AI (2026 pricing and enterprise search connectors), Lindy, Attio, Mem.ai, Personal.ai or Read.ai's memory features. These were not researched within the tool budget and are still open.
- Microsoft Graph connector internals and Viva Insights' older "commitments" features were not verified.

## Who already does promise / commitment / follow-up tracking, and how well?

### Takeaway
Commitment tracking is now a crowded niche of **small startups** (Claryti, Promiso, Ally, Lodestar, Rapto) plus **incumbent features** (Microsoft Copilot in Outlook and Planner Agent, and notetakers' action items in Granola, Fireflies and Read.ai). Almost none publish evidence on extraction accuracy or closure detection, which means automatically knowing a promise was fulfilled. Most are meeting-centric, and few cover WhatsApp or CRM.

### Cited Findings
- **Claryti** detects promises and action items from meetings, email and Slack, monitors them over time, tracks what others owe the user, and sends a daily brief. It targets founders and consultants and claims "0 dropped commitments" (self-reported) — [Claryti search snippet](https://www.claryti.ai/features/commitment-tracking), [founders page](https://www.claryti.ai/solutions/founders). The feature page returned HTTP 402 on fetch, so the details are unverified.
- **Promiso.ai** claims to track "every promise, made and received, across emails, texts, calls, and meetings" — [promiso.ai](https://promiso.ai/)
- **Ally** is aimed at founders and tracks each commitment with its counterparty, such as investors and customers — [allonourown.com](https://allonourown.com/ai-assistant-for-founders)
- **Lodestar AI** extracts commitments from email and meetings, infers implied due dates, and assigns the owner as the person who made the promise — [getlodestar.ai](https://www.getlodestar.ai/blog/daily-execution/follow-through/)
- **Rapto** is engineering-focused, syncs to Jira, Linear and Slack, and claims "70% of meeting promises are never kept" and "3× follow-through" without sourcing either figure — [rapto.cloud](https://www.rapto.cloud/)
- **Granola** drafts "what we agreed" follow-up emails with action items and owners. It is a notetaker, not a tracker — [Granola blog](https://www.granola.ai/blog/stakeholder-meetings-ai-notetakers-track-commitments-follow-ups). Pricing is a free Basic plan with limited history and Business at $14/user/month with MCP, API and HubSpot/Slack/Notion integrations. It is bot-free with local audio capture — [Granola pricing blog](https://www.granola.ai/blog/meeting-note-tool-pricing-granola-vs-fireflies-fathom-otter), [layer3labs](https://www.layer3labs.io/comparisons/granola-vs-fireflies)
- **Fireflies** includes action items. Pricing is Pro $10, Business $19 and Enterprise $39/seat/month (annual), with a visible bot — [Fireflies blog](https://fireflies.ai/blog/granola-vs-fireflies). **Read.ai** is free, with Enterprise from about $25/user/month — [meetily](https://meetily.ai/blog/best-meeting-notes-software-2026)
- **Microsoft Copilot (Outlook, Planner Agent)** surfaces follow-ups and commitments across mail and meetings, but the inbox-wide reasoning is still rolling out — [release notes](https://learn.microsoft.com/en-us/microsoft-365/copilot/release-notes), [Planner Agent](https://techcommunity.microsoft.com/blog/plannerblog/planner-agent-brings-work-management-directly-into-microsoft-365-copilot/4511720)
- **360labs OmniAgent** claims promise and deadline tracking with "overdue" and "who am I waiting on" views — [360labs](https://www.360labs.ai/products/omniagent)
- Search results noted that none of these vendors publish how extraction performs in practice or how they handle the privacy of email content — [search synthesis across the vendor pages above](https://www.claryti.ai/blog/what-is-commitment-tracking)

### Inferences
- "How well" can't be judged from public data. Every accuracy or outcome claim is self-reported marketing. The hard, undifferentiated problems are (1) precision, avoiding nagging about non-promises; (2) bidirectionality, covering both what I owe and what I'm owed; (3) **closure detection**, recognising from later email, CRM or Slack activity that a promise was fulfilled; and (4) deduplicating the same promise across channels.
- Microsoft bundling follow-up detection into Copilot threatens M365-only shops. Shops on Google, WhatsApp, Zoho or mixed stacks are underserved.

### Gaps
- I found no independent benchmark, G2 review data or user-reported accuracy for any commitment tracker.
- Pricing for Claryti, Promiso, Ally, Lodestar and Rapto was not retrieved.

## Where is the gap ALRO can own?

### Takeaway
No one combines all four of the following: (1) a **commitment-native temporal graph**, where promises are first-class nodes with owner, counterparty, due date, status and evidence links; (2) **WhatsApp + Zoho + CRM + email + meetings** coverage for SMBs and Indian or emerging-market companies; (3) **automatic closure detection** across channels; and (4) per-user, permission-mirrored company memory at SMB price points well below Glean.

### Cited Findings
- Enterprise search graphs model content, people and activity for relevance and permissions, not commitments — [Glean docs](https://docs.glean.com/security/knowledge-graph)
- Glean is priced for enterprise, with a median contract of about $99k/year and roughly a 100-seat minimum reported — [insearch](https://insearch.ai/glean-pricing), [Macha](https://www.getmacha.com/blog/glean-ai-complete-guide). Lighter competitors sit at about $20–30/user/month (Dust, Notion Business) — [dust.tt](https://dust.tt/landing/glean), [gend.co](https://www.gend.co/blog/notion-pricing)
- Commitment trackers are mostly meeting- and email-centric startups — [Claryti](https://www.claryti.ai/features/commitment-tracking), [Rapto](https://www.rapto.cloud/), [Lodestar](https://www.getlodestar.ai/blog/daily-execution/follow-through/). Promiso is the one that claims texts and calls — [promiso.ai](https://promiso.ai/)
- The closest direct analogue (360labs OmniAgent/Enterprise Brain) is self-hosted, has no public pricing, and comes from a services agency — [360labs](https://www.360labs.ai/)
- Day.ai owns the "context graph for CRM" niche for sales — [Ramp](https://ramp.com/leading-indicators/the-ai-digest-february-3-2026)

### Inferences
- **Positioning**: ALRO could be "the company's promise ledger", a memory graph where commitments, decisions and people are first-class, temporal and evidence-linked, and where the chat agent is one interface onto it. Competing head-on as "a cheaper Glean" is weak. Competing as "Claryti/Promiso with company-wide memory and WhatsApp/Zoho" is differentiated.
- **Architecture**: ALRO should use a bi-temporal entity and fact graph for people, orgs, deals, projects and commitments, with valid-from/valid-to and source pointers (for example Graphiti/Zep or similar). Hybrid vector and keyword retrieval would sit over raw messages for citations. Commitment status would change only on evidence (sent email, CRM stage change, a message saying "done"), and permissions would be inherited per source item and per user.
- **Defensibility**: the moats are closure-detection accuracy, WhatsApp/Zoho connectors (ignored by US incumbents), and trust controls (per-user privacy for personal channels, plus confirmation before any agent action, which is also 360labs' pattern).
- **Threats**: Microsoft Copilot follow-up detection for M365 shops, notetakers (Granola, Fireflies) moving up into cross-meeting memory, and Day.ai or Attio-style AI CRMs absorbing customer-commitment tracking.

### Gaps
- Attio, Lindy, Slack AI, Guru, Mem.ai and Personal.ai positioning was not verified in this pass, so the claim that they don't track commitments is unconfirmed.
- I found no market-size data for SMB "company brain" demand in India or other emerging markets.
