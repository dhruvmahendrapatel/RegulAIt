-- ADR-0310 (G2): signed, versioned bundles of vendor-native managed settings compiled from one subject's effective
-- MCP entitlements (Claude Code, GitHub Copilot, OpenAI Codex, a Cursor worksheet).
--
-- A bundle row is the signed manifest (exact bytes) plus its signature and key id; each compiled vendor file is a
-- child row whose sha256 the manifest lists. Both are point-in-time evidence: drift is measured against what was
-- exported, not against today's grants. The subject is a foreign key (a user or a role), never a copied name.
--
-- Hand-authored, additive and idempotent. No functions or triggers (zz-dbguard-0185 checked by hand).
CREATE TABLE IF NOT EXISTS "managed_settings_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_kind" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "role_id" uuid REFERENCES "roles"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "policy_digest" text NOT NULL,
  "manifest" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "managed_settings_bundles_subject_check" CHECK (CASE "subject_kind"
    WHEN 'user' THEN "user_id" IS NOT NULL AND "role_id" IS NULL
    WHEN 'role' THEN "role_id" IS NOT NULL AND "user_id" IS NULL
    ELSE false END),
  CONSTRAINT "managed_settings_bundles_version_check" CHECK ("version" >= 1),
  CONSTRAINT "managed_settings_bundles_manifest_size_check" CHECK (octet_length("manifest") <= 65536)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_settings_bundles_user_version_uq"
  ON "managed_settings_bundles" ("user_id", "version") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_settings_bundles_role_version_uq"
  ON "managed_settings_bundles" ("role_id", "version") WHERE "role_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "managed_settings_bundles_created_idx"
  ON "managed_settings_bundles" ("created_at", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "managed_settings_bundle_files" (
  "bundle_id" uuid NOT NULL REFERENCES "managed_settings_bundles"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "body" text NOT NULL,
  "sha256" text NOT NULL,
  CONSTRAINT "managed_settings_bundle_files_pkey" PRIMARY KEY ("bundle_id", "path"),
  CONSTRAINT "managed_settings_bundle_files_size_check" CHECK (octet_length("body") <= 262144)
);
--> statement-breakpoint
-- Row-level security (#850 review; ADR-0234's admin-only shape). Both tables hold one subject's compiled policy and
-- are read and written only by the admin-only export routes, so a row is reachable only by an active admin principal
-- or under the `migration` reason. A plain `regulait_app` connection, or any other system reason, sees and writes
-- nothing.
ALTER TABLE "managed_settings_bundles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "managed_settings_bundles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS managed_settings_bundles_all ON "managed_settings_bundles";
--> statement-breakpoint
CREATE POLICY managed_settings_bundles_all ON "managed_settings_bundles" FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration'])
  );
--> statement-breakpoint
ALTER TABLE "managed_settings_bundle_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "managed_settings_bundle_files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS managed_settings_bundle_files_all ON "managed_settings_bundle_files";
--> statement-breakpoint
CREATE POLICY managed_settings_bundle_files_all ON "managed_settings_bundle_files" FOR ALL
  USING (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration'])
  )
  WITH CHECK (
    (SELECT regulait_rls_is_admin())
    OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['migration'])
  );
