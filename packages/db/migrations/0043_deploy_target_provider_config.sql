-- Migration 0043 — the #64 flagged gap: per-provider-kind deploy-target
-- config. One nullable jsonb (validated per kind by the shared zod schema at
-- the API boundary) rather than a column per field, so the table stays
-- provider-agnostic: a future provider adds keys, not DDL. Null = a pre-0043
-- row = the legacy behaviour (roleArn doubles as the azure subscription / gcp
-- project handle, live deploy clients fall back to their env vars).
ALTER TABLE "deploy_targets" ADD COLUMN "provider_config" jsonb;
