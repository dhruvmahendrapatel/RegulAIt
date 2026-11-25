-- ADR-0337 §5 (lane E18, slice 3): observed use of SaaS entitlements. Hand-authored (never drizzle-kit generate);
-- additive and idempotent. Runs after `saas_entitlement_graph` (byte order of the pending names).
--
--   saas_entitlement_usage_reads  one row per discovery source: how finely its latest read could observe use
--                                 (`none` | `app` | `verb`), from when, and why (a plain note). Replaced by each read.
--   saas_entitlement_app_usage    one row per app: its latest observed use, and its latest read and write where the
--                                 coverage tells them apart. Times only move forward.
--
--   discovery_settings.salesforce_org_tokens_enabled  the org switch (off) a Salesforce source needs before it may read the
--                                 org-wide OAuth tokens (owner decision 2026-11-22: Customize Application only by opt-in).
--   saas_entitlement_usage_reads.activity_log_state   what the latest read saw of Microsoft 365's guided activity-log
--                                 setup (null for other platforms); an observation each read replaces.
--
-- Nothing is copied: the platform is the source's kind, the app is an FK. No person is named (use is per app).
-- Row-level security, ENABLED and FORCED: an active admin principal and the `system_task` and `migration` reasons
-- only, as the other ADR-0337 tables. Deleting a source or an app cascades. No functions or triggers.

CREATE TABLE IF NOT EXISTS "saas_entitlement_usage_reads" (
  "source_id" uuid PRIMARY KEY NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "coverage" text NOT NULL,
  "window_start" timestamp with time zone,
  "note" text NOT NULL,
  "activity_log_state" text,
  "recorded_at" timestamp with time zone NOT NULL,
  "run_id" uuid REFERENCES "discovery_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "saas_entitlement_usage_reads_coverage_check" CHECK ("coverage" IN ('none', 'app', 'verb')),
  CONSTRAINT "saas_entitlement_usage_reads_activity_log_state_check" CHECK ("activity_log_state" IS NULL OR "activity_log_state" IN ('off', 'not_enabled', 'unreadable', 'no_activity_yet', 'flowing')),
  CONSTRAINT "saas_entitlement_usage_reads_note_check" CHECK (length("note") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saas_entitlement_app_usage" (
  "app_id" uuid PRIMARY KEY NOT NULL REFERENCES "saas_entitlement_apps"("id") ON DELETE CASCADE,
  "last_use_at" timestamp with time zone NOT NULL,
  "last_read_at" timestamp with time zone,
  "last_write_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "saas_entitlement_app_usage_last_use_check" CHECK ("last_use_at" >= coalesce("last_read_at", "last_use_at") AND "last_use_at" >= coalesce("last_write_at", "last_use_at"))
);
--> statement-breakpoint
ALTER TABLE "saas_entitlement_usage_reads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_usage_reads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_usage_reads_admin" ON "saas_entitlement_usage_reads";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_usage_reads_admin" ON "saas_entitlement_usage_reads" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "saas_entitlement_app_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_entitlement_app_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "saas_entitlement_app_usage_admin" ON "saas_entitlement_app_usage";
--> statement-breakpoint
CREATE POLICY "saas_entitlement_app_usage_admin" ON "saas_entitlement_app_usage" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "salesforce_org_tokens_enabled" boolean DEFAULT false NOT NULL;
