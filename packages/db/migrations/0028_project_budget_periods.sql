ALTER TABLE "projects" ADD COLUMN "budget_period" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "alert_threshold_pct" integer DEFAULT 100 NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "overage_approved_period" text;
