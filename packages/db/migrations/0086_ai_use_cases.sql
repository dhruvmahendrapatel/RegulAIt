-- Migration 0086 (ADR-0080) — THE AI USE-CASE REGISTRY.
--
-- The L1 gap (docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md): governance that
-- starts BEFORE anything runs. A proposed AI use case becomes a registered,
-- approvable object — and unlike a GRC registry entry, an approved row here is
-- a governance OBJECT the enforcement plane can reference: its
-- `compliance_tags` are the SAME tags the §8.3 cascade already enforces
-- (compliance_profiles.tag / projects.classifications), so approval registers
-- the thing the cascade then governs, not a parallel piece of paperwork.
--
-- THE ONE RULE THIS TABLE'S LIFECYCLE ENFORCES (in the gateway, stated here):
--
--   `status` reaches 'approved' or 'rejected' ONLY through the terminal
--   decision of the linked pillar-2 intake workflow instance
--   (`workflow_instance_id`) riding the ONE approvals queue. No PATCH writes
--   those two values; the decide endpoint's separation-of-duties guards
--   (named approver, admin-override reason, self-review reason, delegation)
--   are therefore inherited, never re-implemented.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No risk scores, no control mappings, no auto-discovery columns — L2/L4
--   are their own gaps. No GAIA-style pre-fill provenance columns either: the
--   intake questionnaire is a FORM the proposer fills (we hold no model
--   credential; a pre-fill would be mechanism-without-instrument).
CREATE TABLE IF NOT EXISTS "ai_use_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "owner_user_id" uuid NOT NULL,
  -- why the business wants this — the intake's anchor sentence(s)
  "business_context" text NOT NULL,
  -- REFERENCES, not copies: agent ids the proposer intends to use. Validated
  -- against `agents` at propose time; jsonb because the set is small and the
  -- registry must not break when an agent is later deleted.
  "intended_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "data_sensitivity" text NOT NULL,
  -- THE DIFFERENTIATOR: the same vocabulary compliance_profiles.tag /
  -- projects.classifications use — what the cascade enforces, this registers.
  "compliance_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- nullable: a use case may be proposed before any project exists for it
  "project_id" uuid,
  "status" text DEFAULT 'proposed' NOT NULL,
  -- the pillar-2 intake instance that governs this use case's approval
  "workflow_instance_id" uuid,
  "decided_at" timestamp with time zone,
  "retired_reason" text,
  "retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_use_cases_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "ai_use_cases_status_check"
    CHECK ("status" IN ('proposed', 'under_review', 'approved', 'rejected', 'retired')),
  CONSTRAINT "ai_use_cases_sensitivity_check"
    CHECK ("data_sensitivity" IN ('public', 'internal', 'confidential', 'regulated')),
  -- a retirement without a reason is not auditable; the reverse (a reason on a
  -- non-retired row) is equally incoherent
  CONSTRAINT "ai_use_cases_retirement_check"
    CHECK (("status" = 'retired') = ("retired_at" IS NOT NULL AND "retired_reason" IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_owner_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_project_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_instance_fk"
    FOREIGN KEY ("workflow_instance_id") REFERENCES "workflow_instances"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ai_use_cases_owner_idx" ON "ai_use_cases" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "ai_use_cases_status_idx" ON "ai_use_cases" ("status");
CREATE INDEX IF NOT EXISTS "ai_use_cases_instance_idx" ON "ai_use_cases" ("workflow_instance_id");
