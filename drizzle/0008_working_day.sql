-- Direct connections (tokens held by ALRO, encrypted), calendar, meeting notes,
-- the personal brain, scheduled tasks, live tools and messaging channels.

ALTER TABLE "connections" DROP COLUMN "nango_connection_id";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "label" text;--> statement-breakpoint

CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"data" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_ref_uq" ON "secrets" USING btree ("kind","ref_id");--> statement-breakpoint
-- Credentials are never readable by user-facing queries: no policy, and no grant.
ALTER TABLE "secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "secrets" FROM alro_app;--> statement-breakpoint

CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE cascade,
	"external_id" text NOT NULL,
	"owner_person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"organizer" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "events_connection_external_uq" ON "events" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "events_owner_start_idx" ON "events" USING btree ("owner_person_id","starts_at");--> statement-breakpoint
CREATE INDEX "events_acl_idx" ON "events" USING gin ("acl");--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON "events" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint

CREATE TABLE "meeting_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"thread_id" uuid NOT NULL UNIQUE REFERENCES "threads"("id") ON DELETE cascade,
	"summary" text NOT NULL,
	"follow_up" text,
	"acl" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "meeting_notes_acl_idx" ON "meeting_notes" USING gin ("acl");--> statement-breakpoint
ALTER TABLE "meeting_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON "meeting_notes" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
-- Notes are as visible as the meeting they describe, and follow it if that changes.
CREATE TRIGGER meeting_notes_acl BEFORE INSERT OR UPDATE OF thread_id ON "meeting_notes"
  FOR EACH ROW EXECUTE FUNCTION inherit_thread_acl();--> statement-breakpoint
CREATE OR REPLACE FUNCTION propagate_thread_acl() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE messages SET acl = NEW.acl WHERE thread_id = NEW.id;
  UPDATE chunks SET acl = NEW.acl WHERE thread_id = NEW.id;
  UPDATE meeting_notes SET acl = NEW.acl WHERE thread_id = NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE TABLE "profiles" (
	"person_id" uuid PRIMARY KEY NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"style" text,
	"style_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "profiles" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint

CREATE TABLE "profile_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"source" text DEFAULT 'chat' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "profile_notes_person_idx" ON "profile_notes" USING btree ("person_id","created_at");--> statement-breakpoint
ALTER TABLE "profile_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "profile_notes" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint

CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"owner_person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "routines_due_idx" ON "routines" USING btree ("next_run_at") WHERE "enabled";--> statement-breakpoint
CREATE INDEX "routines_owner_idx" ON "routines" USING btree ("owner_person_id");--> statement-breakpoint
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "routines" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND owner_person_id = app_person_id());--> statement-breakpoint

CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"routine_id" uuid NOT NULL REFERENCES "routines"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"status" text DEFAULT 'running' NOT NULL,
	"output" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "routine_runs_routine_idx" ON "routine_runs" USING btree ("routine_id","started_at");--> statement-breakpoint
ALTER TABLE "routine_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "routine_runs" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint

CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"scope" "connection_scope" NOT NULL,
	"owner_person_id" uuid REFERENCES "people"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "mcp_servers_org_idx" ON "mcp_servers" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Team servers are visible to the org; personal ones only to whoever added them.
CREATE POLICY visible ON "mcp_servers" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND (scope = 'org' OR owner_person_id = app_person_id()));--> statement-breakpoint

CREATE TABLE "channel_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"channel" text NOT NULL,
	"external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_user_uq" ON "channel_links" USING btree ("channel","external_user_id");--> statement-breakpoint
CREATE INDEX "channel_links_person_idx" ON "channel_links" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "channel_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "channel_links" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint

CREATE TABLE "channel_link_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"expires_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
-- Ops only: RLS with no policy hides it from the alro_app role.
ALTER TABLE "channel_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"channel" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "channel_messages_person_idx" ON "channel_messages" USING btree ("person_id","channel","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_external_uq" ON "channel_messages" USING btree ("channel","external_id");--> statement-breakpoint
ALTER TABLE "channel_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "channel_messages" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());
