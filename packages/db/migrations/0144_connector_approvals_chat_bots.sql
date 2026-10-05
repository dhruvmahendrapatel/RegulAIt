-- ADR-0173 batch 2b — the batch-2a leftovers.
--
-- 1. CONNECTOR WRITES IN THE APPROVALS QUEUE. Under the execution dial's
--    `require_approval` mode a connector write is no longer refused: it is
--    queued as an `approvals` row of object type 'connector_call' (no DB CHECK
--    on that column, see 0001), bound to the call's argument digest and policy
--    context exactly as an MCP tool approval is (ADR-0104/0105/0166).
--    `connector_id` names the connector the consent may be spent against; it
--    is NULL on every other kind of approval. The index is the matcher's
--    lookup shape (who, which connector, status, which payload).
-- 2. MICROSOFT TEAMS BOT FRAMEWORK. A Teams workspace may also receive
--    activities from a registered bot: `bot_app_id` is the audience a Bot
--    Framework token must carry, `bot_tenant_id` (optional) pins the tenant an
--    activity must come from, and `bot_openid_metadata_url` (optional) points
--    at the OpenID metadata whose JWKS signs the tokens. The bot endpoint is
--    off until `bot_app_id` is set, and only a teams workspace may set it.
-- 3. SLACK "ASK FIRST" BUTTONS. `builder_step_chat_prompts` records the Slack
--    message that carries Approve / Deny for one paused tool step: which
--    workspace and channel, the message handle (to update it), and the ONE
--    answer it took. `answered_at` is claimed once, so a second click (or a
--    second person) is refused.
-- 4. SLACK WORKSPACE PIN (batch 2b review). `slack_team_id` (optional, slack
--    only) names the one Slack workspace (team) whose signed events and
--    interactions this connection accepts; one from another team is refused
--    and audited even when its signature verifies (a signing secret is per
--    app, and one app can be installed in several workspaces).
--
-- Additive and idempotent (the one replaced CHECK is dropped and re-added).
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "connector_id" uuid REFERENCES "connectors"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_connector_binding_idx"
  ON "approvals" ("user_id", "connector_id", "status", "arguments_digest")
  WHERE "connector_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "bot_app_id" text;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "bot_tenant_id" text;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "bot_openid_metadata_url" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_bot_teams_check"
    CHECK (("bot_app_id" IS NULL AND "bot_tenant_id" IS NULL AND "bot_openid_metadata_url" IS NULL) OR "provider" = 'teams');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD COLUMN IF NOT EXISTS "slack_team_id" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_slack_team_check"
    CHECK ("slack_team_id" IS NULL OR "provider" = 'slack');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- 0112 required a signing secret on every slack/teams row. A teams workspace
-- reached ONLY through its registered bot verifies the platform's signed
-- tokens instead, so for teams a secret OR a bot app id is required (still
-- never neither: a workspace that could never be answered stays impossible).
ALTER TABLE "chatops_connections" DROP CONSTRAINT IF EXISTS "chatops_connections_signing_secret_ck";
--> statement-breakpoint
ALTER TABLE "chatops_connections" ADD CONSTRAINT "chatops_connections_signing_secret_ck"
  CHECK (
    ("provider" = 'outlook' AND "signing_secret_ciphertext" IS NULL)
    OR ("provider" = 'teams' AND ("signing_secret_ciphertext" IS NOT NULL OR "bot_app_id" IS NOT NULL))
    OR ("provider" NOT IN ('outlook', 'teams') AND "signing_secret_ciphertext" IS NOT NULL)
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_step_chat_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "step_id" uuid NOT NULL REFERENCES "builder_tool_steps"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "chatops_connections"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "message_ref" text,
  "posted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "answered_at" timestamp with time zone,
  "answered_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "answer" text,
  CONSTRAINT "builder_step_chat_prompts_answer_check" CHECK ("answer" IS NULL OR "answer" IN ('approve', 'deny'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_step_chat_prompts_step_uq" ON "builder_step_chat_prompts" ("step_id", "connection_id");
