-- ADR-0346: an evaluation engine beside promptfoo, fairlearn (group-fairness metrics on the decisions a card's model
-- makes through the gateway). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `engines_id_check` gains 'fairlearn', in lockstep with ENGINE_IDS in @regulait/shared
--    (packages/shared/src/engines/contract.ts), which the drizzle schema reads. It keeps every engine migration 0325
--    allowed (the two admission-scan engines and spikee) and the content extractor that pending migration
--    `content_extract_engine` (ADR-0362) adds. That file sorts, and so runs, before this one: without 'contentextract'
--    here the new check would refuse the row it inserted.
-- 2. Its row, OFF (`enabled` defaults to false and `engines_enabled_needs_self_test_check` holds). Version and digest
--    are re-synced from the shipped manifest by the gateway (`syncEngineManifest`); no route writes them, and the
--    manifest's digest is null until the first signed publish is recorded in engines/images.lock.json, so it cannot
--    be enabled before then (secure by default, ADR-0180).
-- Runs, runners, schedules and results already key on `engines.id` (migration 0173). No function or trigger is added,
-- so the 0185 guard has nothing new to check.

ALTER TABLE "engines" DROP CONSTRAINT IF EXISTS "engines_id_check";
--> statement-breakpoint
ALTER TABLE "engines" ADD CONSTRAINT "engines_id_check"
  CHECK ("id" IN ('promptfoo', 'modelscan', 'garak', 'mcpscanner', 'skillscanner', 'spikee', 'contentextract', 'fairlearn'));
--> statement-breakpoint
INSERT INTO "engines" ("id", "kind", "version", "licence") VALUES
  ('fairlearn', 'eval', '0.15.0', 'MIT')
ON CONFLICT ("id") DO NOTHING;
