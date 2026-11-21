-- ADR-0360 slice 1a (lane E41): endpoint agent fleet operations.
--
-- The per-source self-update setting (absent row or false = off; on only with a recorded settings_relax step-up), staged
-- update rollouts and their stages (lifecycles declared in the gateway's endpoint-fleet-lifecycle.ts; at most one open
-- rollout per source), and one-line enrolment tokens on endpoint_enrolment_tokens (single use: device cap 1 and at
-- most 60 minutes; an optional device group).
--
-- Device groups are ADR-0350's (lane E31, migration endpoint_command_exceptions, which runs first): this migration
-- creates no group table. A stage and a token reference endpoint_device_groups ON DELETE SET NULL, so deleting a
-- group (an ADR-0350 step-up) is never blocked by a rollout; the stage keeps the group's name as evidence.
--
-- Row-level security, ENABLED and FORCED on every new table: an active admin principal (regulait_rls_is_admin(), which
-- also admits the bootstrap token) and the `system_task` and `migration` reasons. The one addition to an existing
-- table is an INSERT-only policy on ADR-0350's endpoint_device_group_members under `public_ingest`: the agent's ticket
-- redemption (an exempt route) places the device in its one-line token's group in the same transaction that creates
-- the device. Joining a group only narrows a device's policy (ADR-0350 rules are ask or deny), so this grants nothing.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "endpoint_fleet_settings" (
  "source_id" uuid PRIMARY KEY NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "self_update" boolean DEFAULT false NOT NULL,
  "self_update_relaxed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "self_update_step_up" text,
  "self_update_audit_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_fleet_settings_self_update_check"
    CHECK (NOT "self_update" OR ("self_update_step_up" IS NOT NULL AND "self_update_audit_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_update_rollouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "target_version" text NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "endpoint_update_rollouts_version_check"
    CHECK ("target_version" ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$'),
  CONSTRAINT "endpoint_update_rollouts_state_check"
    CHECK ("state" IN ('draft', 'running', 'paused', 'halted', 'completed', 'aborted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_update_rollouts_open_uq"
  ON "endpoint_update_rollouts" ("source_id") WHERE "state" NOT IN ('completed', 'aborted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_update_rollouts_source_idx" ON "endpoint_update_rollouts" ("source_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_update_rollout_stages" (
  "rollout_id" uuid NOT NULL REFERENCES "endpoint_update_rollouts"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "group_id" uuid REFERENCES "endpoint_device_groups"("id") ON DELETE SET NULL,
  "group_name" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "endpoint_update_rollout_stages_pk" PRIMARY KEY ("rollout_id", "ordinal"),
  CONSTRAINT "endpoint_update_rollout_stages_group_uq" UNIQUE ("rollout_id", "group_id"),
  CONSTRAINT "endpoint_update_rollout_stages_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 20),
  CONSTRAINT "endpoint_update_rollout_stages_state_check" CHECK ("state" IN ('pending', 'active', 'done')),
  CONSTRAINT "endpoint_update_rollout_stages_times_check"
    CHECK (("state" = 'pending') = ("started_at" IS NULL) AND ("state" = 'done') = ("completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_update_rollout_stages_group_idx" ON "endpoint_update_rollout_stages" ("group_id");
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD COLUMN IF NOT EXISTS "single_use" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD COLUMN IF NOT EXISTS "device_group_id" uuid;
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" DROP CONSTRAINT IF EXISTS "endpoint_enrolment_tokens_single_use_check";
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD CONSTRAINT "endpoint_enrolment_tokens_single_use_check"
  CHECK (NOT "single_use" OR ("device_cap" = 1 AND "expires_at" <= "created_at" + interval '60 minutes'));
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" DROP CONSTRAINT IF EXISTS "endpoint_enrolment_tokens_device_group_fk";
--> statement-breakpoint
ALTER TABLE "endpoint_enrolment_tokens" ADD CONSTRAINT "endpoint_enrolment_tokens_device_group_fk"
  FOREIGN KEY ("device_group_id") REFERENCES "endpoint_device_groups"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_enrolment_tokens_device_group_idx"
  ON "endpoint_enrolment_tokens" ("device_group_id") WHERE "device_group_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "endpoint_fleet_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_fleet_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_fleet_settings_admin" ON "endpoint_fleet_settings";
--> statement-breakpoint
CREATE POLICY "endpoint_fleet_settings_admin" ON "endpoint_fleet_settings" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_update_rollouts_admin" ON "endpoint_update_rollouts";
--> statement-breakpoint
CREATE POLICY "endpoint_update_rollouts_admin" ON "endpoint_update_rollouts" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollout_stages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_update_rollout_stages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_update_rollout_stages_admin" ON "endpoint_update_rollout_stages";
--> statement-breakpoint
CREATE POLICY "endpoint_update_rollout_stages_admin" ON "endpoint_update_rollout_stages" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_device_group_members_redeem" ON "endpoint_device_group_members";
--> statement-breakpoint
CREATE POLICY "endpoint_device_group_members_redeem" ON "endpoint_device_group_members" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'public_ingest');
