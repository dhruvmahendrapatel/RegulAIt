-- Migration 0081 (ADR-0069) — CROSS-VENDOR COST CONSOLIDATION.
--
-- ADR-0049/0051 gave this platform a MEASURED spend ledger: `usage_events` has
-- a row for every call RegulAIt itself intercepted, entitled, dispatched and
-- priced. That is metering, and it is honest. It is also structurally blind to
-- the majority of a real company's AI spend — per-seat SaaS (Claude Code,
-- Copilot, Cursor), a raw vendor key somebody uses outside the gateway, a
-- Bedrock line on a cloud bill. None of that traffic passes through us, so no
-- amount of better metering can ever see it, and a per-person chargeback figure
-- was therefore impossible rather than merely incomplete.
--
-- This migration adds the other half: a place to put a customer's own export,
-- restated, with an identity-resolution layer onto RegulAIt users and enough
-- provenance on every row that a disputed chargeback can be argued.
--
-- THE ONE RULE THIS MIGRATION ENFORCES IN THE DATABASE
--
--   Imported money lives in a DIFFERENT TABLE from metered money, and
--   `imported_cost_lines.basis` carries a CHECK admitting the single value
--   'imported'. Not a convention, not a column somebody remembers to filter on
--   — a constraint. There is no row anywhere in this schema that could be read
--   as metered when it was not, and no future writer can create one without
--   deliberately dropping a constraint.
--
--   The consolidated read surface reports the two sides beside each other and
--   has no field for their sum. That is a property of the API shape rather than
--   of this file, but it is the reason this file keeps them apart.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No column on `usage_events`. Nothing about the metered ledger changes, so
--   no existing billing statement, forecast, budget check or exec report moves
--   by a cent. ADR-0051's statements stay METERED-ONLY by design: an invoice
--   must bill only what we observed.
--
--   No FX rate table and no conversion. `currency` is stored per line and a
--   mixed-currency rollup reports `usd = NULL` with a stated reason rather than
--   inventing a rate. A guessed rate is a wrong invoice.
--
--   No scheduled re-import job. There is nothing to poll: RegulAIt holds no
--   vendor billing-API credential, and minting one is an egress + credential-
--   custody decision (ADR-0034/0062/0063), not a scheduling one. An import is
--   an operator act with a file attached, and the consolidated view reports its
--   own staleness so an operator can SEE that nobody has uploaded since March.
--
--   No write path from an import to anything governed. Exhaustively, an import
--   writes one `cost_import_batches` row and its `imported_cost_lines`. No
--   column below names a role, a grant, an entitlement, an agent, an approval
--   or a budget, and `resolved_user_id` can only point at a user that already
--   exists.

-- ---------------------------------------------------------------------------
-- 1. The person-level chargeback key.
--
-- `projects.cost_center` and `initiatives.cost_center` already exist and carry
-- the code for a governed unit of WORK; metered spend rolls up through them.
-- Imported per-seat spend belongs to a HUMAN — a Copilot seat is not a project
-- — and there was nowhere to put its chargeback key. NULL keeps every existing
-- user exactly as they are; a person with no cost centre rolls up under
-- "(no cost centre)" rather than having one inferred from their memberships,
-- which stops being well-defined the moment somebody belongs to two projects.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cost_center" text;

-- ---------------------------------------------------------------------------
-- 2. The batch: every import, planned, applied, REFUSED and revoked.
--
-- The refusals are the rows that matter, exactly as in `shadow_ai_imports` and
-- `onboarding_imports`. `rows_parsed = rows_accepted + rows_refused` is a CHECK
-- rather than an intention: that identity IS the claim that nothing was
-- silently dropped, and a silently dropped row is a wrong total presented
-- confidently.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "cost_import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "adapter" text NOT NULL,
  "vendor" text NOT NULL,
  "format" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "source" text,
  "payload_sha256" text NOT NULL,
  "rows_parsed" integer DEFAULT 0 NOT NULL,
  "rows_accepted" integer DEFAULT 0 NOT NULL,
  "rows_refused" integer DEFAULT 0 NOT NULL,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  "total_usd" double precision,
  "refusals" jsonb NOT NULL,
  "summary" jsonb NOT NULL,
  "pii_mode" text,
  "scan_verdict" text,
  "scan_findings" jsonb,
  "rule_id" text NOT NULL,
  "reason" text NOT NULL,
  "requested_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  CONSTRAINT "cost_import_batches_format_check" CHECK ("format" IN ('csv','json')),
  CONSTRAINT "cost_import_batches_mode_check" CHECK ("mode" IN ('dry_run','apply')),
  CONSTRAINT "cost_import_batches_status_check" CHECK ("status" IN ('planned','applied','refused','revoked')),
  CONSTRAINT "cost_import_batches_scan_verdict_check"
    CHECK ("scan_verdict" IS NULL OR "scan_verdict" IN ('clean','flagged','blocked')),
  CONSTRAINT "cost_import_batches_row_identity_check"
    CHECK ("rows_parsed" = "rows_accepted" + "rows_refused")
);

DO $$ BEGIN
  ALTER TABLE "cost_import_batches" ADD CONSTRAINT "cost_import_batches_requested_by_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "cost_import_batches" ADD CONSTRAINT "cost_import_batches_revoked_by_fk"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "cost_import_batches_created_idx" ON "cost_import_batches" ("created_at");
CREATE INDEX IF NOT EXISTS "cost_import_batches_status_idx" ON "cost_import_batches" ("status");
CREATE INDEX IF NOT EXISTS "cost_import_batches_vendor_idx" ON "cost_import_batches" ("vendor");

-- THE DOUBLE-COUNT GUARD. Re-applying the same bytes is the single easiest way
-- to turn this feature into a lie: the operator sees "imported successfully"
-- twice and every consolidated figure is doubled. A PARTIAL unique index over
-- live applied batches makes the second apply a real 409 with a stated reason.
-- Partial rather than total so a dry run, a refusal and a REVOKED batch can all
-- carry the same fingerprint — revoking is exactly how an operator legitimately
-- re-imports a corrected file.
CREATE UNIQUE INDEX IF NOT EXISTS "cost_import_batches_applied_payload_uq"
  ON "cost_import_batches" ("payload_sha256") WHERE "status" = 'applied';

-- ---------------------------------------------------------------------------
-- 3. The restated lines.
--
-- `basis` and its CHECK are the honesty spine. `resolution_method` is NOT NULL
-- and is paired with `resolved_user_id` by a CHECK, so "unattributed" is a
-- real countable state rather than a null that might mean anything, and a
-- chargeback can always be traced to the rule that made it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "imported_cost_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL,
  "basis" text DEFAULT 'imported' NOT NULL,
  "vendor" text NOT NULL,
  "adapter" text NOT NULL,
  "source_row" integer NOT NULL,
  "account_ref" text NOT NULL,
  "account_key" text NOT NULL,
  "resolved_user_id" uuid,
  "resolution_method" text NOT NULL,
  "resolution_detail" text NOT NULL,
  "resolution_mapping_id" uuid,
  "resolution_domain_rule_id" uuid,
  "cost_center" text,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "amount" double precision NOT NULL,
  "currency" text DEFAULT 'USD' NOT NULL,
  "billing_kind" text NOT NULL,
  "service" text,
  "description" text,
  "quantity" double precision,
  "unit" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- THE HONESTY SPINE. Nothing can ever store a line here that claims to have
  -- been metered by RegulAIt.
  CONSTRAINT "imported_cost_lines_basis_check" CHECK ("basis" = 'imported'),
  CONSTRAINT "imported_cost_lines_period_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "imported_cost_lines_billing_kind_check"
    CHECK ("billing_kind" IN ('seat','usage','commit','other')),
  CONSTRAINT "imported_cost_lines_method_check"
    CHECK ("resolution_method" IN ('exact_email','admin_alias','domain_rule','unresolved')),
  CONSTRAINT "imported_cost_lines_resolution_check"
    CHECK (("resolution_method" = 'unresolved') = ("resolved_user_id" IS NULL))
);

DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_batch_fk"
    FOREIGN KEY ("batch_id") REFERENCES "cost_import_batches"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ON DELETE SET NULL, deliberately: deleting a user must UN-ATTRIBUTE their
-- imported spend, never delete it. The money was real whether or not the person
-- is still on the roster, and a chargeback report that quietly shrinks when
-- somebody leaves is a broken chargeback report.
DO $$ BEGIN
  ALTER TABLE "imported_cost_lines" ADD CONSTRAINT "imported_cost_lines_user_fk"
    FOREIGN KEY ("resolved_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "imported_cost_lines_batch_idx" ON "imported_cost_lines" ("batch_id");
CREATE INDEX IF NOT EXISTS "imported_cost_lines_user_idx" ON "imported_cost_lines" ("resolved_user_id", "period_start");
CREATE INDEX IF NOT EXISTS "imported_cost_lines_period_idx" ON "imported_cost_lines" ("period_start", "period_end");
CREATE INDEX IF NOT EXISTS "imported_cost_lines_account_idx" ON "imported_cost_lines" ("account_key");

-- NOTE ON THE ON-DELETE-SET-NULL / CHECK INTERACTION, stated because it is
-- surprising: a user delete sets `resolved_user_id` to NULL and would then
-- violate `imported_cost_lines_resolution_check` while `resolution_method`
-- still says (say) 'exact_email'. Postgres evaluates row CHECKs on the UPDATE
-- the FK action performs, so the delete would fail. That is not the behaviour
-- we want — a user must remain deletable — so the method is stamped back to
-- 'unresolved' by the same trigger that nulls it.
CREATE OR REPLACE FUNCTION "imported_cost_lines_unattribute"() RETURNS trigger AS $$
BEGIN
  IF NEW."resolved_user_id" IS NULL AND NEW."resolution_method" <> 'unresolved' THEN
    NEW."resolution_method" := 'unresolved';
    NEW."resolution_detail" :=
      'the RegulAIt user this line was attributed to has been deleted; the spend is retained as unattributed. Prior attribution: '
      || OLD."resolution_detail";
    NEW."resolution_mapping_id" := NULL;
    NEW."resolution_domain_rule_id" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "imported_cost_lines_unattribute_trg" ON "imported_cost_lines";
CREATE TRIGGER "imported_cost_lines_unattribute_trg"
  BEFORE UPDATE ON "imported_cost_lines"
  FOR EACH ROW EXECUTE FUNCTION "imported_cost_lines_unattribute"();

-- ---------------------------------------------------------------------------
-- 4. Identity resolution: the two admin-authored rule tables.
--
-- Neither is ever written by an import. A file cannot invent a person and
-- cannot invent the mapping onto one; `reason` is NOT NULL on both because an
-- assertion nobody has to justify is an assertion nobody can review, and every
-- create/delete also writes an `audit_log` row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "vendor_account_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor" text DEFAULT '*' NOT NULL,
  "account_key" text NOT NULL,
  "user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "vendor_account_aliases" ADD CONSTRAINT "vendor_account_aliases_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "vendor_account_aliases" ADD CONSTRAINT "vendor_account_aliases_created_by_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_account_aliases_uq"
  ON "vendor_account_aliases" ("vendor", "account_key");
CREATE INDEX IF NOT EXISTS "vendor_account_aliases_user_idx" ON "vendor_account_aliases" ("user_id");

CREATE TABLE IF NOT EXISTS "vendor_domain_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor" text DEFAULT '*' NOT NULL,
  "from_domain" text NOT NULL,
  "to_domain" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vendor_domain_rules_distinct_check" CHECK (lower("from_domain") <> lower("to_domain"))
);

DO $$ BEGIN
  ALTER TABLE "vendor_domain_rules" ADD CONSTRAINT "vendor_domain_rules_created_by_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "vendor_domain_rules_uq"
  ON "vendor_domain_rules" ("vendor", "from_domain", "to_domain");
