-- ADR-0193 (I4) first slice, P0 and P1: content provenance and trust tiers. Hand-authored (never drizzle-kit
-- generate). Journaled at idx 206, after 0204 and 0205.
--
--   content_digest_keys         the per-tenant HMAC key for keyed (pii) content digests: 32 random bytes as a
--                               data-key envelope, made on first use (decision 3). One row per data key, found by
--                               the envelope's key-fingerprint segment: a deployment runs one data key (boot-gated),
--                               so one row, and each record names the row it was keyed under. Stored, not derived, so
--                               a data-key rotation (which re-encrypts it) does not change any digest.
--   content_trust_tiers         an admin-set tier per source (MCP server, connector). No row = `untrusted`
--                               (decision 7, ADR-0180); every change is a step-up and audited by the gateway.
--   content_trust_settings      one row: the write floor, `trusted` by default; `standard` is a relaxation.
--   content_provenance_records  one governed return's label and digests (P0), append-only. Digests only, never
--                               content; the label also rides the provenance audit row, whose hash covers it.
--
-- 0185's invariants: the one new function pins its search_path, and the table it guards refuses TRUNCATE.
CREATE TABLE IF NOT EXISTS "content_digest_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- 32 random bytes, a data-key envelope
  "key_ciphertext" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_trust_tiers" (
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "tier" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "set_by_user_id" uuid NOT NULL,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_trust_tiers_pk" PRIMARY KEY ("source_kind", "source_id"),
  CONSTRAINT "content_trust_tiers_source_kind_check" CHECK ("source_kind" IN ('mcp_server', 'connector')),
  CONSTRAINT "content_trust_tiers_tier_check" CHECK ("tier" IN ('untrusted', 'standard', 'trusted')),
  CONSTRAINT "content_trust_tiers_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_trust_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "write_floor" text DEFAULT 'trusted' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_trust_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "content_trust_settings_write_floor_check" CHECK ("write_floor" IN ('standard', 'trusted')),
  CONSTRAINT "content_trust_settings_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
INSERT INTO "content_trust_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_provenance_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audit_id" uuid NOT NULL,
  "decision_audit_id" uuid NOT NULL,
  "context_id" text,
  "source_kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_detail" text,
  "trust_tier" text NOT NULL,
  "classification" text NOT NULL,
  "digest_alg" text NOT NULL,
  "digest_key_id" uuid,
  "upstream_digest" text,
  "delivered_digest" text,
  "label" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_provenance_records_source_kind_check" CHECK ("source_kind" IN ('mcp_server', 'connector')),
  CONSTRAINT "content_provenance_records_tier_check" CHECK ("trust_tier" IN ('untrusted', 'standard', 'trusted')),
  CONSTRAINT "content_provenance_records_classification_check" CHECK ("classification" IN ('pii', 'clean', 'unscanned')),
  CONSTRAINT "content_provenance_records_context_check" CHECK ("context_id" IS NULL OR "context_id" ~ '^(run|builder_thread):[0-9a-f-]{36}$'),
  -- a plain digest only for content scanned clean; keyed (or, with no data key, none at all) otherwise
  CONSTRAINT "content_provenance_records_digest_check" CHECK (CASE "digest_alg"
    WHEN 'sha256' THEN "classification" = 'clean' AND "digest_key_id" IS NULL
      AND "upstream_digest" ~ '^[0-9a-f]{64}$' AND "delivered_digest" ~ '^[0-9a-f]{64}$'
    WHEN 'hmac-sha256' THEN "classification" <> 'clean' AND "digest_key_id" IS NOT NULL
      AND "upstream_digest" ~ '^[0-9a-f]{64}$' AND "delivered_digest" ~ '^[0-9a-f]{64}$'
    WHEN 'unavailable' THEN "classification" <> 'clean' AND "digest_key_id" IS NULL
      AND "upstream_digest" IS NULL AND "delivered_digest" IS NULL
    ELSE false END),
  CONSTRAINT "content_provenance_records_label_check" CHECK (jsonb_typeof("label") = 'object' AND "label" ->> 'v' = 'regulait.content-provenance-label.v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_provenance_records_audit_uq" ON "content_provenance_records" ("audit_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_provenance_records_context_idx" ON "content_provenance_records" ("context_id") WHERE "context_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_provenance_records_created_idx" ON "content_provenance_records" ("created_at");
--> statement-breakpoint
-- evidence: written once, never changed or deleted
CREATE OR REPLACE FUNCTION "content_provenance_records_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'content_provenance_records rows are append-only (ADR-0193 P0)' USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "content_provenance_records_guard" ON "content_provenance_records";
--> statement-breakpoint
CREATE TRIGGER "content_provenance_records_guard" BEFORE UPDATE OR DELETE ON "content_provenance_records"
  FOR EACH ROW EXECUTE FUNCTION "content_provenance_records_guard"();
--> statement-breakpoint
-- a TRUNCATE skips every row trigger: refused that way too (0185's pattern)
DROP TRIGGER IF EXISTS "content_provenance_records_no_truncate" ON public."content_provenance_records";
--> statement-breakpoint
CREATE TRIGGER "content_provenance_records_no_truncate" BEFORE TRUNCATE ON public."content_provenance_records"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
