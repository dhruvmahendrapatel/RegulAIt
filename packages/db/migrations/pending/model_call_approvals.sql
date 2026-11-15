-- ADR-0251 (P-01 remainder): an approval queue for MODEL calls.
--
-- A model call matched by a model approval rule (`resource_approval_rules`, resource_type 'model') is now held in the
-- one approvals queue as a 'model_call' approval instead of being refused. The approval names the agent (model) it may
-- be spent against; it is released only by the identical re-submitted call (ADR-0104 payload binding, ADR-0105 context
-- binding) and spent once. `approvals.object_type` has no DB CHECK (migration 0001), so the new kind needs no DDL.
--
-- Additive and idempotent.
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_agent_binding_idx"
  ON "approvals" ("user_id", "agent_id", "status", "arguments_digest")
  WHERE "agent_id" IS NOT NULL;
