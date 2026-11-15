-- ADR-0312 (pilot addendum, lane E2): a person's spend budget, alert only. Hand-authored (never drizzle-kit generate),
-- additive and idempotent. The governance monitor's `user_budget_threshold` rule (and its five-minute spend pass)
-- raises an alert when the person's metered spend in the window reaches `alert_threshold_pct` of `budget_usd`.
-- Nothing is refused on it. Monthly by default. An admin register like the other budget columns, so no RLS tenant
-- column (single-tenant). No functions or triggers. No row of an RLS table is read or written here.
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
