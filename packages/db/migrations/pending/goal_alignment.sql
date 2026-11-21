-- ADR-0359 §7 (lane E40): goal alignment (OWASP ASI01), shadow mode. Each agent tool call in the audit chain is
-- compared with the agent's declared purpose; a call that does not fit becomes a finding, never a block.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- - `agent_purpose_declarations`: one declared purpose per workload identity (ADR-0188); writes, destructive writes
--   and open-world reach are off unless declared (ADR-0180).
-- - `agent_purpose_tools`: the tools a purpose needs (join table; `ref_id` FK-free across two target tables).
-- - `goal_alignment_state`: the sweep's leased cursor over `audit_log.seq` (null until the first pass sets it to the
--   chain head, so history is never judged against a purpose declared later).
-- - `goal_alignment_findings`: point-in-time snapshots, one per day, identity, primary divergence and target.
-- - The deployment is single-tenant (ADR-0015), so like the other register tables there is no tenant column for RLS.
-- No new functions or refusal triggers.

CREATE TABLE IF NOT EXISTS "agent_purpose_declarations" (
  "identity_id" uuid PRIMARY KEY NOT NULL,
  "statement" text NOT NULL,
  "allow_write" boolean DEFAULT false NOT NULL,
  "allow_destructive" boolean DEFAULT false NOT NULL,
  "allow_open_world" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "declared_by" uuid,
  "declared_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_purpose_declarations_statement_check" CHECK (char_length(btrim("statement")) BETWEEN 1 AND 500 AND "statement" !~ '[<>[:cntrl:]]'),
  CONSTRAINT "agent_purpose_declarations_destructive_check" CHECK (NOT "allow_destructive" OR "allow_write")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_purpose_declarations" ADD CONSTRAINT "agent_purpose_declarations_identity_id_workload_identities_id_fk"
    FOREIGN KEY ("identity_id") REFERENCES "public"."workload_identities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_purpose_declarations" ADD CONSTRAINT "agent_purpose_declarations_declared_by_users_id_fk"
    FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_purpose_tools" (
  "identity_id" uuid NOT NULL,
  "target_kind" text NOT NULL,
  "ref_id" uuid NOT NULL,
  CONSTRAINT "agent_purpose_tools_pk" PRIMARY KEY ("identity_id", "target_kind", "ref_id"),
  CONSTRAINT "agent_purpose_tools_kind_check" CHECK ("target_kind" IN ('mcp_tool', 'connector'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_purpose_tools" ADD CONSTRAINT "agent_purpose_tools_identity_id_agent_purpose_declarations_identity_id_fk"
    FOREIGN KEY ("identity_id") REFERENCES "public"."agent_purpose_declarations"("identity_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goal_alignment_state" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "cursor_seq" bigint,
  "lease_token" uuid,
  "lease_until" timestamp with time zone,
  "last_sweep_at" timestamp with time zone,
  CONSTRAINT "goal_alignment_state_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goal_alignment_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "day" date NOT NULL,
  "identity_id" uuid NOT NULL,
  "divergence" text NOT NULL,
  "divergences" text[] NOT NULL,
  "suggested_response" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_key" text NOT NULL,
  "target_name" text NOT NULL,
  "observed_write" boolean NOT NULL,
  "observed_destructive" boolean NOT NULL,
  "observed_open_world" boolean NOT NULL,
  "declared" jsonb,
  "call_count" integer DEFAULT 1 NOT NULL,
  "first_seq" bigint NOT NULL,
  "last_seq" bigint NOT NULL,
  "explanation" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "status_changed_by" uuid,
  "status_changed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "goal_alignment_findings_divergence_check" CHECK ("divergence" IN ('no_declared_purpose', 'tool_not_declared', 'write_not_declared', 'open_world_not_declared', 'destructive_not_declared')),
  CONSTRAINT "goal_alignment_findings_response_check" CHECK ("suggested_response" IN ('advise', 'correct', 'block_session')),
  CONSTRAINT "goal_alignment_findings_kind_check" CHECK ("target_kind" IN ('mcp_tool', 'connector')),
  CONSTRAINT "goal_alignment_findings_status_check" CHECK ("status" IN ('open', 'acknowledged', 'dismissed')),
  CONSTRAINT "goal_alignment_findings_text_check" CHECK (char_length("target_name") <= 300 AND char_length("target_key") <= 300 AND char_length("explanation") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "goal_alignment_findings" ADD CONSTRAINT "goal_alignment_findings_status_changed_by_users_id_fk"
    FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goal_alignment_findings_day_uq" ON "goal_alignment_findings" USING btree ("day", "identity_id", "divergence", "target_kind", "target_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_alignment_findings_status_created_idx" ON "goal_alignment_findings" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_alignment_findings_identity_idx" ON "goal_alignment_findings" USING btree ("identity_id", "day");
