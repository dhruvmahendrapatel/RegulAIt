-- ADR-0056 §5 amendment (lane L7): the copilot narrator red-team gate. Strict by default.
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_gate_enabled" boolean DEFAULT true NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_max_age_days" integer DEFAULT 30 NOT NULL;
ALTER TABLE "org_settings" ADD COLUMN "copilot_redteam_min_resist_rate" double precision DEFAULT 1 NOT NULL;
