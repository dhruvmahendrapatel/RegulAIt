-- ADR-0360 slice 1c (lane E41): delivering an update rollout to devices.
--
-- 1. A rollout's start and resume are decided by two signed-in people (review lessons of #979): two new waiting
--    states, the requester and decider columns (user FKs restrict, so the people stay on the evidence) and CHECKs that
--    a waiting rollout names its requester and that the decider is never the requester.
-- 2. endpoint_update_attempts: one device's attempt to install one rollout's version, created when the gateway first
--    offers it a signed directive and settled by the device's one report (ENDPOINT_UPDATE_ATTEMPT_MACHINE).
-- 3. endpoint_update_rollout_devices: the devices a start or resume approval covers (security review of #1248).
-- 4. the rollout target version CHECK gains the 32-character limit the device and the result already hold.
--
-- Row-level security, ENABLED and FORCED: an active admin principal and the `system_task` and `migration` reasons
-- (the device routes run their reads and writes under `system_task`, scoped to the calling device).
--
-- Hand-authored and idempotent; additive apart from the tightened version CHECK (the product is not live, ADR-0180). It sorts after endpoint_fleet_operations, whose tables it alters. No
-- functions or triggers.
ALTER TABLE "endpoint_update_rollouts" ADD COLUMN IF NOT EXISTS "approval_requested_by" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD COLUMN IF NOT EXISTS "approval_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD COLUMN IF NOT EXISTS "approval_decided_by" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" DROP CONSTRAINT IF EXISTS "endpoint_update_rollouts_state_check";
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD CONSTRAINT "endpoint_update_rollouts_state_check"
  CHECK ("state" IN ('draft', 'start_requested', 'running', 'paused', 'halted', 'resume_requested', 'completed', 'aborted'));
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" DROP CONSTRAINT IF EXISTS "endpoint_update_rollouts_requested_check";
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD CONSTRAINT "endpoint_update_rollouts_requested_check"
  CHECK ("state" NOT IN ('start_requested', 'resume_requested') OR ("approval_requested_by" IS NOT NULL AND "approval_requested_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" DROP CONSTRAINT IF EXISTS "endpoint_update_rollouts_two_people_check";
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD CONSTRAINT "endpoint_update_rollouts_two_people_check"
  CHECK ("approval_decided_by" IS NULL OR ("approval_requested_by" IS NOT NULL AND "approval_decided_by" <> "approval_requested_by"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_update_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rollout_id" uuid NOT NULL REFERENCES "endpoint_update_rollouts"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "state" text DEFAULT 'directed' NOT NULL,
  "from_version" text NOT NULL,
  "os" text NOT NULL,
  "arch" text NOT NULL,
  "code" text,
  "expires_at" timestamp with time zone NOT NULL,
  "reported_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_update_attempts_state_check"
    CHECK ("state" IN ('directed', 'installed', 'current', 'refused', 'failed', 'rolled_back', 'expired')),
  CONSTRAINT "endpoint_update_attempts_code_check" CHECK ("code" IS NULL OR "code" ~ '^[a-z_]{1,64}$'),
  CONSTRAINT "endpoint_update_attempts_version_check" CHECK ("from_version" ~ '^[0-9A-Za-z.+-]{1,32}$'),
  CONSTRAINT "endpoint_update_attempts_os_check" CHECK ("os" IN ('linux', 'darwin', 'windows')),
  CONSTRAINT "endpoint_update_attempts_arch_check" CHECK ("arch" IN ('amd64', 'arm64'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_update_attempts_device_uq" ON "endpoint_update_attempts" ("rollout_id", "device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_update_attempts_device_idx" ON "endpoint_update_attempts" ("device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_update_attempts_expiry_idx" ON "endpoint_update_attempts" ("state", "expires_at");
--> statement-breakpoint
ALTER TABLE "endpoint_update_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_update_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_update_attempts_admin" ON "endpoint_update_attempts";
--> statement-breakpoint
CREATE POLICY "endpoint_update_attempts_admin" ON "endpoint_update_attempts" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
-- 3. endpoint_update_rollout_devices (security review of #1248): the devices a start or resume approval covers. The
--    gateway offers the update only to a captured device still in its stage's group, so a later membership change by
--    one admin never widens a two-person-approved rollout.
CREATE TABLE IF NOT EXISTS "endpoint_update_rollout_devices" (
  "rollout_id" uuid NOT NULL REFERENCES "endpoint_update_rollouts"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "stage_ordinal" integer NOT NULL,
  "approved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_update_rollout_devices_pk" PRIMARY KEY ("rollout_id", "device_id"),
  CONSTRAINT "endpoint_update_rollout_devices_stage_fk" FOREIGN KEY ("rollout_id", "stage_ordinal")
    REFERENCES "endpoint_update_rollout_stages"("rollout_id", "ordinal") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_update_rollout_devices_device_idx" ON "endpoint_update_rollout_devices" ("device_id");
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollout_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollout_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_update_rollout_devices_admin" ON "endpoint_update_rollout_devices";
--> statement-breakpoint
CREATE POLICY "endpoint_update_rollout_devices_admin" ON "endpoint_update_rollout_devices" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
-- 4. one version limit everywhere (review of #1248): a rollout target holds at most 32 characters, as the device's
--    reported version, the update result and the agent do.
ALTER TABLE "endpoint_update_rollouts" DROP CONSTRAINT IF EXISTS "endpoint_update_rollouts_version_check";
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ADD CONSTRAINT "endpoint_update_rollouts_version_check"
  CHECK (length("target_version") <= 32 AND "target_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,30})?$');
