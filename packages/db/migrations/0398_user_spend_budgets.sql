-- ADR-0312 (pilot addendum, lane E2): a person's spend budget, alert only. Hand-authored (never drizzle-kit generate),
-- additive and idempotent. The governance monitor's `user_budget_threshold` rule (and its five-minute spend pass)
-- raises an alert when the person's metered spend in the window reaches `alert_threshold_pct` of `budget_usd`.
-- Nothing is refused on it. Monthly by default. No functions or triggers. No row of an RLS table is read or written here.
--
-- Secure by default (ADR-0180, ADR-0234): each row is one person's budget, so row-level security is ENABLED and
-- FORCED. An admin, the spend pass (`system_task`) and `migration` read every row; any other principal reads only its
-- own (`GET /v1/users/:userId/spend-budget`), so a handler bug cannot expose another person's budget. Only an admin
-- or `migration` may insert, update or delete. A transaction with no principal and no system context sees zero rows.
CREATE TABLE IF NOT EXISTS "user_spend_budgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "budget_usd" double precision NOT NULL,
  "budget_period" text DEFAULT 'monthly' NOT NULL,
  "alert_threshold_pct" integer DEFAULT 80 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_spend_budgets_budget_check" CHECK ("budget_usd" > 0 AND "budget_usd" <= 10000000),
  CONSTRAINT "user_spend_budgets_pct_check" CHECK ("alert_threshold_pct" BETWEEN 1 AND 100),
  CONSTRAINT "user_spend_budgets_period_check" CHECK ("budget_period" IN ('monthly', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_spend_budgets_user_uq" ON "user_spend_budgets" ("user_id");
--> statement-breakpoint
ALTER TABLE "user_spend_budgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_spend_budgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS user_spend_budgets_select ON "user_spend_budgets";
--> statement-breakpoint
CREATE POLICY user_spend_budgets_select ON "user_spend_budgets" FOR SELECT USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration'])
  OR "user_id" = (SELECT regulait_rls_user_id())
);
--> statement-breakpoint
DROP POLICY IF EXISTS user_spend_budgets_insert ON "user_spend_budgets";
--> statement-breakpoint
CREATE POLICY user_spend_budgets_insert ON "user_spend_budgets" FOR INSERT WITH CHECK (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = 'migration'
);
--> statement-breakpoint
DROP POLICY IF EXISTS user_spend_budgets_update ON "user_spend_budgets";
--> statement-breakpoint
CREATE POLICY user_spend_budgets_update ON "user_spend_budgets" FOR UPDATE
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration')
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = 'migration');
--> statement-breakpoint
DROP POLICY IF EXISTS user_spend_budgets_delete ON "user_spend_budgets";
--> statement-breakpoint
CREATE POLICY user_spend_budgets_delete ON "user_spend_budgets" FOR DELETE USING (
  (SELECT regulait_rls_is_admin())
  OR (SELECT regulait_rls_system_reason()) = 'migration'
);
