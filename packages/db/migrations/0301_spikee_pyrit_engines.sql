-- ADR-0245: two more red-team engines beside garak and promptfoo, Spikee (indirect prompt injection) and PyRIT
-- (multi-turn attacks). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `engines_id_check` gains 'spikee' and 'pyrit', in lockstep with ENGINE_IDS in @regulait/shared
--    (packages/shared/src/engines/contract.ts), which the drizzle schema reads.
-- 2. One row per new engine, OFF (`enabled` defaults to false and `engines_enabled_needs_self_test_check` holds).
--    Version and digest are re-synced from the shipped manifest by the gateway (`syncEngineManifest`); no route
--    writes them, and the manifest's digest is null until the first signed publish is recorded in
--    engines/images.lock.json, so neither engine can be enabled before then (secure by default, ADR-0180).
-- No other table changes: runs, runners, schedules and results already key on `engines.id` (migration 0173).

ALTER TABLE "engines" DROP CONSTRAINT IF EXISTS "engines_id_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_id_check"
  CHECK ("id" IN ('promptfoo', 'modelscan', 'garak', 'spikee', 'pyrit'));
--> statement-breakpoint
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('spikee', 'redteam', '0.9.4', 'Apache-2.0'),
  ('pyrit', 'redteam', '1.1.0', 'MIT')
ON CONFLICT ("id") DO NOTHING;
