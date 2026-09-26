-- Migration 0091 (ADR-0089) — AGENT OWNERSHIP + LIFECYCLE (gap L20,
-- docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
--
-- Saviynt's accountability spine: every agent has a registered human owner
-- and a lifecycle from registration to decommissioning. Our `agents` row had
-- neither — ownership existed only indirectly (an approved use case has an
-- owner and names intended agents), and the only lifecycle was the `enabled`
-- boolean, which is an availability switch, not a governance state.
--
-- THE RULES THIS SCHEMA STATES (enforced in the gateway):
--
--   * `owner_user_id` is NULLABLE ON PURPOSE. Every existing agent has no
--     recorded owner, and inventing one (first admin? creator?) would forge
--     an accountability record. NULL renders in the ADR-0082 inventory as an
--     explicit "unowned" flag — never as a default, never hidden. An owner
--     whose user row is deactivated (ADR-0022 `users.disabled_at`, the state
--     SCIM deprovisioning writes) renders as "orphaned" — computed at read
--     time, no stored denormalization.
--   * `lifecycle_status` is a CLOSED vocabulary: active | deprecated |
--     retired. Deprecated WARNS in the inventory and blocks nothing.
--     Retired is TERMINAL for governance purposes: the dispatch core refuses
--     a retired agent with a named 409 (`agent_retired`, the ADR-0045 gate
--     idiom) — grants and history stay readable, the rows are never deleted.
--   * A non-active state carries its reason (the CHECK below); returning to
--     active clears it. Transitions are admin-only, audited acts — there is
--     no PATCH that writes these columns silently.

DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "owner_user_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "lifecycle_status" text DEFAULT 'active' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "lifecycle_reason" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ON DELETE SET NULL, not RESTRICT: users are deactivated, never deleted
-- (ADR-0022), so this fires only in exceptional cleanup — and an agent must
-- survive it as "unowned", not block it.
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_lifecycle_status_ck";
ALTER TABLE "agents" ADD CONSTRAINT "agents_lifecycle_status_ck"
  CHECK ("lifecycle_status" IN ('active', 'deprecated', 'retired'));

-- active carries no reason; deprecated/retired always carry one — the same
-- shape as ai_use_cases_retirement_check.
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_lifecycle_reason_ck";
ALTER TABLE "agents" ADD CONSTRAINT "agents_lifecycle_reason_ck"
  CHECK (("lifecycle_status" = 'active') = ("lifecycle_reason" IS NULL));

CREATE INDEX IF NOT EXISTS "agents_owner_user_id_idx" ON "agents" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "agents_lifecycle_status_idx" ON "agents" ("lifecycle_status");
