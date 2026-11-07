-- ADR-0241 (backlog P21): the configurable usage extractor.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. usage_extractor_versions: one immutable row per saved mapping version of one agent. `mapping` is a
--    schema-validated configuration document (validateUsageMapping in @regulait/model-provider, 4 KiB cap repeated
--    here), the ADR-0200 exception for configuration documents. A change is a new row with the next version number;
--    no route updates or deletes a row (rows go only with their agent, ON DELETE CASCADE).
-- 2. usage_extractor_tests: the sample-response test of one version, append-only evidence. Only a SHA-256 of the
--    sample is kept, never the sample (it can carry prompt or answer text). `expected` and `extracted` are
--    point-in-time snapshots of counts (the evidence exception), each a small object.
-- 3. usage_extractor_active: at most one active version per agent (agent_id is the key). Activation requires a
--    passing test of that exact version (checked in the gateway, in the same transaction, under a row lock).
-- 4. org_settings.usage_extractor_enabled: off by default (ADR-0180). While off, no mapping is read at dispatch
--    and every count is the adapter's built-in extraction. Turning it on needs a settings_relax step-up.
-- 5. usage_events.usage_extractor_version_id: which mapping version produced the row's counts. FK-free like every
--    other attribution column of the ledger (an evidence row outlives the configuration it names). NULL = the
--    adapter's own extraction, which is every existing row; nothing is backfilled.
-- No functions or triggers are added (zz-dbguard-0185 checked by hand). No new text column is named for prose
-- (reason, note, rationale, explanation, justification, comment), so prose-scrub has nothing to register.

CREATE TABLE IF NOT EXISTS "usage_extractor_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "mapping" jsonb NOT NULL,
  "mapping_sha256" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "usage_extractor_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "usage_extractor_versions_mapping_check"
    CHECK (jsonb_typeof("mapping") = 'object' AND octet_length("mapping"::text) <= 8192),
  CONSTRAINT "usage_extractor_versions_sha_check" CHECK ("mapping_sha256" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_extractor_versions_agent_version_uq"
  ON "usage_extractor_versions" ("agent_id", "version");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_extractor_tests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "version_id" uuid NOT NULL REFERENCES "usage_extractor_versions"("id") ON DELETE CASCADE,
  "sample_sha256" text NOT NULL,
  "passed" boolean NOT NULL,
  "expected" jsonb NOT NULL,
  "extracted" jsonb,
  "failure" text,
  "tested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "tested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "usage_extractor_tests_sha_check" CHECK ("sample_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "usage_extractor_tests_expected_check"
    CHECK (jsonb_typeof("expected") = 'object' AND octet_length("expected"::text) <= 2048),
  CONSTRAINT "usage_extractor_tests_extracted_check"
    CHECK ("extracted" IS NULL OR (jsonb_typeof("extracted") = 'object' AND octet_length("extracted"::text) <= 2048)),
  CONSTRAINT "usage_extractor_tests_failure_check" CHECK ("failure" IS NULL OR char_length("failure") <= 500),
  CONSTRAINT "usage_extractor_tests_outcome_check" CHECK (("passed" AND "failure" IS NULL) OR (NOT "passed" AND "failure" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_extractor_tests_version_idx"
  ON "usage_extractor_tests" ("version_id", "tested_at" DESC);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_extractor_active" (
  "agent_id" uuid PRIMARY KEY NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "version_id" uuid NOT NULL REFERENCES "usage_extractor_versions"("id") ON DELETE CASCADE,
  "test_id" uuid NOT NULL REFERENCES "usage_extractor_tests"("id") ON DELETE CASCADE,
  "activated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_extractor_active_version_idx" ON "usage_extractor_active" ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_extractor_active_test_idx" ON "usage_extractor_active" ("test_id");--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "usage_extractor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "usage_extractor_version_id" uuid;
