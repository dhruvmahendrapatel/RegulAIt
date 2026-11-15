-- ADR-0320 (lane E5, slice 2): third-party cloud coding agents as governed pillar-7 workers. Hand-authored (never
-- drizzle-kit generate). Re-runnable: every statement is idempotent. No function is created here and no refusal
-- trigger is added (zz-dbguard-0185): the only trigger reuses the existing, pinned `regulait_stamp_secret_set`.
--
-- 1. `org_settings.cloud_workers_enabled`, default false (ADR-0180): no dispatch until an admin turns it on through
--    the audited `PUT /v1/org/settings` (a `settings_relax` step-up). Nothing is backfilled.
-- 2. `cloud_worker_providers`: one row per provider id (`CLOUD_WORKER_PROVIDERS` in the orchestration kernel), created
--    disabled. `halted_at` / `halted_reason` are the per-provider kill switch and are set together.
--    `allow_private_ranges` NULL inherits the org's MCP private-range default, exactly like `a2a_agents`.
-- 3. `cloud_worker_credentials`: the provider's service-account key, data-key envelope (CIPHERTEXT_COLUMNS), last four
--    only. Its own table so no provider read carries the ciphertext. `secret_set_at` is stamped by the 0142 trigger.
-- 4. `cloud_worker_grants`: who may dispatch to which provider. No row = no dispatch (default deny).
-- 5. `cloud_worker_dispatches`: one governed dispatch. The repository, base branch and branch prefix are an "as
--    dispatched" snapshot (the scope the provider was told), and `poll_deadline_at` the deadline as dispatched; both
--    are the deliberate 3NF exceptions commented in schema.ts. `reason` is a CHECK-constrained snake_case code, never
--    provider text (prose-scrub exclusion). `node_id` names a node inside the run's jsonb graph, so it has no FK.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "cloud_workers_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_worker_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "base_url" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "halted_at" timestamp with time zone,
  "halted_reason" text,
  "halted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "allow_private_ranges" boolean,
  "usd_per_acu" double precision,
  "usd_per_million_tokens" double precision,
  "max_poll_minutes" integer DEFAULT 120 NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_worker_providers_provider_uq" UNIQUE ("provider"),
  CONSTRAINT "cloud_worker_providers_provider_check" CHECK ("provider" IN ('cursor', 'devin', 'github_copilot', 'openai_codex')),
  CONSTRAINT "cloud_worker_providers_base_url_check" CHECK (char_length("base_url") <= 2048 AND "base_url" ~ '^https?://'),
  CONSTRAINT "cloud_worker_providers_halt_check" CHECK (("halted_at" IS NULL) = ("halted_reason" IS NULL)),
  CONSTRAINT "cloud_worker_providers_halted_reason_check" CHECK ("halted_reason" IS NULL OR char_length("halted_reason") BETWEEN 1 AND 500),
  CONSTRAINT "cloud_worker_providers_usd_per_acu_check" CHECK ("usd_per_acu" IS NULL OR ("usd_per_acu" > 0 AND "usd_per_acu" <= 1000)),
  CONSTRAINT "cloud_worker_providers_usd_per_mtok_check" CHECK ("usd_per_million_tokens" IS NULL OR ("usd_per_million_tokens" > 0 AND "usd_per_million_tokens" <= 10000)),
  CONSTRAINT "cloud_worker_providers_max_poll_check" CHECK ("max_poll_minutes" BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_worker_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "cloud_worker_providers"("id") ON DELETE CASCADE,
  "secret_ciphertext" text NOT NULL,
  "secret_last4" text NOT NULL,
  "set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "secret_set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_worker_credentials_provider_uq" UNIQUE ("provider_id"),
  CONSTRAINT "cloud_worker_credentials_last4_check" CHECK (char_length("secret_last4") = 4)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS "cloud_worker_credentials_secret_set_trg" ON "cloud_worker_credentials";
--> statement-breakpoint
CREATE TRIGGER "cloud_worker_credentials_secret_set_trg" BEFORE INSERT OR UPDATE ON "cloud_worker_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_stamp_secret_set"('secret_ciphertext', 'secret_set_at');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_worker_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "cloud_worker_providers"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_worker_grants_uq" UNIQUE ("provider_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_worker_grants_user_idx" ON "cloud_worker_grants" ("user_id", "provider_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_worker_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "cloud_worker_providers"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "workflow_instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "orchestration_runs"("id") ON DELETE SET NULL,
  "node_id" text,
  "repo_host" text NOT NULL,
  "repo_owner" text NOT NULL,
  "repo_name" text NOT NULL,
  "base_branch" text NOT NULL,
  "branch_prefix" text NOT NULL,
  "external_id" text,
  "external_run_id" text,
  "state" text DEFAULT 'queued' NOT NULL,
  "reason" text,
  "reserved_usd" double precision NOT NULL,
  "cost_usd" double precision,
  "usage_event_id" uuid REFERENCES "usage_events"("id") ON DELETE SET NULL,
  "pr_url" text,
  "poll_deadline_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_worker_dispatches_state_check" CHECK ("state" IN ('queued', 'launching', 'running', 'needs_input', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT "cloud_worker_dispatches_reason_check" CHECK ("reason" IS NULL OR "reason" ~ '^[a-z][a-z_]{0,63}$'),
  CONSTRAINT "cloud_worker_dispatches_node_check" CHECK ("node_id" IS NULL OR char_length("node_id") BETWEEN 1 AND 128),
  CONSTRAINT "cloud_worker_dispatches_repo_check" CHECK (char_length("repo_host") BETWEEN 1 AND 253 AND char_length("repo_owner") BETWEEN 1 AND 39 AND char_length("repo_name") BETWEEN 1 AND 100),
  CONSTRAINT "cloud_worker_dispatches_branch_check" CHECK (char_length("base_branch") BETWEEN 1 AND 200 AND char_length("branch_prefix") BETWEEN 2 AND 200),
  CONSTRAINT "cloud_worker_dispatches_external_check" CHECK (("external_id" IS NULL OR "external_id" ~ '^[A-Za-z0-9_-]{1,128}$') AND ("external_run_id" IS NULL OR "external_run_id" ~ '^[A-Za-z0-9_-]{1,128}$')),
  CONSTRAINT "cloud_worker_dispatches_reserved_check" CHECK ("reserved_usd" > 0 AND "reserved_usd" <= 10000),
  CONSTRAINT "cloud_worker_dispatches_cost_check" CHECK ("cost_usd" IS NULL OR ("cost_usd" >= 0 AND "cost_usd" <= "reserved_usd")),
  CONSTRAINT "cloud_worker_dispatches_pr_url_check" CHECK ("pr_url" IS NULL OR (char_length("pr_url") <= 2048 AND "pr_url" ~ '^https://'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_worker_dispatches_provider_state_idx" ON "cloud_worker_dispatches" ("provider_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_worker_dispatches_instance_idx" ON "cloud_worker_dispatches" ("workflow_instance_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_worker_dispatches_user_idx" ON "cloud_worker_dispatches" ("user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_worker_dispatches_external_uq" ON "cloud_worker_dispatches" ("provider_id", "external_id") WHERE "external_id" IS NOT NULL;
