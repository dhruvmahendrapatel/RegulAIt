-- ADR-0255 (P31): the governed connector catalogue (curated Activepieces community pieces).
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- `connector_piece_enablements`: one row per curated piece an admin has enabled. No row = not enabled (ADR-0180
-- secure by default), so a fresh install enables nothing and nothing is backfilled. Written only by the admin-only,
-- step-up-gated, audited `POST /v1/connector-catalogue/:pieceKey/enablement` (insert to enable, delete to disable,
-- each with its audit row in the same transaction). The CHECK repeats CURATED_PIECES' keys in
-- @regulait/connector-provider, so a row written around the API cannot enable a piece that has no RegulAIt adapter.
-- The enabling admin is a foreign key (3NF); ON DELETE SET NULL keeps the enablement when the account goes, and the
-- audit row keeps who it was.

CREATE TABLE IF NOT EXISTS "connector_piece_enablements" (
  "piece_key" text PRIMARY KEY NOT NULL,
  "enabled_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connector_piece_enablements_piece_key_check"
    CHECK ("piece_key" IN ('slack', 'jira-cloud', 'github', 'google-sheets', 'gmail'))
);
