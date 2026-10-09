-- ADR-0187 B5-M (decisions 104 onward): model artifacts, their scans and the upload limit.
-- Hand-authored (never drizzle-kit generate).
--
-- 1. The upload limit, strict by default (ADR-0180): an upload larger than this many MiB is refused
--    before it is stored. Raising it is a relaxation (a `settings_relax` step-up, audited).
ALTER TABLE "org_settings" ADD COLUMN "model_artifact_max_megabytes" integer DEFAULT 512 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_model_artifact_max_megabytes_check" CHECK ("model_artifact_max_megabytes" BETWEEN 1 AND 8192);
--> statement-breakpoint
-- 2. What clean means (owner decision 1, pending owner confirmation): an executable format in which
--    modelscan found no known-unsafe operator is `no_known_unsafe`, never `clean`.
ALTER TABLE "artifact_scans" DROP CONSTRAINT "artifact_scans_verdict_check";
--> statement-breakpoint
ALTER TABLE "artifact_scans" ADD CONSTRAINT "artifact_scans_verdict_check" CHECK ("verdict" IN ('clean', 'no_known_unsafe', 'unsafe', 'unknown', 'not_run'));
--> statement-breakpoint
-- `clean` is reachable only for a non-executable format (safetensors, verified by its header)
ALTER TABLE "artifact_scans" ADD CONSTRAINT "artifact_scans_clean_format_check" CHECK ("verdict" <> 'clean' OR "format" = 'safetensors');
--> statement-breakpoint
-- one scan record per engine run (the terminal write is idempotent)
CREATE UNIQUE INDEX "artifact_scans_engine_run_unique" ON "artifact_scans" ("engine_run_id") WHERE "engine_run_id" IS NOT NULL;
--> statement-breakpoint
-- 3. The format is decided by the gateway from the bytes, never from the file name. The vocabulary
--    is ARTIFACT_FORMATS (packages/shared/src/engines/modelscan.ts).
ALTER TABLE "model_artifacts" ADD CONSTRAINT "model_artifacts_format_check" CHECK ("format" IN (
  'safetensors', 'safetensors_invalid', 'pickle', 'pytorch_legacy', 'pytorch_zip', 'numpy', 'numpy_npz',
  'keras_h5', 'keras_v3', 'zip', 'zip_opaque', 'gguf', 'compressed', 'tar', 'empty', 'unrecognised'
));
--> statement-breakpoint
ALTER TABLE "artifact_scans" ADD CONSTRAINT "artifact_scans_format_check" CHECK ("format" IS NULL OR "format" IN (
  'safetensors', 'safetensors_invalid', 'pickle', 'pytorch_legacy', 'pytorch_zip', 'numpy', 'numpy_npz',
  'keras_h5', 'keras_v3', 'zip', 'zip_opaque', 'gguf', 'compressed', 'tar', 'empty', 'unrecognised'
));
--> statement-breakpoint
-- 4. Content-addressed storage: one stored object per sha256.
ALTER TABLE "model_artifacts" ADD CONSTRAINT "model_artifacts_storage_key_check" CHECK ("storage_key" = 'sha256/' || "sha256");
