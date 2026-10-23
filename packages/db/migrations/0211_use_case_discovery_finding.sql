-- Issue #522 finding #30: a use case registered from a shadow-AI finding keeps the link to that finding.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `ai_use_cases.discovery_finding_id`: the shadow-AI finding the use case was registered from. Set once, by
--    `POST /v1/use-cases` (the gateway checks that the finding exists and that the caller may read it, and audits the
--    link); no route changes or clears it. NULL for every use case registered any other way. Nothing is backfilled:
--    a use case recorded before this migration was not linked when it was registered (ADR-0180, as for a first load).
-- 2. `ON DELETE SET NULL`: a deleted finding never deletes the use case that governs the usage it found. The audit
--    rows of the link keep the finding's id.
-- 3. A finding is registered as at most ONE use case (the partial unique index). A second registration of the same
--    finding is refused 409 `finding_already_registered`, naming the use case that holds it.

ALTER TABLE "ai_use_cases" ADD COLUMN IF NOT EXISTS "discovery_finding_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_use_cases" DROP CONSTRAINT IF EXISTS "ai_use_cases_discovery_finding_id_shadow_ai_findings_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_use_cases" ADD CONSTRAINT "ai_use_cases_discovery_finding_id_shadow_ai_findings_id_fk"
  FOREIGN KEY ("discovery_finding_id") REFERENCES "public"."shadow_ai_findings"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_use_cases_discovery_finding_uq" ON "ai_use_cases" ("discovery_finding_id")
  WHERE "discovery_finding_id" IS NOT NULL;
