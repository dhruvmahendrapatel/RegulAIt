-- ADR-0124 — THE KILL SWITCH AND SAFE MODES.
--
-- Three scopes, one concept. ISACA's checklist asks for "global AND
-- per-capability kill switches" for a reason an operator will recognise: an
-- incident confined to one tool should not cost you the business.
--
-- EVERYTHING HERE DEFAULTS TO TODAY'S BEHAVIOUR. `normal` adds nothing to any
-- decision, and a halt column that is NULL means "not halted" — so an existing
-- deployment behaves byte-identically across this upgrade, which is the same
-- rule every enforcement control in this product has followed.
--
-- WHY A REASON IS NOT NULLABLE ALONGSIDE THE TIMESTAMP. An emergency stop with
-- no stated reason is an outage of unknown cause, and the person who lifts it
-- is usually not the person who threw it. The CHECK constraints below make
-- "halted with no reason" unrepresentable rather than merely discouraged.

-- ── 1. The deployment-wide dial ──────────────────────────────────────────
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "execution_mode" text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS "execution_mode_reason" text,
  ADD COLUMN IF NOT EXISTS "execution_mode_set_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "execution_mode_set_at" timestamp with time zone;

ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_execution_mode_ck"
  CHECK ("execution_mode" IN ('normal', 'read_only', 'require_approval', 'halted'));

-- Any mode OTHER than normal is an operator intervention and carries its
-- reason. Returning to `normal` clears it, which is why the constraint is
-- stated this way round rather than "reason required when halted".
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_execution_reason_ck"
  CHECK (
    ("execution_mode" = 'normal')
    OR ("execution_mode_reason" IS NOT NULL AND length(btrim("execution_mode_reason")) > 0)
  );

-- ── 2. Per-agent halt ────────────────────────────────────────────────────
--
-- DELIBERATELY SEPARATE FROM `agents.enabled`. They are different facts:
-- `enabled = false` means "not in service" — a registry decision, possibly
-- months old. A halt means "stopped during an incident". Collapsing them would
-- mean an operator lifting a halt silently returns an agent to service that
-- someone had deliberately retired, which is precisely the kind of quiet
-- widening this product refuses everywhere else.
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "halted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "halted_reason" text,
  ADD COLUMN IF NOT EXISTS "halted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_halt_reason_ck"
  CHECK (
    ("halted_at" IS NULL AND "halted_reason" IS NULL)
    OR ("halted_at" IS NOT NULL AND "halted_reason" IS NOT NULL AND length(btrim("halted_reason")) > 0)
  );

-- ── 3. Per-tool halt ─────────────────────────────────────────────────────
--
-- The finest scope, and the one that makes a halt usable without stopping the
-- business: a poisoned or misbehaving tool is pulled while its server, its
-- other tools and every other agent keep working.
ALTER TABLE "mcp_tools"
  ADD COLUMN IF NOT EXISTS "halted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "halted_reason" text,
  ADD COLUMN IF NOT EXISTS "halted_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "mcp_tools"
  ADD CONSTRAINT "mcp_tools_halt_reason_ck"
  CHECK (
    ("halted_at" IS NULL AND "halted_reason" IS NULL)
    OR ("halted_at" IS NOT NULL AND "halted_reason" IS NOT NULL AND length(btrim("halted_reason")) > 0)
  );

-- Partial indexes: the resolver asks "is this one halted?" on every governed
-- call, and the answer is almost always no. Indexing only the halted rows
-- keeps that lookup cheap and the index tiny.
CREATE INDEX IF NOT EXISTS "agents_halted_idx" ON "agents" ("id") WHERE "halted_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "mcp_tools_halted_idx" ON "mcp_tools" ("server_id", "name") WHERE "halted_at" IS NOT NULL;
