/**
 * ALRO memory schema.
 *
 * Five layers, all in one Postgres:
 *   0. Tenancy & identity  orgs, people, identities, connections, secrets
 *   1. Evidence log        threads, thread_members, messages, records, chunks
 *   2. Entity graph        entities, entity_aliases, edges (bi-temporal facts)
 *   3. Commitment ledger   commitments, commitment_events, notifications
 *   4. Agent tools         (queries over the tables above, no tables of their own)
 *   5. Consolidation       rollups
 *   6. Working day         events, meeting_notes, profiles, routines, live tools, messaging channels
 *   +  Ops                 sync_runs, llm_runs
 *
 * Access control
 * --------------
 * Every row that carries content has an `acl` text[] of principals:
 *   'org'          everyone in the org (public channels, CRM data)
 *   't:<threadId>' members of that thread (private channels, DMs, a mailbox)
 *   'p:<personId>' one specific person
 * A user's principals are 'org', their own 'p:<id>' and a 't:<id>' for every
 * thread they belong to. A row is visible when the two arrays overlap.
 * Derived rows (entities, edges, commitments, rollups) carry the union of the
 * ACLs of their evidence, so they are visible if any supporting source is.
 * Row-level security enforces this for the `alro_app` role (see the
 * 0002_access_control migration and src/db/scope.ts).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  halfvec,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMS = 1024;

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" });
const acl = () =>
  text("acl")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// 0. Tenancy & identity
// ---------------------------------------------------------------------------

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
});

/** A human. One person can have many identities across tools. */
export const people = pgTable(
  "people",
  {
    id: id(),
    orgId: orgId(),
    displayName: text("display_name").notNull(),
    primaryEmail: text("primary_email"),
    timezone: text("timezone"),
    /** True for people who sign in to ALRO, false for customers, vendors, etc. */
    isMember: boolean("is_member").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("people_org_idx").on(t.orgId)],
);

/** An account or handle in some tool: a Slack user, an email address, a phone number, a CRM contact. */
export const identities = pgTable(
  "identities",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** slack | microsoft | google | whatsapp | zoho | salesforce | hubspot | email | phone | ... */
    provider: text("provider").notNull(),
    /** The provider's id for this identity, or a normalised email / E.164 phone. */
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    phone: text("phone"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("identities_provider_external_uq").on(
      t.orgId,
      t.provider,
      t.externalId,
    ),
    index("identities_person_idx").on(t.personId),
    index("identities_email_idx").on(t.orgId, t.email),
    index("identities_phone_idx").on(t.orgId, t.phone),
  ],
);

export const connectionScope = pgEnum("connection_scope", ["org", "personal"]);
export const connectionStatus = pgEnum("connection_status", [
  "active",
  "syncing",
  "error",
  "revoked",
]);

/** One authorised link to a source: a Slack workspace, someone's Gmail, a Salesforce org, an upload. */
export const connections = pgTable(
  "connections",
  {
    id: id(),
    orgId: orgId(),
    provider: text("provider").notNull(),
    scope: connectionScope("scope").notNull(),
    /** Who connected it. Required for personal scope. */
    ownerPersonId: uuid("owner_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** Workspace id, mailbox address, CRM instance URL, etc. Tokens live in `secrets`, never here. */
    externalAccountId: text("external_account_id"),
    /** How the account is shown: workspace name, mailbox, site. */
    label: text("label"),
    /** Data region where the provider has one (Zoho .com/.in/.eu, Salesforce instance). */
    region: text("region"),
    status: connectionStatus("status").notNull().default("active"),
    /** Per-connector sync cursors, e.g. Gmail historyId or Slack channel cursors. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connections_org_idx").on(t.orgId)],
);

/**
 * Encrypted credentials: connector tokens and live-tool sign-ins (AES-256-GCM, key in
 * ALRO_SECRET_KEY; see src/lib/secrets.ts). The alro_app role cannot read this table.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: id(),
    orgId: orgId(),
    /** connection | mcp */
    kind: text("kind").notNull(),
    /** The connection or live-tool server the secret belongs to. */
    refId: uuid("ref_id").notNull(),
    data: text("data").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secrets_ref_uq").on(t.kind, t.refId)],
);

// ---------------------------------------------------------------------------
// 1. Evidence log
// ---------------------------------------------------------------------------

export const threadKind = pgEnum("thread_kind", [
  "channel",
  "dm",
  "group_dm",
  "email",
  "whatsapp",
  "meeting",
  "crm_timeline",
  "doc",
  "upload",
]);
export const threadVisibility = pgEnum("thread_visibility", ["org", "members"]);

/** Any container of messages: a channel, a DM, an email thread, a WhatsApp chat, a meeting, a CRM record's timeline. */
export const threads = pgTable(
  "threads",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    kind: threadKind("kind").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title"),
    url: text("url"),
    /** 'org' for public channels and shared CRM data; 'members' for everything private. */
    visibility: threadVisibility("visibility").notNull(),
    acl: acl(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("threads_connection_external_uq").on(
      t.connectionId,
      t.externalId,
    ),
    index("threads_org_idx").on(t.orgId),
    index("threads_acl_idx").using("gin", t.acl),
  ],
);

/** Who can see a members-only thread. Mirrors the source (channel members, mailbox owner, chat participants). */
export const threadMembers = pgTable(
  "thread_members",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    orgId: orgId(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.personId] }),
    index("thread_members_person_idx").on(t.personId),
  ],
);

export const messageKind = pgEnum("message_kind", [
  "chat",
  "email",
  "transcript",
  "note",
  "record_change",
  "calendar_event",
]);
export const screenResult = pgEnum("screen_result", ["skip", "extract"]);

/**
 * The immutable evidence log. Every chat message, email, transcript segment and
 * CRM change lands here exactly once. Derived memory points back to these rows.
 */
export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: orgId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: messageKind("kind").notNull(),
    authorIdentityId: uuid("author_identity_id").references(
      () => identities.id,
      { onDelete: "set null" },
    ),
    authorPersonId: uuid("author_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** Other people addressed: email to/cc, @mentions, meeting attendees. */
    recipientPersonIds: uuid("recipient_person_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /** Parent message in the source (Slack thread_ts, In-Reply-To). */
    replyToExternalId: text("reply_to_external_id"),
    subject: text("subject"),
    text: text("text").notNull(),
    attachments: jsonb("attachments").$type<
      { name: string; mimeType?: string; url?: string; size?: number }[]
    >(),
    url: text("url"),
    raw: jsonb("raw"),
    acl: acl(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Pipeline state: cheap screen first, then extraction for the few that need it. */
    screenResult: screenResult("screen_result"),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_connection_external_uq").on(
      t.connectionId,
      t.externalId,
    ),
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt),
    index("messages_org_sent_idx").on(t.orgId, t.sentAt),
    index("messages_author_idx").on(t.authorPersonId, t.sentAt),
    index("messages_acl_idx").using("gin", t.acl),
    index("messages_pending_idx")
      .on(t.orgId, t.ingestedAt)
      .where(sql`${t.extractedAt} is null`),
  ],
);

/** Current state of a structured object in a CRM or similar: deal, account, contact, task, ticket. Changes also land in `messages` as record_change. */
export const records = pgTable(
  "records",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** Timeline thread holding this record's change history. */
    threadId: uuid("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    /** deal | account | contact | lead | task | note | ticket | ... */
    type: text("type").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    url: text("url"),
    acl: acl(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("records_connection_external_uq").on(
      t.connectionId,
      t.externalId,
    ),
    index("records_org_type_idx").on(t.orgId, t.type),
    index("records_acl_idx").using("gin", t.acl),
  ],
);

/** Searchable windows over messages (one thread, or ~15 consecutive messages). */
export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    orgId: orgId(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    messageIds: uuid("message_ids").array().notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    text: text("text").notNull(),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMS }),
    /** When the graph stage read this chunk; null means it's waiting. */
    graphedAt: timestamp("graphed_at", { withTimezone: true }),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', text)`),
    acl: acl(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chunks_thread_idx").on(t.threadId, t.startAt),
    index("chunks_acl_idx").using("gin", t.acl),
    index("chunks_tsv_idx").using("gin", t.tsv),
    index("chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("halfvec_cosine_ops"),
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2. Entity graph (bi-temporal, after Graphiti / the Zep paper)
// ---------------------------------------------------------------------------

export const entityType = pgEnum("entity_type", [
  "person",
  "company",
  "deal",
  "project",
  "product",
  "topic",
  "other",
]);

export const entities = pgTable(
  "entities",
  {
    id: id(),
    orgId: orgId(),
    type: entityType("type").notNull(),
    name: text("name").notNull(),
    summary: text("summary"),
    personId: uuid("person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    recordId: uuid("record_id").references(() => records.id, {
      onDelete: "set null",
    }),
    nameEmbedding: halfvec("name_embedding", { dimensions: EMBEDDING_DIMS }),
    /** Hidden by a person (noise, or not worth tracking): left out of the graph and search. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    acl: acl(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("entities_org_type_idx").on(t.orgId, t.type),
    index("entities_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("entities_acl_idx").using("gin", t.acl),
    index("entities_person_idx").on(t.personId),
  ],
);

/** Other names an entity goes by ("Acme", "Acme Corp", "acme.com"), for resolution. */
export const entityAliases = pgTable(
  "entity_aliases",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    orgId: orgId(),
    alias: text("alias").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.alias] }),
    index("entity_aliases_trgm_idx").using("gin", t.alias.op("gin_trgm_ops")),
  ],
);

/**
 * Where an entity comes up: one row per (entity, chunk), with what that
 * conversation says about it. Graph search goes entity → mentions → chunks,
 * so it can answer from conversations that never name the query's words.
 * Visible only when the chunk is (row-level security via chunks).
 */
export const entityMentions = pgTable(
  "entity_mentions",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    orgId: orgId(),
    description: text("description"),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.chunkId] }), index("entity_mentions_chunk_idx").on(t.chunkId)],
);

/**
 * A fact linking two entities, e.g. (Priya) -[works_at]-> (Acme).
 * Two timelines, as in the Zep paper:
 *   valid_from / valid_to      when the fact was true in the world
 *   created_at / expired_at    when ALRO believed it
 * Facts are never edited or deleted. A contradiction sets the old edge's
 * valid_to / expired_at and points invalidated_by at the new edge.
 */
export const edges = pgTable(
  "edges",
  {
    id: id(),
    orgId: orgId(),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    /** Snake-case relation, e.g. works_at, owns_deal, decided, blocked_by. */
    relation: text("relation").notNull(),
    /** The fact as a sentence: "Priya is the buyer for Acme's renewal." */
    fact: text("fact").notNull(),
    factEmbedding: halfvec("fact_embedding", { dimensions: EMBEDDING_DIMS }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: createdAt(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    invalidatedBy: uuid("invalidated_by"),
    sourceMessageIds: uuid("source_message_ids").array().notNull(),
    /** The chunk the graph stage read this fact from (null for facts from commitment extraction). */
    sourceChunkId: uuid("source_chunk_id").references(() => chunks.id, { onDelete: "set null" }),
    confidence: real("confidence"),
    acl: acl(),
  },
  (t) => [
    index("edges_source_idx").on(t.sourceEntityId, t.relation),
    index("edges_target_idx").on(t.targetEntityId, t.relation),
    index("edges_current_idx")
      .on(t.orgId, t.relation)
      .where(sql`${t.expiredAt} is null`),
    index("edges_acl_idx").using("gin", t.acl),
    index("edges_fact_embedding_idx").using(
      "hnsw",
      t.factEmbedding.op("halfvec_cosine_ops"),
    ),
  ],
);

// ---------------------------------------------------------------------------
// 3. Commitment ledger
// ---------------------------------------------------------------------------

export const commitmentStatus = pgEnum("commitment_status", [
  "open",
  "due_soon",
  "overdue",
  "done",
  "cancelled",
  "dismissed",
]);
export const dueKind = pgEnum("due_kind", ["hard", "soft", "none"]);
export const userVerdict = pgEnum("user_verdict", ["confirmed", "rejected"]);

export const commitments = pgTable(
  "commitments",
  {
    id: id(),
    orgId: orgId(),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /** Who it was promised to. Free text when we can't resolve them yet. */
    counterpartyPersonId: uuid("counterparty_person_id").references(
      () => people.id,
      { onDelete: "set null" },
    ),
    counterpartyText: text("counterparty_text"),
    /** The account, deal or project it belongs to, when known. */
    relatedEntityId: uuid("related_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    details: text("details"),
    /** The exact words, verified to appear in the source message. */
    quote: text("quote").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    dueKind: dueKind("due_kind").notNull().default("none"),
    /** The original wording, e.g. "by Friday", "end of month". */
    dueText: text("due_text"),
    status: commitmentStatus("status").notNull().default("open"),
    confidence: real("confidence").notNull(),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    evidenceMessageIds: uuid("evidence_message_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    fulfilledByMessageId: uuid("fulfilled_by_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    userVerdict: userVerdict("user_verdict"),
    verdictByPersonId: uuid("verdict_by_person_id").references(
      () => people.id,
      { onDelete: "set null" },
    ),
    /** Which model and prompt produced it, for evals. */
    extractor: text("extractor"),
    acl: acl(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("commitments_owner_status_idx").on(
      t.orgId,
      t.ownerPersonId,
      t.status,
    ),
    index("commitments_due_idx")
      .on(t.orgId, t.dueAt)
      .where(sql`${t.status} in ('open', 'due_soon', 'overdue')`),
    index("commitments_related_idx").on(t.relatedEntityId),
    index("commitments_source_idx").on(t.sourceMessageId),
    index("commitments_acl_idx").using("gin", t.acl),
  ],
);

export const commitmentEventType = pgEnum("commitment_event_type", [
  "created",
  "status_changed",
  "due_changed",
  "evidence_added",
  "merged",
  "verdict",
  "reminded",
]);

/** Append-only history of a commitment. Every status change cites its evidence. */
export const commitmentEvents = pgTable(
  "commitment_events",
  {
    id: id(),
    orgId: orgId(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitments.id, { onDelete: "cascade" }),
    type: commitmentEventType("type").notNull(),
    fromStatus: commitmentStatus("from_status"),
    toStatus: commitmentStatus("to_status"),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    /** 'system', 'watcher', or 'person:<id>'. */
    actor: text("actor").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("commitment_events_commitment_idx").on(t.commitmentId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgId(),
    commitmentId: uuid("commitment_id").references(() => commitments.id, {
      onDelete: "cascade",
    }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** due_soon | overdue | overdue_followup | digest:<yyyy-mm-dd> */
    kind: text("kind").notNull(),
    /** slack | email | teams | in_app */
    channel: text("channel").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Never send the same reminder twice, even if the watcher reruns.
    unique("notifications_once_uq")
      .on(t.commitmentId, t.personId, t.kind)
      .nullsNotDistinct(),
  ],
);

// ---------------------------------------------------------------------------
// 5. Consolidation
// ---------------------------------------------------------------------------

/** Periodic summaries per entity, thread or week, for "big picture" questions. */
export const rollups = pgTable(
  "rollups",
  {
    id: id(),
    orgId: orgId(),
    /** entity | thread | org_week | person_week */
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    summary: text("summary").notNull(),
    embedding: halfvec("embedding", { dimensions: EMBEDDING_DIMS }),
    sourceMessageIds: uuid("source_message_ids").array().notNull(),
    acl: acl(),
    createdAt: createdAt(),
  },
  (t) => [
    index("rollups_scope_idx").on(t.orgId, t.scopeType, t.scopeId, t.periodEnd),
    index("rollups_acl_idx").using("gin", t.acl),
  ],
);

// ---------------------------------------------------------------------------
// 6. Working day: calendar, meeting notes, the personal brain, scheduled tasks,
//    live tools and messaging channels
// ---------------------------------------------------------------------------

export interface EventAttendee {
  email?: string;
  name?: string;
  /** Set when the attendee is someone ALRO already knows. */
  personId?: string;
}

/** A calendar event on one person's calendar. Private to them (acl 'p:<owner>'). */
export const events = pgTable(
  "events",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    ownerPersonId: uuid("owner_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    url: text("url"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    organizer: text("organizer"),
    attendees: jsonb("attendees").$type<EventAttendee[]>().notNull().default(sql`'[]'::jsonb`),
    cancelled: boolean("cancelled").notNull().default(false),
    acl: acl(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("events_connection_external_uq").on(t.connectionId, t.externalId),
    index("events_owner_start_idx").on(t.ownerPersonId, t.startsAt),
    index("events_acl_idx").using("gin", t.acl),
  ],
);

/** What a meeting came to: written once per meeting thread, from its transcript. Visible to whoever can see the transcript. */
export const meetingNotes = pgTable(
  "meeting_notes",
  {
    id: id(),
    orgId: orgId(),
    threadId: uuid("thread_id")
      .notNull()
      .unique()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** Markdown: what was discussed, decisions, who owes what by when. */
    summary: text("summary").notNull(),
    /** A follow-up email to the attendees, ready to edit and send. */
    followUp: text("follow_up"),
    acl: acl(),
    createdAt: createdAt(),
  },
  (t) => [index("meeting_notes_acl_idx").using("gin", t.acl)],
);

/** The personal brain: how one member writes and works. Only they can read it. */
export const profiles = pgTable("profiles", {
  personId: uuid("person_id")
    .primaryKey()
    .references(() => people.id, { onDelete: "cascade" }),
  orgId: orgId(),
  /** How they write, learned from their own messages. */
  style: text("style"),
  styleAt: timestamp("style_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** One thing ALRO knows about a member: a goal, a preference, how they decide. */
export const profileNotes = pgTable(
  "profile_notes",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** goal | preference | decision | about */
    category: text("category").notNull(),
    text: text("text").notNull(),
    /** chat | interview | manual */
    source: text("source").notNull().default("chat"),
    createdAt: createdAt(),
  },
  (t) => [index("profile_notes_person_idx").on(t.personId, t.createdAt)],
);

/** When a scheduled task runs. Times are local to the org's time zone. */
export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string };

/** A task the agent does on a schedule for one member, with their access: a Monday report, "have this ready by 5am". */
export const routines = pgTable(
  "routines",
  {
    id: id(),
    orgId: orgId(),
    ownerPersonId: uuid("owner_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** What to do, in the owner's words. */
    instruction: text("instruction").notNull(),
    schedule: jsonb("schedule").$type<Schedule>().notNull(),
    /** Null once a one-off has run, or while switched off. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("routines_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`), index("routines_owner_idx").on(t.ownerPersonId)],
);

export const routineRuns = pgTable(
  "routine_runs",
  {
    id: id(),
    orgId: orgId(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** running | ok | error */
    status: text("status").notNull().default("running"),
    output: text("output"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("routine_runs_routine_idx").on(t.routineId, t.startedAt)],
);

export interface LiveToolInfo {
  name: string;
  description?: string;
  /** What the server says: true reads only, false changes things, null when it doesn't say. */
  readOnly: boolean | null;
  enabled: boolean;
}

/** A live-tool server (MCP): the agent queries the app at the moment someone asks, nothing is stored. */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: id(),
    orgId: orgId(),
    scope: connectionScope("scope").notNull(),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** none | bearer | oauth */
    authKind: text("auth_kind").notNull().default("none"),
    /** active | needs_auth | error */
    status: text("status").notNull().default("active"),
    tools: jsonb("tools").$type<LiveToolInfo[]>().notNull().default(sql`'[]'::jsonb`),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("mcp_servers_org_idx").on(t.orgId)],
);

/** A member's account in a messaging app, proven with a one-time code, so the agent knows who is asking. */
export const channelLinks = pgTable(
  "channel_links",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    /** whatsapp | telegram | slack */
    channel: text("channel").notNull(),
    /** Phone number, Telegram chat id, Slack user id. */
    externalUserId: text("external_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("channel_links_user_uq").on(t.channel, t.externalUserId), index("channel_links_person_idx").on(t.personId)],
);

/** Short-lived codes a member sends from the messaging app to link it. */
export const channelLinkCodes = pgTable("channel_link_codes", {
  code: text("code").primaryKey(),
  orgId: orgId(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** The conversation with the agent in a messaging app, kept so follow-up questions have context. */
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    /** user | assistant */
    role: text("role").notNull(),
    text: text("text").notNull(),
    /** The app's id for an incoming message, so a redelivered webhook is answered once. */
    externalId: text("external_id"),
    createdAt: createdAt(),
  },
  (t) => [index("channel_messages_person_idx").on(t.personId, t.channel, t.createdAt), uniqueIndex("channel_messages_external_uq").on(t.channel, t.externalId)],
);

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** backfill | incremental | webhook | upload */
    kind: text("kind").notNull(),
    status: text("status").notNull().default("running"),
    counts: jsonb("counts").$type<Record<string, number>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("sync_runs_connection_idx").on(t.connectionId, t.startedAt)],
);

/** At most one pipeline run per org at a time, across all instances. A crashed run's lease simply expires. */
export const pipelineLeases = pgTable("pipeline_leases", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Every model call, so cost per org and per pipeline stage is visible. */
export const llmRuns = pgTable(
  "llm_runs",
  {
    id: id(),
    orgId: orgId(),
    /** screen | extract | fulfil | embed | answer | rollup */
    stage: text("stage").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    messageIds: uuid("message_ids").array(),
    createdAt: createdAt(),
  },
  (t) => [index("llm_runs_org_stage_idx").on(t.orgId, t.stage, t.createdAt)],
);

/** One run of the answer-quality eval: real questions, graded answers, and what they cost. */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: id(),
    orgId: orgId(),
    /** Model per stage when the run happened. */
    models: jsonb("models").$type<Record<string, string>>().notNull(),
    cases: integer("cases").notNull(),
    /** 0 to 1: share of expected facts present and supported, unanswerables declined. */
    score: real("score").notNull(),
    /** Answers whose citations all pointed at real sources, 0 to 1. */
    citationRate: real("citation_rate").notNull(),
    costUsd: real("cost_usd").notNull(),
    avgSeconds: real("avg_seconds").notNull(),
    details: jsonb("details").$type<unknown[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("eval_runs_org_idx").on(t.orgId, t.createdAt)],
);
