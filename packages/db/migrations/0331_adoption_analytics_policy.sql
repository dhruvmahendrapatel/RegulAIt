-- ADR-0358 (lane E39): the AI adoption-analytics privacy policy, one row.
--
-- Strict by default (ADR-0180): per-person ranking off, counts of people below min_cohort_size (5) suppressed. A
-- missing row reads as the defaults; the gateway inserts it on the first audited write.
--
-- Row-level security, ENABLED and FORCED: an active admin principal (regulait_rls_is_admin()) and the `system_task`
-- and `migration` reasons only.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "adoption_analytics_policy" (
  "id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
  "per_person_ranking" boolean DEFAULT false NOT NULL,
  "min_cohort_size" integer DEFAULT 5 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "adoption_analytics_policy_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "adoption_analytics_policy_cohort_check" CHECK ("min_cohort_size" BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "adoption_analytics_policy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "adoption_analytics_policy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "adoption_analytics_policy_admin" ON "adoption_analytics_policy";
--> statement-breakpoint
CREATE POLICY "adoption_analytics_policy_admin" ON "adoption_analytics_policy" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
