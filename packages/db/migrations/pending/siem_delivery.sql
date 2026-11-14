-- ADR-0303 (ADR-0135's proposed SIEM delivery contract, lane L11): `siem_destinations`, an outbox cursor over the
-- audit chain (`audit_log.seq`). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - New destinations are OFF (ADR-0180); enabling one is a step-up relaxation, audited.
-- - `cursor_seq` moves only after the receiver acknowledges a batch, so delivery is at least once and in chain order.
-- - `secret_ciphertext`: the Standard Webhooks `whsec_` signing secret under REGULAIT_DATA_KEY (never plaintext).
-- - `last_error_code` is one of a fixed set of codes (CHECK below), never receiver text, so no third-party bytes land
--   in this table.
-- - The deployment is single-tenant, so like the other register tables (0281) there is no tenant column for RLS.
-- No new functions or refusal triggers.

CREATE TABLE IF NOT EXISTS "siem_destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text DEFAULT 'webhook' NOT NULL,
  "url" text NOT NULL,
  "allow_plaintext_http" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cursor_seq" bigint NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "lease_until" timestamp with time zone,
  "lease_token" uuid,
  "last_attempt_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_error_code" text,
  "delivered_events" bigint DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "siem_destinations_kind_check" CHECK ("kind" IN ('webhook')),
  CONSTRAINT "siem_destinations_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "siem_destinations_url_check" CHECK (char_length("url") BETWEEN 1 AND 2048),
  CONSTRAINT "siem_destinations_cursor_check" CHECK ("cursor_seq" >= 0),
  CONSTRAINT "siem_destinations_state_check" CHECK ("state" IN ('active', 'backoff', 'dead_letter')),
  CONSTRAINT "siem_destinations_failures_check" CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "siem_destinations_delivered_check" CHECK ("delivered_events" >= 0),
  CONSTRAINT "siem_destinations_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" IN (
    'http_4xx', 'http_408', 'http_413', 'http_429', 'http_5xx', 'timeout', 'network', 'egress_blocked', 'no_data_key',
    'secret_unreadable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "siem_destinations_name_uq" ON "siem_destinations" (lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "siem_destinations_due_idx" ON "siem_destinations" ("enabled", "next_attempt_at");
