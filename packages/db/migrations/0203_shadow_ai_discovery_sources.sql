-- Migration 0203. ADR-0195 slice SD0: shadow-AI ACTIVE discovery, the foundation. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent.
--
-- ADR-0195 supersedes ADR-0055's and ADR-0083's "evidence only, no collectors" stance: RegulAIt may now call
-- customer systems READ-ONLY to discover AI use. This migration adds what every scanner (SD1 repos, SD2 clouds,
-- SD3/SD4 endpoints) runs over:
--
--   discovery_sources        one admin-configured place to scan. OFF until an admin enables it (a `settings_relax`
--                            step-up bound to its kind, target and scope; widening an enabled source's scope is the
--                            same step-up). ADR-0180 first-load posture: no row exists after this migration.
--                            `version` is the compare-and-set counter.
--   discovery_credentials    the scanner credential of one source, a data-key envelope (`secret_ciphertext`, in the
--                            gateway's CIPHERTEXT_COLUMNS). Never returned by any route. At most one live credential
--                            per source; replacing one revokes the old row, and a revoked row has its ciphertext
--                            destroyed (CHECK). `created_at` drives the static-credential age warning;
--                            `write_scope` says whether a scanner has verified the credential is read-only, or found
--                            it grants write access (`refused`: never used again; the source is blocked until replaced).
--   discovery_runs           one scan, leased with an expiry like the workflow engine's execution claim (REL-06): a
--                            crashed worker's run is re-claimed after the lease lapses, never lost and never doubled
--                            (one live run per source, partial unique index). Raw scanner output is never stored:
--                            only its SHA-256 (decision 6). `catalogue_gaps` holds the observations no enabled admin
--                            catalogue row matched (decision 5: detection is data), bounded.
--   discovery_settings       one row: the static-credential warning age (90 days) and the endpoint evidence
--                            retention (90 days). Lengthening either is a relaxation.
--   discovery_pseudonyms     ADR-0195 decision 20: the display name of a person a scanner names (a device user, a
--                            commit author, a cloud calling principal), a data-key envelope, keyed by the per-tenant
--                            HMAC pseudonym findings carry instead. Revealing one is a step-up and audited.
--   discovery_pseudonym_keys the per-tenant HMAC key, a data-key envelope, created on first use (one live row).
--   step-up kind             `pseudonym_reveal` (master decision on #403): revealing a name is its own step-up kind,
--                            required on the existing org row as on a first load.
--
-- Findings (decisions 5 and 5a): a scanner observation becomes a finding only when it matches an enabled
-- `ai_endpoint_signatures` row. The signature kinds gain the six ARTIFACT kinds, matched only by whole-identifier
-- equality (`match_type = 'identifier'`; never a regular expression). Findings gain the subject kinds `device`,
-- `cloud_resource` and `cloud_principal`. A scan run writes through the SAME import path as an uploaded file: one
-- `shadow_ai_imports` row per evidence kind it reported, whose closed `kind` enum is extended with the six scanner
-- kinds, and `discovery_run_id` names the run.
--
-- No function and no trigger is created here, so the 0185 guard (pinned search_path; TRUNCATE refusal beside a row
-- refusal) has nothing new to check.

-- ---------------------------------------------------------------------------------------------------------------
-- the catalogue, the imports and the findings: widened, never loosened
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_ck" CHECK ("kind" IN (
  'hostname', 'sdk_package', 'api_key_prefix', 'web_app',
  'cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime', 'assistant_config'));
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_match_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_match_ck"
  CHECK ("match_type" IN ('exact_host', 'host_suffix', 'package', 'key_prefix', 'identifier'));
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_match_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_match_ck" CHECK (
  ("kind" = 'sdk_package') = ("match_type" = 'package')
  AND ("kind" = 'api_key_prefix') = ("match_type" = 'key_prefix')
  AND ("kind" IN ('cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime',
                  'assistant_config')) = ("match_type" = 'identifier')
);

-- catalogue rows scoped to an OS or a package ecosystem, a tool id, an admin note, and a confidence (SD3 request)
ALTER TABLE "ai_endpoint_signatures" ADD COLUMN IF NOT EXISTS "os" text;
ALTER TABLE "ai_endpoint_signatures" ADD COLUMN IF NOT EXISTS "ecosystem" text;
ALTER TABLE "ai_endpoint_signatures" ADD COLUMN IF NOT EXISTS "tool_id" text;
ALTER TABLE "ai_endpoint_signatures" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "ai_endpoint_signatures" ADD COLUMN IF NOT EXISTS "confidence" text DEFAULT 'high' NOT NULL;
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_os_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_os_ck"
  CHECK ("os" IS NULL OR "os" IN ('macos', 'windows', 'linux'));
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_ecosystem_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_ecosystem_ck"
  CHECK ("ecosystem" IS NULL OR "ecosystem" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$');
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_tool_id_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_tool_id_ck"
  CHECK ("tool_id" IS NULL OR "tool_id" ~ '^[a-z0-9][a-z0-9_.-]{0,127}$');
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_note_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_note_ck"
  CHECK ("note" IS NULL OR char_length("note") <= 500);
ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_confidence_ck";
ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_confidence_ck"
  CHECK ("confidence" IN ('high', 'medium', 'low'));

ALTER TABLE "shadow_ai_imports" DROP CONSTRAINT IF EXISTS "shadow_ai_imports_kind_ck";
ALTER TABLE "shadow_ai_imports" ADD CONSTRAINT "shadow_ai_imports_kind_ck" CHECK ("kind" IN (
  'egress_log', 'code_scan', 'saas_export', 'self_reported',
  'repo_scan', 'cloud_inventory', 'cloud_audit_log', 'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent'));

ALTER TABLE "shadow_ai_findings" DROP CONSTRAINT IF EXISTS "shadow_ai_findings_subject_kind_ck";
ALTER TABLE "shadow_ai_findings" ADD CONSTRAINT "shadow_ai_findings_subject_kind_ck" CHECK ("subject_kind" IN (
  'host', 'repo', 'saas_app', 'system', 'device', 'cloud_resource', 'cloud_principal'));

-- ---------------------------------------------------------------------------------------------------------------
-- discovery sources, credentials, runs, settings
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "discovery_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  -- what to scan (an organisation, an account, a fleet); validated per kind by the gateway
  "target" jsonb NOT NULL,
  -- how far: {"orgLevel": bool, "include": [names]}; widening it on an enabled source is a step-up
  "scope" jsonb NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "schedule_interval_seconds" integer DEFAULT 86400 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "enabled_at" timestamp with time zone,
  "enabled_by" uuid,
  "disabled_at" timestamp with time zone,
  "disabled_by" uuid,
  -- the acting principal, as in audit_log.user_id (no foreign key)
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_sources_kind_check" CHECK ("kind" IN (
    'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
    'cloud_aws', 'cloud_gcp', 'cloud_azure',
    'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent')),
  CONSTRAINT "discovery_sources_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "discovery_sources_target_check" CHECK (jsonb_typeof("target") = 'object'),
  CONSTRAINT "discovery_sources_scope_check" CHECK (
    jsonb_typeof("scope") = 'object'
    AND jsonb_typeof("scope" -> 'orgLevel') = 'boolean'
    AND jsonb_typeof("scope" -> 'include') = 'array'
  ),
  CONSTRAINT "discovery_sources_schedule_check" CHECK ("schedule_interval_seconds" BETWEEN 3600 AND 2592000),
  CONSTRAINT "discovery_sources_version_check" CHECK ("version" >= 1),
  -- an enabled source records who enabled it and when
  CONSTRAINT "discovery_sources_enabled_check" CHECK (NOT "enabled" OR ("enabled_at" IS NOT NULL AND "enabled_by" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_sources_name_uq" ON "discovery_sources" (lower("name"));
CREATE INDEX IF NOT EXISTS "discovery_sources_due_idx" ON "discovery_sources" ("next_run_at") WHERE "enabled";

CREATE TABLE IF NOT EXISTS "discovery_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "credential_mode" text NOT NULL,
  -- non-secret identifiers (a role ARN, a workload identity pool, a tenant id); string values only, bounded
  "public_config" jsonb NOT NULL,
  -- a data-key envelope; NULL for a federated credential with no secret part, and destroyed on revoke
  "secret_ciphertext" text,
  "write_scope" text DEFAULT 'unverified' NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid,
  CONSTRAINT "discovery_credentials_mode_check" CHECK ("credential_mode" IN ('federated', 'static')),
  CONSTRAINT "discovery_credentials_write_scope_check" CHECK ("write_scope" IN ('unverified', 'read_only', 'refused')),
  CONSTRAINT "discovery_credentials_public_config_check" CHECK (jsonb_typeof("public_config") = 'object'),
  -- a live static credential holds its secret
  CONSTRAINT "discovery_credentials_static_secret_check"
    CHECK ("credential_mode" <> 'static' OR "revoked_at" IS NOT NULL OR "secret_ciphertext" IS NOT NULL),
  -- a revoked credential keeps no secret
  CONSTRAINT "discovery_credentials_revoked_check" CHECK ("revoked_at" IS NULL OR "secret_ciphertext" IS NULL),
  CONSTRAINT "discovery_credentials_revoked_by_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_credentials_live_uq"
  ON "discovery_credentials" ("source_id") WHERE "revoked_at" IS NULL;

CREATE TABLE IF NOT EXISTS "discovery_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "requested_by" uuid,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  -- the source version when the run was queued: what was asked to be scanned
  "source_version" integer NOT NULL,
  "kind" text NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "observed" integer DEFAULT 0 NOT NULL,
  "matched" integer DEFAULT 0 NOT NULL,
  "findings_created" integer DEFAULT 0 NOT NULL,
  "findings_updated" integer DEFAULT 0 NOT NULL,
  -- observations no enabled admin catalogue row matched: [{kind, value}], at most 50
  "catalogue_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- what the scanner could and could not read: [{read, status, detail?}], at most 100, details scrubbed
  "read_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- SHA-256 of the raw scanner output; the output itself is discarded
  "raw_output_sha256" text,
  "error_code" text,
  "error_detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual')),
  CONSTRAINT "discovery_runs_status_check" CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT "discovery_runs_kind_check" CHECK ("kind" IN (
    'repo_github', 'repo_gitlab', 'repo_bitbucket', 'repo_azure_devops',
    'cloud_aws', 'cloud_gcp', 'cloud_azure',
    'endpoint_osquery', 'endpoint_inventory', 'endpoint_agent')),
  CONSTRAINT "discovery_runs_attempt_check" CHECK ("attempt" BETWEEN 0 AND 3),
  CONSTRAINT "discovery_runs_counts_check"
    CHECK ("observed" >= 0 AND "matched" >= 0 AND "findings_created" >= 0 AND "findings_updated" >= 0),
  CONSTRAINT "discovery_runs_gaps_check"
    CHECK (jsonb_typeof("catalogue_gaps") = 'array' AND jsonb_array_length("catalogue_gaps") <= 50),
  CONSTRAINT "discovery_runs_read_outcomes_check"
    CHECK (jsonb_typeof("read_outcomes") = 'array' AND jsonb_array_length("read_outcomes") <= 100),
  CONSTRAINT "discovery_runs_digest_check" CHECK ("raw_output_sha256" IS NULL OR "raw_output_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "discovery_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT "discovery_runs_error_detail_check" CHECK ("error_detail" IS NULL OR char_length("error_detail") <= 1000),
  -- a running run holds a lease; any other run holds none
  CONSTRAINT "discovery_runs_lease_check" CHECK (
    ("status" = 'running') = ("lease_expires_at" IS NOT NULL AND "lease_owner" IS NOT NULL)
  ),
  CONSTRAINT "discovery_runs_finished_check" CHECK (("status" IN ('succeeded', 'failed')) = ("finished_at" IS NOT NULL)),
  CONSTRAINT "discovery_runs_failed_check" CHECK (("status" = 'failed') = ("error_code" IS NOT NULL))
);
-- one live run per source: a second "run now" or a scheduled tick while one is queued or running is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_runs_live_uq"
  ON "discovery_runs" ("source_id") WHERE "status" IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS "discovery_runs_claim_idx" ON "discovery_runs" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "discovery_runs_source_idx" ON "discovery_runs" ("source_id", "created_at");

-- the scan run an import row came from (NULL for an uploaded file). The upload routes accept only the four import
-- kinds (their request schema); a scanner evidence kind arrives only from the scan worker. Not a CHECK: deleting a
-- source deletes its runs, and the import rows (the evidence trail of what was found) outlive them.
ALTER TABLE "shadow_ai_imports"
  ADD COLUMN IF NOT EXISTS "discovery_run_id" uuid REFERENCES "discovery_runs"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "discovery_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "credential_warning_age_days" integer DEFAULT 90 NOT NULL,
  "endpoint_retention_days" integer DEFAULT 90 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "discovery_settings_age_check" CHECK ("credential_warning_age_days" BETWEEN 1 AND 365),
  CONSTRAINT "discovery_settings_retention_check" CHECK ("endpoint_retention_days" BETWEEN 1 AND 3650),
  CONSTRAINT "discovery_settings_version_check" CHECK ("version" >= 1)
);
INSERT INTO "discovery_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- pseudonyms (ADR-0195 decision 20)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "discovery_pseudonym_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- 32 random bytes, a data-key envelope
  "key_ciphertext" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
-- one key per tenant: a second concurrent first use loses the race and reads the winner's key
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_pseudonym_keys_one_uq" ON "discovery_pseudonym_keys" ((true));

CREATE TABLE IF NOT EXISTS "discovery_pseudonyms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "pseudonym" text NOT NULL,
  "display_name_ciphertext" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_pseudonyms_kind_check" CHECK ("kind" IN ('device_user', 'commit_author', 'cloud_principal', 'device')),
  CONSTRAINT "discovery_pseudonyms_pseudonym_check" CHECK ("pseudonym" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "discovery_pseudonyms_seen_check" CHECK ("first_seen_at" <= "last_seen_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "discovery_pseudonyms_pseudonym_uq" ON "discovery_pseudonyms" ("pseudonym");
CREATE INDEX IF NOT EXISTS "discovery_pseudonyms_last_seen_idx" ON "discovery_pseudonyms" ("kind", "last_seen_at");

-- ---------------------------------------------------------------------------------------------------------------
-- the step-up kind `pseudonym_reveal`: revealing a person's name is its own action, not a settings relaxation
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE "step_up_grants" DROP CONSTRAINT IF EXISTS "step_up_grants_action_kind_check";
ALTER TABLE "step_up_grants" ADD CONSTRAINT "step_up_grants_action_kind_check" CHECK (
  "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage',
                    'owner_change', 'identity_manage', 'pseudonym_reveal')
);
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT IF EXISTS "webauthn_challenges_action_kind_check";
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_action_kind_check" CHECK (
  "action_kind" IS NULL
  OR "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage',
                       'owner_change', 'identity_manage', 'pseudonym_reveal')
);
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_step_up_actions_check";
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_actions_check" CHECK (
  jsonb_typeof("step_up_actions") = 'array'
  AND "step_up_actions" <@ '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal"]'::jsonb
);
ALTER TABLE "org_settings" ALTER COLUMN "step_up_actions"
  SET DEFAULT '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal"]'::jsonb;
-- first load (ADR-0180): the existing row requires the new kind too
UPDATE "org_settings" SET "step_up_actions" = "step_up_actions" || '["pseudonym_reveal"]'::jsonb
  WHERE NOT ("step_up_actions" ? 'pseudonym_reveal');
