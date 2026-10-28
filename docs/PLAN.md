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
- [~] **4. Upload fallback.** Done: Slack export ZIP, WhatsApp `.txt` (Android + iOS), `.eml`, `.vtt` (`src/ingest/parsers/`). To do: `.mbox`, CRM CSV, upload UI.
- [ ] **5. Live connectors.** Slack, Gmail + Calendar, one CRM, meeting transcripts, WhatsApp Business.
- [ ] **6. Chunking and embeddings.** Hybrid search (pgvector + tsvector, RRF) under `withScope`.
- [ ] **7. Screen and extract.** Cheap model screens each message; thread windows go to extraction. Promises (quote must match the source), entities and bi-temporal edges.
- [ ] **8. Fulfilment.** Close commitments only on evidence: a reply, a sent email, a CRM change.
- [ ] **9. Agent.** AI SDK tools over layers 1–3, cited answers.
- [ ] **10. Watcher and rollups.** Cron for due soon / overdue / digest (deduped by `notifications`), nightly rollups.
- [ ] **11. Connector health page and evals in CI.**

## Known follow-ups

- When a thread's visibility changes, messages and chunks update automatically (trigger), but derived rows (entities, edges, commitments, rollups) need their ACL recomputed by a job.
- Graphiti on FalkorDB/Neo4j stays an option if multi-hop questions dominate. The `edges` table mirrors its model so moving would be an export, not a rewrite.
