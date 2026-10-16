-- ADR-0188 slice S9: the SPIFFE trust bundles move from the `REGULAIT_SPIFFE_TRUST_BUNDLES` environment variable into
-- audited storage (S5 security review: "the SPIFFE trust bundles move from environment variables into audited storage
-- in S9"). Hand-authored (never drizzle-kit generate). Re-runnable: every statement is idempotent.
--
-- One row per uploaded bundle: the PUBLIC X.509 authorities of one trust domain, never a private key. At most one
-- ACTIVE bundle per trust domain (partial unique index). Uploading a new bundle for a domain supersedes the active one
-- (rotation: nothing is revoked; tokens already issued live to their own expiry). Revoking a bundle ends that domain's
-- SPIFFE trust, and the gateway revokes every token and grant a SPIFFE ID credential in the domain authenticated
-- (decision 12). Rows are never deleted, their content never changes, and each lifecycle stamp is written once.
--
-- Built as for a first load (ADR-0180): the table starts EMPTY, so SPIFFE client authentication is OFF until an admin
-- uploads a bundle (decision 10: `spiffe_trust_bundles` empty). The environment variable is NOT imported: an install
-- that set it has SPIFFE off after this migration until an admin uploads the bundle through the audited route. The
-- gateway's boot log and the bundle list say the variable is ignored.

CREATE TABLE IF NOT EXISTS "spiffe_trust_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trust_domain" text NOT NULL,
  "format" text NOT NULL,
  "authorities_pem" text NOT NULL,
  "authorities" jsonb NOT NULL,
  "digest" text NOT NULL,
  "jwt_authorities_ignored" integer DEFAULT 0 NOT NULL,
  -- the acting principal, as in audit_log.user_id (no foreign key: the system principal acts for the bootstrap token)
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "superseded_at" timestamp with time zone,
  -- deferred: the replacing row is inserted after the old one is superseded (the one-active index allows no overlap)
  "superseded_by_bundle_id" uuid REFERENCES "spiffe_trust_bundles"("id") DEFERRABLE INITIALLY DEFERRED,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid,
  CONSTRAINT "spiffe_trust_bundles_trust_domain_check" CHECK ("trust_domain" ~ '^[a-z0-9._-]{1,255}$'),
  CONSTRAINT "spiffe_trust_bundles_format_check" CHECK ("format" IN ('pem', 'spiffe_jwks')),
  CONSTRAINT "spiffe_trust_bundles_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "spiffe_trust_bundles_authorities_check" CHECK (
    jsonb_typeof("authorities") = 'array' AND jsonb_array_length("authorities") BETWEEN 1 AND 64
  ),
  -- PUBLIC authorities only: a PEM that carries any private key block is refused by the gateway and by this CHECK
  CONSTRAINT "spiffe_trust_bundles_public_only_check" CHECK (position('PRIVATE KEY' in "authorities_pem") = 0),
  CONSTRAINT "spiffe_trust_bundles_jwt_ignored_check" CHECK ("jwt_authorities_ignored" >= 0),
  -- superseded and revoked each come as a pair, never both, and never before the row was created
  CONSTRAINT "spiffe_trust_bundles_lifecycle_check" CHECK (
    ("superseded_at" IS NULL) = ("superseded_by_bundle_id" IS NULL)
    AND ("revoked_at" IS NULL) = ("revoked_by" IS NULL)
    AND NOT ("superseded_at" IS NOT NULL AND "revoked_at" IS NOT NULL)
    AND ("superseded_at" IS NULL OR "superseded_at" >= "created_at")
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);
--> statement-breakpoint
-- at most one active bundle per trust domain
CREATE UNIQUE INDEX IF NOT EXISTS "spiffe_trust_bundles_one_active_uq" ON "spiffe_trust_bundles" ("trust_domain")
  WHERE "superseded_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
-- a bundle is never deleted; its content is written once; superseding or revoking it happens once and is final
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
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR OLD."superseded_at" IS NOT NULL OR OLD."revoked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'spiffe_trust_bundles: a bundle''s content is written once, and a superseded or revoked bundle is final'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "spiffe_trust_bundles_guard" ON "spiffe_trust_bundles";
--> statement-breakpoint
CREATE TRIGGER "spiffe_trust_bundles_guard"
  BEFORE UPDATE OR DELETE ON "spiffe_trust_bundles"
  FOR EACH ROW EXECUTE FUNCTION "regulait_spiffe_trust_bundle_guard"();
--> statement-breakpoint
-- migration 0185's rule: a table that refuses row DELETE also refuses TRUNCATE (which fires no row trigger)
DROP TRIGGER IF EXISTS "spiffe_trust_bundles_no_truncate" ON public."spiffe_trust_bundles";
--> statement-breakpoint
CREATE TRIGGER "spiffe_trust_bundles_no_truncate" BEFORE TRUNCATE ON public."spiffe_trust_bundles"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
