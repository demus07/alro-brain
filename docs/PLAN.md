# ALRO Brain: build plan

ALRO ingests everything a company communicates through (Slack, Teams, Gmail/Outlook, WhatsApp, Zoho, Salesforce, HubSpot, meeting transcripts), keeps an ever-growing memory of it, answers questions with citations, and tracks promises until they are kept.

Background research: [Graph memory for ALRO](research/reports/Graph%20memory%20for%20ALRO.md).

## Architecture

```
Connectors (Nango + file uploads)
        │  normalise to one shape
        ▼
1. Evidence log      threads, messages, records, chunks        immutable, ACL on every row
2. Entity graph      entities, aliases, edges                  bi-temporal facts (Graphiti design, in Postgres)
3. Commitment ledger commitments, commitment_events            status changes only on evidence
4. Agent tools       hybrid search, threads, commitments, 1–3 hop graph queries, always cited
5. Consolidation     rollups, watcher, reminders
```

One Neon Postgres (pgvector + pg_trgm). No separate graph or vector database in Phase 1.

**Privacy.** Every content row carries an `acl` of principals (`org`, `t:<thread>`, `p:<person>`). Derived rows carry the union of their evidence's ACLs. User requests run through `withScope()`, which switches to the `alro_app` role so Postgres row-level security hides anything the asker couldn't see in the source tool. Personal sources (DMs, personal email, WhatsApp) are members-only by default.

## Phases

| Phase | Goal |
|---|---|
| 0. Setup | App, database, AI Gateway, Nango, start Google/Microsoft/Meta approvals |
| **1. Core loop** | Memory schema, connectors (one per category + uploads), screen → extract → fulfil, agent, watcher |
| 2. Coverage | More connectors, per-record CRM permissions, cross-source fulfilment |
| 3. Actions | Agent writes back (CRM tasks, draft replies) with Approve/Deny |
| 4. UI | Design system and palette |

## Phase 1 steps

- [x] **1. Memory schema and access control.** `src/db/schema.ts`, `drizzle/`, `src/db/scope.ts`; tested in `src/db/access.test.ts`.
- [x] **2. Gold set (dummy).** `fixtures/alro-founders/`: 28 commitments with outcomes and ~85 distractors across Slack, email, meetings and WhatsApp. Still needs real pilot data and CRM notes.
- [x] **3. Ingestion core.** `src/ingest/types.ts` (normalized batch), `src/ingest/writer.ts` (idempotent upserts, identity resolution by provider id → email → phone → name, `sync_runs`).
- [x] **4. Upload fallback.** Slack export ZIP, WhatsApp `.txt` (Android + iOS), `.eml` and `.mbox` (multipart MIME), `.vtt`, CRM `.csv` (HubSpot / Zoho / Salesforce columns; changes logged as `record_change` messages) in `src/ingest/parsers/`; `/upload` page and `POST /api/uploads`.
- [ ] **5. Live connectors.** Slack, Gmail + Calendar, one CRM, meeting transcripts, WhatsApp Business.
- [x] **6. Chunking and embeddings.** `src/memory/chunks.ts` (windows of ≤15 messages, split on 6h gaps, only the tail rebuilt), `src/memory/search.ts` (pgvector + tsvector, RRF, HNSW iterative scan so RLS can't starve results).
- [x] **7. Screen and extract.** `src/pipeline/screen.ts`, `src/pipeline/extract.ts`: quotes verified against the source, owners must resolve to known people, facts invalidate older ones (bi-temporal). Processed one local day at a time across threads.
- [x] **8. Fulfilment.** `src/pipeline/fulfil.ts`: done / cancelled / rescheduled / partial only with quoted evidence, logged in `commitment_events`; evidence widens visibility. People can also mark done, dismiss or reopen (`src/memory/verdicts.ts`, `/commitments`).
- [x] **9. Agent.** `src/agent/`: search, read thread, commitments, commitment history, entity facts (1–3 hops, with history), daily summaries; each tool in its own `withScope()`; `[S1]` citations rendered on `/`.
- [x] **10. Watcher and rollups.** `src/pipeline/watcher.ts`, `src/pipeline/rollups.ts`, cron routes in `src/app/api/cron/`, schedules in `vercel.json`. Reminders are queued as `in_app` only; delivery to Slack / email waits for those connectors.
- [x] **11. Connector health page and evals in CI.** `/connectors`; `npm run eval` scores against the gold set (`src/evals/gold.ts`); `.github/workflows/ci.yml` runs it when extraction code changes.

## Known follow-ups

- **Authentication.** `src/lib/viewer.ts` is a development stand-in (`ALRO_DEV_USER_EMAIL`) and refuses to run in production.
- **Step 5, live connectors,** needs Nango, the Slack / Google / Meta apps and Google's CASA review.
- **Reminder delivery.** The watcher queues reminders and digests; nothing sends them yet.
- **First real eval run.** The scoring is tested, but the prompts haven't been run against real models yet (`npm run eval` with an AI Gateway key).
- `mentionedEntities` in extraction loads every entity name per call; fine for now, needs a trigram index query at scale.
- When a thread's visibility changes, messages and chunks update automatically (trigger), but derived rows (entities, edges, commitments, rollups) need their ACL recomputed by a job.
- Graphiti on FalkorDB/Neo4j stays an option if multi-hop questions dominate. The `edges` table mirrors its model so moving would be an export, not a rewrite.
