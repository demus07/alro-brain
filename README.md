# ALRO Brain

The company-brain app behind ALRO. See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap.

## Develop

```sh
npm install
cp .env.example .env.local   # DATABASE_URL, a model key, ALRO_SECRET_KEY, ALRO_DEV_USER_EMAIL
npm test                     # everything on in-memory Postgres (PGlite) with mock models; no keys needed
npm run db:migrate           # apply migrations to the database in DATABASE_URL
npm run fixtures:load        # load the two-founder dataset
npm run dev
```

There is no sign-in yet: in development the app acts as the member in `ALRO_DEV_USER_EMAIL`, and it refuses to serve requests in production until authentication exists.

## How data flows

1. **Ingest** (`src/ingest/`, `src/connectors/`): direct connectors and uploads (`/upload`: Slack export, WhatsApp, .eml, .mbox, .vtt, CRM .csv) become one normalized batch shape; `writer.ts` saves it idempotently. Connectors sync every 15 minutes.
2. **Process** (`src/pipeline/run.ts`, every 10 minutes and after each upload): chunk + embed (`src/memory/chunks.ts`), build the knowledge graph, screen with the cheap model, extract commitments, updates, entities and facts, then write notes for new meeting transcripts. Extraction goes one local day at a time across threads so cross-source fulfilment works on backfills. A commitment only closes on quoted evidence (`fulfil.ts`).
3. **Watch** (hourly): `watcher.ts` moves deadlines to due soon / overdue and queues each reminder once. **Rollups** (hourly, per org's midnight): daily thread summaries. **Tick** (every 15 minutes): briefs for meetings about to start, and scheduled tasks that have come due.
4. **Answer** (`/`, `src/agent/`): the agent's tools each run in `withScope()`, so answers only use what the asker could see, and cite sources. `openAgent()` adds the asker's personal brain, their scheduled tasks and live tools. The same agent answers in WhatsApp, Telegram and Slack DMs (`src/channels/`).

## Sources

A source is one file in `src/connectors/` exporting a `Provider` (`provider.ts`), listed in `registry.ts`. ALRO calls each app directly with a credential the member gives it (a pasted token, or a Google / Microsoft sign-in), stored encrypted in `secrets` with `ALRO_SECRET_KEY`. A provider can `sync` into memory, offer live `tools` to the agent, or both. To add one, run `/build-connector <app>` in Claude Code (`.claude/skills/build-connector`).

Live tools (Settings → Live tools) are MCP servers the agent queries when asked; nothing is stored. Only tools that read are switched on.

Every connector is tested against a fake API. None has been run against a real account until someone connects it: check the first sync on the Health page.

## Database

- Schema: `src/db/schema.ts`. After changing it, run `npm run db:generate`.
- Hand-written migrations (extensions, row-level security, ACL triggers) live alongside the generated ones in `drizzle/`.
- Apply to Neon with `npm run db:migrate`.
- Background jobs use `getDb()` and must filter by `org_id`. Anything answering a user must use `withScope()` from `src/db/scope.ts`.

## Models and evals

Models are AI Gateway ids in `src/ai/models.ts` (overridable by env). Every call is logged to `llm_runs`; the Connectors page shows usage.

`npm run eval` runs the real pipeline over the founder fixtures in an in-memory database (never your `DATABASE_URL`) and scores it against the gold set: precision, recall, whether each promise ends done / cancelled / open as in the story, and whether "done" points at the right message. It writes `eval-report.json` and fails below `EVAL_MIN_PRECISION` (0.7), `EVAL_MIN_RECALL` (0.8) or `EVAL_MIN_OUTCOME` (0.7). CI runs it when extraction code changes and the `AI_GATEWAY_API_KEY` secret is set.
