-- ADR-0317 (builder lane L6, G4) under the ADR-0234 PM batch: row-level security on the assignment tables.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. The file name sorts after
-- `pm_assignment_trigger.sql`, which creates the tables. It names reasons only as strings and redefines no function,
-- so its order against `rls_pm_tables.sql` does not matter.
--
-- Like every PM table, these carry no org_id (ADR-0041): an admin (or the bootstrap token) reaches them through
-- regulait_rls_is_admin(), and the paths with no admin principal through named reasons:
--   approval_maintenance  the PM webhook route, which matches an assignment event: reads the trigger and the identity
--                         links, and claims and updates the start (pm_assignment_starts, all).
--   migration             every table, for a later data step.
-- The trigger and identity links are admin-managed configuration: only an admin or a migration writes them.

ALTER TABLE pm_assignment_triggers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_assignment_triggers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_assignment_triggers_select ON pm_assignment_triggers;
--> statement-breakpoint
CREATE POLICY pm_assignment_triggers_select ON pm_assignment_triggers FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_assignment_triggers_write ON pm_assignment_triggers;
--> statement-breakpoint
CREATE POLICY pm_assignment_triggers_write ON pm_assignment_triggers FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

ALTER TABLE pm_identity_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_identity_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_identity_links_select ON pm_identity_links;
--> statement-breakpoint
CREATE POLICY pm_identity_links_select ON pm_identity_links FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_identity_links_write ON pm_identity_links;
--> statement-breakpoint
CREATE POLICY pm_identity_links_write ON pm_identity_links FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) IS NOT DISTINCT FROM 'migration');
--> statement-breakpoint

ALTER TABLE pm_assignment_starts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_assignment_starts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_assignment_starts_all ON pm_assignment_starts;
--> statement-breakpoint
CREATE POLICY pm_assignment_starts_all ON pm_assignment_starts FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'migration'])
  );
