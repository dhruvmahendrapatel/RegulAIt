-- ADR-0195 SD2b: the RS256 federation signing keys of RegulAIt's cloud workload identity federation issuer
-- (`<REGULAIT_PUBLIC_URL>/federation`). Hand-authored (never drizzle-kit generate). The journal entry is added by
-- the master once 0204 is journalled.
--
-- Separate from identity_signing_keys so the Ed25519 verifier's CHECKs, its one-active index and the issued_tokens
-- FK are untouched. The private half is a data-key envelope (CIPHERTEXT_COLUMNS); a retired or revoked key's is
-- destroyed in the same update. The 0185 rules hold: the guard function pins its search_path, and the table that
-- refuses row UPDATE/DELETE also refuses TRUNCATE.
CREATE TABLE "federation_signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kid" text NOT NULL,
  "algorithm" text DEFAULT 'RS256' NOT NULL,
  "public_jwk" jsonb NOT NULL,
  "private_key_ciphertext" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "federation_signing_keys_kid_uq" UNIQUE ("kid"),
  CONSTRAINT "federation_signing_keys_kid_check" CHECK ("kid" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "federation_signing_keys_algorithm_check" CHECK ("algorithm" = 'RS256'),
  CONSTRAINT "federation_signing_keys_public_only_check" CHECK (
    COALESCE(
      jsonb_typeof("public_jwk") = 'object'
      AND "public_jwk" ->> 'kty' = 'RSA'
      AND "public_jwk" ->> 'e' = 'AQAB'
      AND jsonb_typeof("public_jwk" -> 'n') = 'string'
      AND length("public_jwk" ->> 'n') BETWEEN 342 AND 683
      AND NOT ("public_jwk" ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
      false
    )
  ),
  -- a live key holds its private half; a retired or revoked key never does
  CONSTRAINT "federation_signing_keys_private_check" CHECK (
    ("retired_at" IS NULL AND "revoked_at" IS NULL) = ("private_key_ciphertext" IS NOT NULL)
  ),
  CONSTRAINT "federation_signing_keys_order_check" CHECK (
    ("activated_at" IS NULL OR "activated_at" >= "created_at")
    AND ("retired_at" IS NULL OR ("activated_at" IS NOT NULL AND "retired_at" >= "activated_at"))
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "federation_signing_keys_one_active_uq" ON "federation_signing_keys" ((true))
  WHERE "activated_at" IS NOT NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
-- never deleted; identity and each lifecycle stamp written once; the ciphertext may be re-encrypted (data-key
-- rotation) while live, and once destroyed it never comes back
CREATE OR REPLACE FUNCTION public."regulait_federation_signing_key_guard"() RETURNS trigger
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'federation_signing_keys: a signing key is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."kid" IS DISTINCT FROM OLD."kid"
     OR NEW."algorithm" IS DISTINCT FROM OLD."algorithm" OR NEW."public_jwk" IS DISTINCT FROM OLD."public_jwk"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at")
     OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
     OR (OLD."private_key_ciphertext" IS NULL AND NEW."private_key_ciphertext" IS NOT NULL) THEN
    RAISE EXCEPTION 'federation_signing_keys: a key and each of its lifecycle stamps are written once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "federation_signing_keys_guard"
  BEFORE UPDATE OR DELETE ON "federation_signing_keys"
  FOR EACH ROW EXECUTE FUNCTION public."regulait_federation_signing_key_guard"();
--> statement-breakpoint
CREATE TRIGGER "federation_signing_keys_no_truncate" BEFORE TRUNCATE ON public."federation_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
