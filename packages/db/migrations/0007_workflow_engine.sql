ALTER TABLE "approvals" ALTER COLUMN "server_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "tool_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "rule_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "object_type" text DEFAULT 'mcp_tool' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "instance_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "stage_id" text;
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "workflow_assignment_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"path_pattern" text,
	"change_type" text,
	"environment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_ids" jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"change" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"stage_id" text NOT NULL,
	"output" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_assignment_rules" ADD CONSTRAINT "workflow_assignment_rules_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workflow_instances_status_idx" ON "workflow_instances" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "workflow_events_instance_idx" ON "workflow_events" USING btree ("instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_artifacts_instance_output_version_uq" ON "workflow_artifacts" USING btree ("instance_id","output","version");
