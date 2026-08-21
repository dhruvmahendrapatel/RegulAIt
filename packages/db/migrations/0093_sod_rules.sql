-- Migration 0093 (ADR-0091) — TOXIC-COMBINATION SEGREGATION OF DUTIES (gap
-- L23, docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
--
-- Saviynt's SoD franchise is cross-application ERP rulesets ("requester
-- cannot hold A and B" across SAP/Oracle transactions). Ours is DELIBERATELY
-- narrower and ours: a rule names two GATEWAY capabilities (an agent, a
-- connector — optionally at a mode, an MCP tool, an MCP server) that no
-- single identity may hold together, enforced where gateway grants are
-- MINTED. Replicating ERP cross-app SoD is Saviynt's decades-deep fight and
-- is refused on the comparison page, not half-built here.
--
-- THE RULES THIS SCHEMA STATES (enforced in the gateway):
--
--   * Selectors are CONCRETE (id-based). No pattern/category selectors in
--     this slice — a rule names exactly two capabilities. Pattern selectors
--     are named follow-up work in the ADR, not smuggled in as jsonb.
--   * `reason` is REQUIRED. An SoD rule without a recorded rationale is
--     cargo cult — the refusal it produces must be able to say WHY.
--   * A rule is PREVENTIVE AT MINT TIME ONLY. Creating or enabling a rule
--     never strips existing holders (silent revocation by side effect is
--     the kind of magic this product refuses); existing violators are
--     COMPUTED AT READ TIME and surfaced, to be resolved through ADR-0090
--     certification campaigns or ordinary revocation.
--   * An override is a first-class record riding the ONE approvals queue
--     (`sod_override_requests` below): the refused mint's exact payload is
--     stored, an arm's-length approver decides it, and an approval mints
--     the grant WITH the overridden rule recorded in the audit detail.
--     Denied = nothing minted, ever.

CREATE TABLE IF NOT EXISTS "sod_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  -- side A / side B: kind + the concrete object id; mcp_tool sides also
  -- carry the tool name (a tool is identified by server + name); connector
  -- sides may carry a mode qualifier (read|readwrite; NULL = any mode)
  "a_kind" text NOT NULL,
  "a_object_id" uuid NOT NULL,
  "a_tool_name" text,
  "a_mode" text,
  "b_kind" text NOT NULL,
  "b_object_id" uuid NOT NULL,
  "b_tool_name" text,
  "b_mode" text,
  "reason" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  -- who declared the combination toxic. SET NULL on user deletion: the rule
  -- must OUTLIVE its author — a cascade here would silently un-enforce a
  -- control because an admin left.
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sod_rules_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "sod_rules_name_uq" UNIQUE ("name"),
  CONSTRAINT "sod_rules_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "sod_rules_a_kind_check"
    CHECK ("a_kind" IN ('agent', 'connector', 'mcp_tool', 'mcp_server')),
  CONSTRAINT "sod_rules_b_kind_check"
    CHECK ("b_kind" IN ('agent', 'connector', 'mcp_tool', 'mcp_server')),
  -- tool name iff the side is an MCP tool; mode only on connector sides
  CONSTRAINT "sod_rules_a_tool_check" CHECK (("a_kind" = 'mcp_tool') = ("a_tool_name" IS NOT NULL)),
  CONSTRAINT "sod_rules_b_tool_check" CHECK (("b_kind" = 'mcp_tool') = ("b_tool_name" IS NOT NULL)),
  CONSTRAINT "sod_rules_a_mode_check"
    CHECK ("a_mode" IS NULL OR ("a_kind" = 'connector' AND "a_mode" IN ('read', 'readwrite'))),
  CONSTRAINT "sod_rules_b_mode_check"
    CHECK ("b_mode" IS NULL OR ("b_kind" = 'connector' AND "b_mode" IN ('read', 'readwrite'))),
  -- a capability cannot be toxic with itself — a self-pair enforces nothing
  CONSTRAINT "sod_rules_sides_differ_check" CHECK (NOT (
    "a_kind" = "b_kind" AND "a_object_id" = "b_object_id"
    AND "a_tool_name" IS NOT DISTINCT FROM "b_tool_name"
    AND "a_mode" IS NOT DISTINCT FROM "b_mode"
  ))
);

DO $$ BEGIN
  ALTER TABLE "sod_rules"
    ADD CONSTRAINT "sod_rules_created_by_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "sod_rules_enabled_idx" ON "sod_rules" ("enabled");

-- A refused mint, escalated. The request stores the EXACT validated mint
-- payload so an approval can execute precisely the mint that was refused —
-- never a client-restated one — and the rule it would override is
-- SERVER-DERIVED at request time (re-checked, never client-asserted).
CREATE TABLE IF NOT EXISTS "sod_override_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" uuid NOT NULL,
  -- which mint path was refused; the payload is that path's validated body
  "mint_kind" text NOT NULL,
  "mint_payload" jsonb NOT NULL,
  -- the conflict as computed at request time (rule name, identity, the
  -- existing holding) — display evidence, the enforcement re-checks live
  "conflict_detail" jsonb NOT NULL,
  -- one line for the queue row: who wants what, despite which rule
  "label" text NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  -- the row in the ONE approvals queue carrying this request's decision
  "approval_id" uuid,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  -- what an approval actually minted (grant row id + kind), null until then
  "mint_detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sod_override_mint_kind_check"
    CHECK ("mint_kind" IN ('agent', 'connector', 'tool', 'server',
                           'role_agent', 'role_connector', 'role_tool', 'role_server',
                           'role_assignment')),
  CONSTRAINT "sod_override_status_check" CHECK ("status" IN ('pending', 'approved', 'denied')),
  CONSTRAINT "sod_override_decided_check" CHECK (("status" = 'pending') = ("decided_at" IS NULL)),
  CONSTRAINT "sod_override_decided_by_check" CHECK (("status" = 'pending') = ("decided_by_user_id" IS NULL))
);

-- CASCADE with the rule: an override request is meaningless without the rule
-- it overrides (deleting the rule un-declares the toxicity, so pending
-- escalations about it are moot; decided history lives in the audit log,
-- which has no FKs by design).
DO $$ BEGIN
  ALTER TABLE "sod_override_requests"
    ADD CONSTRAINT "sod_override_rule_fk"
    FOREIGN KEY ("rule_id") REFERENCES "sod_rules"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "sod_override_requests"
    ADD CONSTRAINT "sod_override_requested_by_fk"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL, not CASCADE: the queue row may cascade away with its user; the
-- override request is the durable record of the escalation.
DO $$ BEGIN
  ALTER TABLE "sod_override_requests"
    ADD CONSTRAINT "sod_override_approval_fk"
    FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "sod_override_rule_idx" ON "sod_override_requests" ("rule_id");
CREATE INDEX IF NOT EXISTS "sod_override_approval_idx" ON "sod_override_requests" ("approval_id");
CREATE INDEX IF NOT EXISTS "sod_override_status_idx" ON "sod_override_requests" ("status");
