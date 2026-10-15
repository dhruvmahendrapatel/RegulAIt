-- ADR-0190 slice I4 (with the I8 contract): a governed stdio call's placement is evidence of THAT decision.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. THE DECISION-TIME PLACEMENT ROW. A governed `mcp_tool` call (or protocol method) on a stdio server decides its
--    isolation placement in the SAME transaction as its decision audit row, before the decision's facts are
--    captured (ADR-0189 B2), and the placement row is keyed to that decision's audit id (`audit_id`). Its outcome:
--      - `offered`: an executor holding a fresh attestation at or above the required class was chosen and offered
--        the work. The row names the executor, the class that attestation shows, the broker's attestation
--        (`attestation_id`), the closure image (`image_digest`), the SHA-256 of the runtime flags that attestation
--        reported (`runtime_flags_sha256`) and the offer it made (`offer_id`). Nothing has run yet.
--      - `refused`: decision 7's refusal, with its fixed code; the decision itself is the refusal. A policy fact
--        that did not resolve (`policy_unresolved`) is recorded too: for that code ONLY, the requirement columns
--        (`required_class`, `required_by`, `profile_digest`) may be NULL, because they are exactly what did not
--        resolve (CHECK `execution_placements_requirement_check`).
--    The executor's later report never rewrites that row (the table stays append-only): it is a LINKED row in
--    `execution_placement_reports` (step 2).
--
-- 2. `execution_placement_reports`: what happened to an offered placement, append-only. At most one REPORT row per
--    placement — `placed` (the sandbox's own report was accepted), `mismatch` (it disagreed: the executor was
--    quarantined) or `refused` (the offer expired, was declined or withdrawn: decision 7's code) — plus at most one
--    `cancelled` row (the gateway stopped it, before or after the report: `end_code` says why, and the effective
--    outcome is then `cancelled`, never `placed`) and at most one `session_lost` row (the executor's side of a stdio
--    session was lost: our own refusal, never the upstream's). A trigger refuses a
--    report for a parent that is not `offered`, and a `placed` report below the parent's required class (the
--    no-fallback invariant, enforced in the database); a composite foreign key makes `offer_id` the parent's offer.
--
-- 3. Every placement row may also carry the image digest, the runtime flags hash and the attestation reference
--    (the I3 broker stamps the image too); each is checked for shape. The new columns are nullable: no existing
--    row is rewritten (the table is append-only and its trigger stays in force).

-- ===== 1. execution_placements =====================================================================================
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "image_digest" text;
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "runtime_flags_sha256" text;
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "attestation_id" uuid REFERENCES "executor_attestations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD COLUMN IF NOT EXISTS "offer_id" uuid REFERENCES "execution_offers"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_placements_offer_uq" ON "execution_placements" ("offer_id") WHERE "offer_id" IS NOT NULL;
--> statement-breakpoint
-- the target of the reports' composite foreign key (a report's offer is its placement's offer)
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_id_offer_uq";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_id_offer_uq" UNIQUE ("id", "offer_id");
--> statement-breakpoint
-- a policy fact that did not resolve leaves the requirement columns empty, and only then
ALTER TABLE "execution_placements" ALTER COLUMN "required_class" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "execution_placements" ALTER COLUMN "required_by" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "execution_placements" ALTER COLUMN "profile_digest" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_requirement_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_requirement_check" CHECK (
  ("required_class" IS NOT NULL AND "required_by" IS NOT NULL AND "profile_digest" IS NOT NULL)
  OR ("outcome" = 'refused' AND "refusal_code" = 'policy_unresolved')
);
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
  -- I4: chosen and offered at decision time; what happened next is a linked execution_placement_reports row
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

-- ===== 2. execution_placement_reports ===============================================================================
CREATE TABLE IF NOT EXISTS "execution_placement_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "placement_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL REFERENCES "execution_offers"("id") ON DELETE RESTRICT,
  "audit_id" uuid NOT NULL,
  "outcome" text NOT NULL,
  "applied_class" text,
  "report_sha256" text,
  "refusal_code" text,
  "end_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_placement_reports_parent_fk" FOREIGN KEY ("placement_id", "offer_id")
    REFERENCES "execution_placements"("id", "offer_id") ON DELETE RESTRICT,
  CONSTRAINT "execution_placement_reports_audit_id_uq" UNIQUE ("audit_id"),
  CONSTRAINT "execution_placement_reports_outcome_check" CHECK ("outcome" IN ('placed', 'mismatch', 'refused', 'cancelled', 'session_lost')),
  CONSTRAINT "execution_placement_reports_applied_class_check" CHECK (
    "applied_class" IS NULL OR "applied_class" IN ('hardened_container', 'user_space_kernel', 'microvm', 'customer_declared')
  ),
  CONSTRAINT "execution_placement_reports_report_sha256_check" CHECK ("report_sha256" IS NULL OR "report_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_placement_reports_shape_check" CHECK (
    ("outcome" = 'placed' AND "applied_class" IS NOT NULL AND "report_sha256" IS NOT NULL AND "refusal_code" IS NULL AND "end_code" IS NULL)
    OR ("outcome" = 'mismatch' AND "report_sha256" IS NOT NULL AND "refusal_code" = 'execution_profile_mismatch' AND "end_code" IS NULL)
    OR ("outcome" = 'refused' AND "applied_class" IS NULL AND "report_sha256" IS NULL AND "end_code" IS NULL AND "refusal_code" IN (
      'no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired', 'policy_unresolved'))
    OR ("outcome" = 'cancelled' AND "applied_class" IS NULL AND "report_sha256" IS NULL AND "refusal_code" IS NULL
      AND "end_code" IN ('later_gate', 'placement_timeout', 'session_abandoned'))
    OR ("outcome" = 'session_lost' AND "applied_class" IS NULL AND "report_sha256" IS NULL AND "refusal_code" IS NULL
      AND "end_code" = 'session_unknown')
  )
);
--> statement-breakpoint
-- one report row per placement, at most one cancelled row and at most one session_lost row
CREATE UNIQUE INDEX IF NOT EXISTS "execution_placement_reports_end_uq" ON "execution_placement_reports" ("placement_id") WHERE "outcome" IN ('placed', 'mismatch', 'refused');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_placement_reports_cancel_uq" ON "execution_placement_reports" ("placement_id") WHERE "outcome" = 'cancelled';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_placement_reports_session_uq" ON "execution_placement_reports" ("placement_id") WHERE "outcome" = 'session_lost';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_placement_reports_offer_idx" ON "execution_placement_reports" ("offer_id");
--> statement-breakpoint
-- the parent must be an `offered` placement; a `placed` report is never below the parent's requirement
CREATE OR REPLACE FUNCTION "regulait_execution_placement_report_guard"() RETURNS trigger AS $$
DECLARE
  parent record;
BEGIN
  SELECT "outcome", "required_class" INTO parent FROM "execution_placements" WHERE "id" = NEW."placement_id";
  IF parent IS NULL OR parent."outcome" <> 'offered' THEN
    RAISE EXCEPTION 'execution_placement_reports: the placement % is not an offered placement', NEW."placement_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" = 'placed' AND NEW."applied_class" <> 'customer_declared'
     AND array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], NEW."applied_class")
         < array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], parent."required_class") THEN
    RAISE EXCEPTION 'execution_placement_reports: % is below the required class % (no fallback, ADR-0190 decision 7)',
      NEW."applied_class", parent."required_class" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "execution_placement_reports_guard" ON "execution_placement_reports";
--> statement-breakpoint
CREATE TRIGGER "execution_placement_reports_guard"
  BEFORE INSERT ON "execution_placement_reports"
  FOR EACH ROW EXECUTE FUNCTION "regulait_execution_placement_report_guard"();
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
