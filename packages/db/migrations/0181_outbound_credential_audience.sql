-- ADR-0186 decision 32 (V, credential audience): the org setting that refuses caller-supplied credentials sent to a
-- host outside their audience. Hand-authored (never drizzle-kit generate).
--
-- Strict by default (ADR-0180): `enforce`. `off` is a relaxation (a `settings_relax` step-up, audited through
-- `org-settings-updated`). The vocabulary is OUTBOUND_CREDENTIAL_AUDIENCE_MODES (packages/shared/src/batch4.ts).
ALTER TABLE "org_settings" ADD COLUMN "outbound_credential_audience" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_outbound_credential_audience_check" CHECK ("outbound_credential_audience" IN ('enforce', 'off'));
