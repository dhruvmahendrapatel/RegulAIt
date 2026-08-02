-- Migration 0063 (ADR-0051) — METERING & BILLING.
--
-- WHAT IS NEW HERE, AND WHAT DELIBERATELY IS NOT
--
--   NOT new: metering. `usage_events` (measured token/call counts) and
--   `cost_events` (list-price estimate) have been written unconditionally at
--   the point of every governed call since ADR-0019/0024. This migration adds
--   NO counter, NO rollup and NO second instrumentation point. Everything below
--   is a READ-SIDE consumer of that one ledger.
--
--   New: the commercial half — a rate card, a billing period, an append-only
--   statement, and a record of what was exported.
--
-- THE FOUR STRUCTURAL DECISIONS
--
--  1. RATE CARDS ARE IMMUTABLE VERSIONS, NOT EDITABLE ROWS. A price change
--     writes a NEW (name, version) row and supersedes the old one; there is no
--     UPDATE path for entries. `rate_card_entries` has no updated_at because it
--     is never updated. The reason is money: an issued invoice that pointed at
--     a mutable card would silently restate itself the day someone changed next
--     quarter's pricing, and nobody would see it happen.
--
--  2. A STATEMENT CARRIES ITS OWN PRICING SNAPSHOT. `pricing_snapshot` is the
--     exact entry list used, COPIED at cut time. Re-derivation replays the
--     snapshot, never the live card. Together with (1) this is belt AND braces:
--     even if a card were somehow mutated, the statement would not move.
--
--  3. STATEMENTS ARE APPEND-ONLY VERSIONS (the ADR-0040/0048 precedent).
--     Re-cutting a period writes version N+1 and marks N `superseded`. An
--     `issued` statement is never edited: a CHECK ties `issued`/`superseded` to
--     the presence of `issued_at`, and the gateway refuses to re-issue.
--
--  4. `effective_project_ids` ON THE STATEMENT. Same discipline as ADR-0047's
--     `report_runs`: the honest record of what this artifact was PERMITTED to
--     see, frozen at generation, so widening a scope later cannot retroactively
--     widen an already-cut document's audience. NULL means the org-wide set and
--     is only ever produced for an admin under an org-scoped period.
--
-- WHAT NO TABLE HERE DOES: contact a payment processor. There is no customer,
-- no payment method, no subscription and no invoice number, because none of
-- those are ours to hold — §4 delegates the payment lifecycle to whichever
-- backend is configured, and the only backend that exists is `noop`
-- (export-only, no network), which is §6's air-gapped default.

-- --------------------------------------------------------------------------
-- Rate cards — the COMMERCIAL price, deliberately not the metering price
-- --------------------------------------------------------------------------

CREATE TABLE "rate_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- append-only version. (name, version) is unique; a "change" is a new row.
  "version" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "status" text NOT NULL DEFAULT 'active',
  "description" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rate_cards_status_ck" CHECK ("status" IN ('active', 'superseded')),
  CONSTRAINT "rate_cards_version_ck" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "rate_cards_name_version_uq" ON "rate_cards" ("name", "version");
CREATE INDEX "rate_cards_status_idx" ON "rate_cards" ("status");

CREATE TABLE "rate_card_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rate_card_id" uuid NOT NULL REFERENCES "rate_cards"("id") ON DELETE CASCADE,
  "dimension" text NOT NULL,
  -- the model name / connector id / tool name, or '*' for every key in the
  -- dimension. Exact beats wildcard at lookup time.
  "match_key" text NOT NULL DEFAULT '*',
  "unit" text NOT NULL,
  "unit_price_usd" double precision NOT NULL,
  CONSTRAINT "rate_card_entries_dimension_ck"
    CHECK ("dimension" IN ('model', 'connector', 'mcp_tool', 'seat')),
  CONSTRAINT "rate_card_entries_unit_ck"
    CHECK ("unit" IN ('per_1k_input_tokens', 'per_1k_output_tokens', 'per_call', 'per_seat_month')),
  CONSTRAINT "rate_card_entries_price_ck" CHECK ("unit_price_usd" >= 0),
  -- a seat is priced per seat and nothing else is: two ways to price one thing
  -- is how a bill becomes ambiguous
  CONSTRAINT "rate_card_entries_seat_unit_ck"
    CHECK (("dimension" = 'seat') = ("unit" = 'per_seat_month'))
);
CREATE UNIQUE INDEX "rate_card_entries_card_key_uq"
  ON "rate_card_entries" ("rate_card_id", "dimension", "match_key", "unit");

-- --------------------------------------------------------------------------
-- Billing periods — the unit an invoice is cut for
-- --------------------------------------------------------------------------

CREATE TABLE "billing_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_id" uuid,
  -- scope_id is nullable for an org period, and Postgres treats NULLs in a
  -- UNIQUE index as DISTINCT — so without this derived key the same org month
  -- could be opened twice and cut two documents each claiming to be "the"
  -- statement for it. 'org' is the sentinel.
  "scope_key" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  -- the card a close will rate against unless one is named at cut time
  "rate_card_id" uuid REFERENCES "rate_cards"("id") ON DELETE SET NULL,
  "closed_at" timestamp with time zone,
  "closed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_periods_scope_kind_ck"
    CHECK ("scope_kind" IN ('org', 'initiative', 'team', 'project')),
  CONSTRAINT "billing_periods_status_ck" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "billing_periods_window_ck" CHECK ("period_end" > "period_start"),
  -- closed means closed: the timestamp and the status move together or not at all
  CONSTRAINT "billing_periods_closed_ck"
    CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
  CONSTRAINT "billing_periods_scope_id_ck"
    CHECK (("scope_kind" = 'org') = ("scope_id" IS NULL))
);
CREATE UNIQUE INDEX "billing_periods_scope_window_uq"
  ON "billing_periods" ("scope_kind", "scope_key", "period_start", "period_end");
CREATE INDEX "billing_periods_status_idx" ON "billing_periods" ("status");

-- --------------------------------------------------------------------------
-- Statements — APPEND-ONLY versions; an issued one is immutable
-- --------------------------------------------------------------------------

CREATE TABLE "billing_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "period_id" uuid NOT NULL REFERENCES "billing_periods"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "rating_mode" text NOT NULL DEFAULT 'estimated',

  -- THE FROZEN PRICE (see header decision 2)
  "rate_card_id" uuid REFERENCES "rate_cards"("id") ON DELETE SET NULL,
  "rate_card_name" text NOT NULL,
  "rate_card_version" integer NOT NULL,
  "pricing_snapshot" jsonb NOT NULL,

  -- THE FROZEN VISIBILITY (see header decision 4)
  "entitlement_scope" text NOT NULL,
  "effective_project_ids" jsonb,
  -- false = this version was cut by a caller who could only see PART of the
  -- period's scope. Such a version is a personal view and may never be issued.
  "covers_full_scope" boolean NOT NULL DEFAULT false,

  -- THE FROZEN WINDOW. Re-derivation replays the ledger as of this instant.
  "derived_through_at" timestamp with time zone NOT NULL,

  -- reconciliation anchors, denormalised so a drift check is a comparison
  -- rather than a re-read of a jsonb blob
  "source_usage_event_count" integer NOT NULL,
  "measured_input_tokens" bigint NOT NULL,
  "measured_output_tokens" bigint NOT NULL,
  "unpriced_event_count" integer NOT NULL,
  -- the sum of usage_events.cost_usd over the same rows: the anchor back to the
  -- cost dashboard and ADR-0047's reports. Kept SEPARATE from the billed total
  -- because §5 refuses to flatten estimate and commercial price into one number.
  "ledger_estimated_cost_usd" double precision NOT NULL,

  "seat_count" integer NOT NULL,
  "usage_subtotal_usd" double precision NOT NULL,
  "seat_subtotal_usd" double precision NOT NULL,
  "total_usd" double precision NOT NULL,

  "payload" jsonb NOT NULL,
  "generated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "issued_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "issued_at" timestamp with time zone,
  "issue_reason" text,
  CONSTRAINT "billing_statements_status_ck"
    CHECK ("status" IN ('draft', 'issued', 'superseded')),
  CONSTRAINT "billing_statements_rating_mode_ck"
    CHECK ("rating_mode" IN ('estimated', 'reconciled')),
  CONSTRAINT "billing_statements_entitlement_scope_ck"
    CHECK ("entitlement_scope" IN ('org', 'team', 'project')),
  CONSTRAINT "billing_statements_version_ck" CHECK ("version" >= 1),
  -- A draft has never been issued; anything ISSUED carries the moment it was.
  -- This is what makes "issued" a fact rather than a label. `superseded` is
  -- deliberately unconstrained on `issued_at`, because BOTH kinds of row reach
  -- it: a draft superseded by a newer derivation (no issued_at) and an issued
  -- invoice superseded by a later one (issued_at retained — superseding records
  -- that a newer derivation exists, it does not un-issue the old one).
  CONSTRAINT "billing_statements_issued_ck"
    CHECK (
      ("status" = 'draft' AND "issued_at" IS NULL)
      OR ("status" = 'issued' AND "issued_at" IS NOT NULL)
      OR ("status" = 'superseded')
    )
);
CREATE UNIQUE INDEX "billing_statements_period_version_uq"
  ON "billing_statements" ("period_id", "version");
CREATE INDEX "billing_statements_period_idx" ON "billing_statements" ("period_id");
CREATE INDEX "billing_statements_status_idx" ON "billing_statements" ("status");

-- --------------------------------------------------------------------------
-- Exports — ADR-0051 §1's "a double-bill is structurally impossible"
-- --------------------------------------------------------------------------
--
-- The idempotency grain is (period, backend), not (usage_events row, backend).
-- That is a deliberate simplification and it is exactly as strong here: a
-- statement covers a PERIOD's row set by construction, so "this period has been
-- shipped to this backend once" is the same statement as "each of its rows has
-- been shipped once". A per-row table would carry one row per metered call
-- forever to express the same constraint. The disclosure is in the amendment
-- rather than only in this comment.

CREATE TABLE "billing_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "statement_id" uuid NOT NULL REFERENCES "billing_statements"("id") ON DELETE CASCADE,
  "period_id" uuid NOT NULL REFERENCES "billing_periods"("id") ON DELETE CASCADE,
  "backend" text NOT NULL DEFAULT 'noop',
  "format" text NOT NULL,
  "row_count" integer NOT NULL,
  "usage_event_count" integer NOT NULL,
  "total_usd" double precision NOT NULL,
  "exported_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "exported_at" timestamp with time zone DEFAULT now() NOT NULL,
  "detail" jsonb,
  CONSTRAINT "billing_exports_backend_ck" CHECK ("backend" IN ('noop')),
  CONSTRAINT "billing_exports_format_ck" CHECK ("format" IN ('csv', 'json'))
);
-- one shipment per (period, backend), ever. A re-export is recognised and
-- returns the FIRST one rather than creating a second.
CREATE UNIQUE INDEX "billing_exports_period_backend_uq"
  ON "billing_exports" ("period_id", "backend");
CREATE INDEX "billing_exports_statement_idx" ON "billing_exports" ("statement_id");
