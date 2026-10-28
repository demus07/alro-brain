# ALRO founders dataset (dummy)

Two fictional founders, Rohan Kulkarni (CEO) and Ananya Desai (CTO), building ALRO between 1 Sep and 26 Oct 2026. [STORY.md](STORY.md) is the ground truth: people, facts that change over time, and the 28 commitments (C01–C28) with their outcomes.

| Source | Files | Size |
|---|---|---|
| Slack export | `slack/` and `slack-export.zip` | #general, #eng, #product + 1 DM, 184 messages |
| Email | `emails/*.eml` | 5 emails from Rohan's mailbox |
| Meetings | `meetings/*.vtt` | 5 Google Meet transcripts, 82–92 cues each |
| WhatsApp | `whatsapp/` | 1:1 (191, Android), "ALRO Build 🚀" group (168, Android), "ALRO Money & Admin" group (110, iOS) |

`labels/*.json` is the gold set: every place a commitment is made, rescheduled, partly done, done or cancelled, plus distractors that look like promises but aren't (vague, conditional, jokes, third-party, past tense, unaccepted requests, no owner). Quotes are exact substrings of the ingested message text; `src/ingest/fixtures.test.ts` checks this.

Load into the database in `DATABASE_URL` with `npm run fixtures:load`.
