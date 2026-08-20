-- Migration 0088 (ADR-0084) — THE AI VENDOR REGISTRY (third-party AI risk).
--
-- The L5 gap (docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md): our vendor
-- story was COST (ADR-0069/0076 imports), not risk. This table makes a
-- third-party AI vendor a governed object with an ASSESSMENT LIFECYCLE that
-- rides the pillar-2 rails exactly like an AI use case (ADR-0080): propose →
-- assessment questionnaire as a versioned workflow artifact → human sign-off
-- on the one approvals queue. The gap analysis said "defer unless a buyer
-- says otherwise"; the owner directed building it (2026-08-20) — ADR-0084
-- records that overriding call.
--
-- THE ONE RULE THIS TABLE'S LIFECYCLE ENFORCES (in the gateway, stated here):
--
--   `status` reaches 'approved' or 'rejected' ONLY through the terminal
--   decision of the linked pillar-2 assessment instance
--   (`workflow_instance_id`) riding the ONE approvals queue — the exact
--   ADR-0080 discipline. No PATCH writes those two values; retirement is its
--   own audited, admin-only, reason-required act.
--
-- ATTESTED, NEVER MEASURED — the honesty split this feature exists for:
--
--   `pack_attestations` holds VENDOR-SUPPLIED answers to compliance-pack
--   controls, each stamped with who recorded it, when, and from which
--   questionnaire artifact version. They are CLAIMS. They are deliberately
--   NOT rows in `compliance_pack_attestations` (those are the org's own
--   statements and feed the pack evaluator's 'attested' status) and no pack
--   scorecard, report, or collector ever reads this column — blending a
--   vendor's "we are certified" into our computed evidence would fabricate
--   satisfaction (ADR-0058's exact refusal).
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No verification columns, no scores, no SLA/renewal scheduler, no
--   auto-discovery — L4's classifier may NAME a vendor in a finding, but
--   nothing creates a row here except a person. No external vendor-facing
--   auth surface exists anywhere: this is an internal record of
--   vendor-supplied answers.
CREATE TABLE IF NOT EXISTS "ai_vendors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  -- what kind of third party this is, honestly small: a model provider we
  -- call, a product with AI features we use, a processor our data reaches,
  -- or an integration that moves data between systems
  "category" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  -- REFERENCES, not copies: which admin-registered custom model providers
  -- (ADR-0034) this vendor corresponds to. Validated at write time; jsonb so
  -- the registry row survives a later provider deletion.
  "linked_custom_provider_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- the provider keys as they appear on agents.provider — free text, because
  -- that column is free text; a linkage hint, never an enforcement key
  "linked_agent_providers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- VENDOR-SUPPLIED pack-control answers with attribution (see header).
  -- Written only by the audited attestation endpoint.
  "pack_attestations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  -- the pillar-2 assessment instance that governs this vendor's approval
  "workflow_instance_id" uuid,
  "decided_at" timestamp with time zone,
  "retired_reason" text,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_vendors_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "ai_vendors_status_check"
    CHECK ("status" IN ('proposed', 'under_assessment', 'approved', 'rejected', 'retired')),
  CONSTRAINT "ai_vendors_category_check"
    CHECK ("category" IN ('model_provider', 'ai_feature_vendor', 'data_processor', 'integration')),
  -- a retirement without a reason is not auditable; the reverse (a reason on
  -- a non-retired row) is equally incoherent — the 0086 discipline
  CONSTRAINT "ai_vendors_retirement_check"
    CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL AND "retired_reason" IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE "ai_vendors" ADD CONSTRAINT "ai_vendors_owner_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_vendors" ADD CONSTRAINT "ai_vendors_instance_fk"
    FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ai_vendors_owner_idx" ON "ai_vendors" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "ai_vendors_status_idx" ON "ai_vendors" ("status");
CREATE INDEX IF NOT EXISTS "ai_vendors_instance_idx" ON "ai_vendors" ("workflow_instance_id");

-- ---------------------------------------------------------------------------
-- ai_risks joins the vendor story (ADR-0081 × ADR-0084).
--
-- `vendor_id` is the LOAD-BEARING join: ADR-0081's evidence resolvers narrow
-- their queries by the scope columns on the risk row (project_id, agent_id) —
-- a third-party risk pinned to one vendor needs the same, so its
-- `vendor_assessments` evidence can be scoped to that vendor's rows at query
-- construction. ai_use_cases gets NO vendor column: nothing in the use-case
-- read path queries by vendor, so the column would be a dead reference.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD COLUMN "vendor_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_vendor_fk"
    FOREIGN KEY ("vendor_id") REFERENCES "ai_vendors"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ai_risks_vendor_idx" ON "ai_risks" ("vendor_id");

-- `third_party_ai` joins the risk-category vocabulary: the FIRST category
-- whose evidence is the vendor registry's own assessment lifecycle. The
-- resolver counts assessment STATES (platform records); the assessment
-- CONTENT stays vendor-attested and the evidence payload says so.
ALTER TABLE "ai_risks" DROP CONSTRAINT IF EXISTS "ai_risks_category_check";
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_category_check"
  CHECK ("category" IN ('tool_misuse', 'scope_drift', 'prompt_injection', 'data_leakage_pii',
                        'over_permissioning', 'budget_overrun', 'hallucination', 'shadow_ai',
                        'third_party_ai'));
