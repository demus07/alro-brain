-- Hidden entities drop out of everything a person reads (graph, search, the agent): the read policy skips them.
DROP POLICY acl_read ON entities;--> statement-breakpoint
CREATE POLICY acl_read ON entities FOR SELECT TO alro_app
  USING (org_id = app_org_id() AND acl && app_principals() AND hidden_at IS NULL);
