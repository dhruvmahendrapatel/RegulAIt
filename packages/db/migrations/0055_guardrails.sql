-- Migration 0055 (ADR-0042) — the layered input+output GUARDRAIL ENGINE that
-- generalizes §8.4's single PII classifier into a registry of content-safety
-- detectors evaluated at the one governed-dispatch chokepoint.
--
-- WHAT THIS SCHEMA HAS TO HOLD, AND WHY EACH PIECE EXISTS
--
--  1. THE VERBS DO NOT CHANGE. Every mode column is CHECK-constrained to
--     ('off','log','warn','block'). `log|warn|block` is exactly the `piiMode`
--     triad ADR-0019 already enforces; `off` is the one member a per-detector
--     switch needs that `piiMode` does not (piiMode expresses "not enforced" by
--     the cascade resolving to NULL, whereas a config row always exists and
--     must be able to say "do not run this detector at all").
--
--  2. THE COMPLIANCE CASCADE IS THE CEILING, NOT A PEER. §8.3 profiles get
--     `guardrail_modes`, a jsonb FLOOR that composes MAX-of-strictness across a
--     project's profiles — exactly how `pii_mode` already composes. A local
--     per-agent/per-connector setting is then composed with that floor by the
--     same MAX, so a local setting can RAISE strictness and can never relax
--     below what a framework demands. There is deliberately no column anywhere
--     in this migration that can lower a floor.
--
--  3. SCOPE PRECEDENCE IS DATA, NOT CODE-PATHS. One table, one row per scope:
--     the org default (scope='org', scope_id NULL, at most one row) and the
--     per-agent / per-connector overrides (scope_id NOT NULL). Adding a scope
--     later is a CHECK change, not a new table.
--
--  4. VIOLATIONS ARE NOT A NEW LEDGER. There is no guardrail_violations table
--     on purpose: every guardrail decision — block, warn AND log — writes a row
--     into the SINGLE existing `audit_log`, with rule ids 'guardrail-blocked' /
--     'guardrail-warned' / 'guardrail-logged' and the detector, category counts,
--     mode, phase and outcome in `detail`. The admin "recent violations" view is
--     a query over that one table. A second ledger would be a second truth.
--
--  5. COUNTS ONLY, FOREVER. Nothing here stores matched content, and nothing
--     downstream may either — the detectors return {detector, category, count}
--     triples by construction (packages/shared/src/guardrails.ts), which is the
--     same contract §8.4's detectPII already holds, so a violation record can
--     never itself become the leak it was recording.

CREATE TABLE "guardrail_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- 'org' is the deployment-wide default; 'agent'/'connector' are overrides
  -- for one registry object. A project-scoped row is deliberately absent: a
  -- project's guardrail posture comes from its §8.3 classifications (the
  -- cascade floor below), so there is no second, contradictory way to say it.
  "scope" text NOT NULL,
  "scope_id" uuid,
  -- the four ADR-0042 layers. PII is NOT here: it stays governed by the §8.3
  -- cascade's own pii_mode, unchanged, which is what "PII at the cascade
  -- ceiling" means in the ADR's default-posture paragraph.
  "prompt_injection_mode" text NOT NULL DEFAULT 'log',
  "jailbreak_mode" text NOT NULL DEFAULT 'log',
  "toxicity_mode" text NOT NULL DEFAULT 'log',
  "semantic_dlp_mode" text NOT NULL DEFAULT 'log',
  -- the org's OWN vocabulary, per detector: {"semantic_dlp":["Project Aurora"]}.
  -- Additive across scopes (org terms + override terms), never subtractive.
  -- This is what makes semantic DLP useful for a specific business, given that
  -- the shipped rule set can only see declared markers and secret shapes.
  "custom_terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by_user_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "guardrail_configs_scope_check" CHECK ("scope" IN ('org','agent','connector')),
  -- the org row is the ONLY scope without a target, and every override MUST
  -- have one. Expressed as an equivalence so neither mistake is representable.
  CONSTRAINT "guardrail_configs_scope_id_check"
    CHECK (("scope" = 'org') = ("scope_id" IS NULL)),
  CONSTRAINT "guardrail_configs_prompt_injection_check"
    CHECK ("prompt_injection_mode" IN ('off','log','warn','block')),
  CONSTRAINT "guardrail_configs_jailbreak_check"
    CHECK ("jailbreak_mode" IN ('off','log','warn','block')),
  CONSTRAINT "guardrail_configs_toxicity_check"
    CHECK ("toxicity_mode" IN ('off','log','warn','block')),
  CONSTRAINT "guardrail_configs_semantic_dlp_check"
    CHECK ("semantic_dlp_mode" IN ('off','log','warn','block'))
);
--> statement-breakpoint

ALTER TABLE "guardrail_configs" ADD CONSTRAINT "guardrail_configs_updated_by_user_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- at most ONE org-default row, enforced by the database rather than by a
-- convention every future caller has to remember
CREATE UNIQUE INDEX "guardrail_configs_org_uq" ON "guardrail_configs" USING btree ("scope")
  WHERE "scope_id" IS NULL;
--> statement-breakpoint
-- at most one override per (scope, target)
CREATE UNIQUE INDEX "guardrail_configs_scope_target_uq" ON "guardrail_configs" USING btree ("scope","scope_id")
  WHERE "scope_id" IS NOT NULL;
--> statement-breakpoint

-- §8.3 CASCADE FLOOR. A framework profile can force a detector to a stricter
-- mode for every project carrying its tag. Shape: {"prompt_injection":"block"}.
-- NULL / absent key = this framework has no opinion about that detector, which
-- is the state every pre-0055 profile row is in, so the cascade is unchanged
-- for existing installs.
ALTER TABLE "compliance_profiles" ADD COLUMN "guardrail_modes" jsonb;
