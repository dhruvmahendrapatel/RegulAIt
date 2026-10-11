-- ADR-0190 OWNER DECISIONS A and B (accepted 2026-10-11). Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent. No function is created here.
--
-- A. `warn` is retired: `isolation_enforcement` has one value, `enforce`. A stored `warn` reads as `enforce`, with
--    no grandfathering (ADR-0180):
--    1. `org_settings`: the setting is rewritten to `enforce` and the CHECK admits nothing else.
--    2. `execution_offers`: an offer is a working row, not evidence; any `warn` is rewritten to `enforce` (the guard
--       trigger, which keeps an offer's identity immutable, is suspended for that one statement) and the CHECK
--       admits nothing else.
--    3. `execution_placements` is append-only EVIDENCE: a row records the mode its placement was decided under, and
--       is never rewritten. New rows may only say `enforce`, and the no-fallback CHECK loses its `warn` exemption,
--       both added NOT VALID: they bind every row written from now on (the table takes no UPDATE), and leave any
--       earlier row exactly as it was recorded. The gateway never copies a mode from a stored row.
-- B. An unresolved policy fact refuses with a sixth fixed reason, `policy_unresolved`, which a refused placement
--    may now carry (the existing rows all satisfy the wider CHECK, so it is validated).

-- Every rewrite leaves an audit trail (ADR-0181 FX2): one `migration_audit_outbox` row per rewritten org settings
-- row and per rewritten offer, in this transaction, with the old and new value; runMigrations drains them into the
-- chained audit_log straight after. A second run rewrites nothing, so it writes no rows.

-- ===== A1. org settings =======================================================
WITH "changed" AS (
  UPDATE "org_settings" AS s SET "isolation_enforcement" = 'enforce'
  FROM (SELECT "id", "isolation_enforcement" AS "old" FROM "org_settings" WHERE "isolation_enforcement" <> 'enforce') AS o
  WHERE s."id" = o."id"
  RETURNING s."id", o."old"
)
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0191_isolation_enforce_only',
  'org_settings',
  NULL,
  'org-settings-updated',
  'Isolation enforcement ''' || "old" || ''' rewritten to ''enforce'' by migration 0191: ADR-0190 owner decision A retires ''warn''; '
    || 'enforce is the only value. An admin who cannot provide a class lowers an isolation floor instead (audited, step-up).',
  jsonb_build_object(
    'phase', 'migration-0191',
    'orgSettingsId', "id",
    'decision', 'ADR-0190 owner decision A',
    'changed', jsonb_build_object('isolationEnforcement', 'enforce'),
    'transitions', jsonb_build_object('isolationEnforcement', jsonb_build_object('from', "old", 'to', 'enforce'))
  )
FROM "changed";
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_isolation_enforcement_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_isolation_enforcement_check" CHECK ("isolation_enforcement" = 'enforce');
--> statement-breakpoint

-- ===== A2. execution offers ===================================================
ALTER TABLE "execution_offers" DISABLE TRIGGER "execution_offers_guard";
--> statement-breakpoint
WITH "changed" AS (
  UPDATE "execution_offers" AS x SET "enforcement" = 'enforce'
  FROM (SELECT "id", "enforcement" AS "old" FROM "execution_offers" WHERE "enforcement" <> 'enforce') AS o
  WHERE x."id" = o."id"
  RETURNING x."id", o."old", x."executor_id", x."status", x."required_class"
)
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0191_isolation_enforce_only',
  'execution_placement',
  "id",
  'execution-offer-enforcement-rewritten',
  'Execution offer enforcement ''' || "old" || ''' rewritten to ''enforce'' by migration 0191 (ADR-0190 owner decision A).',
  jsonb_build_object(
    'phase', 'migration-0191',
    'offerId', "id",
    'executorId', "executor_id",
    'status', "status",
    'requiredClass', "required_class",
    'decision', 'ADR-0190 owner decision A',
    'transitions', jsonb_build_object('enforcement', jsonb_build_object('from', "old", 'to', 'enforce'))
  )
FROM "changed";
--> statement-breakpoint
ALTER TABLE "execution_offers" ENABLE TRIGGER "execution_offers_guard";
--> statement-breakpoint
ALTER TABLE "execution_offers" DROP CONSTRAINT IF EXISTS "execution_offers_enforcement_check";
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD CONSTRAINT "execution_offers_enforcement_check" CHECK ("enforcement" = 'enforce');
--> statement-breakpoint

-- ===== A3 and B. execution placements =========================================
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_enforcement_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_enforcement_check" CHECK ("enforcement" = 'enforce') NOT VALID;
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_no_fallback_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_no_fallback_check" CHECK (
  "outcome" <> 'placed' OR "applied_class" = 'customer_declared'
  OR array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "applied_class")
     >= array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "required_class")
) NOT VALID;
--> statement-breakpoint
ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_refusal_code_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_refusal_code_check" CHECK (
  "refusal_code" IS NULL OR "refusal_code" IN (
    'no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired',
    'policy_unresolved', 'execution_profile_mismatch'
  )
);
