-- ADR-0207 (G6) — the PM webhook secret can be rotated with a 24-hour overlap. Hand-authored (never drizzle-kit
-- generate).
--
-- 1. THE PREVIOUS-SECRET SLOT, three columns: the previous secret's sha256 (the legacy header check), its data-key
--    envelope (HMAC verification needs the secret itself; registered in CIPHERTEXT_COLUMNS for the custody probe and
--    the re-encryption walk) and when it stops being accepted. All three are set together or all are NULL.
-- 2. The window is decided on the DATABASE clock: the rotate route writes `now() + interval '24 hours'` and the webhook
--    reads `previous_webhook_secret_valid_until > now()`. An expired slot is inert; the next rotation overwrites it.
-- 3. Nothing is backfilled: no existing connection has a previous secret.

ALTER TABLE "pm_connections" ADD COLUMN IF NOT EXISTS "previous_webhook_secret_hash" text;
--> statement-breakpoint
ALTER TABLE "pm_connections" ADD COLUMN IF NOT EXISTS "previous_webhook_secret_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "pm_connections" ADD COLUMN IF NOT EXISTS "previous_webhook_secret_valid_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pm_connections" DROP CONSTRAINT IF EXISTS "pm_connections_previous_secret_check";
--> statement-breakpoint
ALTER TABLE "pm_connections" ADD CONSTRAINT "pm_connections_previous_secret_check" CHECK (
  ("previous_webhook_secret_hash" IS NULL AND "previous_webhook_secret_ciphertext" IS NULL
    AND "previous_webhook_secret_valid_until" IS NULL)
  OR ("previous_webhook_secret_hash" IS NOT NULL AND "previous_webhook_secret_valid_until" IS NOT NULL)
);
