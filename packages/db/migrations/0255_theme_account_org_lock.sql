-- ADR-0218: themes saved to the account, an organisation default palette and an admin lock.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `org_settings.theme_default_palette` (default 'aurora', the palette everyone had before) and
--    `org_settings.theme_locked` (default false). Written only by the admin-only, audited `PUT /v1/org/settings`
--    (old -> new in the same transaction as the write). The lock is a presentation setting, not a security control,
--    so it ships off (ADR-0218 records why ADR-0180's strict-by-default does not apply).
-- 2. `user_appearance`: one row per person, their own palette and light/dark mode. Written only by
--    `PUT /auth/appearance` for the caller's own user id, with its audit row in the same transaction. Nothing is
--    backfilled: a person with no row gets the organisation default and their browser's mode.
-- 3. The CHECKs repeat the palette list in @regulait/shared (THEME_PALETTE_IDS), so a row written around the API
--    cannot name a palette the app does not ship. High contrast ('contrast') is in both lists: the lock never
--    takes it away (enforced in the gateway, where the lock is read).

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "theme_default_palette" text DEFAULT 'aurora' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "theme_locked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_theme_default_palette_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_theme_default_palette_check"
  CHECK ("theme_default_palette" IN ('aurora', 'harbor', 'evergreen', 'graphite', 'orchid', 'contrast'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_appearance" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "palette" text,
  "mode" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_appearance_palette_check"
    CHECK ("palette" IS NULL OR "palette" IN ('aurora', 'harbor', 'evergreen', 'graphite', 'orchid', 'contrast')),
  CONSTRAINT "user_appearance_mode_check" CHECK ("mode" IS NULL OR "mode" IN ('light', 'dark', 'system'))
);
