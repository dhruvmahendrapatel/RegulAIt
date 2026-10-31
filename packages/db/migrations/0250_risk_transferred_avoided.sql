-- ADR-0211 (P17): two more risk treatments, `transferred` and `avoided`.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `ai_risks.status` gains 'transferred' (the risk is carried by an insurance policy or a supplier contract) and
--    'avoided' (the use that created it stopped). The four existing states keep their meaning; no row is rewritten.
-- 2. A treatment is a record, not a flag: the evidence (the contract or policy reference, or the decision that stopped
--    the use), the accountable owner, who recorded it and when. The biconditional CHECK makes a treated row without
--    evidence, or evidence on an untreated row, a database error, exactly like `ai_risks_acceptance_check` (0087).
--    The owner is required by the API at write time; the FK is SET NULL so deleting a user never deletes the record.
-- 3. Written only by POST /v1/risks/:riskId/treatment (admin or the risk's owner), in the same transaction as its
--    audit row, and only while `org_settings.risk_treatments_enabled` is on. That setting defaults to OFF (ADR-0180):
--    applying this migration changes nothing until an admin turns it on (step-up, audited).

ALTER TABLE "ai_risks" DROP CONSTRAINT IF EXISTS "ai_risks_status_check";
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_status_check"
  CHECK ("status" IN ('open', 'mitigating', 'accepted', 'closed', 'transferred', 'avoided'));

ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "treatment_evidence" text;
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "treatment_owner_user_id" uuid;
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "treated_by_user_id" uuid;
ALTER TABLE "ai_risks" ADD COLUMN IF NOT EXISTS "treated_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_treatment_owner_user_id_users_id_fk"
    FOREIGN KEY ("treatment_owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_treated_by_user_id_users_id_fk"
    FOREIGN KEY ("treated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ai_risks" DROP CONSTRAINT IF EXISTS "ai_risks_treatment_check";
ALTER TABLE "ai_risks" ADD CONSTRAINT "ai_risks_treatment_check"
  CHECK (
    ("status" IN ('transferred', 'avoided'))
      = ("treatment_evidence" IS NOT NULL AND "treated_at" IS NOT NULL)
    AND ("treatment_evidence" IS NULL OR length(btrim("treatment_evidence")) BETWEEN 1 AND 2000)
  );

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "risk_treatments_enabled" boolean DEFAULT false NOT NULL;
