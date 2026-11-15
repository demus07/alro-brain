---
name: build-connector
description: Add a new source to ALRO (a synced connector, live lookups, or both). Use when asked to connect a new app such as Asana, Zoho, Salesforce, Intercom or Zoom.
argument-hint: <app name, e.g. "Zoho CRM">
user-invocable: true
---

You are adding a source to ALRO. A source is one file in `src/connectors/` that exports a `Provider`
(`src/connectors/provider.ts`). ALRO calls the app directly with a credential the member gives it, stored
encrypted; there is no middleman service.

# Decide the shape first

- **Synced** (`sync`): where people talk or write (chat, mail, tickets, docs, transcripts). ALRO reads it
  into memory so promises, decisions and facts are found and cited.
- **Live** (`tools`): where current numbers and records live (CRM, sheets, accounting, the store). The agent
  queries it at the moment someone asks; nothing is stored.
- If the app publishes an official MCP server, prefer adding it under Settings → Live tools over writing
  `tools` by hand. Write `tools` only when there is no usable server.

# Research the app (write it down before coding)

Use the app's current API docs, and the open-source references if present (`getomnico/omni` connectors,
`pipeshub-ai/pipeshub-ai` sources; Apache-2.0: read for endpoints and field names, write your own code):

1. **Credential**: API key / personal token / Basic (→ `auth.kind: "token"`), or Google / Microsoft sign-in
   (→ `auth.kind: "oauth"`). Ask for read-only access. Any other OAuth app needs an entry in
   `src/connectors/oauth.ts` first.
2. **Identify call**: one cheap request that proves the credential and returns a stable account id and name.
3. **What's new**: an updated-since filter, cursor or incremental export. Pagination and per-page limits.
4. **Who can see what**: is an item visible to the whole workspace, or restricted? Can you read who has
   access? Never invent membership: if an item is restricted and you can't read its audience, skip it.
5. **Rate limits** and how the API signals them (429 and 5xx are retried for you by `withRetries`).

# Write `src/connectors/<id>.ts`

- `id` is lowercase with dashes and matches an entry you add to `src/lib/sources.ts` (label and badge).
- `scope`: `"org"` when one connection covers a workspace; `"personal"` for one person's mailbox, calendar
  or account (the connecting person is added to every thread automatically).
- `auth`:
  - token: `fields`, a one or two sentence `setup` a non-technical founder can follow, `docsUrl`, and
    `api: (c) => httpApi({ baseUrl, headers: bearer(c.token) })` (or `basic(...)`).
  - sign-in: `{ kind: "oauth", app, scopes, baseUrl, hosts }`; the framework supplies a fresh token.
- All HTTP goes through the `Api` you are given. Never call `fetch`. `httpApi` only talks to `baseUrl`'s
  host and any `hosts` you list, over https.
- `identify(api, credentials)`: return `{ accountId, label }`; throw a plain-English `Error` when refused.
- `sync(api, cursor, ctx)` returns `{ people, threads, messages, cursor }` (`src/ingest/types.ts`):
  - First sync: 90 days back. Later: only what changed since the cursor, with a small overlap.
  - Cap each sync (about 500 items) so it finishes in minutes; the next one continues.
  - Chat → thread `kind: "channel" | "dm" | "group_dm"`, messages `kind: "chat"`.
    Mail → fetch raw RFC 822 and use `emailsToBatch`. Meetings → `kind: "meeting"` with `"transcript"` turns.
    Issues, tickets, tasks, pages → thread `kind: "doc"`; the body is one `kind: "note"` message with
    `externalId: "<id>@<updatedAt>"` listed in `versions` (an edit replaces the old text); comments are
    `kind: "chat"` messages.
  - People: `key: "<id>:<userId>"`, with a lower-cased `email` whenever the API gives one. Emails are what
    link one person across sources.
  - `visibility: "org"` only for things everyone in the workspace can see; otherwise `"members"` with
    `memberKeys`.
- Calendar-like sources return `events` instead of threads (`src/connectors/google.ts`).
- `tools(api, ctx)`: AI SDK `tool()`s named `<id>_<verb>`, read-only, with descriptions that say when to use
  them and to name the system in the answer. Keep results small. `ctx` has the account id and credentials.
- `actions`: writes (send, post, add a note or task), keyed `<id>_<verb>`, implementing `ActionDef`
  (`provider.ts`): a zod `input`, `audience` (external reaches a client/vendor/public), a one-line `summary`,
  `body`/`withBody` for text the approver may edit, and `run`. They are only ever run after a person approves
  (`src/approvals/`), so `run` must do exactly one write and never retry. Ask for the narrowest write scope.
- Keys traded for short-lived tokens (server-to-server apps, client credentials): `postForm` + `mintedBearer`
  from `api.ts`. A one-time code traded for a refresh token at connect time: `auth.exchange`.
- Sign-in with an app other than Google/Microsoft: add it to `APPS` in `oauth.ts` first (Xero and QuickBooks are
  there); callback parameters the API needs later (QuickBooks' `realmId`) go in `callbackParams`.

Shortest complete examples: `slack.ts` (chat, plus a post action), `notion.ts` (versioned docs), `gmail.ts`
(mail, plus a send action), `google.ts` (calendar and live lookups), `hubspot.ts` (live only, plus note/task
actions), `zoom.ts` (minted tokens), `zoho-crm.ts` (`exchange`), `xero.ts` (another sign-in app).

# Wire it in

1. Add the provider to `ALL` in `src/connectors/registry.ts`.
2. Add its label and badge to `SOURCES` in `src/lib/sources.ts`.
3. Nothing else: Settings shows the connect form, the 15-minute sync picks it up, and the agent gets its tools.

# Test `src/connectors/<id>.test.ts`

Use the `fakeApi(routes)` helper from `connectors.test.ts`. At least: the first sync maps items, people and
threads and returns a cursor; a later sync asks only for what's new; `identify` names the account; a
restricted item is skipped or gets the right members.

Run `npx vitest run src/connectors/<id>.test.ts`, `npx tsc --noEmit` and `npx eslint src/connectors/<id>.*`.

# Say what isn't proven

A fake API proves the mapping, not the app. In your report list every endpoint or field you could not
confirm in the docs, and say plainly that the connector has not run against a real account until someone
connects one in Settings and checks the first sync on the Health page.
