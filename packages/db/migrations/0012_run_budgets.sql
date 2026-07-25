ALTER TABLE "user_agent_policies" ADD COLUMN "run_budget_usd" double precision;
--> statement-breakpoint
ALTER TABLE "user_agent_policies" ADD COLUMN "run_budget_breach_action" text DEFAULT 'approve' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orchestration_runs" ADD COLUMN "budget" jsonb;
