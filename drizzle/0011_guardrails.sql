-- A caution on proposals drafted after reading suspicious text, and conversations an admin excluded from ALRO.
ALTER TABLE "approvals" ADD COLUMN "caution" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "excluded_at" timestamp with time zone;
