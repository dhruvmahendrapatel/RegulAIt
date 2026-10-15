-- ADR-0190 slice I4 (with the I8 contract): a governed stdio call's placement is evidence of THAT decision.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. THE DECISION-TIME PLACEMENT ROW. A governed `mcp_tool` call on a stdio server decides its isolation placement
--    in the SAME transaction as its decision audit row, before the decision's facts are captured (ADR-0189 B2), and
--    the placement row is keyed to that decision's audit id (`audit_id`). Its outcome is one of:
--      - `offered`: an executor holding a fresh attestation at or above the required class was chosen and offered
--        the work. The row names the executor, the class that attestation shows, the broker's attestation
--        (`attestation_id`), the closure image (`image_digest`) and the SHA-256 of the runtime flags that
--        attestation reported (`runtime_flags_sha256`), and the offer it made (`offer_id`). Nothing has run yet.
--      - `refused`: decision 7's refusal, with its fixed code; the decision itself is the refusal.
--    The executor's later per-placement report never rewrites that row (the table stays append-only): it is a
--    LINKED row in `execution_placement_reports` (step 2), one per offered placement.
--
-- 2. `execution_placement_reports`: how an offered placement ended, append-only, at most one per placement:
--    `placed` (the sandbox's own report was accepted: applied class and report hash), `mismatch` (the report
--    disagreed: the executor was quarantined), or `refused` (the offer expired, was declined or was withdrawn,
--    with decision 7's code). `audit_id` names the audit row written for that outcome.
--
-- 3. Every placement row may also carry the image digest, the runtime flags hash and the attestation reference
--    (the I3 broker stamps them too); each is checked for shape. The new columns are nullable: no existing row is
--    rewritten (the table is append-only and the trigger stays in force).

-- ===== 1. execution_placements: the evidence columns and the `offered` outcome =====
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "image_digest" text;
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "runtime_flags_sha256" text;
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "attestation_id" uuid REFERENCES "executor_attestations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
-- the offer an `offered` placement made (the executor's report finds its decision-time row through it)
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "offer_id" uuid REFERENCES "execution_offers"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_placements_offer_uq" ON "execution_placements" ("offer_id") WHERE "offer_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_image_digest_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_image_digest_check"
  CHECK ("image_digest" IS NULL OR "image_digest" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_runtime_flags_sha256_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_runtime_flags_sha256_check"
  CHECK ("runtime_flags_sha256" IS NULL OR "runtime_flags_sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_outcome_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_outcome_check"
  CHECK ("outcome" IN ('placed', 'refused', 'mismatch', 'offered'));
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_shape_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_shape_check" CHECK (
  ("outcome" = 'refused' AND "executor_id" IS NULL AND "applied_class" IS NULL AND "report_sha256" IS NULL
    AND "refusal_code" IS NOT NULL AND "refusal_code" <> 'execution_profile_mismatch')
  OR ("outcome" = 'placed' AND "executor_id" IS NOT NULL AND "applied_class" IS NOT NULL AND "report_sha256" IS NOT NULL
    AND "refusal_code" IS NULL)
  OR ("outcome" = 'mismatch' AND "executor_id" IS NOT NULL AND "report_sha256" IS NOT NULL
    AND "refusal_code" = 'execution_profile_mismatch')
  -- I4: chosen and offered at decision time; its report is a linked execution_placement_reports row
  OR ("outcome" = 'offered' AND "executor_id" IS NOT NULL AND "applied_class" IS NOT NULL AND "report_sha256" IS NULL
    AND "refusal_code" IS NULL AND "image_digest" IS NOT NULL AND "attestation_id" IS NOT NULL AND "offer_id" IS NOT NULL)
);
--> statement-breakpoint
-- the no-fallback invariant holds for an offer too: never offered below the requirement (0191's form, widened)
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_no_fallback_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_no_fallback_check" CHECK (
  "outcome" NOT IN ('placed', 'offered') OR "applied_class" = 'customer_declared'
  OR array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "applied_class")
     >= array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "required_class")
) NOT VALID;
--> statement-breakpoint

-- ===== 2. execution_placement_reports: the linked outcome of an offered placement, append-only =====
CREATE TABLE IF NOT EXISTS "execution_placement_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "placement_id" uuid NOT NULL REFERENCES "execution_placements"("id") ON DELETE RESTRICT,
  "offer_id" uuid NOT NULL REFERENCES "execution_offers"("id") ON DELETE RESTRICT,
  "audit_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "applied_class" text,
  "report_sha256" text,
  "refusal_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_placement_reports_placement_uq" UNIQUE ("placement_id"),
  CONSTRAINT "execution_placement_reports_audit_id_uq" UNIQUE ("audit_id"),
  CONSTRAINT "execution_placement_reports_outcome_check" CHECK ("outcome" IN ('placed', 'mismatch', 'refused')),
  CONSTRAINT "execution_placement_reports_applied_class_check" CHECK (
    "applied_class" IS NULL OR "applied_class" IN ('hardened_container', 'user_space_kernel', 'microvm', 'customer_declared')
  ),
  CONSTRAINT "execution_placement_reports_report_sha256_check" CHECK ("report_sha256" IS NULL OR "report_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_placement_reports_shape_check" CHECK (
    ("outcome" = 'placed' AND "applied_class" IS NOT NULL AND "report_sha256" IS NOT NULL AND "refusal_code" IS NULL)
    OR ("outcome" = 'mismatch' AND "report_sha256" IS NOT NULL AND "refusal_code" = 'execution_profile_mismatch')
    OR ("outcome" = 'refused' AND "applied_class" IS NULL AND "report_sha256" IS NULL AND "refusal_code" IN (
      'no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired', 'policy_unresolved'))
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_placement_reports_offer_idx" ON "execution_placement_reports" ("offer_id");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_placement_reports_append_only" ON "execution_placement_reports";
--> statement-breakpoint
CREATE TRIGGER "execution_placement_reports_append_only"
  BEFORE UPDATE OR DELETE ON "execution_placement_reports"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_placement_reports_no_truncate" ON public."execution_placement_reports";
--> statement-breakpoint
CREATE TRIGGER "execution_placement_reports_no_truncate" BEFORE TRUNCATE ON public."execution_placement_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
