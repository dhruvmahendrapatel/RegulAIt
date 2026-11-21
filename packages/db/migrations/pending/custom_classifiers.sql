-- Pending migration custom_classifiers (ADR-0252: numbered at merge). ADR-0363 slice 2 (lane E44): customer-defined
-- classifiers (regex, keyword, dictionary, exact-data-match) run inside the existing guardrail pipeline.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent. Additive only.
--
--   custom_classifiers              one classifier's identity: a stable key (the finding category is
--                                   `classifier.<key>`) and a display name.
--   custom_classifier_versions      every version, with the declared lifecycle (CLASSIFIER_VERSION_TRANSITIONS):
--                                   draft -> pending_approval -> published | rejected; published -> superseded |
--                                   retired. At most one published version per classifier (partial unique index).
--                                   `definition` is a schema-validated configuration document (ADR-0200 exception):
--                                   the regex, keyword or dictionary list, or the EDM normalisation; never EDM values.
--                                   `approval_id` is the one approvals-queue row a publish waits on.
--   custom_classifier_edm_digests   an EDM version's values as HMAC-SHA256 digests (64 hex). The plaintext values are
--                                   hashed on the write request and never stored, logged or returned.
--   custom_classifier_hash_key      one row: the deployment's random EDM HMAC key, enveloped under the data key
--                                   (CIPHERTEXT_COLUMNS, re-encrypted on a data-key rotation; the key itself never
--                                   rotates, so stored digests stay valid).
--
-- Deployment configuration read on every governed call, like guardrail_configs: single-tenant (ADR-0041), no tenant
-- column, so no row-level security policy of its own. No functions or triggers (the 0185 guard read by hand).

CREATE TABLE IF NOT EXISTS "custom_classifiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "custom_classifiers_key_uq" UNIQUE ("key"),
  CONSTRAINT "custom_classifiers_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,47}$'),
  CONSTRAINT "custom_classifiers_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_classifier_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "classifier_id" uuid NOT NULL REFERENCES "custom_classifiers"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "kind" text NOT NULL,
  "mode" text NOT NULL,
  "scan_input" boolean NOT NULL DEFAULT true,
  "scan_output" boolean NOT NULL DEFAULT true,
  "definition" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "custom_classifier_versions_uq" UNIQUE ("classifier_id", "version"),
  CONSTRAINT "custom_classifier_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "custom_classifier_versions_kind_check" CHECK ("kind" IN ('regex', 'keyword', 'dictionary', 'exact_data_match')),
  CONSTRAINT "custom_classifier_versions_mode_check" CHECK ("mode" IN ('log', 'warn', 'block')),
  CONSTRAINT "custom_classifier_versions_phase_check" CHECK ("scan_input" OR "scan_output"),
  CONSTRAINT "custom_classifier_versions_status_check" CHECK ("status" IN ('draft', 'pending_approval', 'published', 'rejected', 'superseded', 'retired')),
  CONSTRAINT "custom_classifier_versions_definition_check" CHECK (jsonb_typeof("definition") = 'object' AND "definition"->>'kind' = "kind")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_classifier_versions_one_published_uq" ON "custom_classifier_versions" ("classifier_id") WHERE "status" = 'published';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_classifier_versions_status_idx" ON "custom_classifier_versions" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custom_classifier_versions_approval_idx" ON "custom_classifier_versions" ("approval_id") WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_classifier_edm_digests" (
  "version_id" uuid NOT NULL REFERENCES "custom_classifier_versions"("id") ON DELETE CASCADE,
  "digest" text NOT NULL,
  CONSTRAINT "custom_classifier_edm_digests_pk" PRIMARY KEY ("version_id", "digest"),
  CONSTRAINT "custom_classifier_edm_digests_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_classifier_hash_key" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "key_ciphertext" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "custom_classifier_hash_key_singleton_check" CHECK ("id")
);
