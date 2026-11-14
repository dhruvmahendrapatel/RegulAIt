-- ADR-0296 (P18 B2, B3): incident clocks for GDPR breach notification (Art. 33, 34), NIS2 (Art. 23(4)),
-- DORA (Delegated Regulation (EU) 2025/301, Art. 5) and the CRA (Art. 14).
--
-- 1. Five new criteria an incident may list, each naming one regime's trigger. None is an EU AI Act
--    Art. 3(49) criterion, so none marks an incident serious.
-- 2. Four new regimes a notification clock may belong to.
-- 3. Secure by default (ADR-0180): the org default enables every regime, and every existing org gains the
--    four new ones. They are new regimes, not a choice an admin made, so this is not grandfathering; an admin
--    turns off the ones that do not apply, which the settings route audits as a relaxation.
ALTER TABLE "ai_incidents" DROP CONSTRAINT "ai_incidents_serious_criteria_check";
--> statement-breakpoint
ALTER TABLE "ai_incidents" ADD CONSTRAINT "ai_incidents_serious_criteria_check" CHECK (
  jsonb_typeof("serious_criteria") = 'array'
  AND "serious_criteria" <@ '["death", "health", "critical_infrastructure", "fundamental_rights", "property_environment", "widespread_infringement", "phi_breach", "personal_data_breach", "significant_cyber_incident", "major_ict_incident", "exploited_vulnerability", "severe_product_incident"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "ai_incident_notifications" DROP CONSTRAINT "ai_incident_notifications_regime_check";
--> statement-breakpoint
ALTER TABLE "ai_incident_notifications" ADD CONSTRAINT "ai_incident_notifications_regime_check" CHECK (
  "regime" IN ('eu-ai-act', 'hipaa', 'gdpr', 'nis2', 'dora', 'cra')
);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT "org_settings_incident_clock_regimes_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_incident_clock_regimes_check" CHECK (
  jsonb_typeof("incident_clock_regimes") = 'array'
  AND "incident_clock_regimes" <@ '["eu-ai-act", "hipaa", "gdpr", "nis2", "dora", "cra"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "incident_clock_regimes" SET DEFAULT '["eu-ai-act", "hipaa", "gdpr", "nis2", "dora", "cra"]'::jsonb;
--> statement-breakpoint
UPDATE "org_settings"
SET "incident_clock_regimes" = "incident_clock_regimes" || (
  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
  FROM jsonb_array_elements_text('["gdpr", "nis2", "dora", "cra"]'::jsonb) AS r
  WHERE NOT "incident_clock_regimes" ? r
);
