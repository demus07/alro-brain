CREATE TABLE "pipeline_leases" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_leases" ADD CONSTRAINT "pipeline_leases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Ops only: RLS with no policy hides it from the alro_app role.
ALTER TABLE "pipeline_leases" ENABLE ROW LEVEL SECURITY;
