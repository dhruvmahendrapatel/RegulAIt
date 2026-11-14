-- ADR-0230 slice A2, gateway part (Lane L3): SAP business MCP servers.
-- Hand-authored (never drizzle-kit generate). Numbered at merge (ADR-0252). Re-runnable: every statement is idempotent.
--
-- 1. `mcp_servers.system_class`: null (the default, every existing row) is an ordinary MCP server. `sap_business` marks
--    a server whose write tools post business documents into SAP; marking it seeds the strict defaults (a quorum-2
--    approval rule on its write tools, a write-only rate limit) and makes every write need a budgeted project.
-- 2. `rate_limits.write_only`: false (the default, every existing row) counts every call, as today. True narrows the
--    limit to write-kind tools, matched by the same read/write classification approval rules already use, so one row
--    covers write tools discovered later. Turning it on narrows what is limited, so it is a loosening (rule-loosening.ts).
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "system_class" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_system_class_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_system_class_check" CHECK ("system_class" IS NULL OR "system_class" IN ('sap_business'));
--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN IF NOT EXISTS "write_only" boolean DEFAULT false NOT NULL;
