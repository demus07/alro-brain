-- The business desk: money owed and chased, leads, a customer-facing assistant with its approved answers,
-- quotes and invoices, expenses, dates that can't be missed, and instant updates from sources.
ALTER TABLE "connections" ADD COLUMN "last_push_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "push_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "push_state" jsonb;--> statement-breakpoint
CREATE TABLE "receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE cascade,
	"external_id" text NOT NULL,
	"number" text,
	"customer" text,
	"email" text,
	"phone" text,
	"currency" text NOT NULL,
	"amount_due" numeric(14,2) NOT NULL,
	"due_on" date,
	"url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"last_approval_id" uuid REFERENCES "approvals"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "receivables_external_uq" ON "receivables" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "receivables_org_status_idx" ON "receivables" USING btree ("org_id","status","due_on");--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"source" text NOT NULL,
	"external_id" text,
	"name" text,
	"email" text,
	"phone" text,
	"message" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"owner_person_id" uuid REFERENCES "people"("id") ON DELETE set null,
	"first_replied_at" timestamp with time zone,
	"customer_replied_at" timestamp with time zone,
	"follow_ups_sent" integer DEFAULT 0 NOT NULL,
	"next_follow_up_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"last_approval_id" uuid REFERENCES "approvals"("id") ON DELETE set null,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "leads_external_uq" ON "leads" USING btree ("org_id","source","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE INDEX "leads_org_status_idx" ON "leads" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE TABLE "faq_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "faq_entries_org_idx" ON "faq_entries" USING btree ("org_id");--> statement-breakpoint
CREATE TABLE "customer_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"channel" text NOT NULL,
	"external_user" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'bot' NOT NULL,
	"handoff_reason" text,
	"last_customer_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "customer_chats_user_uq" ON "customer_chats" USING btree ("org_id","channel","external_user");--> statement-breakpoint
CREATE INDEX "customer_chats_status_idx" ON "customer_chats" USING btree ("org_id","status","last_message_at");--> statement-breakpoint
CREATE TABLE "customer_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"chat_id" uuid NOT NULL REFERENCES "customer_chats"("id") ON DELETE cascade,
	"sender" text NOT NULL,
	"text" text NOT NULL,
	"external_id" text,
	"person_id" uuid REFERENCES "people"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "customer_messages_chat_idx" ON "customer_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_messages_external_uq" ON "customer_messages" USING btree ("chat_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"number" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"customer_tax_id" text,
	"customer_address" text,
	"items" jsonb NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"subtotal" numeric(14,2) NOT NULL,
	"tax" numeric(14,2) NOT NULL,
	"total" numeric(14,2) NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"share_token" text NOT NULL,
	"from_document_id" uuid REFERENCES "documents"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "people"("id") ON DELETE set null,
	"last_approval_id" uuid REFERENCES "approvals"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_number_uq" ON "documents" USING btree ("org_id","kind","number");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_token_uq" ON "documents" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "documents_org_idx" ON "documents" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "people"("id") ON DELETE cascade,
	"vendor" text NOT NULL,
	"spent_on" date NOT NULL,
	"amount" numeric(14,2) NOT NULL,
	"tax_amount" numeric(14,2),
	"currency" text DEFAULT 'INR' NOT NULL,
	"category" text,
	"tax_id" text,
	"paid_by" text DEFAULT 'company' NOT NULL,
	"invoice_number" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "expenses_org_idx" ON "expenses" USING btree ("org_id","spent_on");--> statement-breakpoint
CREATE INDEX "expenses_person_idx" ON "expenses" USING btree ("person_id","spent_on");--> statement-breakpoint
CREATE TABLE "deadlines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"due_on" date NOT NULL,
	"repeat" text DEFAULT 'none' NOT NULL,
	"remind_days" integer[] DEFAULT '{30,7,1}'::integer[] NOT NULL,
	"owner_person_id" uuid REFERENCES "people"("id") ON DELETE set null,
	"source_message_id" uuid REFERENCES "messages"("id") ON DELETE set null,
	"preset" text,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"last_reminded_day" integer,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "deadlines_org_idx" ON "deadlines" USING btree ("org_id","status","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "deadlines_preset_uq" ON "deadlines" USING btree ("org_id","preset") WHERE "preset" is not null;--> statement-breakpoint
-- Money, leads, customer chats, documents, expenses and dates are read only by code that checks the person's role: no policy, no grant.
ALTER TABLE "receivables" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "receivables" FROM alro_app;--> statement-breakpoint
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "leads" FROM alro_app;--> statement-breakpoint
ALTER TABLE "faq_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "faq_entries" FROM alro_app;--> statement-breakpoint
ALTER TABLE "customer_chats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "customer_chats" FROM alro_app;--> statement-breakpoint
ALTER TABLE "customer_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "customer_messages" FROM alro_app;--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "documents" FROM alro_app;--> statement-breakpoint
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "expenses" FROM alro_app;--> statement-breakpoint
ALTER TABLE "deadlines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "deadlines" FROM alro_app;
