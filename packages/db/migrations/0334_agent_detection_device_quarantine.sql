-- ADR-0333 §6 (lane E15, slice 3): device quarantine as a detection response.
--
-- - `detection_incidents.response` admits `quarantine_device` (the CHECK is replaced; every other value is kept).
-- - `endpoint_device_quarantines`: one row per quarantine a `quarantine_device` response opened. Its lifecycle is the
--   ADR-0348 machine ENDPOINT_DEVICE_QUARANTINE_MACHINE (active -> released | expired), and the CHECKs below hold the
--   columns each state needs. At most one quarantine is active per device (partial unique index), so a second
--   incident on a quarantined device reuses the active one instead of stacking a second.
-- - Row-level security (ADR-0234), ENABLED and FORCED, with the incident tables' policy: an admin principal, or the
--   sweep (`system_task`) and migrations. The device itself never reads this table.
ALTER TABLE "detection_incidents" DROP CONSTRAINT IF EXISTS "detection_incidents_response_check";
--> statement-breakpoint
ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_response_check"
  CHECK ("response" IN ('alert', 'suspend_grant', 'revoke_credential', 'require_approval', 'quarantine_device'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_device_quarantines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL,
  "incident_id" uuid NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "released_by" uuid,
  "release_step_up" text,
  CONSTRAINT "endpoint_device_quarantines_incident_uq" UNIQUE ("incident_id"),
  CONSTRAINT "endpoint_device_quarantines_status_check" CHECK ("status" IN ('active', 'released', 'expired')),
  CONSTRAINT "endpoint_device_quarantines_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "endpoint_device_quarantines_ended_check" CHECK (("status" = 'active') = ("ended_at" IS NULL) AND ("ended_at" IS NULL OR "ended_at" >= "created_at")),
  CONSTRAINT "endpoint_device_quarantines_release_check" CHECK (("status" = 'released') = ("release_step_up" IS NOT NULL) AND ("released_by" IS NULL OR "status" = 'released')),
  CONSTRAINT "endpoint_device_quarantines_step_up_check" CHECK ("release_step_up" IS NULL OR "release_step_up" ~ '^[a-z_]{1,32}$')
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "endpoint_device_quarantines" ADD CONSTRAINT "endpoint_device_quarantines_device_id_endpoint_devices_id_fk"
    FOREIGN KEY ("device_id") REFERENCES "public"."endpoint_devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "endpoint_device_quarantines" ADD CONSTRAINT "endpoint_device_quarantines_incident_id_detection_incidents_id_fk"
    FOREIGN KEY ("incident_id") REFERENCES "public"."detection_incidents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "endpoint_device_quarantines" ADD CONSTRAINT "endpoint_device_quarantines_released_by_users_id_fk"
    FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "endpoint_device_quarantines_one_active_uq" ON "endpoint_device_quarantines" USING btree ("device_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_device_quarantines_expiry_idx" ON "endpoint_device_quarantines" USING btree ("expires_at") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_device_quarantines_created_idx" ON "endpoint_device_quarantines" USING btree ("created_at", "id");
--> statement-breakpoint
ALTER TABLE "endpoint_device_quarantines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_device_quarantines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_device_quarantines_admin" ON "endpoint_device_quarantines";
--> statement-breakpoint
CREATE POLICY "endpoint_device_quarantines_admin" ON "endpoint_device_quarantines" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
