-- ADR-0175 batch D2, item A4 — record the model the provider actually served.
--
-- 1. `usage_events.served_model`: the model id the PROVIDER reported in its
--    response (Anthropic / OpenAI-compatible `model`, Google `modelVersion`),
--    stored beside `model` (the configured id we asked for). NULL = the
--    provider did not report one — never guessed. Every pre-0141 row, every
--    connector / MCP / training row and every semantic-cache hit stays NULL.
-- 2. `model_cards.pinned_model_version`: OPTIONAL exact model version a card's
--    risk position was taken on. NULL (DEFAULT) = the card covers the agent's
--    configured id under the governance monitor's version-suffix matching
--    rule; set = any other served id raises `served_model_drift` at high
--    severity.
-- 3. A partial index for the monitor's window scan of reported served models.
--
-- Additive and idempotent: nullable columns, no default changes the meaning of
-- an existing row.
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "served_model" text;
--> statement-breakpoint
ALTER TABLE "model_cards" ADD COLUMN IF NOT EXISTS "pinned_model_version" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_served_model_idx"
  ON "usage_events" ("agent_id", "at") WHERE "served_model" IS NOT NULL;
