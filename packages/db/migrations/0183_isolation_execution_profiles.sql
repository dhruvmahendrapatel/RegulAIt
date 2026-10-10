-- ADR-0190 (batch 6 item 3) slice I1 — isolation and execution profiles: the FOUNDATION (decision 14).
-- Hand-authored (never drizzle-kit generate).
--
-- New tables: execution_profiles (immutable versions, digest-checked, the three shipped profiles seeded as v1),
-- executors (one per ADR-0188 worker_runtime identity), executor_attestations (append-only self-test verdicts) and
-- execution_placements (append-only placement outcomes). The isolation org settings, all strict (decision 11,
-- OWNER DECISIONS 3, 4 and 9), written onto the existing org row (ADR-0180: first load, no grandfathering).
--
-- Deferred to I2 (it first reads them; delegation_grants is altered in parallel by ADR-0188 S4):
-- compliance_profiles.min_isolation_class, workload_identities.execution_profile_id,
-- delegation_grants.required_isolation_class and execution_profile_digest.
--
-- The vocabularies are the constants of packages/shared/src/isolation (contract.ts, settings.ts); the class order is
-- in_gateway < hardened_container < user_space_kernel < microvm, and L0 (in_gateway) is never a stored requirement.

-- TRUNCATE skips row triggers, so every table guarded against UPDATE/DELETE also refuses TRUNCATE. Migration 0185
-- (db-guard-hardening) defines the same function with the identical body; it is created here because 0183 merges first.
CREATE OR REPLACE FUNCTION public.regulait_refuse_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION '%: TRUNCATE refused (append-only)', TG_TABLE_NAME; END $$;
--> statement-breakpoint

-- ===== 1. execution profiles (decision 2) =====================================
CREATE TABLE "execution_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL,
  "body" text NOT NULL,
  "digest" text NOT NULL,
  "min_class" text NOT NULL,
  "shipped" boolean DEFAULT false NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone,
  "retired_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "execution_profiles_name_version_uq" UNIQUE ("name", "version"),
  CONSTRAINT "execution_profiles_digest_uq" UNIQUE ("digest"),
  CONSTRAINT "execution_profiles_name_check" CHECK ("name" ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT "execution_profiles_version_check" CHECK ("version" >= 1),
  CONSTRAINT "execution_profiles_min_class_check" CHECK ("min_class" IN ('hardened_container', 'user_space_kernel', 'microvm')),
  -- the digest IS the SHA-256 of the stored canonical text: a row whose digest names another body cannot exist
  CONSTRAINT "execution_profiles_digest_check" CHECK (
    "digest" ~ '^[0-9a-f]{64}$' AND "digest" = encode(sha256(convert_to("body", 'UTF8')), 'hex')
  ),
  -- the body is a v1 profile, and the columns restate it
  CONSTRAINT "execution_profiles_body_check" CHECK (
    length("body") <= 65536
    AND jsonb_typeof("body"::jsonb) = 'object'
    AND ("body"::jsonb ->> 'schema') = 'regulait.execution-profile.v1'
    AND ("body"::jsonb ->> 'name') = "name"
    AND ("body"::jsonb ->> 'minClass') = "min_class"
  ),
  CONSTRAINT "execution_profiles_retired_check" CHECK ("retired_at" IS NULL OR "retired_at" >= "created_at"),
  CONSTRAINT "execution_profiles_retired_by_check" CHECK ("retired_by" IS NULL OR "retired_at" IS NOT NULL)
);
--> statement-breakpoint
-- append-only versions: a change is version n+1 (one step, never after the name was retired); a row only ever gains
-- its retirement (once); never deleted. The FK set-nulls of created_by / retired_by are the one other change allowed.
CREATE OR REPLACE FUNCTION "regulait_execution_profile_guard"() RETURNS trigger AS $$
DECLARE
  latest integer;
  latest_retired boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_profiles: a profile version is never deleted (retire it)'
      USING ERRCODE = 'insufficient_privilege', HINT = 'placements and attestations name its digest (ADR-0190 decision 2)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- serialise versioning per name
    PERFORM pg_advisory_xact_lock(hashtext('execution_profiles:' || NEW."name"));
    SELECT "version", "retired_at" IS NOT NULL INTO latest, latest_retired
      FROM "execution_profiles" WHERE "name" = NEW."name" ORDER BY "version" DESC LIMIT 1;
    IF NEW."version" <> COALESCE(latest, 0) + 1 THEN
      RAISE EXCEPTION 'execution_profiles: % must be version %, not %', NEW."name", COALESCE(latest, 0) + 1, NEW."version"
        USING ERRCODE = 'check_violation';
    END IF;
    IF latest_retired THEN
      RAISE EXCEPTION 'execution_profiles: % is retired; a retired profile is not versioned again', NEW."name"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."retired_at" IS NOT NULL THEN
      RAISE EXCEPTION 'execution_profiles: a version is created live, then retired'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."digest" IS DISTINCT FROM OLD."digest"
     OR NEW."min_class" IS DISTINCT FROM OLD."min_class"
     OR NEW."shipped" IS DISTINCT FROM OLD."shipped"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."created_by" IS DISTINCT FROM OLD."created_by" AND NEW."created_by" IS NOT NULL) THEN
    RAISE EXCEPTION 'execution_profiles: a profile version is immutable (create version n+1)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at" THEN
    RAISE EXCEPTION 'execution_profiles: retirement is terminal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."retired_by" IS DISTINCT FROM OLD."retired_by" AND NEW."retired_by" IS NOT NULL
     AND NOT (OLD."retired_at" IS NULL AND NEW."retired_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'execution_profiles: retired_by is written with the retirement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
CREATE TRIGGER "execution_profiles_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "execution_profiles"
  FOR EACH ROW EXECUTE FUNCTION "regulait_execution_profile_guard"();
--> statement-breakpoint
CREATE TRIGGER "execution_profiles_no_truncate" BEFORE TRUNCATE ON public."execution_profiles" FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint
-- the shipped profiles, version 1 (packages/shared/src/isolation/profiles.ts; the I1 suite checks them byte for byte)
-- restricted: sha256 9b8e0c493874ba6768bb00ec331827a76f44f64cc5024f10adc9380f20a21496
INSERT INTO "execution_profiles" ("name", "version", "body", "digest", "min_class", "shipped") VALUES ('restricted', 1, '{"attestation":{"executorMaxAgeMinutes":120,"perPlacement":true,"probes":["runtime_identity","proc_status","seccomp_enforced","root_read_only","egress_literal_address","egress_dns","network_interfaces","no_executor_credentials","visible_limits","host_cgroup_limits","runtime_config"]},"filesystem":{"inputs":[],"rootReadOnly":true,"workDir":{"path":"/work","tmpfsMiB":256}},"minClass":"user_space_kernel","name":"restricted","network":{"mode":"gateway_only"},"persistence":"none","process":{"capabilities":[],"exec":"image_only","noNewPrivileges":true,"pids":{"hostCgroupPidsMax":512,"workloadNproc":128},"seccomp":{"type":"RuntimeDefault"},"uid":10001},"resources":{"cpuMillis":1000,"memoryMiB":1024,"outputBytes":16777216,"wallClockSecondsPerCall":300,"wallClockSecondsPerSession":1800},"runsc":{"directfs":false,"ociSeccomp":true,"platform":"systrap","sidecarReleaseEnforcementPolicy":"ALWAYS","sidecarUsagePolicy":"STRICT"},"schema":"regulait.execution-profile.v1","secrets":"none","workloadKinds":["mcp_stdio","code_exec","engine_worker","byoc_worker"]}', '9b8e0c493874ba6768bb00ec331827a76f44f64cc5024f10adc9380f20a21496', 'user_space_kernel', true);
--> statement-breakpoint
-- restricted-microvm: sha256 9a2363321acbd41914826143273037829107c99a61db21adb03deebfdb39aacd
INSERT INTO "execution_profiles" ("name", "version", "body", "digest", "min_class", "shipped") VALUES ('restricted-microvm', 1, '{"attestation":{"executorMaxAgeMinutes":120,"perPlacement":true,"probes":["runtime_identity","proc_status","seccomp_enforced","root_read_only","egress_literal_address","egress_dns","network_interfaces","no_executor_credentials","visible_limits","host_cgroup_limits","runtime_config"]},"filesystem":{"inputs":[],"rootReadOnly":true,"workDir":{"path":"/work","tmpfsMiB":256}},"minClass":"microvm","name":"restricted-microvm","network":{"mode":"gateway_only"},"persistence":"none","process":{"capabilities":[],"exec":"image_only","noNewPrivileges":true,"pids":{"hostCgroupPidsMax":512,"workloadNproc":128},"seccomp":{"type":"RuntimeDefault"},"uid":10001},"resources":{"cpuMillis":1000,"memoryMiB":1024,"outputBytes":16777216,"wallClockSecondsPerCall":300,"wallClockSecondsPerSession":1800},"runsc":{"directfs":false,"ociSeccomp":true,"platform":"systrap","sidecarReleaseEnforcementPolicy":"ALWAYS","sidecarUsagePolicy":"STRICT"},"schema":"regulait.execution-profile.v1","secrets":"none","workloadKinds":["mcp_stdio","code_exec","engine_worker","byoc_worker"]}', '9a2363321acbd41914826143273037829107c99a61db21adb03deebfdb39aacd', 'microvm', true);
--> statement-breakpoint
-- engine-worker: sha256 1a9700e7e04883b04b5ffcce625d4f2a9fda6ba17b1a9a474a638c9f8d4dc7c3
INSERT INTO "execution_profiles" ("name", "version", "body", "digest", "min_class", "shipped") VALUES ('engine-worker', 1, '{"attestation":{"executorMaxAgeMinutes":120,"perPlacement":true,"probes":["runtime_identity","proc_status","seccomp_enforced","root_read_only","egress_literal_address","egress_dns","network_interfaces","no_executor_credentials","visible_limits","host_cgroup_limits","runtime_config"]},"filesystem":{"inputs":[{"mountPath":"/jobs","name":"jobs"}],"rootReadOnly":true,"workDir":{"path":"/work","tmpfsMiB":1024}},"minClass":"user_space_kernel","name":"engine-worker","network":{"mode":"gateway_only"},"persistence":"none","process":{"capabilities":[],"exec":"image_only","noNewPrivileges":true,"pids":{"hostCgroupPidsMax":768,"workloadNproc":256},"seccomp":{"type":"RuntimeDefault"},"uid":10001},"resources":{"cpuMillis":2000,"memoryMiB":2048,"outputBytes":67108864,"wallClockSecondsPerCall":1800,"wallClockSecondsPerSession":1800},"runsc":{"directfs":false,"ociSeccomp":true,"platform":"systrap","sidecarReleaseEnforcementPolicy":"ALWAYS","sidecarUsagePolicy":"STRICT"},"schema":"regulait.execution-profile.v1","secrets":"task_scoped","workloadKinds":["engine_worker"]}', '1a9700e7e04883b04b5ffcce625d4f2a9fda6ba17b1a9a474a638c9f8d4dc7c3', 'user_space_kernel', true);
--> statement-breakpoint

-- ===== 2. executors (decision 4) ==============================================
CREATE TABLE "executors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workload_identity_id" uuid NOT NULL REFERENCES "workload_identities"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "backend" text NOT NULL,
  "runtime_version" text NOT NULL,
  "classes_declared" jsonb NOT NULL,
  "declared_class" text,
  "status" text DEFAULT 'active' NOT NULL,
  "quarantine_code" text,
  "quarantined_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executors_workload_identity_uq" UNIQUE ("workload_identity_id"),
  CONSTRAINT "executors_name_uq" UNIQUE ("name"),
  CONSTRAINT "executors_name_check" CHECK ("name" ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT "executors_backend_check" CHECK ("backend" IN ('runc', 'gvisor', 'kata', 'openshell', 'customer')),
  CONSTRAINT "executors_runtime_version_check" CHECK ("runtime_version" ~ '^[A-Za-z0-9._+-]{1,128}$'),
  -- what each backend may attest (decision 1, amendment F: OpenShell never attests L2)
  CONSTRAINT "executors_classes_declared_check" CHECK (
    jsonb_typeof("classes_declared") = 'array'
    AND jsonb_array_length("classes_declared") >= 1
    AND (
      ("backend" = 'runc' AND "classes_declared" <@ '["hardened_container"]'::jsonb)
      OR ("backend" = 'gvisor' AND "classes_declared" <@ '["hardened_container", "user_space_kernel"]'::jsonb)
      OR ("backend" IN ('kata', 'openshell') AND "classes_declared" <@ '["hardened_container", "microvm"]'::jsonb)
      OR ("backend" = 'customer' AND "classes_declared" = '["customer_declared"]'::jsonb)
    )
  ),
  -- OWNER DECISION 6: a customer plane maps to NO class (null) until an admin maps it
  CONSTRAINT "executors_declared_class_check" CHECK (
    "declared_class" IS NULL
    OR ("backend" = 'customer' AND "declared_class" IN ('hardened_container', 'user_space_kernel', 'microvm'))
  ),
  CONSTRAINT "executors_status_check" CHECK ("status" IN ('active', 'quarantined', 'revoked')),
  CONSTRAINT "executors_quarantine_check" CHECK (
    ("status" = 'active' AND "quarantine_code" IS NULL AND "quarantined_at" IS NULL)
    OR ("status" = 'quarantined' AND "quarantine_code" IS NOT NULL AND "quarantined_at" IS NOT NULL)
    OR "status" = 'revoked'
  ),
  CONSTRAINT "executors_quarantine_code_check" CHECK (
    "quarantine_code" IS NULL OR "quarantine_code" IN ('execution_profile_mismatch', 'attestation_failed', 'admin')
  )
);
--> statement-breakpoint
CREATE INDEX "executors_status_idx" ON "executors" ("status");
--> statement-breakpoint
-- the identity is a worker_runtime (ADR-0188); identity and backend never change; `revoked` is terminal; never deleted
CREATE OR REPLACE FUNCTION "regulait_executor_guard"() RETURNS trigger AS $$
DECLARE
  identity_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'executors: an executor is never deleted (revoke it)'
      USING ERRCODE = 'insufficient_privilege', HINT = 'placements and attestations name executor ids (ADR-0190 decision 13)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "kind" INTO identity_kind FROM "workload_identities" WHERE "id" = NEW."workload_identity_id";
    IF identity_kind IS DISTINCT FROM 'worker_runtime' THEN
      RAISE EXCEPTION 'executors: an executor authenticates as an ADR-0188 worker_runtime identity'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'active' THEN
      RAISE EXCEPTION 'executors: an executor is registered active (its classes count only once attested)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."workload_identity_id" IS DISTINCT FROM OLD."workload_identity_id"
     OR NEW."backend" IS DISTINCT FROM OLD."backend"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."created_by" IS DISTINCT FROM OLD."created_by" AND NEW."created_by" IS NOT NULL) THEN
    RAISE EXCEPTION 'executors: identity and backend are immutable (register a new executor)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'executors: a revoked executor is never changed or reinstated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
CREATE TRIGGER "executors_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "executors"
  FOR EACH ROW EXECUTE FUNCTION "regulait_executor_guard"();
--> statement-breakpoint
CREATE TRIGGER "executors_no_truncate" BEFORE TRUNCATE ON public."executors" FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint

-- ===== 3. executor attestations (decision 6), append-only =====================
CREATE TABLE "executor_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "executor_id" uuid NOT NULL REFERENCES "executors"("id") ON DELETE RESTRICT,
  "profile_digest" text NOT NULL REFERENCES "execution_profiles"("digest") ON DELETE RESTRICT,
  "class" text NOT NULL,
  "report_sha256" text NOT NULL,
  "report" jsonb NOT NULL,
  "verdict" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "executor_attestations_class_check" CHECK (
    "class" IN ('hardened_container', 'user_space_kernel', 'microvm', 'customer_declared')
  ),
  CONSTRAINT "executor_attestations_report_sha256_check" CHECK ("report_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "executor_attestations_report_check" CHECK (jsonb_typeof("report") = 'object' AND pg_column_size("report") <= 65536),
  CONSTRAINT "executor_attestations_verdict_check" CHECK ("verdict" IN ('pass', 'fail')),
  -- the freshness limit is at most the org ceiling (24 h)
  CONSTRAINT "executor_attestations_expiry_check" CHECK (
    "expires_at" > "observed_at" AND "expires_at" <= "observed_at" + interval '24 hours'
  )
);
--> statement-breakpoint
CREATE INDEX "executor_attestations_fresh_idx" ON "executor_attestations" ("executor_id", "profile_digest", "class", "observed_at" DESC);
--> statement-breakpoint
CREATE TRIGGER "executor_attestations_append_only"
  BEFORE UPDATE OR DELETE ON "executor_attestations"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "executor_attestations_no_truncate" BEFORE TRUNCATE ON public."executor_attestations" FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint

-- ===== 4. execution placements (decisions 7 and 13), append-only ==============
CREATE TABLE "execution_placements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "audit_id" uuid NOT NULL,
  "workload_kind" text NOT NULL,
  "required_class" text NOT NULL,
  "required_by" text NOT NULL,
  "enforcement" text NOT NULL,
  "profile_digest" text NOT NULL REFERENCES "execution_profiles"("digest") ON DELETE RESTRICT,
  "executor_id" uuid REFERENCES "executors"("id") ON DELETE RESTRICT,
  "applied_class" text,
  "report_sha256" text,
  "outcome" text NOT NULL,
  "refusal_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "execution_placements_audit_id_uq" UNIQUE ("audit_id"),
  CONSTRAINT "execution_placements_workload_kind_check" CHECK (
    "workload_kind" IN ('mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker')
  ),
  CONSTRAINT "execution_placements_required_class_check" CHECK (
    "required_class" IN ('hardened_container', 'user_space_kernel', 'microvm')
  ),
  CONSTRAINT "execution_placements_required_by_check" CHECK (
    "required_by" IN ('workload_kind', 'data_sensitivity', 'compliance_tag', 'autonomy_class', 'configured_profile', 'unknown_agent', 'parent_grant')
  ),
  CONSTRAINT "execution_placements_enforcement_check" CHECK ("enforcement" IN ('enforce', 'warn')),
  CONSTRAINT "execution_placements_applied_class_check" CHECK (
    "applied_class" IS NULL OR "applied_class" IN ('hardened_container', 'user_space_kernel', 'microvm', 'customer_declared')
  ),
  CONSTRAINT "execution_placements_report_sha256_check" CHECK ("report_sha256" IS NULL OR "report_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "execution_placements_outcome_check" CHECK ("outcome" IN ('placed', 'refused', 'mismatch')),
  CONSTRAINT "execution_placements_refusal_code_check" CHECK (
    "refusal_code" IS NULL OR "refusal_code" IN (
      'no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired',
      'execution_profile_mismatch'
    )
  ),
  -- each outcome's shape: a refusal starts nothing; a placement names its executor, class and report; a mismatch
  -- names the executor and the report that disagreed
  CONSTRAINT "execution_placements_shape_check" CHECK (
    ("outcome" = 'refused' AND "executor_id" IS NULL AND "applied_class" IS NULL AND "report_sha256" IS NULL
      AND "refusal_code" IS NOT NULL AND "refusal_code" <> 'execution_profile_mismatch')
    OR ("outcome" = 'placed' AND "executor_id" IS NOT NULL AND "applied_class" IS NOT NULL AND "report_sha256" IS NOT NULL
      AND "refusal_code" IS NULL)
    OR ("outcome" = 'mismatch' AND "executor_id" IS NOT NULL AND "report_sha256" IS NOT NULL
      AND "refusal_code" = 'execution_profile_mismatch')
  ),
  -- the no-fallback invariant (decision 7): under enforcement a placement is never below its requirement. A
  -- customer_declared placement is admitted only through an admin's mapping, which the placing code checks.
  CONSTRAINT "execution_placements_no_fallback_check" CHECK (
    "outcome" <> 'placed' OR "enforcement" = 'warn' OR "applied_class" = 'customer_declared'
    OR array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "applied_class")
       >= array_position(ARRAY['hardened_container', 'user_space_kernel', 'microvm'], "required_class")
  )
);
--> statement-breakpoint
CREATE INDEX "execution_placements_executor_idx" ON "execution_placements" ("executor_id", "created_at");
--> statement-breakpoint
CREATE INDEX "execution_placements_created_idx" ON "execution_placements" ("created_at");
--> statement-breakpoint
CREATE TRIGGER "execution_placements_append_only"
  BEFORE UPDATE OR DELETE ON "execution_placements"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TRIGGER "execution_placements_no_truncate" BEFORE TRUNCATE ON public."execution_placements" FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
--> statement-breakpoint

-- ===== 5. the isolation org settings, all strict (decision 11) ================
ALTER TABLE "org_settings" ADD COLUMN "isolation_enforcement" text DEFAULT 'enforce' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_public" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_internal" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_confidential" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_regulated" text DEFAULT 'microvm' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_mcp_stdio" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "isolation_floor_engine_worker" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "executor_attestation_max_age_minutes" integer DEFAULT 120 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_isolation_enforcement_check" CHECK ("isolation_enforcement" IN ('enforce', 'warn'));
--> statement-breakpoint
-- a floor is never below a hardened container (L1): in_gateway is not a value
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_isolation_floors_check" CHECK (
  "isolation_floor_public" IN ('hardened_container', 'user_space_kernel', 'microvm')
  AND "isolation_floor_internal" IN ('hardened_container', 'user_space_kernel', 'microvm')
  AND "isolation_floor_confidential" IN ('hardened_container', 'user_space_kernel', 'microvm')
  AND "isolation_floor_regulated" IN ('hardened_container', 'user_space_kernel', 'microvm')
  AND "isolation_floor_mcp_stdio" IN ('hardened_container', 'user_space_kernel', 'microvm')
  AND "isolation_floor_engine_worker" IN ('hardened_container', 'user_space_kernel', 'microvm')
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_executor_attestation_max_age_minutes_check" CHECK ("executor_attestation_max_age_minutes" BETWEEN 60 AND 1440);
