-- Migration 0064 (ADR-0052) — LICENSING & SEAT MANAGEMENT.
--
-- WHY THIS IS A FILE AND NOT A SERVER
--
--   ADR-0041 makes BYOC and air-gapped the PRIMARY motion: the control plane
--   runs inside the customer's own environment, and in the air-gapped case with
--   no outbound connection at all. There is no home to phone. So the license is
--   a signed artifact the admin installs, verified LOCALLY against a pinned
--   public key — the same shape, and deliberately the same crypto posture, as
--   ADR-0041's update bundle (`scripts/verify-update-bundle.sh`,
--   `infra/release-keys/`). One signing/verification scheme in this product,
--   not two.
--
-- WHAT THE `document` COLUMN IS, AND WHY IT IS TEXT
--
--   It is the EXACT BYTES that were signed, stored verbatim. The parsed fields
--   beside it (tenant, tier, seat_cap, …) are a DENORMALISED READ MODEL for
--   queries and the console; the authority is the signature over `document`,
--   and it can be re-verified at any time from this row alone. Storing only the
--   parsed fields would mean the signature could never be checked again, which
--   would make "signed" a claim about the past rather than a property of the
--   row. `document_sha256` is UNIQUE, so installing the same artifact twice is
--   recognised rather than duplicated.
--
-- THE POSTURE THIS SCHEMA ENCODES
--
--   * ONE active license at a time — a partial unique index, so "which license
--     is in force" can never be ambiguous. Installing a new one supersedes the
--     old; nothing is deleted, so the history of what was in force when is
--     answerable.
--   * A FORGED license never reaches this table. Verification happens before
--     the insert and a refusal is an `audit_log` deny row plus a
--     `license_verifications` row — it does not, and must not, displace the
--     license already installed.
--   * An ABSENT license is not an error state. No row here means the deployment
--     runs UNLICENSED: fully governed, every tier feature closed, no seat cap
--     enforced (there is no authoritative number to enforce). That is the
--     disclosed residual, chosen because bricking a fresh install would make
--     the governance layer depend on the commercial one — and would leave no
--     way to reach the console to install the license.
--
-- CLOCK. Validity is decided against the host clock. An offline license cannot
-- defend against an attacker who owns the machine it runs on; that is disclosed
-- in the ADR rather than mitigated here.

CREATE TABLE "licenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- THE SIGNED ARTIFACT (the authority)
  -- the exact bytes the signature covers, kept verbatim so the row stays
  -- independently re-verifiable forever
  "document" text NOT NULL,
  "document_sha256" text NOT NULL,
  "signature" text NOT NULL,
  "signing_key_id" text NOT NULL,

  -- THE PARSED READ MODEL (convenience, never the authority)
  "license_id" text NOT NULL,
  "tenant" text NOT NULL,
  "tier" text NOT NULL,
  "seat_cap" integer NOT NULL,
  "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "deployment_mode" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "not_before" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "grace_days" integer NOT NULL,
  -- OPT-IN, never the default: a total shutdown on expiry, available only
  -- because some customers' own contracts require it.
  "hard_stop_on_expiry" boolean DEFAULT false NOT NULL,

  "status" text DEFAULT 'active' NOT NULL,
  "installed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  CONSTRAINT "licenses_status_ck" CHECK ("status" IN ('active', 'superseded')),
  CONSTRAINT "licenses_seat_cap_ck" CHECK ("seat_cap" >= 1),
  CONSTRAINT "licenses_grace_ck" CHECK ("grace_days" >= 0),
  CONSTRAINT "licenses_window_ck" CHECK ("expires_at" > "not_before"),
  CONSTRAINT "licenses_mode_ck" CHECK ("deployment_mode" IN ('hosted', 'byoc', 'airgapped')),
  CONSTRAINT "licenses_superseded_ck"
    CHECK (("status" = 'superseded') = ("superseded_at" IS NOT NULL))
);
-- installing the same artifact twice is recognised, not duplicated
CREATE UNIQUE INDEX "licenses_document_sha_uq" ON "licenses" ("document_sha256");
-- EXACTLY ONE license is in force at a time. "Which one applies" must never be
-- a question the application answers by picking the newest row and hoping.
CREATE UNIQUE INDEX "licenses_single_active_uq" ON "licenses" ("status") WHERE "status" = 'active';

-- --------------------------------------------------------------------------
-- The verification trail
-- --------------------------------------------------------------------------
--
-- ADR-0052 §1 describes verification "at boot and on a periodic timer". There
-- is no in-process scheduler in this codebase (ADRs 0044-0051 all landed the
-- same way), so the periodic verifier is an ENDPOINT an operator or an external
-- cron drives. This table is how a deployment that never wires that cron SEES
-- it: an empty table, or a `last checked` that stops moving, is the disclosure.
--
-- Every REFUSAL lands here too, including refusals of artifacts that were never
-- installed — a rejected forgery is exactly the row an operator needs.

CREATE TABLE "license_verifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL when the artifact was refused and therefore never became a row
  "license_row_id" uuid REFERENCES "licenses"("id") ON DELETE SET NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "trigger" text NOT NULL,
  "ok" boolean NOT NULL,
  "state" text NOT NULL,
  "rule_id" text NOT NULL,
  "reason" text NOT NULL,
  "seat_cap" integer,
  "active_seats" integer,
  "signing_key_id" text,
  "checked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "detail" jsonb,
  CONSTRAINT "license_verifications_trigger_ck"
    CHECK ("trigger" IN ('install', 'periodic', 'manual')),
  CONSTRAINT "license_verifications_state_ck"
    CHECK ("state" IN ('absent', 'not_yet_valid', 'valid', 'grace', 'expired', 'invalid'))
);
CREATE INDEX "license_verifications_at_idx" ON "license_verifications" ("at");
CREATE INDEX "license_verifications_ok_idx" ON "license_verifications" ("ok");
