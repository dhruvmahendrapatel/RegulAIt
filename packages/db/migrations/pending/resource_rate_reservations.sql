-- ADR-0251 (P-01 remainder): HARD rate-limit windows for connector and A2A calls.
--
-- One row is one slot a call took inside a `resource_rate_limits` window. The governed core writes it in the same
-- transaction as the recount, under a per-(user, resource type) advisory lock, only when a limit binds the call and the
-- decision is allow; the windows count these rows instead of audit rows (which are written after the call runs), so
-- concurrent calls can no longer overshoot a limit. Rows older than the longest window (30 days) are pruned by the
-- reserving transaction.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "resource_rate_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource_type" text NOT NULL,
  "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE,
  "a2a_agent_id" uuid REFERENCES "a2a_agents"("id") ON DELETE CASCADE,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_rate_reservations_type_check" CHECK (CASE "resource_type"
    WHEN 'connector' THEN "connector_id" IS NOT NULL AND "a2a_agent_id" IS NULL
    WHEN 'a2a' THEN "a2a_agent_id" IS NOT NULL AND "connector_id" IS NULL
    ELSE false END)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_rate_reservations_window_idx"
  ON "resource_rate_reservations" ("user_id", "resource_type", "at");
