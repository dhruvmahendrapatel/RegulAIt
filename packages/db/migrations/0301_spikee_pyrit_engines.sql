-- ADR-0245: two more red-team engines beside garak and promptfoo, Spikee (indirect prompt injection) and PyRIT
-- (multi-turn attacks). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `engines_id_check` gains 'spikee' and 'pyrit', in lockstep with ENGINE_IDS in @regulait/shared
--    (packages/shared/src/engines/contract.ts), which the drizzle schema reads.
-- 2. One row per new engine, OFF (`enabled` defaults to false and `engines_enabled_needs_self_test_check` holds).
--    Version and digest are re-synced from the shipped manifest by the gateway (`syncEngineManifest`); no route
--    writes them, and the manifest's digest is null until the first signed publish is recorded in
--    engines/images.lock.json, so neither engine can be enabled before then (secure by default, ADR-0180).
-- 3. ADR-0217's automatic re-test gains a third kind, 'engine': a red-team engine run a person already ran against the
--    agent (any engine, these two included) is run again after a model change, as that person, on that project.
--    `mrm_retest_runs.engine_run_id` names the run the re-test started (a foreign key, ON DELETE SET NULL like the
--    other run links); `source_id` is the engine run that was repeated. The re-test row stays `running` until that
--    engine run ends, and the gateway settles it in the same transaction as the run's end.
-- Runs, runners, schedules and results already key on `engines.id` (migration 0173). No function or trigger is
-- added, so the 0185 guard has nothing new to check.

ALTER TABLE "engines" DROP CONSTRAINT IF EXISTS "engines_id_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_id_check"
  CHECK ("id" IN ('promptfoo', 'modelscan', 'garak', 'spikee', 'pyrit'));
--> statement-breakpoint
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('spikee', 'redteam', '0.9.4', 'Apache-2.0'),
  ('pyrit', 'redteam', '1.1.0', 'MIT')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "mrm_retest_runs" ADD COLUMN IF NOT EXISTS "engine_run_id" uuid REFERENCES "engine_runs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "mrm_retest_runs" DROP CONSTRAINT IF EXISTS "mrm_retest_runs_kind_check";
--> statement-breakpoint
ALTER TABLE "mrm_retest_runs" ADD CONSTRAINT "mrm_retest_runs_kind_check" CHECK ("kind" IN ('eval', 'redteam', 'engine'));
--> statement-breakpoint
ALTER TABLE "mrm_retest_runs" DROP CONSTRAINT IF EXISTS "mrm_retest_runs_engine_run_check";
--> statement-breakpoint
ALTER TABLE "mrm_retest_runs" ADD CONSTRAINT "mrm_retest_runs_engine_run_check" CHECK ("engine_run_id" IS NULL OR "kind" = 'engine');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mrm_retest_runs_engine_run_uq" ON "mrm_retest_runs" ("engine_run_id") WHERE "engine_run_id" IS NOT NULL;
