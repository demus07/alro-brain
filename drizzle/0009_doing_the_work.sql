-- Approvals for actions, the agent team, procedures and trackers pulled from conversations,
-- trusted scheduled tasks, and delivery addresses for messaging apps that need them (Teams).
ALTER TABLE "routines" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "team" text;--> statement-breakpoint
ALTER TABLE "channel_links" ADD COLUMN "address" jsonb;--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"connection_id" uuid REFERENCES "connections"("id") ON DELETE cascade,
	"mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE cascade,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"summary" text NOT NULL,
	"body" text,
	"audience" text NOT NULL,
	"reason" text,
	"origin" text NOT NULL,
	"routine_id" uuid REFERENCES "routines"("id") ON DELETE set null,
	"code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"approved_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "approvals_person_idx" ON "approvals" USING btree ("person_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_code_uq" ON "approvals" USING btree ("org_id","code");--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "approvals" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint
CREATE TABLE "team_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"department" text NOT NULL,
	"name" text NOT NULL,
	"job" text NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "people"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "team_agents_org_idx" ON "team_agents" USING btree ("org_id","department");--> statement-breakpoint
ALTER TABLE "team_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Job descriptions, not content: the whole org can read them. What each agent finds is still limited to the asker's access.
CREATE POLICY org_read ON "team_agents" FOR SELECT TO alro_app
  USING (org_id = app_org_id());--> statement-breakpoint
CREATE TABLE "procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"steps" jsonb NOT NULL,
	"owners" text,
	"frequency" text NOT NULL,
	"minutes" integer,
	"judgment" text NOT NULL,
	"automation_score" integer NOT NULL,
	"message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "procedures_person_idx" ON "procedures" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procedures_title_uq" ON "procedures" USING btree ("person_id","title");--> statement-breakpoint
ALTER TABLE "procedures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Written from what one person can see, so only they read it.
CREATE POLICY own ON "procedures" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint
CREATE TABLE "trackers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"columns" jsonb NOT NULL,
	"scanned_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "trackers_person_idx" ON "trackers" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "trackers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "trackers" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint
CREATE TABLE "tracker_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"tracker_id" uuid NOT NULL REFERENCES "trackers"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"values" jsonb NOT NULL,
	"message_id" uuid REFERENCES "messages"("id") ON DELETE set null,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "tracker_rows_tracker_idx" ON "tracker_rows" USING btree ("tracker_id","at");--> statement-breakpoint
ALTER TABLE "tracker_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON "tracker_rows" FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());
