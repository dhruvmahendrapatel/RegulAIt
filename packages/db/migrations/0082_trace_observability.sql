-- Migration 0082 (ADR-0070) — TRACE / SPAN OBSERVABILITY.
--
-- A pre-slice grep confirmed the premise: there was NO trace or span model
-- anywhere in this schema, and no OpenTelemetry dependency in any package.
-- What existed was every FACT a trace is made of, scattered across the tables
-- that own them:
--
--   * `orchestration_runs` + the node statuses inside `state` — a DAG.
--   * `usage_events`  — per-call tokens, provider, model, measured cost.
--   * `audit_log`     — hash-chained (ADR-0060), every governance decision,
--                       including every ADR-0066 fallback hop.
--   * guardrail decisions, eval runs, red-team trials, lineage nodes.
--   * `workflow_instances` / stages.
--
-- The gap was never the DATA. It was the SHAPE: nothing in the product said
-- "this call happened INSIDE that node, which happened inside that run, and
-- the reason there is no model call under this branch is that pillar 1 said
-- no." A DAG plus a flat ledger is not a causal tree, and you cannot derive
-- one after the fact without inventing parentage that nobody recorded.
--
-- SO THIS MIGRATION ADDS THE SHAPE AND (ALMOST) NO FACTS.
--
--   `trace_spans` REFERENCES the rows above rather than copying them:
--   `usage_event_id`, `audit_log_id`, `run_id`, `node_id`, `agent_id`.
--   The one deliberate exception is stated here and defended in the ADR:
--   `provider`, `model`, `input_tokens`, `output_tokens` and `cost_usd` are
--   DENORMALISED onto the span. A trace tree over a large run renders every
--   span's cost at once; joining each of them back to `usage_events` is the
--   textbook N+1, and a tree view that took N round trips would not be usable
--   on the runs that most need one. The copy is written FROM the very row it
--   references, in the same call, and `tracing.test.ts` asserts equality
--   against `usage_events` rather than trusting it.
--
-- WHAT A SPAN IS ALLOWED TO SAY, AND WHAT IT IS NOT
--
--   `status` is one of 'ok' | 'error' | 'denied' | 'running'. 'denied' is not
--   a flavour of error: it is the whole point. A governance refusal must be a
--   PRESENT span carrying its reason, because "why did nothing happen" is the
--   single most valuable question a governance product's trace can answer, and
--   an absent span answers it with silence.
--
--   `input_preview` / `output_preview` carry the most sensitive data in the
--   system. They are written through the SAME ADR-0042 / §8.4 posture
--   `eval_results.output_text` and the ADR-0065 training ingest use — the text
--   that already survived the dispatch path's PII and guardrail adjudication,
--   truncated, with the existing withheld marker in place of anything a block
--   acted on. No fourth posture was invented. `content_withheld` records that
--   a marker is what is stored, so a reader is never left guessing whether a
--   short preview is short because the answer was short.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   No retention column and no retention job of its own. Trace retention rides
--   the §8.3 compliance cascade's `audit_retention_days` floor through the
--   EXISTING `runAuditPruneOnce` sweep. A separate knob would let an operator
--   keep prompts for a year under a framework that says 90 days, which is
--   exactly the drift a cascade exists to prevent.
--
--   No exporter queue, no spooling table, no retry ledger. Export is a pull
--   the operator triggers (or the existing ADR-0064 scheduler triggers) over a
--   bounded window; see the ADR for why an outbound queue was rejected on an
--   air-gapped-primary product.
--
--   No FK from `trace_spans.usage_event_id` to `usage_events`. Same discipline
--   as every other attribution column on that ledger: a pruned or archived
--   ledger row must not take the trace with it, and a trace must never be the
--   thing that blocks a retention delete.

-- ---------------------------------------------------------------------------
-- 1. TRACES — one causal tree. `session_id` is the thread grouping: a
--    multi-turn conversation or a long-running workflow is many traces that
--    read as one thing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- thread grouping. NULL = a one-shot trace that belongs to no session.
  "session_id" text,
  -- what KIND of thing this trace is the tree of, and the id of that thing in
  -- its own table. FK-free on purpose (see header).
  "kind" text NOT NULL,
  "root_ref_id" text,
  "name" text NOT NULL,
  "user_id" uuid NOT NULL,
  "project_id" uuid,
  "status" text DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "duration_ms" integer,
  -- rollups, maintained as spans land. Present so the LIST view is one query
  -- rather than a fan-out over every span of every trace on the page.
  "span_count" integer DEFAULT 0 NOT NULL,
  "denied_span_count" integer DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "traces_status_check"
    CHECK ("status" IN ('running', 'ok', 'error', 'denied')),
  CONSTRAINT "traces_kind_check"
    CHECK ("kind" IN ('dispatch', 'run', 'workflow', 'conversation', 'tool', 'eval'))
);

CREATE INDEX IF NOT EXISTS "traces_user_started_idx" ON "traces" ("user_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "traces_session_idx" ON "traces" ("session_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "traces_project_idx" ON "traces" ("project_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "traces_root_idx" ON "traces" ("kind", "root_ref_id");
CREATE INDEX IF NOT EXISTS "traces_started_idx" ON "traces" ("started_at");

-- ---------------------------------------------------------------------------
-- 2. TRACE SPANS — the tree. `parent_span_id` is a self-reference; a NULL
--    parent is a root. ON DELETE CASCADE from the trace means one retention
--    delete removes a whole tree and can never leave orphan spans behind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "trace_spans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trace_id" uuid NOT NULL REFERENCES "traces"("id") ON DELETE CASCADE,
  "parent_span_id" uuid REFERENCES "trace_spans"("id") ON DELETE CASCADE,
  -- DETERMINISTIC SIBLING ORDER. Timestamps collide at millisecond resolution
  -- on a fast in-process path, and a tree whose children reorder between two
  -- reads is not a trace. Assigned monotonically per trace as spans are
  -- recorded; every read orders by (parent, seq).
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  -- WHY. On a 'denied' span this is the governance reason, verbatim from the
  -- decision that produced it. A deny with no reason is the failure this
  -- column exists to make impossible.
  "status_reason" text,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "duration_ms" integer,

  -- REFERENCES (not copies). FK-free for the same reason usage_events'
  -- attribution columns are.
  "usage_event_id" uuid,
  "audit_log_id" uuid,
  "run_id" uuid,
  "node_id" text,
  "agent_id" uuid,
  "mcp_server_id" uuid,
  "connector_id" uuid,

  -- DENORMALISED, and only this much (see header). Written from the referenced
  -- usage_events row in the same call that inserted it.
  "provider" text,
  "model" text,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_usd" double precision,

  -- CONTENT, through the existing ADR-0042 / §8.4 posture. Never a fourth one.
  "input_preview" text,
  "output_preview" text,
  "content_withheld" boolean DEFAULT false NOT NULL,

  "attributes" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "trace_spans_status_check"
    CHECK ("status" IN ('running', 'ok', 'error', 'denied')),
  CONSTRAINT "trace_spans_kind_check"
    CHECK ("kind" IN (
      'run', 'run_node', 'llm', 'fallback_hop', 'tool', 'connector',
      'guardrail', 'policy', 'workflow_stage', 'eval_case'
    )),
  -- A span cannot be its own parent. Cheap, and it makes the one cycle a
  -- single-row bug could create structurally impossible.
  CONSTRAINT "trace_spans_not_self_parent" CHECK ("parent_span_id" IS NULL OR "parent_span_id" <> "id")
);

CREATE INDEX IF NOT EXISTS "trace_spans_trace_idx" ON "trace_spans" ("trace_id", "seq");
CREATE INDEX IF NOT EXISTS "trace_spans_parent_idx" ON "trace_spans" ("parent_span_id");
CREATE INDEX IF NOT EXISTS "trace_spans_usage_idx" ON "trace_spans" ("usage_event_id");
CREATE INDEX IF NOT EXISTS "trace_spans_run_idx" ON "trace_spans" ("run_id");

-- ---------------------------------------------------------------------------
-- 3. ORG SETTINGS — the tracing dials. Three, and no more.
--
--    `tracing_enabled` is the master switch (ADR-0034's
--    `customModelProvidersEnabled` precedent). It defaults ON because a
--    governance product whose trace is off by default answers "why did nothing
--    happen" with "we did not record it".
--
--    `tracing_capture_content` may only ever NARROW: turning it off keeps the
--    tree, the timings, the costs and every deny reason, and stops storing
--    prompts and outputs at all. Defaults ON — an inspectable tree with no
--    tool I/O is not the feature that was asked for — and an install that
--    wants metadata-only flips one switch rather than trusting a retention job.
--
--    `tracing_otlp_*` is the EXPORT, and it is off unless somebody types an
--    endpoint. ADR-0041 makes air-gapped the primary motion, so there is no
--    default endpoint anywhere in this schema or in the code: an install with
--    nothing configured makes no outbound connection and uses its traces
--    locally. When configured, the endpoint is an admin-typed URL and goes
--    through the SAME ADR-0034/0062 egress guard `mcp_servers.url` does.
-- ---------------------------------------------------------------------------
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_capture_content" boolean DEFAULT true NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_preview_max_chars" integer DEFAULT 4000 NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_otlp_endpoint" text;
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_otlp_headers" jsonb;
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "tracing_otlp_service_name" text DEFAULT 'regulait-gateway' NOT NULL;

ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_tracing_preview_max_chars_check";
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_tracing_preview_max_chars_check"
  CHECK ("tracing_preview_max_chars" >= 0 AND "tracing_preview_max_chars" <= 20000);
