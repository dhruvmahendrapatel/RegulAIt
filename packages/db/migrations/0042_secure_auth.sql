-- ADR-0025 — real human authentication: password + server-side sessions,
-- TOTP MFA, OIDC SSO, and the org sign-in policy dials.
--
-- Transition invariant: existing users get NO password (password_hash NULL =
-- password login impossible for them until an admin sets an initial one-time
-- password), API keys keep authenticating byte-identically, and every new
-- org_settings column defaults to the ADR's sane-secure baseline. Applying
-- this migration changes nothing about any existing credential path.

-- users: password + TOTP + lockout state
ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_ciphertext" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_used_step" bigint;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_failed_login_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;
--> statement-breakpoint

-- server-side browser sessions (cookie carries the token; sha256 at rest)
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"idle_minutes" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint

-- password-accepted-awaiting-TOTP state (short-lived, single-use)
CREATE TABLE "auth_mfa_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_mfa_pending_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "auth_mfa_pending" ADD CONSTRAINT "auth_mfa_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- OIDC SSO providers (secrets encrypted, write-only at the API)
CREATE TABLE "oidc_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ciphertext" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_email_domains" jsonb,
	"default_role_id" uuid,
	"jit_provisioning" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- per-redirect authorization state: state/nonce/PKCE verifier live server-side
CREATE TABLE "oidc_login_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"state" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_to" text DEFAULT '/app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oidc_login_states_state_unique" UNIQUE("state")
);
--> statement-breakpoint
ALTER TABLE "oidc_login_states" ADD CONSTRAINT "oidc_login_states_provider_id_oidc_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."oidc_providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- org sign-in policy dials (ADR-0025 sane-secure defaults)
ALTER TABLE "org_settings" ADD COLUMN "password_min_length" integer DEFAULT 12 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "password_require_classes" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "session_lifetime_hours" integer DEFAULT 24 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "session_idle_minutes" integer DEFAULT 120 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "mfa_required" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "sso_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "login_lockout_threshold" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "login_lockout_window_minutes" integer DEFAULT 15 NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "login_lockout_minutes" integer DEFAULT 15 NOT NULL;
