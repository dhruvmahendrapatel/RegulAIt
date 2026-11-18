-- ADR-0350 (lane E31): endpoint device groups and time-limited per-device command-rule exceptions.
--
-- Third normal form: a group, its device memberships (a join table to endpoint_devices), its narrowing rules (ask or
-- deny only; `rule` is a schema-validated configuration document, ADR-0200 exception), and exceptions, each relaxing
-- one rule on one device until `not_after`. The exception lifecycle is @regulait/shared ENDPOINT_COMMAND_EXCEPTION_MACHINE (ADR-0348);
-- `expired` is derived from `not_after` and never stored. Nobody approves their own exception (CHECK), an approved
-- exception always has an expiry no later than `hours` after the decision (CHECK), and the approval names the
-- ADR-0104 digest of the exact terms. The terms are frozen once written (trigger below): only the status and the
-- decision and revoke columns move, so the digest an approver approves is always the digest of the row (review #964).
--
-- Row-level security, ENABLED and FORCED on every table: an active admin principal (regulait_rls_is_admin()) and the
-- `system_task` and `migration` reasons only.
CREATE TABLE IF NOT EXISTS "endpoint_device_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_device_groups_name_check" CHECK (length("name") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_device_groups_name_uq" ON "endpoint_device_groups" ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_device_group_members" (
  "group_id" uuid NOT NULL REFERENCES "endpoint_device_groups"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_device_group_members_group_id_device_id_pk" PRIMARY KEY ("group_id", "device_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_device_group_members_device_idx" ON "endpoint_device_group_members" ("device_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_device_group_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL REFERENCES "endpoint_device_groups"("id") ON DELETE CASCADE,
  "rule_id" text NOT NULL,
  "kind" text NOT NULL,
  "rule" jsonb NOT NULL,
  "verdict" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_device_group_rules_rule_id_check" CHECK ("rule_id" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT "endpoint_device_group_rules_kind_check" CHECK ("kind" IN ('exec', 'file', 'package')),
  CONSTRAINT "endpoint_device_group_rules_verdict_check" CHECK ("verdict" IN ('ask', 'deny')),
  CONSTRAINT "endpoint_device_group_rules_rule_check" CHECK (jsonb_typeof("rule") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_device_group_rules_rule_uq" ON "endpoint_device_group_rules" ("group_id", "rule_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_command_exceptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "rule_id" text NOT NULL,
  "verdict" text NOT NULL,
  "hours" integer NOT NULL,
  "reason" text NOT NULL,
  "terms_digest" text NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "users"("id"),
  "approver_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "status" text DEFAULT 'requested' NOT NULL,
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "not_after" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id"),
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_command_exceptions_rule_id_check" CHECK ("rule_id" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  CONSTRAINT "endpoint_command_exceptions_verdict_check" CHECK ("verdict" IN ('allow', 'ask')),
  CONSTRAINT "endpoint_command_exceptions_hours_check" CHECK ("hours" BETWEEN 1 AND 168),
  CONSTRAINT "endpoint_command_exceptions_reason_check" CHECK (length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "endpoint_command_exceptions_digest_check" CHECK ("terms_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_command_exceptions_status_check" CHECK ("status" IN ('requested', 'approved', 'rejected', 'cancelled', 'revoked')),
  CONSTRAINT "endpoint_command_exceptions_approver_check" CHECK ("approver_user_id" <> "requested_by"),
  CONSTRAINT "endpoint_command_exceptions_decider_check" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by" OR "status" = 'cancelled'),
  CONSTRAINT "endpoint_command_exceptions_revoked_check" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL)),
  CONSTRAINT "endpoint_command_exceptions_expiry_check" CHECK (("status" = 'approved' OR "status" = 'revoked') = ("not_after" IS NOT NULL) AND ("not_after" IS NULL OR "not_after" <= "decided_at" + make_interval(hours => "hours")))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_command_exceptions_device_idx" ON "endpoint_command_exceptions" ("device_id", "status");
--> statement-breakpoint
ALTER TABLE "endpoint_device_groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_device_groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_device_groups_admin" ON "endpoint_device_groups";
--> statement-breakpoint
CREATE POLICY "endpoint_device_groups_admin" ON "endpoint_device_groups" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_device_group_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_device_group_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_device_group_members_admin" ON "endpoint_device_group_members";
--> statement-breakpoint
CREATE POLICY "endpoint_device_group_members_admin" ON "endpoint_device_group_members" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_device_group_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_device_group_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_device_group_rules_admin" ON "endpoint_device_group_rules";
--> statement-breakpoint
CREATE POLICY "endpoint_device_group_rules_admin" ON "endpoint_device_group_rules" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_command_exceptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_command_exceptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_command_exceptions_admin" ON "endpoint_command_exceptions";
--> statement-breakpoint
CREATE POLICY "endpoint_command_exceptions_admin" ON "endpoint_command_exceptions" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regulait_endpoint_exception_terms_frozen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."device_id" IS DISTINCT FROM OLD."device_id"
     OR NEW."rule_id" IS DISTINCT FROM OLD."rule_id"
     OR NEW."verdict" IS DISTINCT FROM OLD."verdict"
     OR NEW."hours" IS DISTINCT FROM OLD."hours"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."terms_digest" IS DISTINCT FROM OLD."terms_digest"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."approver_user_id" IS DISTINCT FROM OLD."approver_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'endpoint_command_exceptions: the terms of an exception cannot change (ADR-0350)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_command_exceptions_terms_frozen" ON "endpoint_command_exceptions";
--> statement-breakpoint
CREATE TRIGGER "endpoint_command_exceptions_terms_frozen"
  BEFORE UPDATE ON "endpoint_command_exceptions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_endpoint_exception_terms_frozen"();
