-- ADR-0360 slice 2 (lane E41): EDR integration (Defender for Endpoint, Falcon, SentinelOne).
--
-- A read-only-by-default EDR connection per endpoint-agent source with its sealed credential and webhook secret, the
-- latest normalised signal per device (a read model whose source of truth is the vendor), the webhook replay table, and
-- governed isolation requests (two people: the approver is never the requester, CHECKs; one open request per device).
--
-- Row-level security, ENABLED and FORCED on every table: an active admin principal and the `system_task` and
-- `migration` reasons. The verified webhook route (auth-exempt, `public_ingest`) gets exactly what it needs: SELECT on
-- edr_connections (to read the sealed webhook secret), SELECT and INSERT on the replay table, and SELECT/INSERT/UPDATE on the
-- signals.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "edr_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "vendor" text NOT NULL,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "tenant_id" text,
  "client_id" text,
  "secret_ciphertext" text NOT NULL,
  "webhook_secret_ciphertext" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "isolation_enabled" boolean DEFAULT false NOT NULL,
  "isolation_relaxed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "isolation_step_up" text,
  "isolation_audit_id" uuid,
  "last_sync_at" timestamp with time zone,
  "last_sync_code" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edr_connections_name_uq" UNIQUE ("source_id", "name"),
  CONSTRAINT "edr_connections_vendor_check" CHECK ("vendor" IN ('defender', 'falcon', 'sentinelone')),
  CONSTRAINT "edr_connections_name_check" CHECK (length("name") BETWEEN 1 AND 100),
  CONSTRAINT "edr_connections_isolation_check"
    CHECK (NOT "isolation_enabled" OR ("isolation_step_up" IS NOT NULL AND "isolation_audit_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edr_connections_source_idx" ON "edr_connections" ("source_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edr_device_signals" (
  "connection_id" uuid NOT NULL REFERENCES "edr_connections"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "vendor_device_id" text NOT NULL,
  "risk" text NOT NULL,
  "alerts_low" integer DEFAULT 0 NOT NULL,
  "alerts_medium" integer DEFAULT 0 NOT NULL,
  "alerts_high" integer DEFAULT 0 NOT NULL,
  "alerts_critical" integer DEFAULT 0 NOT NULL,
  "isolated_at_vendor" boolean DEFAULT false NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edr_device_signals_pk" PRIMARY KEY ("connection_id", "device_id"),
  CONSTRAINT "edr_device_signals_vendor_uq" UNIQUE ("connection_id", "vendor_device_id"),
  CONSTRAINT "edr_device_signals_risk_check" CHECK ("risk" IN ('none', 'low', 'medium', 'high', 'critical')),
  CONSTRAINT "edr_device_signals_counts_check"
    CHECK ("alerts_low" >= 0 AND "alerts_medium" >= 0 AND "alerts_high" >= 0 AND "alerts_critical" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edr_device_signals_device_idx" ON "edr_device_signals" ("device_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edr_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "edr_connections"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "edr_webhook_deliveries_event_uq" ON "edr_webhook_deliveries" ("connection_id", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edr_webhook_deliveries_received_idx" ON "edr_webhook_deliveries" ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edr_isolation_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "edr_connections"("id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "vendor_device_id" text NOT NULL,
  "state" text DEFAULT 'requested' NOT NULL,
  "reason" text NOT NULL,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "release_requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "release_decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "vendor_action_id" text,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "edr_isolation_requests_state_check" CHECK ("state" IN ('requested', 'rejected', 'submitting', 'isolated', 'failed', 'release_requested', 'releasing', 'released')),
  CONSTRAINT "edr_isolation_requests_reason_check" CHECK (length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "edr_isolation_requests_two_people_check" CHECK ("decided_by" IS NULL OR "decided_by" IS DISTINCT FROM "requested_by"),
  CONSTRAINT "edr_isolation_requests_release_two_people_check"
    CHECK ("release_decided_by" IS NULL OR "release_decided_by" IS DISTINCT FROM "release_requested_by")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "edr_isolation_requests_open_uq"
  ON "edr_isolation_requests" ("connection_id", "device_id") WHERE "state" NOT IN ('rejected', 'failed', 'released');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edr_isolation_requests_state_idx" ON "edr_isolation_requests" ("state", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "edr_isolation_requests_device_idx" ON "edr_isolation_requests" ("device_id");
--> statement-breakpoint
ALTER TABLE "edr_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "edr_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_connections_admin" ON "edr_connections";
--> statement-breakpoint
CREATE POLICY "edr_connections_admin" ON "edr_connections" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "edr_device_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "edr_device_signals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_device_signals_admin" ON "edr_device_signals";
--> statement-breakpoint
CREATE POLICY "edr_device_signals_admin" ON "edr_device_signals" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "edr_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "edr_webhook_deliveries" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_webhook_deliveries_admin" ON "edr_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "edr_webhook_deliveries_admin" ON "edr_webhook_deliveries" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
ALTER TABLE "edr_isolation_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "edr_isolation_requests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_isolation_requests_admin" ON "edr_isolation_requests";
--> statement-breakpoint
CREATE POLICY "edr_isolation_requests_admin" ON "edr_isolation_requests" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_connections_webhook_read" ON "edr_connections";
--> statement-breakpoint
CREATE POLICY "edr_connections_webhook_read" ON "edr_connections" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'public_ingest');
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_webhook_deliveries_webhook" ON "edr_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "edr_webhook_deliveries_webhook" ON "edr_webhook_deliveries" FOR INSERT
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'public_ingest');
--> statement-breakpoint
-- INSERT ... ON CONFLICT DO NOTHING RETURNING (the replay check) needs to see the row it conflicts with
DROP POLICY IF EXISTS "edr_webhook_deliveries_webhook_read" ON "edr_webhook_deliveries";
--> statement-breakpoint
CREATE POLICY "edr_webhook_deliveries_webhook_read" ON "edr_webhook_deliveries" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'public_ingest');
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_device_signals_webhook_read" ON "edr_device_signals";
--> statement-breakpoint
CREATE POLICY "edr_device_signals_webhook_read" ON "edr_device_signals" FOR SELECT
  USING ((SELECT regulait_rls_system_reason()) = 'public_ingest');
--> statement-breakpoint
DROP POLICY IF EXISTS "edr_device_signals_webhook_update" ON "edr_device_signals";
--> statement-breakpoint
CREATE POLICY "edr_device_signals_webhook_update" ON "edr_device_signals" FOR UPDATE
  USING ((SELECT regulait_rls_system_reason()) = 'public_ingest')
  WITH CHECK ((SELECT regulait_rls_system_reason()) = 'public_ingest');
