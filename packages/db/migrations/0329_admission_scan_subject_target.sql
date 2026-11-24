-- ADR-0242 phase 2 (lane L4, amendment L4.3): the `subject` engine target, so the gateway's admission gate can run the
-- two admission-scan engines (mcpscanner, skillscanner) against an MCP server's manifest or a builder skill at one
-- digest. Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `engine_runs.trigger` gains 'admission' and `engine_runs.target_kind` gains 'subject', in lockstep with
--    ENGINE_RUN_TRIGGERS and ENGINE_TARGET_KINDS in @regulait/shared (packages/shared/src/engines/contract.ts).
--    Both CHECKs were created by migration 0173.
-- 2. Four columns:
--    - `target_mcp_server_id` and `target_builder_skill_id`: the subject, a real foreign key each (ON DELETE SET NULL
--      like the other target links; a run whose subject is gone ends not_run at lease);
--    - `target_subject_digest`: the digest the run scans (the subject's current digest moves on; the run's does not);
--    - `target_subject_input_ciphertext`: the MCP manifest snapshot the scan reads, encrypted under the data key and
--      cleared at the run's end. A held manifest is never stored in `mcp_tools`, so the bytes are captured when the
--      run is queued (ADR-0200 exception: a temporary verbatim external payload, see the column comment).
-- 3. `engine_runs_target_check` is widened: a subject run has no agent, judge, artifact, run-as person or project,
--    is always trigger 'admission', names at most one subject of its engine's kind, and carries a sha256 digest;
--    any other run has no subject column set and is never trigger 'admission'.
-- 4. Two partial unique indexes keep one live (queued or leased) run per engine, subject and digest.
-- No function or trigger is added, so the 0185 guard has nothing new to check.

ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "target_mcp_server_id" uuid REFERENCES "mcp_servers"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "target_builder_skill_id" uuid REFERENCES "builder_skills"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "target_subject_digest" text;
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD COLUMN IF NOT EXISTS "target_subject_input_ciphertext" text;
--> statement-breakpoint
COMMENT ON COLUMN "engine_runs"."target_subject_input_ciphertext" IS
  'ADR-0200 exception: a temporary verbatim external payload (the MCP manifest snapshot an admission scan reads), encrypted under the data key and cleared when the run ends (ADR-0242 L4.3)';
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_trigger_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_trigger_check"
  CHECK ("trigger" IN ('manual', 'workflow', 'scheduled', 'admission'));
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_target_kind_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_target_kind_check"
  CHECK ("target_kind" IN ('agent', 'artifact', 'subject'));
--> statement-breakpoint
ALTER TABLE "engine_runs" DROP CONSTRAINT IF EXISTS "engine_runs_target_check";
--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_target_check" CHECK (
  (
    "target_kind" IN ('agent', 'artifact')
    AND "trigger" <> 'admission'
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
    AND "target_agent_id" IS NULL AND "judge_agent_id" IS NULL AND "target_artifact_id" IS NULL
    AND "run_as_user_id" IS NULL AND "project_id" IS NULL
    AND num_nonnulls("target_mcp_server_id", "target_builder_skill_id") <= 1
    AND ("target_mcp_server_id" IS NULL OR "engine_id" = 'mcpscanner')
    AND ("target_builder_skill_id" IS NULL OR "engine_id" = 'skillscanner')
    AND "target_subject_digest" IS NOT NULL AND "target_subject_digest" ~ '^[0-9a-f]{64}$'
    AND ("target_subject_input_ciphertext" IS NULL OR "engine_id" = 'mcpscanner')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engine_runs_subject_mcp_live_uq"
  ON "engine_runs" ("engine_id", "target_mcp_server_id", "target_subject_digest")
  WHERE "target_mcp_server_id" IS NOT NULL AND "status" IN ('queued', 'leased');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engine_runs_subject_skill_live_uq"
  ON "engine_runs" ("engine_id", "target_builder_skill_id", "target_subject_digest")
  WHERE "target_builder_skill_id" IS NOT NULL AND "status" IN ('queued', 'leased');
