CREATE TYPE "public"."commitment_event_type" AS ENUM('created', 'status_changed', 'due_changed', 'evidence_added', 'merged', 'verdict', 'reminded');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('open', 'due_soon', 'overdue', 'done', 'cancelled', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."connection_scope" AS ENUM('org', 'personal');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'syncing', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."due_kind" AS ENUM('hard', 'soft', 'none');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('person', 'company', 'deal', 'project', 'product', 'topic', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('chat', 'email', 'transcript', 'note', 'record_change', 'calendar_event');--> statement-breakpoint
CREATE TYPE "public"."screen_result" AS ENUM('skip', 'extract');--> statement-breakpoint
CREATE TYPE "public"."thread_kind" AS ENUM('channel', 'dm', 'group_dm', 'email', 'whatsapp', 'meeting', 'crm_timeline', 'upload');--> statement-breakpoint
CREATE TYPE "public"."thread_visibility" AS ENUM('org', 'members');--> statement-breakpoint
CREATE TYPE "public"."user_verdict" AS ENUM('confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_ids" uuid[] NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL,
	"embedding" halfvec(1024),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED NOT NULL,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"type" "commitment_event_type" NOT NULL,
	"from_status" "commitment_status",
	"to_status" "commitment_status",
	"message_id" uuid,
	"actor" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_person_id" uuid,
	"counterparty_person_id" uuid,
	"counterparty_text" text,
	"related_entity_id" uuid,
	"title" text NOT NULL,
	"details" text,
	"quote" text NOT NULL,
	"due_at" timestamp with time zone,
	"due_kind" "due_kind" DEFAULT 'none' NOT NULL,
	"due_text" text,
	"status" "commitment_status" DEFAULT 'open' NOT NULL,
	"confidence" real NOT NULL,
	"source_message_id" uuid NOT NULL,
	"evidence_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"fulfilled_by_message_id" uuid,
	"user_verdict" "user_verdict",
	"verdict_by_person_id" uuid,
	"extractor" text,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"scope" "connection_scope" NOT NULL,
	"owner_person_id" uuid,
	"nango_connection_id" text,
	"external_account_id" text,
	"region" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"cursor" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"fact" text NOT NULL,
	"fact_embedding" halfvec(1024),
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expired_at" timestamp with time zone,
	"invalidated_by" uuid,
	"source_message_ids" uuid[] NOT NULL,
	"confidence" real,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "entity_type" NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"person_id" uuid,
	"record_id" uuid,
	"name_embedding" halfvec(1024),
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"entity_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "entity_aliases_entity_id_alias_pk" PRIMARY KEY("entity_id","alias")
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"message_ids" uuid[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" "message_kind" NOT NULL,
	"author_identity_id" uuid,
	"author_person_id" uuid,
	"recipient_person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"reply_to_external_id" text,
	"subject" text,
	"text" text NOT NULL,
	"attachments" jsonb,
	"url" text,
	"raw" jsonb,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"screen_result" "screen_result",
	"extracted_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"commitment_id" uuid,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_once_uq" UNIQUE NULLS NOT DISTINCT("commitment_id","person_id","kind")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"primary_email" text,
	"timezone" text,
	"is_member" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"thread_id" uuid,
	"type" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"fields" jsonb NOT NULL,
	"owner_person_id" uuid,
	"url" text,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"embedding" halfvec(1024),
	"source_message_ids" uuid[] NOT NULL,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread_members" (
	"thread_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_members_thread_id_person_id_pk" PRIMARY KEY("thread_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" "thread_kind" NOT NULL,
	"external_id" text NOT NULL,
	"title" text,
	"url" text,
	"visibility" "thread_visibility" NOT NULL,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_events" ADD CONSTRAINT "commitment_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_events" ADD CONSTRAINT "commitment_events_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_events" ADD CONSTRAINT "commitment_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_counterparty_person_id_people_id_fk" FOREIGN KEY ("counterparty_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_related_entity_id_entities_id_fk" FOREIGN KEY ("related_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_fulfilled_by_message_id_messages_id_fk" FOREIGN KEY ("fulfilled_by_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_verdict_by_person_id_people_id_fk" FOREIGN KEY ("verdict_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD CONSTRAINT "llm_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_identity_id_identities_id_fk" FOREIGN KEY ("author_identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollups" ADD CONSTRAINT "rollups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_thread_idx" ON "chunks" USING btree ("thread_id","start_at");--> statement-breakpoint
CREATE INDEX "chunks_acl_idx" ON "chunks" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "commitment_events_commitment_idx" ON "commitment_events" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "commitments_owner_status_idx" ON "commitments" USING btree ("org_id","owner_person_id","status");--> statement-breakpoint
CREATE INDEX "commitments_due_idx" ON "commitments" USING btree ("org_id","due_at") WHERE "commitments"."status" in ('open', 'due_soon', 'overdue');--> statement-breakpoint
CREATE INDEX "commitments_related_idx" ON "commitments" USING btree ("related_entity_id");--> statement-breakpoint
CREATE INDEX "commitments_source_idx" ON "commitments" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "commitments_acl_idx" ON "commitments" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "connections_org_idx" ON "connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "edges_source_idx" ON "edges" USING btree ("source_entity_id","relation");--> statement-breakpoint
CREATE INDEX "edges_target_idx" ON "edges" USING btree ("target_entity_id","relation");--> statement-breakpoint
CREATE INDEX "edges_current_idx" ON "edges" USING btree ("org_id","relation") WHERE "edges"."expired_at" is null;--> statement-breakpoint
CREATE INDEX "edges_acl_idx" ON "edges" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "edges_fact_embedding_idx" ON "edges" USING hnsw ("fact_embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "entities_org_type_idx" ON "entities" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "entities_name_trgm_idx" ON "entities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entities_acl_idx" ON "entities" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "entities_person_idx" ON "entities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "entity_aliases_trgm_idx" ON "entity_aliases" USING gin ("alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "identities_provider_external_uq" ON "identities" USING btree ("org_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "identities_person_idx" ON "identities" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "identities_email_idx" ON "identities" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "identities_phone_idx" ON "identities" USING btree ("org_id","phone");--> statement-breakpoint
CREATE INDEX "llm_runs_org_stage_idx" ON "llm_runs" USING btree ("org_id","stage","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_connection_external_uq" ON "messages" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "messages_thread_sent_idx" ON "messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_org_sent_idx" ON "messages" USING btree ("org_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_author_idx" ON "messages" USING btree ("author_person_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_acl_idx" ON "messages" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "messages_pending_idx" ON "messages" USING btree ("org_id","ingested_at") WHERE "messages"."extracted_at" is null;--> statement-breakpoint
CREATE INDEX "people_org_idx" ON "people" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "records_connection_external_uq" ON "records" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "records_org_type_idx" ON "records" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "records_acl_idx" ON "records" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "rollups_scope_idx" ON "rollups" USING btree ("org_id","scope_type","scope_id","period_end");--> statement-breakpoint
CREATE INDEX "rollups_acl_idx" ON "rollups" USING gin ("acl");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "thread_members_person_idx" ON "thread_members" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_connection_external_uq" ON "threads" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "threads_org_idx" ON "threads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "threads_acl_idx" ON "threads" USING gin ("acl");