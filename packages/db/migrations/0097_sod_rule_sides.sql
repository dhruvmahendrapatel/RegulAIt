-- Migration 0097 (ADR-0091 amendment, batch B2) — SoD SELECTOR DEPTH: N-WAY
-- TOXIC SETS AND PATTERN SELECTORS.
--
-- ADR-0091 shipped two-sided, id-concrete rules and named both extensions as
-- follow-up rather than smuggling them in. This migration builds that named
-- follow-up:
--
--   * N-WAY SETS. A rule may name 2..N capability sides. The conflict
--     semantics stay strict: an identity's effective holdings must contain
--     ALL sides for the rule to refuse a mint — any N-1 subset is allowed.
--   * PATTERN SELECTORS. Alongside concrete ids, a side may select by an
--     ENUMERABLE dimension the schema actually has: an agent's lifecycle
--     status ('active'|'deprecated'|'retired'), an agent's provider kind
--     (the closed MODEL_PROVIDER_KINDS vocabulary), or a connector holding's
--     mode ('read'|'readwrite' — any connector at that mode). NO free-form
--     regex/category text anywhere — the ADR-0085 data-only-rules discipline:
--     a pattern is a (dimension, value) pair over a closed vocabulary,
--     validated in the gateway, resolved at CHECK time against current
--     objects (a new agent matching the pattern is covered the moment it
--     exists; nothing is snapshotted).
--
-- STORAGE, stated plainly. Existing two-sided rules stay in the a_*/b_*
-- columns BYTE-IDENTICALLY — nothing rewrites them, and a legacy row remains
-- valid under every constraint below. New-shape rules (N-way and/or pattern)
-- store EVERY side in `sod_rule_sides` and leave the legacy columns NULL:
-- the legacy columns are relaxed to nullable with a shape CHECK so a row is
-- either fully legacy-sided or fully child-sided, never half of each. The
-- gateway reads both shapes through one loader; there is no second check
-- path.

ALTER TABLE "sod_rules" ALTER COLUMN "a_kind" DROP NOT NULL;
ALTER TABLE "sod_rules" ALTER COLUMN "a_object_id" DROP NOT NULL;
ALTER TABLE "sod_rules" ALTER COLUMN "b_kind" DROP NOT NULL;
ALTER TABLE "sod_rules" ALTER COLUMN "b_object_id" DROP NOT NULL;

-- a rule is legacy-sided (all four legacy columns present) or child-sided
-- (all four NULL, with no orphaned tool/mode qualifiers) — never in between.
-- Every pre-0097 row has all four columns set, so this admits them unchanged.
DO $$ BEGIN
  ALTER TABLE "sod_rules"
    ADD CONSTRAINT "sod_rules_side_storage_check" CHECK (
      (("a_kind" IS NOT NULL) = ("a_object_id" IS NOT NULL))
      AND (("b_kind" IS NOT NULL) = ("b_object_id" IS NOT NULL))
      AND (("a_kind" IS NULL) = ("b_kind" IS NULL))
      AND ("a_kind" IS NOT NULL
           OR ("a_tool_name" IS NULL AND "a_mode" IS NULL
               AND "b_tool_name" IS NULL AND "b_mode" IS NULL))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "sod_rule_sides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- CASCADE with the rule: a side is meaningless without its rule
  "rule_id" uuid NOT NULL,
  -- stable display/order position within the rule (1-based)
  "position" integer NOT NULL,
  "selector" text NOT NULL,
  "kind" text NOT NULL,
  -- concrete selectors only
  "object_id" uuid,
  "tool_name" text,
  "mode" text,
  -- pattern selectors only: an enumerable (dimension, value) pair — the
  -- gateway validates the value against the dimension's closed vocabulary
  "pattern_dimension" text,
  "pattern_value" text,
  CONSTRAINT "sod_rule_sides_position_uq" UNIQUE ("rule_id", "position"),
  CONSTRAINT "sod_rule_sides_selector_check" CHECK ("selector" IN ('concrete', 'pattern')),
  CONSTRAINT "sod_rule_sides_kind_check"
    CHECK ("kind" IN ('agent', 'connector', 'mcp_tool', 'mcp_server')),
  -- concrete: an object id, no pattern columns; tool name iff mcp_tool;
  -- mode only on connector sides
  CONSTRAINT "sod_rule_sides_concrete_check" CHECK (
    "selector" <> 'concrete' OR (
      "object_id" IS NOT NULL
      AND "pattern_dimension" IS NULL AND "pattern_value" IS NULL
      AND (("kind" = 'mcp_tool') = ("tool_name" IS NOT NULL))
      AND ("mode" IS NULL OR ("kind" = 'connector' AND "mode" IN ('read', 'readwrite')))
    )
  ),
  -- pattern: a (dimension, value) pair over a closed vocabulary, no concrete
  -- columns. The three dimensions are the ones the schema actually has —
  -- agent lifecycle status, agent provider kind, connector holding mode —
  -- never free text matched against names.
  CONSTRAINT "sod_rule_sides_pattern_check" CHECK (
    "selector" <> 'pattern' OR (
      "object_id" IS NULL AND "tool_name" IS NULL AND "mode" IS NULL
      AND "pattern_dimension" IS NOT NULL AND "pattern_value" IS NOT NULL
      AND (
        ("kind" = 'agent' AND "pattern_dimension" IN ('lifecycle_status', 'provider'))
        OR ("kind" = 'connector' AND "pattern_dimension" = 'mode'
            AND "pattern_value" IN ('read', 'readwrite'))
      )
    )
  ),
  CONSTRAINT "sod_rule_sides_lifecycle_value_check" CHECK (
    "pattern_dimension" <> 'lifecycle_status'
    OR "pattern_value" IN ('active', 'deprecated', 'retired')
  )
);

DO $$ BEGIN
  ALTER TABLE "sod_rule_sides"
    ADD CONSTRAINT "sod_rule_sides_rule_fk"
    FOREIGN KEY ("rule_id") REFERENCES "sod_rules"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "sod_rule_sides_rule_idx" ON "sod_rule_sides" ("rule_id");
