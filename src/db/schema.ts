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
 *   7. Doing the work      approvals, team_agents, team_runs, procedures, trackers, tracker_rows, insights
 *   8. Platform            credentials, sessions, invitations, rate_limits, audit_log, usage_daily
 *   9. Business desk       receivables, leads, faq_entries, customer_chats, customer_messages, documents, expenses, deadlines
 *   +  Ops                 sync_runs, llm_runs, job_runs, dead_letters, webhook_events
 *
 * Access control
 * --------------
 * Every row that carries content has an `acl` text[] of principals:
 *   'org'          everyone in the org (public channels, CRM data)
 *   'd:<dept>'     everyone in one department (a team source limited to that department)
 *   't:<threadId>' members of that thread (private channels, DMs, a mailbox)
 *   'p:<personId>' one specific person
 * A user's principals are 'org', their department's 'd:<dept>', their own 'p:<id>'
 * and a 't:<id>' for every thread they belong to. A row is visible when the two arrays overlap.
 * Derived rows (entities, edges, commitments, rollups) carry the union of the
 * ACLs of their evidence, so they are visible if any supporting source is.
 * Row-level security enforces this for the `alro_app` role (see the
 * 0002_access_control migration and src/db/scope.ts).
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  customType,
  date,
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

/** Per-company choices an admin makes. Everything is optional; defaults live in src/platform. */
export interface OrgSettings {
  /** Messages older than this many days are deleted, with what was derived only from them. Unset keeps everything. */
  retentionDays?: number;
  /** A proposal nobody decides is dropped after this many days (default 7). */
  approvalExpiryDays?: number;
  /** Setup steps finished or skipped in the welcome flow. */
  onboarding?: { done?: string[]; finishedAt?: string };
  /** Per-plan limits an operator raised or lowered for this company. */
  limits?: Partial<Record<string, number>>;
  /** The business desk: how chasing, follow-ups and the customer assistant behave. Defaults live in src/business/settings.ts. */
  desk?: DeskSettings;
}

export interface DeskSettings {
  /** Answer customers who message the WhatsApp/Telegram number, from the approved answers only. Off until an admin turns it on. */
  customerAssistant?: boolean;
  /** Opening hours, address, how to reach us: facts the assistant may state. */
  businessInfo?: string;
  /** Payment reminders: first one this many days after the due date, then every so many days, at most `max`. */
  reminders?: { firstDays?: number; everyDays?: number; max?: number };
  /** A lead nobody answered is followed up this many days after the last message. */
  leadFollowUpDays?: number[];
  /** Messages stored before this have been read for dates (renewals, filings). */
  deadlinesScannedUntil?: string;
  /** The company's prefix for numbering quotes and invoices, and its tax ID printed on them. */
  documents?: { quotePrefix?: string; invoicePrefix?: string; taxId?: string; address?: string; terms?: string };
}

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  /** pilot | team | business: decides usage limits (src/platform/usage.ts). */
  plan: text("plan").notNull().default("pilot"),
  settings: jsonb("settings").$type<OrgSettings>().notNull().default(sql`'{}'::jsonb`),
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
    /** owner | admin | member. Admins manage people, team sources, the agent team and company settings. */
    role: text("role").notNull().default("member"),
    /** A lowercase slug ("finance"). Gives access to team sources limited to that department. */
    department: text("department"),
    /** Set when an admin removes a member: they can no longer sign in or be answered in messaging apps. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
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
    /** The source app says this account was deactivated or deleted (someone left). */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
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
    /** A team source limited to one department: what would be visible to the whole org is visible to it only. */
    department: text("department"),
    status: connectionStatus("status").notNull().default("active"),
    /** Per-connector sync cursors, e.g. Gmail historyId or Slack channel cursors. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    /** The source told ALRO something changed (see src/connectors/push.ts); updates are synced at once instead of waiting for the poll. */
    lastPushAt: timestamp("last_push_at", { withTimezone: true }),
    /** When a registered push subscription (Gmail watch, Outlook subscription) stops sending, so it is renewed first. */
    pushExpiresAt: timestamp("push_expires_at", { withTimezone: true }),
    pushState: jsonb("push_state").$type<Record<string, unknown>>(),
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
    /** An admin told ALRO not to read this conversation: its content was deleted and syncs skip it. The row stays as the marker. */
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
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
    /** 0 to 1. Starts from how it was said and who said it; rises when repeated or confirmed, 1 when a person verified it. */
    confidence: real("confidence"),
    /** Who stated it, when the extraction could tell. A client's word about their own budget outweighs a colleague's guess. */
    assertedByPersonId: uuid("asserted_by_person_id").references(() => people.id, { onDelete: "set null" }),
    /** Current facts that contradict each other share a group until one is confirmed or a person picks. */
    disputeGroup: uuid("dispute_group"),
    /** A member checked this fact. */
    verifiedBy: uuid("verified_by").references(() => people.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** The last time a message restated or confirmed it; old, never-confirmed facts are shown as possibly stale. */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    acl: acl(),
  },
  (t) => [
    index("edges_source_idx").on(t.sourceEntityId, t.relation),
    index("edges_dispute_idx").on(t.disputeGroup).where(sql`${t.disputeGroup} is not null`),
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
  | { kind: "weekly"; weekday: number; time: string }
  /** A watch: runs every few minutes and only reports when something new needs doing. */
  | { kind: "every"; minutes: number };

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
    /** Trusted with its actions: what it proposes runs without asking (the owner turns this on once it has earned it). */
    trusted: boolean("trusted").notNull().default(false),
    /** A department ("finance") whose lead plans the task and hands parts to its specialists. */
    team: text("team"),
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
    /** Phone number, Telegram chat id, Slack user id, Teams user id. */
    externalUserId: text("external_user_id").notNull(),
    /** Where to send unprompted messages when the id alone isn't enough (Teams: service URL and conversation id). */
    address: jsonb("address").$type<Record<string, string>>(),
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
// 7. Doing the work
// ---------------------------------------------------------------------------

/**
 * Something the agent wants to do in an app (send an email, post a message, add a CRM note).
 * Nothing runs until the owner approves it here or by replying in a messaging app, unless it
 * came from a scheduled task they trust.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    orgId: orgId(),
    /** Who decides, and whose account it runs as. */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    /** The action's tool name, e.g. gmail_send_email. */
    tool: text("tool").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    summary: text("summary").notNull(),
    /** The text to read before approving (email body, message); editable. */
    body: text("body"),
    /** external | internal */
    audience: text("audience").notNull(),
    /** Why the agent proposed it, in a sentence. */
    reason: text("reason"),
    /** chat | messaging | routine | meeting | team */
    origin: text("origin").notNull(),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    /** Short code to approve from a messaging app: "yes K7QM". */
    code: text("code").notNull(),
    /**
     * pending → running → done | failed | unknown; or rejected | expired.
     * "unknown": the app didn't answer in time, so it may or may not have gone through; never retried automatically.
     */
    status: text("status").notNull().default("pending"),
    /** Goes up each time the text is edited; approving an older revision than the current one is refused. */
    revision: integer("revision").notNull().default(0),
    /** A pending proposal is dropped after this. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set when the run that drafted this had read text that looked like instructions aimed at an assistant. Shown to the approver. */
    caution: text("caution"),
    result: jsonb("result").$type<{ url?: string; detail?: string }>(),
    error: text("error"),
    /** Approved by a person, or by trust in the routine. */
    approvedBy: text("approved_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("approvals_person_idx").on(t.personId, t.status, t.createdAt), uniqueIndex("approvals_code_uq").on(t.orgId, t.code)],
);

/**
 * The agent team: specialists grouped by department (finance, sales, ops...). A department's
 * lead plans a piece of work and hands parts to its specialists, who work in parallel, each
 * with only the tools its job needs.
 */
export const teamAgents = pgTable(
  "team_agents",
  {
    id: id(),
    orgId: orgId(),
    department: text("department").notNull(),
    name: text("name").notNull(),
    /** What this specialist does and how, in plain words. */
    job: text("job").notNull(),
    /** Tool names or prefixes it may use ("stripe_", "searchMemory"); empty means every read tool. */
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("team_agents_org_idx").on(t.orgId, t.department)],
);

/** One piece of work a department did: the task, each specialist's report and the combined answer. */
export const teamRuns = pgTable(
  "team_runs",
  {
    id: id(),
    orgId: orgId(),
    /** Whose access it ran with. */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    department: text("department").notNull(),
    task: text("task").notNull(),
    /** running | ok | error | over_budget */
    status: text("status").notNull().default("running"),
    answer: text("answer"),
    reports: jsonb("reports").$type<{ specialist: string; task: string; report: string; status: "ok" | "failed"; tokens?: number }[]>().notNull().default(sql`'[]'::jsonb`),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("team_runs_person_idx").on(t.personId, t.startedAt)],
);

/**
 * Something worth a person's attention that nobody asked about: a client waiting on a reply,
 * a deal gone quiet, someone carrying too many overdue promises. Computed from memory, visible
 * to whoever can see the evidence.
 */
export const insights = pgTable(
  "insights",
  {
    id: id(),
    orgId: orgId(),
    /** waiting_on_us | gone_quiet | overloaded | at_risk | disputed_fact | automate | ... */
    kind: text("kind").notNull(),
    /** Stable per subject, so a recomputed insight updates its row instead of adding one. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    /** What to do about it, when there's an obvious next step. */
    suggestion: text("suggestion"),
    /** 1 (worth knowing) to 3 (act today). */
    severity: integer("severity").notNull().default(1),
    subjectEntityId: uuid("subject_entity_id").references(() => entities.id, { onDelete: "cascade" }),
    subjectPersonId: uuid("subject_person_id").references(() => people.id, { onDelete: "cascade" }),
    /** A department it mostly concerns, for the department view. */
    department: text("department"),
    evidenceMessageIds: uuid("evidence_message_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** new | dismissed | resolved */
    status: text("status").notNull().default("new"),
    dismissedBy: uuid("dismissed_by").references(() => people.id, { onDelete: "set null" }),
    acl: acl(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("insights_key_uq").on(t.orgId, t.key), index("insights_open_idx").on(t.orgId, t.status, t.severity), index("insights_acl_idx").using("gin", t.acl)],
);

/** How a recurring piece of work is done, pulled out of the conversations where people actually did it. */
export const procedures = pgTable(
  "procedures",
  {
    id: id(),
    orgId: orgId(),
    /** Whoever asked for it to be written up; it was written from what they can see. */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    steps: jsonb("steps").$type<string[]>().notNull(),
    /** Who does it today. */
    owners: text("owners"),
    /** daily | weekly | monthly | occasional */
    frequency: text("frequency").notNull(),
    /** Rough minutes each time. */
    minutes: integer("minutes"),
    /** low | medium | high: how much judgment it takes. */
    judgment: text("judgment").notNull(),
    /** 0–100: often, long and rule-bound scores high. Hand those to the agent first. */
    automationScore: integer("automation_score").notNull(),
    messageIds: uuid("message_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("procedures_person_idx").on(t.personId), uniqueIndex("procedures_title_uq").on(t.personId, t.title)],
);

export interface TrackerColumn {
  name: string;
  /** text | number | date */
  type: "text" | "number" | "date";
  description?: string;
}

/**
 * A running table pulled out of chats and email: a sales log, a receivables list, stock by
 * grade, how long each truck took. Rows carry the message they came from.
 */
export const trackers = pgTable(
  "trackers",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What counts as a row, in plain words. */
    description: text("description").notNull(),
    columns: jsonb("columns").$type<TrackerColumn[]>().notNull(),
    /** Messages that arrived (were stored) after this have not been read for this tracker yet. */
    scannedUntil: timestamp("scanned_until", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("trackers_person_idx").on(t.personId)],
);

export const trackerRows = pgTable(
  "tracker_rows",
  {
    id: id(),
    orgId: orgId(),
    trackerId: uuid("tracker_id")
      .notNull()
      .references(() => trackers.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    values: jsonb("values").$type<Record<string, string | number | null>>().notNull(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** When it happened (the message's time). */
    at: timestamp("at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("tracker_rows_tracker_idx").on(t.trackerId, t.at)],
);

// ---------------------------------------------------------------------------
// 8. Platform: sign-in, sessions, audit, usage. None of it is readable by the alro_app role.
// ---------------------------------------------------------------------------

/** A member's password hash, kept apart from `people` so no user-facing query can ever select it. */
export const credentials = pgTable("credentials", {
  personId: uuid("person_id")
    .primaryKey()
    .references(() => people.id, { onDelete: "cascade" }),
  orgId: orgId(),
  /** scrypt: "scrypt$<N>$<r>$<p>$<salt>$<hash>". */
  passwordHash: text("password_hash").notNull(),
  updatedAt: updatedAt(),
});

/** A signed-in browser. The cookie holds a random token; only its hash is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** password | sso:<provider> | invite */
    method: text("method").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_person_idx").on(t.personId)],
);

/** A one-time link: an invitation to join a company, or a password reset. Only the token's hash is stored. */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: orgId(),
    /** invite | reset */
    kind: text("kind").notNull().default("invite"),
    email: text("email").notNull(),
    /** For a reset, or when inviting someone already known from a source (a Slack user). */
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    department: text("department"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => people.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invitations_token_uq").on(t.tokenHash), index("invitations_org_idx").on(t.orgId, t.createdAt)],
);

/** Fixed-window counters for rate limits: sign-in attempts per address, questions per person. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

/** Who did what: sign-ins, questions asked, approvals, admin changes, sources connected and removed, exports. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: orgId(),
    /** Null for the system (a scheduled job) or a failed sign-in. */
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    /** Dotted: auth.sign_in, ask, approval.approve, member.invite, source.connect, data.export ... */
    action: text("action").notNull(),
    /** What it was done to: an id, an email, a source name. */
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_org_idx").on(t.orgId, t.createdAt), index("audit_log_person_idx").on(t.personId, t.createdAt)],
);

/** What a company used each day, per metric (tokens, questions, messages synced, agent runs), for limits and billing. */
export const usageDaily = pgTable(
  "usage_daily",
  {
    orgId: orgId(),
    /** YYYY-MM-DD in UTC. */
    day: text("day").notNull(),
    metric: text("metric").notNull(),
    amount: integer("amount").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day, t.metric] })],
);

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** Every background job run (sync, processing, deadlines, tick), so a failure is visible and its work is picked up again. */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    /** Null for a run that covers every company. */
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    job: text("job").notNull(),
    /** running | ok | error */
    status: text("status").notNull().default("running"),
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_job_idx").on(t.job, t.startedAt), index("job_runs_org_idx").on(t.orgId, t.startedAt)],
);

/** Work that failed and will be tried again with growing waits, then left for a person once it has failed too often. */
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: id(),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    /** What kind of work: webhook | routine | sync | pipeline | notify ... */
    kind: text("kind").notNull(),
    /** What it was about: an id the retry handler understands. */
    ref: text("ref").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(1),
    /** Null once it has given up (a person retries it from the Health page) or been resolved. */
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dead_letters_ref_uq").on(t.kind, t.ref), index("dead_letters_due_idx").on(t.nextRetryAt).where(sql`${t.resolvedAt} is null`)],
);

/** An incoming webhook (a message to the bot), stored before it's handled so a failure can be retried and a redelivery is ignored. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    /** whatsapp | telegram | slack | teams */
    channel: text("channel").notNull(),
    /** The app's id for the event. */
    externalId: text("external_id").notNull(),
    /** The parts needed to handle it again (sender, text, media ids). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** received | done | failed */
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("webhook_events_external_uq").on(t.channel, t.externalId), index("webhook_events_status_idx").on(t.status, t.receivedAt)],
);

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

// ---------------------------------------------------------------------------
// 9. Business desk
// ---------------------------------------------------------------------------
// Read only by code that checks the person's role (src/business); the alro_app role has no grant on these.

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });

/** An invoice a customer still owes, copied from the accounting app so it can be chased and its recovery measured. */
export const receivables = pgTable(
  "receivables",
  {
    id: id(),
    orgId: orgId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The accounting app's id for the invoice. */
    externalId: text("external_id").notNull(),
    number: text("number"),
    customer: text("customer"),
    email: text("email"),
    phone: text("phone"),
    currency: text("currency").notNull(),
    amountDue: money("amount_due").notNull(),
    dueOn: date("due_on", { mode: "string" }),
    /** Where the customer can see and pay it, when the app has such a page. */
    url: text("url"),
    /** open | paid: paid once the app no longer lists it as owed. */
    status: text("status").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    remindersSent: integer("reminders_sent").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** The reminder last proposed for this invoice: while it is still waiting, no second one is made. */
    lastApprovalId: uuid("last_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("receivables_external_uq").on(t.connectionId, t.externalId), index("receivables_org_status_idx").on(t.orgId, t.status, t.dueOn)],
);

/** Someone who asked about buying: from a website form, WhatsApp or by hand, with how far the reply and follow-ups have got. */
export const leads = pgTable(
  "leads",
  {
    id: id(),
    orgId: orgId(),
    source: text("source").notNull(),
    /** The sender's own id for it (a form submission id), so a redelivery isn't a second lead. */
    externalId: text("external_id"),
    name: text("name"),
    email: text("email"),
    phone: text("phone"),
    message: text("message").notNull(),
    /** new | replied | following | won | lost */
    status: text("status").notNull().default("new"),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, { onDelete: "set null" }),
    firstRepliedAt: timestamp("first_replied_at", { withTimezone: true }),
    customerRepliedAt: timestamp("customer_replied_at", { withTimezone: true }),
    followUpsSent: integer("follow_ups_sent").notNull().default(0),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The reply or follow-up last proposed for this lead. */
    lastApprovalId: uuid("last_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("leads_external_uq").on(t.orgId, t.source, t.externalId).where(sql`${t.externalId} is not null`), index("leads_org_status_idx").on(t.orgId, t.status, t.createdAt)],
);

/** An answer the owner approved for customers to be given. The customer assistant says nothing else. */
export const faqEntries = pgTable(
  "faq_entries",
  {
    id: id(),
    orgId: orgId(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("faq_entries_org_idx").on(t.orgId)],
);

/** A customer's conversation with the assistant, on one messaging app. */
export const customerChats = pgTable(
  "customer_chats",
  {
    id: id(),
    orgId: orgId(),
    channel: text("channel").notNull(),
    /** Phone number or chat id. */
    externalUser: text("external_user").notNull(),
    name: text("name"),
    /** bot | waiting (a person must answer) | human (a person is handling it) | closed */
    status: text("status").notNull().default("bot"),
    handoffReason: text("handoff_reason"),
    /** WhatsApp only lets free-form replies within 24 hours of the customer's last message. */
    lastCustomerMessageAt: timestamp("last_customer_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customer_chats_user_uq").on(t.orgId, t.channel, t.externalUser), index("customer_chats_status_idx").on(t.orgId, t.status, t.lastMessageAt)],
);

export const customerMessages = pgTable(
  "customer_messages",
  {
    id: id(),
    orgId: orgId(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => customerChats.id, { onDelete: "cascade" }),
    /** customer | bot | staff */
    sender: text("sender").notNull(),
    text: text("text").notNull(),
    /** The app's id for an incoming message, so a redelivered webhook is answered once. */
    externalId: text("external_id"),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("customer_messages_chat_idx").on(t.chatId, t.createdAt), uniqueIndex("customer_messages_external_uq").on(t.chatId, t.externalId).where(sql`${t.externalId} is not null`)],
);

export interface DocumentLine {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Tax rate in percent (GST 18). */
  taxRate: number;
}

/** A quote or invoice, numbered per company and shared with the customer through an unguessable link. */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgId(),
    /** quote | invoice */
    kind: text("kind").notNull(),
    number: text("number").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    customerTaxId: text("customer_tax_id"),
    customerAddress: text("customer_address"),
    items: jsonb("items").$type<DocumentLine[]>().notNull(),
    currency: text("currency").notNull().default("INR"),
    subtotal: money("subtotal").notNull(),
    tax: money("tax").notNull(),
    total: money("total").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    dueOn: date("due_on", { mode: "string" }),
    notes: text("notes"),
    /** draft | sent | accepted | paid | void */
    status: text("status").notNull().default("draft"),
    shareToken: text("share_token").notNull(),
    /** The quote an invoice was made from. */
    fromDocumentId: uuid("from_document_id").references((): AnyPgColumn => documents.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
    /** The email or message last proposed to send it to the customer. */
    lastApprovalId: uuid("last_approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("documents_number_uq").on(t.orgId, t.kind, t.number), uniqueIndex("documents_token_uq").on(t.shareToken), index("documents_org_idx").on(t.orgId, t.createdAt)],
);

/** A receipt or bill someone spent money on, read from a photo or typed. */
export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    orgId: orgId(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(),
    spentOn: date("spent_on", { mode: "string" }).notNull(),
    amount: money("amount").notNull(),
    /** The tax inside the amount (GST), when the receipt shows it. */
    taxAmount: money("tax_amount"),
    currency: text("currency").notNull().default("INR"),
    category: text("category"),
    /** The vendor's GSTIN or tax number. */
    taxId: text("tax_id"),
    /** company | personal (to be reimbursed) */
    paidBy: text("paid_by").notNull().default("company"),
    invoiceNumber: text("invoice_number"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("expenses_org_idx").on(t.orgId, t.spentOn), index("expenses_person_idx").on(t.personId, t.spentOn)],
);

/** A date that can't be missed: a licence, contract or registration expiring, a filing due. Reminded ahead of time. */
export const deadlines = pgTable(
  "deadlines",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    /** licence | contract | filing | renewal | payment | other */
    kind: text("kind").notNull().default("other"),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    /** none | monthly | quarterly | yearly: after it's done the next date is set. */
    repeat: text("repeat").notNull().default("none"),
    /** Remind this many days before. */
    remindDays: integer("remind_days").array().notNull().default(sql`'{30,7,1}'::integer[]`),
    ownerPersonId: uuid("owner_person_id").references(() => people.id, { onDelete: "set null" }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Set for the ready-made compliance dates, so switching one on twice does nothing. */
    preset: text("preset"),
    notes: text("notes"),
    /** suggested (found in a message, waiting to be confirmed) | open | done | dismissed */
    status: text("status").notNull().default("open"),
    /** The smallest "days before" already reminded for this due date. */
    lastRemindedDay: integer("last_reminded_day"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("deadlines_org_idx").on(t.orgId, t.status, t.dueOn), uniqueIndex("deadlines_preset_uq").on(t.orgId, t.preset).where(sql`${t.preset} is not null`)],
);
