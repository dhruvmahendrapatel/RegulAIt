-- ADR-0056 §5 amendment (lane L7): the copilot narrator red-team gate. Strict by default.
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_gate_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_max_age_days" integer DEFAULT 30 NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_min_resist_rate" double precision DEFAULT 1 NOT NULL;
-- Second review of #811: the gate-owned library (NULL = none designated, the gate refuses) and minimum trials.
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_library_id" uuid;
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_min_trials" integer DEFAULT 3 NOT NULL;
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_copilot_redteam_library_id_redteam_libraries_id_fk" FOREIGN KEY ("copilot_redteam_library_id") REFERENCES "public"."redteam_libraries"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_copilot_redteam_min_trials_check" CHECK ("copilot_redteam_min_trials" BETWEEN 1 AND 25);
