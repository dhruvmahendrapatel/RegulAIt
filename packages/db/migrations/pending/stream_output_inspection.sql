-- ADR-0352 (lane E33 slice 3): how a streamed answer is released under an output-phase block policy.
-- 'buffer' (strict default, ADR-0042) scans the whole completion before one flush; 'incremental' releases it piece by
-- piece after windowed scans and ends the stream with an explicit error event on a block. Turning it on is audited.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "stream_output_inspection" text DEFAULT 'buffer' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_stream_output_inspection_check"
  CHECK ("org_settings"."stream_output_inspection" IN ('buffer', 'incremental'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
