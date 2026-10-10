-- ADR-0188 (batch 6 item 1) S1 — per-agent and workload identity, and
-- constrained delegation: THE FOUNDATION. Tables and invariants only; nothing
-- here mints, verifies, allocates or wires anything (S2–S9 do).
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785115000000
-- (0175's when + 5,000,000: 0177–0179 may be taken by other branches,
-- CONTRIBUTING_PARALLEL_SESSIONS §4.1).
--
--  1. `workload_identities` — an agent principal (decision 2): one identity per
--     subject, exactly the subject FK its kind names (CHECK), a SPIFFE ID as its
--     identifier, one or more stewards, `revoked` terminal (trigger).
--  1b. `identity_tool_grants`, `identity_server_grants`, `identity_agent_grants`,
--     `identity_connector_grants`, `identity_role_assignments` — an agent's OWN
--     grants (decision 3), parallel to a user's; default-deny, empty at start
--     (decision 24, OWNER DECISION 1).
--  2. `workload_credentials` — PUBLIC halves only: an Ed25519/P-256 JWK with
--     no private member, an X.509 thumbprint + SAN, or a SPIFFE ID; at most 90
--     days (CHECK). No shared secret column exists.
--  3. `identity_signing_keys` — the gateway issuer's Ed25519 PUBLIC keys
--     (decision 5); never deleted; a revoked key is never revived.
--  4. `delegation_grants` (decisions 4, 12, 17, 22) — path/depth/root
--     consistency (CHECK + trigger against the parent row), subset lifetime,
--     immutable except revocation and spend, non-negative micro-dollar
--     balances; `delegation_allocations` (one per parent→child edge) and
--     `delegation_charges` (one per usage row, settled once).
--  5. `issued_tokens` (decision 12) — every external token is sender-bound
--     (`dpop` or `mtls`, never bearer) and at most an hour long.
--  6. `replay_claims` (decision 14) — namespaced atomic claims.
--  7. `audit_chain_versions` (decision 19) — the append-only, verifier-trusted
--     v2 boundary; `audit_log` gains the three actor columns and
--     `chain_version`; `trace_spans` and `usage_events` gain the actor columns.
--     The cutover itself is NOT run here (S4).
--  8. `mcp_servers.identity_propagation` (decision 8, OWNER DECISION 6): `none`.
--  9. The step-up kind `identity_manage`, required on the existing org row.
-- 10. Six strict org settings (decision 10; OWNER DECISION 7), written onto the
--     existing row as on a first load (ADR-0180, no grandfathering).

-- ===== 1. workload identities ================================================
-- does every element of a text array match a pattern? (a CHECK cannot hold a subquery)
CREATE OR REPLACE FUNCTION "regulait_text_array_matches"("arr" text[], "pattern" text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(bool_and(e ~ "pattern"), true) FROM unnest("arr") AS e $$;
--> statement-breakpoint
CREATE TABLE "workload_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE RESTRICT,
  "builder_agent_id" uuid REFERENCES "builder_agents"("id") ON DELETE RESTRICT,
  "engine_runner_id" uuid REFERENCES "engine_runners"("id") ON DELETE RESTRICT,
  "identifier" text NOT NULL,
  "sponsor_user_ids" uuid[] NOT NULL,
  "environments" text[] DEFAULT '{}'::text[] NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workload_identities_identifier_uq" UNIQUE ("identifier"),
  -- one identity per subject (decision 2)
  CONSTRAINT "workload_identities_agent_uq" UNIQUE ("agent_id"),
  CONSTRAINT "workload_identities_builder_agent_uq" UNIQUE ("builder_agent_id"),
  CONSTRAINT "workload_identities_engine_runner_uq" UNIQUE ("engine_runner_id"),
  CONSTRAINT "workload_identities_kind_check" CHECK ("kind" IN ('agent', 'builder_agent', 'engine_runner', 'worker_runtime', 'pdp')),
  -- exactly the subject FK the kind names, and none for the external kinds
  CONSTRAINT "workload_identities_subject_check" CHECK (
    ("kind" = 'agent' AND "agent_id" IS NOT NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
    OR ("kind" = 'builder_agent' AND "agent_id" IS NULL AND "builder_agent_id" IS NOT NULL AND "engine_runner_id" IS NULL)
    OR ("kind" = 'engine_runner' AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NOT NULL)
    OR ("kind" IN ('worker_runtime', 'pdp') AND "agent_id" IS NULL AND "builder_agent_id" IS NULL AND "engine_runner_id" IS NULL)
  ),
  -- a SPIFFE ID (and so a WIMSE identifier); `.` and `..` segments are refused
  CONSTRAINT "workload_identities_identifier_check" CHECK (
    length("identifier") <= 2048
    AND "identifier" ~ '^spiffe://[a-z0-9._-]{1,255}(/[A-Za-z0-9._-]+)+$'
    AND "identifier" !~ '/\.\.?(/|$)'
  ),
  -- one to ten stewards, no duplicates, no NULL member
  CONSTRAINT "workload_identities_sponsors_check" CHECK (
    cardinality("sponsor_user_ids") BETWEEN 1 AND 10
    AND array_position("sponsor_user_ids", NULL) IS NULL
  ),
  CONSTRAINT "workload_identities_environments_check" CHECK (
    cardinality("environments") <= 20
    AND array_position("environments", NULL) IS NULL
    AND "regulait_text_array_matches"("environments", '^[a-z0-9][a-z0-9_.-]{0,63}$')
  ),
  CONSTRAINT "workload_identities_status_check" CHECK ("status" IN ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX "workload_identities_status_idx" ON "workload_identities" ("status");
--> statement-breakpoint
CREATE INDEX "workload_identities_sponsors_gin" ON "workload_identities" USING gin ("sponsor_user_ids");
--> statement-breakpoint
-- the kind, subject and identifier never change; `revoked` is terminal; never deleted
CREATE OR REPLACE FUNCTION "regulait_workload_identity_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workload_identities: an identity is never deleted (revoke it)'
      USING ERRCODE = 'insufficient_privilege', HINT = 'audit rows name identity ids (ADR-0188 decision 12)';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."agent_id" IS DISTINCT FROM OLD."agent_id"
     OR NEW."builder_agent_id" IS DISTINCT FROM OLD."builder_agent_id"
     OR NEW."engine_runner_id" IS DISTINCT FROM OLD."engine_runner_id"
     OR NEW."identifier" IS DISTINCT FROM OLD."identifier"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'workload_identities: kind, subject and identifier are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'revoked' AND NEW."status" <> 'revoked' THEN
    RAISE EXCEPTION 'workload_identities: a revoked identity is never reinstated'
      USING ERRCODE = 'insufficient_privilege', HINT = 'create a new identity (ADR-0188 decision 12)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workload_identities_guard"
  BEFORE UPDATE OR DELETE ON "workload_identities"
  FOR EACH ROW EXECUTE FUNCTION "regulait_workload_identity_guard"();
--> statement-breakpoint

-- ===== 1b. an agent principal's OWN grants (decision 3; decision 24) ==========
-- Parallel tables, the exact twins of a user's `tool_grants`, `server_grants`,
-- `agent_grants`, `connector_grants` and `role_assignments`, keyed by
-- `identity_id`. Default-deny: no row, no right, and every identity starts
-- with none (OWNER DECISION 1, no grandfathering). Unlike a user's grants,
-- `allowed_modes` and `allowed_objects` are NOT NULL: an agent never gets
-- "every mode / every object" implicitly (decision 27). The governed object's
-- deletion removes the grant (as for users); the identity is never deleted.
CREATE TABLE "identity_tool_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "tool_name" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_tool_grants_tool_name_check" CHECK (length("tool_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_tool_grants_identity_server_tool_uq" ON "identity_tool_grants" ("identity_id", "server_id", "tool_name");
--> statement-breakpoint
CREATE TABLE "identity_server_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "server_id" uuid NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "read_only_all" boolean DEFAULT false NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_server_grants_identity_server_uq" ON "identity_server_grants" ("identity_id", "server_id");
--> statement-breakpoint
CREATE TABLE "identity_agent_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "allowed_modes" jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_agent_grants_allowed_modes_check" CHECK (
    jsonb_typeof("allowed_modes") = 'array' AND jsonb_array_length("allowed_modes") <= 20
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_agent_grants_identity_agent_uq" ON "identity_agent_grants" ("identity_id", "agent_id");
--> statement-breakpoint
CREATE TABLE "identity_connector_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "connector_id" uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  "mode" text NOT NULL,
  "allowed_objects" jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "identity_connector_grants_mode_check" CHECK ("mode" IN ('read', 'readwrite')),
  CONSTRAINT "identity_connector_grants_allowed_objects_check" CHECK (
    jsonb_typeof("allowed_objects") = 'array' AND jsonb_array_length("allowed_objects") <= 500
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_connector_grants_identity_connector_uq" ON "identity_connector_grants" ("identity_id", "connector_id");
--> statement-breakpoint
-- an agent role assignment: the identity holds the role's tool/server/agent/connector grants
CREATE TABLE "identity_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "identity_role_assignments_identity_role_uq" ON "identity_role_assignments" ("identity_id", "role_id");
--> statement-breakpoint

-- ===== 2. workload credentials: PUBLIC halves only ===========================
CREATE TABLE "workload_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL,
  "public_jwk" jsonb,
  "jwk_thumbprint" text,
  "x5t_s256" text,
  "san_uri" text,
  "subject_dn" text,
  "spiffe_id" text,
  "self_signed" boolean DEFAULT false NOT NULL,
  "not_before" timestamp with time zone DEFAULT now() NOT NULL,
  "not_after" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workload_credentials_kind_check" CHECK ("kind" IN ('jwk', 'x509', 'spiffe_id')),
  -- each kind carries exactly its own fields
  CONSTRAINT "workload_credentials_shape_check" CHECK (
    ("kind" = 'jwk' AND "public_jwk" IS NOT NULL AND "jwk_thumbprint" IS NOT NULL
       AND "x5t_s256" IS NULL AND "san_uri" IS NULL AND "subject_dn" IS NULL AND "spiffe_id" IS NULL AND NOT "self_signed")
    OR ("kind" = 'x509' AND "public_jwk" IS NULL AND "jwk_thumbprint" IS NULL
       AND "x5t_s256" IS NOT NULL AND "spiffe_id" IS NULL)
    OR ("kind" = 'spiffe_id' AND "public_jwk" IS NULL AND "jwk_thumbprint" IS NULL
       AND "x5t_s256" IS NULL AND "san_uri" IS NULL AND "subject_dn" IS NULL AND "spiffe_id" IS NOT NULL AND NOT "self_signed")
  ),
  -- PUBLIC keys only: an Ed25519 (OKP) or P-256 (EC) JWK, and never a private
  -- or symmetric member (COALESCE: a missing member makes a test NULL, which a
  -- CHECK would pass)
  CONSTRAINT "workload_credentials_public_only_check" CHECK (
    "public_jwk" IS NULL OR COALESCE(
      jsonb_typeof("public_jwk") = 'object'
      AND (
        ("public_jwk" ->> 'kty' = 'OKP' AND "public_jwk" ->> 'crv' = 'Ed25519' AND jsonb_typeof("public_jwk" -> 'x') = 'string')
        OR ("public_jwk" ->> 'kty' = 'EC' AND "public_jwk" ->> 'crv' = 'P-256'
            AND jsonb_typeof("public_jwk" -> 'x') = 'string' AND jsonb_typeof("public_jwk" -> 'y') = 'string')
      )
      AND NOT ("public_jwk" ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
      false
    )
  ),
  CONSTRAINT "workload_credentials_jwk_thumbprint_check" CHECK ("jwk_thumbprint" IS NULL OR "jwk_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "workload_credentials_x5t_check" CHECK ("x5t_s256" IS NULL OR "x5t_s256" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "workload_credentials_san_uri_check" CHECK ("san_uri" IS NULL OR length("san_uri") BETWEEN 1 AND 2048),
  CONSTRAINT "workload_credentials_subject_dn_check" CHECK ("subject_dn" IS NULL OR length("subject_dn") BETWEEN 1 AND 1024),
  CONSTRAINT "workload_credentials_spiffe_id_check" CHECK (
    "spiffe_id" IS NULL OR (
      length("spiffe_id") <= 2048
      AND "spiffe_id" ~ '^spiffe://[a-z0-9._-]{1,255}(/[A-Za-z0-9._-]+)+$'
      AND "spiffe_id" !~ '/\.\.?(/|$)'
    )
  ),
  -- a registered credential is accepted at most 90 days (OWNER DECISION 7)
  CONSTRAINT "workload_credentials_window_check" CHECK (
    "not_after" > "not_before" AND "not_after" <= "not_before" + interval '90 days'
  ),
  CONSTRAINT "workload_credentials_revoked_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
--> statement-breakpoint
-- one key or certificate authenticates one identity, ever (a revoked one is not re-registered)
CREATE UNIQUE INDEX "workload_credentials_jwk_thumbprint_uq" ON "workload_credentials" ("jwk_thumbprint") WHERE "jwk_thumbprint" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "workload_credentials_x5t_uq" ON "workload_credentials" ("x5t_s256") WHERE "x5t_s256" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "workload_credentials_spiffe_id_live_uq" ON "workload_credentials" ("spiffe_id") WHERE "spiffe_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "workload_credentials_identity_idx" ON "workload_credentials" ("identity_id");
--> statement-breakpoint
-- the public half and its window are immutable; revocation is the only change and is never undone; never deleted
CREATE OR REPLACE FUNCTION "regulait_workload_credential_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workload_credentials: a credential is never deleted (revoke it)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'not_after']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'not_after']) THEN
    RAISE EXCEPTION 'workload_credentials: only revoked_at (and an earlier not_after, for rotation) may change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."not_after" > OLD."not_after" THEN
    RAISE EXCEPTION 'workload_credentials: not_after may only move earlier (rotation), never later'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
    RAISE EXCEPTION 'workload_credentials: a revoked credential is never revived'
      USING ERRCODE = 'insufficient_privilege', HINT = 'register a new credential (ADR-0188 decision 12)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workload_credentials_guard"
  BEFORE UPDATE OR DELETE ON "workload_credentials"
  FOR EACH ROW EXECUTE FUNCTION "regulait_workload_credential_guard"();
--> statement-breakpoint

-- ===== 3. the issuer's signing keys (PUBLIC halves) ==========================
CREATE TABLE "identity_signing_keys" (
  "kid" text PRIMARY KEY NOT NULL,
  "algorithm" text DEFAULT 'Ed25519' NOT NULL,
  "public_jwk" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "identity_signing_keys_kid_check" CHECK ("kid" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "identity_signing_keys_algorithm_check" CHECK ("algorithm" = 'Ed25519'),
  CONSTRAINT "identity_signing_keys_public_only_check" CHECK (
    COALESCE(
      jsonb_typeof("public_jwk") = 'object'
      AND "public_jwk" ->> 'kty' = 'OKP'
      AND "public_jwk" ->> 'crv' = 'Ed25519'
      AND jsonb_typeof("public_jwk" -> 'x') = 'string'
      AND NOT ("public_jwk" ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
      false
    )
  ),
  CONSTRAINT "identity_signing_keys_order_check" CHECK (
    ("activated_at" IS NULL OR "activated_at" >= "created_at")
    AND ("retired_at" IS NULL OR ("activated_at" IS NOT NULL AND "retired_at" >= "activated_at"))
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);
--> statement-breakpoint
-- at most one key signs at a time (rotation keeps the old one for verification until it is retired)
CREATE UNIQUE INDEX "identity_signing_keys_one_active_uq" ON "identity_signing_keys" ((true))
  WHERE "activated_at" IS NOT NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
-- retired public keys stay published for verification (decision 9); a revoked key is never revived
CREATE OR REPLACE FUNCTION "regulait_identity_signing_key_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity_signing_keys: a signing key is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."kid" IS DISTINCT FROM OLD."kid" OR NEW."algorithm" IS DISTINCT FROM OLD."algorithm"
     OR NEW."public_jwk" IS DISTINCT FROM OLD."public_jwk" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at")
     OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'identity_signing_keys: a key and each of its lifecycle stamps are written once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "identity_signing_keys_guard"
  BEFORE UPDATE OR DELETE ON "identity_signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "regulait_identity_signing_key_guard"();
--> statement-breakpoint

-- ===== 4. delegation grants, allocations and charges =========================
CREATE TABLE "delegation_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "root_grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "parent_grant_id" uuid REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "path" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "depth" integer NOT NULL,
  "sponsor_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "actor_identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "run_id" uuid,
  "builder_turn_id" uuid,
  "engine_run_id" uuid,
  "schedule_id" uuid,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE RESTRICT,
  "scope" jsonb NOT NULL,
  "cap_micros" bigint,
  "settled_micros" bigint DEFAULT 0 NOT NULL,
  "reserved_micros" bigint DEFAULT 0 NOT NULL,
  "environment" text NOT NULL,
  "audience" text,
  "auth_credential_id" uuid REFERENCES "workload_credentials"("id") ON DELETE RESTRICT,
  "subject_credential_id" uuid,
  "binding_kind" text NOT NULL,
  "binding_thumbprint" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- the stored chain is self-consistent (the trigger below checks it against the parent row)
  CONSTRAINT "delegation_grants_depth_check" CHECK ("depth" = cardinality("path") AND "depth" BETWEEN 0 AND 8),
  CONSTRAINT "delegation_grants_parent_check" CHECK (
    ("depth" = 0 AND "parent_grant_id" IS NULL AND "root_grant_id" = "id")
    OR ("depth" > 0 AND "parent_grant_id" IS NOT NULL
        AND "path"[cardinality("path")] = "parent_grant_id"
        AND "path"[1] = "root_grant_id")
  ),
  CONSTRAINT "delegation_grants_acyclic_check" CHECK (NOT ("id" = ANY ("path")) AND array_position("path", NULL) IS NULL),
  -- at most one context it was made for (none: an external root from a human's delegation proof)
  CONSTRAINT "delegation_grants_context_check" CHECK (num_nonnulls("run_id", "builder_turn_id", "engine_run_id", "schedule_id") <= 1),
  CONSTRAINT "delegation_grants_scope_check" CHECK (jsonb_typeof("scope") = 'array' AND jsonb_array_length("scope") <= 100),
  -- micro-dollar balances never go negative; reserved allocation never exceeds the cap
  CONSTRAINT "delegation_grants_balances_check" CHECK (
    ("cap_micros" IS NULL OR "cap_micros" >= 0)
    AND "settled_micros" >= 0
    AND "reserved_micros" >= 0
    AND ("cap_micros" IS NOT NULL OR "reserved_micros" = 0)
    AND ("cap_micros" IS NULL OR "reserved_micros" <= "cap_micros")
  ),
  CONSTRAINT "delegation_grants_environment_check" CHECK ("environment" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  CONSTRAINT "delegation_grants_audience_check" CHECK ("audience" IS NULL OR length("audience") BETWEEN 1 AND 2048),
  -- an in-process grant mints no token and has no credential or binding (decision 6); an external one has both
  CONSTRAINT "delegation_grants_binding_check" CHECK (
    ("binding_kind" = 'in_process' AND "binding_thumbprint" IS NULL AND "auth_credential_id" IS NULL)
    OR ("binding_kind" IN ('dpop', 'mtls') AND "binding_thumbprint" IS NOT NULL AND "binding_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'
        AND "auth_credential_id" IS NOT NULL AND "audience" IS NOT NULL)
  ),
  CONSTRAINT "delegation_grants_expiry_check" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "delegation_grants_revoked_check" CHECK (
    ("revoked_at" IS NULL AND "revoked_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_reason" IS NOT NULL AND "revoked_reason" IN
        ('admin', 'cascade', 'identity_revoked', 'credential_revoked', 'sponsor_disabled', 'agent_halted', 'run_ended'))
  )
);
--> statement-breakpoint
-- revocation cascades over `path` in one statement (decision 4)
CREATE INDEX "delegation_grants_path_gin" ON "delegation_grants" USING gin ("path");
--> statement-breakpoint
CREATE INDEX "delegation_grants_root_idx" ON "delegation_grants" ("root_grant_id");
--> statement-breakpoint
CREATE INDEX "delegation_grants_parent_idx" ON "delegation_grants" ("parent_grant_id");
--> statement-breakpoint
CREATE INDEX "delegation_grants_actor_idx" ON "delegation_grants" ("actor_identity_id");
--> statement-breakpoint
CREATE INDEX "delegation_grants_sponsor_idx" ON "delegation_grants" ("sponsor_user_id");
--> statement-breakpoint
CREATE INDEX "delegation_grants_auth_credential_idx" ON "delegation_grants" ("auth_credential_id") WHERE "auth_credential_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "delegation_grants_expires_idx" ON "delegation_grants" ("expires_at") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
-- decision 17: a child's chain, sponsor, project, environment and run context
-- come from its parent row, never from a caller, and its lifetime is inside the
-- parent's. A grant is never updated except to revoke it or record spend
-- (decision 4), and never deleted.
CREATE OR REPLACE FUNCTION "regulait_delegation_grant_guard"() RETURNS trigger AS $$
DECLARE
  p "delegation_grants"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delegation_grants: a grant is never deleted (revoke it)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_reason', 'settled_micros', 'reserved_micros'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_reason', 'settled_micros', 'reserved_micros']) THEN
      RAISE EXCEPTION 'delegation_grants: a grant changes only by revocation or spend (ADR-0188 decision 4)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."revoked_at" IS NOT NULL
       AND (NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" OR NEW."revoked_reason" IS DISTINCT FROM OLD."revoked_reason") THEN
      RAISE EXCEPTION 'delegation_grants: a revocation is never undone or rewritten'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT
  IF NEW."parent_grant_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM "delegation_grants" WHERE "id" = NEW."parent_grant_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delegation_grants: parent % does not exist', NEW."parent_grant_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."path" IS DISTINCT FROM (p."path" || p."id")
     OR NEW."depth" <> p."depth" + 1
     OR NEW."root_grant_id" IS DISTINCT FROM p."root_grant_id" THEN
    RAISE EXCEPTION 'delegation_grants: path, depth and root must follow the parent row (ADR-0188 decision 17)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sponsor_user_id" IS DISTINCT FROM p."sponsor_user_id"
     OR NEW."project_id" IS DISTINCT FROM p."project_id"
     OR NEW."environment" IS DISTINCT FROM p."environment"
     OR NEW."run_id" IS DISTINCT FROM p."run_id"
     OR NEW."builder_turn_id" IS DISTINCT FROM p."builder_turn_id"
     OR NEW."engine_run_id" IS DISTINCT FROM p."engine_run_id"
     OR NEW."schedule_id" IS DISTINCT FROM p."schedule_id" THEN
    RAISE EXCEPTION 'delegation_grants: sponsor, project, environment and run context are immutable down the chain (ADR-0188 decision 17)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expires_at" > p."expires_at" THEN
    RAISE EXCEPTION 'delegation_grants: a child never outlives its parent (ADR-0188 decision 4)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p."cap_micros" IS NOT NULL AND (NEW."cap_micros" IS NULL OR NEW."cap_micros" > p."cap_micros") THEN
    RAISE EXCEPTION 'delegation_grants: a child of a capped grant has a cap no larger than its parent''s (ADR-0188 decision 22)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "delegation_grants_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "delegation_grants"
  FOR EACH ROW EXECUTE FUNCTION "regulait_delegation_grant_guard"();
--> statement-breakpoint
-- decision 22: one allocation edge per parent→child; each dollar sits on exactly one edge
CREATE TABLE "delegation_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "child_grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "amount_micros" bigint NOT NULL,
  "drawn_micros" bigint DEFAULT 0 NOT NULL,
  "released_micros" bigint DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "delegation_allocations_child_uq" UNIQUE ("child_grant_id"),
  CONSTRAINT "delegation_allocations_idempotency_uq" UNIQUE ("parent_grant_id", "idempotency_key"),
  CONSTRAINT "delegation_allocations_edge_check" CHECK ("parent_grant_id" <> "child_grant_id"),
  CONSTRAINT "delegation_allocations_status_check" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "delegation_allocations_amounts_check" CHECK (
    "amount_micros" >= 0 AND "drawn_micros" >= 0 AND "released_micros" >= 0 AND "released_micros" <= "amount_micros"
  ),
  -- open: nothing released yet; closed: exactly the unspent part returned, once
  CONSTRAINT "delegation_allocations_close_check" CHECK (
    ("status" = 'open' AND "closed_at" IS NULL AND "released_micros" = 0)
    OR ("status" = 'closed' AND "closed_at" IS NOT NULL
        AND "released_micros" = GREATEST(0, "amount_micros" - "drawn_micros"))
  ),
  CONSTRAINT "delegation_allocations_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "delegation_allocations_open_idx" ON "delegation_allocations" ("parent_grant_id") WHERE "status" = 'open';
--> statement-breakpoint
-- the edge's identity and amount never change; a closed edge is never reopened; never deleted
CREATE OR REPLACE FUNCTION "regulait_delegation_allocation_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delegation_allocations: an allocation is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."parent_grant_id" IS DISTINCT FROM OLD."parent_grant_id"
     OR NEW."child_grant_id" IS DISTINCT FROM OLD."child_grant_id"
     OR NEW."amount_micros" IS DISTINCT FROM OLD."amount_micros"
     OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."drawn_micros" < OLD."drawn_micros" THEN
    RAISE EXCEPTION 'delegation_allocations: an edge''s parties and amount are immutable and drawn only grows'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'closed' AND (NEW."status" <> 'closed' OR NEW."released_micros" IS DISTINCT FROM OLD."released_micros"
       OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at") THEN
    RAISE EXCEPTION 'delegation_allocations: a closed edge is never reopened or released twice (ADR-0188 decision 22)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "delegation_allocations_guard"
  BEFORE UPDATE OR DELETE ON "delegation_allocations"
  FOR EACH ROW EXECUTE FUNCTION "regulait_delegation_allocation_guard"();
--> statement-breakpoint
-- decision 22: one usage row is settled along its path exactly once (append-only)
CREATE TABLE "delegation_charges" (
  "usage_event_id" uuid PRIMARY KEY NOT NULL,
  "leaf_grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "amount_micros" bigint NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "delegation_charges_amount_check" CHECK ("amount_micros" >= 0)
);
--> statement-breakpoint
CREATE INDEX "delegation_charges_leaf_idx" ON "delegation_charges" ("leaf_grant_id", "at");
--> statement-breakpoint
CREATE TRIGGER "delegation_charges_append_only"
  BEFORE UPDATE OR DELETE ON "delegation_charges"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint

-- ===== 5. issued tokens (decision 12) ========================================
CREATE TABLE "issued_tokens" (
  "jti" text PRIMARY KEY NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "delegation_grants"("id") ON DELETE RESTRICT,
  "auth_credential_id" uuid NOT NULL REFERENCES "workload_credentials"("id") ON DELETE RESTRICT,
  "signing_kid" text NOT NULL REFERENCES "identity_signing_keys"("kid") ON DELETE RESTRICT,
  "binding_kind" text NOT NULL,
  "binding_thumbprint" text NOT NULL,
  "audience" text NOT NULL,
  "env" text NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "issued_tokens_jti_check" CHECK ("jti" ~ '^[A-Za-z0-9_-]{16,128}$'),
  -- a token with no sender binding is never issued (decision 5): there is no bearer value
  CONSTRAINT "issued_tokens_binding_check" CHECK ("binding_kind" IN ('dpop', 'mtls') AND "binding_thumbprint" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "issued_tokens_audience_check" CHECK (length("audience") BETWEEN 1 AND 2048),
  CONSTRAINT "issued_tokens_env_check" CHECK ("env" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  -- at most the setting's ceiling (3600 s)
  CONSTRAINT "issued_tokens_lifetime_check" CHECK (
    "expires_at" > "issued_at" AND "expires_at" <= "issued_at" + interval '3600 seconds'
  ),
  CONSTRAINT "issued_tokens_revoked_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
);
--> statement-breakpoint
CREATE INDEX "issued_tokens_grant_idx" ON "issued_tokens" ("grant_id");
--> statement-breakpoint
CREATE INDEX "issued_tokens_binding_idx" ON "issued_tokens" ("binding_thumbprint");
--> statement-breakpoint
CREATE INDEX "issued_tokens_credential_idx" ON "issued_tokens" ("auth_credential_id");
--> statement-breakpoint
CREATE INDEX "issued_tokens_expires_idx" ON "issued_tokens" ("expires_at");
--> statement-breakpoint
-- the stored binding is what the resource check compares against: only revocation changes a row
CREATE OR REPLACE FUNCTION "regulait_issued_token_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- the sweep removes rows only after expiry
    IF OLD."expires_at" > now() THEN
      RAISE EXCEPTION 'issued_tokens: an unexpired token row is never deleted (revoke it)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'issued_tokens: a token row changes only by revocation, once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "issued_tokens_guard"
  BEFORE UPDATE OR DELETE ON "issued_tokens"
  FOR EACH ROW EXECUTE FUNCTION "regulait_issued_token_guard"();
--> statement-breakpoint

-- ===== 6. replay claims (decision 14) ========================================
-- A claim is `INSERT … ON CONFLICT DO NOTHING RETURNING 1`: one row back is
-- accepted, none is a replay. Never an update or an overwrite; rows are swept
-- only after `expires_at`.
CREATE TABLE "replay_claims" (
  "namespace" text NOT NULL,
  "key" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "replay_claims_pk" PRIMARY KEY ("namespace", "key"),
  CONSTRAINT "replay_claims_namespace_check" CHECK (
    "namespace" IN ('client_assertion', 'as_dpop', 'rs_dpop', 'human_delegation_proof', 'delegation_authz')
  ),
  CONSTRAINT "replay_claims_key_check" CHECK (length("key") BETWEEN 1 AND 256),
  CONSTRAINT "replay_claims_expiry_check" CHECK ("expires_at" > "claimed_at")
);
--> statement-breakpoint
CREATE INDEX "replay_claims_expires_idx" ON "replay_claims" ("expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "regulait_replay_claim_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."expires_at" > now() THEN
      RAISE EXCEPTION 'replay_claims: a live claim is never removed (ADR-0188 decision 14)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'replay_claims: a claim is never updated or overwritten (ADR-0188 decision 14)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "replay_claims_guard"
  BEFORE UPDATE OR DELETE ON "replay_claims"
  FOR EACH ROW EXECUTE FUNCTION "regulait_replay_claim_guard"();
--> statement-breakpoint

-- ===== 7. the audit v2 boundary and the actor columns (decisions 9, 19) =======
CREATE TABLE "audit_chain_versions" (
  "version" smallint PRIMARY KEY NOT NULL,
  "from_seq" bigint NOT NULL,
  "set_at" timestamp with time zone DEFAULT now() NOT NULL,
  "set_by" uuid,
  CONSTRAINT "audit_chain_versions_from_seq_uq" UNIQUE ("from_seq"),
  CONSTRAINT "audit_chain_versions_version_check" CHECK ("version" = 2),
  CONSTRAINT "audit_chain_versions_from_seq_check" CHECK ("from_seq" > 1)
);
--> statement-breakpoint
CREATE TRIGGER "audit_chain_versions_append_only"
  BEFORE UPDATE OR DELETE ON "audit_chain_versions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_identity_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "delegation_grant_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_chain" jsonb;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "chain_version" smallint;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_chain_version_check" CHECK ("chain_version" IS NULL OR "chain_version" IN (1, 2));
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_chain_check" CHECK (
  "actor_chain" IS NULL OR (jsonb_typeof("actor_chain") = 'array' AND jsonb_array_length("actor_chain") BETWEEN 1 AND 9)
);
--> statement-breakpoint
-- the actor fields go together: an agent-made row names its identity, its grant and the chain
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_fields_check" CHECK (
  ("actor_identity_id" IS NULL AND "delegation_grant_id" IS NULL AND "actor_chain" IS NULL)
  OR ("actor_identity_id" IS NOT NULL AND "delegation_grant_id" IS NOT NULL AND "actor_chain" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "audit_log_delegation_grant_idx" ON "audit_log" ("delegation_grant_id") WHERE "delegation_grant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "audit_log_actor_identity_idx" ON "audit_log" ("actor_identity_id") WHERE "actor_identity_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "trace_spans" ADD COLUMN "actor_identity_id" uuid;
--> statement-breakpoint
ALTER TABLE "trace_spans" ADD COLUMN "delegation_grant_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "actor_identity_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "delegation_grant_id" uuid;
--> statement-breakpoint
CREATE INDEX "usage_events_delegation_grant_idx" ON "usage_events" ("delegation_grant_id") WHERE "delegation_grant_id" IS NOT NULL;
--> statement-breakpoint

-- ===== 8. identity sent to upstream MCP servers (decision 8) =================
ALTER TABLE "mcp_servers" ADD COLUMN "identity_propagation" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_identity_propagation_check" CHECK ("identity_propagation" IN ('none', 'signed_assertion'));
--> statement-breakpoint

-- ===== 9. the step-up kind `identity_manage` ==================================
ALTER TABLE "step_up_grants" DROP CONSTRAINT "step_up_grants_action_kind_check";
--> statement-breakpoint
ALTER TABLE "step_up_grants" ADD CONSTRAINT "step_up_grants_action_kind_check" CHECK (
  "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage')
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_action_kind_check";
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_action_kind_check" CHECK (
  "action_kind" IS NULL
  OR "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change', 'identity_manage')
);
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT "org_settings_step_up_actions_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_actions_check" CHECK (
  jsonb_typeof("step_up_actions") = 'array'
  AND "step_up_actions" <@ '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ALTER COLUMN "step_up_actions" SET DEFAULT '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage"]'::jsonb;
--> statement-breakpoint
-- first load (ADR-0180): the existing row requires the new kind too
UPDATE "org_settings" SET "step_up_actions" = "step_up_actions" || '["identity_manage"]'::jsonb
  WHERE NOT ("step_up_actions" ? 'identity_manage');
--> statement-breakpoint

-- ===== 10. the identity org settings, all strict (decision 10) ===============
ALTER TABLE "org_settings" ADD COLUMN "agent_entitlement_mode" text DEFAULT 'own_grants' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "delegated_token_ttl_seconds" integer DEFAULT 300 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "delegation_max_depth" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "workload_client_auth_methods" jsonb DEFAULT '["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "dpop_nonce_required" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "workload_key_max_age_days" integer DEFAULT 90 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_agent_entitlement_mode_check" CHECK ("agent_entitlement_mode" IN ('own_grants', 'sponsor_only'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_delegated_token_ttl_seconds_check" CHECK ("delegated_token_ttl_seconds" BETWEEN 60 AND 3600);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_delegation_max_depth_check" CHECK ("delegation_max_depth" BETWEEN 0 AND 8);
--> statement-breakpoint
-- `client_secret_*` is not a member, so it can never be stored
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_workload_client_auth_methods_check" CHECK (
  jsonb_typeof("workload_client_auth_methods") = 'array'
  AND "workload_client_auth_methods" <@ '["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_workload_key_max_age_days_check" CHECK ("workload_key_max_age_days" BETWEEN 1 AND 90);
