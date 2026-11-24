-- ADR-0357 §4 (lane E38, slice 2): business units and tighten-only policy layers (org → business unit → project →
-- use case). `governance_policy_layers.policy` is a schema-validated configuration document (governancePolicySchema),
-- one layer per level and subject, the subject a foreign key per level. Hand-authored, additive and idempotent. No
-- functions or triggers.
CREATE TABLE IF NOT EXISTS "business_units" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_units_name_uq" UNIQUE ("name")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "business_unit_id" uuid REFERENCES "business_units"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_business_unit_idx" ON "projects" ("business_unit_id") WHERE "business_unit_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "governance_policy_layers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "level" text NOT NULL,
  "business_unit_id" uuid REFERENCES "business_units"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "use_case_id" uuid REFERENCES "ai_use_cases"("id") ON DELETE CASCADE,
  "policy" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "governance_policy_layers_subject_check" CHECK (CASE "level"
    WHEN 'org' THEN "business_unit_id" IS NULL AND "project_id" IS NULL AND "use_case_id" IS NULL
    WHEN 'business_unit' THEN "business_unit_id" IS NOT NULL AND "project_id" IS NULL AND "use_case_id" IS NULL
    WHEN 'project' THEN "project_id" IS NOT NULL AND "business_unit_id" IS NULL AND "use_case_id" IS NULL
    WHEN 'use_case' THEN "use_case_id" IS NOT NULL AND "business_unit_id" IS NULL AND "project_id" IS NULL
    ELSE false END),
  CONSTRAINT "governance_policy_layers_policy_check" CHECK (jsonb_typeof("policy") = 'object' AND octet_length("policy"::text) <= 262144),
  CONSTRAINT "governance_policy_layers_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_layers_org_uq" ON "governance_policy_layers" ("level") WHERE "level" = 'org';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_layers_bu_uq" ON "governance_policy_layers" ("business_unit_id") WHERE "business_unit_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_layers_project_uq" ON "governance_policy_layers" ("project_id") WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "governance_policy_layers_use_case_uq" ON "governance_policy_layers" ("use_case_id") WHERE "use_case_id" IS NOT NULL;
--> statement-breakpoint
-- Row-level security (ADR-0234's admin-only shape): both tables are read and written only by the admin-only policy
-- routes, so a row is reachable only by an active admin principal or under the `migration` reason.
ALTER TABLE "business_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS business_units_all ON "business_units";
--> statement-breakpoint
CREATE POLICY business_units_all ON "business_units" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
--> statement-breakpoint
ALTER TABLE "governance_policy_layers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "governance_policy_layers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS governance_policy_layers_all ON "governance_policy_layers";
--> statement-breakpoint
CREATE POLICY governance_policy_layers_all ON "governance_policy_layers" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration']));
