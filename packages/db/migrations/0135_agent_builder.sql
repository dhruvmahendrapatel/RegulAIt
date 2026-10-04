-- ADR-0172 — the agent builder.
--
-- A builder agent is a CONFIGURATION, not an identity with authority of its
-- own: it names one governed model binding from the agent registry, a toolbox
-- of connectors / MCP tools the editor held grants for, sub-agents, skills,
-- memory, schedules and channels. Every run dispatches through the existing
-- governed core AS THE PERSON USING IT (a schedule runs as the agent's owner),
-- so nothing stored here can widen what a human may reach.
--
--   builder_agents            the agent (soft-deleted via archived_at)
--   builder_agent_shares      named people an agent is shared with
--   builder_agent_tools       toolbox entries (connector id | mcp_tools id)
--   builder_agent_subagents   parent -> child edges (cycles refused in the API)
--   builder_skills            the shared SKILL.md library
--   builder_agent_skills      which skills an agent carries
--   builder_agent_memory      append-only memory items
--   builder_agent_schedules   cadence + prompt; next_run_at is the CAS claim
--   builder_agent_channels    binding to an existing ChatOps connection
--   builder_threads           conversations (chat / schedule / channel)
--   builder_messages          messages; agent rows carry the cost the governed
--                             core measured, which the monthly limit sums
CREATE TABLE IF NOT EXISTS "builder_agents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "color" text DEFAULT '#5b6cff' NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "sharing" text DEFAULT 'private' NOT NULL,
  "model_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "template_id" text,
  "instructions" text DEFAULT '' NOT NULL,
  "connection_format" text NOT NULL,
  "computer_use" boolean DEFAULT false NOT NULL,
  "monthly_limit_usd" double precision,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agents_sharing_ck" CHECK ("sharing" IN ('private', 'workspace', 'people')),
  CONSTRAINT "builder_agents_connection_format_ck" CHECK ("connection_format" IN ('shared', 'per_user')),
  CONSTRAINT "builder_agents_limit_ck"
    CHECK ("monthly_limit_usd" IS NULL OR ("monthly_limit_usd" >= 0.01 AND "monthly_limit_usd" <= 100000))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agents_owner_idx" ON "builder_agents" ("owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_shares" (
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_shares_agent_id_user_id_pk" PRIMARY KEY ("agent_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_shares_user_idx" ON "builder_agent_shares" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_tools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "ref_id" uuid NOT NULL,
  "requires_approval" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_tools_kind_ck" CHECK ("kind" IN ('connector', 'mcp_tool'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_agent_tools_uq" ON "builder_agent_tools" ("agent_id", "kind", "ref_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_subagents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "child_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_subagents_not_self_ck" CHECK ("parent_id" <> "child_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_agent_subagents_uq" ON "builder_agent_subagents" ("parent_id", "child_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_subagents_child_idx" ON "builder_agent_subagents" ("child_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "visibility" text DEFAULT 'private' NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_skills_visibility_ck" CHECK ("visibility" IN ('private', 'workspace'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_skills_owner_idx" ON "builder_skills" ("owner_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_skills" (
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "skill_id" uuid NOT NULL REFERENCES "builder_skills"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_skills_agent_id_skill_id_pk" PRIMARY KEY ("agent_id", "skill_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_skills_skill_idx" ON "builder_agent_skills" ("skill_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "content" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_memory_agent_idx" ON "builder_agent_memory" ("agent_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "cadence" text NOT NULL,
  "time_utc" text NOT NULL,
  "prompt" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_schedules_cadence_ck" CHECK ("cadence" IN ('hourly', 'daily', 'weekdays', 'weekly')),
  CONSTRAINT "builder_agent_schedules_time_ck" CHECK ("time_utc" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_schedules_agent_idx" ON "builder_agent_schedules" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_schedules_due_idx" ON "builder_agent_schedules" ("enabled", "next_run_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_agent_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "chatops_connection_id" uuid REFERENCES "chatops_connections"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_agent_channels_provider_ck" CHECK ("provider" IN ('slack', 'teams', 'outlook', 'email'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_agent_channels_agent_idx" ON "builder_agent_channels" ("agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "builder_agents"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source" text DEFAULT 'chat' NOT NULL,
  "schedule_id" uuid REFERENCES "builder_agent_schedules"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_threads_status_ck" CHECK ("status" IN ('active', 'needs_attention', 'completed')),
  CONSTRAINT "builder_threads_source_ck" CHECK ("source" IN ('chat', 'schedule', 'channel'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_threads_user_idx" ON "builder_threads" ("user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_threads_agent_idx" ON "builder_threads" ("agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "builder_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "builder_threads"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "model_agent_id" uuid,
  "provider" text,
  "model" text,
  "cost_usd" double precision,
  "latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "builder_messages_role_ck" CHECK ("role" IN ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_messages_thread_idx" ON "builder_messages" ("thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_messages_agent_idx" ON "builder_messages" ("agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_messages_user_idx" ON "builder_messages" ("user_id", "created_at");
