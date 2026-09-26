-- ADR-0120 — policy simulation beyond ABAC.
--
-- `policy_simulations` could only ever describe an ABAC policy version:
-- `policy_version_id` was NOT NULL and FK'd to `abac_policy_versions`. A
-- simulation of a proposed APPROVAL RULE or RATE LIMIT has no such row to point
-- at — its candidate is a `config_versions` row — so the column is relaxed and
-- two columns are added to name the other kind.
--
-- Hand-authored (never `drizzle-kit generate`). Purely additive and safe to
-- re-run against a populated deployment: the drop of NOT NULL cannot fail, and
-- existing rows keep their ABAC candidate exactly as recorded.

ALTER TABLE "policy_simulations" ALTER COLUMN "policy_version_id" DROP NOT NULL;

ALTER TABLE "policy_simulations"
  ADD COLUMN IF NOT EXISTS "candidate_artifact_type" text,
  ADD COLUMN IF NOT EXISTS "candidate_version_id" uuid;

-- Exactly one kind of candidate per simulation, and never neither. A row that
-- named both, or named nothing, would be a preview nobody could reproduce.
ALTER TABLE "policy_simulations"
  ADD CONSTRAINT "policy_simulations_one_candidate_check" CHECK (
    ("policy_version_id" IS NOT NULL AND "candidate_version_id" IS NULL)
    OR ("policy_version_id" IS NULL AND "candidate_version_id" IS NOT NULL
        AND "candidate_artifact_type" IS NOT NULL)
  );
