-- ADR-0210: an OIDC-compatible MCP identity assertion (per server, opt-in) — an ES256 issuer key beside Ed25519, and
-- the per-server profile and scope. Hand-authored (never drizzle-kit generate). Nothing is backfilled: every server
-- keeps the S8 default (`regulait_header`, no scope), and no ES256 key exists until an operator configures one.
--
-- 1. identity_signing_keys may hold ES256 (P-256) keys. Public halves only, as before; the CHECK is per algorithm. One
--    active signer PER ALGORITHM, so an ES256 key never retires the Ed25519 signer (or the reverse). The 0180 guard
--    (algorithm and public_jwk written once) is unchanged, and it already pins its search_path (0185).
-- 2. mcp_servers gains identity_assertion_profile and identity_assertion_scope. `oidc_bearer` needs signed_assertion
--    propagation and an RFC 6749 scope; the default profile carries no scope. The mutual exclusion with an ADR-0204
--    Bearer credential spans two tables and is enforced by both writers under the server row's lock.
-- No new function or trigger, so nothing here falls under the 0185 search_path or TRUNCATE invariants.

ALTER TABLE "identity_signing_keys" DROP CONSTRAINT IF EXISTS "identity_signing_keys_algorithm_check";
--> statement-breakpoint
ALTER TABLE "identity_signing_keys" ADD CONSTRAINT "identity_signing_keys_algorithm_check" CHECK ("algorithm" IN ('Ed25519', 'ES256'));
--> statement-breakpoint
ALTER TABLE "identity_signing_keys" DROP CONSTRAINT IF EXISTS "identity_signing_keys_public_only_check";
--> statement-breakpoint
ALTER TABLE "identity_signing_keys" ADD CONSTRAINT "identity_signing_keys_public_only_check" CHECK (
  COALESCE(
    jsonb_typeof("public_jwk") = 'object'
    AND (
      ("algorithm" = 'Ed25519' AND "public_jwk" ->> 'kty' = 'OKP' AND "public_jwk" ->> 'crv' = 'Ed25519'
        AND jsonb_typeof("public_jwk" -> 'x') = 'string')
      OR ("algorithm" = 'ES256' AND "public_jwk" ->> 'kty' = 'EC' AND "public_jwk" ->> 'crv' = 'P-256'
        AND jsonb_typeof("public_jwk" -> 'x') = 'string' AND jsonb_typeof("public_jwk" -> 'y') = 'string')
    )
    AND NOT ("public_jwk" ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
    false
  )
);
--> statement-breakpoint
DROP INDEX IF EXISTS "identity_signing_keys_one_active_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_signing_keys_one_active_uq" ON "identity_signing_keys" ("algorithm")
  WHERE "activated_at" IS NOT NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "identity_assertion_profile" text DEFAULT 'regulait_header' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "identity_assertion_scope" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT IF EXISTS "mcp_servers_identity_assertion_profile_check";
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_identity_assertion_profile_check" CHECK (
  ("identity_assertion_profile" = 'regulait_header' AND "identity_assertion_scope" IS NULL)
  OR (
    "identity_assertion_profile" = 'oidc_bearer'
    AND "identity_propagation" = 'signed_assertion'
    AND length("identity_assertion_scope") BETWEEN 1 AND 512
    AND "identity_assertion_scope" ~ '^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$'
  )
);
