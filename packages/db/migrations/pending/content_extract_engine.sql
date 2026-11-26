-- ADR-0362 slice 1b-i (lane E43): the content-extraction engine (`contentextract`), registered OFF, and the table its
-- results wait in. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `engines_id_check` gains 'contentextract' and `engines_kind_check` gains 'content_extract', in lockstep with
--    ENGINE_IDS and ENGINE_KINDS in @regulait/shared (packages/shared/src/engines/contract.ts), which the drizzle schema
--    reads. Both lists keep every engine an earlier migration added (spikee included, migration 0325).
-- 2. Its row, OFF (`enabled` defaults to false and `engines_enabled_needs_self_test_check` holds). Version and digest
--    are re-synced from the shipped manifest by the gateway (`syncEngineManifest`); the manifest's digest is null until
--    the first signed publish is recorded in engines/images.lock.json, so it cannot be enabled before then (ADR-0180).
-- 3. `engine_runs.trigger` gains 'inspection' (ENGINE_RUN_TRIGGERS), and `engine_runs_target_check` gains a third
--    branch: a `contentextract` run is a `subject` run with trigger 'inspection', no agent, judge, artifact, MCP server
--    or skill, and a sha256 subject digest (the sha256 of the request's file bundle, which the gateway encrypts into
--    `target_subject_input_ciphertext` and clears at the run's end). Unlike an admission scan it may name the person
--    and project of the request it inspects (both ON DELETE SET NULL, so either may be null later). The other two
--    branches now name their engines: an agent or artifact run is never `contentextract` and never trigger
--    'inspection'; an admission run is only mcpscanner or skillscanner (the only engines that ever ran one).
-- 4. `content_inspection_results`: the extractor's result for one run, stored ONLY encrypted under the data key
--    (ADR-0200 exception: a temporary verbatim external payload, see the column comment), deleted by the gateway when
--    it reads it. One row per run (unique), gone with its run (ON DELETE CASCADE). `id` is the row key the data-key
--    re-encryption walk pages by. No row-level security: as every engine table (engine_runs, admission_engine_scans),
--    it is reached only by the gateway's engine code, and the default privileges of migration 0272 grant the runtime
--    role on a new table.
-- No function or trigger is added, so the 0185 guard has nothing new to check.

ALTER TABLE "engines" DROP CONSTRAINT IF EXISTS "engines_id_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_id_check"
  CHECK ("id" IN ('promptfoo', 'modelscan', 'garak', 'mcpscanner', 'skillscanner', 'spikee', 'contentextract'));
--> statement-breakpoint
ALTER TABLE "engines" DROP CONSTRAINT IF EXISTS "engines_kind_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_kind_check"
  CHECK ("kind" IN ('redteam', 'eval', 'model_scan', 'admission_scan', 'content_extract'));
--> statement-breakpoint
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('contentextract', 'content_extract', '0.1.0', 'LicenseRef-RegulAIt')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_trigger_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_trigger_check"
  CHECK ("trigger" IN ('manual', 'workflow', 'scheduled', 'admission', 'inspection'));
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_target_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_target_check" CHECK (
  (
    "target_kind" IN ('agent', 'artifact')
    AND "trigger" NOT IN ('admission', 'inspection')
    AND "engine_id" <> 'contentextract'
    AND "target_mcp_server_id" IS NULL AND "target_builder_skill_id" IS NULL
    AND "target_subject_digest" IS NULL AND "target_subject_input_ciphertext" IS NULL
    AND (
      ("target_kind" = 'agent' AND "target_artifact_id" IS NULL)
      OR ("target_kind" = 'artifact' AND "target_agent_id" IS NULL AND "judge_agent_id" IS NULL)
    )
  )
  OR (
    "target_kind" = 'subject'
    AND "trigger" = 'admission'
    AND "engine_id" IN ('mcpscanner', 'skillscanner')
    AND "target_agent_id" IS NULL AND "judge_agent_id" IS NULL AND "target_artifact_id" IS NULL
    AND "run_as_user_id" IS NULL AND "project_id" IS NULL
    AND num_nonnulls("target_mcp_server_id", "target_builder_skill_id") <= 1
    AND ("target_mcp_server_id" IS NULL OR "engine_id" = 'mcpscanner')
    AND ("target_builder_skill_id" IS NULL OR "engine_id" = 'skillscanner')
    AND "target_subject_digest" IS NOT NULL AND "target_subject_digest" ~ '^[0-9a-f]{64}$'
    AND ("target_subject_input_ciphertext" IS NULL OR "engine_id" = 'mcpscanner')
  )
  OR (
    "target_kind" = 'subject'
    AND "trigger" = 'inspection'
    AND "engine_id" = 'contentextract'
    AND "target_agent_id" IS NULL AND "judge_agent_id" IS NULL AND "target_artifact_id" IS NULL
    AND "target_mcp_server_id" IS NULL AND "target_builder_skill_id" IS NULL
    AND "target_subject_digest" IS NOT NULL AND "target_subject_digest" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_inspection_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "engine_runs"("id") ON DELETE CASCADE,
  "result_ciphertext" text NOT NULL,
  "result_sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "content_inspection_results_sha256_check" CHECK ("result_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "content_inspection_results_run_uq" ON "content_inspection_results" ("run_id");
--> statement-breakpoint
COMMENT ON COLUMN "content_inspection_results"."result_ciphertext" IS
  'ADR-0200 exception: a temporary verbatim external payload (the text the sandboxed extractor returned for one request''s files), encrypted under the data key and deleted when the gateway reads it (ADR-0362)';
