-- Migration 0073 (ADR-0058) — REGULATORY COMPLIANCE PACKS.
--
-- THE COLUMN THAT IS NOT HERE
--
--   There is no `satisfied` column, no `status` on a control, no
--   `marked_met_by`. Nowhere in these four tables can a human record that a
--   control is met. Satisfaction is COMPUTED at evaluation time by a SELECT
--   over ledgers that already exist — `audit_log`, `approvals`,
--   `model_card_approvals`, `eval_runs`, `guardrail_configs`, `abac_policies`,
--   `lineage_edges`, `usage_events`, `compliance_profiles` — and it goes red
--   again the moment those rows stop existing. A tick-box would have been this
--   feature's entire failure mode: an ISO 42001 scorecard that is green because
--   somebody clicked, not because anything happened. So there is no box.
--
--   The one thing a human MAY record is an ATTESTATION, and it has its own
--   table, its own status (`attested`, never `satisfied`), and the user id of
--   whoever made it. Organisational controls — training, incident response,
--   post-market monitoring plans, BAAs — are not observable from a control
--   plane, and reporting them as satisfied would be the exact false assurance
--   ADR-0058 exists to refuse.
--
-- A PACK IS DATA
--
--   `compliance_packs` + `compliance_pack_controls` are the whole catalogue.
--   `DEFAULT_COMPLIANCE_PACKS` in @regulait/shared is a SEED that
--   `POST /v1/compliance/packs/seed` INSERTS as ordinary rows; the evaluator
--   reads rows and nothing else. Empty the tables and it evaluates nothing;
--   POST a framework nobody has heard of and it is evaluated on the next call
--   with no deploy. `framework` is free text on purpose — a customer's internal
--   control set must not require an enum migration to become a first-class
--   pack.
--
--   The one boundary: `collector` names a PARAMETERISED QUERY the gateway
--   knows, not SQL. A pack is analyst-authored data and a pack that could carry
--   SQL would be an injection primitive wearing a control mapping's clothes. A
--   control needing a ledger RegulAIt does not keep is marked
--   attestation-required — never silently satisfied.
--
-- HOW A PACK IS UPDATED WITHOUT A RELEASE
--
--   A framework revision is a NEW ROW: same `framework`, higher `version`, its
--   controls posted with it, then activated — and activation retires the
--   previous version in the same transaction. The partial unique index below
--   makes "at most one active version per framework" a database fact rather
--   than application etiquette. Generated reports store the pack version that
--   produced them (`compliance_pack_reports.pack_version`), so a revision never
--   rewrites a report an auditor was already handed.

CREATE TABLE "compliance_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- free text: a customer's own framework is a first-class pack
  "framework" text NOT NULL,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "description" text,
  -- where the mapping came from and who reviewed it. Makes staleness legible;
  -- cannot make a mapping authoritative.
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- the §8.3 cascade tag this pack DRIVES. A pack enforces nothing itself.
  "cascade_tag" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "activated_at" timestamptz,
  "retired_at" timestamptz,
  CONSTRAINT "compliance_packs_version_check" CHECK ("version" >= 1),
  CONSTRAINT "compliance_packs_status_check" CHECK ("status" IN ('draft','active','retired'))
);

CREATE UNIQUE INDEX "compliance_packs_framework_version_uq"
  ON "compliance_packs" ("framework", "version");

-- AT MOST ONE ACTIVE VERSION PER FRAMEWORK. Two would mean two answers to
-- "which mapping evidenced this report".
CREATE UNIQUE INDEX "compliance_packs_one_active_uq"
  ON "compliance_packs" ("framework") WHERE "status" = 'active';

CREATE TABLE "compliance_pack_controls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" uuid NOT NULL REFERENCES "compliance_packs"("id") ON DELETE CASCADE,
  -- the FRAMEWORK's own identifier, e.g. 'eu-ai-act:art-12-record-keeping'
  "control_ref" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  -- the mapping author's DECLARED posture (ADR-0058 §4)
  "coverage" text NOT NULL,
  -- a NAMED collector, not SQL
  "collector" text NOT NULL,
  "collector_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "min_evidence_count" integer DEFAULT 1 NOT NULL,
  -- TRUE = organisational control; the evaluator returns before consulting any
  -- count, so this can never resolve to 'satisfied'
  "attestation_required" boolean DEFAULT false NOT NULL,
  "owner_note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "compliance_pack_controls_min_evidence_check" CHECK ("min_evidence_count" >= 1),
  CONSTRAINT "compliance_pack_controls_coverage_check"
    CHECK ("coverage" IN ('enforced','evidenced','partial','unaddressed')),
  -- THE PAIRING RULE, IN THE DATABASE: an attestation-required control has no
  -- collector, so no ledger row can quietly satisfy an organisational control.
  CONSTRAINT "compliance_pack_controls_attestation_check"
    CHECK ("attestation_required" = false OR "collector" = 'none')
);

CREATE UNIQUE INDEX "compliance_pack_controls_ref_uq"
  ON "compliance_pack_controls" ("pack_id", "control_ref");
CREATE INDEX "compliance_pack_controls_pack_idx" ON "compliance_pack_controls" ("pack_id");

-- The ONE thing a human may record — and it is not "satisfied".
CREATE TABLE "compliance_pack_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" uuid NOT NULL REFERENCES "compliance_packs"("id") ON DELETE CASCADE,
  "control_ref" text NOT NULL,
  "statement" text NOT NULL,
  "evidence_ref" text,
  -- null = no expiry stated. Reported as such; never treated as permanent.
  "valid_until" timestamptz,
  "attested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "attested_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "compliance_pack_attestations_lookup_idx"
  ON "compliance_pack_attestations" ("pack_id", "control_ref", "attested_at");

-- The generated ARTIFACT. Same posture as `report_runs` (ADR-0047): what a
-- generation produced, never an input to another computation. `pack_id` has no
-- FK so the artifact outlives a deleted pack, and `pack_version` +
-- `effective_project_ids` mean "which mapping, over whose evidence" stays
-- answerable forever.
CREATE TABLE "compliance_pack_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pack_id" uuid NOT NULL,
  "framework" text NOT NULL,
  "pack_version" integer NOT NULL,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "scope_kind" text NOT NULL,
  "scope_id" uuid,
  "entitlement_scope" text NOT NULL,
  -- NULL = org-wide (admin under an org-scoped request)
  "effective_project_ids" jsonb,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "payload" jsonb NOT NULL,
  "generated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "compliance_pack_reports_pack_idx"
  ON "compliance_pack_reports" ("pack_id", "generated_at");

-- ------------------------------------------------------------------------
-- ADR-0047's placeholder catalogue, retired properly
-- ------------------------------------------------------------------------
--
-- `packages/shared/src/reporting.ts` shipped a built-in five-control set
-- explicitly marked "until ADR-0058". This is that ADR. A report definition may
-- now name the pack its `controls` section is computed from; the section is
-- then the pack's real, ledger-evidenced assessment, stamped with the pack
-- version. NULL keeps the built-in fallback — which now says in its own note
-- that it IS a fallback and that a pack should be attached, rather than
-- claiming a framework mapping it never had.
ALTER TABLE "report_definitions" ADD COLUMN "pack_id" uuid;
