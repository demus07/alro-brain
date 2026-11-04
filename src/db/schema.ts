/**
 * ALRO memory schema.
 *
 * Five layers, all in one Postgres:
 *   0. Tenancy & identity  orgs, people, identities, connections
 *   1. Evidence log        threads, thread_members, messages, records, chunks
 *   2. Entity graph        entities, entity_aliases, edges (bi-temporal facts)
 *   3. Commitment ledger   commitments, commitment_events, notifications
 *   4. Agent tools         (queries over the tables above, no tables of their own)
 *   5. Consolidation       rollups
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
    /** Nango connection id. Tokens live in Nango, never here. */
    nangoConnectionId: text("nango_connection_id"),
    /** Workspace id, mailbox address, CRM instance URL, etc. */
    externalAccountId: text("external_account_id"),
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
