-- ADR-0233 (PENDING S6) — the content-credential guard.
--
--   * org_settings.content_credential_guard: TRUE (the strict default) = a write that puts
--     credential-shaped text into a registered name/title/description/summary/body column is
--     refused with 422 credential_in_content. FALSE stores such text as typed; turning the guard
--     off is an audited, step-up admin relaxation (the strictness registry in org-setting-strictness.ts).
--
-- Numbering (review finding 2): 0259 is held by an open PR (0259_theme_account_org_lock, when
-- 1785194000000), so this is 0260 (when 1785195000000) rather than a second 0259 with the same `when`.
-- Whichever of the two lands second is renumbered above main; scripts/migration-watermark-guard.mjs refuses
-- any entry whose `when` is not above the base branch's newest, so neither can be silently skipped.
--
-- No data is rewritten: rows written before this migration are reported by
-- GET /v1/admin/content-credential-report, never edited.
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "content_credential_guard" boolean NOT NULL DEFAULT true;
