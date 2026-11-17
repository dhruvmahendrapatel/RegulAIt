-- ADR-0341 follow-up (Camunda gap row 10): the sub-process catalogue. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. No change to an existing column. Needs workflow_template_builder first.
--
-- 1. `workflow_fragments`: a named, reusable sub-process. Never deleted by a route.
-- 2. `workflow_fragment_versions`: every proposed version, append-only. Its state is the status of its Approvals Queue
--    row (`approval_id`), not a column here; a removed approval row leaves it null, which reads as rejected.
-- 3. `workflow_template_version_fragments`: which fragment version each call stage of a published template version
--    pinned. Append-only; it goes with its template version.
-- All are deployment-wide like `workflow_templates` (no tenant column, so no RLS policy); the routes are admin-only.
CREATE TABLE IF NOT EXISTS "workflow_fragments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_fragments_name_check" CHECK (char_length("name") BETWEEN 1 AND 100),
  CONSTRAINT "workflow_fragments_description_check" CHECK ("description" IS NULL OR char_length("description") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_fragments_name_uq" ON "workflow_fragments" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_fragment_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fragment_id" uuid NOT NULL REFERENCES "workflow_fragments"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "stages" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "proposed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_fragment_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "workflow_fragment_versions_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workflow_fragment_versions_stages_check" CHECK (jsonb_typeof("stages") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_fragment_versions_fragment_version_uq" ON "workflow_fragment_versions" ("fragment_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_fragment_versions_approval_uq" ON "workflow_fragment_versions" ("approval_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_template_version_fragments" (
  "template_version_id" uuid NOT NULL REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE,
  "call_stage_id" text NOT NULL,
  "fragment_version_id" uuid NOT NULL REFERENCES "workflow_fragment_versions"("id") ON DELETE RESTRICT,
  CONSTRAINT "workflow_template_version_fragments_pk" PRIMARY KEY ("template_version_id", "call_stage_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_template_version_fragments_fragment_version_idx" ON "workflow_template_version_fragments" ("fragment_version_id");
--> statement-breakpoint
-- the record of what was approved and what a template version was built from: append-only. The two-argument form
-- lets the cascade of the row's OWN parent through; the SET NULL of a removed user or approval row is let through by
-- regulait_refuse_mutation's own rule.
DROP TRIGGER IF EXISTS "workflow_fragment_versions_append_only" ON "workflow_fragment_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_fragment_versions_append_only" BEFORE UPDATE OR DELETE ON "workflow_fragment_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('fragment_id', 'workflow_fragments');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_fragment_versions_no_truncate" ON public."workflow_fragment_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_fragment_versions_no_truncate" BEFORE TRUNCATE ON public."workflow_fragment_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_template_version_fragments_append_only" ON "workflow_template_version_fragments";
--> statement-breakpoint
CREATE TRIGGER "workflow_template_version_fragments_append_only" BEFORE UPDATE OR DELETE ON "workflow_template_version_fragments"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('template_version_id', 'workflow_template_versions');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_template_version_fragments_no_truncate" ON public."workflow_template_version_fragments";
--> statement-breakpoint
CREATE TRIGGER "workflow_template_version_fragments_no_truncate" BEFORE TRUNCATE ON public."workflow_template_version_fragments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
