-- ADR-0224 (P13 c): privacy operations, part 1 — the org switch and the record of processing.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `org_settings.privacy_ops_enabled` ships false (owner, 10-30): nothing is limited until an admin turns it on.
--    `dsr_sla_days` is the due date of a data-subject request; 30 is the strict default.
-- 2. `processing_records`: purpose, lawful basis, data categories, retention and recipients, linked to a project, a
--    use case or both. Only an `active` record permits anything; nothing is backfilled, so an upgraded database has
--    none and, once the switch is on, personal data in a dispatch is refused until a record permits it (ADR-0180).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "privacy_ops_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "dsr_sla_days" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_dsr_sla_days_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_dsr_sla_days_check" CHECK ("dsr_sla_days" BETWEEN 1 AND 90);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processing_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "purpose" text NOT NULL,
  "lawful_basis" text NOT NULL,
  "data_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "retention_days" integer NOT NULL,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "processing_records_link_check" CHECK ("project_id" IS NOT NULL OR "use_case_id" IS NOT NULL),
  CONSTRAINT "processing_records_status_check" CHECK ("status" IN ('active', 'retired')),
  CONSTRAINT "processing_records_lawful_basis_check" CHECK ("lawful_basis" IN ('consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests')),
  CONSTRAINT "processing_records_retention_check" CHECK ("retention_days" BETWEEN 1 AND 36500),
  CONSTRAINT "processing_records_categories_check" CHECK (jsonb_typeof("data_categories") = 'array'),
  CONSTRAINT "processing_records_recipients_check" CHECK (jsonb_typeof("recipients") = 'array')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_records_project_idx" ON "processing_records" ("project_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_records_use_case_idx" ON "processing_records" ("use_case_id") WHERE "status" = 'active';
