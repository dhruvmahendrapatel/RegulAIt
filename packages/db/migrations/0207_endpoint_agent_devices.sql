-- ADR-0195 SD4b: the gateway side of the RegulAIt endpoint agent (agents/endpoint/, SD4a).
--
-- Enrolment (owner decision 3): an admin issues a per-source bulk enrolment token with a device cap the admin must
-- set (no unlimited default) and an expiry of at most 30 days. The package's install step redeems it once per device
-- for a short-lived device ticket (at most 7 days), and each user of the device registers its own device key with
-- that ticket as a workload identity of the new kind `endpoint_agent` (ADR-0188 S7 pattern). Only SHA-256 digests of
-- the token and the ticket are stored. Nothing here works unless the source's `endpoint_agent` discovery source is
-- enabled, which is SD0's `settings_relax` step-up (strict default: off).
--
-- Pseudonymity (decision 20): a device is named only by its SD0 `device` pseudonym and a device user only by its
-- `device_user` pseudonym; the display names live enveloped in `discovery_pseudonyms`.
--
-- Data minimisation (master decision): a report row keeps digests, counts, fixed gap codes and the sightings that
-- matched the enabled catalogue (catalogue values only). It never keeps a fact's path, a key name, an
-- environment-variable name or anything else the device sent beyond that.

ALTER TABLE "workload_identities" DROP CONSTRAINT "workload_identities_kind_check";
--> statement-breakpoint
ALTER TABLE "workload_identities" ADD CONSTRAINT "workload_identities_kind_check"
  CHECK ("kind" IN ('agent', 'builder_agent', 'engine_runner', 'worker_runtime', 'pdp', 'endpoint_agent'));
--> statement-breakpoint
ALTER TABLE "workload_identities" DROP CONSTRAINT "workload_identities_subject_check";
--> statement-breakpoint
ALTER TABLE "workload_identities" ADD CONSTRAINT "workload_identities_subject_check" CHECK (
  ("kind" = 'agent' AND "agent_id" IS NOT NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
  OR ("kind" = 'builder_agent' AND "agent_id" IS NULL AND "builder_agent_id" IS NOT NULL AND "engine_runner_id" IS NULL)
  OR ("kind" = 'engine_runner' AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NOT NULL)
  OR ("kind" IN ('worker_runtime', 'pdp', 'endpoint_agent') AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "endpoint_enrolment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "token_hash" text NOT NULL,
  "device_cap" integer NOT NULL,
  "devices_enrolled" integer DEFAULT 0 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "endpoint_enrolment_tokens_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "endpoint_enrolment_tokens_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_enrolment_tokens_label_check" CHECK (length("label") BETWEEN 1 AND 100),
  CONSTRAINT "endpoint_enrolment_tokens_cap_check" CHECK ("device_cap" BETWEEN 1 AND 100000),
  CONSTRAINT "endpoint_enrolment_tokens_enrolled_check" CHECK ("devices_enrolled" >= 0 AND "devices_enrolled" <= "device_cap"),
  CONSTRAINT "endpoint_enrolment_tokens_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "endpoint_enrolment_tokens_revoked_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE INDEX "endpoint_enrolment_tokens_source_idx" ON "endpoint_enrolment_tokens" ("source_id");
--> statement-breakpoint
CREATE TABLE "endpoint_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "token_id" uuid NOT NULL REFERENCES "endpoint_enrolment_tokens"("id") ON DELETE CASCADE,
  "device_pseudonym" text NOT NULL,
  "os" text NOT NULL,
  "arch" text NOT NULL,
  "agent_version" text NOT NULL,
  "ticket_hash" text NOT NULL,
  "ticket_expires_at" timestamp with time zone NOT NULL,
  "identity_cap" integer DEFAULT 8 NOT NULL,
  "identities_registered" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_report_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "endpoint_devices_ticket_uq" UNIQUE ("ticket_hash"),
  CONSTRAINT "endpoint_devices_ticket_check" CHECK ("ticket_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "endpoint_devices_pseudonym_check" CHECK ("device_pseudonym" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "endpoint_devices_os_check" CHECK ("os" IN ('linux', 'darwin', 'windows')),
  CONSTRAINT "endpoint_devices_arch_check" CHECK ("arch" IN ('amd64', 'arm64')),
  CONSTRAINT "endpoint_devices_version_check" CHECK ("agent_version" ~ '^[0-9A-Za-z.+-]{1,32}$'),
  CONSTRAINT "endpoint_devices_ticket_expiry_check" CHECK ("ticket_expires_at" > "created_at" AND "ticket_expires_at" <= "created_at" + interval '7 days'),
  CONSTRAINT "endpoint_devices_identity_cap_check" CHECK ("identity_cap" BETWEEN 1 AND 32),
  CONSTRAINT "endpoint_devices_registered_check" CHECK ("identities_registered" >= 0 AND "identities_registered" <= "identity_cap"),
  CONSTRAINT "endpoint_devices_revoked_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE INDEX "endpoint_devices_source_idx" ON "endpoint_devices" ("source_id", "created_at");
--> statement-breakpoint
CREATE INDEX "endpoint_devices_token_idx" ON "endpoint_devices" ("token_id");
--> statement-breakpoint
CREATE TABLE "endpoint_agent_identities" (
  "identity_id" uuid PRIMARY KEY NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "device_user_pseudonym" text NOT NULL,
  "key_protection" text NOT NULL,
  "key_provider" text NOT NULL,
  "agent_version" text NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_report_at" timestamp with time zone,
  CONSTRAINT "endpoint_agent_identities_pseudonym_check" CHECK ("device_user_pseudonym" ~ '^psn:[0-9a-f]{24}$'),
  CONSTRAINT "endpoint_agent_identities_protection_check" CHECK (
    ("key_protection" = 'hardware' AND "key_provider" IN ('tpm', 'tpm_ncrypt', 'secure_enclave'))
    OR ("key_protection" = 'software' AND "key_provider" IN ('file', 'dpapi'))
  ),
  CONSTRAINT "endpoint_agent_identities_version_check" CHECK ("agent_version" ~ '^[0-9A-Za-z.+-]{1,32}$')
);
--> statement-breakpoint
CREATE INDEX "endpoint_agent_identities_device_idx" ON "endpoint_agent_identities" ("device_id");
--> statement-breakpoint
CREATE TABLE "endpoint_agent_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "device_id" uuid NOT NULL REFERENCES "endpoint_devices"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "discovery_sources"("id") ON DELETE CASCADE,
  "snapshot_id" uuid NOT NULL,
  "collected_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "body_sha256" text NOT NULL,
  "facts_digest" text NOT NULL,
  "manifest_version" text NOT NULL,
  "manifest_digest" text NOT NULL,
  "facts_received" integer NOT NULL,
  "facts_env_refused" integer NOT NULL,
  "facts_unmatched" integer NOT NULL,
  "dropped_snapshots" integer NOT NULL,
  "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sightings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  -- the discovery run that committed it (no foreign key: a run's deletion must not rewrite this row)
  "run_id" uuid,
  "committed_at" timestamp with time zone,
  CONSTRAINT "endpoint_agent_reports_snapshot_uq" UNIQUE ("identity_id", "snapshot_id"),
  CONSTRAINT "endpoint_agent_reports_digest_check" CHECK (
    "body_sha256" ~ '^[0-9a-f]{64}$' AND "facts_digest" ~ '^[0-9a-f]{64}$' AND "manifest_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "endpoint_agent_reports_manifest_version_check" CHECK ("manifest_version" ~ '^[0-9A-Za-z.+-]{1,32}$'),
  CONSTRAINT "endpoint_agent_reports_counts_check" CHECK (
    "facts_received" BETWEEN 0 AND 2000 AND "facts_env_refused" BETWEEN 0 AND "facts_received"
    AND "facts_unmatched" BETWEEN 0 AND "facts_received" AND "dropped_snapshots" BETWEEN 0 AND 1000000
  ),
  CONSTRAINT "endpoint_agent_reports_gaps_check" CHECK (jsonb_typeof("gaps") = 'array' AND jsonb_array_length("gaps") <= 200),
  CONSTRAINT "endpoint_agent_reports_sightings_check" CHECK (jsonb_typeof("sightings") = 'array' AND jsonb_array_length("sightings") <= 2000),
  CONSTRAINT "endpoint_agent_reports_status_check" CHECK (
    ("status" = 'pending' AND "run_id" IS NULL AND "committed_at" IS NULL)
    OR ("status" IN ('committed', 'refused') AND "run_id" IS NOT NULL AND "committed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "endpoint_agent_reports_pending_idx" ON "endpoint_agent_reports" ("source_id", "received_at") WHERE "status" = 'pending';
--> statement-breakpoint
-- a report is evidence: what was received is written once; the only change is its outcome (pending -> committed, or
-- pending -> refused when SD0's observation checks refuse its run). A row is deleted only as the cascade of its own
-- identity, device or source, once that parent row is gone (0182/0186's pattern); a plain DELETE is refused.
CREATE OR REPLACE FUNCTION "regulait_endpoint_agent_report_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 AND (
         NOT EXISTS (SELECT 1 FROM public."endpoint_agent_identities" WHERE "identity_id" = OLD."identity_id")
      OR NOT EXISTS (SELECT 1 FROM public."endpoint_devices" WHERE "id" = OLD."device_id")
      OR NOT EXISTS (SELECT 1 FROM public."discovery_sources" WHERE "id" = OLD."source_id")
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'endpoint_agent_reports: a report is evidence; it goes only with its identity, device or source'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."identity_id" IS DISTINCT FROM OLD."identity_id"
     OR NEW."device_id" IS DISTINCT FROM OLD."device_id" OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."snapshot_id" IS DISTINCT FROM OLD."snapshot_id" OR NEW."collected_at" IS DISTINCT FROM OLD."collected_at"
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at" OR NEW."body_sha256" IS DISTINCT FROM OLD."body_sha256"
     OR NEW."facts_digest" IS DISTINCT FROM OLD."facts_digest" OR NEW."manifest_version" IS DISTINCT FROM OLD."manifest_version"
     OR NEW."manifest_digest" IS DISTINCT FROM OLD."manifest_digest" OR NEW."facts_received" IS DISTINCT FROM OLD."facts_received"
     OR NEW."facts_env_refused" IS DISTINCT FROM OLD."facts_env_refused" OR NEW."facts_unmatched" IS DISTINCT FROM OLD."facts_unmatched"
     OR NEW."dropped_snapshots" IS DISTINCT FROM OLD."dropped_snapshots" OR NEW."gaps" IS DISTINCT FROM OLD."gaps"
     OR NEW."sightings" IS DISTINCT FROM OLD."sightings"
     OR OLD."status" <> 'pending' OR NEW."status" NOT IN ('committed', 'refused') THEN
    RAISE EXCEPTION 'endpoint_agent_reports: a report is written once; it may only be committed or refused'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "endpoint_agent_reports_guard" ON "endpoint_agent_reports";
--> statement-breakpoint
CREATE TRIGGER "endpoint_agent_reports_guard"
  BEFORE UPDATE OR DELETE ON "endpoint_agent_reports"
  FOR EACH ROW EXECUTE FUNCTION "regulait_endpoint_agent_report_guard"();
--> statement-breakpoint
-- migration 0185's rule: a table that refuses a row UPDATE also refuses TRUNCATE (which fires no row trigger)
DROP TRIGGER IF EXISTS "endpoint_agent_reports_no_truncate" ON public."endpoint_agent_reports";
--> statement-breakpoint
CREATE TRIGGER "endpoint_agent_reports_no_truncate" BEFORE TRUNCATE ON public."endpoint_agent_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
