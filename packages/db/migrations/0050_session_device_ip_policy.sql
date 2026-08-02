-- Migration 0050 (ADR-0039) — session & device management: per-session
-- revocation surfaces need no DDL (revoked_at already exists and stays the ONE
-- way sessions die); this migration adds the device/network columns.
--
-- auth_sessions.last_seen_ip: where the session IS NOW, not only where it
-- started (`ip` stays the creation-time record). Updated on every
-- authenticated use in the SAME UPDATE as the idle-slide — no extra query.
-- Nullable: pre-0050 rows have no last-seen record and none is invented.
ALTER TABLE "auth_sessions" ADD COLUMN "last_seen_ip" text;
--> statement-breakpoint
-- The org network envelope: a jsonb array of CIDR blocks (IPv4 + IPv6).
-- NULL/empty = NO restriction (today's behaviour — the default must not lock
-- anyone out on upgrade). Malformed entries are refused at write time and
-- match NOTHING at evaluation time (fail closed per entry).
ALTER TABLE "org_settings" ADD COLUMN "session_ip_allowlist" jsonb;
--> statement-breakpoint
-- HUMAN-session policy (origins password | oidc | saml):
--   off (default)        = no IP restriction — today's behaviour.
--   enforce_at_login     = a NEW human session may only be CREATED from an
--                          allow-listed CIDR (401 + audit, no cookie minted);
--                          existing sessions are unaffected.
--   enforce_continuous   = EVERY authenticated use is checked; a request from
--                          outside the envelope is refused and the session
--                          force-revoked on the spot ("trusted network only").
-- Enforcement is fail-closed: an undeterminable client IP under an enforcing
-- policy is DENIED. No CHECK constraint, matching every other org_settings
-- text enum (mfa_required, budget_enforcement, ...) — the zod schema and the
-- drizzle enum are the walls.
ALTER TABLE "org_settings" ADD COLUMN "session_ip_policy" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
-- The SEPARATE, explicit knob for the automation path (header API-key auth
-- and origin='api_key' exchanged sessions). Same value shape as
-- session_ip_policy and evaluated against the SAME session_ip_allowlist —
-- "same shape" per the ADR means the same policy levels over the same CIDR
-- envelope; what is separate is WHICH paths it governs, so tightening the
-- human policy can never silently lock out CI, and neither knob can EXEMPT
-- the other's path. The bootstrap origin (deploy-time break-glass) is never
-- IP-restricted by either knob.
ALTER TABLE "org_settings" ADD COLUMN "api_key_ip_policy" text DEFAULT 'off' NOT NULL;
