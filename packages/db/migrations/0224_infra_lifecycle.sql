-- ADR-0208 G8: infrastructure resources and policies can be edited and RETIRED (never deleted: a delete would cascade
-- away the remediation ledgers — findings, cert rotations, patches, backup runs — that hang off a resource).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `status` (active | retired) on both tables, default 'active', with who/when/why for a retirement. A retired row
--    stays readable, is read-only, and is excluded from scans, effective-policy resolution and anything that starts
--    new work (gateway: infra.ts). The CHECK keeps the four columns consistent: an active row carries no retirement
--    facts, a retired row carries its time and a non-empty reason. `retired_reason` is registered for the prose scrub.
-- 2. One ACTIVE policy per resource, and at most one ACTIVE fleet policy (resource_id IS NULL), enforced here by two
--    partial unique indexes (the gateway answers a named 409 first). Like 0108/0109 this ADDS and REFUSES — it never
--    repairs or retires a duplicate; `scripts/preflight-unique-constraints.mjs` reports any pair that would block it.
-- No functions or triggers: nothing here needs the 0185 search_path / TRUNCATE guards.

ALTER TABLE "infra_resources" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
ALTER TABLE "infra_resources" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "infra_resources" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "infra_resources" ADD COLUMN IF NOT EXISTS "retired_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "infra_policies" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
ALTER TABLE "infra_policies" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "infra_policies" ADD COLUMN IF NOT EXISTS "retired_reason" text;
ALTER TABLE "infra_policies" ADD COLUMN IF NOT EXISTS "retired_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_status_check" CHECK ("status" IN ('active', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "infra_resources" ADD CONSTRAINT "infra_resources_retired_shape_check" CHECK (
    ("status" = 'active' AND "retired_at" IS NULL AND "retired_reason" IS NULL AND "retired_by_user_id" IS NULL)
    OR ("status" = 'retired' AND "retired_at" IS NOT NULL AND "retired_reason" IS NOT NULL
        AND length(btrim("retired_reason")) > 0 AND length("retired_reason") <= 8000)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "infra_policies" ADD CONSTRAINT "infra_policies_status_check" CHECK ("status" IN ('active', 'retired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "infra_policies" ADD CONSTRAINT "infra_policies_retired_shape_check" CHECK (
    ("status" = 'active' AND "retired_at" IS NULL AND "retired_reason" IS NULL AND "retired_by_user_id" IS NULL)
    OR ("status" = 'retired' AND "retired_at" IS NOT NULL AND "retired_reason" IS NOT NULL
        AND length(btrim("retired_reason")) > 0 AND length("retired_reason") <= 8000)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "infra_policies_active_resource_uq"
  ON "infra_policies" ("resource_id")
  WHERE "status" = 'active' AND "resource_id" IS NOT NULL;

-- the indexed expression is constant (true) across the predicate, so two active fleet rows collide
CREATE UNIQUE INDEX IF NOT EXISTS "infra_policies_active_fleet_uq"
  ON "infra_policies" (("resource_id" IS NULL))
  WHERE "status" = 'active' AND "resource_id" IS NULL;
