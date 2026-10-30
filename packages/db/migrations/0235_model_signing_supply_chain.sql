-- ADR-0216 (P14 + P15): model-file signatures and the model supply-chain block. Hand-authored (never drizzle-kit
-- generate). Re-runnable: every statement is idempotent.
--
-- 1. `model_signing_keys`: the trust roots an admin configures for air-gapped, key-based verification of the OpenSSF
--    model-signing format (a Sigstore bundle with a DSSE envelope). Public keys only (no secret is held). The key hint
--    is the sha256 of the key's PEM, as the format writes it into the bundle. A key is never deleted; it only gains
--    its revocation, once (the guard below), so a past verification can always name the key it rested on.
-- 2. `model_artifact_signatures`: every signature presented for an artifact, at upload or attached later, with the
--    gateway's verdict. The newest row is the artifact's signature; it is re-verified on every gated read.
-- 3. `model_artifact_supply_chain_relaxations`: an admin's per-artifact relaxation of named failing conditions, with
--    a reason and an expiry of at most 30 days (ADR-0180). One in force per artifact; a row only gains its clearing.
CREATE TABLE IF NOT EXISTS "model_signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "algorithm" text NOT NULL,
  "public_key_pem" text NOT NULL,
  "key_hint" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "model_signing_keys_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  CONSTRAINT "model_signing_keys_algorithm_check" CHECK ("algorithm" IN ('ecdsa_p256_sha256')),
  CONSTRAINT "model_signing_keys_hint_check" CHECK ("key_hint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_signing_keys_pem_check" CHECK (length("public_key_pem") BETWEEN 1 AND 4096)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_signing_keys_hint_unique" ON "model_signing_keys" ("key_hint");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "model_signing_keys_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model_signing_keys rows are never deleted; revoke the key (ADR-0216)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revoked_at" IS NOT NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."algorithm" IS DISTINCT FROM OLD."algorithm"
     OR NEW."public_key_pem" IS DISTINCT FROM OLD."public_key_pem"
     OR NEW."key_hint" IS DISTINCT FROM OLD."key_hint"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."revoked_at" IS NULL THEN
    RAISE EXCEPTION 'a model_signing_keys row only gains its revocation, once (ADR-0216)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "model_signing_keys_guard" ON "model_signing_keys";
--> statement-breakpoint
CREATE TRIGGER "model_signing_keys_guard" BEFORE UPDATE OR DELETE ON "model_signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "model_signing_keys_guard"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_artifact_signatures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "model_artifacts"("id") ON DELETE CASCADE,
  "artifact_sha256" text NOT NULL,
  "bundle" jsonb NOT NULL,
  "status" text NOT NULL,
  "failure" text,
  "signing_key_id" uuid REFERENCES "model_signing_keys"("id") ON DELETE RESTRICT,
  "key_hint" text,
  "signed_name" text,
  "resource_name" text,
  "phase" text NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_artifact_signatures_sha256_check" CHECK ("artifact_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_artifact_signatures_status_check" CHECK ("status" IN ('verified', 'failed')),
  CONSTRAINT "model_artifact_signatures_failure_check" CHECK (
    ("status" = 'verified' AND "failure" IS NULL AND "signing_key_id" IS NOT NULL)
    OR ("status" = 'failed' AND "failure" ~ '^[a-z][a-z0-9_]{0,63}$')
  ),
  CONSTRAINT "model_artifact_signatures_hint_check" CHECK ("key_hint" IS NULL OR "key_hint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_artifact_signatures_phase_check" CHECK ("phase" IN ('upload', 'attach'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_artifact_signatures_artifact_idx" ON "model_artifact_signatures" ("artifact_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_artifact_signatures_key_idx" ON "model_artifact_signatures" ("signing_key_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_artifact_supply_chain_relaxations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL REFERENCES "model_artifacts"("id") ON DELETE CASCADE,
  "artifact_sha256" text NOT NULL,
  "conditions" text[] NOT NULL,
  "reason" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone,
  "cleared_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "model_artifact_supply_chain_relaxations_sha256_check" CHECK ("artifact_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "model_artifact_supply_chain_relaxations_conditions_check" CHECK (
    cardinality("conditions") BETWEEN 1 AND 3 AND "conditions" <@ ARRAY['unsigned', 'unscanned', 'unsafe_format']::text[]
  ),
  CONSTRAINT "model_artifact_supply_chain_relaxations_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1000),
  CONSTRAINT "model_artifact_supply_chain_relaxations_expiry_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'
  ),
  CONSTRAINT "model_artifact_supply_chain_relaxations_cleared_check" CHECK ("cleared_by_user_id" IS NULL OR "cleared_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_artifact_supply_chain_relaxations_active_unique"
  ON "model_artifact_supply_chain_relaxations" ("artifact_id") WHERE "cleared_at" IS NULL;
--> statement-breakpoint
-- a row only gains its clearing, once (an artifact's deletion removes its rows; that delete is itself audited)
CREATE OR REPLACE FUNCTION "model_artifact_supply_chain_relaxations_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."cleared_at" IS NOT NULL
     OR NEW."cleared_at" IS NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"
     OR NEW."artifact_sha256" IS DISTINCT FROM OLD."artifact_sha256"
     OR NEW."conditions" IS DISTINCT FROM OLD."conditions"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'a model_artifact_supply_chain_relaxations row only gains its clearing, once (ADR-0216)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "model_artifact_supply_chain_relaxations_guard" ON "model_artifact_supply_chain_relaxations";
--> statement-breakpoint
CREATE TRIGGER "model_artifact_supply_chain_relaxations_guard" BEFORE UPDATE ON "model_artifact_supply_chain_relaxations"
  FOR EACH ROW EXECUTE FUNCTION "model_artifact_supply_chain_relaxations_guard"();
