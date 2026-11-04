CREATE TABLE "entity_mentions" (
	"entity_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"description" text,
	CONSTRAINT "entity_mentions_entity_id_chunk_id_pk" PRIMARY KEY("entity_id","chunk_id")
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "graphed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "source_chunk_id" uuid;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_mentions_chunk_idx" ON "entity_mentions" USING btree ("chunk_id");--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_chunk_id_chunks_id_fk" FOREIGN KEY ("source_chunk_id") REFERENCES "public"."chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A mention is visible when the conversation it points at is.
ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY via_chunk ON entity_mentions FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM chunks c WHERE c.id = chunk_id));
