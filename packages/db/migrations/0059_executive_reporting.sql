-- Migration 0059 (ADR-0047) — EXECUTIVE & COMPLIANCE REPORTING: report
-- definitions, schedule definitions, and an immutable run ledger.
--
-- THE CONSTRAINT THAT SHAPES EVERY LINE BELOW
--
--   A report is a READ-ONLY PROJECTION. It adds no source of truth. Every
--   number a report shows is computed, at generation time, from the ledgers
--   that already exist — `usage_events` (pillar 5 spend), `audit_log`
--   (governance decisions), `approvals` (approval throughput/SLA) — with a
--   WHERE clause built from the CALLER'S OWN entitlement. There is deliberately
--   NO rollup/summary table here: a denormalized copy of spend would drift from
--   the ledger, and a board report that disagrees with the cost dashboard is
--   worse than no board report.
--
--   `report_runs.payload` is the one thing that looks like a copy and is not:
--   it is the ARTIFACT a generation produced — the immutable, timestamped
--   document an auditor was handed. It is never read back as a source for
--   another computation, and re-running the same definition over the same
--   period recomputes from the ledgers rather than reading it. That is what
--   makes it an artifact rather than a cache.
--
-- WHAT EACH PIECE EXISTS FOR
--
--  1. `report_definitions` — WHAT to compute and WHO may run it. `kind`,
--     `scope_kind`/`scope_id` (org | initiative | team | project), `period`,
--     `sections`, `format`, and — the load-bearing one — `entitlement_scope`:
--     the grant a caller must hold for this definition to produce anything.
--     `entitlement_scope='org'` is admin-only, enforced in code AND asserted by
--     a test, because an org-wide rollup is precisely the shape that leaks one
--     team's numbers to another.
--
--  2. `report_schedules` — the schedule DEFINITION. There is NO in-process
--     scheduler in this codebase (ADR-0046 established this, ADR-0045's expiry
--     sweep is the same shape): these rows describe a cadence, and an operator
--     or an external cron drives `POST /v1/reports/schedules/run-due`. Nothing
--     fires on its own. `last_generated_at` is written by that sweep, so a
--     deployment that never calls it is VISIBLY never generating rather than
--     silently so.
--
--  3. `report_runs` — one immutable row per generation: the definition, the
--     resolved period, the EFFECTIVE scope the generator was actually allowed
--     to query (not the requested one), the caller, the format, and the
--     payload. `effective_project_ids` is the honest record of "what this
--     report was permitted to see", so an over-disclosure is visible in the
--     ledger rather than only in the document.

-- --------------------------------------------------------------------------
-- Report definitions
-- --------------------------------------------------------------------------

CREATE TABLE "report_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  -- WHAT the report covers. scope_id is NULL exactly when scope_kind='org'.
  "scope_kind" text NOT NULL DEFAULT 'org',
  "scope_id" uuid,
  "period" text NOT NULL DEFAULT 'current_month',
  -- which sections to compute; NULL/absent = every section the kind defines
  "sections" jsonb,
  "format" text NOT NULL DEFAULT 'json',
  -- THE GRANT REQUIRED TO RUN OR RECEIVE THIS. 'org' is admin-only.
  "entitlement_scope" text NOT NULL DEFAULT 'project',
  "description" text,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_definitions_kind_check"
    CHECK ("kind" IN ('exec_summary','team_scorecard','compliance')),
  CONSTRAINT "report_definitions_scope_kind_check"
    CHECK ("scope_kind" IN ('org','initiative','team','project')),
  CONSTRAINT "report_definitions_period_check"
    CHECK ("period" IN ('current_month','last_month','current_quarter','last_quarter','last_30_days')),
  CONSTRAINT "report_definitions_format_check"
    CHECK ("format" IN ('csv','json','both')),
  CONSTRAINT "report_definitions_entitlement_scope_check"
    CHECK ("entitlement_scope" IN ('org','team','project')),
  -- an org-scoped report names no single object; every other scope MUST name
  -- one, or "scope" would be decorative
  CONSTRAINT "report_definitions_scope_id_check" CHECK (
    ("scope_kind" = 'org' AND "scope_id" IS NULL)
    OR ("scope_kind" <> 'org' AND "scope_id" IS NOT NULL)
  ),
  -- a team/project-scoped definition cannot carry an ORG entitlement: that
  -- combination reads as "narrow report, org-wide grant", which is the
  -- privilege-creep shape this table exists to prevent
  CONSTRAINT "report_definitions_entitlement_consistency_check" CHECK (
    "entitlement_scope" <> 'org' OR "scope_kind" = 'org'
  )
);
--> statement-breakpoint

ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "report_definitions_name_uq" ON "report_definitions" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "report_definitions_kind_idx" ON "report_definitions" USING btree ("kind");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Schedule definitions — DEFINITIONS ONLY. Nothing here fires on a timer.
-- --------------------------------------------------------------------------

CREATE TABLE "report_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "definition_id" uuid NOT NULL,
  "cadence" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  -- recipients are recorded so the entitlement check has something to check
  -- AGAINST; delivery transport is deliberately not built here (see the ADR
  -- amendment) rather than half-built and claimed.
  "recipient_user_ids" jsonb,
  "last_generated_at" timestamp with time zone,
  "last_run_id" uuid,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_schedules_cadence_check"
    CHECK ("cadence" IN ('daily','weekly','monthly','quarterly'))
);
--> statement-breakpoint

ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_definition_id_fk"
  FOREIGN KEY ("definition_id") REFERENCES "public"."report_definitions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "report_schedules_definition_idx" ON "report_schedules" USING btree ("definition_id");
--> statement-breakpoint
CREATE INDEX "report_schedules_enabled_idx" ON "report_schedules" USING btree ("enabled");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The run ledger — one immutable row per generation
-- --------------------------------------------------------------------------

CREATE TABLE "report_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "definition_id" uuid NOT NULL,
  "schedule_id" uuid,
  -- who asked. NULL only for the bootstrap-token/operator sweep path.
  "requested_by_user_id" uuid,
  "trigger" text NOT NULL DEFAULT 'manual',
  "period" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  -- THE ENTITLEMENT RECORD. `entitlement_scope` is copied from the definition
  -- at generation time so a later edit to the definition cannot retroactively
  -- widen who may read an already-generated artifact.
  "entitlement_scope" text NOT NULL,
  -- the EXACT project ids the generator was permitted to query. NULL means
  -- "org-wide, including unattributed spend" and is only ever written for an
  -- admin/org-scoped generation.
  "effective_project_ids" jsonb,
  "format" text NOT NULL DEFAULT 'json',
  "payload" jsonb NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_runs_trigger_check"
    CHECK ("trigger" IN ('manual','scheduled')),
  CONSTRAINT "report_runs_entitlement_scope_check"
    CHECK ("entitlement_scope" IN ('org','team','project')),
  CONSTRAINT "report_runs_format_check"
    CHECK ("format" IN ('csv','json','both')),
  CONSTRAINT "report_runs_period_check"
    CHECK ("period_end" > "period_start")
);
--> statement-breakpoint

ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_definition_id_fk"
  FOREIGN KEY ("definition_id") REFERENCES "public"."report_definitions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_id_fk"
  FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "report_runs_definition_at_idx" ON "report_runs" USING btree ("definition_id","generated_at");
--> statement-breakpoint
CREATE INDEX "report_runs_requested_by_idx" ON "report_runs" USING btree ("requested_by_user_id");
--> statement-breakpoint

ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_last_run_id_fk"
  FOREIGN KEY ("last_run_id") REFERENCES "public"."report_runs"("id") ON DELETE set null ON UPDATE no action;
