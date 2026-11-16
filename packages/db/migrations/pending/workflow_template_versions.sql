-- ADR-0340 slice 3 (lane E21): workflow template versions, instance pinning and governed in-flight migration.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. ADR-0048's `config_versions` learns the artifact type `workflow_template` (the 0095 precedent: drop the CHECK,
--    add it again with the new value). A template's versions are ordinary immutable version rows with the ADR-0048
--    activation ledger, canary and rollback.
-- 2. `workflow_instance_template_versions`: which version each instance runs (a row at start per template, a row per
--    applied migration). A join table, not an id list on the instance (ADR-0200 3NF).
-- 3. `workflow_instance_migrations`: a request to move one running instance to another version, decided in the one
--    approvals queue (kind `workflow_migration`). At most one open request per instance.
-- `regulait_app` gets DML on both tables through 0272's default privileges.

ALTER TABLE "config_versions" DROP CONSTRAINT IF EXISTS "config_versions_artifact_type_check";
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_artifact_type_check" CHECK ("artifact_type" IN (
  'agent_system_prompt','agent_config','approval_rule','rate_limit',
  'data_scope_rule','compliance_profile','workflow_template'
));

CREATE TABLE IF NOT EXISTS "workflow_instance_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
  "config_version_id" uuid REFERENCES "config_versions"("id") ON DELETE RESTRICT,
  "canary" boolean DEFAULT false NOT NULL,
  "via" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_instance_template_versions_via_check" CHECK ("via" IN ('start', 'migration'))
);
CREATE INDEX IF NOT EXISTS "workflow_instance_template_versions_instance_idx" ON "workflow_instance_template_versions" ("instance_id");
CREATE INDEX IF NOT EXISTS "workflow_instance_template_versions_version_idx" ON "workflow_instance_template_versions" ("config_version_id");

CREATE TABLE IF NOT EXISTS "workflow_instance_migrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "target_version_id" uuid NOT NULL REFERENCES "config_versions"("id") ON DELETE RESTRICT,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "plan" jsonb NOT NULL,
  "from_definition_sha256" text NOT NULL,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_instance_migrations_status_check" CHECK ("status" IN ('pending', 'applied', 'denied', 'stale')),
  CONSTRAINT "workflow_instance_migrations_sha_check" CHECK ("from_definition_sha256" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS "workflow_instance_migrations_instance_idx" ON "workflow_instance_migrations" ("instance_id");
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_instance_migrations_one_pending_uq" ON "workflow_instance_migrations" ("instance_id") WHERE "status" = 'pending';
