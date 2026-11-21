-- Pending migration endpoint_addon_removal (numbered at merge, ADR-0252). ADR-0331: the governed removal of flagged MCP
-- servers from endpoints, through one signed, typed directive the ADR-0195 SD4 endpoint agent verifies before acting.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `discovery_settings.endpoint_addon_removal_enabled`: the org switch, default false (ADR-0180 first-load posture).
--    Turning it on is a `settings_relax` step-up, audited; turning it off is free. While it is off no directive is
--    created or delivered, pending ones included.
-- 2. The step-up kind `endpoint_remediation`: starting a removal is bound to its own kind, so no other grant authorises
--    one and an `endpoint_remediation` grant authorises nothing else. The three kind CHECKs carry all ten kinds (0203's
--    nine, `pseudonym_reveal` and `key_management` included); another migration that rewrites them must carry every
--    kind listed here. The existing org row requires the new kind too (first load, no grandfathering).
-- 3. `endpoint_addon_removals`: one admin-started removal of one MCP server identity (the request). Its `status` is
--    ADR-0348's `endpoint_addon_removal` machine: it is sent to no device until a second administrator decides its
--    ADR-0186 approval (`approval_id`, whose arguments digest binds the request and the resolved target set).
-- 4. `endpoint_addon_removal_targets`: the endpoint config entries a removal resolved to, written when it is approved
--    (never before), each one signed
--    directive (its id is the directive's `directiveId`), with the outcome the device reported. Each is bound to the
--    agent identity (one device user) whose signed report last showed the entry: config paths are relative to that
--    user's home, so only that identity's agent is served it or may report it. The device is reached through the
--    identity (third normal form), not copied.
--
--    Its `status` is ADR-0348's `endpoint_addon_target` machine; the one CHECK listing the states is
--    `…_status_check`, and `…_evidence_check` says what each state carries.
-- 5. Row-level security, ENABLEd and FORCEd on all three tables (as the ADR-0332 inventory tables): an admin principal, or
--    the `system_task` reason, reaches them. The endpoint agent's routes enter `system_task` for their one narrow read
--    and outcome write, and scope every row to the calling agent's own identity in the query itself.
--
-- No function or trigger, so the 0185 guards have nothing new to check; the 0272 default privileges give
-- `regulait_app` its grants.

ALTER TABLE "discovery_settings" ADD COLUMN IF NOT EXISTS "endpoint_addon_removal_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "step_up_grants" DROP CONSTRAINT IF EXISTS "step_up_grants_action_kind_check";
--> statement-breakpoint
ALTER TABLE "step_up_grants" ADD CONSTRAINT "step_up_grants_action_kind_check" CHECK (
  "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage', 'pseudonym_reveal', 'key_management', 'endpoint_remediation')
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT IF EXISTS "webauthn_challenges_action_kind_check";
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_action_kind_check" CHECK (
  "action_kind" IS NULL
  OR "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage', 'pseudonym_reveal', 'key_management', 'endpoint_remediation')
);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_step_up_actions_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_actions_check" CHECK (
  jsonb_typeof("step_up_actions") = 'array'
  AND "step_up_actions" <@ '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management", "endpoint_remediation"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "step_up_actions" SET DEFAULT '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management", "endpoint_remediation"]'::jsonb;
--> statement-breakpoint
-- first load (ADR-0180): the existing row requires the new kind too; the append keeps every kind already in the row
UPDATE "org_settings" SET "step_up_actions" = "step_up_actions" || '["endpoint_remediation"]'::jsonb
  WHERE NOT ("step_up_actions" ? 'endpoint_remediation');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_removals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "action" text DEFAULT 'remove_mcp_server' NOT NULL,
  "identity_kind" text NOT NULL,
  "identity" text NOT NULL,
  "package_version" text,
  "server_name" text,
  "scope_kind" text NOT NULL,
  -- the look-back of a `recent` scope, in days; null for the other scopes
  "scope_days" integer,
  "block_reinstall" boolean DEFAULT true NOT NULL,
  "reason" text NOT NULL,
  -- every directive of this removal is valid until here (ADR-0331 section 4)
  "expires_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'awaiting_approval' NOT NULL,
  -- the ADR-0186 approval a second administrator decides (its decision, who and when, lives on that row)
  "approval_id" uuid NOT NULL REFERENCES "approvals"("id") ON DELETE RESTRICT,
  "cancelled_at" timestamp with time zone,
  "cancelled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "endpoint_addon_removals_approval_uq" UNIQUE ("approval_id"),
  CONSTRAINT "endpoint_addon_removals_status_check" CHECK ("status" IN ('awaiting_approval', 'active', 'denied', 'stale', 'cancelled')),
  CONSTRAINT "endpoint_addon_removals_cancelled_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)),
  CONSTRAINT "endpoint_addon_removals_action_check" CHECK ("action" IN ('remove_mcp_server')),
  CONSTRAINT "endpoint_addon_removals_identity_check" CHECK (
    "identity_kind" IN ('package', 'host', 'command') AND char_length("identity") BETWEEN 1 AND 255
    AND ("package_version" IS NULL OR char_length("package_version") BETWEEN 1 AND 64)
    AND ("server_name" IS NULL OR "server_name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')),
  CONSTRAINT "endpoint_addon_removals_scope_check" CHECK (
    "scope_kind" IN ('device', 'devices', 'recent') AND ("scope_kind" = 'recent') = ("scope_days" IS NOT NULL)
    AND ("scope_days" IS NULL OR "scope_days" BETWEEN 1 AND 90)),
  CONSTRAINT "endpoint_addon_removals_reason_check" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "endpoint_addon_removals_expiry_check" CHECK ("expires_at" = "created_at" + interval '7 days'),
  CONSTRAINT "endpoint_addon_removals_cancel_check" CHECK (
    ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at") AND ("cancelled_by" IS NULL OR "cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_removals_created_idx" ON "endpoint_addon_removals" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_removals_identity_idx" ON "endpoint_addon_removals" ("identity_kind", "identity");
--> statement-breakpoint
-- the devices a `device` or `devices` scope names (a join table, not an id array): the approval re-resolves the
-- targets from them
CREATE TABLE IF NOT EXISTS "endpoint_addon_removal_devices" (
  "removal_id" uuid NOT NULL REFERENCES "endpoint_addon_removals"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  CONSTRAINT "endpoint_addon_removal_devices_pk" PRIMARY KEY ("removal_id", "device_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_removal_devices_device_idx" ON "endpoint_addon_removal_devices" ("device_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_addon_removal_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "removal_id" uuid NOT NULL REFERENCES "endpoint_addon_removals"("id") ON DELETE CASCADE,
  -- a reference (not a copy): the identity whose report last showed the entry; its device is endpoint_agent_identities.device_id
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  -- exception (ADR-0200 addendum): point-in-time evidence copies of the `endpoint_mcp_servers` row the target was
  -- resolved from (that row is refreshed or pruned by later reports; the directive must name what was seen)
  "signature_id" text NOT NULL,
  "provider" text NOT NULL,
  "config_root" text NOT NULL,
  "config_path" text NOT NULL,
  "server_name" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "code" text,
  "notified" boolean,
  "delivered_at" timestamp with time zone,
  "reported_at" timestamp with time zone,
  CONSTRAINT "endpoint_addon_removal_targets_entry_uq" UNIQUE ("removal_id", "identity_id", "config_root", "config_path", "server_name"),
  CONSTRAINT "endpoint_addon_removal_targets_shape_check" CHECK (
    char_length("signature_id") BETWEEN 1 AND 128 AND char_length("provider") BETWEEN 1 AND 64
    AND "config_root" IN ('home', 'appdata', 'localappdata') AND char_length("config_path") BETWEEN 1 AND 1024
    AND "server_name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  -- the one CHECK listing the states (ADR-0348: equal to the endpoint_addon_target machine's states)
  CONSTRAINT "endpoint_addon_removal_targets_status_check" CHECK (
    "status" IN ('pending', 'delivered', 'removed', 'nothing_to_remove', 'failed', 'cancelled')),
  -- what each state carries; the codes are ORs, not IN, so this is not a second state list
  CONSTRAINT "endpoint_addon_removal_targets_evidence_check" CHECK (CASE "status"
    WHEN 'pending' THEN "delivered_at" IS NULL AND "reported_at" IS NULL AND "code" IS NULL AND "notified" IS NULL
    WHEN 'delivered' THEN "delivered_at" IS NOT NULL AND "reported_at" IS NULL AND "code" IS NULL AND "notified" IS NULL
    WHEN 'cancelled' THEN "delivered_at" IS NULL AND "reported_at" IS NULL AND "code" IS NULL AND "notified" IS NULL
    WHEN 'removed' THEN "code" = 'removed'
      AND "delivered_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "notified" IS NOT NULL
    WHEN 'nothing_to_remove' THEN ("code" = 'not_present' OR "code" = 'identity_differs')
      AND "delivered_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "notified" IS NOT NULL
    WHEN 'failed' THEN ("code" = 'not_in_manifest' OR "code" = 'path_refused' OR "code" = 'unsupported_format'
        OR "code" = 'parse_failed' OR "code" = 'write_failed' OR "code" = 'expired' OR "code" = 'wrong_identity')
      AND "delivered_at" IS NOT NULL AND "reported_at" IS NOT NULL AND "notified" IS NOT NULL
    ELSE false END),
  CONSTRAINT "endpoint_addon_removal_targets_times_check" CHECK ("reported_at" IS NULL OR "reported_at" >= "delivered_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_removal_targets_identity_idx" ON "endpoint_addon_removal_targets" ("identity_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_addon_removals_status_idx" ON "endpoint_addon_removals" ("status", "expires_at");
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_removals_admin" ON "endpoint_addon_removals";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_removals_admin" ON "endpoint_addon_removals" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removal_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removal_targets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_removal_targets_admin" ON "endpoint_addon_removal_targets";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_removal_targets_admin" ON "endpoint_addon_removal_targets" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removal_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_addon_removal_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_addon_removal_devices_admin" ON "endpoint_addon_removal_devices";
--> statement-breakpoint
CREATE POLICY "endpoint_addon_removal_devices_admin" ON "endpoint_addon_removal_devices" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
