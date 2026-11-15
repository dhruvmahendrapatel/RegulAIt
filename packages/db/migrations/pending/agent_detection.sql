-- ADR-0333 (lane E15): rule-based detection of risky agent behaviour over the governed action stream.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `detection_rule_packs`: admin-edited, signed rule pack versions (the built-in default pack has no row). `pack` is
--   a schema-validated configuration document (ADR-0200 exception).
-- - `detection_engine_state`: the engine's live cursor over `audit_log.seq` and its first-run history replay
--   checkpoint (ADR-0333 D2), leased per sweep.
-- - `detection_incidents` and `detection_incident_evidence`: each detection and the audit rows that prove it. The
--   audit pointers are FK-free on purpose, like `decision_receipts.audit_id`: the audit trail is FK-free and its
--   retention prune must not be blocked by, or cascade into, incident history.
-- - The deployment is single-tenant, so like the other register tables (0281) there is no tenant column for RLS.
-- No new functions or refusal triggers.

CREATE TABLE IF NOT EXISTS "detection_rule_packs" (
  "version" integer PRIMARY KEY NOT NULL,
  "pack" jsonb NOT NULL,
  "pack_digest" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "detection_rule_packs_version_check" CHECK ("version" >= 1),
  CONSTRAINT "detection_rule_packs_digest_check" CHECK ("pack_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "detection_rule_packs_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$')
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_rule_packs" ADD CONSTRAINT "detection_rule_packs_key_id_receipt_signing_keys_key_id_fk"
    FOREIGN KEY ("key_id") REFERENCES "public"."receipt_signing_keys"("key_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_rule_packs" ADD CONSTRAINT "detection_rule_packs_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "detection_engine_state" (
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
  "cursor_seq" bigint NOT NULL,
  "lease_until" timestamp with time zone,
  "lease_token" uuid,
  "last_sweep_at" timestamp with time zone,
  "unverified_pack_version" integer,
  "replay_cursor_seq" bigint DEFAULT 0 NOT NULL,
  "replay_until_seq" bigint DEFAULT 0 NOT NULL,
  "replay_completed_at" timestamp with time zone,
  CONSTRAINT "detection_engine_state_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "detection_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" text NOT NULL,
  "pack_version" integer,
  "severity" text NOT NULL,
  "group_key" text NOT NULL,
  "trigger_audit_id" uuid NOT NULL,
  "trigger_audit_seq" bigint NOT NULL,
  "user_id" uuid,
  "delegation_grant_id" uuid,
  "actor_identity_id" uuid,
  "actor_chain" jsonb,
  "historical" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "status_changed_by" uuid,
  "status_changed_at" timestamp with time zone,
  "response" text DEFAULT 'alert' NOT NULL,
  "response_state" text DEFAULT 'none' NOT NULL,
  "response_error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "detection_incidents_rule_id_check" CHECK ("rule_id" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT "detection_incidents_group_key_check" CHECK ("group_key" ~ '^(grant|user|endpoint):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT "detection_incidents_actor_chain_check" CHECK ("actor_chain" IS NULL OR (jsonb_typeof("actor_chain") = 'array' AND jsonb_array_length("actor_chain") BETWEEN 1 AND 9)),
  CONSTRAINT "detection_incidents_response_error_check" CHECK ("response_error_code" IS NULL OR "response_error_code" ~ '^[a-z_]{1,48}$'),
  CONSTRAINT "detection_incidents_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "detection_incidents_status_check" CHECK ("status" IN ('open', 'acknowledged', 'closed')),
  CONSTRAINT "detection_incidents_response_check" CHECK ("response" IN ('alert', 'suspend_grant', 'revoke_credential', 'require_approval')),
  CONSTRAINT "detection_incidents_response_state_check" CHECK ("response_state" IN ('none', 'done', 'failed')),
  CONSTRAINT "detection_incidents_historical_alert_check" CHECK (NOT "historical" OR "response" = 'alert')
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_pack_version_detection_rule_packs_version_fk"
    FOREIGN KEY ("pack_version") REFERENCES "public"."detection_rule_packs"("version") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_delegation_grant_id_delegation_grants_id_fk"
    FOREIGN KEY ("delegation_grant_id") REFERENCES "public"."delegation_grants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_actor_identity_id_workload_identities_id_fk"
    FOREIGN KEY ("actor_identity_id") REFERENCES "public"."workload_identities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incidents" ADD CONSTRAINT "detection_incidents_status_changed_by_users_id_fk"
    FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "detection_incidents_rule_trigger_uq" ON "detection_incidents" USING btree ("rule_id", "trigger_audit_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detection_incidents_status_created_idx" ON "detection_incidents" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "detection_incidents_group_idx" ON "detection_incidents" USING btree ("group_key", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "detection_incident_evidence" (
  "incident_id" uuid NOT NULL,
  "audit_id" uuid NOT NULL,
  "audit_seq" bigint NOT NULL,
  "step_index" smallint NOT NULL,
  CONSTRAINT "detection_incident_evidence_pk" PRIMARY KEY ("incident_id", "audit_seq"),
  CONSTRAINT "detection_incident_evidence_step_check" CHECK ("step_index" BETWEEN 0 AND 999)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "detection_incident_evidence" ADD CONSTRAINT "detection_incident_evidence_incident_id_detection_incidents_id_fk"
    FOREIGN KEY ("incident_id") REFERENCES "public"."detection_incidents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
