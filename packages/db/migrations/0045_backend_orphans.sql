-- Migration 0045 — the remaining "backend orphans" DDL (ADR-0027), grouped:
-- each section is additive with behaviour-preserving defaults.

-- O6 cert-rotation lifecycle: one cert_rotations row PER ATTEMPT (created at
-- propose, advanced by /decide to rotated/denied/failed). `reason` carries
-- the approver's denial reason or the provider's failure message. The status
-- enums (cert_inventory rotation_denied/rotation_failed, cert_rotations
-- denied) are drizzle-side text enums — no DDL needed for them.
ALTER TABLE "cert_rotations" ADD COLUMN "reason" text;
--> statement-breakpoint

-- O5 backup-verification scheduler: `success` backup_runs rows stop being
-- seed/manual-only. A boot-scheduled pass (org toggle, default OFF = today)
-- verifies recent recovery points per backup_target via the EXISTING provider
-- scan path and writes honest ledger rows: `source` marks who wrote a row —
-- 'scheduler:<provider-kind>' for scheduler-verified rows (the mock provider
-- is labelled 'scheduler:mock', never mistakable for a real cloud check);
-- null = a pre-O5 / seed / manual row.
ALTER TABLE "backup_runs" ADD COLUMN "source" text;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "backup_verify_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "backup_verify_interval_hours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint

-- O9 partial revocations: 'full' (default = every existing row = today's
-- total semantics) vs 'read_only' (write-classified tools/ops denied, reads
-- still allowed). MCP + connector revocations only — agent revocations have
-- no read/write op classification to scope by (ADR-0027).
ALTER TABLE "revocations" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE "connector_revocations" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;
--> statement-breakpoint

-- O10 per-tool MCP pricing: an optional per-tool override on the inventory
-- row; resolution is tool-first, server-flat-price fallback. Null (every
-- existing and auto-synced row) = no override = today's flat server price.
ALTER TABLE "mcp_tools" ADD COLUMN "price_per_call_usd" double precision;
--> statement-breakpoint

-- O2 per-framework cost policies: a compliance profile may declare a project
-- budget CEILING (composed as MIN — the strictest ceiling wins, and it also
-- caps an unbudgeted project) and a budget-enforcement FLOOR (a profile
-- declaring 'block' forces blocking even when the org says warn_only —
-- strictest wins; 'warn_only' can never relax a stricter org and is surfaced
-- as an inert declaration). Null (every existing row) = no cost opinion =
-- today's behaviour.
ALTER TABLE "compliance_profiles" ADD COLUMN "max_project_budget_usd" double precision;
--> statement-breakpoint
ALTER TABLE "compliance_profiles" ADD COLUMN "budget_enforcement" text;
