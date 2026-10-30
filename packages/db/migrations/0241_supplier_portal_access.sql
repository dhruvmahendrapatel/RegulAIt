-- ADR-0221 (PENDING P4): the supplier portal's access model. Hand-authored (never drizzle-kit generate).
-- Re-runnable: every statement is idempotent.
--
-- 1. `org_settings.supplier_portal_enabled` ships OFF (ADR-0180). While it is off every supplier route answers the
--    same 404 as an unknown path, and no access can be granted. Turning it on is a relaxation (settings_relax step-up).
-- 2. `supplier_questionnaires`: custom questionnaires an admin builds. A row is one VERSION; editing publishes the next
--    version, so an answer always names the exact questions it answered.
-- 3. `supplier_access`: one grant = one supplier contact, scoped to exactly ONE vendor and ONE assessment instance and
--    the one framework applied to it. It expires (at most 30 days) and can be revoked.
-- 4. `supplier_invitations`: the single-use sign-in links of a grant. Only the sha256 of the 256-bit token is stored;
--    a link lives at most 72 hours, is spent on first use, and is revoked with its grant.
-- 5. `supplier_sessions`: what a spent link becomes. Hashed token, an absolute life of at most 8 hours, an idle
--    window enforced by the gateway, revoked with the grant.
-- Every timestamp here is on the database clock (`now()`), never the process clock.

ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "supplier_portal_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_questionnaires" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "questions" jsonb NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone,
  CONSTRAINT "supplier_questionnaires_name_version_uq" UNIQUE ("name", "version"),
  CONSTRAINT "supplier_questionnaires_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "supplier_questionnaires_description_check" CHECK (char_length("description") <= 2000),
  CONSTRAINT "supplier_questionnaires_version_check" CHECK ("version" >= 1),
  CONSTRAINT "supplier_questionnaires_questions_check" CHECK (
    jsonb_typeof("questions") = 'array' AND jsonb_array_length("questions") BETWEEN 1 AND 100
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor_id" uuid NOT NULL REFERENCES "ai_vendors"("id") ON DELETE CASCADE,
  "workflow_instance_id" uuid NOT NULL REFERENCES "workflow_instances"("id") ON DELETE CASCADE,
  "framework" text NOT NULL,
  "questionnaire_id" uuid REFERENCES "supplier_questionnaires"("id") ON DELETE RESTRICT,
  "supplier_email" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_access_email_check" CHECK (
    char_length("supplier_email") BETWEEN 3 AND 254 AND "supplier_email" = lower("supplier_email")
    AND "supplier_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  CONSTRAINT "supplier_access_framework_check" CHECK (char_length("framework") BETWEEN 1 AND 120),
  CONSTRAINT "supplier_access_ttl_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '30 days'
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_access_vendor_idx" ON "supplier_access" ("vendor_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "access_id" uuid NOT NULL REFERENCES "supplier_access"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_invitations_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "supplier_invitations_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "supplier_invitations_ttl_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '72 hours'
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invitations_access_idx" ON "supplier_invitations" ("access_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "access_id" uuid NOT NULL REFERENCES "supplier_access"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "supplier_sessions_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "supplier_sessions_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "supplier_sessions_ttl_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" - "created_at" <= interval '8 hours'
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_sessions_access_idx" ON "supplier_sessions" ("access_id");
--> statement-breakpoint
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0241_supplier_portal_access',
  'org_settings',
  NULL,
  'supplier-portal-setting-strict',
  'Migration 0241 introduced the supplier portal setting at its STRICT value (off): no supplier can sign in and no ' ||
    'access can be granted until an admin turns it on (audited, with a step-up).',
  jsonb_build_object('phase', 'migration-0241', 'settings', jsonb_build_object('supplierPortalEnabled', "supplier_portal_enabled"))
FROM "org_settings";
