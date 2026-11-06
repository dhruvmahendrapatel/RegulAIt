-- ADR-0212 (P12 b and c): modality pricing in cost attribution, and rate limits keyed on the model.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. agents: four optional per-modality list prices per million tokens. NULL (every existing row) = that modality is
--    priced at the text price, so no existing agent's cost changes.
-- 2. usage_events.modality_usage: the text/image/audio split of a dispatch's tokens and cost, written only when the
--    provider reported modality data. NULL on every existing row; nothing is backfilled or inferred.
-- 3. model_rate_limits: its own table (the MCP tool path's rate_limits stay byte-identical). The scope discriminant is
--    the rate_limits_scope_ck rule; the bounds repeat the shared schema's.
-- 4. org_settings.model_rate_limits_enabled: off by default (the owner's lane rule: new features land behind a
--    default-off org setting). Written only by PUT /v1/rules/model-rate-limits/enforcement (admin, step-up, audited).
-- No functions or triggers are added (zz-dbguard-0185 checked by hand).

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_per_mtok_image_in" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_per_mtok_image_out" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_per_mtok_audio_in" double precision;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_per_mtok_audio_out" double precision;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_modality_prices_ck";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_modality_prices_ck" CHECK (
  (cost_per_mtok_image_in IS NULL OR cost_per_mtok_image_in >= 0)
  AND (cost_per_mtok_image_out IS NULL OR cost_per_mtok_image_out >= 0)
  AND (cost_per_mtok_audio_in IS NULL OR cost_per_mtok_audio_in >= 0)
  AND (cost_per_mtok_audio_out IS NULL OR cost_per_mtok_audio_out >= 0)
);--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN IF NOT EXISTS "modality_usage" jsonb;--> statement-breakpoint
ALTER TABLE "usage_events" DROP CONSTRAINT IF EXISTS "usage_events_modality_usage_ck";--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_modality_usage_ck" CHECK (
  modality_usage IS NULL OR (jsonb_typeof(modality_usage) = 'object' AND modality_usage ?& ARRAY['text', 'image', 'audio'])
);--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "model_rate_limits_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text DEFAULT 'user' NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid REFERENCES "roles"("id") ON DELETE CASCADE,
  "team_id" uuid REFERENCES "teams"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "max_calls" integer NOT NULL,
  "window_seconds" integer NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_rate_limits_max_calls_check" CHECK ("max_calls" BETWEEN 1 AND 1000000),
  CONSTRAINT "model_rate_limits_window_check" CHECK ("window_seconds" BETWEEN 1 AND 2592000),
  CONSTRAINT "model_rate_limits_scope_ck" CHECK (CASE scope
    WHEN 'user' THEN user_id IS NOT NULL AND role_id IS NULL AND team_id IS NULL
    WHEN 'role' THEN role_id IS NOT NULL AND user_id IS NULL AND team_id IS NULL
    WHEN 'team' THEN team_id IS NOT NULL AND user_id IS NULL AND role_id IS NULL
    WHEN 'fleet' THEN user_id IS NULL AND role_id IS NULL AND team_id IS NULL
    ELSE false END)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_rate_limits_agent_idx" ON "model_rate_limits" ("agent_id");--> statement-breakpoint
-- the dispatch-time count: one user's agent rows for one agent inside a window
CREATE INDEX IF NOT EXISTS "usage_events_user_agent_at_idx" ON "usage_events" ("user_id", "agent_id", "at") WHERE "object_type" = 'agent';
