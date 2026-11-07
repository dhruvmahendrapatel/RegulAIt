-- ADR-0207 (G4) — an MCP server can be disabled, enabled again and deleted. Hand-authored (never drizzle-kit generate).
--
-- 1. The same three nullable columns and CHECK as `connectors` (0219). NULL `disabled_at` = enabled; nothing is
--    backfilled. A disable is a fourth fact beside `admission_state`, a tool's `halted_at` and the circuit breaker
--    (ADR-0126): clearing one never clears another.
-- 2. THE POLICY-EPOCH TRIGGER. `mcp_servers` had none, because the proxy rewrites the row constantly (breaker state,
--    registry sync stamps). A row-level trigger fires only when `disabled_at` changes, and on a delete, so an
--    admission decided before the disable is withheld at its final epoch check, and breaker writes stay free.
--    It reuses `advance_governance_policy_epoch()` (0119, search_path pinned in 0185); no new function.
-- 3. `disabled_reason` is operator prose, registered in prose-scrub.ts (ADR-0102).

ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disabled_reason" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_disabled_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_disabled_check" CHECK (
  ("disabled_at" IS NULL AND "disabled_reason" IS NULL AND "disabled_by" IS NULL)
  OR ("disabled_at" IS NOT NULL AND char_length("disabled_reason") BETWEEN 10 AND 1000)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_servers_disable_policy_epoch" ON "mcp_servers";
--> statement-breakpoint
CREATE TRIGGER "mcp_servers_disable_policy_epoch" AFTER UPDATE ON "mcp_servers"
  FOR EACH ROW WHEN (OLD."disabled_at" IS DISTINCT FROM NEW."disabled_at")
  EXECUTE FUNCTION advance_governance_policy_epoch();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mcp_servers_delete_policy_epoch" ON "mcp_servers";
--> statement-breakpoint
CREATE TRIGGER "mcp_servers_delete_policy_epoch" AFTER DELETE ON "mcp_servers"
  FOR EACH STATEMENT EXECUTE FUNCTION advance_governance_policy_epoch();
