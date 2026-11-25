-- ADR-0349 slice 4 (lane E30): workflow schedules. Hand-authored (never drizzle-kit generate). Re-runnable.
--
-- Both tables are deployment-wide like `workflow_templates` (no tenant column, so no RLS policy); every route is
-- admin-only. `regulait_app` DML comes from migration 0272's default privileges. No function or trigger is created.
CREATE TABLE IF NOT EXISTS "workflow_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "cron_expression" text NOT NULL,
  "time_zone" text DEFAULT 'UTC' NOT NULL,
  "change" jsonb NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "work_item_ref" text,
  "run_as_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "overlap_policy" text DEFAULT 'skip' NOT NULL,
  "catchup_window_seconds" integer DEFAULT 0 NOT NULL,
  "jitter_seconds" integer DEFAULT 0 NOT NULL,
  "next_fire_at" timestamp with time zone,
  "buffered_fire_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "paused_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "pause_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_schedules_overlap_check" CHECK ("overlap_policy" IN ('skip', 'buffer_one', 'allow')),
  CONSTRAINT "workflow_schedules_catchup_check" CHECK ("catchup_window_seconds" BETWEEN 0 AND 604800),
  CONSTRAINT "workflow_schedules_jitter_check" CHECK ("jitter_seconds" BETWEEN 0 AND 3600),
  CONSTRAINT "workflow_schedules_name_check" CHECK (char_length("name") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_schedules_name_uq" ON "workflow_schedules" ("name");
CREATE INDEX IF NOT EXISTS "workflow_schedules_template_idx" ON "workflow_schedules" ("template_id");
CREATE INDEX IF NOT EXISTS "workflow_schedules_due_idx" ON "workflow_schedules" ("next_fire_at") WHERE "paused_at" IS NULL;

CREATE TABLE IF NOT EXISTS "workflow_schedule_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL REFERENCES "workflow_schedules"("id") ON DELETE CASCADE,
  "fire_at" timestamp with time zone NOT NULL,
  "trigger" text NOT NULL,
  "outcome" text NOT NULL,
  "instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "refusal" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_schedule_runs_trigger_check" CHECK ("trigger" IN ('scheduled', 'buffered', 'backfill')),
  CONSTRAINT "workflow_schedule_runs_outcome_check"
    CHECK ("outcome" IN ('starting', 'started', 'reused', 'skipped_overlap', 'buffered', 'skipped_missed', 'refused'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_schedule_runs_fire_uq" ON "workflow_schedule_runs" ("schedule_id", "fire_at");
CREATE INDEX IF NOT EXISTS "workflow_schedule_runs_instance_idx" ON "workflow_schedule_runs" ("instance_id");
