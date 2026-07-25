CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"cost_center" text,
	"budget_usd" double precision,
	"budget_approver_user_id" uuid,
	"overage_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_budget_approver_user_id_users_id_fk" FOREIGN KEY ("budget_approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "orchestration_runs" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "project_id" uuid;
