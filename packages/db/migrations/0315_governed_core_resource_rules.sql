-- ADR-0251: one governed decision core for model, connector, MCP and A2A calls.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. resource_approval_rules: approval rules for model, connector and A2A calls. One subject dimension (the same
--    scope discriminant as approval_rules) and one resource binding: the resource type, plus at most one foreign key
--    that must match the type; no key = every resource of that type. The MCP tool path's approval_rules are untouched.
-- 2. resource_rate_limits: rate limits for connector and A2A calls, with the same subject and resource binding.
--    Models keep model_rate_limits (ADR-0212), so one fact stays in one place.
-- 3. org_settings: the attribution mandate for connector and A2A calls, TRUE by default (ADR-0180); an admin may
--    relax either (settings_relax step-up, audited).
-- 4. org_settings.model_rate_limits_enabled: TRUE by default, and the existing row is set TRUE (ADR-0180: the product
--    is not live, so nothing is grandfathered). No row in model_rate_limits = nothing is limited.
-- 5. audit_log: a partial index for the window counts (allowed decisions per user, resource and time).
-- No functions or triggers are added (zz-dbguard-0185 checked by hand).

CREATE TABLE IF NOT EXISTS "resource_approval_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "resource_type" text NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "a2a_agent_id" uuid REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "scope" text DEFAULT 'user' NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid REFERENCES "roles"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "write_only" boolean DEFAULT false NOT NULL,
  "approver_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_approval_rules_type_ck" CHECK (CASE resource_type
    WHEN 'model' THEN connector_id IS NULL AND a2a_agent_id IS NULL
    WHEN 'connector' THEN agent_id IS NULL AND a2a_agent_id IS NULL
    WHEN 'a2a' THEN agent_id IS NULL AND connector_id IS NULL
    ELSE false END),
  CONSTRAINT "resource_approval_rules_scope_ck" CHECK (CASE scope
    WHEN 'user' THEN user_id IS NOT NULL AND role_id IS NULL AND team_id IS NULL
    WHEN 'role' THEN role_id IS NOT NULL AND user_id IS NULL AND team_id IS NULL
    WHEN 'team' THEN team_id IS NOT NULL AND user_id IS NULL AND role_id IS NULL
    WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL
    ELSE false END)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_approval_rules_type_idx" ON "resource_approval_rules" ("resource_type", "scope");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "resource_type" text NOT NULL,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "a2a_agent_id" uuid REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "scope" text DEFAULT 'user' NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid REFERENCES "roles"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "max_calls" integer NOT NULL,
  "window_seconds" integer NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_rate_limits_type_ck" CHECK (CASE resource_type
    WHEN 'connector' THEN a2a_agent_id IS NULL
    WHEN 'a2a' THEN connector_id IS NULL
    ELSE false END),
  CONSTRAINT "resource_rate_limits_scope_ck" CHECK (CASE scope
    WHEN 'user' THEN user_id IS NOT NULL AND role_id IS NULL AND team_id IS NULL
    WHEN 'role' THEN role_id IS NOT NULL AND user_id IS NULL AND team_id IS NULL
    WHEN 'team' THEN team_id IS NOT NULL AND user_id IS NULL AND role_id IS NULL
    WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL
    ELSE false END),
  CONSTRAINT "resource_rate_limits_max_calls_check" CHECK ("max_calls" BETWEEN 1 AND 1000000),
  CONSTRAINT "resource_rate_limits_window_check" CHECK ("window_seconds" BETWEEN 1 AND 2592000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_rate_limits_type_idx" ON "resource_rate_limits" ("resource_type", "scope");--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "connector_attribution_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "a2a_attribution_required" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "model_rate_limits_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "org_settings" SET "model_rate_limits_enabled" = true WHERE "model_rate_limits_enabled" = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_resource_window_idx" ON "audit_log" ("user_id", "object_type", "object_id", "at") WHERE "effect" = 'allow';
