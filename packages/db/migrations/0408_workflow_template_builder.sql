-- ADR-0341: the visual pipeline builder — drafts and versions of workflow templates. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent. No change to an existing column.
--
-- 1. `workflow_template_versions`: every published version of a template, append-only (regulait_refuse_mutation plus
--    no TRUNCATE). `definition` is the point-in-time snapshot that went live; `content_hash` is SHA-256 of ADR-0060's
--    canonical JSON of it. `origin` 'baseline' is the live definition captured the first time a template is opened in
--    the builder (no backfill here: a template never opened in the builder has no history yet, and needs none).
-- 2. `workflow_template_drafts`: at most one open draft per template, with the version it was opened from and an
--    optimistic-concurrency revision. A configuration document, never executed.
-- Both are deployment-wide like `workflow_templates` (no tenant column, so no RLS policy); the routes are admin-only.
CREATE TABLE IF NOT EXISTS "workflow_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "definition" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "origin" text NOT NULL,
  "published_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_template_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "workflow_template_versions_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "workflow_template_versions_origin_check" CHECK ("origin" IN ('baseline', 'builder'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_versions_template_version_uq" ON "workflow_template_versions" ("template_id", "version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_template_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "definition" jsonb NOT NULL,
  "base_version_id" uuid NOT NULL REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_template_drafts_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "workflow_template_drafts_definition_check" CHECK (jsonb_typeof("definition") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_template_drafts_template_uq" ON "workflow_template_drafts" ("template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_template_drafts_base_version_idx" ON "workflow_template_drafts" ("base_version_id");
--> statement-breakpoint
-- versions are evidence of what went live when: append-only. The two-argument form lets the cascade of the row's OWN
-- parent through (a template deleted by a test fixture); the SET NULL of a removed user is let through by
-- regulait_refuse_mutation's own rule.
DROP TRIGGER IF EXISTS "workflow_template_versions_append_only" ON "workflow_template_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_template_versions_append_only" BEFORE UPDATE OR DELETE ON "workflow_template_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"('template_id', 'workflow_templates');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "workflow_template_versions_no_truncate" ON public."workflow_template_versions";
--> statement-breakpoint
CREATE TRIGGER "workflow_template_versions_no_truncate" BEFORE TRUNCATE ON public."workflow_template_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
