-- ADR-0181 (strict defaults everywhere) — FX2: identity follow-ups from the
-- security review of the integrated batch.
--
-- 1. migration_audit_outbox: a migration that changes existing records leaves
--    an audit trail. SQL cannot write a CHAINED audit row (the chain is
--    computed at createDb), so the rows go here, in this transaction, and
--    runMigrations drains them into audit_log through the chained path
--    straight after (packages/db/src/migrate.ts).
-- 2. saml_providers: JIT provisioning now REQUIRES a non-empty
--    allowed_email_domains list (CHECK), mirroring 0156 for OIDC. A provider
--    that had JIT on with no list has JIT turned off — the strict state, until
--    an admin names the domains — one audit row each.
-- 3. saml_providers.want_authn_response_signed: 0156 turned it on for every
--    provider. An IdP that signs only the assertion cannot sign in until an
--    admin relaxes it, so each provider with the setting on gets an audit row
--    saying so. (Which rows 0156 itself flipped cannot be told apart reliably
--    afterwards, so every provider with the setting on is recorded.)
-- 4. api_keys: no grandfathering. A live key with no expiry, or one expiring
--    beyond the org's key-lifetime ceiling, is given the ceiling (365 days
--    from now unless an admin has set another). One summary audit row. If an
--    admin has already relaxed the ceiling to "none", existing keys are left
--    as they are: that relaxation is the admin's audited choice.

CREATE TABLE IF NOT EXISTS "migration_audit_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "migration" text NOT NULL,
  "object_type" text NOT NULL,
  "object_id" uuid,
  "rule_id" text NOT NULL,
  "reason" text NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
WITH "changed" AS (
  UPDATE "saml_providers" SET "jit_provisioning" = false, "updated_at" = now()
  WHERE "jit_provisioning"
    AND NOT (CASE WHEN jsonb_typeof("allowed_email_domains") = 'array' THEN jsonb_array_length("allowed_email_domains") > 0 ELSE false END)
  RETURNING "id", "name", "allowed_email_domains"
)
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0160_strict_identity_followups',
  'saml_provider',
  "id",
  'jit_requires_allowed_domains',
  'SAML provider ''' || "name" || ''': JIT provisioning turned off by migration 0160 because it named no allowed email domains (ADR-0181). An admin turns it back on by naming the domains.',
  jsonb_build_object(
    'phase', 'migration-0160',
    'name', "name",
    'allowedEmailDomains', "allowed_email_domains",
    'transitions', jsonb_build_object('jitProvisioning', jsonb_build_object('from', true, 'to', false))
  )
FROM "changed";
--> statement-breakpoint
ALTER TABLE "saml_providers" DROP CONSTRAINT IF EXISTS "saml_providers_jit_domains_ck";
--> statement-breakpoint
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_jit_domains_ck" CHECK (
  NOT "jit_provisioning" OR (CASE WHEN jsonb_typeof("allowed_email_domains") = 'array' THEN jsonb_array_length("allowed_email_domains") > 0 ELSE false END)
);
--> statement-breakpoint
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0160_strict_identity_followups',
  'saml_provider',
  "id",
  'saml-response-signing-required',
  'SAML provider ''' || "name" || ''' requires a signed SAML Response (wantAuthnResponseSigned, strict since migration 0156, ADR-0181). An identity provider that signs only the assertion cannot sign in until it signs the Response or an admin relaxes wantAuthnResponseSigned on this provider.',
  jsonb_build_object(
    'phase', 'migration-0160',
    'name', "name",
    'setting', 'wantAuthnResponseSigned',
    'value', true,
    'strictSince', '0156_strict_identity_defaults'
  )
FROM "saml_providers"
WHERE "want_authn_response_signed";
--> statement-breakpoint
WITH "ceiling" AS (
  -- the org's key-lifetime ceiling in days; 365 (the strict default) when the
  -- singleton row does not exist yet; NULL when an admin relaxed it to "none"
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM "org_settings") THEN (SELECT "api_key_max_ttl_days" FROM "org_settings" LIMIT 1)
    ELSE 365
  END AS "days"
),
"target" AS (
  SELECT k."id", k."expires_at" AS "old_expires_at", c."days"
  FROM "api_keys" AS k CROSS JOIN "ceiling" AS c
  WHERE c."days" IS NOT NULL
    AND k."revoked_at" IS NULL
    AND (k."expires_at" IS NULL OR k."expires_at" > now() + make_interval(days => c."days"))
),
"changed" AS (
  UPDATE "api_keys" AS k
  SET "expires_at" = now() + make_interval(days => t."days")
  FROM "target" AS t
  WHERE k."id" = t."id"
  RETURNING k."id", t."old_expires_at", t."days"
)
INSERT INTO "migration_audit_outbox" ("migration", "object_type", "object_id", "rule_id", "reason", "detail")
SELECT
  '0160_strict_identity_followups',
  'api_key',
  NULL,
  'api-key-expiry-backfilled',
  'Migration 0160 gave ' || count(*) || ' live API key(s) the org key-lifetime ceiling of ' || max("days") ||
    ' days (ADR-0181, no grandfathering): ' || count(*) FILTER (WHERE "old_expires_at" IS NULL) || ' never expired, ' ||
    count(*) FILTER (WHERE "old_expires_at" IS NOT NULL) || ' expired beyond the ceiling.',
  jsonb_build_object(
    'phase', 'migration-0160',
    'keys', count(*),
    'neverExpiring', count(*) FILTER (WHERE "old_expires_at" IS NULL),
    'beyondCeiling', count(*) FILTER (WHERE "old_expires_at" IS NOT NULL),
    'ceilingDays', max("days"),
    'expiresAt', to_jsonb(now() + make_interval(days => max("days"))),
    'keyIds', jsonb_agg("id" ORDER BY "id")
  )
FROM "changed"
HAVING count(*) > 0;
