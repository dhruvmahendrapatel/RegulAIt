-- ADR-0187 (batch 5) — the sidecar engine contract: engines, runners and their
-- enrolment tokens, engine runs and their normalised items, schedules, model
-- artifacts and artifact scans, the `engine` virtual-key purpose with project
-- pinning, the `engine_scan` model-card evidence kind, and five strict org
-- settings.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785108000000
-- (previous + 1,000,000, CONTRIBUTING_PARALLEL_SESSIONS §4.1).
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180): every engine row is
-- inserted DISABLED, an engine can only be enabled once a self-test passed
-- (CHECK), and every new org setting takes its strict value on the existing
-- row, as on a first load.

-- ===== 1. engines ============================================================
CREATE TABLE "engines" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "version" text NOT NULL,
  "image_digest" text,
  "licence" text NOT NULL,
  "maintainer_count" integer,
  "usage_data_posture" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_verified" text,
  "re_check_by" text,
  "enabled" boolean DEFAULT false NOT NULL,
  "timeout_seconds" integer DEFAULT 1800 NOT NULL,
  "max_budget_usd" double precision DEFAULT 5 NOT NULL,
  "max_concurrent" integer DEFAULT 1 NOT NULL,
  "self_test" jsonb,
  "self_test_passed_at" timestamp with time zone,
  "enabled_at" timestamp with time zone,
  "enabled_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "engines_id_check" CHECK ("id" IN ('promptfoo', 'modelscan', 'garak')),
  CONSTRAINT "engines_kind_check" CHECK ("kind" IN ('redteam', 'eval', 'model_scan')),
  CONSTRAINT "engines_image_digest_check" CHECK ("image_digest" IS NULL OR "image_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "engines_enabled_needs_self_test_check" CHECK (NOT "enabled" OR "self_test_passed_at" IS NOT NULL),
  CONSTRAINT "engines_timeout_check" CHECK ("timeout_seconds" BETWEEN 60 AND 7200),
  CONSTRAINT "engines_budget_check" CHECK ("max_budget_usd" >= 0.01 AND "max_budget_usd" <= 10000),
  CONSTRAINT "engines_concurrency_check" CHECK ("max_concurrent" BETWEEN 1 AND 20)
);
--> statement-breakpoint
-- the three engines this build knows, all OFF; version and digest are re-synced
-- from the shipped manifest by the gateway (no route writes them)
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('promptfoo', 'redteam', '0.123.1', 'MIT'),
  ('modelscan', 'model_scan', '0.8.8', 'Apache-2.0'),
  ('garak', 'redteam', '0.17.0', 'Apache-2.0');
--> statement-breakpoint

-- ===== 2. enrolment tokens and runners =======================================
CREATE TABLE "engine_enrollment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine_id" text NOT NULL REFERENCES "engines"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "label" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "runner_id" uuid,
  CONSTRAINT "engine_enrollment_tokens_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "engine_enrollment_tokens_expiry_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '60 minutes'
  )
);
--> statement-breakpoint
CREATE TABLE "engine_runners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine_id" text NOT NULL REFERENCES "engines"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "enrollment_token_id" uuid REFERENCES "engine_enrollment_tokens"("id") ON DELETE SET NULL,
  "reported_digest" text NOT NULL,
  "reported_version" text NOT NULL,
  "self_test" jsonb NOT NULL,
  "self_test_passed" boolean NOT NULL,
  "self_test_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "registered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoke_reason" text,
  CONSTRAINT "engine_runners_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "engine_runners_digest_check" CHECK ("reported_digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "engine_runners_engine_idx" ON "engine_runners" ("engine_id");
--> statement-breakpoint

-- ===== 3. model artifacts (B5-M fills the upload) ============================
CREATE TABLE "model_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "format" text NOT NULL,
  "filename" text NOT NULL,
  "storage_key" text NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "uploaded_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_artifacts_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_artifacts_size_check" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "model_artifacts_sha256_idx" ON "model_artifacts" ("sha256");
--> statement-breakpoint

-- ===== 4. schedules ==========================================================
CREATE TABLE "engine_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine_id" text NOT NULL REFERENCES "engines"("id") ON DELETE CASCADE,
  "request" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "run_as_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "interval_hours" integer NOT NULL,
  "next_run_at" timestamp with time zone NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_run_id" uuid,
  "last_skip" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engine_schedules_interval_check" CHECK ("interval_hours" BETWEEN 1 AND 720)
);
--> statement-breakpoint
CREATE INDEX "engine_schedules_due_idx" ON "engine_schedules" ("next_run_at") WHERE "enabled";
--> statement-breakpoint

-- ===== 5. engine runs ========================================================
CREATE TABLE "engine_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "engine_id" text NOT NULL REFERENCES "engines"("id") ON DELETE RESTRICT,
  "engine_version" text NOT NULL,
  "status" text NOT NULL,
  "trigger" text NOT NULL,
  "run_as_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "target_kind" text NOT NULL,
  "target_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "judge_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "target_artifact_id" uuid REFERENCES "model_artifacts"("id") ON DELETE SET NULL,
  "config" jsonb NOT NULL,
  "config_hash" text NOT NULL,
  "agent_config_hash" text,
  "trials" integer DEFAULT 3 NOT NULL,
  "budget_usd" double precision NOT NULL,
  "cost_usd" double precision DEFAULT 0 NOT NULL,
  "timeout_seconds" integer NOT NULL,
  "virtual_key_id" uuid REFERENCES "virtual_keys"("id") ON DELETE SET NULL,
  "runner_id" uuid REFERENCES "engine_runners"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "schedule_id" uuid REFERENCES "engine_schedules"("id") ON DELETE SET NULL,
  "workflow_instance_id" uuid REFERENCES "workflow_instances"("id") ON DELETE SET NULL,
  "workflow_stage_id" text,
  "workflow_check_name" text,
  "workflow_round" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "queue_expires_at" timestamp with time zone NOT NULL,
  "leased_at" timestamp with time zone,
  "lease_expires_at" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "phase" text,
  "progress" double precision,
  "deadline_at" timestamp with time zone,
  "cancel_requested_at" timestamp with time zone,
  "cancel_requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "finished_at" timestamp with time zone,
  "error_code" text,
  "summary" jsonb,
  "raw_report_sha256" text,
  "raw_report_bytes" integer,
  "raw_report_ciphertext" text,
  "raw_report_expires_at" timestamp with time zone,
  "redteam_run_id" uuid REFERENCES "redteam_runs"("id") ON DELETE SET NULL,
  "eval_run_id" uuid REFERENCES "eval_runs"("id") ON DELETE SET NULL,
  -- PR #203 review [5]: when the run's end was handed to its workflow stage;
  -- a terminal workflow run with none is retried by the sweep
  "workflow_notified_at" timestamp with time zone,
  CONSTRAINT "engine_runs_status_check" CHECK (
    "status" IN ('awaiting_approval', 'queued', 'leased', 'completed', 'failed', 'timeout', 'cancelled', 'not_run')
  ),
  CONSTRAINT "engine_runs_trigger_check" CHECK ("trigger" IN ('manual', 'workflow', 'scheduled')),
  CONSTRAINT "engine_runs_target_kind_check" CHECK ("target_kind" IN ('agent', 'artifact')),
  CONSTRAINT "engine_runs_target_check" CHECK (
    ("target_kind" = 'agent' AND "target_artifact_id" IS NULL)
    OR ("target_kind" = 'artifact' AND "target_agent_id" IS NULL AND "judge_agent_id" IS NULL)
  ),
  CONSTRAINT "engine_runs_phase_check" CHECK ("phase" IS NULL OR "phase" IN ('starting', 'running', 'uploading')),
  CONSTRAINT "engine_runs_progress_check" CHECK ("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 1)),
  CONSTRAINT "engine_runs_trials_check" CHECK ("trials" BETWEEN 1 AND 25),
  CONSTRAINT "engine_runs_budget_check" CHECK ("budget_usd" > 0),
  CONSTRAINT "engine_runs_timeout_check" CHECK ("timeout_seconds" BETWEEN 60 AND 7200),
  CONSTRAINT "engine_runs_error_code_check" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "engine_runs_raw_sha_check" CHECK ("raw_report_sha256" IS NULL OR "raw_report_sha256" ~ '^[0-9a-f]{64}$'),
  -- a leased run has its key, its lease and its deadline; a queued or awaiting one has none of them
  CONSTRAINT "engine_runs_lease_shape_check" CHECK (
    ("status" <> 'leased' OR ("leased_at" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "deadline_at" IS NOT NULL AND "runner_id" IS NOT NULL))
    AND ("status" NOT IN ('queued', 'awaiting_approval') OR ("leased_at" IS NULL AND "virtual_key_id" IS NULL))
  ),
  -- a terminal run says when it ended
  CONSTRAINT "engine_runs_finished_check" CHECK (
    ("status" IN ('awaiting_approval', 'queued', 'leased')) = ("finished_at" IS NULL)
  ),
  -- a workflow-bound run names its stage, check and round (the instance link may
  -- later be cleared by ON DELETE SET NULL)
  CONSTRAINT "engine_runs_workflow_shape_check" CHECK (
    ("trigger" = 'workflow') = ("workflow_stage_id" IS NOT NULL AND "workflow_check_name" IS NOT NULL AND "workflow_round" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "engine_runs_lease_idx" ON "engine_runs" ("engine_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "engine_runs_user_idx" ON "engine_runs" ("run_as_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "engine_runs_workflow_pending_idx" ON "engine_runs" ("finished_at")
  WHERE "workflow_instance_id" IS NOT NULL AND "finished_at" IS NOT NULL AND "workflow_notified_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_runs_workflow_uq" ON "engine_runs" ("workflow_instance_id", "workflow_stage_id", "workflow_check_name", "workflow_round")
  WHERE "workflow_instance_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "engine_run_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "engine_runs"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "source_system" text NOT NULL,
  "source_id" text NOT NULL,
  "attack_class" text,
  "scorer_kind" text,
  "claimed_class" text,
  "severity" text NOT NULL,
  "attempts" integer NOT NULL,
  "defeated" integer NOT NULL,
  "claimed_verdict" text NOT NULL,
  "verdict" text NOT NULL,
  "reason" text,
  "verdict_note" text,
  "not_run_reason" text,
  "dispatch_audit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "engine_run_items_counts_check" CHECK ("attempts" >= 0 AND "defeated" >= 0 AND "defeated" <= "attempts"),
  CONSTRAINT "engine_run_items_verdict_check" CHECK ("verdict" IN ('pass', 'fail', 'unknown', 'not_run')),
  CONSTRAINT "engine_run_items_claimed_verdict_check" CHECK ("claimed_verdict" IN ('pass', 'fail', 'unknown', 'not_run')),
  CONSTRAINT "engine_run_items_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT "engine_run_items_not_run_reason_check" CHECK (
    "not_run_reason" IS NULL
    OR "not_run_reason" IN ('cloud_only', 'excluded_licence', 'egress_denied', 'unsupported_format', 'missing_preseed', 'engine_error')
  ),
  -- a not-run item has a not-run verdict, and nothing not run is ever a pass
  CONSTRAINT "engine_run_items_not_run_check" CHECK ("not_run_reason" IS NULL OR "verdict" = 'not_run')
);
--> statement-breakpoint
CREATE INDEX "engine_run_items_run_idx" ON "engine_run_items" ("run_id");
--> statement-breakpoint

-- ===== 6. artifact scans and model-card evidence =============================
CREATE TABLE "artifact_scans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "model_artifacts"("id") ON DELETE RESTRICT,
  "engine_run_id" uuid REFERENCES "engine_runs"("id") ON DELETE SET NULL,
  "artifact_sha256" text NOT NULL,
  "format" text,
  "verdict" text NOT NULL,
  "issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scanner_version" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "artifact_scans_verdict_check" CHECK ("verdict" IN ('clean', 'unsafe', 'unknown', 'not_run')),
  CONSTRAINT "artifact_scans_sha256_check" CHECK ("artifact_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "artifact_scans_artifact_idx" ON "artifact_scans" ("artifact_id");
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD COLUMN "artifact_scan_id" uuid REFERENCES "artifact_scans"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "model_card_evidence" DROP CONSTRAINT "model_card_evidence_kind_check";
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_kind_check" CHECK ("kind" IN ('eval_run', 'external', 'engine_scan'));
--> statement-breakpoint
ALTER TABLE "model_card_evidence" DROP CONSTRAINT "model_card_evidence_shape_check";
--> statement-breakpoint
ALTER TABLE "model_card_evidence" ADD CONSTRAINT "model_card_evidence_shape_check" CHECK (
  ("kind" = 'eval_run' AND "eval_run_id" IS NOT NULL AND "external_ref" IS NULL AND "artifact_scan_id" IS NULL)
  OR ("kind" = 'external' AND "external_ref" IS NOT NULL AND "eval_run_id" IS NULL AND "artifact_scan_id" IS NULL)
  OR ("kind" = 'engine_scan' AND "artifact_scan_id" IS NOT NULL AND "eval_run_id" IS NULL AND "external_ref" IS NULL)
);
--> statement-breakpoint

-- ===== 7. virtual keys: the `engine` purpose, pinned to a project and a run ===
ALTER TABLE "virtual_keys" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD COLUMN "engine_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "virtual_keys" DROP CONSTRAINT "virtual_keys_purpose_ck";
--> statement-breakpoint
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_purpose_ck" CHECK ("purpose" IN ('dispatch', 'pdp', 'engine'));
--> statement-breakpoint
-- an engine key always carries its project, its run, an expiry, a budget and an
-- allow-list; no other key carries a run
ALTER TABLE "virtual_keys" ADD CONSTRAINT "virtual_keys_engine_pin_check" CHECK (
  ("purpose" = 'engine') = ("engine_run_id" IS NOT NULL)
  AND ("purpose" <> 'engine' OR (
    "project_id" IS NOT NULL AND "expires_at" IS NOT NULL AND "budget_usd" IS NOT NULL AND "allowed_models" IS NOT NULL
  ))
);
--> statement-breakpoint

-- ===== 8. org settings, all strict ===========================================
ALTER TABLE "org_settings" ADD COLUMN "engine_max_run_timeout_minutes" integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "engine_default_run_budget_usd" double precision DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "engine_run_approval_threshold_usd" double precision DEFAULT 10 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "engine_raw_report_retention_days" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "engine_sensitive_set_approval" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_engine_max_run_timeout_minutes_check" CHECK ("engine_max_run_timeout_minutes" BETWEEN 1 AND 120);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_engine_default_run_budget_usd_check" CHECK ("engine_default_run_budget_usd" >= 0.01 AND "engine_default_run_budget_usd" <= 1000);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_engine_run_approval_threshold_usd_check" CHECK ("engine_run_approval_threshold_usd" >= 0 AND "engine_run_approval_threshold_usd" <= 10000);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_engine_raw_report_retention_days_check" CHECK ("engine_raw_report_retention_days" BETWEEN 1 AND 3650);
