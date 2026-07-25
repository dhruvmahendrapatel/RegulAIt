CREATE TABLE "orchestration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"initiating_user_id" uuid NOT NULL,
	"workflow_instance_id" uuid,
	"graph" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestration_runs" ADD CONSTRAINT "orchestration_runs_initiating_user_id_users_id_fk" FOREIGN KEY ("initiating_user_id") REFERENCES "users"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "orchestration_runs" ADD CONSTRAINT "orchestration_runs_workflow_instance_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "orchestration_runs_user_idx" ON "orchestration_runs" ("initiating_user_id");
--> statement-breakpoint
CREATE TABLE "orchestration_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestration_run_events" ADD CONSTRAINT "orchestration_run_events_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "orchestration_runs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "orchestration_run_events_run_idx" ON "orchestration_run_events" ("run_id");
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "run_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "orchestration_runs"("id") ON DELETE cascade;
