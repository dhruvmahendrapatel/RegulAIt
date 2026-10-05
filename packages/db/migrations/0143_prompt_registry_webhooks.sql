-- ADR-0173 batch 2b — the governed prompt registry, outbound webhooks, and the
-- playground's model-policy feature.
--
-- prompts / prompt_shares    the identity and its visibility (the builder model:
--                            private, workspace, or named people; admins see all)
-- prompt_commits             IMMUTABLE content addressed by a sha256 over
--                            {template, model config, variables, output schema,
--                            tools, parent}
-- prompt_tags                movable names -> commits
-- prompt_promotions          a `prod` move waiting on the approvals queue, pinned
--                            to the (prompt, tag, commit hash) digest; the tag
--                            moves only in the decide hook, and only if the
--                            binding still holds
-- webhook_subscriptions      admin-managed; the Standard Webhooks signing secret
--                            is a REGULAIT_DATA_KEY envelope (CIPHERTEXT_COLUMNS)
-- webhook_deliveries         the delivery log; retried on the scheduler sweep
CREATE TABLE IF NOT EXISTS "prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "visibility" text DEFAULT 'private' NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompts_visibility_ck" CHECK ("visibility" IN ('private', 'workspace', 'people'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompts_owner_idx" ON "prompts" ("owner_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompts_name_live_uq" ON "prompts" (lower("name")) WHERE "archived_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_shares" (
  "prompt_id" uuid NOT NULL REFERENCES "prompts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_shares_prompt_id_user_id_pk" PRIMARY KEY ("prompt_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_shares_user_idx" ON "prompt_shares" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_commits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prompt_id" uuid NOT NULL REFERENCES "prompts"("id") ON DELETE CASCADE,
  "hash" text NOT NULL,
  "parent_hash" text,
  "template" text NOT NULL,
  "model_config" jsonb NOT NULL,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "output_schema" jsonb,
  "tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "author_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_commits_hash_ck" CHECK ("hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_commits_prompt_hash_uq" ON "prompt_commits" ("prompt_id", "hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_commits_prompt_created_idx" ON "prompt_commits" ("prompt_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_tags" (
  "prompt_id" uuid NOT NULL REFERENCES "prompts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "commit_id" uuid NOT NULL REFERENCES "prompt_commits"("id") ON DELETE CASCADE,
  "moved_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "moved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_tags_prompt_id_name_pk" PRIMARY KEY ("prompt_id", "name"),
  CONSTRAINT "prompt_tags_name_ck" CHECK ("name" ~ '^[a-z][a-z0-9_-]{0,31}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_promotions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prompt_id" uuid NOT NULL REFERENCES "prompts"("id") ON DELETE CASCADE,
  "tag" text NOT NULL,
  "commit_id" uuid NOT NULL REFERENCES "prompt_commits"("id") ON DELETE CASCADE,
  "commit_hash" text NOT NULL,
  "previous_commit_hash" text,
  "binding_digest" text NOT NULL,
  "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "approver_user_id" uuid NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'pending_approval' NOT NULL,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "prompt_promotions_status_ck" CHECK ("status" IN ('pending_approval', 'applied', 'denied', 'stale'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_promotions_one_pending_uq"
  ON "prompt_promotions" ("prompt_id", "tag") WHERE "status" = 'pending_approval';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompt_promotions_approval_idx" ON "prompt_promotions" ("approval_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "secret_ciphertext" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "allow_plaintext_http" boolean DEFAULT false NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "webhook_subscriptions_name_unique" UNIQUE ("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "message_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer NOT NULL,
  "next_retry_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "response_code" integer,
  "last_error" text,
  "lease_until" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "webhook_deliveries_status_ck" CHECK ("status" IN ('pending', 'delivered', 'failed')),
  CONSTRAINT "webhook_deliveries_attempts_ck" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" ("status", "next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscription_idx" ON "webhook_deliveries" ("subscription_id", "created_at");
--> statement-breakpoint
-- the playground is its own model-policy feature
ALTER TABLE "model_policy_rules" DROP CONSTRAINT IF EXISTS "model_policy_rules_feature_ck";
--> statement-breakpoint
ALTER TABLE "model_policy_rules" ADD CONSTRAINT "model_policy_rules_feature_ck"
  CHECK ("feature" IN ('chat', 'builder', 'copilot', 'intake_assist', 'evals', 'orchestration', 'compat', 'playground'));
