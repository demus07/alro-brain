CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"models" jsonb NOT NULL,
	"cases" integer NOT NULL,
	"score" real NOT NULL,
	"citation_rate" real NOT NULL,
	"cost_usd" real NOT NULL,
	"avg_seconds" real NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_runs_org_idx" ON "eval_runs" USING btree ("org_id","created_at");--> statement-breakpoint
-- Eval runs are org-level reports, like llm_runs.
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON eval_runs FOR SELECT TO alro_app USING (org_id = app_org_id());
