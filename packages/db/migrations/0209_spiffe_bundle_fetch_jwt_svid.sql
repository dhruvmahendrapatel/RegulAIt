-- ADR-0188 S9 follow-ups: SPIFFE bundle endpoint fetch, and JWT-SVID client authentication.
-- Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- 1. `spiffe_trust_bundles` keeps the bundle's JWT authorities (`jwt-svid` keys, PUBLIC JWKs only), where S9 counted
--    and dropped them, and records where a bundle came from (`upload` by an admin, or `fetch` from the domain's bundle
--    endpoint) with a fetched bundle's `spiffe_sequence`. Every bundle recorded before this migration was uploaded
--    and keeps its X.509 authorities only (`jwt_authorities` empty): nothing is backfilled, so a domain verifies no
--    JWT-SVID until a bundle carrying its JWT authorities is uploaded or fetched (ADR-0180, as for a first load).
-- 2. `spiffe_bundle_endpoints`: one row per trust domain an admin configured to fetch (SPIFFE Federation §5). The
--    table starts EMPTY: no bundle is fetched until an admin sets an endpoint (the strict default).
-- 3. `org_settings.workload_client_auth_methods` may name `spiffe_jwt_svid`. The column default is unchanged (the four
--    methods of migration 0180), so JWT-SVID client authentication is OFF until an admin adds it (a relaxation).

ALTER TABLE "spiffe_trust_bundles" ADD COLUMN IF NOT EXISTS "jwt_authorities" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" ADD COLUMN IF NOT EXISTS "jwt_authority_views" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'upload' NOT NULL;
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" ADD COLUMN IF NOT EXISTS "sequence" bigint;
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" DROP CONSTRAINT IF EXISTS "spiffe_trust_bundles_jwt_authorities_check";
--> statement-breakpoint
-- at most 64 JWT authorities, one view per authority, and never a private JWK member
ALTER TABLE "spiffe_trust_bundles" ADD CONSTRAINT "spiffe_trust_bundles_jwt_authorities_check" CHECK (
  jsonb_typeof("jwt_authorities") = 'array' AND jsonb_array_length("jwt_authorities") <= 64
  AND jsonb_typeof("jwt_authority_views") = 'array'
  AND jsonb_array_length("jwt_authority_views") = jsonb_array_length("jwt_authorities")
  AND NOT jsonb_path_exists("jwt_authorities",
    '$[*] ? (exists(@.d) || exists(@.p) || exists(@.q) || exists(@.dp) || exists(@.dq) || exists(@.qi) || exists(@.oth) || exists(@.k))')
);
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" DROP CONSTRAINT IF EXISTS "spiffe_trust_bundles_source_check";
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" ADD CONSTRAINT "spiffe_trust_bundles_source_check" CHECK ("source" IN ('upload', 'fetch'));
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" DROP CONSTRAINT IF EXISTS "spiffe_trust_bundles_sequence_check";
--> statement-breakpoint
ALTER TABLE "spiffe_trust_bundles" ADD CONSTRAINT "spiffe_trust_bundles_sequence_check" CHECK (
  "sequence" IS NULL OR ("source" = 'fetch' AND "sequence" >= 0)
);
--> statement-breakpoint
-- migration 0199's guard, with the new content columns written once too (search_path pinned, migration 0185)
CREATE OR REPLACE FUNCTION "regulait_spiffe_trust_bundle_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'spiffe_trust_bundles: a trust bundle is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."trust_domain" IS DISTINCT FROM OLD."trust_domain"
     OR NEW."format" IS DISTINCT FROM OLD."format" OR NEW."authorities_pem" IS DISTINCT FROM OLD."authorities_pem"
     OR NEW."authorities" IS DISTINCT FROM OLD."authorities" OR NEW."digest" IS DISTINCT FROM OLD."digest"
     OR NEW."jwt_authorities_ignored" IS DISTINCT FROM OLD."jwt_authorities_ignored"
     OR NEW."jwt_authorities" IS DISTINCT FROM OLD."jwt_authorities"
     OR NEW."jwt_authority_views" IS DISTINCT FROM OLD."jwt_authority_views"
     OR NEW."source" IS DISTINCT FROM OLD."source" OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."superseded_at" IS NOT NULL OR OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'spiffe_trust_bundles: a bundle''s content is written once, and a superseded or revoked bundle is final'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spiffe_bundle_endpoints" (
  "trust_domain" text PRIMARY KEY NOT NULL,
  "url" text NOT NULL,
  "profile" text NOT NULL,
  "endpoint_spiffe_id" text,
  "enabled" boolean NOT NULL,
  "next_refresh_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_error_code" text,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "trust_until" timestamp with time zone,
  -- the acting principal, as in audit_log.user_id (no foreign key: the system principal acts for the bootstrap token)
  "updated_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "spiffe_bundle_endpoints_trust_domain_check" CHECK ("trust_domain" ~ '^[a-z0-9._-]{1,255}$'),
  -- https only, and no userinfo in the authority (SPIFFE Federation §5.2.1.1 and §5.2.2.1)
  CONSTRAINT "spiffe_bundle_endpoints_url_check" CHECK (length("url") <= 2048 AND "url" ~ '^https://[^/@]+(/|$)'),
  CONSTRAINT "spiffe_bundle_endpoints_profile_check" CHECK ("profile" IN ('https_web', 'https_spiffe')),
  -- https_spiffe names the endpoint server's SPIFFE ID; https_web names none
  CONSTRAINT "spiffe_bundle_endpoints_spiffe_id_check" CHECK (
    ("profile" = 'https_spiffe') = ("endpoint_spiffe_id" IS NOT NULL)
    AND ("endpoint_spiffe_id" IS NULL OR (
      length("endpoint_spiffe_id") <= 2048
      AND "endpoint_spiffe_id" ~ '^spiffe://[a-z0-9._-]{1,255}(/[A-Za-z0-9._-]+)+$'
    ))
  ),
  CONSTRAINT "spiffe_bundle_endpoints_failures_check" CHECK ("consecutive_failures" >= 0),
  -- a failure is recorded as a code, never as response text
  CONSTRAINT "spiffe_bundle_endpoints_error_code_check" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_workload_client_auth_methods_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_workload_client_auth_methods_check" CHECK (
  jsonb_typeof("workload_client_auth_methods") = 'array'
  AND "workload_client_auth_methods" <@ '["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid", "spiffe_jwt_svid"]'::jsonb
);
