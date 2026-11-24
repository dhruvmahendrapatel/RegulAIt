-- ADR-0350 §11 (lane E31): credential reuse across endpoints. A device reports a keyed HMAC of each discovered secret
-- under the tenant's credential-reuse key (the value never leaves the device). `fingerprint` is NOT that device value:
-- it is HMAC(server key, key id ‖ device fingerprint) under a key derived from the gateway's data key, so a copy of
-- this table plus a device's key cannot test guesses. One row per agent identity, key id and fingerprint; the device
-- and the user pseudonym are joined through endpoint_agent_identities, never copied. The same value on two active
-- devices or users is a reuse finding. Rows are pruned on report ingest (ADR-0350 §11).
--
-- Row-level security, ENABLED and FORCED: an active admin principal and the `system_task` and `migration` reasons
-- only. The report route writes as the system (the device's own call), like the other endpoint report tables.
CREATE TABLE IF NOT EXISTS "endpoint_credential_fingerprints" (
  "identity_id" uuid NOT NULL REFERENCES "endpoint_agent_identities"("identity_id") ON DELETE CASCADE,
  "key_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "rule_id" text,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reuse_reported_at" timestamp with time zone,
  CONSTRAINT "endpoint_credential_fingerprints_identity_id_key_id_fingerprint_pk" PRIMARY KEY ("identity_id", "key_id", "fingerprint"),
  CONSTRAINT "endpoint_credential_fingerprints_key_id_check" CHECK ("key_id" ~ '^[0-9a-f]{16}$'),
  CONSTRAINT "endpoint_credential_fingerprints_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "endpoint_credential_fingerprints_match_idx" ON "endpoint_credential_fingerprints" ("key_id", "fingerprint");
--> statement-breakpoint
ALTER TABLE "endpoint_credential_fingerprints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "endpoint_credential_fingerprints" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "endpoint_credential_fingerprints_admin" ON "endpoint_credential_fingerprints";
--> statement-breakpoint
CREATE POLICY "endpoint_credential_fingerprints_admin" ON "endpoint_credential_fingerprints" FOR ALL
  USING ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']))
  WITH CHECK ((SELECT regulait_rls_is_admin()) OR (SELECT regulait_rls_system_reason()) = ANY (ARRAY['system_task', 'migration']));
