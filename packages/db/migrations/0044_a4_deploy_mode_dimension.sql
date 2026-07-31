-- Migration 0044 — A4 (ADR-0027, decomposing ADR-0019's deferred A4):
-- (a) a deploy_mode dimension on audit_log, written by deploy-mode-scoped
--     actions (workflow deploy/rollback events, infra operations on resources
--     pinned to a deploy target). NULLABLE ON PURPOSE and NOT backfilled:
--     pre-existing rows carry no mode to derive one from (ADR-0019's own
--     finding), so null = "unknown / not a deploy-scoped action" — an honest
--     absence, never an invented value.
-- (b) a MAX-only per-mode audit-retention override (org_settings jsonb map
--     mode -> days, default {} = no overrides = today). Composition is
--     max(global floor, mode override) per row — an override can only ever
--     EXTEND retention for its mode's rows, never shorten below any
--     applicable floor.
-- (c) a deploy_mode scope on the three pillar-1 restriction-rule tables,
--     mirroring migration 0026's additive scoping: null (every existing and
--     default row) = mode-unscoped = today's behaviour, byte-identical.
ALTER TABLE "audit_log" ADD COLUMN "deploy_mode" text;
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "deploy_mode" text;
--> statement-breakpoint
ALTER TABLE "rate_limits" ADD COLUMN "deploy_mode" text;
--> statement-breakpoint
ALTER TABLE "data_scope_rules" ADD COLUMN "deploy_mode" text;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "mode_audit_retention" jsonb DEFAULT '{}'::jsonb NOT NULL;
