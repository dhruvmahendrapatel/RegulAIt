-- ADR-0098 — API-KEY EXPIRY. The most privileged credential in this product
-- finally gets a lifetime.
--
-- THE GAP. `api_keys` carried `created_at`, `last_used_at` and `revoked_at`
-- and NOTHING ELSE. An API key is what authenticates the MCP proxy and the
-- whole programmatic surface, so until this migration the single most
-- privileged credential RegulAIt issues was the only one with no expiry at
-- all. Sessions have a real lifetime and idle window (ADR-0025/0039); virtual
-- keys have an optional `expires_at` with issuer-only extension (ADR-0066 §2).
-- API keys were the outlier, and the outlier in the wrong direction.
--
-- WHAT THIS MIGRATION ADDS, AND THE ONE THING THAT MATTERS ABOUT ITS DEFAULTS:
--
--   `api_keys.expires_at` is NULLABLE with NO default, so EVERY EXISTING ROW
--   GETS NULL and NULL MEANS "never expires". An upgrade must not silently
--   invalidate every key in a running install — an install that upgrades on a
--   Tuesday afternoon does not lose its CI, its IDE integrations and its MCP
--   clients at the same instant. Existing keys keep working exactly as they
--   did, until an operator decides otherwise by issuing new ones.
--
--   `org_settings.api_key_default_ttl_days` DEFAULT NULL — no default
--   lifetime, so a key issued after this migration ALSO never expires unless
--   an admin sets the knob. That is what makes the whole slice byte-identical
--   at the shipped settings, and it is ADR-0021's "a fresh settings row
--   changes nothing" invariant held one more time.
--
--   `org_settings.api_key_max_ttl_days` DEFAULT NULL — no ceiling. When an
--   admin sets one, a request for a longer lifetime (INCLUDING an explicit
--   request for no expiry at all) is REFUSED BY NAME with a 422 rather than
--   silently clamped. A clamp hands somebody a credential with a lifetime
--   they did not ask for and were never told about, and they discover it when
--   it stops working.
--
-- RECOMMENDED PRODUCTION SETTINGS: default 90 days, ceiling 365 days. They are
-- deliberately NOT set here. A migration that starts expiring live credentials
-- is how a security control gets turned back off permanently — the same
-- reasoning ADR-0097 recorded for `mcp_admission_mode` one migration ago.
--
-- ENFORCEMENT is in `authenticate()` (apps/gateway/src/auth.ts), the ONE place
-- a bearer token becomes an identity. An expired key is refused with its OWN
-- named reason (`api_key_expired`), distinct from a revoked one
-- (`api_key_revoked`), and both write their own audit row — an operator
-- debugging "my key stopped working" must be able to tell which happened.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_expires_at_idx"
  ON "api_keys" ("expires_at");
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "api_key_default_ttl_days" integer;
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD COLUMN IF NOT EXISTS "api_key_max_ttl_days" integer;
--> statement-breakpoint
ALTER TABLE "org_settings"
  DROP CONSTRAINT IF EXISTS "org_settings_api_key_default_ttl_days_check";
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_api_key_default_ttl_days_check"
  CHECK ("api_key_default_ttl_days" IS NULL
         OR ("api_key_default_ttl_days" >= 1 AND "api_key_default_ttl_days" <= 3650));
--> statement-breakpoint
ALTER TABLE "org_settings"
  DROP CONSTRAINT IF EXISTS "org_settings_api_key_max_ttl_days_check";
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_api_key_max_ttl_days_check"
  CHECK ("api_key_max_ttl_days" IS NULL
         OR ("api_key_max_ttl_days" >= 1 AND "api_key_max_ttl_days" <= 3650));
--> statement-breakpoint
ALTER TABLE "org_settings"
  DROP CONSTRAINT IF EXISTS "org_settings_api_key_ttl_ordering_check";
--> statement-breakpoint
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_api_key_ttl_ordering_check"
  CHECK ("api_key_default_ttl_days" IS NULL
         OR "api_key_max_ttl_days" IS NULL
         OR "api_key_default_ttl_days" <= "api_key_max_ttl_days");
