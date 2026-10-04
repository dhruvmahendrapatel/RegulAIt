-- ADR-0173 §1 — governed tool use in builder agents.
--
-- A builder turn is now a bounded loop: the model may ask for tools from the
-- agent's toolbox, and every call runs through the existing governed paths
-- (MCP: executeGovernedToolCall; connectors: executeGovernedConnectorCall) AS
-- THE PERSON THE TURN RUNS AS. Each call is one row here, attached to the
-- agent message of the turn that asked for it. The governed call keeps its own
-- audit row and trace span; this row links them (audit_log_id, trace ids) and
-- carries what the thread shows: the tool, a REDACTED preview of the arguments
-- (credential scrub, plus PII redaction when the project has a PII mode), the
-- argument digest (the same fingerprint the approvals queue binds consent to),
-- the outcome, a truncated result preview (withheld when PII or guardrails
-- withheld the result), the cost and the latency.
--
-- Two pauses, never conflated (status):
--   pending_confirmation  the agent's own "Ask first" flag — the person in the
--                         thread approves or denies the exact call
--   pending_approval      an organisation approval rule / ABAC require_approval —
--                         an approvals-queue row (approval_id) under the
--                         existing binding; deciding it resumes the turn
--
-- builder_threads.pending_turn_ciphertext holds the paused turn's model conversation
-- (including the RAW arguments a resume must replay identically, so the
-- approval digest matches) ENCRYPTED with the data key; it is cleared the
-- moment the turn finishes and is never returned by the API.
CREATE TABLE IF NOT EXISTS "builder_tool_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL REFERENCES "builder_threads"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL REFERENCES "builder_messages"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "turn" integer NOT NULL,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "ref_id" uuid,
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "provider" text,
  "tool_call_id" text,
  "arguments" jsonb,
  "arguments_digest" text NOT NULL,
  "requires_confirmation" boolean DEFAULT false NOT NULL,
  "status" text NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "result_preview" text,
  "result_withheld" boolean DEFAULT false NOT NULL,
  "outcome_code" text,
  "outcome_detail" text,
  "cost_usd" double precision,
  "latency_ms" integer,
  "audit_log_id" uuid,
  "trace_id" uuid,
  "parent_span_id" uuid,
  "decided_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "builder_tool_steps_kind_ck" CHECK ("kind" IN ('mcp_tool', 'connector', 'unknown')),
  CONSTRAINT "builder_tool_steps_status_ck" CHECK ("status" IN ('pending_confirmation', 'pending_approval', 'running', 'done', 'denied', 'refused', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_tool_steps_message_seq_uq" ON "builder_tool_steps" ("message_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_tool_steps_thread_idx" ON "builder_tool_steps" ("thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_tool_steps_agent_idx" ON "builder_tool_steps" ("agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_tool_steps_approval_idx" ON "builder_tool_steps" ("approval_id") WHERE "approval_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_threads" ADD COLUMN IF NOT EXISTS "pending_turn_ciphertext" text;
