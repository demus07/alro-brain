-- Row-level security for user-facing reads.
--
-- Background jobs (ingest, extraction, watcher) connect as the table owner and
-- bypass RLS; they must always filter by org_id themselves.
-- Anything answering a user runs inside withScope() (src/db/scope.ts), which does
--   SET LOCAL ROLE alro_app
--   set_config('app.org_id' | 'app.person_id' | 'app.principals', ..., true)
-- so Postgres itself hides every row the asker could not see in the source tool.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alro_app') THEN
    CREATE ROLE alro_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT alro_app TO CURRENT_USER;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO alro_app;--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA public TO alro_app;--> statement-breakpoint
GRANT UPDATE ON commitments TO alro_app;--> statement-breakpoint
GRANT INSERT ON commitment_events TO alro_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO alro_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_person_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_principals() RETURNS text[]
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.principals', true), '')::text[], '{}'::text[]) $$;--> statement-breakpoint

-- Content tables: same org, and at least one shared principal.
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON threads FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON messages FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON records FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON chunks FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON entities FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE edges ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON edges FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE rollups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON rollups FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY acl_read ON commitments FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint
CREATE POLICY acl_update ON commitments FOR UPDATE TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals())
  WITH CHECK (org_id = app_org_id() AND acl && app_principals());--> statement-breakpoint

-- Rows that hang off a content row inherit its visibility.
ALTER TABLE entity_aliases ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY via_entity ON entity_aliases FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM entities e WHERE e.id = entity_id));--> statement-breakpoint
ALTER TABLE commitment_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY via_commitment ON commitment_events FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND EXISTS (SELECT 1 FROM commitments c WHERE c.id = commitment_id));--> statement-breakpoint
CREATE POLICY via_commitment_insert ON commitment_events FOR INSERT TO alro_app
  WITH CHECK (org_id = app_org_id() AND EXISTS (SELECT 1 FROM commitments c WHERE c.id = commitment_id));--> statement-breakpoint
ALTER TABLE thread_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY via_thread ON thread_members FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND ('t:' || thread_id::text) = ANY (app_principals()));--> statement-breakpoint

-- Personal rows.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY own ON notifications FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND person_id = app_person_id());--> statement-breakpoint

-- Org-level rows: visible to everyone in the org.
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON orgs FOR SELECT TO alro_app USING (id = app_org_id());--> statement-breakpoint
ALTER TABLE people ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON people FOR SELECT TO alro_app USING (org_id = app_org_id());--> statement-breakpoint
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON identities FOR SELECT TO alro_app USING (org_id = app_org_id());--> statement-breakpoint
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON connections FOR SELECT TO alro_app USING (org_id = app_org_id());--> statement-breakpoint
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON sync_runs FOR SELECT TO alro_app USING (org_id = app_org_id());--> statement-breakpoint
ALTER TABLE llm_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY same_org ON llm_runs FOR SELECT TO alro_app USING (org_id = app_org_id());
--> statement-breakpoint

-- A thread's ACL is derived from its visibility, and messages and chunks always
-- inherit their thread's ACL. Connectors can't get this wrong by accident.
CREATE OR REPLACE FUNCTION set_thread_acl() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.acl := CASE WHEN NEW.visibility = 'org' THEN ARRAY['org'] ELSE ARRAY['t:' || NEW.id::text] END;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER threads_acl BEFORE INSERT OR UPDATE OF visibility ON threads
  FOR EACH ROW EXECUTE FUNCTION set_thread_acl();--> statement-breakpoint

CREATE OR REPLACE FUNCTION inherit_thread_acl() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  SELECT t.acl INTO NEW.acl FROM threads t WHERE t.id = NEW.thread_id;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER messages_acl BEFORE INSERT OR UPDATE OF thread_id ON messages
  FOR EACH ROW EXECUTE FUNCTION inherit_thread_acl();--> statement-breakpoint
CREATE TRIGGER chunks_acl BEFORE INSERT OR UPDATE OF thread_id ON chunks
  FOR EACH ROW EXECUTE FUNCTION inherit_thread_acl();--> statement-breakpoint

-- When a thread changes visibility (a channel goes private), its content follows.
CREATE OR REPLACE FUNCTION propagate_thread_acl() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  UPDATE messages SET acl = NEW.acl WHERE thread_id = NEW.id;
  UPDATE chunks SET acl = NEW.acl WHERE thread_id = NEW.id;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER threads_acl_propagate AFTER UPDATE OF visibility ON threads
  FOR EACH ROW WHEN (OLD.acl IS DISTINCT FROM NEW.acl)
  EXECUTE FUNCTION propagate_thread_acl();
