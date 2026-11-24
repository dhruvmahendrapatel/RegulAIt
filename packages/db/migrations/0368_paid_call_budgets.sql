-- ADR-0313 (lane E2, G9): paid-tool and agent-payment budgets. Hand-authored (never drizzle-kit generate), additive
-- and idempotent.
--
-- `paid_call_prices` makes an MCP tool, every tool of an MCP server, or a connector a PAID call. `paid_call_holds`
-- is the reservation ledger: each paid call reserves its price's `max_settle_usd` against the attributed project's
-- budget and/or its orchestration run's cap, in one transaction under that envelope's advisory lock, before the
-- upstream is contacted; it settles with the call's usage row (never above the hold) or is released.
--
-- Secure by default (ADR-0180): no budget envelope means no paid call; over budget is a refusal routed to the
-- approvals queue. RLS (ADR-0234): paid_call_holds has project_id, so it is project-scoped and joins that batch with
-- usage_events (admin-only routes read it until then); paid_call_prices is deployment-wide. Holds are never deleted. No functions or triggers. No row of an RLS table is read
-- or written here.

CREATE TABLE IF NOT EXISTS "paid_call_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "mcp_tool_id" uuid REFERENCES "mcp_tools"("id") ON DELETE CASCADE,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "price_usd" double precision NOT NULL,
  "max_settle_usd" double precision NOT NULL,
  "hold_ttl_seconds" integer DEFAULT 900 NOT NULL,
  "note" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "paid_call_prices_subject_check" CHECK (num_nonnulls("mcp_server_id", "mcp_tool_id", "connector_id") = 1),
  CONSTRAINT "paid_call_prices_amount_check" CHECK ("price_usd" > 0 AND "max_settle_usd" >= "price_usd" AND "max_settle_usd" <= 10000),
  CONSTRAINT "paid_call_prices_ttl_check" CHECK ("hold_ttl_seconds" BETWEEN 60 AND 86400),
  CONSTRAINT "paid_call_prices_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paid_call_prices_server_uq" ON "paid_call_prices" ("mcp_server_id") WHERE "mcp_server_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paid_call_prices_tool_uq" ON "paid_call_prices" ("mcp_tool_id") WHERE "mcp_tool_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paid_call_prices_connector_uq" ON "paid_call_prices" ("connector_id") WHERE "connector_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paid_call_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "price_id" uuid REFERENCES "paid_call_prices"("id") ON DELETE SET NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "orchestration_run_id" uuid REFERENCES "orchestration_runs"("id") ON DELETE SET NULL,
  "subject_kind" text NOT NULL,
  "mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE SET NULL,
  "tool_name" text,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE SET NULL,
  "held_usd" double precision NOT NULL,
  "state" text DEFAULT 'held' NOT NULL,
  "settled_usd" double precision,
  "usage_event_id" uuid REFERENCES "usage_events"("id") ON DELETE SET NULL,
  "release_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "paid_call_holds_subject_kind_check" CHECK ("subject_kind" IN ('mcp_tool', 'connector')),
  CONSTRAINT "paid_call_holds_release_reason_check" CHECK ("release_reason" IS NULL OR "release_reason" IN ('call_failed', 'expired', 'not_executed')),
  CONSTRAINT "paid_call_holds_tool_name_check" CHECK ("tool_name" IS NULL OR char_length("tool_name") BETWEEN 1 AND 256),
  CONSTRAINT "paid_call_holds_state_check" CHECK (CASE "state"
    WHEN 'held' THEN "settled_usd" IS NULL AND "release_reason" IS NULL
    WHEN 'settled' THEN "settled_usd" IS NOT NULL AND "settled_usd" >= 0 AND "settled_usd" <= "held_usd" AND "release_reason" IS NULL
    WHEN 'released' THEN "settled_usd" IS NULL AND "release_reason" IS NOT NULL
    ELSE false END),
  CONSTRAINT "paid_call_holds_amount_check" CHECK ("held_usd" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paid_call_holds_project_held_idx" ON "paid_call_holds" ("project_id") WHERE "state" = 'held';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paid_call_holds_run_held_idx" ON "paid_call_holds" ("orchestration_run_id") WHERE "state" = 'held';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paid_call_holds_expiry_idx" ON "paid_call_holds" ("expires_at") WHERE "state" = 'held';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paid_call_holds_created_idx" ON "paid_call_holds" ("created_at");
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "paid_call_holds" FROM regulait_app;
