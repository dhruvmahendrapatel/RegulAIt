-- Migration 0051 (ADR-0036) — SAML 2.0 SSO as a SECOND federated login path
-- beside OIDC. Everything here is a twin of the 0042 OIDC tables: the point of
-- the ADR is that SAML extends the existing registry/JIT/audit machinery by
-- analogy rather than by inventing a second pattern.
--
-- FIRST, and load-bearing: migration 0046 put a CHECK on auth_sessions.origin
-- enumerating ('password','api_key','oidc','bootstrap','unknown'). A `saml`
-- origin that is not in that list typechecks in drizzle and then fails 23514
-- on the very first SAML login. The constraint is therefore DROPPED and
-- re-added with 'saml' admitted. No data changes: no existing row can hold a
-- value the old constraint refused.
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_origin_ck";
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_origin_ck" CHECK ("auth_sessions"."origin" IN ('password', 'api_key', 'oidc', 'saml', 'bootstrap', 'unknown'));
--> statement-breakpoint
-- The provider registry. `entity_id` is the IDP's entity id / Issuer — our own
-- SP entity id is deployment-global and derived per request (exactly like the
-- OIDC redirect_uri), never stored per provider.
--
-- `idp_signing_certs` is a jsonb ARRAY, not a single column: certificate
-- ROLLOVER has no `.well-known` auto-refresh in SAML, so an operator must be
-- able to stage the incoming cert alongside the outgoing one and cut over
-- without a login outage. An assertion verifies if ANY pinned cert verifies
-- it. Signatures are checked against THESE certs and never against a
-- certificate embedded in the document — that pinning is the whole defence
-- against signature-wrapping.
--
-- `jit_provisioning` DEFAULT FALSE and `allow_idp_initiated` DEFAULT FALSE are
-- the two default-deny switches: an unknown subject is refused and audited,
-- and an unsolicited (IdP-initiated) assertion is refused unless the admin
-- consciously opted this provider in.
CREATE TABLE "saml_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "entity_id" text NOT NULL,
  "idp_sso_url" text NOT NULL,
  "idp_signing_certs" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "allowed_email_domains" jsonb,
  "default_role_id" uuid,
  "jit_provisioning" boolean DEFAULT false NOT NULL,
  "want_assertions_signed" boolean DEFAULT true NOT NULL,
  "want_authn_response_signed" boolean DEFAULT false NOT NULL,
  "allow_idp_initiated" boolean DEFAULT false NOT NULL,
  "email_attribute" text,
  "sp_private_key_ciphertext" text,
  "sp_certificate" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "saml_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
-- ON DELETE SET NULL, identical to oidc_providers.default_role_id: deleting a
-- role must never cascade into deleting a login path.
ALTER TABLE "saml_providers" ADD CONSTRAINT "saml_providers_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- The oidc_login_states twin. The AuthnRequest `request_id` is what the IdP
-- echoes back as InResponseTo, so THIS ROW is the proof that the login was
-- solicited by us: with allow_idp_initiated off, an assertion with no matching
-- outstanding row is refused. Single-use (claimed and deleted) and swept by
-- expiry, exactly like the OIDC state row.
CREATE TABLE "saml_login_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "request_id" text NOT NULL,
  "relay_state" text NOT NULL,
  "return_to" text DEFAULT '/app' NOT NULL,
  "acs_url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "saml_login_states_request_id_unique" UNIQUE("request_id"),
  CONSTRAINT "saml_login_states_relay_state_unique" UNIQUE("relay_state")
);
--> statement-breakpoint
ALTER TABLE "saml_login_states" ADD CONSTRAINT "saml_login_states_provider_id_saml_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."saml_providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- The REPLAY seen-set. A captured assertion is still perfectly signed and
-- still inside its NotOnOrAfter for minutes after it was used; the assertion
-- ID is recorded on acceptance and a second presentation is refused. The
-- UNIQUE index is the enforcement (an insert conflict IS the refusal, so two
-- concurrent replays cannot both win a check-then-insert race); it is global
-- rather than per-provider so a second registered provider cannot be used to
-- re-play the first one's assertion. Rows are swept once expires_at passes,
-- at which point the assertion is refused on its own timestamps anyway.
CREATE TABLE "saml_assertion_ids" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "assertion_id" text NOT NULL,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "saml_assertion_ids_assertion_id_unique" UNIQUE("assertion_id")
);
--> statement-breakpoint
ALTER TABLE "saml_assertion_ids" ADD CONSTRAINT "saml_assertion_ids_provider_id_saml_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."saml_providers"("id") ON DELETE cascade ON UPDATE no action;
