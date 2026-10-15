-- ADR-0188 slice S8 follow-up: a per-MCP-server opt-in, "disclose agent workload IDs". Hand-authored (never
-- drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- With `identity_propagation = 'signed_assertion'`, each agent in an outbound assertion's `act` chain is named by a
-- PAIRWISE id (an HMAC of the audience and the workload identity id): stable for one server, unlinkable across
-- servers. That stays the default. This column lets an admin name the agents by their real workload identifiers (their
-- SPIFFE IDs) for ONE server instead. Those are global and may be admin-typed, so two upstreams could correlate the
-- same agent: turning it on is a relaxation (ADR-0180), a `settings_relax` step-up bound to the server and its url,
-- audited, reset by a url move.
--
-- Built as for a first load (ADR-0180): the column defaults to false (the strict value) on every existing row, and the
-- CHECK makes it meaningful only while the server is sent an assertion. Every row satisfies it at once: no row can be
-- true yet. A stdio server can never be `signed_assertion` (the S8 PATCH refusal), so it can never disclose either.
-- Adding a NOT NULL column with a constant default rewrites no row (Postgres 11+).

ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "disclose_agent_workload_ids" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_disclose_agent_ids_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_disclose_agent_ids_check"
  CHECK (NOT "disclose_agent_workload_ids" OR "identity_propagation" = 'signed_assertion');
