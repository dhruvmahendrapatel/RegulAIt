-- ADR-0186 (batch 4) — dual control, step-up and passkey-signed approvals,
-- signed decision receipts, RFC 3161 timestamps on audit anchors, vendored
-- detection content and four monitor rules.
--
-- Hand-written (never drizzle-kit generate); journal `when` 1785105000000
-- (previous + 1,000,000, CONTRIBUTING_PARALLEL_SESSIONS §4.1).
--
-- SECURE BY DEFAULT, NO GRANDFATHERING (ADR-0180): every new setting defaults
-- to its strict value and the existing org row takes it, as on a first load.
--
-- 1. `webauthn_credentials` — a user's passkeys: the COSE public key
--    (base64url), the signature counter, transports, AAGUID, backed-up flag, a
--    label, and revocation (a revoked passkey is kept, never deleted, so the
--    decisions it signed stay attributable).
-- 2. `webauthn_challenges` — one row per ceremony: purpose register | step_up |
--    approval_sign, bound to the session, the action digest (step_up,
--    approval_sign) and, for approval_sign, the approval and decision. At most
--    5 minutes; single use by `UPDATE … SET used_at = now() WHERE used_at IS
--    NULL AND expires_at > now() RETURNING` (`consumeWebauthnChallenge`). The
--    row's id is also the `stepUpId` of a step-up started with
--    `POST /v1/auth/step-up/options`, whichever method then completes it.
-- 3. `step_up_grants` — an issued step-up: the `rgsu_` token stored only as
--    sha256, session-bound, method passkey | totp | sso, bound to one action
--    kind and digest, single use, at most 900 s (the setting's ceiling).
-- 4. `sso_reauth_requests` — a fresh SSO login started for a step-up (OIDC
--    `max_age=0`/`prompt=login` with state, nonce and PKCE; SAML
--    `ForceAuthn="true"` with the AuthnRequest id): at most 5 minutes, single
--    use, and verified only if the returned identity is the session's user and
--    `auth_time`/`AuthnInstant` is after `requested_at`.
-- 5. `approval_decisions` — APPEND-ONLY (trigger): one row per approving
--    principal with what proved it (method, credential, signed payload and
--    digest, assertion, counter before). UNIQUE(approval, principal). Its
--    parents are ON DELETE SET NULL: the record outlives the approval, the
--    users and the passkey.
-- 6. `approval_rules.quorum` (1–5, default 1) and `approver_role_id`;
--    `approvals.quorum` and `approvals.signature_mode` snapshotted at queue time
--    (consulted for the tool-call kinds `mcp_tool` and `connector_call`). Every
--    existing row takes quorum 1 and the strict `passkey` mode: a pending
--    tool-call approval queued before 0170 must be signed like a new one.
-- 7. `receipt_signing_keys` (PUBLIC keys only: a JWK carrying `d` is refused)
--    and `decision_receipts` — APPEND-ONLY (trigger), one per audit row,
--    chained by `prev_hash`, Ed25519 signature over the canonical payload.
--    No foreign key to `audit_log`: a receipt outlives a pruned audit row.
-- 8. `audit_anchors` + the RFC 3161 token fields; `tsa_status` defaults to
--    `not_configured`, so every existing anchor honestly reads "not
--    timestamped".
-- 9. `org_settings`, all strict (ADR-0186): approval_signature_mode passkey;
--    step_up_mode required; step_up_max_age_seconds 120 (30–900); step_up_actions
--    all six; tool_approval_sensitive_quorum 2 (1–5); decision_receipts_mode on;
--    audit_anchor_timestamp_mode required; vendored_detection_packs all four;
--    monitor_mcp_baseline_days 14 (1–90); monitor_jailbreak_threshold 3 (1–100);
--    monitor_jailbreak_window_hours 24 (1–168).

-- ===== 1. passkeys ===========================================================
CREATE TABLE "webauthn_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "counter" bigint DEFAULT 0 NOT NULL,
  "transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "aaguid" text,
  "backed_up" boolean DEFAULT false NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "revoke_reason" text,
  CONSTRAINT "webauthn_credentials_credential_id_uq" UNIQUE ("credential_id"),
  CONSTRAINT "webauthn_credentials_credential_id_check" CHECK ("credential_id" ~ '^[A-Za-z0-9_-]+$' AND length("credential_id") BETWEEN 16 AND 1366),
  CONSTRAINT "webauthn_credentials_public_key_check" CHECK ("public_key" ~ '^[A-Za-z0-9_-]+$' AND length("public_key") BETWEEN 16 AND 4096),
  CONSTRAINT "webauthn_credentials_counter_check" CHECK ("counter" >= 0),
  CONSTRAINT "webauthn_credentials_transports_check" CHECK (
    jsonb_typeof("transports") = 'array'
    AND "transports" <@ '["usb", "nfc", "ble", "smart-card", "hybrid", "internal", "cable"]'::jsonb
  ),
  CONSTRAINT "webauthn_credentials_aaguid_check" CHECK ("aaguid" IS NULL OR "aaguid" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT "webauthn_credentials_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 100),
  CONSTRAINT "webauthn_credentials_revoke_check" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_idx" ON "webauthn_credentials" ("user_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- ===== 2. ceremonies =========================================================
CREATE TABLE "webauthn_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "challenge" text NOT NULL,
  "action_kind" text,
  "action_digest" text,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE CASCADE,
  "decision" text,
  "signed_payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  CONSTRAINT "webauthn_challenges_challenge_uq" UNIQUE ("challenge"),
  CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("purpose" IN ('register', 'step_up', 'approval_sign')),
  CONSTRAINT "webauthn_challenges_challenge_check" CHECK ("challenge" ~ '^[A-Za-z0-9_-]{22,128}$'),
  CONSTRAINT "webauthn_challenges_expiry_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '5 minutes'
  ),
  CONSTRAINT "webauthn_challenges_used_check" CHECK ("used_at" IS NULL OR "used_at" >= "created_at"),
  CONSTRAINT "webauthn_challenges_action_kind_check" CHECK (
    "action_kind" IS NULL
    OR "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change')
  ),
  CONSTRAINT "webauthn_challenges_action_digest_check" CHECK ("action_digest" IS NULL OR "action_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "webauthn_challenges_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('approved', 'denied')),
  -- the binding each purpose needs, and nothing it does not
  CONSTRAINT "webauthn_challenges_shape_check" CHECK (
    (
      "purpose" = 'register'
      AND "action_kind" IS NULL AND "action_digest" IS NULL
      AND "approval_id" IS NULL AND "decision" IS NULL AND "signed_payload" IS NULL
    )
    OR (
      "purpose" = 'step_up'
      AND "action_kind" IS NOT NULL AND "action_digest" IS NOT NULL
      AND "approval_id" IS NULL AND "decision" IS NULL AND "signed_payload" IS NULL
    )
    OR (
      "purpose" = 'approval_sign'
      AND "action_kind" IS NULL AND "action_digest" IS NOT NULL
      AND "approval_id" IS NOT NULL AND "decision" IS NOT NULL AND "signed_payload" IS NOT NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_idx" ON "webauthn_challenges" ("user_id", "purpose");
--> statement-breakpoint
CREATE INDEX "webauthn_challenges_expires_idx" ON "webauthn_challenges" ("expires_at");
--> statement-breakpoint

-- ===== 3. step-up grants =====================================================
CREATE TABLE "step_up_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
  "step_up_id" uuid REFERENCES "webauthn_challenges"("id") ON DELETE SET NULL,
  "method" text NOT NULL,
  "credential_id" uuid REFERENCES "webauthn_credentials"("id") ON DELETE SET NULL,
  "action_kind" text NOT NULL,
  "action_digest" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  CONSTRAINT "step_up_grants_token_hash_uq" UNIQUE ("token_hash"),
  CONSTRAINT "step_up_grants_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "step_up_grants_method_check" CHECK ("method" IN ('passkey', 'totp', 'sso')),
  CONSTRAINT "step_up_grants_action_kind_check" CHECK (
    "action_kind" IN ('approval_decide', 'settings_relax', 'evidence_hold_override', 'break_glass', 'passkey_manage', 'owner_change')
  ),
  CONSTRAINT "step_up_grants_action_digest_check" CHECK ("action_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "step_up_grants_expiry_check" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '900 seconds'
  ),
  CONSTRAINT "step_up_grants_used_check" CHECK ("used_at" IS NULL OR "used_at" >= "created_at"),
  CONSTRAINT "step_up_grants_passkey_credential_check" CHECK ("credential_id" IS NULL OR "method" = 'passkey')
);
--> statement-breakpoint
CREATE INDEX "step_up_grants_session_idx" ON "step_up_grants" ("session_id");
--> statement-breakpoint
CREATE INDEX "step_up_grants_expires_idx" ON "step_up_grants" ("expires_at");
--> statement-breakpoint

-- ===== 4. fresh SSO login for a step-up ======================================
CREATE TABLE "sso_reauth_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "step_up_id" uuid NOT NULL REFERENCES "webauthn_challenges"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
  "provider_kind" text NOT NULL,
  "oidc_provider_id" uuid REFERENCES "oidc_providers"("id") ON DELETE CASCADE,
  "saml_provider_id" uuid REFERENCES "saml_providers"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "nonce" text NOT NULL,
  "code_verifier" text,
  "redirect_uri" text NOT NULL,
  "action_digest" text NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "auth_time" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  CONSTRAINT "sso_reauth_requests_state_uq" UNIQUE ("state"),
  CONSTRAINT "sso_reauth_requests_provider_kind_check" CHECK ("provider_kind" IN ('oidc', 'saml')),
  CONSTRAINT "sso_reauth_requests_provider_check" CHECK (
    ("provider_kind" = 'oidc' AND "oidc_provider_id" IS NOT NULL AND "saml_provider_id" IS NULL AND "code_verifier" IS NOT NULL)
    OR ("provider_kind" = 'saml' AND "saml_provider_id" IS NOT NULL AND "oidc_provider_id" IS NULL AND "code_verifier" IS NULL)
  ),
  CONSTRAINT "sso_reauth_requests_action_digest_check" CHECK ("action_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sso_reauth_requests_expiry_check" CHECK (
    "expires_at" > "requested_at" AND "expires_at" <= "requested_at" + interval '5 minutes'
  ),
  -- a verified login is one whose identity provider authenticated AFTER the request
  CONSTRAINT "sso_reauth_requests_verified_check" CHECK (
    "verified_at" IS NULL OR ("auth_time" IS NOT NULL AND "auth_time" > "requested_at")
  ),
  CONSTRAINT "sso_reauth_requests_used_check" CHECK ("used_at" IS NULL OR "verified_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "sso_reauth_requests_step_up_idx" ON "sso_reauth_requests" ("step_up_id");
--> statement-breakpoint
CREATE INDEX "sso_reauth_requests_expires_idx" ON "sso_reauth_requests" ("expires_at");
--> statement-breakpoint

-- ===== 5–6. dual control =====================================================
ALTER TABLE "approval_rules" ADD COLUMN "quorum" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "approver_role_id" uuid REFERENCES "roles"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_quorum_check" CHECK ("quorum" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "quorum" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "signature_mode" text DEFAULT 'passkey' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_quorum_check" CHECK ("quorum" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_signature_mode_check" CHECK ("signature_mode" IN ('passkey', 'step_up', 'off'));
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "approval_id" uuid REFERENCES "approvals"("id") ON DELETE SET NULL,
  "decider_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "principal_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decision" text NOT NULL,
  "reason" text,
  "step_up_method" text NOT NULL,
  "credential_id" uuid REFERENCES "webauthn_credentials"("id") ON DELETE SET NULL,
  "signed_payload" jsonb,
  "signed_digest" text,
  "assertion" jsonb,
  "counter_before" bigint,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "approval_decisions_approval_principal_uq" UNIQUE ("approval_id", "principal_user_id"),
  CONSTRAINT "approval_decisions_decision_check" CHECK ("decision" IN ('approved', 'denied')),
  CONSTRAINT "approval_decisions_method_check" CHECK ("step_up_method" IN ('passkey', 'totp', 'sso', 'none')),
  CONSTRAINT "approval_decisions_signed_digest_check" CHECK ("signed_digest" IS NULL OR "signed_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "approval_decisions_counter_check" CHECK ("counter_before" IS NULL OR "counter_before" >= 0),
  -- a SIGNED decision (signature mode passkey) carries everything needed to
  -- re-verify it — payload, digest, assertion and counter, all or none — and
  -- only a passkey can have produced it; a passkey step-up (mode step_up) names
  -- its credential without a signature over the call
  CONSTRAINT "approval_decisions_signature_shape_check" CHECK (
    ("signed_payload" IS NULL) = ("signed_digest" IS NULL)
    AND ("signed_payload" IS NULL) = ("assertion" IS NULL)
    AND ("signed_payload" IS NULL) = ("counter_before" IS NULL)
    AND ("signed_payload" IS NULL OR "step_up_method" = 'passkey')
    AND ("credential_id" IS NULL OR "step_up_method" = 'passkey')
  ),
  CONSTRAINT "approval_decisions_reason_check" CHECK ("reason" IS NULL OR length("reason") <= 2000)
);
--> statement-breakpoint
CREATE INDEX "approval_decisions_approval_idx" ON "approval_decisions" ("approval_id", "decided_at");
--> statement-breakpoint
CREATE TRIGGER "approval_decisions_append_only"
  BEFORE UPDATE OR DELETE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint

-- ===== 7. receipts ===========================================================
CREATE TABLE "receipt_signing_keys" (
  "key_id" text PRIMARY KEY NOT NULL,
  "algorithm" text DEFAULT 'Ed25519' NOT NULL,
  "public_jwk" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "first_used_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  CONSTRAINT "receipt_signing_keys_key_id_check" CHECK ("key_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "receipt_signing_keys_algorithm_check" CHECK ("algorithm" = 'Ed25519'),
  -- PUBLIC keys only: an OKP Ed25519 JWK with `x` and never the private `d`
  -- (COALESCE: a missing member makes the test NULL, which a CHECK would pass)
  CONSTRAINT "receipt_signing_keys_public_only_check" CHECK (
    COALESCE(
      jsonb_typeof("public_jwk") = 'object'
      AND "public_jwk" ->> 'kty' = 'OKP'
      AND "public_jwk" ->> 'crv' = 'Ed25519'
      AND jsonb_typeof("public_jwk" -> 'x') = 'string'
      AND NOT ("public_jwk" ? 'd'),
      false
    )
  )
);
--> statement-breakpoint
CREATE TRIGGER "receipt_signing_keys_never_deleted"
  BEFORE DELETE ON "receipt_signing_keys"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint
CREATE TABLE "decision_receipts" (
  "receipt_seq" bigint PRIMARY KEY NOT NULL,
  "audit_id" uuid NOT NULL,
  "audit_seq" bigint NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "prev_hash" text NOT NULL,
  "signature" text NOT NULL,
  "key_id" text NOT NULL REFERENCES "receipt_signing_keys"("key_id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_receipts_audit_id_uq" UNIQUE ("audit_id"),
  CONSTRAINT "decision_receipts_audit_seq_uq" UNIQUE ("audit_seq"),
  CONSTRAINT "decision_receipts_seq_check" CHECK ("receipt_seq" >= 1),
  CONSTRAINT "decision_receipts_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "decision_receipts_prev_hash_check" CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "decision_receipts_signature_check" CHECK ("signature" ~ '^[A-Za-z0-9_-]{86}$'),
  -- the stored payload states the row's own seq, key and prev (COALESCE: a
  -- missing member makes the test NULL, which a CHECK would pass)
  CONSTRAINT "decision_receipts_payload_check" CHECK (
    COALESCE(
      jsonb_typeof("payload") = 'object'
      AND "payload" ->> 'v' = 'regulait.receipt.v1'
      AND jsonb_typeof("payload" -> 'receiptSeq') = 'number'
      AND "payload" ->> 'receiptSeq' = "receipt_seq"::text
      AND "payload" ->> 'keyId' = "key_id"
      AND "payload" ->> 'prev' = "prev_hash",
      false
    )
  )
);
--> statement-breakpoint
CREATE TRIGGER "decision_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "decision_receipts"
  FOR EACH ROW EXECUTE FUNCTION "regulait_refuse_mutation"();
--> statement-breakpoint

-- ===== 8. RFC 3161 timestamps on audit anchors ===============================
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_status" text DEFAULT 'not_configured' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_url" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_token" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_gen_time" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_serial" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_policy_oid" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_message_imprint" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_nonce" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "tsa_last_error" text;
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_status_check" CHECK ("tsa_status" IN ('not_configured', 'pending', 'granted', 'failed'));
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_attempts_check" CHECK ("tsa_attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_imprint_check" CHECK ("tsa_message_imprint" IS NULL OR "tsa_message_imprint" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_policy_oid_check" CHECK ("tsa_policy_oid" IS NULL OR "tsa_policy_oid" ~ '^[0-2](\.[0-9]+)+$');
--> statement-breakpoint
-- a granted timestamp carries its token, time, imprint and the TSA it came from
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tsa_granted_check" CHECK (
  "tsa_status" <> 'granted'
  OR ("tsa_token" IS NOT NULL AND "tsa_gen_time" IS NOT NULL AND "tsa_message_imprint" IS NOT NULL AND "tsa_url" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "audit_anchors_tsa_due_idx" ON "audit_anchors" ("tsa_status", "tsa_next_attempt_at");
--> statement-breakpoint

-- ===== 9. org settings, all strict ===========================================
ALTER TABLE "org_settings" ADD COLUMN "approval_signature_mode" text DEFAULT 'passkey' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "step_up_mode" text DEFAULT 'required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "step_up_max_age_seconds" integer DEFAULT 120 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "step_up_actions" jsonb DEFAULT '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "tool_approval_sensitive_quorum" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "decision_receipts_mode" text DEFAULT 'on' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "audit_anchor_timestamp_mode" text DEFAULT 'required' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "vendored_detection_packs" jsonb DEFAULT '["pipelock-secrets", "pipelock-normalise", "nemo-yara-injection", "agt-mcp-heuristics"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "monitor_mcp_baseline_days" integer DEFAULT 14 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "monitor_jailbreak_threshold" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "monitor_jailbreak_window_hours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_approval_signature_mode_check" CHECK ("approval_signature_mode" IN ('passkey', 'step_up', 'off'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_mode_check" CHECK ("step_up_mode" IN ('required', 'off'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_max_age_seconds_check" CHECK ("step_up_max_age_seconds" BETWEEN 30 AND 900);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_step_up_actions_check" CHECK (
  jsonb_typeof("step_up_actions") = 'array'
  AND "step_up_actions" <@ '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_tool_approval_sensitive_quorum_check" CHECK ("tool_approval_sensitive_quorum" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_decision_receipts_mode_check" CHECK ("decision_receipts_mode" IN ('on', 'off'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_audit_anchor_timestamp_mode_check" CHECK ("audit_anchor_timestamp_mode" IN ('required', 'off'));
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_vendored_detection_packs_check" CHECK (
  jsonb_typeof("vendored_detection_packs") = 'array'
  AND "vendored_detection_packs" <@ '["pipelock-secrets", "pipelock-normalise", "nemo-yara-injection", "agt-mcp-heuristics"]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_monitor_mcp_baseline_days_check" CHECK ("monitor_mcp_baseline_days" BETWEEN 1 AND 90);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_monitor_jailbreak_threshold_check" CHECK ("monitor_jailbreak_threshold" BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_monitor_jailbreak_window_hours_check" CHECK ("monitor_jailbreak_window_hours" BETWEEN 1 AND 168);
