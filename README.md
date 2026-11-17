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

Sign-in is always required in production. In development the app acts as the member in `ALRO_DEV_USER_EMAIL` without signing in; set `ALRO_AUTH=on` to sign in locally (`npm run auth:invite -- you@company.com owner` prints a first-sign-in link for data loaded before sign-in existed).

What is built, what has only been tested against fakes and what has run against real services is tracked in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), along with how the five parts of the system fit together.

## People, access and safety

- **Sign-in** (`src/auth/`): email and password (scrypt), sessions in the database (the cookie holds a random token, only its hash is stored), one-time invitation and reset links, "Continue with Google / Microsoft" and single sign-on through any OpenID Connect provider (Okta, Entra, Google Workspace), and one-time sign-in links emailed to any work address (sent by SMTP, e.g. a Hostinger mailbox, or Resend). Google, Microsoft and emailed links let in members and people with a live invitation; the first owner can create the company with Google or Microsoft. A company is created at `/sign-up` (open only for the first company unless `ALRO_SIGNUP=open`); everyone else joins by invitation. `src/proxy.ts` turns away requests without a session; `getViewer()` checks the session on every read.
- **Roles and departments** (`src/platform/`, `/admin`): owners and admins manage people, team sources, the agent team, data policies and usage; members connect their own accounts. A team source can be limited to a department (`d:<dept>` principal in the ACL). Admins can exclude a conversation: what was taken from it is deleted and syncs skip it. Removing a member signs them out everywhere and stops their sources and tasks.
- **What each person sees** (`src/db/scope.ts`, `drizzle/0002`, `0010`): every user-facing read runs as the `alro_app` role with the person's principals, and row-level security hides the rest. Each sync replaces channel membership, marks deleted messages and re-derives visibility (`src/memory/revoke.ts`), so losing access in the source means losing it here.
- **Outside text is never instructions** (`src/agent/untrusted.ts`): tool results are scanned; text aimed at instructing the assistant is flagged to the model, the proposal that follows carries a warning to its approver, and a trusted task stops acting on its own for that run.
- **Audit and limits**: sign-ins, questions, approvals, sources and admin changes go to `audit_log` (`/admin` → Activity). Usage is metered per company per day against its plan (`src/platform/usage.ts`); questions and processing stop at the limit instead of running up a bill.
- **Keys**: connector tokens are sealed with `ALRO_SECRET_KEY`; `npm run secrets:rotate` re-seals them under a new key.

## How data flows

1. **Ingest** (`src/ingest/`, `src/connectors/`): direct connectors and uploads (Settings → Upload files: Slack export, WhatsApp, .eml, .mbox, .vtt, CRM .csv) become one normalized batch shape; `writer.ts` saves it idempotently. Connectors sync every 15 minutes.
2. **Process** (`src/pipeline/run.ts`, every 10 minutes and after each upload): chunk + embed (`src/memory/chunks.ts`), build the knowledge graph, screen with the cheap model, extract commitments, updates, entities and facts, write notes for new meeting transcripts (and propose the follow-up email for approval), then add rows to trackers (`src/work/trackers.ts`). Extraction goes one local day at a time across threads so cross-source fulfilment works on backfills. A commitment only closes on quoted evidence (`fulfil.ts`).
3. **Watch** (hourly): `watcher.ts` moves deadlines to due soon / overdue and queues each reminder once. **Rollups** (hourly, per org's midnight): daily thread summaries. **Tick** (every 15 minutes): briefs for meetings about to start, and scheduled tasks that have come due.
4. **Answer** (`/`, `src/agent/`): the agent's tools each run in `withScope()`, so answers only use what the asker could see, and cite sources. `openAgent()` adds the asker's personal brain, their scheduled tasks, procedures and trackers, live tools, actions and the agent team. The same agent answers in WhatsApp, Telegram, Slack and Teams (`src/channels/`), including voice notes, photos and PDFs.
5. **Act** (`src/approvals/`): anything that sends or changes something (an email, a Slack post, a CRM note, a live-tool call that writes) is only proposed. It waits under Approvals until its owner approves it, in the app or by replying "yes CODE" in a messaging app; a scheduled task they mark as trusted runs its actions without asking. Writes are never retried automatically.
6. **Team** (`src/team/`): departments (finance, sales, operations, marketing, tech) whose lead hands focused tasks to specialists that run in parallel, each with only the tools its job needs (`/team`). The agent calls a department with `askTeam`; a scheduled task can be given to one. Each run has a token budget (`ALRO_TEAM_TOKEN_BUDGET`) and a time limit, survives a failing specialist, cross-checks figures between reports and is recorded (`/team/runs`).
7. **Notice** (`src/insights/`): after each processing pass and every hour, deterministic signals (a client waiting on a reply, a deal gone quiet, promises slipping, someone overloaded, facts in dispute) become insights visible to whoever can see their evidence. They lead the morning brief, the Updates page and `/overview`, and urgent ones are pushed to the people concerned.

**Memory that stays true** (`src/memory/facts.ts`, `/memory`): each fact records who said it and how sure; a contradiction between equals becomes a dispute rather than a silent overwrite, a confirmation settles it, old unconfirmed facts are marked as possibly out of date, and people can verify or reject a fact. Search re-ranks by recency, entity match and source kind after the hybrid fusion.

**When things fail** (`src/ops/`, `/connectors`): every background job run is recorded; failed bot messages, scheduled tasks and reminders are retried with growing waits and then left for an admin; incoming webhooks are stored before they are handled so a redelivery is ignored and a failure is replayed; repeated failures alert once (`ALRO_ALERT_WEBHOOK_URL`). An approved action that times out is marked "unknown" and never re-sent automatically.

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
