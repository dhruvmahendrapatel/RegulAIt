-- ADR-0190 slice I8: execution facts in the evidence. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. No function is created and no row is rewritten.
--
-- The signed formats are versioned, and migration 0182 pins each version in a CHECK. I8 bumps two of them:
--  - `regulait.decision-facts.v2` adds `execution` (decision 9), captured in the decision's own transaction from its
--    `execution_placements` row;
--  - `regulait.decision-bom.v2` adds the `execution` section and its completeness entry.
-- Both CHECKs are WIDENED to admit v1 and v2: every stored v1 row stays valid as recorded (append-only evidence is
-- never rewritten, and nothing is back-filled: a decision captured before I8 reads `execution: not_recorded,
-- pre_isolation`). Any other version is still refused. The facts column defaults to v2, the version the capture
-- writes. `regulait.ai-bom.v1` is unchanged (its records map is open-keyed; owner ruling, 2026-10-15).
--
-- Each widened CHECK is added NOT VALID and then validated in its own statement: ADD ... NOT VALID does no scan,
-- and VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE. Every existing row is v1, which the widened CHECK
-- admits, so the validation passes and the constraint ends fully validated. Caveat: drizzle's migrator applies all
-- pending migrations in ONE transaction, so there the ACCESS EXCLUSIVE lock taken by DROP/ADD is held until commit
-- and the scan still runs under it; the shorter lock applies when an operator runs these statements on their own.

-- ===== decision_facts ==========================================================
ALTER TABLE "decision_facts" ALTER COLUMN "facts_version" SET DEFAULT 'regulait.decision-facts.v2';
--> statement-breakpoint
ALTER TABLE "decision_facts" DROP CONSTRAINT IF EXISTS "decision_facts_version_check";
--> statement-breakpoint
ALTER TABLE "decision_facts" ADD CONSTRAINT "decision_facts_version_check"
  CHECK ("facts_version" IN ('regulait.decision-facts.v1', 'regulait.decision-facts.v2')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "decision_facts" VALIDATE CONSTRAINT "decision_facts_version_check";
--> statement-breakpoint

-- ===== decision_boms ===========================================================
ALTER TABLE "decision_boms" DROP CONSTRAINT IF EXISTS "decision_boms_body_check";
--> statement-breakpoint
ALTER TABLE "decision_boms" ADD CONSTRAINT "decision_boms_body_check" CHECK (
  COALESCE(
    ("body"::jsonb ->> 'v') IN ('regulait.decision-bom.v1', 'regulait.decision-bom.v2')
    AND ("body"::jsonb ->> 'id') = "id"::text
    AND ("body"::jsonb ->> 'auditId') = "audit_id"::text
    AND ("body"::jsonb -> 'version') = to_jsonb("version")
    AND ("body"::jsonb ->> 'finality') = "finality",
    false
  )
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "decision_boms" VALIDATE CONSTRAINT "decision_boms_body_check";
