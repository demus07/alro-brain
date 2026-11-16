-- Sign-in and sessions, roles and departments, audit log, usage metering, job history and
-- retries, stored webhooks, fact confidence and disputes, insights, team runs, approval lifecycle.
ALTER TABLE "orgs" ADD COLUMN "plan" text DEFAULT 'pilot' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
-- Companies that existed before roles: their first member owns it, the other members are admins.
UPDATE "people" SET "role" = 'admin' WHERE "is_member";--> statement-breakpoint
UPDATE "people" p SET "role" = 'owner' WHERE p."is_member" AND p."id" = (
  SELECT q."id" FROM "people" q WHERE q."org_id" = p."org_id" AND q."is_member" ORDER BY q."created_at", q."id" LIMIT 1
);--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "asserted_by_person_id" uuid REFERENCES "people"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "dispute_group" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "verified_by" uuid REFERENCES "people"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "edges_dispute_idx" ON "edges" USING btree ("dispute_group") WHERE "dispute_group" is not null;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint

-- A team source limited to a department: what would be visible to the whole org is visible to that department.
CREATE OR REPLACE FUNCTION set_thread_acl() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.acl := CASE
    WHEN NEW.visibility = 'org' THEN ARRAY[coalesce(
      (SELECT 'd:' || c.department FROM connections c WHERE c.id = NEW.connection_id AND c.department IS NOT NULL),
      'org')]
    ELSE ARRAY['t:' || NEW.id::text]
  END;
  RETURN NEW;
END
$$;--> statement-breakpoint
-- Changing a source's department re-derives its threads' visibility (and, through the existing trigger, their content's).
CREATE OR REPLACE FUNCTION propagate_connection_department() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE threads SET visibility = visibility WHERE connection_id = NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER connections_department AFTER UPDATE OF department ON "connections"
  FOR EACH ROW WHEN (OLD.department IS DISTINCT FROM NEW.department)
  EXECUTE FUNCTION propagate_connection_department();--> statement-breakpoint

CREATE TABLE "credentials" (
	"person_id" uuid PRIMARY KEY NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"password_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"token_hash" text NOT NULL,
	"method" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_person_idx" ON "sessions" USING btree ("person_id");--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"kind" text DEFAULT 'invite' NOT NULL,
	"email" text NOT NULL,
	"person_id" uuid REFERENCES "people"("id") ON DELETE cascade,
	"role" text DEFAULT 'member' NOT NULL,
	"department" text,
	"token_hash" text NOT NULL,
	"invited_by" uuid REFERENCES "people"("id") ON DELETE set null,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_uq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid REFERENCES "people"("id") ON DELETE set null,
	"action" text NOT NULL,
	"target" text,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_person_idx" ON "audit_log" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"day" text NOT NULL,
	"metric" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_org_id_day_metric_pk" PRIMARY KEY("org_id","day","metric")
);--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid REFERENCES "orgs"("id") ON DELETE cascade,
	"job" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "job_runs_job_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_org_idx" ON "job_runs" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid REFERENCES "orgs"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"payload" jsonb,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letters_ref_uq" ON "dead_letters" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "dead_letters_due_idx" ON "dead_letters" USING btree ("next_retry_at") WHERE "resolved_at" is null;--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_external_uq" ON "webhook_events" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status","received_at");--> statement-breakpoint
-- Platform and ops tables are never readable by user-facing queries: no policy, and no grant.
ALTER TABLE "credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "credentials" FROM alro_app;--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "sessions" FROM alro_app;--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "invitations" FROM alro_app;--> statement-breakpoint
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "rate_limits" FROM alro_app;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "audit_log" FROM alro_app;--> statement-breakpoint
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "usage_daily" FROM alro_app;--> statement-breakpoint
ALTER TABLE "job_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "job_runs" FROM alro_app;--> statement-breakpoint
ALTER TABLE "dead_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "dead_letters" FROM alro_app;--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "webhook_events" FROM alro_app;--> statement-breakpoint

CREATE TABLE "team_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"department" text NOT NULL,
	"task" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"answer" text,
	"reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"routine_id" uuid REFERENCES "routines"("id") ON DELETE set null,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "team_runs_person_idx" ON "team_runs" USING btree ("person_id","started_at");--> statement-breakpoint
ALTER TABLE "team_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- A run holds what one person's access found: only they read it.
CREATE POLICY own ON "team_runs" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"suggestion" text,
	"severity" integer DEFAULT 1 NOT NULL,
	"subject_entity_id" uuid REFERENCES "entities"("id") ON DELETE cascade,
	"subject_person_id" uuid REFERENCES "people"("id") ON DELETE cascade,
	"department" text,
	"evidence_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"dismissed_by" uuid REFERENCES "people"("id") ON DELETE set null,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "insights_key_uq" ON "insights" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "insights_open_idx" ON "insights" USING btree ("org_id","status","severity");--> statement-breakpoint
CREATE INDEX "insights_acl_idx" ON "insights" USING gin ("acl");--> statement-breakpoint
ALTER TABLE "insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON "insights" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());
