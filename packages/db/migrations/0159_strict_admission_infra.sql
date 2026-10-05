-- ADR-0181 (strict defaults), agent SC: admission, infrastructure and monitors.
--
-- Every default below moves to its strict value. As for a first load, the
-- existing settings rows move with it: the product is not live, and ADR-0181
-- reverses the ADR-0021 "a fresh install behaves exactly as before" rule for
-- security settings. An admin may relax each one again through its existing
-- audited write path (PUT /v1/org/settings, PUT /v1/spend/monitor-policies).
--
--   mcp_admission_mode             off     -> enforce
--   min_release_age_days           0       -> 7
--   mcp_private_ranges_default     true    -> false
--   egress_compiled_default_policy inherit -> strict
--   backup_verify_enabled          false   -> true
--   stale_credential_alerts        false   -> true
--   spend_monitor_policies.enabled false   -> true
ALTER TABLE "org_settings" ALTER COLUMN "mcp_admission_mode" SET DEFAULT 'enforce';--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "min_release_age_days" SET DEFAULT 7;--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "mcp_private_ranges_default" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "egress_compiled_default_policy" SET DEFAULT 'strict';--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "backup_verify_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "stale_credential_alerts" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "spend_monitor_policies" ALTER COLUMN "enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "org_settings" SET
  "mcp_admission_mode" = 'enforce',
  "min_release_age_days" = GREATEST("min_release_age_days", 7),
  "mcp_private_ranges_default" = false,
  "egress_compiled_default_policy" = 'strict',
  "backup_verify_enabled" = true,
  "stale_credential_alerts" = true;--> statement-breakpoint
UPDATE "spend_monitor_policies" SET "enabled" = true;
