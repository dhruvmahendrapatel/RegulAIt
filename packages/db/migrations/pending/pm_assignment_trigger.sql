-- ADR-0317 (lane L6, gap G4): RegulAIt assignable from Jira and Azure Boards.
--
-- pm_assignment_triggers  one per PM connection: OFF by default (ADR-0180); when enabled, assigning, @mentioning or a
--                         tool-side rule addressing the agent identity starts the pillar-2 workflow for the item.
-- pm_identity_links       admin-managed mapping of a PM tool user to the RegulAIt user it is; an assignment acts as
--                         exactly that user (never more).
-- pm_assignment_starts    the claim: at most one started workflow per work item per connection.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand). Nothing backfilled.
CREATE TABLE IF NOT EXISTS "pm_assignment_triggers" (
  "connection_id" uuid PRIMARY KEY NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "agent_ref" text NOT NULL,
  "change_type" text NOT NULL,
  "environment" text NOT NULL,
  "target_system" text,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_assignment_triggers_agent_ref_len" CHECK (char_length("agent_ref") BETWEEN 1 AND 256),
  CONSTRAINT "pm_assignment_triggers_change_type_len" CHECK (char_length("change_type") BETWEEN 1 AND 128),
  CONSTRAINT "pm_assignment_triggers_environment_len" CHECK (char_length("environment") BETWEEN 1 AND 128),
  CONSTRAINT "pm_assignment_triggers_target_system_len" CHECK ("target_system" IS NULL OR char_length("target_system") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_assignment_triggers_project_idx" ON "pm_assignment_triggers" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_assignment_triggers_updated_by_idx" ON "pm_assignment_triggers" ("updated_by_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "external_user_id" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_identity_links_external_len" CHECK (char_length("external_user_id") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_identity_links_conn_external_uq" ON "pm_identity_links" ("connection_id", "external_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_identity_links_conn_user_uq" ON "pm_identity_links" ("connection_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_identity_links_user_idx" ON "pm_identity_links" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_identity_links_created_by_idx" ON "pm_identity_links" ("created_by_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pm_assignment_starts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "workflow_instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "initiator_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "actor_external_id" text NOT NULL,
  "trigger" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_assignment_starts_external_len" CHECK (char_length("external_id") BETWEEN 1 AND 256),
  CONSTRAINT "pm_assignment_starts_actor_len" CHECK (char_length("actor_external_id") BETWEEN 1 AND 256),
  CONSTRAINT "pm_assignment_starts_trigger_check" CHECK ("trigger" IN ('assigned', 'mentioned', 'automation'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_assignment_starts_conn_external_uq" ON "pm_assignment_starts" ("connection_id", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_assignment_starts_instance_idx" ON "pm_assignment_starts" ("workflow_instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_assignment_starts_initiator_idx" ON "pm_assignment_starts" ("initiator_user_id");
