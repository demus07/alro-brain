# ALRO architecture and status

ALRO is five systems that can change independently. Each depends only on the ones below it.

| # | System | What it is | Where |
|---|--------|------------|-------|
| 1 | **Experience** | Where people meet ALRO: the web app, WhatsApp, Telegram, Slack, Teams, voice notes, photos | `src/app/`, `src/channels/` |
| 2 | **Agent** | The main agent, department leads and specialists, their tools and instructions | `src/agent/`, `src/team/`, `src/tools/` |
| 3 | **Execution** | Doing things: actions and approvals, scheduled tasks and watches, live tools, connectors' write side | `src/approvals/`, `src/routines/`, `src/connectors/*` (`actions`), `src/tools/mcp.ts` |
| 4 | **Intelligence** | The company's memory: ingestion, processing, the knowledge graph, facts, search, insights, procedures, trackers | `src/ingest/`, `src/connectors/*` (`sync`), `src/pipeline/`, `src/memory/`, `src/insights/`, `src/work/` |
| 5 | **Platform** | Sign-in, companies, roles, departments, row-level security, audit, usage limits, retention, jobs, retries, alerts | `src/auth/`, `src/platform/`, `src/db/`, `src/ops/`, `src/lib/`, `src/proxy.ts` |

The intelligence layer is the part meant to become ALRO's own: the agent framework, the channels and
the connectors can all be replaced without touching how a company's memory is built and kept true.

## Three kinds of memory

| Kind | What it holds | Tables |
|------|---------------|--------|
| What happened (episodic) | Conversations, emails, meetings, calendar events, daily summaries | `threads`, `messages`, `chunks`, `events`, `meeting_notes`, `rollups` |
| What is true (semantic) | People, companies, deals and the facts about them, each with who said it, how sure, and whether it's current, disputed or possibly out of date; promises and their history | `entities`, `edges`, `commitments`, `commitment_events`, `insights` |
| How work is done (procedural) | Procedures written up from conversations, trackers, each person's goals, preferences and writing style | `procedures`, `trackers`, `tracker_rows`, `profiles`, `profile_notes` |

A fact's life (`src/memory/facts.ts`): stated → confidence set from how it was said and by whom →
restated (confidence up, `last_confirmed_at` moves) → contradicted (replaced when a higher authority
or the same speaker changes it; **disputed** when equals disagree) → settled by a confirmation or by a
person on `/memory` → marked possibly out of date when nobody has repeated it for 90 days (30 for
prices, status, budgets, owners and dates) → deleted with its evidence (retention, a removed source,
an excluded conversation).

## Who sees what

Every row that carries content has an `acl` of principals: `org`, `d:<department>`, `t:<thread>`,
`p:<person>`. A user-facing read runs as the `alro_app` database role with the person's principals,
and row-level security hides everything else (`src/db/scope.ts`). Derived rows carry the union of
their evidence's ACLs and are re-derived when a conversation changes hands (`src/memory/revoke.ts`).
Tables that hold credentials, sessions, audit, usage and job history are not readable by that role
at all.

## The life of an action

`proposed` (pending, with a short code, a reason, an expiry and, if the run read suspicious text, a
caution) → the owner edits (revision goes up), approves (in the app or "yes CODE" in a messaging app)
or drops it → `running` → `done` / `failed` (can be put back in the queue) / `unknown` (the app didn't
answer: never re-sent automatically; the owner checks and chooses). Unanswered proposals `expire`.
A scheduled task its owner trusts runs **internal** actions without asking, unless that run read
text aimed at instructing the assistant. Nothing that reaches a client runs without a person.

## Status

**Built**: the code exists and is wired in. **Tested with fakes**: automated tests against an
in-memory Postgres with mock models and fake APIs (`npm test`, 803 tests). **Run for real**: exercised
on a real database with real models or a real browser on a developer machine. Nothing has run in
production or with more than one real company.

| Area | Built | Tested with fakes | Run for real |
|------|-------|-------------------|--------------|
| Uploads (WhatsApp, Slack export, email, transcripts, CRM CSV) | Yes | Yes | WhatsApp export only |
| Photos, PDFs and Office files (upload and messaging) | Yes | Yes | One photo read correctly by a free vision model |
| Processing: search index, graph, promises, facts, meeting notes | Yes | Yes | Yes, on free models (promise detection was weak on them) |
| Fact confidence, disputes, confirmation, staleness, verify/reject | Yes | Yes | One scenario: the end state was right; the in-between dispute was not flagged by the free model |
| Search re-ranking | Yes | Yes | Used in real answers; quality not measured |
| 37 connectors (sync, live lookups, actions) | Yes | Yes (fake APIs) | **No.** Each was only probed with a fake key to confirm address and sign-in style |
| Revoked access and deletions flowing in (Slack, Teams, Discord, Gmail) | Yes | Yes | No |
| Google / Microsoft / Xero / QuickBooks sign-in for sources | Yes | Partly | No |
| Agent answers with citations | Yes | Yes | Yes |
| Prompt-injection guard | Yes | Yes | Yes: a planted instruction was flagged, refused and reported |
| Actions and approvals, incl. expiry, revisions, unknown outcomes | Yes | Yes | Approval loop with a test tool server; no real email or CRM write |
| Agent team with budgets, failure handling, run history | Yes | Yes | One department run on free models (before budgets were added) |
| Scheduled tasks, watches, trusted tasks | Yes | Yes | No (needs hosting for the timers) |
| Insights, Overview, people and department pages | Yes | Yes | Pages load on real data; detectors not yet run on it |
| Procedures and trackers | Yes | Yes | No (the one real attempt ran out of memory on a local model) |
| WhatsApp, Telegram, Slack, Teams as places to ask | Yes | Yes | No (need public URLs and bot credentials) |
| Voice notes | Yes | Yes | No (needs a working OpenAI key) |
| Sign-in, invitations, password reset, sessions | Yes | Yes | Yes, in a real browser (18 checks) |
| Single sign-on (OIDC, Google, Microsoft) | Yes | Partly (config and redirects) | No |
| Roles, departments, removing members, excluded conversations | Yes | Yes | Roles in a browser; the rest only in tests |
| Audit log, usage metering and plan limits, retention, company deletion | Yes | Yes | Audit and usage seen in the browser test |
| Job history, retries, stored webhooks, alerts, Health page | Yes | Yes | Health page loads; nothing has failed for real yet |
| Email delivery (briefs, invitations, resets) | Yes | Yes | No (needs a Resend key; links are shown instead) |
| Instant updates from sources (Gmail Pub/Sub, Outlook subscriptions, pasted addresses; polling stays as fallback) | Yes | Yes (fake APIs) | No (needs a public `ALRO_APP_URL`, and for Gmail a Pub/Sub topic) |
| Money owed: overdue invoices from Xero, QuickBooks, Stripe, Razorpay; reminders drafted on a cadence for approval; recovery measured | Yes | Yes (Razorpay faked end to end) | No |
| Leads: intake address (web form, IndiaMART, Meta, Zapier), reply drafted for approval, follow-ups at 2, 5, 10 days | Yes | Yes | Intake address and duplicate handling on the dev server; no real send |
| Customer assistant on WhatsApp: answers only from approved answers, hands off, STOP, staff reply | Yes | Yes | No (needs WhatsApp credentials and a public URL) |
| Quotes and invoices as numbered PDFs, sent as a link after approval | Yes | Yes | No |
| Expenses from receipt photos, GST fields, CSV export | Yes | Yes | CSV export on the dev server; photo reading not run on a real receipt |
| Deadlines with reminders, Indian filing presets, rollover | Yes | Yes | No |

## Not built

- **Billing.** Plans and limits exist; nothing charges anyone.
- **Automatic user provisioning (SCIM)** and a per-company SSO setup screen (SSO is set per deployment in the environment).
- **Model routing**: per-task quality requirements, automatic fallbacks beyond OpenRouter's, evaluation on each model change.
- **Instant updates from sources** (webhooks); everything is polled every 15 minutes.
- **ERP, HR and IT-service connectors** (SAP, NetSuite, Tally, Workday, ServiceNow).
- **Live WhatsApp groups** (Meta's API can't read them; exports only).
- **A content security policy header**, an outside security test, and compliance work (SOC 2, DPDP paperwork).
- **Prediction** (which deals will close, which invoices will go overdue). Insights today are rules over what was said, not forecasts.

## Known limits worth remembering

- An insight built from several conversations is visible to anyone who can see one of them, so those insights state only counts, names and dates.
- Facts and promises taken from a message that is later deleted at the source stay (only the message, its search index and tracker rows go).
- Edited messages are not updated; deletions are caught for Slack, Teams, Discord and Gmail's bin only.
- "Who said it" treats any non-member as the party the fact is about.
- Dismissing an insight dismisses it for everyone who could see it.
- The local development database is one shared session: run scripts while the dev server is idle.
