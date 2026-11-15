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
2. **Process** (`src/pipeline/run.ts`, every 10 minutes and after each upload): chunk + embed (`src/memory/chunks.ts`), build the knowledge graph, screen with the cheap model, extract commitments, updates, entities and facts, write notes for new meeting transcripts (and propose the follow-up email for approval), then add rows to trackers (`src/work/trackers.ts`). Extraction goes one local day at a time across threads so cross-source fulfilment works on backfills. A commitment only closes on quoted evidence (`fulfil.ts`).
3. **Watch** (hourly): `watcher.ts` moves deadlines to due soon / overdue and queues each reminder once. **Rollups** (hourly, per org's midnight): daily thread summaries. **Tick** (every 15 minutes): briefs for meetings about to start, and scheduled tasks that have come due.
4. **Answer** (`/`, `src/agent/`): the agent's tools each run in `withScope()`, so answers only use what the asker could see, and cite sources. `openAgent()` adds the asker's personal brain, their scheduled tasks, procedures and trackers, live tools, actions and the agent team. The same agent answers in WhatsApp, Telegram, Slack and Teams (`src/channels/`), including voice notes, photos and PDFs.
5. **Act** (`src/approvals/`): anything that sends or changes something (an email, a Slack post, a CRM note, a live-tool call that writes) is only proposed. It waits under Approvals until its owner approves it, in the app or by replying "yes CODE" in a messaging app; a scheduled task they mark as trusted runs its actions without asking. Writes are never retried automatically.
6. **Team** (`src/team/`): departments (finance, sales, operations, marketing, tech) whose lead hands focused tasks to specialists that run in parallel, each with only the tools its job needs (`/team`). The agent calls a department with `askTeam`; a scheduled task can be given to one.

`/procedures` writes up how recurring work is actually done from the conversations, scored on how often it happens, how long it takes and how much judgment it needs (the work to hand over first). `/trackers` keeps running tables (a sales log, receivables, stock, truck turnaround) pulled from chats, email and photos, each row linked to its message.

## Sources

A source is one file in `src/connectors/` exporting a `Provider` (`provider.ts`), listed in `registry.ts`. ALRO calls each app directly with a credential the member gives it (a pasted token, or a Google / Microsoft sign-in), stored encrypted in `secrets` with `ALRO_SECRET_KEY`. A provider can `sync` into memory, offer live `tools` to the agent, or both. To add one, run `/build-connector <app>` in Claude Code (`.claude/skills/build-connector`).

A provider can also define `actions` (send an email, post a message, add a CRM note or task). They're offered to the agent as proposals and only run once approved.

Live tools (Settings → Live tools) are MCP servers the agent queries when asked; nothing is stored. Tools that read are switched on by default; tools that change things can be switched on and then always wait for approval.

Every connector is tested against a fake API. None has been run against a real account until someone connects it: check the first sync on the Health page.

## Database

- Schema: `src/db/schema.ts`. After changing it, run `npm run db:generate`.
- Hand-written migrations (extensions, row-level security, ACL triggers) live alongside the generated ones in `drizzle/`.
- Apply to Neon with `npm run db:migrate`.
- Background jobs use `getDb()` and must filter by `org_id`. Anything answering a user must use `withScope()` from `src/db/scope.ts`.

## Models and evals

Models are AI Gateway ids in `src/ai/models.ts` (overridable by env). Every call is logged to `llm_runs`; the Connectors page shows usage.

`npm run eval` runs the real pipeline over the founder fixtures in an in-memory database (never your `DATABASE_URL`) and scores it against the gold set: precision, recall, whether each promise ends done / cancelled / open as in the story, and whether "done" points at the right message. It writes `eval-report.json` and fails below `EVAL_MIN_PRECISION` (0.7), `EVAL_MIN_RECALL` (0.8) or `EVAL_MIN_OUTCOME` (0.7). CI runs it when extraction code changes and the `AI_GATEWAY_API_KEY` secret is set.
