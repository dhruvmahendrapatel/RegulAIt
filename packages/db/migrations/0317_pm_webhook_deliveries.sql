-- S-03 (2026-11-07 whole-build review; ADR-0010 amendment): replay protection for inbound PM webhooks.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `pm_webhook_deliveries`: one row per delivery that reached processing. The gateway inserts it with
--    ON CONFLICT DO NOTHING before processing; no row back means a duplicate, which is answered 200, audited and
--    not processed. Two unique keys, either of which makes a delivery a duplicate:
--      (connection_id, content_sha256) the sha256 of the exact body bytes (for the generic contract, of its signed
--                                      "<timestamp>.<body>"), always present;
--      (connection_id, delivery_id)   the provider's own delivery id, where it sends one (partial: NOT NULL).
-- 2. The rows are dedup markers, not evidence (the audit trail and pm_sync_events are the evidence), so they are
--    pruned by received_at after the retention the gateway sets; the index serves that prune.
-- 3. Nothing is backfilled: deliveries before this migration were never recorded.

CREATE TABLE IF NOT EXISTS "pm_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "pm_connections"("id") ON DELETE CASCADE,
  "content_sha256" text NOT NULL,
  "delivery_id" text,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pm_webhook_deliveries_content_sha256_check" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pm_webhook_deliveries_delivery_id_check" CHECK ("delivery_id" IS NULL OR char_length("delivery_id") BETWEEN 1 AND 271)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_webhook_deliveries_content_uq" ON "pm_webhook_deliveries" ("connection_id", "content_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pm_webhook_deliveries_delivery_uq" ON "pm_webhook_deliveries" ("connection_id", "delivery_id") WHERE "delivery_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pm_webhook_deliveries_received_idx" ON "pm_webhook_deliveries" ("received_at");
