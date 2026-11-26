-- ADR-0356 (builder lane E37, PR 2): writing a PM-triggered workflow's progress back to its work item.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Sorts after
-- `pm_work_triggers.sql`, which creates the tables this one references and amends.
--
-- 1. `pm_write_backs`: the idempotency ledger. One row per write-back (trigger, kind, source), recorded before the PM
--    call and deleted when the call fails, so a successful write-back is made once and a failed one is retried.
-- 2. The scheduler's write-back sweep runs under `system_task`: it reads the trigger settings, moves triggers and
--    records write-backs, so those policies gain `system_task`.

CREATE TABLE IF NOT EXISTS "pm_write_backs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger_id" uuid NOT NULL REFERENCES "pm_work_triggers"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "source_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_write_backs_kind_ck" CHECK ("kind" IN ('started', 'signoff_request', 'approval', 'pr_link', 'outcome')),
  CONSTRAINT "pm_write_backs_source_len_ck" CHECK (char_length("source_key") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_write_backs_key_uq" ON "pm_write_backs" ("trigger_id", "kind", "source_key");
--> statement-breakpoint
ALTER TABLE pm_write_backs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pm_write_backs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS pm_write_backs_all ON pm_write_backs;
--> statement-breakpoint
CREATE POLICY pm_write_backs_all ON pm_write_backs FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'system_task', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'system_task', 'migration'])
  );
--> statement-breakpoint
DROP POLICY IF EXISTS pm_trigger_settings_select ON pm_trigger_settings;
--> statement-breakpoint
CREATE POLICY pm_trigger_settings_select ON pm_trigger_settings FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'system_task', 'migration'])
);
--> statement-breakpoint
DROP POLICY IF EXISTS pm_work_triggers_all ON pm_work_triggers;
--> statement-breakpoint
CREATE POLICY pm_work_triggers_all ON pm_work_triggers FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'system_task', 'migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['approval_maintenance', 'pm_sync', 'system_task', 'migration'])
  );
