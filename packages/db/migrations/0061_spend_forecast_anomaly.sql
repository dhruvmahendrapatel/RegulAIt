-- Migration 0061 (ADR-0049) — COST FORECASTING and SPEND-ANOMALY DETECTION on
-- top of the MEASURED usage ledger.
--
-- THE CONSTRAINT THAT SHAPES EVERY LINE BELOW
--
--   Nothing here stores a rollup of spend. `usage_events` (ADR-0024) stays the
--   single source of truth for every dollar; each table below stores either a
--   POLICY (what to look for), a DECIDED FUTURE FACT (a scheduled change), or
--   an OBSERVATION ARTIFACT (a forecast that was computed, an anomaly that was
--   flagged) — never a number another surface could disagree with. Regenerating
--   a forecast recomputes from the ledger, exactly as ADR-0047's report_runs do.
--
-- WHAT EACH PIECE EXISTS FOR
--
--  1. `spend_monitor_policies` — the ADMIN DIAL, per ADR-0021's conventions:
--     one row per project plus at most one ORG-WIDE DEFAULT (project_id NULL).
--     `enabled` defaults FALSE, matching ADR-0049 §3's "OFF by default,
--     admin-enabled" posture: a deployment that never turns this on gets
--     byte-identical behaviour to before this migration. `action` defaults to
--     'alert' — §5's alert-not-block bias, in the DDL rather than in prose.
--
--  2. `spend_scheduled_changes` — §1's scheduled-change adjustment. A DECIDED
--     future delta (a newly granted expensive agent, a ceiling change landing
--     mid-period), signed, with a mandatory reason. The forecast adds these on
--     top of the extrapolation; nothing else is ever anticipated. A CHECK
--     forbids an empty reason, because an unexplained adjustment to a budget
--     forecast is exactly the thing finance cannot audit.
--
--  3. `spend_anomalies` — the APPEND-ONLY flag ledger. Every row carries the
--     SIGNAL, the METHOD, the BASELINE it was measured against, the THRESHOLD,
--     the SCORE and the WINDOW, so a flag is re-derivable by hand months later
--     (§5: "no unexplained risk score"). `approval_id` is how a flag that
--     escalated points at its item on the ONE Approvals Queue — there is no
--     second inbox, and this column is the proof of that rather than a
--     parallel status machine. Status moves open -> acknowledged/dismissed and
--     the decision REASON is mandatory for both.
--
--  4. `spend_forecast_runs` — the forecast ARTIFACT, mirroring ADR-0047's
--     `report_runs` exactly: what was asked, what the caller was ENTITLED to
--     see (`effective_project_ids`), which method ran, and the payload. It is
--     never read back as an input to another computation. Critically
--     `projected_spend_usd` is NULLABLE and `sufficient` is a real column: an
--     insufficient-data answer is STORED AS SUCH, so the history cannot later
--     be mined for a number that was never claimed.
--
-- WHAT IS DELIBERATELY ABSENT
--
--   A scheduler. There is no in-process scheduler in this codebase (ADRs
--   0044/0045/0046/0047 all landed the same way). `last_evaluated_at` below is
--   the honest tell: it stays NULL until an operator or an external cron drives
--   POST /v1/spend/anomalies/evaluate. Nothing fires on a timer, and the
--   endpoint's own response says so.

-- --------------------------------------------------------------------------
-- 1. The policy (admin dial; OFF by default)
-- --------------------------------------------------------------------------

CREATE TABLE "spend_monitor_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- NULL = the ORG-WIDE DEFAULT. A project-scoped row overrides it.
  "project_id" uuid,
  "enabled" boolean DEFAULT false NOT NULL,
  "sensitivity" text DEFAULT 'medium' NOT NULL,
  "baseline_days" integer DEFAULT 30 NOT NULL,
  -- ADR-0049 §5: alert-not-block is the DEFAULT, expressed here.
  "action" text DEFAULT 'alert' NOT NULL,
  -- NULL = evaluate every signal in the vocabulary
  "signals" jsonb,
  "active_hour_start" integer,
  "active_hour_end" integer,
  -- the honest tell that nothing fires on a timer
  "last_evaluated_at" timestamp with time zone,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spend_monitor_policies_sensitivity_check"
    CHECK ("sensitivity" IN ('low','medium','high')),
  CONSTRAINT "spend_monitor_policies_action_check"
    CHECK ("action" IN ('alert','require_approval')),
  CONSTRAINT "spend_monitor_policies_baseline_days_check"
    CHECK ("baseline_days" BETWEEN 7 AND 365),
  CONSTRAINT "spend_monitor_policies_hours_check" CHECK (
    ("active_hour_start" IS NULL AND "active_hour_end" IS NULL)
    OR ("active_hour_start" BETWEEN 0 AND 23 AND "active_hour_end" BETWEEN 0 AND 23)
  )
);
--> statement-breakpoint

ALTER TABLE "spend_monitor_policies" ADD CONSTRAINT "spend_monitor_policies_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spend_monitor_policies" ADD CONSTRAINT "spend_monitor_policies_updated_by_user_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- at most ONE policy per project...
CREATE UNIQUE INDEX "spend_monitor_policies_project_uq"
  ON "spend_monitor_policies" USING btree ("project_id") WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
-- ...and at most ONE org-wide default. A partial unique index on a constant is
-- how a NULL-keyed singleton is expressed without a sentinel uuid.
CREATE UNIQUE INDEX "spend_monitor_policies_org_default_uq"
  ON "spend_monitor_policies" USING btree (("project_id" IS NULL)) WHERE "project_id" IS NULL;
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 2. Decided future changes (§1's scheduled-change adjustment)
-- --------------------------------------------------------------------------

CREATE TABLE "spend_scheduled_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  -- SIGNED on purpose: a decommissioned expensive agent is negative, and a
  -- forecast adjustment that could only ever go up would be its own dishonesty.
  "delta_usd" double precision NOT NULL,
  "effective_at" timestamp with time zone NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spend_scheduled_changes_reason_check" CHECK (length("reason") > 0)
);
--> statement-breakpoint

ALTER TABLE "spend_scheduled_changes" ADD CONSTRAINT "spend_scheduled_changes_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spend_scheduled_changes" ADD CONSTRAINT "spend_scheduled_changes_created_by_user_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "spend_scheduled_changes_project_effective_idx"
  ON "spend_scheduled_changes" USING btree ("project_id","effective_at");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 3. The anomaly flag ledger (append-only; every flag re-derivable by hand)
-- --------------------------------------------------------------------------

CREATE TABLE "spend_anomalies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  -- the per-user narrowing of the same signal, when one applies (§2's
  -- "per-project AND per-user baseline"). NULL = a project-level flag.
  "subject_user_id" uuid,
  "signal" text NOT NULL,
  "method" text NOT NULL,
  -- THE EVIDENCE. Every one of these is required to re-derive the flag.
  "observed" double precision NOT NULL,
  "baseline_median" double precision,
  "baseline_mad" double precision,
  "baseline_samples" integer NOT NULL,
  "score" double precision,
  "threshold" double precision,
  "absolute_floor" double precision NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  -- the full sentence a human reads; never a bare number
  "explanation" text NOT NULL,
  "action" text NOT NULL,
  -- how a flag that escalated points at its item on the ONE queue. This column
  -- existing (rather than a parallel status machine) IS the "no new inbox"
  -- guarantee of §4.
  "approval_id" uuid,
  "status" text DEFAULT 'open' NOT NULL,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" text,
  "detail" jsonb,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spend_anomalies_signal_check" CHECK ("signal" IN (
    'spend_spike','token_volume','unusual_model','off_hours','egress_volume'
  )),
  CONSTRAINT "spend_anomalies_method_check" CHECK ("method" IN (
    'mad_z','pct_over_baseline','share_of_history'
  )),
  CONSTRAINT "spend_anomalies_status_check" CHECK ("status" IN ('open','acknowledged','dismissed')),
  CONSTRAINT "spend_anomalies_action_check" CHECK ("action" IN ('alert','require_approval')),
  -- a decided flag MUST say why. Dismissing a spend anomaly silently is
  -- precisely the audit hole this ledger exists to close.
  CONSTRAINT "spend_anomalies_decision_reason_check" CHECK (
    "status" = 'open' OR ("decision_reason" IS NOT NULL AND length("decision_reason") > 0)
  )
);
--> statement-breakpoint

ALTER TABLE "spend_anomalies" ADD CONSTRAINT "spend_anomalies_project_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "spend_anomalies" ADD CONSTRAINT "spend_anomalies_approval_id_fk"
  FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "spend_anomalies_project_detected_idx"
  ON "spend_anomalies" USING btree ("project_id","detected_at");
--> statement-breakpoint
CREATE INDEX "spend_anomalies_status_idx" ON "spend_anomalies" USING btree ("status");
--> statement-breakpoint
-- IDEMPOTENT RE-EVALUATION: the same signal on the same project for the same
-- window is ONE row, however many times an operator drives the sweep. Without
-- this a cron misconfigured to run every minute would manufacture a thousand
-- duplicate "incidents" out of one.
CREATE UNIQUE INDEX "spend_anomalies_window_uq"
  ON "spend_anomalies" USING btree ("project_id","signal","window_start","window_end");
--> statement-breakpoint

-- --------------------------------------------------------------------------
-- 4. The forecast artifact (mirrors ADR-0047's report_runs)
-- --------------------------------------------------------------------------

CREATE TABLE "spend_forecast_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requested_by_user_id" uuid,
  "scope_kind" text NOT NULL,
  "scope_id" uuid,
  -- THE HONEST RECORD OF WHAT THIS FORECAST WAS PERMITTED TO SEE. NULL = the
  -- org-wide set, reachable only by an admin under an org-scoped request —
  -- exactly ADR-0047's `report_runs.effective_project_ids` semantics.
  "effective_project_ids" jsonb,
  "method" text NOT NULL,
  "period" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  -- NULLABLE, and `sufficient` is a real column: an insufficient-data answer is
  -- STORED AS SUCH so the history can never be mined for a number that was
  -- never claimed.
  "sufficient" boolean NOT NULL,
  "projected_spend_usd" double precision,
  "low_usd" double precision,
  "high_usd" double precision,
  "spend_to_date_usd" double precision NOT NULL,
  "payload" jsonb NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spend_forecast_runs_method_check" CHECK ("method" IN ('run_rate','ewma')),
  CONSTRAINT "spend_forecast_runs_scope_kind_check"
    CHECK ("scope_kind" IN ('org','initiative','team','project')),
  -- the invariant the whole ADR turns on, enforced by the DATABASE: an
  -- insufficient forecast carries NO projected number.
  CONSTRAINT "spend_forecast_runs_sufficiency_check" CHECK (
    ("sufficient" = true AND "projected_spend_usd" IS NOT NULL)
    OR ("sufficient" = false AND "projected_spend_usd" IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "spend_forecast_runs" ADD CONSTRAINT "spend_forecast_runs_requested_by_user_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "spend_forecast_runs_generated_idx"
  ON "spend_forecast_runs" USING btree ("generated_at");
