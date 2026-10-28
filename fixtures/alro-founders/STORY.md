# Story bible: two founders building ALRO (dummy test data)

All fixture files must follow this bible exactly. It is the ground truth for the
promise-extraction gold set. Everything is fictional.

## People (only these two ever take part in a conversation)

| | Rohan Kulkarni | Ananya Desai |
|---|---|---|
| Role | Co-founder & CEO: product, design partners, fundraising, legal, money | Co-founder & CTO: engineering, infra, data pipeline |
| Email | rohan@alro.ai | ananya@alro.ai |
| Phone (WhatsApp) | +91 98200 11223 | +91 98450 44556 |
| Slack user id / handle | U01ROHAN / rohan | U02ANANYA / ananya |
| Style | Energetic, optimistic, over-commits, writes short messages, uses some Hinglish on WhatsApp | Precise, dry humour, Hinglish on WhatsApp ("kal tak kar deti hoon"), longer technical messages |

Timezone: Asia/Kolkata (IST, +05:30). Year: 2026. The story runs from Tue 1 Sep to Mon 26 Oct 2026. "Today" is Tue 27 Oct 2026.

Third parties may be MENTIONED but never speak: design partners **Kirana Kart** (quick-commerce, contact "Neha"), **Finlo** (fintech, contact "Vikram"), **Brightdesk** (support SaaS, contact "Sara"); investor "Meghna from Tidewater Ventures"; a contractor candidate "Kabir" (frontend dev); vendors Neon, Vercel, Nango, Google (CASA review), Anthropic.

## What ALRO is (so the dialogue is technically right)

ALRO is a company brain: it ingests Slack, Gmail, WhatsApp, CRMs and meeting transcripts into Postgres (Neon + pgvector), builds an entity graph with time-stamped facts, tracks promises ("commitments") until they're kept, and answers questions with citations. Stack: Next.js on Vercel, Drizzle, Neon, Nango for connectors, AI SDK through Vercel AI Gateway, a cheap model to screen messages and a stronger one to extract. Row-level security makes sure people only see what they could see in the source tool. Google Gmail access needs a CASA security assessment. A "gold set" of hand-labelled messages measures extraction precision/recall.

## Facts that CHANGE over time (for the temporal graph)

- **Price**: Meeting 1 (Sep 1) they agree $49/user/month. Meeting 3 (Sep 29) changed to $39. Meeting 5 (Oct 22) final: $29/user/month for teams under 50, India pricing ₹1,999/user.
- **Teams connector**: in Phase 1 scope as of Meeting 2 (Sep 15); dropped from Phase 1 in Meeting 3 (Sep 29).
- **Design partner status**: Kirana Kart: call done Sep 18 → signed pilot Oct 8. Finlo: call Sep 21 → "cold, waiting on WhatsApp answer" (Sep 29 on). Brightdesk: call booked late (Sep 16) → demo scheduled Wed Oct 28.
- **Extraction cost**: estimate ~2.1 cents/message (Oct 13) → 0.7 cents/message after screening (Oct 20).
- **Screening model**: decided Haiku for screening, Sonnet for extraction (Meeting 4).

## Commitments (the gold set)

Status as of Tue 27 Oct 2026. "Made in" says which file family contains the promise; "Evidence" says where fulfilment/cancellation shows up. Each file family must contain the promise and/or evidence wording naturally (not copy-paste of this table) but clearly.

| ID | Made in (date) | Owner → to | Promise | Due | Outcome |
|---|---|---|---|---|---|
| C01 | Meeting 1 (Sep 1) | Ananya → Rohan | Postgres schema draft up as a PR | Fri Sep 4 | DONE Sep 4 — Slack #eng "schema PR is up" |
| C02 | Meeting 1 (Sep 1) | Rohan → Ananya | Book calls with all three design partners | Sat Sep 12 | DONE LATE Sep 16 — WhatsApp 1:1 "all three booked finally" (on Sep 11 he says only two booked) |
| C03 | Meeting 1 (Sep 1) | Ananya → Rohan | Start Google OAuth verification / CASA paperwork | this week (soft, Sun Sep 6) | DONE Sep 7 — Slack #eng "submitted the CASA application" |
| C04 | Meeting 1 (Sep 1) | Rohan → Ananya | Write landing-page copy / one-pager | Wed Sep 9 | RESCHEDULED on WhatsApp 1:1 Sep 9 to Mon Sep 14; DONE Sep 14 — Email #1 with the copy |
| C05 | Slack #eng (Sep 3) | Ananya → Rohan | Set up Neon + Vercel preview environments | tomorrow, Fri Sep 4 | DONE Sep 4 — Slack #eng |
| C06 | WhatsApp 1:1 (Sep 5) | Rohan → Ananya | Send the Nango pricing comparison | tonight, Sat Sep 5 | DONE Sep 5 23:10 — WhatsApp 1:1 (he pastes the summary) |
| C07 | Meeting 2 (Sep 15) | Ananya → Rohan | Write the row-level-security tests before any real data | Sat Sep 19 | DONE Sep 18 — Slack #eng |
| C08 | Meeting 2 (Sep 15) | Rohan → Ananya | Draft privacy policy + DPA template | Wed Sep 30 | MISSED; in Meeting 4 (Oct 13) re-promised for Sat Oct 31 → OPEN, not yet due |
| C09 | Meeting 2 (Sep 15) | Ananya → Rohan | Slack export importer working | Sat Sep 26 | DONE LATE Tue Sep 29 — Slack #eng |
| C10 | Slack #product (Sep 17) | Rohan → Ananya | Share Kirana Kart call notes in #product after tomorrow's call | Fri Sep 18 | DONE Sep 18 — Slack #product |
| C11 | WhatsApp group "ALRO Build" (Sep 20) | Ananya → Rohan | WhatsApp export parser ("kal tak") | Mon Sep 21 | DONE LATE Tue Sep 22 — Slack #eng |
| C12 | Meeting 3 (Sep 29) | Rohan → Ananya | Send first pitch-deck draft | Sun Oct 4 | DONE Oct 4 — Email #2 |
| C13 | Meeting 3 (Sep 29) | Ananya → Rohan | Cost-per-message estimate for extraction | next meeting, Tue Oct 13 | DONE Oct 13 — Meeting 4 (she presents ~2.1 cents/message) |
| C14 | Meeting 3 (Sep 29) | Rohan → Finlo (Vikram), told to Ananya | Reply to Finlo about whether WhatsApp personal chats are supported | tomorrow, Wed Sep 30 | NO EVIDENCE → OVERDUE (Ananya asks about it on WhatsApp Oct 9; Rohan says "haan haan, karta hoon" — not proof) |
| C15 | WhatsApp group "ALRO Money & Admin" (Oct 2) | Rohan → Ananya | Transfer money to top up the company card for the Vercel/Neon bills | Mon Oct 5 | DONE Oct 5 — same WhatsApp group "done, ₹40k transferred" |
| C16 | Email #3 (Oct 6, Ananya → Rohan) | Ananya → Rohan | Eval harness running on the gold set | Fri Oct 9 | DONE Oct 9 — Slack #eng |
| C17 | Slack #eng (Oct 7) | Rohan → Ananya | Label 50 gold-set examples | weekend, Sun Oct 11 | MISSED (Meeting 4: only 30 done); re-promised "remaining 20 by Wednesday" (Oct 14); DONE Oct 15 — Slack #eng |
| C18 | Meeting 4 (Oct 13) | Ananya → Rohan | Add the cheap screening step and get extraction under 1 cent/message | Tue Oct 20 | DONE Oct 20 — Slack #eng (0.7 cents) |
| C19 | Meeting 4 (Oct 13) | Rohan → Ananya | Send the angel/investor target list | Fri Oct 16 | NO EVIDENCE → OVERDUE |
| C20 | WhatsApp 1:1 (Oct 15) | Ananya → Rohan | Review Rohan's deck comments tonight | Thu Oct 15 | DONE Oct 15 23:40 — WhatsApp 1:1 |
| C21 | Email #4 (Oct 17, Rohan → Ananya) | Rohan → Ananya | Book the Brightdesk demo for the week of Oct 26 and send the invite | soft, Fri Oct 23 | DONE Oct 21 — WhatsApp group "ALRO Build" ("Brightdesk demo booked for Wed 28th, invite sent") |
| C22 | Meeting 5 (Oct 22) | Ananya → Rohan | Demo environment seeded with Brightdesk sample data | Mon Oct 26 | PARTIAL Oct 26 — Slack DM: seeded everything except Gmail (CASA still pending) → still OPEN |
| C23 | Meeting 5 (Oct 22) | Rohan → Ananya | Write the demo script and send it | Sat Oct 24 | DONE Oct 24 — Email #5 |
| C24 | Meeting 5 (Oct 22) | Rohan → Ananya | Follow up with Google on CASA status | tomorrow, Fri Oct 23 | NO EVIDENCE → OVERDUE |
| C25 | Slack DM (Oct 23) | Ananya → Rohan | Rotate the Slack signing secret before the demo | before Wed Oct 28 | OPEN, not yet due |
| C26 | WhatsApp 1:1 (Oct 24) | Rohan → Ananya | Send Kabir (contractor) the offer letter | Mon Oct 26 | NO EVIDENCE → OVERDUE |
| C27 | Meeting 2 (Sep 15) | Ananya → Rohan | Build the Microsoft Teams connector | mid-Oct (soft, Thu Oct 15) | CANCELLED Sep 29 — Meeting 3 drops Teams from Phase 1 |
| C28 | Slack #product (Oct 1) | Ananya → Rohan | Fix the landing-page mobile nav bug (after Rohan asks) | today, Thu Oct 1 | DONE Oct 1 — Slack #product |

## Distractors: things that must NOT be extracted as commitments

Each file family should contain several of these naturally:
- Vague intentions: "we should grab coffee with the Finlo folks sometime", "someday I'll redo the logo".
- Conditionals: "if we raise, I'll hire a designer", "if CASA drags, maybe we ship Outlook first".
- Questions/requests not accepted: "can you send me the Neon invoice?" with no yes.
- Past tense reports: "I sent the invoice yesterday".
- Jokes/hyperbole: "I'll never touch Jira again lol", "I will literally sleep for a week after the demo".
- Third-party promises: "Neha said Kirana Kart will share sample data by Friday" (owner is not Rohan/Ananya).
- Generic plans without an owner: "we need to look at Outlook at some point".
