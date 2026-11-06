-- ADR-0200 addendum of 2026-11-06 (normalized schema), batch N1: foreign keys that were missing.
--
-- A normalization audit found these live configuration and lifecycle columns pointing at another table with no
-- constraint and no comment saying it was deliberate. Each one now gets its foreign key, added the way that does not
-- take a long lock: ADD ... NOT VALID (instant, checks every NEW write), orphans cleared, then VALIDATE (a scan that
-- holds only SHARE UPDATE EXCLUSIVE). A nullable pointer whose target is already gone is set to NULL, the same
-- outcome ON DELETE SET NULL gives from now on. The two prompt-promotion accountability columns use RESTRICT, like
-- requested_by_user_id on the same row: users are deactivated, never deleted, and who approved or decided must not
-- silently vanish. An orphan there fails the migration loudly rather than being rewritten.
--
-- Deliberately NOT here (ledgers, snapshots and documented FK-free ids): the audit's exclusion list in the PR body.
-- None of these tables has row-level security (ADR-0234), so no migration context is needed.
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_summarizer_agent_id_fk" FOREIGN KEY ("summarizer_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "org_settings" SET "summarizer_agent_id" = NULL WHERE "summarizer_agent_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" x WHERE x."id" = "org_settings"."summarizer_agent_id");
--> statement-breakpoint
ALTER TABLE "org_settings" VALIDATE CONSTRAINT "org_settings_summarizer_agent_id_fk";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_infra_approver_user_id_fk" FOREIGN KEY ("infra_approver_user_id") REFERENCES "users"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "org_settings" SET "infra_approver_user_id" = NULL WHERE "infra_approver_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" x WHERE x."id" = "org_settings"."infra_approver_user_id");
--> statement-breakpoint
ALTER TABLE "org_settings" VALIDATE CONSTRAINT "org_settings_infra_approver_user_id_fk";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_recommendation_judge_agent_id_fk" FOREIGN KEY ("recommendation_judge_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "org_settings" SET "recommendation_judge_agent_id" = NULL WHERE "recommendation_judge_agent_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "agents" x WHERE x."id" = "org_settings"."recommendation_judge_agent_id");
--> statement-breakpoint
ALTER TABLE "org_settings" VALIDATE CONSTRAINT "org_settings_recommendation_judge_agent_id_fk";
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_pack_id_fk" FOREIGN KEY ("pack_id") REFERENCES "compliance_packs"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "report_definitions" SET "pack_id" = NULL WHERE "pack_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "compliance_packs" x WHERE x."id" = "report_definitions"."pack_id");
--> statement-breakpoint
ALTER TABLE "report_definitions" VALIDATE CONSTRAINT "report_definitions_pack_id_fk";
--> statement-breakpoint
ALTER TABLE "engine_schedules" ADD CONSTRAINT "engine_schedules_last_run_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "engine_runs"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "engine_schedules" SET "last_run_id" = NULL WHERE "last_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "engine_runs" x WHERE x."id" = "engine_schedules"."last_run_id");
--> statement-breakpoint
ALTER TABLE "engine_schedules" VALIDATE CONSTRAINT "engine_schedules_last_run_id_fk";
--> statement-breakpoint
ALTER TABLE "engine_enrollment_tokens" ADD CONSTRAINT "engine_enrollment_tokens_runner_id_fk" FOREIGN KEY ("runner_id") REFERENCES "engine_runners"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "engine_enrollment_tokens" SET "runner_id" = NULL WHERE "runner_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "engine_runners" x WHERE x."id" = "engine_enrollment_tokens"."runner_id");
--> statement-breakpoint
ALTER TABLE "engine_enrollment_tokens" VALIDATE CONSTRAINT "engine_enrollment_tokens_runner_id_fk";
--> statement-breakpoint
ALTER TABLE "cert_rotations" ADD CONSTRAINT "cert_rotations_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "infra_findings"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "cert_rotations" SET "finding_id" = NULL WHERE "finding_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "infra_findings" x WHERE x."id" = "cert_rotations"."finding_id");
--> statement-breakpoint
ALTER TABLE "cert_rotations" VALIDATE CONSTRAINT "cert_rotations_finding_id_fk";
--> statement-breakpoint
ALTER TABLE "cert_rotations" ADD CONSTRAINT "cert_rotations_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "cert_rotations" SET "approval_id" = NULL WHERE "approval_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "approvals" x WHERE x."id" = "cert_rotations"."approval_id");
--> statement-breakpoint
ALTER TABLE "cert_rotations" VALIDATE CONSTRAINT "cert_rotations_approval_id_fk";
--> statement-breakpoint
ALTER TABLE "patch_records" ADD CONSTRAINT "patch_records_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "infra_findings"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "patch_records" SET "finding_id" = NULL WHERE "finding_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "infra_findings" x WHERE x."id" = "patch_records"."finding_id");
--> statement-breakpoint
ALTER TABLE "patch_records" VALIDATE CONSTRAINT "patch_records_finding_id_fk";
--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_finding_id_fk" FOREIGN KEY ("finding_id") REFERENCES "infra_findings"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
UPDATE "backup_runs" SET "finding_id" = NULL WHERE "finding_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "infra_findings" x WHERE x."id" = "backup_runs"."finding_id");
--> statement-breakpoint
ALTER TABLE "backup_runs" VALIDATE CONSTRAINT "backup_runs_finding_id_fk";
--> statement-breakpoint
ALTER TABLE "prompt_promotions" ADD CONSTRAINT "prompt_promotions_approver_user_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "users"("id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "prompt_promotions" VALIDATE CONSTRAINT "prompt_promotions_approver_user_id_fk";
--> statement-breakpoint
ALTER TABLE "prompt_promotions" ADD CONSTRAINT "prompt_promotions_decided_by_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "prompt_promotions" VALIDATE CONSTRAINT "prompt_promotions_decided_by_user_id_fk";
