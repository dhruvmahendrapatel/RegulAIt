-- ADR-0232 (PENDING S6) — the content-credential guard.
--
--   * org_settings.content_credential_guard: TRUE (the strict default) = a write that puts
--     credential-shaped text into a registered name/title/description/summary/body column is
--     refused with 422 credential_in_content. FALSE stores such text as typed; turning the guard
--     off is an audited, step-up admin relaxation (the strictness registry in org-setting-strictness.ts).
--
-- No data is rewritten: rows written before this migration are reported by
-- GET /v1/admin/content-credential-report, never edited.
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "content_credential_guard" boolean NOT NULL DEFAULT true;
