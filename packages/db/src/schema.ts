import { sql } from "drizzle-orm";
import { APPROVAL_OBJECT_TYPES } from "@regulait/shared";
import {
  bigint,
  check,
  integer,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ADR-0042 (migration 0055) — the guardrail vocabulary, declared HERE rather
// than imported from @regulait/shared because this package deliberately has no
// dependency on it. The two definitions are kept in lockstep by the gateway,
// which imports both and would not type-check if they diverged.
/** the detector classes the guardrail registry evaluates */
export const GUARDRAIL_DETECTOR_IDS = [
  "pii",
  "prompt_injection",
  "jailbreak",
  "toxicity",
  "semantic_dlp",
] as const;
export type GuardrailDetectorId = (typeof GUARDRAIL_DETECTOR_IDS)[number];
/** `log|warn|block` is exactly the piiMode triad; `off` is the per-detector
 * "do not run this at all" that piiMode expresses as a NULL cascade result */
export const GUARDRAIL_MODES = ["off", "log", "warn", "block"] as const;
export type GuardrailMode = (typeof GUARDRAIL_MODES)[number];
/** admin-supplied extra vocabulary per detector, additive across scopes */
export type GuardrailTermMap = Partial<Record<GuardrailDetectorId, string[]>>;

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  /** ADR-0030 (migration 0047): the SECOND login identifier. NULL = this user
   * signs in by email only (every pre-0047 user). UNIQUE, and lowercase by
   * construction — the DB CHECK admits `^[a-z0-9][a-z0-9._-]{1,62}$` only, so
   * a plain unique index IS case-insensitive uniqueness and `Dhruv` cannot
   * coexist with `dhruv` (it cannot be stored at all). The shape forbids '@',
   * which is what keeps the username and email namespaces provably disjoint:
   * one login field resolves both, and a username can never impersonate
   * someone else's email address. */
  username: text("username").unique(),
  displayName: text("display_name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  /** ADR-0022 identity lifecycle: a DISABLED user (offboarding, suspension).
   * Deactivate ≠ delete — every FK, audit row and history survives; only
   * authentication (401 user_disabled) and dispatch-as stop. Null = active.
   * Reactivation clears it. There is deliberately NO hard-delete route. */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  // --- ADR-0025 human sign-in (migration 0042) -----------------------------
  /** scrypt password hash, format scrypt$N$r$p$saltB64$hashB64. NULL = this
   * user has NO password and password login is impossible for them (the 0042
   * transition state) until an admin sets an initial one-time password. */
  passwordHash: text("password_hash"),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
  /** true = the current password is one-time (admin-issued or seeded); every
   * session-authenticated request except the auth self-service surface is
   * refused until the user sets their own. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /** TOTP secret, AES-256-GCM under REGULAIT_DATA_KEY like every other stored
   * secret. Present-but-disabled = enrollment started, not yet verified. */
  totpSecretCiphertext: text("totp_secret_ciphertext"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  /** replay guard: the highest RFC 6238 time-step already consumed — a code
   * for a step <= this is refused even inside the ±1 validation window. */
  totpLastUsedStep: bigint("totp_last_used_step", { mode: "number" }),
  /** ADR-0037 (migration 0052): the IdP's OWN id for this user, as asserted on
   * the SCIM `externalId` attribute. NULL for every locally-created user and
   * every pre-0052 row — none was invented. Unique among non-null values.
   *
   * It exists for exactly one reason: email is the SCIM join key, so an IdP
   * that changes someone's primary email would otherwise mint a SECOND
   * account. A connector that correlates by SCIM id first can find the
   * existing row and re-map the email onto it. */
  scimExternalId: text("scim_external_id"),
  /** login lockout counters (org_settings dials set the thresholds) */
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  /** ADR-0069 (migration 0081): the customer's own cost-centre code for this
   * PERSON. `projects.cost_center` and `initiatives.cost_center` already carry
   * the code for a governed unit of work, and metered spend rolls up through
   * them — but per-seat SaaS spend imported from a vendor invoice belongs to a
   * human, not to a project, and there was nowhere to put the chargeback key
   * for it. NULL = no cost centre; imported lines for that person roll up under
   * "(no cost centre)" rather than being guessed from their memberships, which
   * would be ambiguous the moment somebody belongs to two. */
  costCenter: text("cost_center"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
},
  (t) => [
    // ADR-0037: unique among NON-NULL values (Postgres treats NULLs as
    // distinct), so an IdP id maps to at most one account while every user
    // that never came from an IdP keeps a null.
    uniqueIndex("users_scim_external_id_uq").on(t.scimExternalId),
    /** ADR-0109 (migration 0108) — THE FUNCTIONAL index. `users_email_unique`
     * is UNIQUE on `email` EXACTLY, but every identity path in this codebase
     * (login, OIDC/SAML JIT, SCIM, the bulk importer) looks the address up
     * CASE-FOLDED, so 'Ada@x' and 'ada@x' were two legal rows that both matched
     * one login. ADR-0107 could only make that lookup deterministic
     * (`asc(createdAt), asc(id)`, "first registration owns the address") and
     * called it a stopgap; this is the fix. Consequence, deliberately visible:
     * POST /v1/users with a case-variant of an existing address now answers 409
     * (app.ts already maps 23505) instead of creating a second account. */
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
  ],
);

// --- ADR-0025: server-side browser sessions ---------------------------------
// The cookie carries a 256-bit random token; only its sha256 is stored — a DB
// leak never yields a usable session. userId NULL = a bootstrap-token session
// (the operator exchanged the deploy-time bootstrap token for a cookie); it is
// admin-privileged exactly like the header form and dies when the deployment's
// bootstrap token is unset.
/** ADR-0028 (migration 0046): HOW a session was established.
 * - `password`  — POST /auth/login (password, no MFA required)
 * - `api_key`   — POST /auth/login-with-key with a user's API key
 * - `oidc`      — the OIDC callback minted it
 * - `saml`      — ADR-0036 (migration 0051): the SAML Assertion Consumer
 *   Service minted it. Co-equal with `oidc`: same session machinery, same
 *   default-deny JIT posture, and — like `oidc` — it NEVER receives the
 *   ADR-0028 current-password bypass (that bypass is `api_key`-only).
 * - `bootstrap` — POST /auth/login-with-key with the deploy-time bootstrap token
 * - `unknown`   — a pre-0046 row. The true origin is unknowable and was NOT
 *   invented at backfill time; `unknown` never receives the ADR-0028
 *   current-password bypass (fail closed).
 * Sessions completed through MFA are `password` — the second factor does not
 * change WHICH credential established the session. */
export const SESSION_ORIGINS = ["password", "api_key", "oidc", "saml", "bootstrap", "unknown"] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/** ADR-0039 (migration 0050): the IP-policy levels shared by BOTH knobs
 * (session_ip_policy for human sessions, api_key_ip_policy for the automation
 * path). off = today; enforce_at_login gates session CREATION only;
 * enforce_continuous gates every authenticated use and force-revokes an
 * out-of-envelope session on the spot. Fail-closed: an undeterminable client
 * IP under an enforcing policy is denied. */
export const IP_POLICIES = ["off", "enforce_at_login", "enforce_continuous"] as const;
export type IpPolicy = (typeof IP_POLICIES)[number];

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** see SESSION_ORIGINS. NO drizzle-side default on purpose: the DB column
     * defaults to the fail-closed 'unknown' (that is what backfilled the
     * pre-0046 rows), but application inserts must state an origin explicitly
     * — a new session-creation path that forgets one is a type error. */
    origin: text("origin", { enum: SESSION_ORIGINS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** absolute lifetime wall — never slides */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** idle wall — slides forward on every authenticated use */
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    /** snapshot of org sessionIdleMinutes at creation (what the slide adds) */
    idleMinutes: integer("idle_minutes").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    ip: text("ip"),
    /** ADR-0039 (migration 0050): where the session was LAST used (`ip` above
     * stays the creation-time record). Written in the SAME update as the
     * idle-slide on every authenticated use — no extra query. Nullable:
     * pre-0050 rows carry no record and none was invented. */
    lastSeenIp: text("last_seen_ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** ADR-0174 (migration 0139): the identity provider asserted MFA (RFC 8176
     * `amr`, or a configured `acr`) for the login that minted this session.
     * Such a session satisfies the org MFA requirement without a RegulAIt TOTP
     * enrolment. false for every other origin and every pre-0139 row. */
    idpMfa: boolean("idp_mfa").notNull().default(false),
  },
  (t) => [
    index("auth_sessions_user_idx").on(t.userId),
    // ADR-0036 (migration 0051) widened this to admit 'saml'. The constraint
    // is the wall that would otherwise make every SAML session insert fail —
    // adding the origin to SESSION_ORIGINS without widening it here would
    // typecheck and then 23514 at runtime.
    check(
      "auth_sessions_origin_ck",
      sql`${t.origin} IN ('password', 'api_key', 'oidc', 'saml', 'bootstrap', 'unknown')`,
    ),
  ],
);

export const MFA_PENDING_ORIGINS = ["password", "saml"] as const;
/** short-lived password-accepted-awaiting-TOTP state (ADR-0025). Token hashed
 * like a session's; consumed on success; expires in minutes either way. */
export const authMfaPending = pgTable("auth_mfa_pending", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** ADR-0174 security review (migration 0139): the origin the session takes
   * once the code verifies — `password`, or `saml` for a SAML login that had
   * to step up to the account's own TOTP because the assertion did not carry
   * a multi-factor AuthnContextClassRef. */
  origin: text("origin", { enum: MFA_PENDING_ORIGINS }).notNull().default("password"),
  /** the SAML provider a `saml` step-up came through (null for `password`) */
  samlProviderId: uuid("saml_provider_id").references(() => samlProviders.id, { onDelete: "cascade" }),
}, (t) => [check("auth_mfa_pending_origin_ck", sql`${t.origin} IN ('password', 'saml')`)]);

// --- ADR-0025: OIDC SSO ------------------------------------------------------
export const oidcProviders = pgTable("oidc_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  issuerUrl: text("issuer_url").notNull(),
  clientId: text("client_id").notNull(),
  /** AES-256-GCM under REGULAIT_DATA_KEY; write-only at the API */
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  /** NULL = any domain; else the verified email claim's domain must be listed */
  allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),
  /** role granted to JIT-provisioned users (never admin); NULL = no role */
  defaultRoleId: uuid("default_role_id").references(() => roles.id, { onDelete: "set null" }),
  /** default-deny: an unknown subject with JIT off is 403'd and audited */
  jitProvisioning: boolean("jit_provisioning").notNull().default(false),
  /** ADR-0038 (migration 0053): which id_token claim carries group membership
   * (commonly `groups`, sometimes `roles` or a vendor-namespaced URI).
   *
   * NULL — the default, and every pre-0053 row — means this provider emits NO
   * group signal, so a login through it never reconciles group-derived roles.
   * Naming the claim is an explicit admin act, exactly like naming an email
   * attribute. Naming it does NOT grant anything: an asserted group still
   * confers nothing until an admin maps it (`group_role_mappings`). */
  groupsClaim: text("groups_claim"),
  /** ADR-0174 (migration 0139): the upstream identity providers a BROKER
   * (Keycloak) offers through this client — a subset of BROKER_IDPS. NULL =
   * an ordinary enterprise IdP. Each entry becomes a "Continue with …" button
   * that passes the broker an IdP hint (`kc_idp_hint`). */
  brokerIdps: jsonb("broker_idps").$type<string[]>(),
  /** ADR-0174: `acr` values that count as multi-factor for this provider, in
   * addition to the RFC 8176 `amr` values. NULL = amr only. */
  mfaAcrValues: jsonb("mfa_acr_values").$type<string[]>(),
  /** ADR-0174 security review: this provider is a broker that itself enforces
   * a second factor (the bundled Keycloak realm requires a code or passkey), so
   * a single `otp`/`hwk`/`swk` amr from it counts as MFA. false = the amr must
   * say `mfa` or name two distinct factor classes. */
  brokerEnforcesMfa: boolean("broker_enforces_mfa").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** one row per authorization redirect: state (single-use), nonce and the PKCE
 * verifier live server-side, never in the browser. Swept by expiry. */
export const oidcLoginStates = pgTable("oidc_login_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => oidcProviders.id, { onDelete: "cascade" }),
  state: text("state").notNull().unique(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  /** post-login browser destination — restricted to /app or /admin */
  returnTo: text("return_to").notNull().default("/app"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// --- ADR-0036: SAML 2.0 SSO (migration 0051) ---------------------------------
// A SAML twin of oidcProviders, shape-for-shape, so the admin surface, the JIT
// policy and the audit objectType extend by ANALOGY rather than by a new
// pattern. The two federated paths are co-equal: same createSession, same
// default-deny posture, same allowed-domain backstop.
export const samlProviders = pgTable("saml_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** the IdP's entity id / Issuer. Our SP entity id is deployment-global (it
   * is derived per-request, exactly like the OIDC redirect_uri); THIS column
   * is the value we pin an assertion's <Issuer> against. */
  entityId: text("entity_id").notNull(),
  /** the IdP SingleSignOn endpoint an SP-initiated AuthnRequest 302s to */
  idpSsoUrl: text("idp_sso_url").notNull(),
  /** the IdP's X.509 signing certificate(s), PEM. A LIST so a certificate
   * ROLLOVER can stage the incoming cert before the IdP cuts over — an
   * assertion signed by ANY pinned cert verifies. Signatures are verified
   * against these pinned certs, NEVER against a cert embedded in the
   * document: that pinning is what defeats signature-wrapping. */
  idpSigningCerts: jsonb("idp_signing_certs").$type<string[]>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** NULL = any domain; else the asserted email's domain must be listed. The
   * MANDATORY backstop — an IdP email attribute is only as trustworthy as the
   * IdP's own verification, so an empty list is a conscious admin choice. */
  allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),
  /** role granted to JIT-provisioned users (never admin); NULL = no role */
  defaultRoleId: uuid("default_role_id").references(() => roles.id, { onDelete: "set null" }),
  /** default-deny: an unknown subject with JIT off is 403'd and audited */
  jitProvisioning: boolean("jit_provisioning").notNull().default(false),
  /** posture flags handed straight to the library. Defaulting BOTH signature
   * requirements on would break the (common) IdP that signs only the
   * assertion, so want_authn_response_signed defaults false while
   * want_assertions_signed defaults TRUE — at least one signature over the
   * assertion is always required, and turning want_assertions_signed off is
   * refused at the API (see samlProviderSchema). */
  wantAssertionsSigned: boolean("want_assertions_signed").notNull().default(true),
  wantAuthnResponseSigned: boolean("want_authn_response_signed").notNull().default(false),
  /** IdP-initiated SSO is a known CSRF / stolen-assertion surface: OPT-IN per
   * provider. Off (the default) means an assertion with no matching
   * outstanding InResponseTo correlation row is REFUSED. */
  allowIdpInitiated: boolean("allow_idp_initiated").notNull().default(false),
  /** the SAML attribute carrying the email when the NameID format is not
   * emailAddress. NULL = try the usual suspects (NameID/emailAddress, the
   * `email`/`mail` profile keys, urn:oid:0.9.2342.19200300.100.1.3). */
  emailAttribute: text("email_attribute"),
  /** OPTIONAL SP-side private key for request signing / encrypted assertions.
   * AES-256-GCM under REGULAIT_DATA_KEY, WRITE-ONLY at the API — byte-identical
   * handling to oidc_providers.client_secret_ciphertext and the TOTP secret. */
  spPrivateKeyCiphertext: text("sp_private_key_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  /** the matching SP public certificate (PEM) — public by definition, it is
   * published in our SP metadata for the IdP admin to consume. */
  spCertificate: text("sp_certificate"),
  /** ADR-0038 (migration 0053): the SAML attribute carrying group membership
   * (`groups`, `memberOf`, `http://schemas.xmlsoap.org/claims/Group`, …).
   *
   * NULL — the default, and every pre-0053 row — means this provider emits NO
   * group signal, so a login through it never reconciles group-derived roles.
   * Naming it grants nothing on its own: an asserted group confers nothing
   * until an admin maps it (`group_role_mappings`). */
  groupsAttribute: text("groups_attribute"),
  /** ADR-0174 security review (migration 0139): AuthnContextClassRef values
   * that count as multi-factor for this IdP — the SAML twin of
   * `oidc_providers.mfa_acr_values`. Read only from the VERIFIED assertion.
   * NULL = no assertion from this IdP counts as MFA; when the org requires MFA
   * the person steps up to their RegulAIt TOTP (or enrols one). */
  mfaAuthnContexts: jsonb("mfa_authn_contexts").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** the twin of oidcLoginStates: one row per SP-initiated AuthnRequest. The
 * request id is what the IdP echoes back as InResponseTo, so this row IS the
 * correlation proof that the login was solicited; relay_state and returnTo
 * live server-side, never in the browser. SINGLE-USE (claimed-and-deleted)
 * and swept by expiry. */
export const samlLoginStates = pgTable("saml_login_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => samlProviders.id, { onDelete: "cascade" }),
  /** the AuthnRequest ID — matched against the response's InResponseTo */
  requestId: text("request_id").notNull().unique(),
  relayState: text("relay_state").notNull().unique(),
  /** post-login browser destination — restricted to /app or /admin */
  returnTo: text("return_to").notNull().default("/app"),
  /** the ACS URL this request named; the assertion's Recipient must match it */
  acsUrl: text("acs_url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** REPLAY seen-set: the assertion ID of every accepted assertion, kept until
 * its validity window closes. The SAML analogue of the single-use OIDC state
 * row and the TOTP lastUsedStep guard — a captured assertion presented twice
 * inside its own NotOnOrAfter is refused the second time. Swept by expiry. */
export const samlAssertionIds = pgTable("saml_assertion_ids", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => samlProviders.id, { onDelete: "cascade" }),
  /** globally unique: an assertion ID is required to be unique by the spec,
   * and scoping the guard per-provider would let a second registered provider
   * re-play the first one's assertion. */
  assertionId: text("assertion_id").notNull().unique(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** the assertion's own NotOnOrAfter (plus the accepted skew): after this the
   * assertion is refused on its own merits and the row can be swept. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// --- ADR-0174: federated identity links (migration 0139) ---------------------
/** the upstream identity providers the bundled broker can be hinted to */
export const BROKER_IDPS = ["microsoft", "google", "github"] as const;
export type BrokerIdp = (typeof BROKER_IDPS)[number];
/** how a federated identity came to be linked to an account:
 *  - preprovisioned — the account existed with NO local credential (an admin or
 *    SCIM created it for exactly this person), so the verified email links it;
 *  - jit            — the provider's JIT provisioning created the account;
 *  - proof          — the person proved the existing local account (password,
 *    plus TOTP when enrolled) in the same browser;
 *  - admin          — an admin approved the link request (two distinct
 *    admins when the account is an admin);
 *  - prior_sso      — the account signed in through THIS provider row before
 *    migration 0139 (its pre-0139 `login-succeeded` audit row names the
 *    provider and the same verified email), so its first post-0139 sign-in
 *    through that provider records the link. */
export const FEDERATED_LINK_VIAS = ["preprovisioned", "jit", "proof", "admin", "prior_sso"] as const;
export type FederatedLinkVia = (typeof FEDERATED_LINK_VIAS)[number];

/** which (provider, subject) is linked to which user. Looked up BEFORE the
 * email match on every federated login: the IdP's stable subject is the
 * anchor once a link exists. Exactly one of the two provider columns is set. */
export const federatedIdentities = pgTable(
  "federated_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    oidcProviderId: uuid("oidc_provider_id").references(() => oidcProviders.id, { onDelete: "cascade" }),
    samlProviderId: uuid("saml_provider_id").references(() => samlProviders.id, { onDelete: "cascade" }),
    /** the OIDC `iss` claim, or the SAML IdP entity id. Matched on every login;
     * a provider whose issuer/entity id changes loses its links (audited). */
    issuer: text("issuer").notNull(),
    /** the SAML NameID Format ('' for OIDC). A transient NameID is never an
     * anchor: such an IdP is anchored on its verified email (`email-anchor`). */
    subjectFormat: text("subject_format").notNull().default(""),
    /** OIDC `sub`, or the SAML NameID */
    subject: text("subject").notNull(),
    linkedVia: text("linked_via", { enum: FEDERATED_LINK_VIAS }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("federated_identities_oidc_subject_uq")
      .on(t.oidcProviderId, t.issuer, t.subject)
      .where(sql`${t.oidcProviderId} IS NOT NULL`),
    uniqueIndex("federated_identities_saml_subject_uq")
      .on(t.samlProviderId, t.issuer, t.subjectFormat, t.subject)
      .where(sql`${t.samlProviderId} IS NOT NULL`),
    index("federated_identities_user_idx").on(t.userId),
    check("federated_identities_one_provider_ck", sql`(${t.oidcProviderId} IS NULL) <> (${t.samlProviderId} IS NULL)`),
    check(
      "federated_identities_linked_via_ck",
      sql`${t.linkedVia} IN ('preprovisioned', 'jit', 'proof', 'admin', 'prior_sso')`,
    ),
  ],
);
export type FederatedIdentityRow = typeof federatedIdentities.$inferSelect;

export const FEDERATED_LINK_REQUEST_STATUSES = ["pending", "linked", "approved", "denied"] as const;
export type FederatedLinkRequestStatus = (typeof FEDERATED_LINK_REQUEST_STATUSES)[number];

/** a federated identity that matched an existing account holding a LOCAL
 * credential (ADR-0174 §5). It never links silently: the person proves the
 * local account in the same browser (the proof token, hashed, short-lived), or
 * an admin approves. `linked` = proven by the person; `approved`/`denied` = an
 * admin's decision. */
export const federatedLinkRequests = pgTable(
  "federated_link_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    oidcProviderId: uuid("oidc_provider_id").references(() => oidcProviders.id, { onDelete: "cascade" }),
    samlProviderId: uuid("saml_provider_id").references(() => samlProviders.id, { onDelete: "cascade" }),
    /** see federatedIdentities.issuer / subjectFormat */
    issuer: text("issuer").notNull(),
    subjectFormat: text("subject_format").notNull().default(""),
    subject: text("subject").notNull(),
    /** the verified email the provider asserted */
    email: text("email").notNull(),
    /** the provider asserted MFA for the login that raised this request */
    idpMfa: boolean("idp_mfa").notNull().default(false),
    status: text("status", { enum: FEDERATED_LINK_REQUEST_STATUSES }).notNull().default("pending"),
    /** sha256 of the browser-bound proof token (cookie); NULL once spent */
    proofTokenHash: text("proof_token_hash"),
    proofExpiresAt: timestamp("proof_expires_at", { withTimezone: true }),
    /** how long an admin may still approve it */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** admin approvals so far (one suffices for a member; an admin account
     * needs two DISTINCT approvers). `userId` null = the bootstrap operator. */
    approvals: jsonb("approvals").$type<Array<{ userId: string | null; at: string }>>().notNull().default([]),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("federated_link_requests_proof_token_uq")
      .on(t.proofTokenHash)
      .where(sql`${t.proofTokenHash} IS NOT NULL`),
    index("federated_link_requests_status_idx").on(t.status),
    check(
      "federated_link_requests_one_provider_ck",
      sql`(${t.oidcProviderId} IS NULL) <> (${t.samlProviderId} IS NULL)`,
    ),
    check(
      "federated_link_requests_status_ck",
      sql`${t.status} IN ('pending', 'linked', 'approved', 'denied')`,
    ),
  ],
);
export type FederatedLinkRequestRow = typeof federatedLinkRequests.$inferSelect;

// --- ADR-0037: SCIM 2.0 provisioning (migration 0052) ------------------------
// The IdP-machine-to-gateway plumbing an enterprise provisioning engine talks
// to. Three tables and one column, and the most important thing about all of
// them is what they do NOT contain: no hard-delete path for a user. SCIM's
// `DELETE /Users/:id` and `PATCH active:false` both land on ADR-0022's
// `users.disabled_at`, so offboarding is instant, complete (sessions revoked,
// keys stop authenticating) and REVERSIBLE.

/**
 * One bearer credential per configured IdP integration — deliberately the
 * `api_keys` shape field for field: a 256-bit random token whose sha256 is the
 * only thing ever stored, minted and shown exactly once, revocable, with a
 * `lastUsedAt` that makes "is this integration actually running?" answerable
 * from the admin portal.
 *
 * This is a DISTINCT trust path from `users`: the SCIM routes authenticate on
 * this table and on nothing else — never a session cookie, never a user API
 * key — so a leaked SCIM token carries provisioning power and no user
 * identity, and rotating it touches no human account.
 */
export const scimTokens = pgTable("scim_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** operator-facing label, and the ATTRIBUTION name written into every audit
   * row this token's requests produce ("okta-prod deactivated x@y") */
  name: text("name").notNull().unique(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
});

/**
 * A group as the IdP asserts it. `externalId` is the IdP's own id and is what
 * a replayed full sync converges on; it is nullable (RFC 7643 makes it
 * optional and not every connector sends one on create) but UNIQUE among
 * non-null values, so a group that has one can exist exactly once.
 *
 * A row here grants NOTHING. It is inbound sync state. Turning membership into
 * entitlement is an admin-defined, default-deny mapping — ADR-0038 — and is
 * deliberately absent here so SCIM cannot become a privilege-escalation path.
 */
export const scimGroups = pgTable("scim_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").unique(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** group → user membership. The UNIQUE(group, user) index is what makes a
 * replayed full-org sync CONVERGE rather than duplicate — the reconciler
 * computes deltas, and the index is the backstop if two syncs race. */
export const scimGroupMembers = pgTable(
  "scim_group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scim_group_members_group_user_uq").on(t.groupId, t.userId),
    index("scim_group_members_user_idx").on(t.userId),
  ],
);

export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  url: text("url").notNull(),
  // PILLAR 5 (ADR-0019): flat list price per ALLOWED tool call on this server —
  // the MCP twin of connectors.pricePerCallUsd. Null = unpriced → cost null,
  // never invented (agents' costPerMTok null-safety). A tool call is a discrete
  // governed unit of work, so it is priced per call rather than per token.
  pricePerCallUsd: doublePrecision("price_per_call_usd"),
  /** ADR-0043 (migration 0049): may this server's URL resolve into ordinary
   * private LAN space (RFC1918 / loopback / ULA)? NULL = inherit the org
   * default (org_settings.mcpPrivateRangesDefault, true by default — the
   * self-hosted `http://mcp.internal:9000` case is the ORDINARY deployment).
   * 169.254.0.0/16 (IMDS) and the other unconditional ranges are NEVER opened
   * by this flag; a PUBLIC-internet URL still needs an egress_allow_hosts
   * entry regardless of it. */
  allowPrivateRanges: boolean("allow_private_ranges"),
  /** ADR-0097 (migration 0103) — THE ADMISSION VERDICT on this server's tool
   * manifest. ADR-0043 governs where the gateway may CONNECT; these columns
   * govern what it may ACCEPT back.
   *
   * `grandfathered` is the migration DEFAULT and the only way a row can carry
   * it: an install that upgrades keeps every server it already trusted, and
   * each is scanned on its next manifest sync. The registration path writes
   * `unscanned` EXPLICITLY rather than inheriting the default, so the review
   * queue can tell "predates the scanner" from "nobody has synced it yet".
   * `clean`/`held` are scan verdicts; `cleared` is an audited admin override
   * PINNED to `admissionManifestDigest` — a changed manifest is adjudicated
   * from scratch, so "approved once" never means "approved forever". */
  admissionState: text("admission_state", {
    enum: ["grandfathered", "unscanned", "clean", "held", "cleared"],
  })
    .notNull()
    .default("grandfathered"),
  admissionScannedAt: timestamp("admission_scanned_at", { withTimezone: true }),
  /** counts and LOCATIONS only, never the matched text — the ADR-0042 contract,
   * because this column is rendered on a review screen and a finding that
   * quoted the payload would make the review surface a delivery vector */
  admissionFindings: jsonb("admission_findings"),
  admissionSeverity: text("admission_severity", {
    enum: ["low", "medium", "high", "critical"],
  }),
  admissionScannerVersion: text("admission_scanner_version"),
  /** the drift key: the digest of the manifest the verdict was computed over */
  admissionManifestDigest: text("admission_manifest_digest"),
  admissionClearedBy: uuid("admission_cleared_by"),
  admissionClearedAt: timestamp("admission_cleared_at", { withTimezone: true }),
  admissionClearReason: text("admission_clear_reason"),
  /**
   * ADR-0126 (migration 0116) — the circuit breaker, on the server row because
   * the proxy already reads that row on every request, so the state costs no
   * extra query on the hot path of the thing built to avoid work.
   *
   * A THIRD FACT, deliberately not merged with the other two. `agents.enabled`
   * is "not in service"; ADR-0124's `halted_at` is "a human stopped this during
   * an incident"; these are "failing right now, observed by the platform".
   * Collapsing any pair would let one clear another — a recovered upstream must
   * not un-halt something an operator deliberately stopped.
   *
   * `breakerOpenedAt` null = closed. Non-null means refuse fast until the
   * cooldown elapses, after which exactly one request is elected to probe (see
   * upstream-breaker.ts). Never evidence: rewritten constantly, safe to lose,
   * and it is the TRANSITIONS that reach the audit trail.
   */
  breakerConsecutiveFailures: integer("breaker_consecutive_failures").notNull().default(0),
  breakerOpenedAt: timestamp("breaker_opened_at", { withTimezone: true }),
  breakerLastFailureAt: timestamp("breaker_last_failure_at", { withTimezone: true }),
  breakerLastError: text("breaker_last_error"),
  /**
   * AER-037 (migration 0118) — the health sweep's ROTATION CURSOR: when a pass
   * last CONSIDERED this row, not when the row last answered.
   *
   * A bounded pass without one picks the same head of a constant order forever,
   * so past the cap the tail of the estate was never actively probed at all.
   * Ordering by this ascending, nulls first, turns the cap into a fair
   * round-robin. Written at SELECTION time, which is also what makes two
   * concurrent passes pick disjoint sets instead of racing over the same head.
   */
  lastHealthProbeAt: timestamp("last_health_probe_at", { withTimezone: true }),
  /** ADR-0101 (migration 0105) — FEDERATION PROVENANCE, on the server row
   * itself, because "where did this come from" is asked while looking at the
   * server. `local` is the migration DEFAULT and the only value a pre-0105 row
   * can carry: every server that existed before federation is, and stays, the
   * operator's own decision. A federated row can never take one over — the
   * import path refuses on a name or url collision and records the conflict on
   * the catalogue row instead. */
  origin: text("origin", { enum: ["local", "federated"] })
    .notNull()
    .default("local"),
  /** ON DELETE SET NULL: removing a registry configuration must never cascade
   * into deleting servers an operator is relying on. */
  registryId: uuid("registry_id"),
  /** the upstream reverse-DNS name, verbatim — the string that can be pasted
   * back into the upstream registry */
  registryEntryName: text("registry_entry_name"),
  registryVersion: text("registry_version"),
  registryFirstSeenAt: timestamp("registry_first_seen_at", { withTimezone: true }),
  registryLastSyncedAt: timestamp("registry_last_synced_at", { withTimezone: true }),
  /** ADR-0175 A5 (migration 0140) — THE RELEASE THIS SERVER IS ON, for the
   * release-age cooldown. `releaseDigest` is the last manifest digest a sync
   * observed (null until the first sync). `releaseSeenAt` is when this
   * deployment first saw that release: registration time for a new server and
   * its first manifest, the first sighting of the exact registry entry version
   * for a federated import, and the first sighting of the exact digest for a
   * changed manifest. Our own clock, never a publisher's date. */
  releaseDigest: text("release_digest"),
  releaseSeenAt: timestamp("release_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ADR-0101 — an upstream MCP registry an operator configured. A fresh install
 * has ZERO rows here, so federation is off because there is nothing to
 * federate rather than because a flag says so, and `enabled` defaults false on
 * top of that.
 */
export const mcpRegistries = pgTable("mcp_registries", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** BASE url; the adapter appends `/v0.1/servers`. Adjudicated by ADR-0043's
   * guard at write time and on every pull. */
  url: text("url").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  /** NULL inherits org_settings.mcpPrivateRangesDefault, exactly like
   * mcp_servers.allowPrivateRanges — an internal registry mirror on the LAN is
   * an ordinary deployment. */
  allowPrivateRanges: boolean("allow_private_ranges"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncOutcome: text("last_sync_outcome", {
    enum: ["ok", "failed", "refused", "skipped"],
  }),
  lastSyncDetail: jsonb("last_sync_detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ADR-0101 — THE CATALOGUE. The only table a sync writes.
 *
 * A row here is a record of what a registry says exists. It is NOT a server: a
 * row with `serverId` null is inert by construction — no `mcp_servers` row
 * means no `/mcp/:serverId` route, no tool inventory and no grant that could
 * name it. `kind = 'catalogue_only'` rows can NEVER acquire one, because the
 * entry carries no endpoint and this codebase does not invent URLs.
 */
export const mcpRegistryEntries = pgTable(
  "mcp_registry_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registryId: uuid("registry_id")
      .notNull()
      .references(() => mcpRegistries.id, { onDelete: "cascade" }),
    upstreamName: text("upstream_name").notNull(),
    upstreamVersion: text("upstream_version").notNull(),
    title: text("title"),
    description: text("description"),
    repositoryUrl: text("repository_url"),
    websiteUrl: text("website_url"),
    kind: text("kind", { enum: ["remote", "catalogue_only"] }).notNull(),
    remoteUrl: text("remote_url"),
    remoteTransport: text("remote_transport"),
    /** why a catalogue-only entry is catalogue-only, shown verbatim to an
     * operator who asks why they cannot import it */
    catalogueReason: text("catalogue_reason"),
    upstreamStatus: text("upstream_status", { enum: ["active", "deprecated", "deleted"] }),
    upstreamPublishedAt: timestamp("upstream_published_at", { withTimezone: true }),
    upstreamUpdatedAt: timestamp("upstream_updated_at", { withTimezone: true }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "set null" }),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    importedBy: uuid("imported_by"),
    conflictReason: text("conflict_reason", { enum: ["name_taken", "url_taken"] }),
    conflictServerId: uuid("conflict_server_id").references(() => mcpServers.id, {
      onDelete: "set null",
    }),
    /** the upstream endpoint moved AFTER an import. `mcp_servers.url` is NOT
     * rewritten: a registry silently redirecting a server an operator already
     * trusts is the federation attack, not a convenience. */
    remoteUrlDrift: text("remote_url_drift"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    /** set only by a COMPLETE (untruncated) listing that no longer contained
     * this entry — "beyond the page cap" and "gone" are different facts. It
     * never deletes, disables or un-grants the local server. */
    missingSince: timestamp("missing_since", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mcp_registry_entries_registry_name_uq").on(t.registryId, t.upstreamName),
    index("mcp_registry_entries_kind_idx").on(t.registryId, t.kind),
    index("mcp_registry_entries_server_idx").on(t.serverId),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["read", "write"] }).notNull(),
    /** ADR-0124 — an EMERGENCY stop on this one subject, deliberately distinct
     * from any "not in service" flag beside it. `enabled = false` is a registry
     * decision that may be months old; a halt is an incident. Collapsing them
     * would mean lifting a halt silently returns something to service that
     * somebody had deliberately retired. NULL = not halted; the DB CHECK makes
     * "halted with no reason" unrepresentable. */
    haltedAt: timestamp("halted_at", { withTimezone: true }),
    haltedReason: text("halted_reason"),
    haltedByUserId: uuid("halted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    description: text("description"),
    /** ADR-0143: null until a manifest sync; redacted calls fail closed without it. */
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
    /** O10 (migration 0045): optional PER-TOOL price override. Resolution is
     * tool-first, server-flat-price fallback (ADR-0019 recorded the flat
     * price as "an additive column when a customer needs it" — this is it).
     * A column on the inventory row rather than a jsonb map on the server:
     * the inventory row is the identity the proxy already resolves per call,
     * so no name drift between a map key and the manifest is possible, and
     * the manifest re-sync upsert (kind/description only) provably never
     * clobbers an admin-set price. Null = no override = the server price. */
    pricePerCallUsd: doublePrecision("price_per_call_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mcp_tools_server_name_uq").on(t.serverId, t.name)],
);

export const toolGrants = pgTable(
  "tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tool_grants_user_server_tool_uq").on(t.userId, t.serverId, t.toolName),
    index("tool_grants_user_server_idx").on(t.userId, t.serverId),
  ],
);

export const serverGrants = pgTable(
  "server_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    readOnlyAll: boolean("read_only_all").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("server_grants_user_server_uq").on(t.userId, t.serverId)],
);

// No FKs on purpose: audit records must survive user/server deletion.
// One audit trail for every object type (§7): MCP tool calls fill
// serverId/toolName; agent and connector decisions fill objectId/detail.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    objectType: text("object_type", {
      enum: [
        "mcp_tool",
        "agent",
        "connector",
        "workflow",
        "run",
        "pm_work_item",
        "decision",
        "project",
        "initiative",
        "infra_operation",
        // ADR-0020: an admin change to the deployment's interception posture
        // (which compat surfaces exist, how models resolve, whether
        // attribution is mandatory). Plain text column — no DDL needed.
        "interception_settings",
        // ADR-0024 (O13): an admin create/update/delete of a per-scope
        // interception override rule. Plain text column — no DDL needed.
        "interception_scope_rule",
        // ADR-0021: an admin change to the org-wide functional defaults
        // (org_settings singleton). Plain text column — no DDL needed.
        "org_settings",
        // A4 (ADR-0027): an admin set/clear of the deploy-mode scope on a
        // pillar-1 restriction rule. Plain text column — no DDL needed.
        "restriction_rule",
        // O9 (ADR-0027): an admin narrowing/restoring a revocation's scope
        // (full <-> read_only). Plain text column — no DDL needed.
        "revocation",
        // ADR-0022 identity lifecycle: admin acts on users (deactivate/
        // reactivate/rename/admin-flag), roles (force-delete), teams
        // (member-remove/delete), workflow templates (retire) and approver
        // delegations. Plain text column — no DDL needed.
        "user",
        "role",
        "team",
        "workflow_template",
        "approval_delegation",
        // ADR-0025 secure auth: sign-in lifecycle events (login success/
        // failure/lockout, password + MFA changes, session revocations) audit
        // as objectType "user"; admin CRUD of an SSO provider audits as
        // "oidc_provider". Plain text column — no DDL needed.
        "oidc_provider",
        // ADR-0036: admin CRUD of a SAML provider, and every SAML assertion
        // refusal that is a property of the PROVIDER rather than of a user
        // (unsolicited assertion, replay, audience/recipient/issuer mismatch).
        // Plain text column — no DDL needed.
        "saml_provider",
        // ADR-0034: admin registration/update/enable/removal of a CUSTOM LLM
        // provider, every egress-allow-list change, and the per-dispatch
        // destination-host record (the point of a governance product is that
        // "which third-party endpoint did our models talk to" is answerable).
        // Plain text column — no DDL needed.
        "custom_model_provider",
        // ADR-0088: admin registration/update/test/enable/removal of a
        // registered EXTERNAL EVAL SCORER, and every egress refusal on its
        // admin-typed endpoint. Plain text column — no DDL needed.
        "external_scorer",
        // ADR-0034 amendment: a `model_credentials` / `user_model_credentials`
        // baseUrl OVERRIDE refused by the egress guard — at write time (the
        // 400) or at dispatch time (the 403 a pre-guard row now gets). Plain
        // text column — no DDL needed.
        "model_credential",
        // ADR-0034 amendment #2: the `git_connections.baseUrl` /
        // `pm_connections.baseUrl` overrides, refused at write time or at call
        // time, and the destination-host record of every guarded call that WAS
        // permitted. (`connectors.baseUrl` / `connector_credentials.baseUrl`
        // ride the pre-existing "connector" value.) Plain text column — no DDL
        // needed.
        "git_connection",
        "pm_connection",
        // ADR-0043: an `mcp_servers.url` refused by the egress guard — at
        // write time (the 400 on POST/PATCH /v1/servers) or at connect time
        // (the audited refusal a re-pointed or pre-0049 row now gets). Plain
        // text column — no DDL needed.
        "mcp_server",
        // ADR-0037: SCIM group sync. Group CRUD and every membership
        // add/remove audits here; SCIM USER provisioning keeps objectType
        // "user" so "what happened to this account" stays one query. Plain
        // text column — no DDL needed.
        "scim_group",
        // ADR-0037: an admin issuing / rotating / revoking a SCIM bearer
        // token. The token is a provisioning-power credential on its own trust
        // path, so its lifecycle is a governed act in its own right rather
        // than a footnote on some user's row. Plain text column — no DDL.
        "scim_token",
        // ADR-0038: admin CRUD of a group→role mapping, AND every group→role
        // reconciliation an identity event triggers (the asserted groups, the
        // mappings that fired, and each role_assignments insert/remove with its
        // origin). This is what makes "why does this user hold this role?"
        // resolve to either an admin action or a named group+mapping. Plain
        // text column — no DDL needed.
        "group_role_mapping",
        // ADR-0040: admin CRUD of an ABAC/Cedar policy — create, new version,
        // ACTIVATE, ROLLBACK, deactivate, delete. Activation is the act that
        // makes a policy start denying real calls, so it is a governed act in
        // its own right and lands here with the from/to version numbers. The
        // DECISIONS those policies produce audit as ordinary governed rows
        // (objectType "mcp_tool", ruleId = the policy id) — one audit trail,
        // exactly as the ADR requires. Plain text column — no DDL needed.
        "abac_policy",
        // ADR-0044: an evaluation RUN — its verdict (passed / regressed /
        // failed), the dataset version and agent snapshot it measured, which
        // judge scored it and what it cost — plus an admin pinning or clearing
        // a baseline, which changes what every later gate is compared against.
        // The eval's own DISPATCHES audit as ordinary "agent" rows through
        // executeGovernedDispatch, so the trail stays single. Plain text
        // column — no DDL needed.
        "eval_run",
        // ADR-0045: a MODEL CARD — authoring/editing a card, requesting a
        // sign-off, the decided sign-off, a revocation, an expiry sweep flip,
        // and every DISPATCH REFUSED because the model has no unexpired
        // approved card. The refusal is the one that matters: it is what makes
        // "no unreviewed model reaches production data" an audited property
        // rather than a slide. Plain text column — no DDL needed.
        "model_card",
        // ADR-0046: an admin creating or deleting an approval ROUTING RULE.
        // Authoring one changes whose queue every matching approval lands in
        // from that moment on, so it is a governed act in its own right. The
        // ROUTING and SLA events those rules produce audit on the approval's
        // OWN objectType (ruleIds `approval-routed`, `approval-sla-breached`,
        // `approval-claimed`, `approval-bulk-*`), so "what happened to this
        // approval" stays one query. Plain text column — no DDL needed.
        "approval_assignment_rule",
        // ADR-0047: an admin authoring a report DEFINITION or SCHEDULE, every
        // report GENERATION (with the effective scope it was permitted to
        // query), every EXPORT, and — the row that matters — every generation
        // REFUSED because the caller's entitlement did not cover the scope.
        // A report aggregates across teams, so "who was told no" is as much
        // the record as "what was produced". Plain text column — no DDL needed.
        "report",
        // ADR-0048: an admin creating a new immutable VERSION of a governance
        // artifact (a base system prompt, a rules-engine artifact), starting or
        // adjusting a CANARY, PROMOTING one to active — with or without the
        // ADR-0044 eval gate, the override being audited with its reason — and
        // ROLLING BACK. Activation is the act that changes what every
        // subsequent dispatch is governed by, so it is a governed act in its
        // own right. The DISPATCHES those versions serve stamp the version onto
        // `usage_events` rather than emitting a second audit row, so the trail
        // stays single. Plain text column — no DDL needed.
        "config_version",
        // ADR-0074: an admin editing a COMPLIANCE PROFILE through the ordinary
        // CRUD surface (`POST /v1/compliance/profiles`, or the onboarding pack
        // re-applied). Its own type rather than `config_version`, because the
        // row records the ADMIN'S GESTURE and whether it minted a version — the
        // `config_version` rows are what `activateVersion` writes underneath it.
        // Plain text column — no DDL needed.
        "compliance_profile",
        // ADR-0051: an admin authoring an immutable RATE CARD version, opening
        // or CLOSING a billing period, every statement CUT (with the effective
        // scope it was permitted to total), the one-way ISSUE, every EXPORT,
        // every RE-DERIVATION and its drift, and — the rows that matter — every
        // cut REFUSED because the caller's entitlement did not cover the scope
        // and every issue REFUSED because the version covered only part of it.
        // An invoice is the shape in which one team's spend leaks and the shape
        // in which history gets quietly restated, so both refusals are records.
        // Plain text column — no DDL needed.
        "rate_card",
        "billing_period",
        "billing_statement",
        // ADR-0052: an admin INSTALLING a signed license, every operator-driven
        // re-verification, the escalating grace/expiry warnings, and — the rows
        // that matter most — every REFUSED artifact (tampered, signed by an
        // unpinned key, malformed) and every act refused because the license
        // lapsed or the seat cap was reached. A refused forgery is exactly the
        // row an operator needs, and it exists even though the artifact never
        // became a license. Plain text column — no DDL needed.
        "license",
        // ADR-0054: the first-run wizard's checklist transitions, and every
        // IMPORT — planned, applied, and (the rows that matter) REFUSED. An
        // import is bulk state-mutation power handed to a file someone else
        // wrote, so "an import tried to mint an admin and was refused" has to
        // be a row an operator can find, not an error message that scrolled
        // past. Plain text column — no DDL needed.
        "onboarding_step",
        "onboarding_import",
        // ADR-0060 (migration 0067): the GENESIS row of the tamper-evident hash
        // chain, and nothing else. It is an audit_log row rather than a row in
        // some side table on purpose: the boundary between "un-chained legacy"
        // and "covered by the chain" belongs IN the trail an auditor reads, in
        // words, at the exact position where the guarantee starts. Plain text
        // column — no DDL needed.
        "audit_chain",
        // ADR-0055: shadow-AI discovery. An admin editing the detection
        // CATALOGUE (which providers are detectable at all), an evidence
        // IMPORT — including the refused ones, which are the rows that matter —
        // and every disposition/remediation-link on a FINDING. The discovery
        // engine is governed by the kernel it feeds (ADR-0055 §5): there is no
        // privileged scan identity that reads without an audit row. Plain text
        // column — no DDL needed.
        "ai_endpoint_signature",
        "shadow_ai_import",
        "shadow_ai_finding",
        // ADR-0069: cross-vendor cost consolidation. Every IMPORT of a vendor
        // export — including the refused ones (too large, duplicate bytes,
        // unmappable file, ingest-scan blocked), which are again the rows that
        // matter — every REVOCATION of an applied batch, and every change to
        // the identity-resolution rules. An admin asserting "this vendor
        // account is this person" is a chargeback decision somebody may have to
        // defend months later, so the assertion, its stated reason and the
        // number of stored lines it re-attributed all land here. Plain text
        // column — no DDL needed.
        "cost_import_batch",
        "vendor_account_alias",
        "vendor_domain_rule",
        // ADR-0076: a reconciliation pass over the imported cost lines. Every
        // supersession GROUP audits here with the line ids it marked and the
        // batch it kept, plus one summary row per pass — because excluding a
        // number from a chargeback view, even a duplicate one, is a governed
        // act somebody may have to defend. Plain text column — no DDL needed.
        "cost_reconciliation_run",
        // ADR-0061: ChatOps approvals. Admin CRUD of a chat WORKSPACE and of a
        // chat→RegulAIt IDENTITY LINK (the trust artifact that decides which
        // human a Slack click binds to), the outbound mirror of an approval,
        // and — the rows that matter — every inbound callback REFUSED because
        // the chat identity mapped to nobody, to a non-approver, or to an
        // approval whose sensitivity makes it in-app only. The DECISION itself
        // audits as an ordinary approval row through the one decide path, so
        // the trail stays single. Plain text column — no DDL needed.
        "chatops_connection",
        "chat_identity_link",
        // ADR-0058: authoring/seeding a compliance PACK, ACTIVATING a version
        // (and the retirement of the one it supersedes), recording an
        // ATTESTATION on an organisational control, every pack EVALUATION with
        // the effective scope it was permitted to query — and the two rows that
        // matter: every evaluation REFUSED because the caller's entitlement did
        // not cover the scope, and every attestation REFUSED because the
        // control is auto-evidenced and a human statement must not stand in for
        // ledger evidence. Plain text column — no DDL needed.
        "compliance_pack",
        // ADR-0056: the governance COPILOT. Every question asked of it, with
        // the exact entitlement scope its retrieval was narrowed to; every
        // narration dispatch; every proposal it opened in the Approvals Queue;
        // and the refusals — a narrator agent the invoking user may not call,
        // and a guardrail hit on evidence read out of the audit log itself.
        // The copilot is a governed tenant, so its trail is this trail.
        "copilot_query",
        "copilot_proposal",
        // ADR-0063: REGULAIT_DATA_KEY custody. The first-boot RECORD of this
        // deployment's key fingerprint, every boot that VERIFIED it, an
        // operator-declared ROTATION, every custody ATTESTATION — and the row
        // that matters most: the boot REFUSED because the recorded fingerprint
        // and the running key disagree, i.e. a restore onto a box that does not
        // hold the key its ciphertext was written under. That refusal is
        // written before the gateway declines to listen, so the reason a
        // deployment would not come up is IN the trail rather than only in a
        // console someone had to be watching. Plain text column — no DDL.
        "data_key",
        // ADR-0064: every pass of every scheduled sweep — start, outcome, and
        // the count of what it touched — plus an admin enabling/disabling a job
        // or changing its cadence. The row that matters is the FAILURE: a sweep
        // that has not run for a month, on a product whose pitch is that
        // nothing happens unobserved, must be findable in the same trail as
        // everything else rather than in a separate health endpoint. The
        // EFFECTS a sweep produces (an expired model card, a breached SLA, a
        // generated report) keep auditing on their own objectType, so "what
        // happened to this approval" stays one query. Plain text — no DDL.
        "scheduler_job",
        // ADR-0065 (RegulAIt-LLM): the three objects of the custom-model
        // lifecycle. `training_dataset` carries the INGEST SCAN verdict — the
        // row that matters, because a corpus refused for containing PII is the
        // governance win this feature exists for, and nobody else catches it at
        // ingest. `training_job` carries creation, the approval routing of an
        // over-threshold run, start/success/failure, and — distinctly — every
        // HONEST REFUSAL by a credential-less real backend, so "we never tried"
        // is never mistakable for "we tried and it worked". `training_artifact`
        // carries registration for inference, which is the moment a thing
        // somebody trained becomes a thing the platform will dispatch to.
        // Plain text column — no DDL needed.
        "training_dataset",
        "training_job",
        "training_artifact",
        // ADR-0066 (gateway parity): a virtual key's whole lifecycle — issued,
        // updated, revoked — plus every dispatch it was REFUSED, by its own
        // allow-list or its own budget. Kept as its own object type rather than
        // filed under `agent` because "what did this key do, and what was it
        // stopped from doing" is the question an operator asks when handing a
        // credential to a contractor, and it should be one query.
        // Plain text column — no DDL needed.
        "virtual_key",
        // ADR-0098 (API-key expiry): the credential's own lifecycle events —
        // an issuance REFUSED for exceeding the org's lifetime ceiling, and
        // every presentation of a key that is expired or revoked. Its own
        // object type rather than filed under `user` because "why did this
        // key stop working" is exactly the question an operator asks, and the
        // discriminating `ruleId` (api-key-refused-expired vs
        // api-key-refused-revoked) should be one query away.
        // Plain text column — no DDL needed.
        "api_key",
        // ADR-0070 (trace observability): the READ surface, not the recorder.
        // Recording a span emits no audit row — it would double the trail for
        // every governed call and say nothing the existing row does not. What
        // IS audited here is who READ whose trace and was refused, plus every
        // OTLP export (and every export the egress guard, a missing endpoint,
        // or the collector itself refused). A trace carries another person's
        // prompts and tool arguments, so a cross-user read attempt is exactly
        // the kind of event that belongs in the trail.
        // Plain text column — no DDL needed.
        "trace",
        // ADR-0080: the AI use-case registry. A PROPOSAL (the front-door act),
        // every LIFECYCLE FLIP driven by the linked intake instance's decision
        // (approved/rejected — the rows that make "approval registers the use
        // case" a recorded property), every refused DIRECT status write, and
        // an admin RETIREMENT with its reason. The intake instance's own
        // events keep auditing as objectType "workflow", so "what happened to
        // this change" stays one query. Plain text column — no DDL needed.
        "ai_use_case",
        // ADR-0081: the AI risk register. Registration, every audited status
        // transition, and above all the RESIDUAL-RISK ACCEPTANCE — who
        // accepted a named risk, when, why, and what the evidence resolvers
        // measured at that moment (the counts ride in `detail`, so the
        // acceptance row is readable even after the ledgers move on). The
        // evidence itself is never stored — it is computed at read time from
        // the real ledgers (ADR-0058 discipline). Plain text column — no DDL
        // needed.
        "ai_risk",
        // ADR-0084: the AI vendor registry (third-party AI risk). A PROPOSAL
        // (the front-door act), every LIFECYCLE FLIP driven by the linked
        // assessment instance's decision (approved/rejected — the ADR-0080
        // discipline), every VENDOR ATTESTATION recorded against a pack
        // control (who recorded the vendor's claim, when, from which
        // questionnaire version — a claim, never platform evidence), every
        // refused DIRECT status write, and an admin RETIREMENT with its
        // reason. Plain text column — no DDL needed.
        "ai_vendor",
        // ADR-0090: a grant certification campaign (gap L22). Opening a
        // campaign (with its scope and item count), every keep attestation,
        // every EXECUTED revocation (with the mechanism and the campaign as
        // context), and the completion flip — so "what did this campaign
        // decide" stays one query. Plain text column — no DDL needed.
        "certification_campaign",
        // ADR-0090: the generic decide-path audit rows (self-review, admin
        // override, delegation, workbench routing/SLA) write the approval's
        // own objectType — for a certification item's approval that is
        // 'grant_certification'. Plain text column — no DDL needed.
        "grant_certification",
        // ADR-0091: toxic-combination SoD (gap L23). Admin CRUD of an SoD
        // rule (create with its reason, enable/disable, delete), every mint
        // REFUSED by one (`sod-conflict-refused`, naming the rule and the
        // conflicting holding), every escalation of a refusal into the one
        // approvals queue, and the overridden mint an approval executes
        // (with `sodOverride: {ruleId, approvalId}` in the detail). Plain
        // text column — no DDL needed.
        "sod_rule",
        // ADR-0091: the generic decide-path audit rows for an escalated SoD
        // override ride the approval's own objectType. Plain text column —
        // no DDL needed.
        "sod_override",
        // ADR-0116: a SIGNED, offline-verifiable export bundle was produced.
        // Its own object type rather than filed under the thing exported,
        // because "what left this deployment as evidence, when, and who took
        // it" is the question an auditor asks about the EXPORTS themselves —
        // and because the row is written BEFORE the bundle is built, so the
        // bundle's manifest commits to a chain head that already contains the
        // record of its own creation. Plain text column — no DDL needed.
        "audit_export",
        // ADR-0157: a governance-monitor alert raised / resolved /
        // acknowledged, and the monitor pass itself (objectId null). Plain
        // text column — no DDL needed.
        "governance_alert",
        "governance_monitor",
        // ADR-0159: a remediation proposed / applied / denied / failed
        "remediation",
        // ADR-0161: one CI/CD deploy-gate evaluation (objectId = use case)
        "deploy_gate",
        // ADR-0173 §3: an admin replacing the model allow-list matrix
        // (objectId null — the policy is org-wide). Plain text column — no DDL.
        "model_policy",
        // ADR-0173 batch 2b: a prompt created / committed / tagged / promoted
        // (objectId = the prompt), and an outbound webhook subscription changed,
        // tested or a delivery given up (objectId = the subscription). Plain
        // text column — no DDL.
        "prompt",
        // an approval of kind prompt_promotion audits under its own kind
        // (the decide path writes override/self-review/delegation rows so)
        "prompt_promotion",
        "webhook_subscription",
        // ADR-0172: a builder agent created / changed / shared / run on a
        // schedule / refused at its spend limit, and a builder skill change
        // (objectId = the builder agent or skill). Plain text column — no DDL.
        "builder_agent",
        "builder_skill",
        // ADR-0175 A15: an energy factor created / changed / removed
        // (objectId = the factor row). Plain text column — no DDL.
        "energy_factor",
      ],
    })
      .notNull()
      .default("mcp_tool"),
    objectId: uuid("object_id"),
    detail: jsonb("detail"),
    serverId: uuid("server_id"),
    toolName: text("tool_name"),
    effect: text("effect", { enum: ["allow", "deny", "require_approval"] }).notNull(),
    ruleId: text("rule_id").notNull(),
    ruleChain: jsonb("rule_chain").notNull(),
    reason: text("reason").notNull(),
    // A4 (migration 0044): the deploy mode of the target a deploy-mode-scoped
    // action acted on (workflow deploy/rollback events, infra operations on
    // target-pinned resources). NULL = unknown/not-applicable — pre-0044 rows
    // are honestly un-backfillable (they never recorded a mode, ADR-0019),
    // and most rows (MCP calls, membership changes, …) have no mode at all.
    deployMode: text("deploy_mode", { enum: ["hosted", "byoc", "air_gapped"] }),
    // --- ADR-0060 (migration 0067): the tamper-evident hash chain ------------
    // All four are NULL together (a DB CHECK enforces all-or-none) on every row
    // written BEFORE the chain existed. Those rows are un-chained legacy: the
    // integrity guarantee does not cover them, and chaining them retroactively
    // would mean rewriting them, which is indistinguishable from tampering.
    // See migration 0067's header and `@regulait/shared`'s `audit-chain.ts`.
    //
    // FK-FREENESS IS PRESERVED: none of these reference anything. A row stays
    // verifiable from its own bytes plus its predecessor's `rowHash` long after
    // every user, server and project it names has been deleted.
    /** strict total chain order. NOT `at` — timestamps collide and are not
     * monotonic. Assigned as max(seq)+1 under an advisory lock, so a rolled-back
     * transaction never burns a number and leaves a gap that would have to be
     * reported as a possible deletion. */
    seq: bigint("seq", { mode: "number" }),
    /** SHA-256 over the canonical serialization of this row's immutable facts.
     * Changes iff the RECORD was edited. */
    contentHash: text("content_hash"),
    /** the PRECEDING row's `rowHash` — see `auditRowHash()` for why it is not
     * the predecessor's `contentHash`. 64 zeros at genesis. */
    prevHash: text("prev_hash"),
    /** `SHA-256(prevHash || contentHash)` — the linked value, and the thing the
     * WORM anchor pins. Stored so the next append can link without recomputing,
     * and so editing it directly is itself detectable. */
    rowHash: text("row_hash"),
  },
  (t) => [
    index("audit_log_user_at_idx").on(t.userId, t.at),
    uniqueIndex("audit_log_seq_uq").on(t.seq),
  ],
);

/**
 * ADR-0060 §4 — the local ledger of chain-head ANCHORS.
 *
 * A hash chain detects any edit by someone who cannot recompute the whole
 * chain. It does NOT catch a DB admin who rewrites every row AND every hash:
 * that forgery is internally consistent, and local verification blesses it.
 * What closes the gap is pinning the chain HEAD somewhere that admin cannot
 * rewrite — S3 Object Lock in compliance mode, and/or an independent external
 * transparency log. A full recompute then diverges from the anchored head.
 *
 * This table is NOT the trust root. A row here is exactly as rewritable as any
 * other row; `status`/`externalRef` are what say whether an externalized,
 * genuinely immutable copy exists. In an air-gapped install anchors sit here as
 * `pending` until connectivity resumes (§8.5's buffer-and-sync posture), and the
 * verify response discloses the larger undetectable window rather than hiding
 * it.
 *
 * FK-free, like `audit_log` itself and for the same reason.
 */
export const auditAnchors = pgTable(
  "audit_anchors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** the chain head that was anchored */
    seq: bigint("seq", { mode: "number" }).notNull(),
    rowHash: text("row_hash").notNull(),
    /** `at` of the row at `seq`, so "the trail was intact as of…" needs no
     * second lookup into a table that may have been tampered with since */
    headAt: timestamp("head_at", { withTimezone: true }).notNull(),
    algorithm: text("algorithm").notNull().default("sha256"),
    /** `none` = no sink configured, so this anchor exists ONLY here and is NOT
     * tamper-resistant. Recorded honestly rather than implying coverage. */
    destination: text("destination", {
      enum: ["local_worm", "s3_object_lock", "external_log", "none"],
    }).notNull(),
    status: text("status", { enum: ["pending", "flushed", "failed"] }).notNull().default("pending"),
    externalRef: text("external_ref"),
    flushedAt: timestamp("flushed_at", { withTimezone: true }),
    lastError: text("last_error"),
    deployMode: text("deploy_mode", { enum: ["hosted", "byoc", "air_gapped"] }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_anchors_seq_idx").on(t.seq), index("audit_anchors_status_idx").on(t.status, t.seq)],
);

// §3 approval requirement rules: a granted call matching a rule pauses for
// the named approver. toolName null = any tool on the server.
//
// PILLAR 1 rule scoping: userId/serverId are nullable now — a rule is bound to
// exactly ONE subject dimension chosen by `scope` (user | role | team | fleet)
// and ONE server dimension chosen by `serverScope` (server | all). The DB
// CHECK constraints (migration 0026) enforce the discriminant. Existing rows
// carry scope='user', serverScope='server' and behave identically. The rule
// stays a pure RESTRICTION evaluated after the grant check.
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    // A4 (migration 0044): optional deploy-mode scope — null (every pre-0044
    // row, and the default) = mode-unscoped = today's behaviour.
    deployMode: text("deploy_mode", { enum: ["hosted", "byoc", "air_gapped"] }),
    toolName: text("tool_name"),
    writeOnly: boolean("write_only").notNull().default(false),
    // ADR-0104 (migration 0106): what this rule's consent is BOUND TO.
    // 'action' (the default, and every pre-0106 row) binds an approval to the
    // exact arguments it was granted for — the approver signs a payload, not a
    // tool name. 'tool' is the deliberate escape hatch: the approval is
    // reusable across differing arguments, for a call whose arguments do not
    // change what it means to approve it. Strictest-wins across matching rules.
    approvalScope: text("approval_scope", { enum: ["action", "tool"] })
      .notNull()
      .default("action"),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approval_rules_user_server_idx").on(t.userId, t.serverId),
    index("approval_rules_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("approval_rules_role_idx").on(t.roleId),
    index("approval_rules_team_idx").on(t.teamId),
  ],
);

// §3 rate/volume limits. toolName null = server-wide cap. Usage is counted
// from audit_log allow rows at evaluation time, not stored here.
// PILLAR 1 rule scoping: same scope/serverScope discriminant as approval_rules
// (see there). A role/team/fleet limit's window is still counted PER USER —
// each subject the widened rule matches keeps its own independent count.
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    // A4 (migration 0044): optional deploy-mode scope — null = today.
    deployMode: text("deploy_mode", { enum: ["hosted", "byoc", "air_gapped"] }),
    toolName: text("tool_name"),
    maxCalls: integer("max_calls").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_limits_user_server_idx").on(t.userId, t.serverId),
    index("rate_limits_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("rate_limits_role_idx").on(t.roleId),
    index("rate_limits_team_idx").on(t.teamId),
  ],
);

// §6 Approvals Queue: one pending entry per paused call. Approved entries are
// consumed by exactly one retried call. The audit log remains the permanent
// record; queue rows may cascade away with their user/server.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    objectType: text("object_type", {
      // ADR-0045: 'model_card' — an MRM sign-off / recertification request.
      // The column has no DB CHECK (see migration 0001), so this is a TS-only
      // widening with no DDL, exactly like the values ADR-0011/0016/0017 added.
      // The whole point is that MRM does NOT get a second queue.
      // ADR-0056: 'copilot_proposal' — a policy-tightening / grant-revocation
      // diff the governance copilot PROPOSED. Same reasoning as 'model_card'
      // above: the copilot does NOT get a second inbox, and its only route to a
      // change is an ordinary row in this one queue, applied by a named human
      // under their own identity.
      // ADR-0065: 'training_job' — an over-threshold RegulAIt-LLM training run
      // waiting on a named human. Same reasoning as 'model_card' above: model
      // training does NOT get a second inbox, and the only route from
      // `pending_approval` to `queued` is an ordinary row in this one queue
      // decided through the one decide path, with its separation-of-duties
      // guards, delegation window and admin override intact.
      // ADR-0090: 'grant_certification' — one certification-campaign item's
      // keep/revoke decision. Same reasoning as 'model_card' above: a
      // certification campaign does NOT get a second inbox or a second decide
      // path — approved = keep (attested), denied = revoke (executed against
      // the real grant row inside the decision's own transaction).
      // ADR-0091: 'sod_override' — a mint refused by a toxic-combination SoD
      // rule, escalated. Same reasoning as 'model_card' above: the override
      // does NOT get a second inbox — an arm's-length approver approving the
      // one queue row mints the refused grant inside the decision's own
      // transaction with the overridden rule recorded; denied mints nothing.
      // B9b: the list itself now lives in `@regulait/shared`
      // (`APPROVAL_OBJECT_TYPES`), because the queue's own `objectType` filter
      // needs the same ten strings and two hand-maintained copies of "what can
      // be in the one queue" would drift the moment a kind is added — the
      // column has no DB CHECK, so nothing else would catch it.
      enum: APPROVAL_OBJECT_TYPES,
    })
      .notNull()
      .default("mcp_tool"),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    ruleId: uuid("rule_id"),
    instanceId: uuid("instance_id"),
    /** orchestration-run escalations (§3): the run this approval gates; stageId carries the node id */
    runId: uuid("run_id"),
    /** pillar 5 project-budget escalations */
    projectId: uuid("project_id"),
    stageId: text("stage_id"),
    approverUserId: uuid("approver_user_id").notNull(),
    status: text("status", {
      // ADR-0168: 'returned' — an intake sign-off sent back for information.
      // No DB CHECK on this column (migration 0001), so a TS-only widening.
      enum: ["pending", "approved", "denied", "returned", "consumed", "superseded"],
    })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    // ADR-0104 (migration 0106) — PAYLOAD BINDING. Both NULLABLE, because rows
    // queued before 0106 legitimately have neither and inventing one would be
    // manufacturing a consent nobody gave.
    /** consent fingerprint: sha256 hex over the canonical `{projectId,
     * arguments}` of the call this row was queued for, computed on the RAW
     * arguments (pre-scrub) so redaction cannot move consent identity. NULL =
     * a legacy row, which satisfies a `tool`-scoped rule only. */
    argumentsDigest: text("arguments_digest"),
    /** the SCRUBBED (ADR-0099) rendering of those same arguments — what the
     * approver actually reads. Never the input to the digest. */
    argumentsPreview: jsonb("arguments_preview"),
    /** ADR-0144: issuance facts, never inferred from caller-controlled preview keys. */
    argumentsPreviewKind: text("arguments_preview_kind", { enum: ["arguments_v1", "mcp_redacted_v1"] }),
    approvalScope: text("approval_scope", { enum: ["action", "tool"] }),
    // ADR-0105 (migration 0107) — CONSENT CONTEXT + EXPIRY. Both NULLABLE for
    // the same reason ADR-0104's pair is: a row queued before 0107 has
    // neither, and inventing either would be manufacturing a fact nobody
    // recorded.
    /** the POLICY fingerprint this consent was granted under: sha256 hex over
     * the matched approval rules paired with their ACTIVE `config_versions`
     * ids (ADR-0073), the required approver, the approval scope and — since
     * v3 (ADR-0166) — the MCP target. Re-derived at evaluation and compared at
     * consumption, which also re-checks the consent policy epoch (migration
     * 0119) under the same row lock, so a policy activation cannot be raced
     * (AER-004). NULL = a legacy row that predates the feature; it is NOT
     * spendable — the consume predicate requires a matching digest, so a
     * legacy row is retired and re-queued for a fresh, context-bound review. */
    contextDigest: text("context_digest"),
    /** when this consent stops being spendable, stamped at QUEUE time from
     * `org_settings.approval_ttl_hours`. NULL = never expires: either a legacy
     * row queued before 0107, or an org that has deliberately set the dial to
     * NULL. Never rewritten by a later dial change. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // ADR-0168 amendment (migration 0131) — A REVIEW ROUND. An intake sign-off
    // routed by the review policy is one row per required reviewer role: any
    // member of the role may decide it (never the proposer). The name is a
    // snapshot (a renamed or removed role still reads true on old rounds) and
    // the round numbers the use case's review rounds. All three NULL on every
    // other approval, including the single-named-approver intake path.
    reviewRoleId: text("review_role_id"),
    reviewRoleName: text("review_role_name"),
    reviewRound: integer("review_round"),
  },
  (t) => [
    index("approvals_status_idx").on(t.status),
    check(
      "approvals_review_role_check",
      sql`(${t.reviewRoleId} IS NULL) = (${t.reviewRoleName} IS NULL) AND (${t.reviewRoleId} IS NULL) = (${t.reviewRound} IS NULL)`,
    ),
    check("approvals_preview_kind_check", sql`${t.argumentsPreviewKind} IN ('arguments_v1', 'mcp_redacted_v1')`),
    check("approvals_scope_check", sql`${t.approvalScope} IN ('action', 'tool')`),
    check("approvals_redacted_scope_check", sql`${t.argumentsPreviewKind} IS DISTINCT FROM 'mcp_redacted_v1' OR ${t.approvalScope} IS NOT DISTINCT FROM 'action'`),
    index("approvals_user_server_tool_idx").on(t.userId, t.serverId, t.toolName),
    // the shape of ADR-0104's matcher lookup
    index("approvals_payload_binding_idx").on(
      t.userId,
      t.serverId,
      t.toolName,
      t.status,
      t.argumentsDigest,
    ),
  ],
);

// §3 data-scope rules: allow-list the values a call-argument field may take
// for a granted tool. argPath is a dot-path into the call arguments;
// allowedValues is a jsonb string array. Missing/non-scalar values fail closed.
// PILLAR 1 rule scoping: same scope/serverScope discriminant as approval_rules
// (see there). Every matching scoped rule must still be satisfied — a widened
// rule set composes to the INTERSECTION of allow-lists, never a relaxation.
export const dataScopeRules = pgTable(
  "data_scope_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["user", "role", "team", "fleet"] })
      .notNull()
      .default("user"),
    serverScope: text("server_scope", { enum: ["server", "all"] }).notNull().default("server"),
    // A4 (migration 0044): optional deploy-mode scope — null = today.
    deployMode: text("deploy_mode", { enum: ["hosted", "byoc", "air_gapped"] }),
    toolName: text("tool_name"),
    argPath: text("arg_path").notNull(),
    allowedValues: jsonb("allowed_values").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("data_scope_rules_user_server_idx").on(t.userId, t.serverId),
    index("data_scope_rules_scope_idx").on(t.scope, t.serverScope, t.serverId),
    index("data_scope_rules_role_idx").on(t.roleId),
    index("data_scope_rules_team_idx").on(t.teamId),
  ],
);

// Per-user API keys. Only the sha256 hash of the token is stored; the
// plaintext (rgl_<hex>) is shown exactly once at creation.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** ADR-0098 (migration 0104) — THE LIFETIME THIS TABLE NEVER HAD.
     * NULL = never expires, which is what every pre-0104 row is and what a
     * newly issued key still is under the shipped org defaults. A non-null
     * value is enforced in `authenticate()` (the one place a bearer token
     * becomes an identity), where an expired key is refused with its OWN
     * reason so it is never confused with a revoked one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("api_keys_user_idx").on(t.userId),
    /** the lifecycle read (`GET /v1/keys`, and any future expiry sweep) sorts
     * and filters on this; a partial index keeps the never-expiring majority
     * out of it entirely. */
    index("api_keys_expires_at_idx").on(t.expiresAt),
  ],
);

// §5 roles: named bundles of default entitlements. Assigning a role sets a
// user's baseline; per-user overrides layer on top (direct grants add,
// revocations subtract role-derived entitlements only).
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleToolGrants = pgTable(
  "role_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_tool_grants_role_server_tool_uq").on(t.roleId, t.serverId, t.toolName)],
);

export const roleServerGrants = pgTable(
  "role_server_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    readOnlyAll: boolean("read_only_all").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_server_grants_role_server_uq").on(t.roleId, t.serverId)],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    /** ADR-0038 (migration 0053) — WHY this user holds this role.
     *
     * `direct`  an admin assigned it. NEVER touched by an IdP reconciliation.
     * `group`   a currently-mapped, currently-asserted IdP group implies it.
     *           Owned end-to-end by the group reconciler and removed by it the
     *           moment the group or the mapping goes away.
     *
     * DEFAULT 'direct' backfills every pre-0053 row as admin-direct, which is
     * exactly what they are — no group mapping existed to have created them. */
    origin: text("origin", { enum: ["direct", "group"] }).notNull().default("direct"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ADR-0038: the unique key INCLUDES origin so a role held BOTH ways lives
    // in two rows. That is what makes "a sync can never remove an admin's
    // direct grant" structural rather than merely careful: the reconciler's
    // DELETE is scoped to origin='group', and a direct assignment is a
    // different ROW, not a different column value on the same row.
    uniqueIndex("role_assignments_user_role_origin_uq").on(t.userId, t.roleId, t.origin),
    index("role_assignments_user_origin_idx").on(t.userId, t.origin),
  ],
);

// --- ADR-0038: IdP group → RegulAIt role mapping (migration 0053) ------------
// The bridge from "an external directory asserts membership" to "this user
// holds this role". Default-deny (an unmapped group confers nothing), additive
// (it enters at the role_assignments layer the kernel already reads, so it can
// never mint an entitlement a role does not carry), and subordinate to the
// per-user layer (ADR-0019 revocations still beat a group-implied role).

/** the identity paths that can assert a group. `scim` is a synced group's
 * external id (or its displayName when the connector sent no externalId);
 * `saml`/`oidc` are the raw attribute/claim values from the assertion. */
export const GROUP_SOURCES = ["saml", "oidc", "scim"] as const;
export type GroupSource = (typeof GROUP_SOURCES)[number];

/**
 * The admin-curated many-to-many. A group with NO row here grants NOTHING —
 * there is deliberately no "default role for unmapped groups" column, because
 * that would be a default-allow backdoor into pillar 1.
 *
 * The only thing a mapping can point at is a `roles` row. There is no column
 * here that reaches `users.isAdmin`, and there never will be: `isAdmin` is not
 * a role and is not group-derivable.
 *
 * `source` is part of the unique key because "Engineering" asserted by SAML and
 * "Engineering" synced by SCIM are two assertions from two different trust
 * paths — an admin opts into each separately.
 */
export const groupRoleMappings = pgTable(
  "group_role_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", { enum: GROUP_SOURCES }).notNull(),
    /** the group identifier exactly as the IdP asserts it */
    externalGroup: text("external_group").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("group_role_mappings_source_group_role_uq").on(t.source, t.externalGroup, t.roleId),
    index("group_role_mappings_source_group_idx").on(t.source, t.externalGroup),
  ],
);

/**
 * Sighting log for the "unmapped asserted groups" report (ADR-0038 honest-risk
 * #3: group-name drift in the IdP silently breaks a mapping — the group becomes
 * unmapped, which is the SAFE direction, but access disappears and nobody knows
 * why). One row per (source, externalGroup) ever seen in a sync or a login.
 *
 * Records sightings ONLY. A row here grants nothing and implies nothing; it
 * exists so an admin can see "your IdP keeps asserting 'Engineering-EMEA' and
 * nothing is mapped to it".
 */
export const assertedGroups = pgTable(
  "asserted_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", { enum: GROUP_SOURCES }).notNull(),
    externalGroup: text("external_group").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    seenCount: integer("seen_count").notNull().default(1),
  },
  (t) => [uniqueIndex("asserted_groups_source_group_uq").on(t.source, t.externalGroup)],
);

// §5 subtractive per-user override: suppresses role-derived entitlements
// only (direct grants always survive). toolName null = all role-derived
// access on the server. Deleting the row reverses the override.
export const revocations = pgTable(
  "revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name"),
    /** O9 (migration 0045): 'full' (default = today) suppresses the matched
     * role-derived entitlement entirely; 'read_only' suppresses only
     * WRITE-classified tools — reads stay allowed. A full revocation still
     * beats everything (precedence otherwise unchanged). */
    scope: text("scope", { enum: ["full", "read_only"] }).notNull().default("full"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("revocations_user_server_idx").on(t.userId, t.serverId),
    // NULLS NOT DISTINCT in the migration: one revocation per (user, server, tool/null)
    uniqueIndex("revocations_user_server_tool_uq").on(t.userId, t.serverId, t.toolName),
  ],
);

// §4 global agent/model registry: platform-wide catalog, decoupled from
// per-user entitlement. tier ranks capability/cost (basis of the ceiling).
/** ADR-0089 (migration 0091) — the agent lifecycle vocabulary, closed:
 *  - `active`      the ordinary state; nothing changes on its account.
 *  - `deprecated`  a governance WARNING (inventory/posture flag it); dispatch
 *                  is deliberately NOT blocked — deprecation is a migration
 *                  signal, not a control.
 *  - `retired`     TERMINAL for governance purposes: the dispatch core
 *                  refuses with a named 409 (`agent_retired`, the ADR-0045
 *                  gate idiom). Grants and history stay readable — rows are
 *                  never deleted; re-registering is a NEW agent. */
/*
 * ADR-0168 amendment item 6 (migration 0132) widens the vocabulary for agent
 * stewardship: `proposed` (registered, not yet in service), `under_review`
 * (a steward is reviewing it) and `suspended` (temporarily OUT OF SERVICE —
 * dispatch refuses with a named 409 `agent_suspended`, exactly like retired
 * but reversible). proposed / under_review warn only, like deprecated. */
export const AGENT_LIFECYCLE_STATUSES = [
  "proposed",
  "active",
  "under_review",
  "suspended",
  "deprecated",
  "retired",
] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(),
  tier: integer("tier").notNull(),
  modes: jsonb("modes").$type<string[]>(),
  enabled: boolean("enabled").notNull().default(true),
  /** ADR-0124 — an EMERGENCY stop on this one subject, deliberately distinct
   * from any "not in service" flag beside it. `enabled = false` is a registry
   * decision that may be months old; a halt is an incident. Collapsing them
   * would mean lifting a halt silently returns something to service that
   * somebody had deliberately retired. NULL = not halted; the DB CHECK makes
   * "halted with no reason" unrepresentable. */
  haltedAt: timestamp("halted_at", { withTimezone: true }),
  haltedReason: text("halted_reason"),
  haltedByUserId: uuid("halted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // ADR-0089 (migration 0091): the accountable HUMAN for this agent — a
  // governance record, not authentication. NULLABLE ON PURPOSE: existing
  // agents have no owner and inventing one would forge an accountability
  // record; NULL renders in the ADR-0082 inventory as an explicit "unowned"
  // flag, never a default. An owner whose user row is deactivated
  // (users.disabled_at — the state SCIM deprovisioning writes) makes the
  // agent "orphaned", computed at read time. FK ON DELETE SET NULL in SQL.
  ownerUserId: uuid("owner_user_id"),
  // ADR-0089: see AGENT_LIFECYCLE_STATUSES above. DB CHECK pins the
  // vocabulary; a second CHECK pins (status='active') = (reason IS NULL).
  lifecycleStatus: text("lifecycle_status", { enum: AGENT_LIFECYCLE_STATUSES })
    .notNull()
    .default("active"),
  lifecycleReason: text("lifecycle_reason"),
  lifecycleChangedAt: timestamp("lifecycle_changed_at", { withTimezone: true }),
  // ADR-0168 amendment item 6 (migration 0132) — STEWARDSHIP. The steward is
  // `ownerUserId` above (one accountable-human record, named `stewardUserId`
  // in the API). The successor takes over when the steward leaves; a DB CHECK
  // (agents_successor_not_steward_ck) keeps the two different people. FKs ON
  // DELETE SET NULL in SQL. "Orphaned" and "review overdue" are computed at
  // read time — no stored flag.
  successorUserId: uuid("successor_user_id"),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
  lastReviewedByUserId: uuid("last_reviewed_by_user_id"),
  // OPTIMIZATION §7/§8: list price per million tokens; null = unpriced, the
  // optimizer will never route toward (or estimate savings against) it.
  costPerMTokIn: doublePrecision("cost_per_mtok_in"),
  costPerMTokOut: doublePrecision("cost_per_mtok_out"),
  // MODEL DISPATCH: provider-native model id this registry entry executes as
  // (e.g. claude-opus-5). null = decision/routing-only, not dispatchable.
  model: text("model"),
  // ADR-0023: the admin-authored per-agent BASE system prompt — a GOVERNANCE
  // ARTIFACT, not a caller convenience. When set, every governed dispatch of
  // this agent sends it as the system field's base; a caller-supplied system is
  // APPENDED after it, never replaces it (enforced in executeGovernedDispatch,
  // so direct invokes, orchestration workers, and both compat shims inherit
  // the invariant from the one shared core). null = no base prompt (today's
  // behaviour, byte-identical).
  systemPrompt: text("system_prompt"),
  // ADR-0034 (migration 0048): when `provider` is the literal 'custom', THIS
  // is which admin-registered endpoint the agent executes against. The two
  // fields form a discriminated union enforced in the DB by
  // agents_custom_provider_ck: provider='custom' ⇔ custom_provider_id IS NOT
  // NULL. Deliberately a real FK column rather than encoding the id inside the
  // `provider` text: `provider` is a CLOSED vocabulary that model_credentials
  // keys on, usage_events records, the env-fallback allow-list enumerates and
  // isModelProviderKind() switches over exhaustively — smuggling 'custom:<uuid>'
  // through it would silently poison every one of those. ON DELETE RESTRICT:
  // an endpoint an agent still points at cannot be deleted out from under it.
  customProviderId: uuid("custom_provider_id"),
  // ADR-0175 review fix (migration 0141): the model id the provider is
  // EXPECTED to report serving, when it differs from `model` (an endpoint
  // whose configured id is a deployment name). NULL = compare with `model`.
  expectedServedModel: text("expected_served_model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// ADR-0034 (migration 0048) — ADMIN-REGISTERED CUSTOM LLM PROVIDERS, and the
// egress allow-list that makes their admin-suppliable baseUrl safe to have.
// ---------------------------------------------------------------------------

/** The two wire dialects a custom endpoint may speak. Both reuse an existing,
 * already-tested adapter core — this is a routing choice, not a new protocol
 * implementation, which is exactly why the set is closed. */
export const CUSTOM_WIRE_PROTOCOLS = ["openai_chat", "anthropic_messages"] as const;
export type CustomWireProtocol = (typeof CUSTOM_WIRE_PROTOCOLS)[number];

export const customModelProviders = pgTable("custom_model_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** admin-chosen label; what appears wherever a provider name appears */
  name: text("name").notNull().unique(),
  wireProtocol: text("wire_protocol", { enum: CUSTOM_WIRE_PROTOCOLS }).notNull(),
  /** the endpoint root, e.g. https://vllm.corp.example/v1 */
  baseUrl: text("base_url").notNull(),
  /** AES-256-GCM under REGULAIT_DATA_KEY, same discipline as every other
   * credential surface — write-only, never returned. NULLABLE on purpose: a
   * local Ollama / LocalAI endpoint has no API key at all, and inventing a
   * placeholder would make "is this authenticated?" unanswerable. */
  keyCiphertext: text("key_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  /** the provider HALF of the plaintext-http opt-in. Both this AND the
   * matching egress_allow_hosts row must be true for an http:// baseUrl to be
   * reachable — one flag is a typo, two flags are a decision. */
  allowPlaintextHttp: boolean("allow_plaintext_http").notNull().default(false),
  /** default FALSE: a freshly registered provider is inert until an admin runs
   * the connection test and enables it. */
  enabled: boolean("enabled").notNull().default(false),
  /** when the connection test last passed — enabling requires a pass */
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestError: text("last_test_error"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The admin egress allow-list. DEFAULT-DENY: an empty table means no custom
 * provider can reach anything. Exact host match only — no wildcards, because a
 * `*.example.com` entry is one dangling subdomain away from being a hole. */
export const egressAllowHosts = pgTable("egress_allow_hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** normalized: lowercase, punycode, no trailing dot */
  host: text("host").notNull().unique(),
  /** lets THIS host resolve into an otherwise-blocked range (RFC1918, loopback,
   * link-local, CGNAT…). Off by default. This is the air-gapped escape hatch
   * pillar 3 needs — `http://localhost:11434`, `http://vllm.internal:8000` —
   * scoped to one host and recorded as an admin decision, never a blanket
   * "allow private". It does NOT relax the https requirement. */
  allowPrivateRanges: boolean("allow_private_ranges").notNull().default(false),
  /** the host HALF of the plaintext-http opt-in (see the provider flag above) */
  allowPlaintextHttp: boolean("allow_plaintext_http").notNull().default(false),
  /** why this host is here — an allow-list row with no stated reason is how
   * allow-lists rot */
  note: text("note"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CustomModelProviderRow = typeof customModelProviders.$inferSelect;
export type EgressAllowHostRow = typeof egressAllowHosts.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0088 (migration 0090) — REGISTERED EXTERNAL EVAL SCORERS.
//
// The operator brings the instrument (a Fiddler-class scoring endpoint they
// run or buy); the gateway brings the governance. A row here is a DISCLOSED
// measuring instrument an eval scorer config may name for a judge-backed
// metric — never a model we ship, never a fallback anything degrades to, and
// never reachable until its host is in `egress_allow_hosts` AND its own
// connection test has passed. Every score it produces is stamped
// `method: "external:<name>"` on the result row, so a vendor's opinion can
// never be read as our lexical metric or as a model-judged entailment.
// ---------------------------------------------------------------------------

export const externalScorers = pgTable("external_scorers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** admin-chosen label; the SAME string an eval scorer config names via
   * `externalScorer`, and the string stamped into `method: "external:<name>"`
   * on every result row this instrument scores */
  name: text("name").notNull().unique(),
  /** the scoring endpoint. Admin-typed, therefore an SSRF primitive: validated
   * by the ADR-0034 egress guard at registration, at run pre-flight, and again
   * per HTTP request (DNS-pinned) — identical posture to a custom provider */
  baseUrl: text("base_url").notNull(),
  /** AES-256-GCM under REGULAIT_DATA_KEY, write-only, never returned — the
   * same discipline as custom_model_providers.key_ciphertext. NULLABLE: an
   * on-prem scorer that authenticates by network position has no secret. */
  keyCiphertext: text("key_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  /** which judge-backed scorer kinds this instrument CLAIMS to serve
   * (llm_as_judge / groundedness_judge / answer_relevance_judge). A claim,
   * not a verification — the gateway governs the call, it does not validate
   * the instrument. A run naming this scorer for a kind outside this list is
   * refused at pre-flight. */
  scorerKinds: jsonb("scorer_kinds").$type<string[]>().notNull().default([]),
  /** the scorer HALF of the plaintext-http opt-in; the matching
   * egress_allow_hosts row must set it too */
  allowPlaintextHttp: boolean("allow_plaintext_http").notNull().default(false),
  /** default FALSE: a freshly registered scorer is inert until an admin runs
   * the connection test and enables it — register → test → enable, exactly
   * like a custom provider */
  enabled: boolean("enabled").notNull().default(false),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestError: text("last_test_error"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ExternalScorerRow = typeof externalScorers.$inferSelect;

export const agentGrants = pgTable(
  "agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    allowedModes: jsonb("allowed_modes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_grants_user_agent_uq").on(t.userId, t.agentId)],
);

// §4 per-user default and ceiling agent.
export const userAgentPolicies = pgTable("user_agent_policies", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultAgentId: uuid("default_agent_id").references(() => agents.id, { onDelete: "set null" }),
  ceilingAgentId: uuid("ceiling_agent_id").references(() => agents.id, { onDelete: "set null" }),
  // OPTIMIZATION §12: per-user off switch for model routing, admin-set on the
  // existing agent-policy surface (no new admin object, per §13).
  routingMode: text("routing_mode", { enum: ["automatic", "passthrough"] })
    .notNull()
    .default("automatic"),
  // ORCHESTRATION §5.2: per-run budget cap for runs this user initiates, and
  // what happens when a planned run exceeds it. Lives here as a stand-in for
  // the per-project budget until a projects entity exists (admin-set either
  // way). null = no cap.
  runBudgetUsd: doublePrecision("run_budget_usd"),
  runBudgetBreachAction: text("run_budget_breach_action", { enum: ["approve", "replan"] })
    .notNull()
    .default("approve"),
});

// §2 connector catalog + per-user grants (mode + object-level data scope).
export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  // free-text display CATEGORY (e.g. "crm", "issue-tracker") — NOT the adapter.
  kind: text("kind").notNull(),
  // EXECUTION (pillar 5 §10.3): the connector-provider adapter enum
  // (http/webhook/generic/mock/…). Null = governance-only: the invoke endpoint
  // still evaluates policy + writes one audit row but contacts nothing and
  // meters nothing (today's behaviour). Non-null = the call really executes.
  providerKind: text("provider_kind"),
  // connection root for the adapter (generic/http/webhook); a credential row may
  // override it (credential.baseUrl wins), mirroring model_credentials.
  baseUrl: text("base_url"),
  // pillar 5: flat list price per allowed call. Null = unpriced → cost null,
  // never invented (mirrors agents' costPerMTok null-safety).
  pricePerCallUsd: doublePrecision("price_per_call_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// EXECUTION: one platform credential per connector, AES-256-GCM encrypted with
// REGULAIT_DATA_KEY (same discipline as model/git/PM tokens — never plaintext
// at rest, never returned by any endpoint). Keyless kinds (mock, unauthenticated
// generic) never write a row here. Platform-scoped only this slice (no per-user
// BYO connector credential yet).
export const connectorCredentials = pgTable("connector_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  connectorId: uuid("connector_id")
    .notNull()
    .unique()
    .references(() => connectors.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  baseUrl: text("base_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorGrants = pgTable(
  "connector_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["read", "readwrite"] }).notNull(),
    allowedObjects: jsonb("allowed_objects").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connector_grants_user_connector_uq").on(t.userId, t.connectorId)],
);

// §5 role-bundled agent/connector grants: the AGENT/CONNECTOR twins of
// roleToolGrants/roleServerGrants. Assigning a role confers these to a user
// exactly as a direct agentGrant/connectorGrant would — same field shape, so a
// role grant can never exceed a direct grant. Additive (UNION-MAX with direct
// grants), and — since ADR-0019 — BOUNDED by the subtractive per-user
// agentRevocations/connectorRevocations below, so a role-derived agent or
// connector can be taken away from ONE user without unassigning the role. See
// ADR-0014, ADR-0019.
export const roleAgentGrants = pgTable(
  "role_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    allowedModes: jsonb("allowed_modes").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_agent_grants_role_agent_uq").on(t.roleId, t.agentId)],
);

export const roleConnectorGrants = pgTable(
  "role_connector_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["read", "readwrite"] }).notNull(),
    allowedObjects: jsonb("allowed_objects").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_connector_grants_role_connector_uq").on(t.roleId, t.connectorId)],
);

// ADR-0019 — the AGENT/CONNECTOR twins of the MCP `revocations` table, closing
// pillar 1's "role builder + PER-USER OVERRIDE" promise for the two object
// types that had no subtractive override. Unlike the MCP revocation (which is
// role-only, because a direct MCP grant is itself the per-user override), an
// agent/connector revocation is TOTAL for that (user, object): it beats a
// direct grant AND every role-derived grant, because the UNION-MAX composition
// of ADR-0014 otherwise leaves an admin no way to subtract one object from one
// user. A revocation can ONLY ever turn an allow into a deny — the kernel
// consults it strictly on the allow path, so it can never rescue an ungranted
// call. Deleting the row reverses the override, exactly like `revocations`.
export const agentRevocations = pgTable(
  "agent_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** admin's free-text justification — audit prose only, never a policy input */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_revocations_user_agent_uq").on(t.userId, t.agentId),
    index("agent_revocations_user_idx").on(t.userId),
  ],
);

export const connectorRevocations = pgTable(
  "connector_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    reason: text("reason"),
    /** O9 (migration 0045): 'full' (default = today) denies every operation;
     * 'read_only' denies WRITES only — reads stay allowed. Agent revocations
     * carry no scope: agents have no read/write op classification to scope by
     * (ADR-0027). */
    scope: text("scope", { enum: ["full", "read_only"] }).notNull().default("full"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connector_revocations_user_connector_uq").on(t.userId, t.connectorId),
    index("connector_revocations_user_idx").on(t.userId),
  ],
);

// EPIC-03 workflow engine (WORKFLOW_ENGINE_SPEC.md). Templates are the
// declarative §3 definitions; instances snapshot their merged definition at
// start so a template edit never mutates an in-flight run.
export const workflowTemplates = pgTable("workflow_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  definition: jsonb("definition").notNull(),
  /** ADR-0022 retire (soft-disable): a retired template starts NO new
   * instances (creation is refused loudly, never silently skipped — a
   * compliance-required template dropping out silently would ungovern the
   * change); in-flight instances keep their snapshotted definition and are
   * untouched. Not versioning — just an off switch with a recorded why. */
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredReason: text("retired_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// §4 assignment rules: conditions AND together; a rule with no conditions
// matches nothing (kernel-enforced).
export const workflowAssignmentRules = pgTable("workflow_assignment_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => workflowTemplates.id, { onDelete: "cascade" }),
  pathPattern: text("path_pattern"),
  changeType: text("change_type"),
  environment: text("environment"),
  // ADR-0018 (§4 6-dim matching): the target system a change lands on, and the
  // role the initiating user must hold for this rule to apply. initiator_role is
  // matched against the SERVER-derived roles of the authenticated initiator —
  // never a client-supplied value.
  targetSystem: text("target_system"),
  initiatorRole: text("initiator_role"),
  // ADR-0018 addendum (ADR-0019): the 6th and final dim. SERVER-RESOLVED like
  // initiator_role — matched against the compliance classification tags of the
  // change's attributed project (the same source effectiveCompliancePolicy
  // cascades from), never a client-supplied value. No project / no
  // classifications = matches as absent.
  dataSensitivity: text("data_sensitivity"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowInstances = pgTable(
  "workflow_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateIds: jsonb("template_ids").$type<string[]>().notNull(),
    definition: jsonb("definition").notNull(),
    initiatorUserId: uuid("initiator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    change: jsonb("change").notNull(),
    state: jsonb("state").notNull(),
    /** PILLAR 5 attribution: nested runs and their dispatches inherit this */
    projectId: uuid("project_id"),
    /** outputs of executed stages (branch, prId, prUrl, mergeSha, lastError) */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull(),
    /** AER-048 (migration 0130): bumped on every RE-OPEN (artifact resubmitted
     * after its stage completed; sign-off returned). A check report binds to
     * it — a report for a previous round is refused (409) and audited. */
    round: integer("round").notNull().default(0),
    /** AER-048: bumped on every entry into an executable stage and on every
     * re-open. An executor captures it with its claim and commits its result
     * only if it is still current. */
    stageEntry: integer("stage_entry").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_instances_status_idx").on(t.status)],
);

// Append-only per-instance history (§5 dashboard: full history, who, when).
export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    event: jsonb("event").notNull(),
    actorUserId: uuid("actor_user_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_events_instance_idx").on(t.instanceId)],
);

// Versioned artifacts (§2 stage 3): every submitted version retained.
export const workflowArtifacts = pgTable(
  "workflow_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => workflowInstances.id, { onDelete: "cascade" }),
    stageId: text("stage_id").notNull(),
    output: text("output").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workflow_artifacts_instance_output_version_uq").on(t.instanceId, t.output, t.version)],
);

// Git connections for workflow git_operation stages. The token is stored
// AES-256-GCM-encrypted with the gateway's data key — never plaintext.
export const gitConnections = pgTable("git_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["github", "gitlab", "bitbucket", "azure_devops", "mock"],
  }).notNull(),
  baseUrl: text("base_url"),
  tokenCiphertext: text("token_ciphertext").notNull(),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// §2 pillar-2 deploy targets: a governed destination a `deployment`/`rollback`
// stage acts on. Provider-agnostic (mock now; AWS/Azure/GCP/k8s later — the
// BYOC/air-gapped angle of pillar 3). Credentials are optional (mock needs
// none) and, when present, encrypted at rest exactly like a git connection
// token. A deploy stage naming a target that doesn't exist parks at a manual
// handoff — that's the "connector-availability" gate.
export const deployTargets = pgTable("deploy_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["mock", "aws", "azure", "gcp", "kubernetes"],
  }).notNull(),
  environment: text("environment"),
  baseUrl: text("base_url"),
  credentialCiphertext: text("credential_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  // §3 BYOC deployment mode: hosted (we run it), byoc (customer's own cloud
  // account/IAM), or air_gapped (customer-hosted, no execution-plane data ever
  // returns to the control plane — the deploy record we keep is metadata-only).
  mode: text("mode", { enum: ["hosted", "byoc", "air_gapped"] }).notNull().default("hosted"),
  // §3 aws BYOC: the customer IAM role we assume (short-lived creds, no static
  // keys) and the region to deploy in. Null for the mock/hosted provider.
  roleArn: text("role_arn"),
  region: text("region"),
  // Migration 0043 (the #64 flagged gap): per-provider-kind config, validated
  // per kind at the API boundary (shared's createDeployTargetSchema). A jsonb
  // rather than one column per field, deliberately: the table stays
  // provider-agnostic (the standing principle) — a future provider adds keys,
  // not DDL — while the zod per-kind validation is every bit as strict as a
  // column CHECK would be. Null = a pre-0043 row = the legacy behaviour
  // (roleArn doubles as the azure subscription / gcp project handle, live
  // clients fall back to their env vars).
  //   aws:        { cluster? }                                (roleArn/region stay columns)
  //   azure:      { subscriptionId?, resourceGroup?, templateUri? }
  //   gcp:        { projectId?, blueprintGcs? }
  //   kubernetes: { namespace? }                              (kubeconfig stays the credential)
  providerConfig: jsonb("provider_config").$type<{
    cluster?: string;
    subscriptionId?: string;
    resourceGroup?: string;
    templateUri?: string;
    projectId?: string;
    blueprintGcs?: string;
    namespace?: string;
  } | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// OPTIMIZATION §7: the savings ledger — one row per optimization decision at
// the interception point, per technique, dashboard-ready for pillar 5's
// rollup. Like audit_log it carries no FKs: cost history must survive
// user/agent deletion.
export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    objectType: text("object_type", { enum: ["agent", "mcp_tool", "connector", "workflow", "run"] })
      .notNull()
      .default("agent"),
    objectId: uuid("object_id"),
    technique: text("technique", {
      enum: [
        "model_routing",
        "edit_vs_rewrite",
        "context_compaction",
        "file_preprocessing",
        "prompt_caching",
        "lazy_tool_loading",
        "semantic_caching",
        "request_batching",
      ],
    }).notNull(),
    requestedAgentId: uuid("requested_agent_id"),
    servedAgentId: uuid("served_agent_id"),
    baselineAgentId: uuid("baseline_agent_id"),
    estimatedTokensIn: integer("estimated_tokens_in").notNull().default(0),
    estimatedTokensOut: integer("estimated_tokens_out").notNull().default(0),
    estimatedTokensSaved: integer("estimated_tokens_saved").notNull().default(0),
    estimatedCostSavedUsd: doublePrecision("estimated_cost_saved_usd"),
    estimationBasis: text("estimation_basis").notNull(),
    ruleId: text("rule_id").notNull(),
    /** PILLAR 5 attribution; FK-free like the rest of the ledger */
    projectId: uuid("project_id"),
    detail: jsonb("detail"),
  },
  (t) => [
    index("cost_events_user_at_idx").on(t.userId, t.at),
    index("cost_events_technique_idx").on(t.technique),
  ],
);

// OPTIMIZATION §8/§10 semantic caching: a REAL exact-match response cache,
// scoped strictly per (user, agent). A row is the CALLER'S OWN record — like
// the rest of the ledger it carries no FKs, and the §12 governance boundary is
// enforced at the route by scoping every lookup with BOTH userId AND agentId,
// so a user can never be served another user's (or another agent's) cached
// response. promptHash is the sha256 of the normalized input; normalizedInput
// is stored beside it as a hash-collision guard (the route re-checks equality).
export const semanticCache = pgTable(
  "semantic_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(), // SCOPE — never cross-user
    agentId: uuid("agent_id").notNull(), // SCOPE — never cross-agent
    promptHash: text("prompt_hash").notNull(), // sha256 of the normalized input
    normalizedInput: text("normalized_input").notNull(), // stored to guard against hash collision
    outputText: text("output_text").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("semantic_cache_user_agent_hash_uq").on(t.userId, t.agentId, t.promptHash)],
);

// ORCHESTRATION (EPIC-05, pillar 7): one row per run. The task graph and run
// state are jsonb snapshots exactly like workflow_instances — the kernel owns
// their shape. workflow_instance_id links a run nested inside a build stage
// (§8); null = directly-initiated run.
export const orchestrationRuns = pgTable(
  "orchestration_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    initiatingUserId: uuid("initiating_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, {
      onDelete: "set null",
    }),
    graph: jsonb("graph").notNull(),
    state: jsonb("state").notNull(),
    /** PILLAR 5 attribution: every node dispatch of this run bills here */
    projectId: uuid("project_id"),
    /** §5.2 budget envelope: cap, estimates, live estimated spend, overage approval */
    budget: jsonb("budget"),
    status: text("status", { enum: ["planned", "running", "completed", "aborted"] })
      .notNull()
      .default("planned"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orchestration_runs_user_idx").on(t.initiatingUserId)],
);

export const orchestrationRunEvents = pgTable(
  "orchestration_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => orchestrationRuns.id, { onDelete: "cascade" }),
    event: jsonb("event").notNull(),
    actorUserId: uuid("actor_user_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orchestration_run_events_run_idx").on(t.runId)],
);

// PM-TOOL INTEGRATION (EPIC-06, pillar 8). Connections mirror git_connections:
// the token is stored AES-256-GCM-encrypted, never plaintext. mapping is the
// admin's override of the adapter's default field mapping (null = default).
export const pmConnections = pgTable("pm_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", {
    enum: ["azure_devops", "jira", "linear", "asana", "monday", "generic_webhook", "mock"],
  }).notNull(),
  baseUrl: text("base_url"),
  project: text("project").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  mapping: jsonb("mapping"),
  /** jira only: REST API version (2 = legacy plain text, 3 = ADF rich text);
   * null = the provider default (v2) — connections minted before this column
   * existed keep behaving exactly as they did. */
  apiVersion: integer("api_version"),
  /** ADR-0010: sha256 of the per-connection webhook secret (plaintext shown once) */
  webhookSecretHash: text("webhook_secret_hash"),
  /** Provider-native inbound verification (pillar 8 depth): HMAC signature
   * checks (linear/asana/generic) need the secret itself, which a hash cannot
   * key — stored AES-256-GCM-encrypted like the connection token. Null on
   * connections minted before this column existed (legacy-header flows only). */
  webhookSecretCiphertext: text("webhook_secret_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the webhook secret was last set (keyed
   * on its hash, which a data-key re-encryption never rewrites). */
  webhookSecretSetAt: timestamp("webhook_secret_set_at", { withTimezone: true }),
  /** O7 (migration 0045): what a detected drift does. 'manual' (default =
   * today) surfaces only; 'prefer_regulait' pushes RegulAIt's expected state
   * back to the PM tool; 'prefer_pm' adopts the PM tool's state on the link
   * (the run state machine is never driven from outside). */
  driftResolution: text("drift_resolution", {
    enum: ["manual", "prefer_pm", "prefer_regulait"],
  })
    .notNull()
    .default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// §2/§6: the link record making a task-graph node BE a work item rather than
// a shadow copy. RegulAIt stores only the linkage — the PM-authoritative
// fields (priority/description/acceptance criteria) are read through live,
// never cached here (§3).
export const pmLinks = pgTable(
  "pm_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => pmConnections.id, { onDelete: "cascade" }),
    objectType: text("object_type", { enum: ["run_node", "run", "workflow_instance", "decision"] }).notNull(),
    objectId: uuid("object_id").notNull(),
    /** task-graph node id when objectType is run_node */
    nodeId: text("node_id"),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** ADR-0010 inbound: last state reported BY the PM tool — recorded, never
     * applied to the state machine; divergence surfaces as drift */
    inboundState: text("inbound_state"),
    inboundAt: timestamp("inbound_at", { withTimezone: true }),
    /** O7 (migration 0045): the PM-reported state a prefer_pm connection has
     * ADOPTED as authoritative for this item — an inboundState equal to it no
     * longer counts as drift. Null = nothing adopted (today). */
    adoptedState: text("adopted_state"),
    /** set when the PM tool reports the item deleted */
    orphanedAt: timestamp("orphaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT applied in the hand-written migration (0005 precedent)
    uniqueIndex("pm_links_conn_obj_node_uq").on(t.connectionId, t.objectType, t.objectId, t.nodeId),
    index("pm_links_object_idx").on(t.objectType, t.objectId),
  ],
);

// PM-TOOL INTEGRATION §4: first-class Decision records. FK-free like
// audit_log — a decision is a governance record that must survive the
// deletion of the run/instance/user it describes.
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectType: text("object_type", { enum: ["run", "workflow_instance"] }).notNull(),
    objectId: uuid("object_id").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    /** always the authenticated identity — never a body field */
    decisionMakerUserId: uuid("decision_maker_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("decisions_object_idx").on(t.objectType, t.objectId)],
);

// ADR-0010: append-only inbound webhook event log — every signal the PM tool
// sends is retained, matched or not.
export const pmSyncEvents = pgTable(
  "pm_sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => pmConnections.id, { onDelete: "cascade" }),
    linkId: uuid("link_id"),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ["updated", "deleted", "commented"] }).notNull(),
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pm_sync_events_conn_idx").on(t.connectionId, t.receivedAt)],
);

// MODEL DISPATCH: one platform credential per model provider, AES-256-GCM
// encrypted with REGULAIT_DATA_KEY (same discipline as git/PM connection
// tokens — never plaintext at rest, never returned by any endpoint).
export const modelCredentials = pgTable("model_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().unique(),
  keyCiphertext: text("key_ciphertext").notNull(),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  /** override for BYOC/air-gapped bridges; null = provider default endpoint */
  baseUrl: text("base_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 5: the MEASURED actual-spend ledger. Distinct from cost_events on
// purpose — cost_events rows are estimates (estimationBasis says so); rows
// here carry the provider's own token accounting for a dispatch that really
// happened. FK-free like audit_log: spend records outlive their subjects.
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").notNull(),
    /** what this spend row is FOR: 'agent' (model dispatch) or 'connector'
     * (a governed connector call). One ledger, so the per-project rollup
     * picks connector spend up automatically. */
    objectType: text("object_type").notNull().default("agent"),
    /** the agent that actually served (post-routing) — null on connector rows */
    agentId: uuid("agent_id"),
    requestedAgentId: uuid("requested_agent_id"),
    baselineAgentId: uuid("baseline_agent_id"),
    /** connector rows only: the connector that executed, and its operation */
    connectorId: uuid("connector_id"),
    operation: text("operation"),
    /** null on connector rows (no provider/model/tokens) */
    provider: text("provider"),
    model: text("model"),
    /** ADR-0175 A4 (migration 0141) — the model id the PROVIDER reported
     * serving, verbatim (Anthropic/OpenAI `model`, Google `modelVersion`).
     * `model` above is what we configured and asked for; this is what came
     * back. NULL = the provider did not report one (and every pre-0141 row,
     * every connector/MCP row, every semantic-cache hit) — never guessed. */
    servedModel: text("served_model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** agent rows: measured tokens × list price. connector rows: the
     * connector's flat price_per_call_usd. Null = unpriced, never invented. */
    costUsd: doublePrecision("cost_usd"),
    /** what the routing baseline would have cost at the SAME measured token
     * volumes, minus costUsd — the honest, measured version of the routing
     * savings that cost_events could only estimate */
    measuredCostSavedUsd: doublePrecision("measured_cost_saved_usd"),
    stopReason: text("stop_reason"),
    refusal: boolean("refusal").notNull().default(false),
    providerMessageId: text("provider_message_id"),
    /** PILLAR 5 attribution; FK-free like the rest of the ledger */
    projectId: uuid("project_id"),
    /** ADR-0048 §3 — THE STAMP. Which immutable config version (today: which
     * agent base-system-prompt version) actually served this dispatch, and
     * whether it was serving as a CANARY. This is the whole point of a canary:
     * a regression observed in the metrics must be traceable to the version
     * that caused it. FK-free like the rest of the ledger, and the integer is
     * stored alongside the id so the answer survives a pruned version row.
     * NULL = no versioned artifact governed this row (a connector/MCP row, or
     * an agent that has never had a base prompt). */
    configVersionId: uuid("config_version_id"),
    configVersion: integer("config_version"),
    configCanary: boolean("config_canary").notNull().default(false),
    /** ADR-0066 §2 — WHICH VIRTUAL KEY PAID FOR THIS ROW. FK-free like every
     * other attribution column here: a revoked-and-deleted key must not take
     * its spend history with it. NULL = the call arrived on an ordinary API
     * key, a session, or an internal (scheduler/orchestration) path, which is
     * every pre-0066 row. */
    virtualKeyId: uuid("virtual_key_id"),
    /** Batch B7c (ADR-0073 amendment, migration 0102) — WHICH `agent_config`
     * VERSION SERVED. The B1 amendment disclosed "usage_events still stamps
     * only the PROMPT version (one stamp column, two artifact types)"; this
     * closes it. Mirrors the prompt stamp above exactly: FK-FREE like every
     * other attribution column of this ledger, integer stored alongside the id
     * so the answer survives a pruned version row. NULL = the agent's config
     * was unversioned (every pre-B7c row, byte-identical). NEVER the shadow/
     * canary CANDIDATE id — the column means "what served", and an
     * agent_config candidate never serves (ADR-0073's invariant). */
    agentConfigVersionId: uuid("agent_config_version_id"),
    agentConfigVersion: integer("agent_config_version"),
    detail: jsonb("detail"),
  },
  (t) => [
    index("usage_events_user_idx").on(t.userId, t.at),
    index("usage_events_config_version_idx").on(t.configVersionId),
    index("usage_events_agent_config_version_idx").on(t.agentConfigVersionId),
    // ADR-0175 A4/A9 — the governance monitor's window scans read the ledger
    // by time; partial so it holds only agent rows that reported a served model
    index("usage_events_served_model_idx").on(t.agentId, t.at).where(sql`${t.servedModel} IS NOT NULL`),
    // ADR-0175 review fix (migration 0141): the A9 window scan
    index("usage_events_object_type_at_idx").on(t.objectType, t.at),
    // ADR-0066 (migration 0078): per-key reads; the A7 inventory's windowed
    // virtual-key link query uses it too
    index("usage_events_virtual_key_idx").on(t.virtualKeyId, t.at),
    // ADR-0175 A7 review fix (migration 0142): the inventory's windowed
    // connector reads; partial, since only connector rows carry one
    index("usage_events_connector_at_idx").on(t.connectorId, t.at).where(sql`${t.connectorId} IS NOT NULL`),
  ],
);

// MODEL DISPATCH: per-user provider credentials (BYO key). Resolution order
// at dispatch is user credential → platform model_credentials → explicit
// failure; same encryption discipline (AES-256-GCM under REGULAIT_DATA_KEY,
// never plaintext at rest, never returned by any endpoint).
export const userModelCredentials = pgTable(
  "user_model_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
     * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
    secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_model_credentials_user_provider_uq").on(t.userId, t.provider)],
);

// PILLAR 5 cross-team rollup: an Initiative is a flat, reporting-only grouping
// of projects for cost attribution across teams (chargeback/showback at a
// higher level than a single project). v1 is grouping only — no initiative-level
// budget or enforcement; a project's own budget/governance is unchanged.
// Declared before `projects` so the projects.initiativeId FK is an ordinary
// forward reference rather than a thunk-only one.
export const initiatives = pgTable("initiatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** chargeback/showback: the customer's own cost-center code for the initiative */
  costCenter: text("cost_center"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 5: the cost-attribution object. Minimal on purpose — membership and
// sharing semantics arrive with Shared Projects (pillar 4); until then any
// authenticated caller may attribute spend to a project (noted, deferred).
// A budget requires a named approver: enforcement escalates into the ONE
// approvals queue and only that approver can sanction the overage.
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** chargeback/showback: the customer's own cost-center code */
  costCenter: text("cost_center"),
  /** pillar-5 rollup: optional parent Initiative for cross-team cost grouping.
   * Reporting-only — grouping a project under an initiative changes NO
   * governance or budget behaviour. onDelete 'set null': deleting an initiative
   * orphans its children back to ungrouped, never deletes project rows. */
  initiativeId: uuid("initiative_id").references(() => initiatives.id, { onDelete: "set null" }),
  budgetUsd: doublePrecision("budget_usd"),
  budgetApproverUserId: uuid("budget_approver_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  /** pillar-5 budget window: 'none' = lifetime-cumulative (default, back-compat);
   * 'monthly' = only spend within the current calendar month (UTC) counts. */
  budgetPeriod: text("budget_period").notNull().default("none"),
  /** warn (non-blocking) when windowed spend crosses budget*pct/100; the hard
   * block + escalation always stays at 100%. Default 100 = warn only at the cap
   * (byte-identical to the pre-threshold behaviour). */
  alertThresholdPct: integer("alert_threshold_pct").notNull().default(100),
  /** a decided __project_budget__ approval lifts enforcement for this project */
  overageApproved: boolean("overage_approved").notNull().default(false),
  /** the period key (e.g. '2026-07') an overage was approved for; the latch
   * only suppresses enforcement while it equals the current period. Null when
   * budgetPeriod='none' (the lifetime latch is unscoped) or never approved. */
  overageApprovedPeriod: text("overage_approved_period"),
  /** §9 named arbiter for shared-context conflicts; absent = conflicting
   * writes are rejected explicitly (never silently) */
  arbiterUserId: uuid("arbiter_user_id").references(() => users.id, { onDelete: "set null" }),
  /** §8.3: compliance framework tags (multi-valued — hipaa, pci-dss, soc2,
   * gdpr, custom…; the spec defines NO strictness ordering among frameworks) */
  classifications: jsonb("classifications").$type<string[]>(),
  /** §8.3 reclassification: proposed tags awaiting the diff-then-approve
   * review — never applied silently */
  pendingClassifications: jsonb("pending_classifications").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// MULTI-TURN CONVERSATIONS: a personal (per-user) thread of governed
// dispatches against one agent. FK-free ids on purpose, like the ledgers —
// a conversation is the user's own record and must not vanish because an
// agent or project row was deleted; access control is enforced at the
// routes (strictly own-scoped, admins included).
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** pillar 5 default attribution for every turn dispatched in this thread */
    projectId: uuid("project_id"),
    /** auto-titled from the first user turn (~60 chars) when left null */
    title: text("title"),
    /** PILLAR 6 §5 context compaction: the persisted summary of every turn up
     * to and including summary_through_message_id. One summary per
     * conversation, REPLACED cumulatively on re-compaction (new input =
     * existing summary + turns since). Stored messages are never deleted or
     * altered — these fields only change what is model-bound. */
    summary: text("summary"),
    summaryThroughMessageId: uuid("summary_through_message_id"),
    /** chars/4 estimate of the summary — the cost side of the savings claim */
    summaryTokens: integer("summary_tokens"),
    compactedAt: timestamp("compacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversations_user_updated_idx").on(t.userId, t.updatedAt)],
);

// One row per persisted turn. Assistant turns carry the dispatch facts in
// detail (stopReason/refusal/servedAgentId/modelUsed/costUsd/credentialSource);
// a user turn that was governance-DENIED carries detail.denied so history
// shows the attempt honestly. createdAt is written explicitly by the gateway
// (user turn strictly before its assistant turn) so ordering never depends on
// a shared transaction timestamp.
export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_messages_conv_at_idx").on(t.conversationId, t.createdAt)],
);

// §8.3: the cascade expressed as DATA — one admin-editable profile per
// framework tag, mapping it to what it drives. Workflow requirements are
// ENFORCED at instance creation; mcp/retention/pii are declared policy the
// compliance view surfaces with honest enforcement labels until their
// enforcement points exist.
export const complianceProfiles = pgTable("compliance_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tag: text("tag").notNull().unique(),
  /** workflow templates this framework forces into every governed change */
  requiredTemplateIds: jsonb("required_template_ids").$type<string[]>(),
  mcpDefaultMode: text("mcp_default_mode", { enum: ["read_only", "read_write"] })
    .notNull()
    .default("read_write"),
  auditRetentionDays: integer("audit_retention_days"),
  piiMode: text("pii_mode", { enum: ["block", "warn", "log"] }).notNull().default("log"),
  /** §8.3 -> §8.2 tie: the backup retention + patch cadence this framework
   * forces onto any infra resource carrying its tag (pillar 3). Null = the
   * framework declares no infra floor of its own. */
  backupRetentionDays: integer("backup_retention_days"),
  patchCadenceDays: integer("patch_cadence_days"),
  /** O2 (migration 0045): project-budget CEILING this framework forces onto
   * any project carrying its tag — composed as MIN (strictest ceiling wins),
   * and it caps an unbudgeted project too. Null = no ceiling. */
  maxProjectBudgetUsd: doublePrecision("max_project_budget_usd"),
  /** O2: budget-enforcement FLOOR — 'block' forces blocking even when the org
   * says warn_only (strictest wins, matching the cascade's composition
   * rules); 'warn_only' can never relax a stricter org setting (surfaced as
   * an inert declaration). Null = no opinion. */
  budgetEnforcement: text("budget_enforcement", { enum: ["block", "warn_only"] }),
  /** ADR-0042 (migration 0055): the guardrail FLOOR this framework forces onto
   * every project carrying its tag — a partial map detector -> mode, e.g.
   * {"prompt_injection":"block"}. Composed MAX-of-strictness across a
   * project's profiles exactly as `piiMode` is, and then composed by the same
   * MAX with the org/agent/connector setting, so a framework can only ever
   * RAISE a layer and a local setting can never relax below it. NULL (every
   * pre-0055 row) = this framework has no guardrail opinion. */
  guardrailModes: jsonb("guardrail_modes").$type<Partial<Record<GuardrailDetectorId, GuardrailMode>>>(),
  /** ADR-0068 §5 (migration 0080) — this framework's RED-TEAM opinion, on the
   * SAME row as its PII mode and guardrail floor rather than in a parallel
   * config: the attack classes it forces into the gating set, the minimum
   * trials per probe it requires, and the severity floor at or above which a
   * defeat fails its class outright. Composed by the cascade's existing rules
   * (union / MAX / strictest-wins) and applied TIGHTEN-ONLY, so a framework can
   * raise a red-team bar and never lower one. NULL (every pre-0080 row) = this
   * framework has no red-team opinion and the caller's request stands. */
  redteamGatingClasses: jsonb("redteam_gating_classes").$type<string[]>(),
  redteamMinTrials: integer("redteam_min_trials"),
  // literal rather than RED_TEAM_SEVERITY_VALUES: that const is declared far
  // below this table and would be in its temporal dead zone at module load.
  redteamFailOnSeverity: text("redteam_fail_on_severity", {
    enum: ["low", "medium", "high", "critical"],
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PILLAR 4 (§9, ADR-0011): teams and Shared-Project membership. Membership
// roles are per-user and DECOUPLED from home-team role; membership widens
// what context a member sees, never what tools/agents they may call.
export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** §9.3: the team's default classifications; a Shared Project's own tags
   * take precedence inside the project, and mismatches are SURFACED (never
   * silently resolved) at member-add */
  defaultClassifications: jsonb("default_classifications").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("team_members_team_user_uq").on(t.teamId, t.userId)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** the member's contributing team, for provenance defaults; optional */
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    role: text("role", { enum: ["owner", "contributor", "viewer"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_members_project_user_uq").on(t.projectId, t.userId)],
);

// §9.2 shared context store: APPEND-ONLY revisions. The current value of a
// key is its highest ACCEPTED revision; a write based on a stale revision is
// retained but not accepted (a conflict for the named arbiter). Contributor
// ids are FK-free — provenance is a governance record that must survive
// user/team deletion.
export const projectContextItems = pgTable(
  "project_context_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    revision: integer("revision").notNull(),
    content: text("content").notNull(),
    /** the accepted revision the writer based this on; null = first write */
    baseRevision: integer("base_revision"),
    accepted: boolean("accepted").notNull().default(true),
    contributedByUserId: uuid("contributed_by_user_id").notNull(),
    contributedByTeamId: uuid("contributed_by_team_id"),
    /** §9.4 promotion provenance: the team-local artifact this came from */
    sourceArtifactId: uuid("source_artifact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_context_project_key_rev_uq").on(t.projectId, t.key, t.revision),
    index("project_context_project_key_idx").on(t.projectId, t.key),
  ],
);

// ADR-0022 — approver delegation (vacation/offboarding coverage). While a
// delegation window is ACTIVE (starts_at <= now < ends_at), every PENDING
// approval naming from_user as approver ALSO appears in to_user's inbox, and
// to_user may decide it. The decision records the REAL decider (decidedBy)
// plus an on-behalf-of audit row naming the delegator and the delegation —
// both sides of the act are in the one trail. Admin-managed; the rows are
// windows, not standing grants — expiry needs no cleanup, the time check does
// it. Deleting a row ends the delegation immediately.
export const approvalDelegations = pgTable(
  "approval_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    /** the admin who set it up (audit prose; FK-free so history survives) */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approval_delegations_to_idx").on(t.toUserId),
    index("approval_delegations_from_idx").on(t.fromUserId),
  ],
);

// PILLAR 3 (§8.2): a GOVERNED-OPERATIONS layer — monitored resources +
// operational policies + detected findings + governed remediation. NOT a real
// infra patcher: findings are inert reports; a remediation is a governed action
// (auto-remediated under policy, or approval-gated) that runs strictly after
// the governance decision, exactly like the connector execution layer.

// A monitored piece of infrastructure. `provider` is an infra-provider kind
// ('mock' for the MVP); `classifications` carries §8.3 compliance tags whose
// cascade derives the resource's backup/patch floors (§8.3 -> §8.2).
export const infraResources = pgTable("infra_resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["control_plane", "agent_runtime", "cert", "backup_target"] }).notNull(),
  name: text("name").notNull().unique(),
  /** infra-provider kind — 'mock' is keyless/deterministic for the MVP */
  provider: text("provider").notNull().default("mock"),
  /** provider-specific handle (endpoint, days-until-expiry, backup age, …) */
  config: jsonb("config").$type<Record<string, unknown>>(),
  /** §8.3 compliance tags — the cascade applies backup/patch floors */
  classifications: jsonb("classifications").$type<string[]>(),
  /** ADR-0017 — a monitored resource MAY live in a customer-hosted deploy
   * target; an air_gapped target forces metadata-only remediation records
   * (the ADR-0015 control-plane data boundary). ON DELETE SET NULL: dropping a
   * target must never cascade-delete the monitored resource. */
  deployTargetId: uuid("deploy_target_id").references(() => deployTargets.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An operational policy. A null resourceId is FLEET-WIDE (a default for every
// resource); a resource-scoped policy overrides it. `autoRemediateMaxSeverity`
// is the ceiling at/under which a NEW finding is auto-remediated (audited, no
// approval) — null = never auto-remediate. 'critical' is NOT a valid value:
// critical findings are ALWAYS approval-gated regardless of policy.
export const infraPolicies = pgTable(
  "infra_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id").references(() => infraResources.id, { onDelete: "cascade" }),
    patchCadenceDays: integer("patch_cadence_days"),
    certRotationDaysBeforeExpiry: integer("cert_rotation_days_before_expiry"),
    backupSchedule: text("backup_schedule"),
    backupRetentionDays: integer("backup_retention_days"),
    driftBaseline: jsonb("drift_baseline").$type<Record<string, unknown>>(),
    autoRemediateMaxSeverity: text("auto_remediate_max_severity", {
      enum: ["low", "medium", "high"],
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("infra_policies_resource_idx").on(t.resourceId)],
);

// A detected finding — an INERT report until governed. `signature` (carried in
// detail) is a stable natural key so a re-scan is idempotent: the unique index
// on (resource_id, kind, detail->>'signature') means scanning twice refreshes
// detected_at rather than duplicating an open finding.
export const infraFindings = pgTable(
  "infra_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["drift", "cve", "cert_expiring", "backup_missed"] }).notNull(),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    /** ADR-0017 — a finding stays the single inert alert surface but now links
     * to its durable domain ledger row (FK-less soft link: which table + id).
     * null for drift, which has no ledger. */
    refTable: text("ref_table"),
    refId: uuid("ref_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status", {
      enum: [
        "open",
        "remediation_proposed",
        "auto_remediated",
        "approved",
        "remediated",
        "accepted_risk",
      ],
    })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("infra_findings_resource_idx").on(t.resourceId),
    uniqueIndex("infra_findings_natural_key_uq").on(
      t.resourceId,
      t.kind,
      sql`(${t.detail}->>'signature')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0017 — infra-ops automation ledgers (pillar 3 §8.2 automation depth).
// Durable domain records hang off infra_resources and link back to the inert
// infra_findings alert surface via ref_table/ref_id. Remediation still flows
// through the ONE Approvals Queue (objectType infra_operation) — these tables
// record OUTCOMES, they never introduce a second decision path.
// ---------------------------------------------------------------------------

// Certificate inventory — one row per tracked certificate on a resource. A
// cert_expiring finding upserts the matching inventory row; a governed rotation
// advances not_after/last_rotated_at/status.
export const certInventory = pgTable(
  "cert_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    commonName: text("common_name").notNull(),
    issuer: text("issuer"),
    serial: text("serial"),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    // O6 (ADR-0027) cert-rotation LIFECYCLE — text (no DB CHECK), like
    // infra_findings, so drizzle owns the enum:
    //   active → rotation_proposed → (approve) rotating* → rotated
    //                              ↘ (deny)             → rotation_denied
    //                              ↘ (provider failure) → rotation_failed
    // (*rotating is the in-txn provider call, not a persisted checkpoint —
    // there is no async boundary to observe it across.) rotation_denied and
    // rotation_failed are RE-PROPOSABLE (the rotate endpoint accepts them);
    // the denial/failure marker + reason live on the cert_rotations ledger
    // row of that attempt. Pre-O6 rows only ever held
    // active/rotation_proposed/rotated/expired — all still valid states.
    status: text("status", {
      enum: [
        "active",
        "rotation_proposed",
        "rotation_denied",
        "rotation_failed",
        "rotated",
        "expired",
      ],
    })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cert_inventory_resource_idx").on(t.resourceId),
    /** ADR-0109 (migration 0108) — the natural key `syncFindingLedger` already
     * upserts on by hand ("cert by (resource,commonName)"), now enforced. TOTAL,
     * not partial: both columns are NOT NULL, so there is no subset to exclude.
     * `patch_records` got the matching index when it was written; this one was
     * left to convention. */
    uniqueIndex("cert_inventory_resource_cn_uq").on(t.resourceId, t.commonName),
  ],
);

// O6 (ADR-0027): one row PER ROTATION ATTEMPT, created at PROPOSE time
// (status 'proposed') and advanced by the /decide hook to rotated / denied /
// failed — the durable record of every attempt, including the ones that were
// refused or blew up. `reason` carries the approver's denial reason or the
// provider's failure message. (Pre-O6, a row only ever appeared on approve.)
export const certRotations = pgTable("cert_rotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  certId: uuid("cert_id")
    .notNull()
    .references(() => certInventory.id, { onDelete: "cascade" }),
  findingId: uuid("finding_id"),
  approvalId: uuid("approval_id"),
  oldSerial: text("old_serial"),
  newSerial: text("new_serial"),
  newNotAfter: timestamp("new_not_after", { withTimezone: true }),
  status: text("status", { enum: ["proposed", "rotated", "denied", "failed"] })
    .notNull()
    .default("proposed"),
  /** O6: the approver's denial reason, or the provider's failure message */
  reason: text("reason"),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// CVE patch ledger — one row per (resource, CVE). A cve finding upserts on the
// UNIQUE(resource_id, cve); a governed patch advances status/patched_at.
export const patchRecords = pgTable(
  "patch_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id"),
    cve: text("cve").notNull(),
    package: text("package"),
    installedVersion: text("installed_version"),
    fixedVersion: text("fixed_version"),
    cvss: numeric("cvss"),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }).notNull(),
    // open | patch_proposed | patched | accepted_risk
    status: text("status", {
      enum: ["open", "patch_proposed", "patched", "accepted_risk"],
    })
      .notNull()
      .default("open"),
    patchedAt: timestamp("patched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("patch_records_resource_cve_uq").on(t.resourceId, t.cve)],
);

// Backup / restore run ledger. A backup_missed finding appends a 'missed' row;
// a governed restore appends a kind='restore' status='restored' row.
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => infraResources.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id"),
    kind: text("kind", { enum: ["backup", "restore"] }).notNull().default("backup"),
    // success | failed | missed | restore_proposed | restored
    status: text("status", {
      enum: ["success", "failed", "missed", "restore_proposed", "restored"],
    }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    /** O5 (migration 0045): who wrote this row — 'scheduler:<provider-kind>'
     * for scheduler-verified rows (the mock provider's rows are honestly
     * labelled 'scheduler:mock'); null = pre-O5 / seed / manual. */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("backup_runs_resource_idx").on(t.resourceId),
    /** ADR-0110 (migration 0109): ONE backup ledger row per finding.
     *
     * ADR-0109 REFUSED this index: `syncFindingLedger`'s idempotency read was
     * filtered to `status='missed'`, so a restore proposal (which moves the row
     * to 'restore_proposed') let a re-scan insert a SECOND row, and the deny
     * path's UPDATE of the first row back to 'missed' would then have raised
     * 23505 — blocking an operator from refusing a restore. ADR-0110 fixed the
     * writing code first: the read now keys on the finding alone and RE-OPENS
     * the row in place, so the second row is never written and the deny has
     * nothing to collide with.
     *
     * PARTIAL on `kind='backup'` because the ledger also holds the
     * `kind='restore'` row an executed restore appends, which carries the SAME
     * finding_id by design. `finding_id IS NOT NULL` is stated rather than left
     * to Postgres's NULL-distinctness rule: the scheduler's verified
     * `status='success'` rows have no finding and can never participate. */
    uniqueIndex("backup_runs_finding_uq")
      .on(t.findingId)
      .where(sql`${t.kind} = 'backup' AND ${t.findingId} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0020 — IDE / existing-agent INTERCEPTION posture (Batch H).
//
// RegulAIt governs calls that ARRIVE at it. Whether a developer's IDE sends
// its calls here is an ADMIN choice, not a product constant, so every axis of
// the interception surface is configuration rather than hardcoded behaviour:
// which provider-shaped compatibility surfaces exist at all, how an IDE's
// `model` string resolves onto a governed agent, whether attribution is
// mandatory, and which rung of the enforcement ladder the org declares it is
// on. ONE ROW, ever — the posture is deployment-wide, exactly like the
// control plane it describes. The singleton is enforced by a fixed primary
// key plus a CHECK, so a second row is a database error rather than a silent
// second policy.
//
// DEFAULT-DENY POSTURE: both compat surfaces default to FALSE. A new
// interception surface is something an admin opts INTO; until then the
// endpoints answer 404 and are indistinguishable from not existing.
// ---------------------------------------------------------------------------
export const INTERCEPTION_SETTINGS_ID = "singleton";

/** How an IDE's `model` string resolves onto a governed agent (ADR-0020). */
export const RESOLUTION_MODES = ["map_by_model", "require_agent", "router_decides"] as const;
export type ResolutionMode = (typeof RESOLUTION_MODES)[number];

/** The rung of Batch H's interception ladder the org DECLARES it is on. This
 * is descriptive, not enforcing: it drives the honest warnings the admin UI
 * shows. `observe` and `voluntary` are honor systems; `key_custody` and
 * `network` are the non-bypassable rungs, and both are customer IT policy /
 * infrastructure rather than gateway code. */
export const ENFORCEMENT_POSTURES = [
  "observe",
  "voluntary",
  "managed",
  "key_custody",
  "network",
] as const;
export type EnforcementPosture = (typeof ENFORCEMENT_POSTURES)[number];

/** ADR-0021: what a stream=true call on a block-mode PII project gets.
 * Declared before the table literal below uses it (module evaluation order). */
export const STREAMING_ON_BLOCK_MODES = ["suppress", "reject"] as const;

export const interceptionSettings = pgTable(
  "interception_settings",
  {
    id: text("id").primaryKey().default(INTERCEPTION_SETTINGS_ID),
    // OFF by default: an admin opts INTO exposing a provider-shaped surface.
    anthropicCompatEnabled: boolean("anthropic_compat_enabled").notNull().default(false),
    openaiCompatEnabled: boolean("openai_compat_enabled").notNull().default(false),
    // ON by default: POST /mcp/:serverId already ships and is already governed
    // (allow-lists, data scope, rate limits, approvals, audit, attribution).
    // Turning it OFF makes it 404 exactly like a disabled compat surface.
    mcpInterceptionEnabled: boolean("mcp_interception_enabled").notNull().default(true),
    resolutionMode: text("resolution_mode", { enum: RESOLUTION_MODES })
      .notNull()
      .default("map_by_model"),
    enforcementPosture: text("enforcement_posture", { enum: ENFORCEMENT_POSTURES })
      .notNull()
      .default("voluntary"),
    // The admin's lever to guarantee pillar-5 coverage: when true a compat
    // call with no x-regulait-project-id is REJECTED rather than run
    // unattributed.
    requireProjectAttribution: boolean("require_project_attribution").notNull().default(false),
    // ADR-0024 (O11): the MCP twin of requireProjectAttribution. FALSE
    // (default) = an unattributed MCP tool call runs, metered with a NULL
    // project (the explicit "Unattributed" bucket); TRUE = it is rejected
    // pre-dispatch with an error naming the x-regulait-project-id header.
    requireMcpAttribution: boolean("require_mcp_attribution").notNull().default(false),
    // ADR-0024 (O15): the key_custody rung as an ENFORCED mechanism, not a
    // declaration. TRUE = per-user BYO model credentials stop working —
    // creation/update is a 409 and dispatch resolution skips stored user
    // credentials entirely (org/platform only). Rows are never deleted by the
    // flip; they are inert while enforced, so it is reversible.
    keyCustodyEnforced: boolean("key_custody_enforced").notNull().default(false),
    // ADR-0021 (migration 0038): what a stream=true call on a block-mode PII
    // project gets. 'suppress' (default, today's ADR-0019 behaviour) runs the
    // same governed dispatch fully buffered and answers plain JSON with a
    // disclosure; 'reject' refuses the call with a 400 so a client that
    // REQUIRES streaming learns immediately rather than getting a shape it
    // did not ask for.
    streamingOnBlockMode: text("streaming_on_block_mode", { enum: STREAMING_ON_BLOCK_MODES })
      .notNull()
      .default("suppress"),
    // ADR-0021: when true, the COMPAT_IGNORED_FIELDS accept-and-disclose tier
    // is disabled — an unsupported-but-ignorable field (temperature) is a 400
    // again, restoring the strict pre-#47 posture for orgs that want it.
    strictFieldRejection: boolean("strict_field_rejection").notNull().default(false),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("interception_settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type InterceptionSettingsRow = typeof interceptionSettings.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0024 (migration 0041, O13) — per-role / per-project / per-user
// interception scope rules: STAGED ROLLOUT for the compat surfaces. The
// org-wide singleton above stays the base; a scope rule overrides individual
// fields for one user, one project, or one role. NULL = inherit.
//
// PRECEDENCE (documented in ADR-0024 and pinned in tests):
//   user > project > role > org singleton — first NON-NULL per field wins,
//   each FIELD resolved independently. Ties within one kind (e.g. a user
//   holding two roles with conflicting rules) resolve to the MOST RECENTLY
//   CREATED rule.
//
// SURFACE EXPOSURE IS NOT ENTITLEMENT. A rule that enables a surface for a
// role grants NOTHING: every dispatch still goes through evaluateAgent for
// the calling user, identically. A rule only decides whether the provider-
// shaped route exists for that caller; a disabled-by-resolution surface
// answers the same indistinguishable 404 as the org-level gate.
// ---------------------------------------------------------------------------
export const INTERCEPTION_SCOPE_KINDS = ["user", "project", "role"] as const;
export type InterceptionScopeKind = (typeof INTERCEPTION_SCOPE_KINDS)[number];

export const interceptionScopeRules = pgTable(
  "interception_scope_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKind: text("scope_kind", { enum: INTERCEPTION_SCOPE_KINDS }).notNull(),
    // polymorphic: a users.id / projects.id / roles.id depending on scopeKind.
    // No FK — existence is validated at the API; a dangling rule never matches.
    scopeId: uuid("scope_id").notNull(),
    // NULL on any of the three = inherit from the next precedence level down.
    anthropicCompatEnabled: boolean("anthropic_compat_enabled"),
    openaiCompatEnabled: boolean("openai_compat_enabled"),
    resolutionMode: text("resolution_mode", { enum: RESOLUTION_MODES }),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("interception_scope_rules_scope_idx").on(t.scopeKind, t.scopeId),
    check(
      "interception_scope_rules_kind",
      sql`${t.scopeKind} IN ('user', 'project', 'role')`,
    ),
  ],
);

export type InterceptionScopeRuleRow = typeof interceptionScopeRules.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0021 (migration 0038) — ORG SETTINGS: the single home for org-wide
// functional defaults. The owner's mandate: "admins must have options to
// enable/disable features whenever there is a functional or technical choice
// feasible." Every column is a choice the code previously hardcoded (a kernel
// constant, a wired-in default, an always-on technique).
//
// TWO INVARIANTS, held by construction:
// 1. BEHAVIOUR-PRESERVING DEFAULTS — every default equals the pre-0038
//    behaviour, so applying the migration is invisible until an admin acts.
// 2. THE CEILING MODEL — org settings only ever NARROW what happens below
//    them. A per-user setting can narrow further (a user's passthrough always
//    wins) but can never re-enable a technique the org turned off; a zod max
//    stays the absolute wall an org ceiling can only move DOWN from.
//
// ONE ROW ever, exactly like interception_settings: fixed primary key plus a
// CHECK, so a second row is a database error rather than a second policy.
// ---------------------------------------------------------------------------
export const ORG_SETTINGS_ID = "singleton";

export const ORG_ROUTING_MODES = ["automatic", "passthrough"] as const;
export const SEMANTIC_CACHE_POLICIES = ["off", "opt_in", "always"] as const;
export const COMPACTION_FAILURE_MODES = ["fail_open", "fail_closed"] as const;
export const SUMMARIZER_SELECTIONS = ["cheapest", "fixed_agent"] as const;
/** 'none' = no org default — an unclassified project stays unenforced (today). */
export const ORG_PII_MODES = ["none", "log", "warn", "block"] as const;
/** ADR-0025: who must have TOTP enrolled before their session leaves the
 * auth self-service surface. off = today's behaviour. */
export const MFA_REQUIREMENTS = ["off", "admins", "all"] as const;
/** ADR-0174: may people sign in with a local (email + password) account? */
export const LOCAL_SIGN_IN_MODES = ["enabled", "break_glass_only"] as const;
export type LocalSignInMode = (typeof LOCAL_SIGN_IN_MODES)[number];
export const BUDGET_ENFORCEMENTS = ["block", "warn_only"] as const;
export const APPROVAL_QUORUMS = ["all", "any"] as const;
/** ADR-0062: the org's TIGHTENING dial over the deployment-wide egress
 * posture. 'inherit' defers to the env-derived deploy mode; 'strict' raises
 * the floor. There is deliberately no value that lowers it. */
export const EGRESS_COMPILED_DEFAULT_POLICIES = ["inherit", "strict"] as const;
/** ADR-0080 amendment (migration 0098, batch B3): does an approved AI use
 * case gate dispatch? 'off' = the shipped honest limit ("approval registers
 * intent"), byte-identical. 'warn' records the refusal-shaped fact without
 * blocking. 'enforce' refuses a governed dispatch attributed to a
 * use-case-LINKED project with no approved linked use case. */
export const USE_CASE_GATE_MODES = ["off", "warn", "enforce"] as const;

export const orgSettings = pgTable(
  "org_settings",
  {
    id: text("id").primaryKey().default(ORG_SETTINGS_ID),

    // --- pillar-6 technique toggles (org-wide ceilings; all ON = today) ----
    routingEnabled: boolean("routing_enabled").notNull().default(true),
    compactionEnabled: boolean("compaction_enabled").notNull().default(true),
    promptCachingEnabled: boolean("prompt_caching_enabled").notNull().default(true),
    editVsRewriteEnabled: boolean("edit_vs_rewrite_enabled").notNull().default(true),
    filePreprocessingEnabled: boolean("file_preprocessing_enabled").notNull().default(true),
    lazyToolLoadingEnabled: boolean("lazy_tool_loading_enabled").notNull().default(true),
    /** the org DEFAULT for users with no per-user routingMode. A user's own
     * setting still wins either way (it can only narrow, and 'automatic' is
     * only reachable when the technique toggles above allow it). */
    defaultRoutingMode: text("default_routing_mode", { enum: ORG_ROUTING_MODES })
      .notNull()
      .default("automatic"),

    // --- pillar-6 numeric dials (kernel override params, finally wired) ----
    compactionThresholdTokens: integer("compaction_threshold_tokens").notNull().default(1600),
    compactionRecentWindow: integer("compaction_recent_window").notNull().default(4),
    minCacheableTokens: integer("min_cacheable_tokens").notNull().default(1024),
    cacheReadDiscount: doublePrecision("cache_read_discount").notNull().default(0.9),
    maxToolsInManifest: integer("max_tools_in_manifest").notNull().default(20),
    minEditableBaselineTokens: integer("min_editable_baseline_tokens").notNull().default(200),
    batchOverheadTokens: integer("batch_overhead_tokens").notNull().default(200),
    minPreprocessTokens: integer("min_preprocess_tokens").notNull().default(200),

    // --- semantic cache policy ---------------------------------------------
    /** off = never cache (wins over a caller's semanticCache:true); opt_in =
     * today's caller-opt-in; always = cache every eligible dispatch. */
    semanticCachePolicy: text("semantic_cache_policy", { enum: SEMANTIC_CACHE_POLICIES })
      .notNull()
      .default("opt_in"),
    semanticCacheTtlSeconds: integer("semantic_cache_ttl_seconds").notNull().default(3600),

    // --- compaction behaviour ----------------------------------------------
    compactionFailureMode: text("compaction_failure_mode", { enum: COMPACTION_FAILURE_MODES })
      .notNull()
      .default("fail_open"),
    summarizerSelection: text("summarizer_selection", { enum: SUMMARIZER_SELECTIONS })
      .notNull()
      .default("cheapest"),
    /** fixed_agent only: the agent every compaction summarization runs on. It
     * must still be in the caller's own entitled+dispatchable roster — a fixed
     * pick can never widen entitlement, only pin a choice inside it. */
    summarizerAgentId: uuid("summarizer_agent_id"),

    // --- governance / compliance behavioural defaults ----------------------
    /** effective piiMode for a project whose classifications resolve to none.
     * 'none' (default) = today's no-enforcement. */
    defaultPiiMode: text("default_pii_mode", { enum: ORG_PII_MODES }).notNull().default("none"),
    /** ADR-0117 (migration 0110) — WHICH international national-identifier
     * jurisdictions `detectPII` runs, on top of its four always-on base
     * detectors. Ships EMPTY and the migration's DEFAULT is EMPTY, so an
     * existing install upgrades into ADR-0117 detecting exactly what it
     * detected before and refusing exactly what it refused before. Widening it
     * is an explicit, audited admin act. */
    piiInternationalCategories: jsonb("pii_international_categories")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** platform-key-via-environment fallback (ANTHROPIC_API_KEY etc.). ON =
     * today; a regulated org can force every credential through the encrypted
     * store. envFallbackProviders narrows WHICH providers may fall back. */
    envKeyFallbackEnabled: boolean("env_key_fallback_enabled").notNull().default(true),
    envFallbackProviders: jsonb("env_fallback_providers")
      .$type<string[]>()
      .notNull()
      .default(["anthropic", "openai", "google", "xai"]),

    // --- budgets ------------------------------------------------------------
    budgetEnforcement: text("budget_enforcement", { enum: BUDGET_ENFORCEMENTS })
      .notNull()
      .default("block"),
    /** where the hard block engages, as % of the project budget (100 = today).
     * Distinct from the per-project alertThresholdPct, which stays the softer
     * non-blocking warning. */
    budgetHardBlockPct: integer("budget_hard_block_pct").notNull().default(100),

    // --- approvals ----------------------------------------------------------
    /** workflow human_approval stages: 'all' (default, today) = every named
     * approver must approve; 'any' = the first approval advances the stage and
     * supersedes the rest. */
    approvalQuorum: text("approval_quorum", { enum: APPROVAL_QUORUMS }).notNull().default("all"),
    /** AER-048 (migration 0130): may a KEY-authenticated caller (CI) report
     * workflow check results WITHOUT naming the round they were produced for?
     * false (default) = fail closed: such a report is refused 422
     * `round_required`. true = the pre-AER-048 behaviour — an unbound report
     * is taken for whatever round is current when it is applied. A person in
     * the console (session) may always omit it. */
    checkReportsAllowUnbound: boolean("check_reports_allow_unbound").notNull().default(false),
    /** ADR-0022: master switch for approver delegation. ON (default) = active
     * delegation windows widen the delegate's inbox and let them decide
     * on-behalf-of. OFF = a strict separation-of-duties org: creating
     * delegations is refused and existing windows stop applying immediately. */
    approvalDelegationEnabled: boolean("approval_delegation_enabled").notNull().default(true),
    /** ADR-0022 (portal defect fix): the org's default infra-remediation
     * approver. Persisted so the Infrastructure page's approver pick survives
     * reloads and admins; each propose call still names its approver
     * explicitly (this is the prefill/default, never a hidden actor). */
    infraApproverUserId: uuid("infra_approver_user_id"),

    // --- audit retention ----------------------------------------------------
    autoPruneEnabled: boolean("auto_prune_enabled").notNull().default(false),
    pruneIntervalHours: integer("prune_interval_hours").notNull().default(24),
    /** org-wide retention when NO compliance profile sets one. null (default) =
     * never prune without a profile floor. A profile floor always wins upward:
     * effective retention = max(profile floor, this) — an org default can never
     * SHORTEN what a compliance framework demands. */
    defaultAuditRetentionDays: integer("default_audit_retention_days"),
    /** A4 (migration 0044): MAX-ONLY per-deploy-mode retention overrides —
     * a map mode -> days ({} = none = today). Composition per audit row:
     * effective retention = max(global floor, override[row.deployMode]). An
     * override can only EXTEND retention for its mode's rows; one below the
     * global floor is inert (MAX keeps the floor) — retention can never
     * shorten below any applicable floor, by construction. Rows with a null
     * deployMode (unknown/not-deploy-scoped, incl. every pre-0044 row) always
     * use the global floor. */
    modeAuditRetention: jsonb("mode_audit_retention")
      .$type<Partial<Record<"hosted" | "byoc" | "air_gapped", number>>>()
      .notNull()
      .default({}),
    /** Batch B7c (ADR-0073 amendment, migration 0102) — retention window for
     * `config_canary_observations`, the shadow canary's output, which ADR-0073
     * disclosure 5 left growing monotonically. Acted on by the ADR-0064
     * `canary-observation-prune-sweep` job (off with the scheduler, like every
     * job) and the manual prune endpoint. ONLY observations are pruned, and
     * never those of a version currently in CANARY status — `config_versions`
     * themselves are the audit substrate and are NEVER pruned by anything. */
    canaryObservationRetentionDays: integer("canary_observation_retention_days")
      .notNull()
      .default(90),

    // --- O5 (migration 0045): scheduled backup verification --------------
    /** OFF (default) = today's behaviour: success ledger rows only ever come
     * from the seed or a manual write. ON = the boot scheduler verifies
     * recent recovery points per backup_target on the interval below, via the
     * existing provider scan path, and writes source-labelled ledger rows. */
    backupVerifyEnabled: boolean("backup_verify_enabled").notNull().default(false),
    backupVerifyIntervalHours: integer("backup_verify_interval_hours").notNull().default(24),

    // --- orchestration worker caps -----------------------------------------
    defaultWorkerMaxTurns: integer("default_worker_max_turns").notNull().default(6),
    maxWorkerTurns: integer("max_worker_turns").notNull().default(20),

    // --- size ceilings (each narrows BELOW its zod/schema wall) -------------
    maxAttachmentsPerDispatch: integer("max_attachments_per_dispatch").notNull().default(8),
    /** decoded bytes per attachment. 6 MiB = the shipped composer's own clamp. */
    maxAttachmentBytes: integer("max_attachment_bytes").notNull().default(6 * 1024 * 1024),
    imageTokenEstimateTokens: integer("image_token_estimate_tokens").notNull().default(1200),
    sharedContextMaxChars: integer("shared_context_max_chars").notNull().default(100_000),
    nodeOutputMaxChars: integer("node_output_max_chars").notNull().default(20_000),

    // --- ADR-0025 sign-in policy (migration 0042) --------------------------
    // Nothing here weakens the pre-0042 posture: password login only exists
    // for users who HAVE a password, and the defaults are the sane-secure
    // baseline the ADR records.
    passwordMinLength: integer("password_min_length").notNull().default(12),
    /** how many character classes (lower/upper/digit/other) a password needs */
    passwordRequireClasses: integer("password_require_classes").notNull().default(2),
    sessionLifetimeHours: integer("session_lifetime_hours").notNull().default(24),
    sessionIdleMinutes: integer("session_idle_minutes").notNull().default(120),
    mfaRequired: text("mfa_required", { enum: MFA_REQUIREMENTS }).notNull().default("off"),
    /** true = password login 403s (SSO or API-key exchange only). Refused
     * while zero ENABLED OIDC providers exist — no self-lockouts. */
    ssoOnly: boolean("sso_only").notNull().default(false),
    /** ADR-0174 (migration 0139): 'enabled' (default) = today. 'break_glass_only'
     * = password sign-in is refused for everyone except the admins listed in
     * `breakGlassUserIds` (SSO is the door; the break-glass admin is the spare
     * key). Distinct from `ssoOnly`, which refuses password login for all. */
    localSignIn: text("local_sign_in", { enum: LOCAL_SIGN_IN_MODES }).notNull().default("enabled"),
    /** ADR-0174: the designated break-glass admins (user ids). Each must be an
     * active admin with a password when break-glass mode is engaged. */
    breakGlassUserIds: jsonb("break_glass_user_ids").$type<string[]>(),
    /** failed password logins within the window before a temporary lockout */
    loginLockoutThreshold: integer("login_lockout_threshold").notNull().default(5),
    loginLockoutWindowMinutes: integer("login_lockout_window_minutes").notNull().default(15),
    loginLockoutMinutes: integer("login_lockout_minutes").notNull().default(15),
    /** ADR-0030 (migration 0047): may a user set/change/clear their OWN
     * username? false (default) = admin-managed only, the behaviour-preserving
     * conservative choice — a username is a login identifier, and every other
     * identity anchor (email, admin flag) is already admin-managed. true =
     * self-service, still uniqueness-checked and audited identically. Reading
     * one's own username is always allowed; this dial governs WRITES only. */
    usernameSelfService: boolean("username_self_service").notNull().default(false),
    /** ADR-0034 (migration 0048): the master switch for admin-registered
     * CUSTOM LLM providers. false stops every custom-provider dispatch cold
     * (409) and refuses registration/enable — the whole capability, including
     * its egress surface, off from one place. Default true: the capability is
     * already default-deny four ways below it (admin-only registration, an
     * empty egress allow-list, enabled=false until a connection test passes,
     * and the ordinary per-user agent grant), so an org that wants it gone
     * entirely flips this and an org that never registers one is unaffected. */
    customModelProvidersEnabled: boolean("custom_model_providers_enabled").notNull().default(true),
    /** ADR-0043 (migration 0049): the org default for MCP servers whose
     * allowPrivateRanges is null. TRUE (default) = a self-hosted MCP server on
     * a private address Just Works with zero ceremony — the guard fires on the
     * risky public-internet case, not the ordinary internal one (ADR-0041's
     * BYOC/air-gapped buyer). FALSE = strict: every server needs an explicit
     * per-server allowPrivateRanges=true (or an egress_allow_hosts entry with
     * the private-range opt-in) before a private-range URL is reachable.
     * Link-local/IMDS stays unconditionally blocked in BOTH postures. */
    mcpPrivateRangesDefault: boolean("mcp_private_ranges_default").notNull().default(true),
    /** ADR-0097 (migration 0103): the MCP ADMISSION posture. 'off' (DEFAULT)
     * runs no manifest scan at all and is byte-identical to pre-0103. 'log'
     * scans every sync and records the verdict/findings on the server row
     * without ever refusing. 'enforce' refuses a `held` server BEFORE any
     * upstream connect and keeps it out of tool discovery until an admin
     * clears it with a reason. Recommended production setting: 'enforce'. */
    mcpAdmissionMode: text("mcp_admission_mode", { enum: ["off", "log", "enforce"] })
      .notNull()
      .default("off"),
    /** ADR-0175 A5 (migration 0140): the release-age cooldown in days. 0
     * (DEFAULT) = off and byte-identical to pre-0140. Recommended: 7. */
    minReleaseAgeDays: integer("min_release_age_days").notNull().default(0),
    /** ADR-0175 A7 (migration 0142): a credential older than this many days
     * with no use in that many days is flagged "unused" on the inventory. */
    credentialUnusedDays: integer("credential_unused_days").notNull().default(90),
    /** ADR-0175 A7: false (DEFAULT) = the `stale_credentials` rule only shows
     * flags on the inventory page; true = it raises one alert episode per
     * flagged credential. */
    staleCredentialAlerts: boolean("stale_credential_alerts").notNull().default(false),
    /** ADR-0175 A15: the grid region whose `energy_factors` intensity
     * overrides the org default for the energy estimate. NULL = default. */
    energyRegion: text("energy_region"),
    /** ADR-0039 (migration 0050): the org network envelope — CIDR blocks
     * (IPv4 + IPv6) interactive access must come from. NULL/empty = no
     * restriction (today; upgrade locks nobody out). Malformed entries are
     * refused at write time and match NOTHING at evaluation time. */
    sessionIpAllowlist: jsonb("session_ip_allowlist").$type<string[]>(),
    /** ADR-0039: the HUMAN-session knob (origins password|oidc|saml). See
     * IP_POLICIES. Exchanged api_key sessions and bootstrap are NOT governed
     * by this — automation has its own knob below, bootstrap has none. */
    sessionIpPolicy: text("session_ip_policy", { enum: IP_POLICIES }).notNull().default("off"),
    /** ADR-0039: the SEPARATE automation knob (header API-key auth +
     * origin='api_key' sessions), same levels over the SAME allow-list — a
     * conscious second choice so tightening the human policy never silently
     * locks out CI, and neither knob can exempt the other's path. The
     * bootstrap origin is never IP-restricted. */
    apiKeyIpPolicy: text("api_key_ip_policy", { enum: IP_POLICIES }).notNull().default("off"),

    // --- ADR-0098 (migration 0104): API-KEY LIFETIME -----------------------
    /** THE DEFAULT applied to a key issued with no caller-supplied expiry.
     * NULL (DEFAULT) = no default lifetime, so a newly issued key still never
     * expires and behaviour is byte-identical to pre-0104 — ADR-0021's "a
     * fresh settings row changes nothing" invariant, held here too. A number
     * is a lifetime in DAYS from the moment of issuance.
     * Recommended production setting: 90. It is NOT flipped here, because a
     * control that starts expiring live credentials on upgrade is how a
     * security feature gets turned back off permanently (ADR-0097's reasoning
     * for `mcp_admission_mode`, applied verbatim). */
    apiKeyDefaultTtlDays: integer("api_key_default_ttl_days"),
    /** THE CEILING on what any issuer may request, in DAYS. NULL (DEFAULT) =
     * no ceiling, so an issuer may ask for any expiry or none. When set, a
     * request for a longer lifetime — INCLUDING an explicit request for no
     * expiry at all — is REFUSED BY NAME (422), never silently clamped: a
     * clamp hands back a credential with a lifetime nobody asked for and
     * nobody was told about. Recommended production setting: 365. */
    apiKeyMaxTtlDays: integer("api_key_max_ttl_days"),

    // --- ADR-0105 (migration 0107): APPROVAL LIFETIME ----------------------
    /** HOW LONG an approved-but-unspent MCP tool-call consent stays spendable,
     * in HOURS from the moment it was queued. DEFAULT 72, which is NOT the
     * ADR-0098 posture of "ship the dial off": an approval is a human decision
     * about ONE pending action, and an approved row that is still spendable
     * next month is the defect this dial exists to close — shipping it NULL
     * would leave the gap open for exactly the population that already has it.
     * That makes it a deliberate upgrade-day behaviour change, stated in
     * ADR-0105. NULL means "never expires": a legitimate operator choice,
     * recorded as one, which knowingly reopens the gap. Expiry is stamped at
     * queue time and never rewritten, so changing the dial cannot extend a
     * consent that already exists. */
    approvalTtlHours: integer("approval_ttl_hours").default(72),

    // --- ADR-0045 (migration 0057): model risk management -------------------
    /** THE DISPATCH GATE. false (default) = today's behaviour, byte-identical:
     * cards are documentation. true = `executeGovernedDispatch` refuses any
     * agent whose model has no model card carrying an UNEXPIRED approved
     * sign-off (409 `mrm_approval_required`, audited, effect deny).
     *
     * Deliberately the exact shape of `keyCustodyEnforced` above (ADR-0024):
     * one org toggle, refuse-with-a-named-reason, fully reversible — turning
     * it off restores dispatch and destroys no card data. Default-off means no
     * deployment acquires a production hard-stop by accident. */
    mrmEnforced: boolean("mrm_enforced").notNull().default(false),
    /** how many days before `valid_until` a signed-off card counts as
     * "expiring soon" — the window the registry surfaces lapses in as WORK
     * ahead of time rather than as an outage on the day. */
    mrmExpiryWarnDays: integer("mrm_expiry_warn_days").notNull().default(30),
    /** ADR-0086 §3's named follow-up (migration 0098, batch B3):
     * staleness-forces-recertification. false (default) = ADR-0086's shipped
     * posture, byte-identical — staleness informs and gates nothing. true =
     * the ADR-0045 dispatch gate (and ONLY while `mrmEnforced` is on — this
     * knob deepens the one gate, it creates no gate of its own) additionally
     * refuses a card whose ledger drift since the last granting decision has
     * reached the threshold below, on the SAME 409 path expiry uses. Fully
     * reversible; recertifying (a new superseding sign-off) resets the clock. */
    mrmStalenessRecertEnabled: boolean("mrm_staleness_recert_enabled").notNull().default(false),
    /** how many ledger changes since certification (the `computeCardStaleness`
     * counts, summed) it takes before an armed staleness gate refuses. 1 =
     * any drift at all forces recertification. */
    mrmStalenessRecertThreshold: integer("mrm_staleness_recert_threshold").notNull().default(1),

    // --- ADR-0080 amendment (migration 0098): use-case dispatch gate --------
    /** 'off' (default) = the ADR-0080 honest limit exactly as shipped:
     * approval registers intent and gates nothing — byte-identical behaviour.
     * 'warn' = a governed dispatch attributed to a use-case-LINKED project
     * with no approved linked use case proceeds, but the refusal-shaped fact
     * is audited and annotated on the response. 'enforce' = the same dispatch
     * is refused 409 `use_case_approval_required` before any provider work —
     * the ADR-0045 gate shape. The join is `ai_use_cases.project_id`, the
     * only join the schema holds: a project no use case links stays untouched
     * in every mode. */
    useCaseGateMode: text("use_case_gate_mode", { enum: USE_CASE_GATE_MODES })
      .notNull()
      .default("off"),

    // --- B6b / ADR-0080 amendment (migration 0101): the attribution mandate --
    /** FALSE (default) = today, byte-identical: a governed dispatch that names
     * no `projectId` runs and lands in the explicit "Unattributed" cost bucket
     * (GET /v1/costs/unattributed), which is pillar 5's deliberate opt-in
     * posture. TRUE = such a dispatch is refused 409 `attribution_required`,
     * audited, before any provider work.
     *
     * This is the hole B3a recorded and could not close from inside itself:
     * `use_case_gate_mode` binds only dispatches that NAME a project, so a
     * call naming none was invisible to it. The two knobs are INDEPENDENT by
     * construction — this gate acts only where projectId IS NULL, that one
     * only where it is NOT — so they never see the same dispatch and there is
     * no precedence rule.
     *
     * Distinct from `interception_settings.require_project_attribution`
     * (ADR-0020: the compat shims' own 400 at their own edge) and
     * `require_mcp_attribution` (ADR-0024 O11: the MCP proxy's). Those guard
     * surfaces this one cannot reach; this guards the NATIVE governed dispatch
     * neither of them touches. */
    dispatchAttributionRequired: boolean("dispatch_attribution_required")
      .notNull()
      .default(false),

    // --- ADR-0124: the kill switch and safe modes ------------------------
    /**
     * ONE DIAL, FOUR POSITIONS, checked before every other rule at all three
     * governed entry points. `normal` (the default, and what every existing
     * deployment upgrades into) adds nothing to any decision.
     *
     *  read_only         reads pass, writes refused
     *  require_approval  nothing runs unattended — queued on the MCP tool
     *                    path, REFUSED on dispatch/connector, which have no
     *                    per-call approval queue to hand work to
     *  halted            the kill switch: every governed call refused
     *
     * Reading the audit trail, the approvals queue and the posture page is
     * never gated by this, or the halt could not be investigated or lifted.
     */
    executionMode: text("execution_mode", {
      enum: ["normal", "read_only", "require_approval", "halted"],
    })
      .notNull()
      .default("normal"),
    /** REQUIRED by DB CHECK for any mode other than `normal` — an emergency
     * stop with no stated reason is an outage of unknown cause. */
    executionModeReason: text("execution_mode_reason"),
    executionModeSetByUserId: uuid("execution_mode_set_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    executionModeSetAt: timestamp("execution_mode_set_at", { withTimezone: true }),
    /** ADR-0124 — who signs off while `require_approval` is set. Required for
     * that mode by DB CHECK: `approvals.approver_user_id` is NOT NULL, and an
     * approval nobody is named on is one nobody is accountable for deciding. */
    executionModeApproverUserId: uuid("execution_mode_approver_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // --- L6c / ADR-0092 amendment (migration 0100): the model-judged half ---
    /** FALSE (default) = the ADR-0092 access-recommendation report is exactly
     * the six deterministic rules and nothing else, byte-identical to what
     * that ADR shipped. TRUE = each finding the rules ALREADY produced MAY
     * carry a `judged` annotation labelled `method: "model-judged"`. The
     * annotation can never create a finding, never alter a finding's
     * severity/evidence/rationale, and never reorder anything: it is a
     * sibling field on a finding the deterministic layer computed. */
    recommendationJudgeEnabled: boolean("recommendation_judge_enabled").notNull().default(false),
    /** the registry agent the judged layer dispatches through. Must be in the
     * caller's own entitled, dispatchable roster — naming one here can pin a
     * choice, never widen entitlement. NULL while enabled = `judged:
     * unavailable` with `judge_required`, never a silent no-annotation run. */
    recommendationJudgeAgentId: uuid("recommendation_judge_agent_id"),

    // --- ADR-0046 (migration 0058): review-workbench bulk fences ------------
    /** hard cap on items per bulk approve/deny/reassign. Not a UI convenience:
     * a bulk of 5,000 is indistinguishable from "approve everything". */
    approvalBulkMaxItems: integer("approval_bulk_max_items").notNull().default(25),
    /** true (default) = bulk is REFUSED on any approval attributed to a project
     * whose compliance cascade demands PII blocking. Reviewers with large
     * sensitive queues act item-by-item on the highest-risk classes; that
     * friction IS the control (ADR-0046 §4), and it is a disclosed limit. */
    approvalBulkSensitiveBlocked: boolean("approval_bulk_sensitive_blocked").notNull().default(true),

    // --- ADR-0062 (migration 0074): mode-scoped egress ----------------------
    /** THE ONE ORG DIAL OVER THE COMPILED-VENDOR-DEFAULT POSTURE, and it can
     * only TIGHTEN. The deployment-wide posture is derived from the
     * environment (`REGULAIT_DEPLOY_MODE`, ADR-0062, following the ADR-0029
     * HSTS precedent) because "is this installation air-gapped" is a
     * deployment-shape fact an admin cannot judge from a portal — and because
     * an air-gapped posture a compromised admin account can switch off from a
     * web form is not one.
     *
     * 'inherit' (default) = today's behaviour: the env-derived mode decides.
     * 'strict'            = adjudicate compiled vendor endpoints against
     *                       `egress_allow_hosts` regardless of mode, so a
     *                       hosted or BYOC box can opt in.
     *
     * Composition is MAX over {permissive < strict}: there is no value here
     * that loosens an air_gapped deployment, by construction rather than by
     * validation. */
    egressCompiledDefaultPolicy: text("egress_compiled_default_policy", {
      enum: EGRESS_COMPILED_DEFAULT_POLICIES,
    })
      .notNull()
      .default("inherit"),

    // --- ADR-0065 (migration 0077): RegulAIt-LLM ----------------------------
    /** THE MASTER SWITCH over custom-model creation, following ADR-0034's
     * `customModelProvidersEnabled` precedent: a capability an org may not want
     * at all should be refusable in ONE place, honestly, rather than by
     * removing every grant one at a time and hoping none was missed. */
    llmTrainingEnabled: boolean("llm_training_enabled").notNull().default(true),
    /** where the ONE Approvals Queue takes over. A job whose ESTIMATED cost is
     * at or above this does not start — it queues as an ordinary approval
     * (objectType 'training_job') and starts only once a named human approves.
     * 5 USD is a deliberately low default: the wrong failure mode here is a
     * surprise bill, and an org that wants unattended training raises it on
     * purpose rather than discovering it was already raised. */
    llmTrainingApprovalThresholdUsd: doublePrecision("llm_training_approval_threshold_usd")
      .notNull()
      .default(5),

    // --- ADR-0070 (migration 0082): trace observability ---------------------
    /** THE MASTER SWITCH. Defaults ON, because a governance product whose
     * trace is off by default answers "why did nothing happen" with "we did
     * not record it". Off = no trace or span row is written anywhere, and
     * every instrumented path is byte-identical to pre-0070. */
    tracingEnabled: boolean("tracing_enabled").notNull().default(true),
    /** May only ever NARROW. Off keeps the tree, the timings, the costs and
     * every deny reason, and stops storing prompts/outputs at all. */
    tracingCaptureContent: boolean("tracing_capture_content").notNull().default(true),
    /** the truncation ceiling on a stored preview — the same 4000 default
     * `eval_results.output_text` uses (ADR-0044), not a new posture */
    tracingPreviewMaxChars: integer("tracing_preview_max_chars").notNull().default(4000),
    /** ADR-0041: THERE IS NO DEFAULT ENDPOINT. Null (the shipped state) means
     * no exporter exists and no outbound connection is ever attempted. When an
     * admin types one it is adjudicated by the SAME ADR-0034/0062 egress guard
     * `mcp_servers.url` is, on every export, not merely at write time. */
    tracingOtlpEndpoint: text("tracing_otlp_endpoint"),
    /** operator-supplied export headers (e.g. an OTLP collector's auth header).
     * Values are returned REDACTED by the settings read surface. */
    /** ADR-0167 (SEC-06): since migration 0128 this holds header NAMES only
     * (every value is the `[redacted]` marker) — the values live enveloped in
     * the column below. A pre-0128 row still carrying plaintext values is
     * enveloped by the gateway's boot-time backfill. */
    tracingOtlpHeaders: jsonb("tracing_otlp_headers"),
    /** ADR-0167 (SEC-06): the collector headers as a REGULAIT_DATA_KEY
     * envelope over the JSON map — a collector API key is a credential like
     * every other admin-registered endpoint secret */
    tracingOtlpHeadersCiphertext: text("tracing_otlp_headers_ciphertext"),
    /** ADR-0175 A7 (migration 0142): when the collector headers were last set */
    tracingOtlpHeadersSetAt: timestamp("tracing_otlp_headers_set_at", { withTimezone: true }),
    tracingOtlpServiceName: text("tracing_otlp_service_name").notNull().default("regulait-gateway"),

    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("org_settings_singleton", sql`${t.id} = 'singleton'`),
    check(
      "org_settings_mrm_expiry_warn_days_check",
      sql`${t.mrmExpiryWarnDays} >= 0 AND ${t.mrmExpiryWarnDays} <= 3650`,
    ),
    check(
      "org_settings_approval_bulk_max_items_check",
      sql`${t.approvalBulkMaxItems} >= 1 AND ${t.approvalBulkMaxItems} <= 500`,
    ),
    check(
      "org_settings_use_case_gate_mode_check",
      sql`${t.useCaseGateMode} IN ('off', 'warn', 'enforce')`,
    ),
    check(
      "org_settings_mrm_staleness_recert_threshold_check",
      sql`${t.mrmStalenessRecertThreshold} >= 1 AND ${t.mrmStalenessRecertThreshold} <= 100000`,
    ),
    // ADR-0098: both API-key TTL dials are optional (NULL = the shipped
    // never-expires posture) and bounded to a decade when present.
    check(
      "org_settings_api_key_default_ttl_days_check",
      sql`${t.apiKeyDefaultTtlDays} IS NULL OR (${t.apiKeyDefaultTtlDays} >= 1 AND ${t.apiKeyDefaultTtlDays} <= 3650)`,
    ),
    check(
      "org_settings_api_key_max_ttl_days_check",
      sql`${t.apiKeyMaxTtlDays} IS NULL OR (${t.apiKeyMaxTtlDays} >= 1 AND ${t.apiKeyMaxTtlDays} <= 3650)`,
    ),
    // A default longer than the ceiling would make every no-argument issuance
    // refuse itself. The database refuses the incoherent pair outright.
    // ADR-0105: optional (NULL = never expires) and bounded to a year when set.
    check(
      "org_settings_approval_ttl_hours_check",
      sql`${t.approvalTtlHours} IS NULL OR (${t.approvalTtlHours} >= 1 AND ${t.approvalTtlHours} <= 8760)`,
    ),
    check(
      "org_settings_api_key_ttl_ordering_check",
      sql`${t.apiKeyDefaultTtlDays} IS NULL OR ${t.apiKeyMaxTtlDays} IS NULL OR ${t.apiKeyDefaultTtlDays} <= ${t.apiKeyMaxTtlDays}`,
    ),
  ],
);

export type OrgSettingsRow = typeof orgSettings.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0173 §3 (migration 0138) — the model allow-list matrix
// ---------------------------------------------------------------------------
//
// One row per (feature, data class). No rows = every entitled binding is
// allowed everywhere. Enforced in the shared model-access decision
// (copilot.ts `agentDecision` and the helper it calls, model-policy.ts).
export const MODEL_POLICY_FEATURE_VALUES = [
  "chat",
  "builder",
  "copilot",
  "intake_assist",
  "evals",
  "orchestration",
  "compat",
  // ADR-0173 batch 2b (migration 0143): the prompt playground
  "playground",
] as const;
export const MODEL_POLICY_DATA_CLASS_VALUES = ["public", "internal", "confidential", "regulated"] as const;

export const modelPolicyRules = pgTable(
  "model_policy_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feature: text("feature", { enum: MODEL_POLICY_FEATURE_VALUES }).notNull(),
    /** NULL = the feature's base rule */
    dataClass: text("data_class", { enum: MODEL_POLICY_DATA_CLASS_VALUES }),
    /** false = the row only carries a default; every entitled binding is allowed */
    restricted: boolean("restricted").notNull().default(true),
    allowedAgentIds: jsonb("allowed_agent_ids").$type<string[]>().notNull().default([]),
    allowedProviders: jsonb("allowed_providers").$type<string[]>().notNull().default([]),
    defaultAgentId: uuid("default_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_policy_rules_feature_class_uq").on(t.feature, sql`COALESCE(${t.dataClass}, '')`)],
);
export type ModelPolicyRuleRow = typeof modelPolicyRules.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0173 batch 2b (migration 0143) — the governed prompt registry and
// outbound webhooks
// ---------------------------------------------------------------------------
//
// A prompt is an identity (name, owner, visibility, project); its content is
// IMMUTABLE commits addressed by a hash over {template, model config,
// variables, output schema, tools, parent}; tags are movable names pointing
// at commits. Moving `prod` is an approvals-queue decision: a promotion row
// pins the (prompt, tag, commit hash) digest, and the tag moves only in the
// decide hook, only if that binding still holds.
export const PROMPT_VISIBILITY = ["private", "workspace", "people"] as const;
export const PROMPT_PROMOTION_STATUSES = ["pending_approval", "applied", "denied", "stale"] as const;

export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    visibility: text("visibility", { enum: PROMPT_VISIBILITY }).notNull().default("private"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("prompts_owner_idx").on(t.ownerUserId),
    uniqueIndex("prompts_name_live_uq").on(sql`lower(${t.name})`).where(sql`${t.archivedAt} IS NULL`),
    check("prompts_visibility_ck", sql`${t.visibility} IN ('private', 'workspace', 'people')`),
  ],
);
export type PromptRow = typeof prompts.$inferSelect;

export const promptShares = pgTable(
  "prompt_shares",
  {
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.userId] }), index("prompt_shares_user_idx").on(t.userId)],
);

export const promptCommits = pgTable(
  "prompt_commits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    /** sha256 hex of the canonical content + parent (shared `promptCommitHash`) */
    hash: text("hash").notNull(),
    parentHash: text("parent_hash"),
    template: text("template").notNull(),
    modelConfig: jsonb("model_config").$type<{ agentId: string | null; maxTokens: number | null }>().notNull(),
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown> | null>(),
    tools: jsonb("tools")
      .$type<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>()
      .notNull()
      .default([]),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_commits_prompt_hash_uq").on(t.promptId, t.hash),
    index("prompt_commits_prompt_created_idx").on(t.promptId, t.createdAt),
    check("prompt_commits_hash_ck", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);
export type PromptCommitRow = typeof promptCommits.$inferSelect;

export const promptTags = pgTable(
  "prompt_tags",
  {
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    commitId: uuid("commit_id")
      .notNull()
      .references(() => promptCommits.id, { onDelete: "cascade" }),
    movedByUserId: uuid("moved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    movedAt: timestamp("moved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.promptId, t.name] }),
    check("prompt_tags_name_ck", sql`${t.name} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
  ],
);
export type PromptTagRow = typeof promptTags.$inferSelect;

export const promptPromotions = pgTable(
  "prompt_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    commitId: uuid("commit_id")
      .notNull()
      .references(() => promptCommits.id, { onDelete: "cascade" }),
    commitHash: text("commit_hash").notNull(),
    /** the commit the tag pointed at when this was requested (null = the tag was new) */
    previousCommitHash: text("previous_commit_hash"),
    /** shared `promptPromotionDigest({promptId, tag, commitHash})` — the approval's binding */
    bindingDigest: text("binding_digest").notNull(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    approverUserId: uuid("approver_user_id").notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    status: text("status", { enum: PROMPT_PROMOTION_STATUSES }).notNull().default("pending_approval"),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_promotions_one_pending_uq")
      .on(t.promptId, t.tag)
      .where(sql`${t.status} = 'pending_approval'`),
    index("prompt_promotions_approval_idx").on(t.approvalId),
    check(
      "prompt_promotions_status_ck",
      sql`${t.status} IN ('pending_approval', 'applied', 'denied', 'stale')`,
    ),
  ],
);
export type PromptPromotionRow = typeof promptPromotions.$inferSelect;

/** admin-managed outbound webhook subscriptions; the secret is a data-key envelope */
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  url: text("url").notNull(),
  /** registered event names or `<family>.*` selectors */
  events: jsonb("events").$type<string[]>().notNull().default([]),
  /** the Standard Webhooks `whsec_` signing secret, encrypted with REGULAIT_DATA_KEY */
  secretCiphertext: text("secret_ciphertext").notNull(),
  active: boolean("active").notNull().default(true),
  allowPlaintextHttp: boolean("allow_plaintext_http").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;

export const WEBHOOK_DELIVERY_STATUS_VALUES = ["pending", "delivered", "failed"] as const;

/** one event to one subscription; retried on the scheduler sweep until delivered or out of attempts */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** the Standard Webhooks `webhook-id`: one per event, the same on every retry */
    messageId: text("message_id").notNull(),
    /** ids, names, hashes, actor ids and timestamps only (shared `webhookPayloadFor`) */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: WEBHOOK_DELIVERY_STATUS_VALUES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    responseCode: integer("response_code"),
    lastError: text("last_error"),
    /** a claim lease so a manual sweep racing the scheduler sends once */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_due_idx").on(t.status, t.nextRetryAt),
    index("webhook_deliveries_subscription_idx").on(t.subscriptionId, t.createdAt),
    check("webhook_deliveries_status_ck", sql`${t.status} IN ('pending', 'delivered', 'failed')`),
    check("webhook_deliveries_attempts_ck", sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`),
  ],
);
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0040 (migration 0054) — ABAC / policy-as-code
// ---------------------------------------------------------------------------
//
// Attribute-conditional policy, written in Cedar, evaluated in-process INSIDE
// the policy kernel's allow path. Two tables, deliberately:
//
//   `abacPolicies`         the stable IDENTITY (name, in-the-active-set flag,
//                          pointer at the live version). Its id is what lands
//                          in a decision's `ruleId`, in the `abac-forbid`
//                          rule-chain entry and in `approvals.ruleId`, so it
//                          survives every edit.
//   `abacPolicyVersions`   IMMUTABLE. Editing a policy INSERTs version max+1;
//                          activation UPDATEs the pointer; ROLLBACK is that
//                          same update aimed at an older row, so history is
//                          never lost and a rollback is itself revertible.
//
// ABAC CAN ONLY SUBTRACT: `mode` admits 'forbid' and 'require_approval' only,
// there is no column that could widen entitlement, and the engine wrapper
// refuses a Cedar `permit` at write time. Empty tables = pre-ADR-0040
// behaviour exactly.

/** what a matching ABAC policy does to a call the RBAC layer already allowed */
export const ABAC_POLICY_MODES = ["forbid", "require_approval"] as const;

/** Shared-lockable policy generation for exact-action approval consumption. */
export const governancePolicyEpoch = pgTable("governance_policy_epoch", {
  id: boolean("id").primaryKey().default(true),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
});

export const abacPolicies = pgTable(
  "abac_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    description: text("description"),
    /** in the active set? FALSE for every newly created policy — activating is
     * a deliberate, audited act, never a side effect of authoring. */
    enabled: boolean("enabled").notNull().default(false),
    /** which immutable version is live. NULL = nothing activated yet. */
    activeVersionId: uuid("active_version_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("abac_policies_enabled_idx").on(t.enabled)],
);

export const abacPolicyVersions = pgTable(
  "abac_policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => abacPolicies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** the Cedar source, exactly as authored — this column IS the artifact */
    source: text("source").notNull(),
    /** the attribute-schema version it was validated against at write time */
    schemaVersion: text("schema_version").notNull(),
    mode: text("mode", { enum: ABAC_POLICY_MODES }).notNull(),
    /** IANA zone the policy's time-of-day attributes are computed in — never
     * the server's incidental locale, never a client clock */
    timezone: text("timezone").notNull().default("UTC"),
    /** required when mode='require_approval' (DB CHECK): the Approvals-Queue
     * approver a paused call routes to — the SAME queue, not a parallel one */
    approverUserId: uuid("approver_user_id").references(() => users.id, { onDelete: "set null" }),
    /** policy unit tests travelling WITH the version they describe */
    testCases: jsonb("test_cases").$type<AbacPolicyTestCase[]>(),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("abac_policy_versions_policy_version_uq").on(t.policyId, t.version),
    index("abac_policy_versions_policy_idx").on(t.policyId, t.version),
    check("abac_policy_versions_mode_check", sql`${t.mode} IN ('forbid','require_approval')`),
    check(
      "abac_policy_versions_approver_check",
      sql`${t.mode} <> 'require_approval' OR ${t.approverUserId} IS NOT NULL`,
    ),
  ],
);

/** one stored policy unit test: a hypothetical request + the expected verdict */
export interface AbacPolicyTestCase {
  name: string;
  /** ISO instant the case is evaluated at — pins time-of-day cases */
  at?: string | null;
  principal: {
    id?: string | null;
    roles?: string[];
    roleIds?: string[];
    teams?: string[];
    isAdmin?: boolean;
    sessionOrigin?: string;
    mfaCompleted?: boolean;
  };
  resource: {
    serverId?: string | null;
    serverName?: string | null;
    toolName: string;
    kind: "read" | "write";
    priceTier?: string;
    projectId?: string | null;
    projectName?: string | null;
    classifications?: string[];
    dataSensitivity?: string | null;
  };
  context?: {
    deployModes?: string[];
    environments?: string[];
    rateLimitUsagePct?: number;
    /** schema v2 — a literal client address to evaluate this case at. Stored
     *  data, not enforcement input: the simulation surface executes nothing. */
    clientIp?: string | null;
  };
  /** 'match' = this policy is expected to fire; 'no_match' = it must not */
  expect: "match" | "no_match";
}

export type AbacPolicyRow = typeof abacPolicies.$inferSelect;
export type AbacPolicyVersionRow = typeof abacPolicyVersions.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0042 (migration 0055) — the guardrail engine's configuration
// ---------------------------------------------------------------------------
//
// One row per SCOPE. `scope='org'` (scope_id NULL, at most one row by partial
// unique index) is the deployment-wide default; `scope='agent'|'connector'`
// rows override it for one registry object. Effective mode per detector is
//
//     MAX-of-strictness( compliance-cascade floor , override ?? org default )
//
// which is the single rule that makes the §8.3 cascade a CEILING rather than a
// peer: a framework can raise a layer to `block`, and no local row can lower
// it, because MAX has no way to lower anything.
//
// There is deliberately NO guardrail_violations table. Every guardrail
// decision — block, warn AND log — lands in the one `auditLog`, so "what did
// this deployment's guardrails do" is answered by the same query that answers
// every other governance question.
export const guardrailConfigs = pgTable(
  "guardrail_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope", { enum: ["org", "agent", "connector"] }).notNull(),
    /** NULL iff scope='org' (DB CHECK) — the org default has no target */
    scopeId: uuid("scope_id"),
    // The four ADR-0042 layers. PII is absent on purpose: it stays governed by
    // the §8.3 cascade's own piiMode, byte-for-byte as ADR-0019 left it.
    promptInjectionMode: text("prompt_injection_mode", { enum: GUARDRAIL_MODES })
      .notNull()
      .default("log"),
    jailbreakMode: text("jailbreak_mode", { enum: GUARDRAIL_MODES }).notNull().default("log"),
    toxicityMode: text("toxicity_mode", { enum: GUARDRAIL_MODES }).notNull().default("log"),
    semanticDlpMode: text("semantic_dlp_mode", { enum: GUARDRAIL_MODES }).notNull().default("log"),
    /** the org's own vocabulary per detector; additive across scopes */
    customTerms: jsonb("custom_terms").$type<GuardrailTermMap>().notNull().default({}),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("guardrail_configs_scope_check", sql`${t.scope} IN ('org','agent','connector')`),
    check(
      "guardrail_configs_scope_id_check",
      sql`(${t.scope} = 'org') = (${t.scopeId} IS NULL)`,
    ),
    check(
      "guardrail_configs_prompt_injection_check",
      sql`${t.promptInjectionMode} IN ('off','log','warn','block')`,
    ),
    check("guardrail_configs_jailbreak_check", sql`${t.jailbreakMode} IN ('off','log','warn','block')`),
    check("guardrail_configs_toxicity_check", sql`${t.toxicityMode} IN ('off','log','warn','block')`),
    check(
      "guardrail_configs_semantic_dlp_check",
      sql`${t.semanticDlpMode} IN ('off','log','warn','block')`,
    ),
  ],
);

export type GuardrailConfigRow = typeof guardrailConfigs.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0044 (migration 0056) — THE AGENT EVALUATION & REGRESSION HARNESS.
//
// The existing gates prove a dispatch was governed, metered and audited. None
// of them can say whether a prompt edit, a routing-tier drop or a swapped
// custom-provider endpoint made the agent WORSE. These four tables are the
// durable record that answers that: a pinned dataset version, a run against a
// snapshotted agent config, a scored result per case, and the stored
// comparison against a baseline run — which IS the regression signal.
// ---------------------------------------------------------------------------

/** the scorer kinds; kept in lockstep with @regulait/shared's EVAL_SCORER_KINDS
 * (this package deliberately has no dependency on that one — see the note on
 * GUARDRAIL_DETECTOR_IDS above) */
export const EVAL_SCORER_KINDS = [
  "exact",
  "contains",
  "regex",
  "json_schema",
  "numeric",
  "rubric",
  "llm_as_judge",
  // ADR-0067 (migration 0079) — groundedness. Four locally computable, two
  // model-backed and refusing rather than degrading.
  "claim_support",
  "context_precision",
  "context_recall",
  "answer_relevance",
  "groundedness_judge",
  "answer_relevance_judge",
] as const;
export type EvalScorerKindDb = (typeof EVAL_SCORER_KINDS)[number];

/** The literal list the three CHECK constraints below carry. Written once so a
 * kind added to the array above cannot be forgotten in one constraint and
 * remembered in another. */
const EVAL_SCORER_KINDS_SQL = sql.raw(
  EVAL_SCORER_KINDS.map((k) => `'${k}'`).join(","),
);

/**
 * ADR-0072 (migration 0083) — the scoring-semantics version stamped on every
 * new `eval_runs` / `redteam_runs` row. Declared here rather than imported from
 * @regulait/shared for the same reason GUARDRAIL_DETECTOR_IDS is; the gateway
 * imports both and asserts they are equal, so a divergence fails a test rather
 * than shipping.
 */
export const SCORING_SEMANTICS_VERSION = 2;

export const EVAL_RUN_TRIGGERS = ["manual", "workflow", "scheduled"] as const;
export const EVAL_RUN_STATUSES = ["running", "completed", "error", "denied"] as const;

/** ONE ROW PER (name, version). A version is frozen the moment a run references
 * it; editing cases mints N+1 instead of mutating N, which is what makes a red
 * gate un-arguable. */
export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    note: text("note"),
    /** dataset-level DEFAULT scorer; a case may override both */
    scorerKind: text("scorer_kind", { enum: EVAL_SCORER_KINDS }).notNull().default("contains"),
    scorerConfig: jsonb("scorer_config").$type<Record<string, unknown>>().notNull().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("eval_datasets_version_check", sql`${t.version} >= 1`),
    check(
      "eval_datasets_scorer_kind_check",
      sql`${t.scorerKind} IN (${EVAL_SCORER_KINDS_SQL})`,
    ),
    uniqueIndex("eval_datasets_name_version_uq").on(t.name, t.version),
    unique("eval_datasets_id_version_uq").on(t.id, t.version),
  ],
);

export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id").notNull(),
    /** kept honest by the composite FK below, never by convention */
    datasetVersion: integer("dataset_version").notNull(),
    input: text("input").notNull(),
    /** string | number | object | array; NULL for reference-free scorers */
    expected: jsonb("expected"),
    rubric: jsonb("rubric"),
    /**
     * ADR-0067 (migration 0079) — THE RETRIEVED/REFERENCE CONTEXT. One entry per
     * chunk; chunk boundaries are load-bearing, because a claim supported only
     * by stitching two chunks together is exactly the fabrication mode a
     * groundedness metric exists to catch, and a single blob would score it as
     * supported.
     *
     * STORAGE POSTURE: this is authored content, stored beside `input` and
     * `expected` under the same authority — it is not a new data class. When it
     * rides the prompt (the default) it passes through the SAME §8.4 PII
     * classifier and ADR-0042 guardrails as any other dispatch input. It is
     * NEVER a way to smuggle content past those gates.
     */
    context: jsonb("context").$type<string[]>().notNull().default([]),
    /** true = the context is prepended to the prompt, so the metric measures
     * the model against material it actually saw. false = held back and used
     * for scoring only. Two different questions; this flag records which was
     * asked. */
    contextInPrompt: boolean("context_in_prompt").notNull().default(true),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** NULL = inherit the dataset's default scorer */
    scorerKind: text("scorer_kind", { enum: EVAL_SCORER_KINDS }),
    scorerConfig: jsonb("scorer_config").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "eval_cases_scorer_kind_check",
      sql`${t.scorerKind} IS NULL OR ${t.scorerKind} IN (${EVAL_SCORER_KINDS_SQL})`,
    ),
    foreignKey({
      name: "eval_cases_dataset_version_fk",
      columns: [t.datasetId, t.datasetVersion],
      foreignColumns: [evalDatasets.id, evalDatasets.version],
    }).onDelete("cascade"),
    index("eval_cases_dataset_idx").on(t.datasetId, t.datasetVersion),
  ],
);

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id").notNull(),
    datasetVersion: integer("dataset_version").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    customProviderId: uuid("custom_provider_id").references(() => customModelProviders.id, {
      onDelete: "set null",
    }),
    /** the SNAPSHOT of what was measured — the four ADR-0044 levers, so
     * "B regressed against A" sits next to "and here is what differed" */
    agentName: text("agent_name").notNull(),
    model: text("model"),
    tier: integer("tier"),
    /** a hash, not the text: the prompt itself is a governance artifact that
     * lives in `agents` and must not acquire a drifting second copy */
    systemPromptHash: text("system_prompt_hash"),
    /** ADR-0044 §6: the judge is pinned on the run */
    judgeAgentId: uuid("judge_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** which judge IMPLEMENTATION scored it — a model-backed judge, or a
     * deterministic stand-in. Recorded so a score can never be mistaken for a
     * model's opinion when no model produced it. */
    judgeImpl: text("judge_impl"),
    trigger: text("trigger", { enum: EVAL_RUN_TRIGGERS }).notNull(),
    status: text("status", { enum: EVAL_RUN_STATUSES }).notNull().default("running"),
    mode: text("mode").notNull().default("execute"),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, {
      onDelete: "set null",
    }),
    workflowStageId: text("workflow_stage_id"),
    workflowCheckName: text("workflow_check_name"),
    tolerance: doublePrecision("tolerance").notNull().default(0.05),
    minScore: doublePrecision("min_score"),
    minPassRate: doublePrecision("min_pass_rate"),
    cases: integer("cases").notNull().default(0),
    passedCases: integer("passed_cases").notNull().default(0),
    meanScore: doublePrecision("mean_score"),
    passRate: doublePrecision("pass_rate"),
    /** roll-up of the metered usage_events rows this run produced — display
     * only; `usage_events` remains the one ledger */
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** the STORED comparison, so a verdict stays reconstructible after the
     * baseline moves */
    baselineRunId: uuid("baseline_run_id"),
    scoreDelta: doublePrecision("score_delta"),
    passRateDelta: doublePrecision("pass_rate_delta"),
    gatePassed: boolean("gate_passed"),
    regression: boolean("regression"),
    gateReason: text("gate_reason"),
    isBaseline: boolean("is_baseline").notNull().default(false),
    /**
     * ADR-0072 — WHICH SCORING SEMANTICS PRODUCED THIS ROW.
     *
     * ADR-0072 changed the MEANING of two stored numbers without changing their
     * shape. Migration 0083 stamps every pre-existing row `1` and leaves it
     * otherwise untouched — history is MARKED, never rewritten and never
     * deleted. Baseline resolution and both gates refuse to compare across
     * versions, so a run scored before the correction can never be silently
     * subtracted from one scored after it.
     */
    scoringSemantics: integer("scoring_semantics")
      .notNull()
      .default(SCORING_SEMANTICS_VERSION),
    error: text("error"),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("eval_runs_trigger_check", sql`${t.trigger} IN ('manual','workflow','scheduled')`),
    check("eval_runs_scoring_semantics_check", sql`${t.scoringSemantics} >= 1`),
    check("eval_runs_status_check", sql`${t.status} IN ('running','completed','error','denied')`),
    check("eval_runs_tolerance_check", sql`${t.tolerance} >= 0 AND ${t.tolerance} <= 1`),
    foreignKey({
      name: "eval_runs_dataset_version_fk",
      columns: [t.datasetId, t.datasetVersion],
      foreignColumns: [evalDatasets.id, evalDatasets.version],
    }).onDelete("restrict"),
    foreignKey({
      name: "eval_runs_baseline_run_id_fk",
      columns: [t.baselineRunId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    index("eval_runs_dataset_idx").on(t.datasetId, t.datasetVersion, t.startedAt),
    index("eval_runs_agent_idx").on(t.agentId, t.startedAt),
    /** at most ONE pinned baseline per (dataset version, agent) — two would
     * make "the" comparison ambiguous */
    uniqueIndex("eval_runs_baseline_uq")
      .on(t.datasetId, t.datasetVersion, t.agentId)
      .where(sql`${t.isBaseline}`),
  ],
);

export const evalResults = pgTable(
  "eval_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").references(() => evalCases.id, { onDelete: "set null" }),
    scorerKind: text("scorer_kind", { enum: EVAL_SCORER_KINDS }).notNull(),
    score: doublePrecision("score").notNull(),
    passed: boolean("passed").notNull(),
    latencyMs: integer("latency_ms"),
    costUsd: doublePrecision("cost_usd"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** TRUNCATED, and carrying the withheld marker instead of the content when
     * a PII/guardrail block acted — the eval path is not a storage bypass */
    outputText: text("output_text"),
    judgeRationale: text("judge_rationale"),
    /** why the DISPATCH failed — distinct from "the answer scored badly" */
    error: text("error"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("eval_results_score_check", sql`${t.score} >= 0 AND ${t.score} <= 1`),
    uniqueIndex("eval_results_run_case_uq").on(t.runId, t.caseId),
  ],
);

export type EvalDatasetRow = typeof evalDatasets.$inferSelect;
export type EvalCaseRow = typeof evalCases.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type EvalResultRow = typeof evalResults.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0045 (migration 0057) — THE MODEL RISK MANAGEMENT REGISTRY.
//
// The `agents` / `customModelProviders` registries say how to REACH a model and
// who may INVOKE it. They say nothing about whether a human has REVIEWED AND
// ACCEPTED THE RISK of using it for a stated purpose — the question NIST AI RMF,
// ISO/IEC 42001 and the EU AI Act's high-risk documentation duties put at the
// centre. These three tables are that missing state, and (with
// `org_settings.mrmEnforced`) the gate that makes it enforceable rather than
// documentation theatre.
//
// WHAT THIS IS NOT: a bias-testing engine. `biasFairness` is a structured SLOT
// (ADR-0045 §2) — the place an assessment is recorded and its ABSENCE is
// visible. The platform requires and records an assessment; it does not perform
// one, and no field here should ever be read as if it did.
// ---------------------------------------------------------------------------

export const MODEL_CARD_APPROVAL_STATUSES = [
  "draft",
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
  "superseded",
] as const;
export type ModelCardApprovalStatus = (typeof MODEL_CARD_APPROVAL_STATUSES)[number];

export const MODEL_CARD_EVIDENCE_KINDS = ["eval_run", "external"] as const;
export type ModelCardEvidenceKind = (typeof MODEL_CARD_EVIDENCE_KINDS)[number];

/** ADR-0045 §2: one declared bias/fairness assessment SLOT on a card. */
export interface BiasFairnessEntry {
  /** what was assessed (e.g. "gender", "dialect", "age-bracket refusal rate") */
  dimension: string;
  /** how (e.g. "counterfactual prompt set", "vendor model card §4") */
  method: string;
  /** an `eval_runs` id, a URL, or a document reference — free-form on purpose:
   * the platform records where the evidence lives, it does not fetch it */
  resultRef?: string | null;
  status: "not_assessed" | "in_progress" | "assessed" | "waived";
  assessedAt?: string | null;
  assessedBy?: string | null;
  note?: string | null;
}

/** ONE RISK POSITION on ONE (model, purpose). A second intended use is a second
 * card — never an edit of this one, because the two decisions can differ. */
export const modelCards = pgTable(
  "model_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** EXACTLY ONE of agentId / customProviderId is set (DB CHECK) — the
     * discriminated-union discipline ADR-0034 established */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    customProviderId: uuid("custom_provider_id").references(() => customModelProviders.id, {
      onDelete: "cascade",
    }),
    intendedUse: text("intended_use").notNull(),
    /** provenance / training-data / retention claims AS THE PROVIDER STATES
     * THEM — recorded as claims, never as our verification of them */
    dataClaims: jsonb("data_claims").$type<Record<string, unknown>>().notNull().default({}),
    limitations: text("limitations"),
    /** ADR-0045 §2 — a SLOT, not an engine. An empty list is a visibly
     * incomplete card, which is the point. */
    biasFairness: jsonb("bias_fairness").$type<BiasFairnessEntry[]>().notNull().default([]),
    /** e.g. ['nist-ai-rmf:MEASURE-2.11','iso-42001:8.3']. A MAPPING an auditor
     * can follow — never a claim that anything is CERTIFIED. */
    standardRefs: jsonb("standard_refs").$type<string[]>().notNull().default([]),
    note: text("note"),
    /** ADR-0175 A4 (migration 0141) — OPTIONAL exact model version this card's
     * risk position was taken on (e.g. a dated snapshot id). NULL = the card
     * covers the agent's configured model id under the version-suffix
     * matching rule. When set, ANY served model that is not exactly this id
     * raises `served_model_drift` at high severity. */
    pinnedModelVersion: text("pinned_model_version"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "model_cards_subject_check",
      sql`(${t.agentId} IS NOT NULL AND ${t.customProviderId} IS NULL) OR (${t.agentId} IS NULL AND ${t.customProviderId} IS NOT NULL)`,
    ),
    check("model_cards_intended_use_check", sql`length(btrim(${t.intendedUse})) > 0`),
    uniqueIndex("model_cards_agent_use_uq")
      .on(t.agentId, t.intendedUse)
      .where(sql`${t.agentId} IS NOT NULL`),
    uniqueIndex("model_cards_provider_use_uq")
      .on(t.customProviderId, t.intendedUse)
      .where(sql`${t.customProviderId} IS NOT NULL`),
    index("model_cards_agent_idx").on(t.agentId),
    index("model_cards_provider_idx").on(t.customProviderId),
  ],
);

/** THE CHAIN. A recertification is a NEW row pointing at the one it supersedes;
 * nothing here is edited in place, so "who accepted what risk, when, and until
 * when" is durable history rather than a last-writer-wins column. */
export const modelCardApprovals = pgTable(
  "model_card_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => modelCards.id, { onDelete: "cascade" }),
    status: text("status", { enum: MODEL_CARD_APPROVAL_STATUSES }).notNull().default("pending"),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedByUserId: uuid("requested_by_user_id"),
    /** THE LINK TO THE ONE QUEUE (ADR-0045 §3): the `approvals` row this
     * sign-off request rides. MRM does not get a second inbox. */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    /** the recertification date — the field the DISPATCH GATE evaluates
     * against `now()`. `status` is a swept cache of that comparison; the gate
     * never trusts it alone. */
    validUntil: timestamp("valid_until", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "model_card_approvals_status_check",
      sql`${t.status} IN ('draft','pending','approved','denied','expired','revoked','superseded')`,
    ),
    foreignKey({
      name: "model_card_approvals_supersedes_id_fk",
      columns: [t.supersedesId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    index("model_card_approvals_card_idx").on(t.cardId, t.requestedAt),
    index("model_card_approvals_status_idx").on(t.status, t.validUntil),
    /** at most ONE live sign-off request per card — two concurrent requests
     * would let two humans accept two different risk positions on one purpose */
    uniqueIndex("model_card_approvals_one_pending_uq")
      .on(t.cardId)
      .where(sql`${t.status} = 'pending'`),
    /** ADR-0109 (migration 0108): ONE queue row decides ONE sign-off request.
     * `applyModelCardApprovalDecision` reads this table by `approval_id` and
     * acts on the result; a second match would be one human decision executing
     * against a record they were not shown. Partial because NULL is normal — a
     * card can exist before anyone requests sign-off. */
    uniqueIndex("model_card_approvals_approval_uq")
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
  ],
);

/** ADR-0045 §5: the measured evidence behind a risk decision. An `eval_runs`
 * reference is ON DELETE RESTRICT — a run cited as evidence cannot be deleted
 * out from under the sign-off that rests on it. */
export const modelCardEvidence = pgTable(
  "model_card_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => modelCards.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: MODEL_CARD_EVIDENCE_KINDS }).notNull(),
    evalRunId: uuid("eval_run_id").references(() => evalRuns.id, { onDelete: "restrict" }),
    externalRef: text("external_ref"),
    label: text("label"),
    note: text("note"),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, { onDelete: "set null" }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("model_card_evidence_kind_check", sql`${t.kind} IN ('eval_run','external')`),
    check(
      "model_card_evidence_shape_check",
      sql`(${t.kind} = 'eval_run' AND ${t.evalRunId} IS NOT NULL AND ${t.externalRef} IS NULL) OR (${t.kind} = 'external' AND ${t.externalRef} IS NOT NULL AND ${t.evalRunId} IS NULL)`,
    ),
    index("model_card_evidence_card_idx").on(t.cardId),
    uniqueIndex("model_card_evidence_run_uq")
      .on(t.cardId, t.evalRunId)
      .where(sql`${t.evalRunId} IS NOT NULL`),
  ],
);

export type ModelCardRow = typeof modelCards.$inferSelect;
export type ModelCardApprovalRow = typeof modelCardApprovals.$inferSelect;
export type ModelCardEvidenceRow = typeof modelCardEvidence.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0046 (migration 0058) — THE REVIEW WORKBENCH.
//
// An ADDITIVE LAYER over the one `approvals` table, never a second store. The
// `approvals` row keeps its NOT NULL `approverUserId` (ADR-0022's approver
// visibility and ADR-0027's quorum both read it) and gains no columns; these
// three tables describe WHERE it shows up, WHEN it is late, and WHO to widen it
// to when it goes stale.
//
// An approval with no matching rule keeps exactly its current single-approver
// behaviour, byte for byte — the rules table ships empty.
// ---------------------------------------------------------------------------

export const APPROVAL_ASSIGNEE_KINDS = ["user", "role", "team"] as const;
export type ApprovalAssigneeKind = (typeof APPROVAL_ASSIGNEE_KINDS)[number];

/** DELIBERATELY DOES NOT ADMIT auto-approve or auto-deny. A governance queue
 * that clears itself by timeout is a bypass (ADR-0023/0027). The absence is a
 * DB CHECK, not a convention. */
export const APPROVAL_ESCALATE_ACTIONS = ["add_assignee", "reassign", "notify_only"] as const;
export type ApprovalEscalateAction = (typeof APPROVAL_ESCALATE_ACTIONS)[number];

export const APPROVAL_SLA_STATES = ["ok", "warning", "breached"] as const;
export type ApprovalSlaState = (typeof APPROVAL_SLA_STATES)[number];

export const approvalSlaPolicies = pgTable(
  "approval_sla_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** minutes from `approvals.requestedAt` */
    warnAfterMinutes: integer("warn_after_minutes").notNull(),
    breachAfterMinutes: integer("breach_after_minutes").notNull(),
    escalateAction: text("escalate_action", { enum: APPROVAL_ESCALATE_ACTIONS })
      .notNull()
      .default("add_assignee"),
    escalateToKind: text("escalate_to_kind", { enum: APPROVAL_ASSIGNEE_KINDS }),
    escalateToId: uuid("escalate_to_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "approval_sla_policies_window_check",
      sql`${t.warnAfterMinutes} >= 0 AND ${t.breachAfterMinutes} > ${t.warnAfterMinutes}`,
    ),
    check(
      "approval_sla_policies_action_check",
      sql`${t.escalateAction} IN ('add_assignee','reassign','notify_only')`,
    ),
    check(
      "approval_sla_policies_kind_check",
      sql`${t.escalateToKind} IS NULL OR ${t.escalateToKind} IN ('user','role','team')`,
    ),
    check(
      "approval_sla_policies_target_check",
      sql`${t.escalateAction} = 'notify_only' OR (${t.escalateToKind} IS NOT NULL AND ${t.escalateToId} IS NOT NULL)`,
    ),
    check(
      "approval_sla_policies_reassign_check",
      sql`${t.escalateAction} <> 'reassign' OR ${t.escalateToKind} = 'user'`,
    ),
    uniqueIndex("approval_sla_policies_name_uq").on(t.name),
  ],
);

/** ROUTING. Matched on the SAME dimensions ADR-0018 established for workflow
 * assignment rather than a second matching vocabulary. Conditions AND together;
 * a rule with NO conditions matches NOTHING (DB CHECK) — the discipline
 * `workflowAssignmentRules` already follows. */
export const approvalAssignmentRules = pgTable(
  "approval_assignment_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    objectType: text("object_type"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** SERVER-RESOLVED from the attributed project's compliance classifications
     * — never a client-supplied value (the ADR-0019 addendum's rule) */
    dataSensitivity: text("data_sensitivity"),
    /** matched against `approvals.stageId` as a prefix/glob */
    stagePattern: text("stage_pattern"),
    templateId: uuid("template_id").references(() => workflowTemplates.id, { onDelete: "cascade" }),
    assigneeKind: text("assignee_kind", { enum: APPROVAL_ASSIGNEE_KINDS }).notNull(),
    assigneeId: uuid("assignee_id").notNull(),
    /** composes with ADR-0027's per-stage quorum; 1 = today */
    quorum: integer("quorum").notNull().default(1),
    /** lower wins; ties break on createdAt (oldest first) so matching is total */
    priority: integer("priority").notNull().default(100),
    slaPolicyId: uuid("sla_policy_id").references(() => approvalSlaPolicies.id, {
      onDelete: "set null",
    }),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("approval_assignment_rules_kind_check", sql`${t.assigneeKind} IN ('user','role','team')`),
    check("approval_assignment_rules_quorum_check", sql`${t.quorum} >= 1`),
    check(
      "approval_assignment_rules_conditions_check",
      sql`${t.objectType} IS NOT NULL OR ${t.projectId} IS NOT NULL OR ${t.dataSensitivity} IS NOT NULL OR ${t.stagePattern} IS NOT NULL OR ${t.templateId} IS NOT NULL`,
    ),
    index("approval_assignment_rules_match_idx").on(t.enabled, t.priority, t.createdAt),
  ],
);

/** ONE row per approval. Carries the routed owner, the claim state, the SLA
 * clock and the escalation target. `warnAt`/`dueAt` are DERIVED from
 * `approvals.requestedAt` + the policy, so a lazily materialized assignment
 * computes the same deadlines an eagerly materialized one would have. */
export const approvalAssignments = pgTable(
  "approval_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    /** NULL = no rule matched; the assignment mirrors the approval's own named
     * approver, which is today's behaviour made explicit */
    ruleId: uuid("rule_id").references(() => approvalAssignmentRules.id, { onDelete: "set null" }),
    assigneeKind: text("assignee_kind", { enum: APPROVAL_ASSIGNEE_KINDS }).notNull(),
    assigneeId: uuid("assignee_id").notNull(),
    quorum: integer("quorum").notNull().default(1),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    slaPolicyId: uuid("sla_policy_id").references(() => approvalSlaPolicies.id, {
      onDelete: "set null",
    }),
    warnAt: timestamp("warn_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    slaState: text("sla_state", { enum: APPROVAL_SLA_STATES }).notNull().default("ok"),
    breachedAt: timestamp("breached_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationAssigneeKind: text("escalation_assignee_kind", { enum: APPROVAL_ASSIGNEE_KINDS }),
    escalationAssigneeId: uuid("escalation_assignee_id"),
  },
  (t) => [
    check("approval_assignments_kind_check", sql`${t.assigneeKind} IN ('user','role','team')`),
    check("approval_assignments_quorum_check", sql`${t.quorum} >= 1`),
    check("approval_assignments_sla_state_check", sql`${t.slaState} IN ('ok','warning','breached')`),
    check(
      "approval_assignments_escalation_kind_check",
      sql`${t.escalationAssigneeKind} IS NULL OR ${t.escalationAssigneeKind} IN ('user','role','team')`,
    ),
    uniqueIndex("approval_assignments_approval_uq").on(t.approvalId),
    index("approval_assignments_assignee_idx").on(t.assigneeKind, t.assigneeId),
    index("approval_assignments_due_idx").on(t.slaState, t.dueAt),
  ],
);

/** named filter/sort presets. `userId` NULL = an admin-PUBLISHED shared view. */
export const approvalSavedViews = pgTable(
  "approval_saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    sort: text("sort").notNull().default("requested_at_desc"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_saved_views_user_name_uq")
      .on(t.userId, t.name)
      .where(sql`${t.userId} IS NOT NULL`),
    uniqueIndex("approval_saved_views_shared_name_uq")
      .on(t.name)
      .where(sql`${t.userId} IS NULL`),
  ],
);

export type ApprovalSlaPolicyRow = typeof approvalSlaPolicies.$inferSelect;
export type ApprovalAssignmentRuleRow = typeof approvalAssignmentRules.$inferSelect;
export type ApprovalAssignmentRow = typeof approvalAssignments.$inferSelect;
export type ApprovalSavedViewRow = typeof approvalSavedViews.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0047 (migration 0059) — EXECUTIVE & COMPLIANCE REPORTING.
//
// A READ-ONLY PROJECTION over the ledgers that already exist. There is no
// rollup/summary table here on purpose: a denormalized copy of spend drifts
// from `usage_events`, and a board report that disagrees with the cost
// dashboard is worse than no board report. Every figure is computed at
// generation time from `usage_events` / `audit_log` / `approvals` under a WHERE
// clause built from the CALLER'S OWN entitlement.
// ---------------------------------------------------------------------------

export const REPORT_KINDS = ["exec_summary", "team_scorecard", "compliance"] as const;
export const REPORT_SCOPE_KINDS = ["org", "initiative", "team", "project"] as const;
export const REPORT_PERIODS = [
  "current_month",
  "last_month",
  "current_quarter",
  "last_quarter",
  "last_30_days",
] as const;
export const REPORT_FORMATS = ["csv", "json", "both"] as const;
export const REPORT_ENTITLEMENT_SCOPES = ["org", "team", "project"] as const;
export const REPORT_CADENCES = ["daily", "weekly", "monthly", "quarterly"] as const;
export const REPORT_TRIGGERS = ["manual", "scheduled"] as const;

export const reportDefinitions = pgTable(
  "report_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind", { enum: REPORT_KINDS }).notNull(),
    scopeKind: text("scope_kind", { enum: REPORT_SCOPE_KINDS }).notNull().default("org"),
    /** NULL exactly when scopeKind='org' (DB CHECK) */
    scopeId: uuid("scope_id"),
    period: text("period", { enum: REPORT_PERIODS }).notNull().default("current_month"),
    sections: jsonb("sections").$type<string[]>(),
    format: text("format", { enum: REPORT_FORMATS }).notNull().default("json"),
    /** THE GRANT a caller must hold. 'org' is admin-only, and the DB refuses to
     * pair it with anything but an org-scoped definition. */
    entitlementScope: text("entitlement_scope", { enum: REPORT_ENTITLEMENT_SCOPES })
      .notNull()
      .default("project"),
    description: text("description"),
    /** ADR-0058 (migration 0073): the compliance pack whose control mapping the
     * `controls` section is computed from. NULL keeps ADR-0047's built-in
     * fallback set — which now says, in its own note, that it is a fallback and
     * that a pack should be attached. Set, and the section is computed from the
     * pack's controls against the real ledgers, stamped with the pack version. */
    packId: uuid("pack_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("report_definitions_name_uq").on(t.name),
    index("report_definitions_kind_idx").on(t.kind),
  ],
);

/** the schedule DEFINITION. Nothing in this codebase fires it — an operator or
 * an external cron drives POST /v1/reports/schedules/run-due. */
export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => reportDefinitions.id, { onDelete: "cascade" }),
    cadence: text("cadence", { enum: REPORT_CADENCES }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    recipientUserIds: jsonb("recipient_user_ids").$type<string[]>(),
    lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("report_schedules_definition_idx").on(t.definitionId),
    index("report_schedules_enabled_idx").on(t.enabled),
  ],
);

/** one immutable row per generation. `effectiveProjectIds` is the honest record
 * of what the generator was PERMITTED to query — NULL means org-wide. */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => reportDefinitions.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id").references(() => reportSchedules.id, { onDelete: "set null" }),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    trigger: text("trigger", { enum: REPORT_TRIGGERS }).notNull().default("manual"),
    period: text("period", { enum: REPORT_PERIODS }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** COPIED at generation time so a later edit to the definition cannot
     * retroactively widen who may read an already-generated artifact */
    entitlementScope: text("entitlement_scope", { enum: REPORT_ENTITLEMENT_SCOPES }).notNull(),
    effectiveProjectIds: jsonb("effective_project_ids").$type<string[] | null>(),
    format: text("format", { enum: REPORT_FORMATS }).notNull().default("json"),
    payload: jsonb("payload").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("report_runs_definition_at_idx").on(t.definitionId, t.generatedAt),
    index("report_runs_requested_by_idx").on(t.requestedByUserId),
  ],
);

export type ReportDefinitionRow = typeof reportDefinitions.$inferSelect;
export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
export type ReportRunRow = typeof reportRuns.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0048 (migration 0060) — IMMUTABLE VERSIONING, CANARY, ROLLBACK for the
// governance artifacts the gateway actually reads.
//
// Follows ADR-0040's precedent (`abac_policies` + `abac_policy_versions`)
// rather than inventing a second shape: immutable version rows plus an ACTIVE
// pointer, where activation is a pointer move and rollback is selecting an
// older row. What it adds is the CANARY status (a deterministic, sticky
// percentage split) and the STAMP on `usage_events`, so a regression observed
// in the metrics is traceable to the version that caused it.
// ---------------------------------------------------------------------------

export const CONFIG_ARTIFACT_TYPES = [
  "agent_system_prompt",
  "agent_config",
  "approval_rule",
  "rate_limit",
  "data_scope_rule",
  "compliance_profile",
] as const;
export type ConfigArtifactType = (typeof CONFIG_ARTIFACT_TYPES)[number];

export const CONFIG_VERSION_STATUSES = [
  "draft",
  "canary",
  "active",
  "rolled_back",
  "superseded",
  // batch B1 (migration 0095) — demoted because the ARTIFACT was deleted
  // through the explicit rule DELETE route. Not 'superseded' (replaced by a
  // newer active) and not 'rolled_back' (an older version re-activated over
  // it): both would misstate the version's history. A 'retired' version can
  // never serve — its artifact no longer exists — and its row is kept as the
  // record of what governed the calls made while it did.
  "retired",
] as const;
export type ConfigVersionStatus = (typeof CONFIG_VERSION_STATUSES)[number];

export const CONFIG_ACTIVATION_ACTIONS = [
  "created",
  "activated",
  "canary_started",
  "canary_adjusted",
  "promoted",
  "rolled_back",
  "abandoned",
  // batch B1 (migration 0095) — the ledger entry that records a pointer being
  // demoted to 'retired' because the artifact was deleted
  "artifact_deleted",
] as const;
export type ConfigActivationAction = (typeof CONFIG_ACTIVATION_ACTIONS)[number];

export const configVersions = pgTable(
  "config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactType: text("artifact_type", { enum: CONFIG_ARTIFACT_TYPES }).notNull(),
    artifactId: uuid("artifact_id").notNull(),
    version: integer("version").notNull(),
    /** the artifact VERBATIM — this column IS the thing rollback re-points at */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    label: text("label"),
    parentVersion: integer("parent_version"),
    status: text("status", { enum: CONFIG_VERSION_STATUSES }).notNull().default("draft"),
    /** 1..99 exactly when status='canary' (DB CHECK, both directions) */
    canaryPct: integer("canary_pct"),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("config_versions_artifact_version_uq").on(t.artifactType, t.artifactId, t.version),
    // ADR-0048 §1's invariant, in the DATABASE rather than in a comment
    uniqueIndex("config_versions_one_active_uq")
      .on(t.artifactType, t.artifactId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("config_versions_one_canary_uq")
      .on(t.artifactType, t.artifactId)
      .where(sql`${t.status} = 'canary'`),
    index("config_versions_artifact_status_idx").on(t.artifactType, t.artifactId, t.status),
  ],
);

/** the APPEND-ONLY record of which version was active when. `status` on
 * `config_versions` tells you the present; this is what makes the past
 * reconstructable. */
export const configActivationEvents = pgTable(
  "config_activation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactType: text("artifact_type", { enum: CONFIG_ARTIFACT_TYPES }).notNull(),
    artifactId: uuid("artifact_id").notNull(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => configVersions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    fromVersionId: uuid("from_version_id"),
    fromVersion: integer("from_version"),
    action: text("action", { enum: CONFIG_ACTIVATION_ACTIONS }).notNull(),
    canaryPct: integer("canary_pct"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    /** ADR-0048 §4: the eval run that gated this promotion, when one did */
    evalRunId: uuid("eval_run_id").references(() => evalRuns.id, { onDelete: "set null" }),
    /** ...and the honest escape hatch when nothing gated it. A DB CHECK forces
     * an override to carry a non-empty reason. */
    override: boolean("override").notNull().default(false),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_activation_events_artifact_at_idx").on(t.artifactType, t.artifactId, t.at)],
);

/**
 * ADR-0073 (migration 0084) — THE SHADOW CANARY'S OUTPUT.
 *
 * One row per SAMPLED governed decision while a rule/compliance-profile canary
 * is running: what the ACTIVE version decided (which is what the caller
 * actually got), what the CANDIDATE version WOULD have decided, and whether
 * they differ. Deliberately NOT `audit_log`: that table is the hash-chained
 * record of decisions that were SERVED, and a shadow evaluation is by
 * definition not one — putting it there would place a decision nobody was
 * subject to inside the ledger an auditor reads as what happened.
 *
 * FK-free on purpose, exactly like `audit_log`: an observation must survive the
 * deletion of the user, server or project it describes, otherwise the evidence
 * for "this candidate would have denied Dana" disappears with Dana.
 */
export const configCanaryObservations = pgTable(
  "config_canary_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactType: text("artifact_type", { enum: CONFIG_ARTIFACT_TYPES }).notNull(),
    artifactId: uuid("artifact_id").notNull(),
    candidateVersionId: uuid("candidate_version_id").notNull(),
    candidateVersion: integer("candidate_version").notNull(),
    activeVersionId: uuid("active_version_id"),
    activeVersion: integer("active_version"),
    /** the sampling rate in force when this was recorded — so a divergence
     * COUNT is never mistaken for a fleet-wide count */
    canaryPct: integer("canary_pct"),
    bucket: integer("bucket"),
    userId: uuid("user_id"),
    serverId: uuid("server_id"),
    toolName: text("tool_name"),
    projectId: uuid("project_id"),
    /** the decision the caller ACTUALLY got — the active version's */
    servedEffect: text("served_effect"),
    servedRuleId: text("served_rule_id"),
    servedReason: text("served_reason"),
    /** what the candidate WOULD have produced. Null exactly when `failed`. */
    candidateEffect: text("candidate_effect"),
    candidateRuleId: text("candidate_rule_id"),
    candidateReason: text("candidate_reason"),
    diverged: boolean("diverged").notNull().default(false),
    /** the candidate evaluation THREW. The served decision was unaffected by
     * construction (it was already computed); the failure is recorded rather
     * than swallowed, because a canary that fails silently is a canary that
     * reports "no divergences" while measuring nothing. */
    failed: boolean("failed").notNull().default(false),
    failureReason: text("failure_reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("config_canary_obs_artifact_at_idx").on(t.artifactType, t.artifactId, t.at),
    index("config_canary_obs_diverged_idx").on(t.artifactType, t.artifactId, t.diverged, t.at),
    index("config_canary_obs_version_idx").on(t.candidateVersionId, t.diverged),
  ],
);

export type ConfigVersionRow = typeof configVersions.$inferSelect;
export type ConfigActivationEventRow = typeof configActivationEvents.$inferSelect;
export type ConfigCanaryObservationRow = typeof configCanaryObservations.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0049 (migration 0061) — COST FORECASTING and SPEND-ANOMALY DETECTION.
//
// Nothing below stores a rollup of spend. `usage_events` stays the single
// source of truth for every dollar; these tables hold a POLICY (what to look
// for), a DECIDED FUTURE FACT (a scheduled change), or an OBSERVATION ARTIFACT
// (a forecast that was computed, an anomaly that was flagged) — never a number
// another surface could disagree with. The vocabularies are declared here in
// the same lockstep-with-@regulait/shared style as the guardrail ids above:
// this package deliberately has no dependency on shared, and the gateway
// imports both, so a divergence fails to type-check.
// ---------------------------------------------------------------------------

export const ANOMALY_SENSITIVITY_VALUES = ["low", "medium", "high"] as const;
export const ANOMALY_ACTION_VALUES = ["alert", "require_approval"] as const;
export const ANOMALY_SIGNAL_VALUES = [
  "spend_spike",
  "token_volume",
  "unusual_model",
  "off_hours",
  "egress_volume",
] as const;
export const ANOMALY_METHOD_VALUES = ["mad_z", "pct_over_baseline", "share_of_history"] as const;
export const ANOMALY_STATUS_VALUES = ["open", "acknowledged", "dismissed"] as const;
export const FORECAST_METHOD_VALUES = ["run_rate", "ewma"] as const;

/** The admin dial (ADR-0021 conventions). One row per project plus at most one
 * ORG-WIDE DEFAULT (projectId null). `enabled` defaults FALSE — ADR-0049 §3's
 * OFF-by-default posture, so a deployment that never turns this on behaves
 * byte-identically to before migration 0061. `lastEvaluatedAt` staying null is
 * how "nothing fires on a timer" is VISIBLE rather than merely documented. */
export const spendMonitorPolicies = pgTable(
  "spend_monitor_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null = the org-wide default; a project row overrides it */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    sensitivity: text("sensitivity", { enum: ANOMALY_SENSITIVITY_VALUES }).notNull().default("medium"),
    baselineDays: integer("baseline_days").notNull().default(30),
    /** ADR-0049 §5's alert-not-block bias, as the column default */
    action: text("action", { enum: ANOMALY_ACTION_VALUES }).notNull().default("alert"),
    /** null = evaluate every signal in the vocabulary */
    signals: jsonb("signals").$type<string[]>(),
    activeHourStart: integer("active_hour_start"),
    activeHourEnd: integer("active_hour_end"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("spend_monitor_policies_project_uq")
      .on(t.projectId)
      .where(sql`${t.projectId} IS NOT NULL`),
  ],
);

/** ADR-0049 §1's scheduled-change adjustment: a DECIDED future delta, signed,
 * with a mandatory reason. The forecast adds these on top of the extrapolation;
 * nothing else is ever anticipated. */
export const spendScheduledChanges = pgTable(
  "spend_scheduled_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** SIGNED: a decommissioned expensive agent is a negative number */
    deltaUsd: doublePrecision("delta_usd").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spend_scheduled_changes_project_effective_idx").on(t.projectId, t.effectiveAt)],
);

/** The append-only flag ledger. Every row carries the signal, the method, the
 * baseline, the threshold, the score and the window, so a flag is re-derivable
 * by hand months later (§5: no unexplained risk score). `approvalId` points at
 * the item on the ONE Approvals Queue — that column existing, rather than a
 * parallel status machine, IS §4's "no new inbox" guarantee. */
export const spendAnomalies = pgTable(
  "spend_anomalies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** §2's per-user narrowing; null = a project-level flag */
    subjectUserId: uuid("subject_user_id"),
    signal: text("signal", { enum: ANOMALY_SIGNAL_VALUES }).notNull(),
    method: text("method", { enum: ANOMALY_METHOD_VALUES }).notNull(),
    observed: doublePrecision("observed").notNull(),
    baselineMedian: doublePrecision("baseline_median"),
    baselineMad: doublePrecision("baseline_mad"),
    baselineSamples: integer("baseline_samples").notNull(),
    score: doublePrecision("score"),
    threshold: doublePrecision("threshold"),
    absoluteFloor: doublePrecision("absolute_floor").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    /** the full sentence a human reads; never a bare number */
    explanation: text("explanation").notNull(),
    action: text("action", { enum: ANOMALY_ACTION_VALUES }).notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    status: text("status", { enum: ANOMALY_STATUS_VALUES }).notNull().default("open"),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    detail: jsonb("detail"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("spend_anomalies_project_detected_idx").on(t.projectId, t.detectedAt),
    index("spend_anomalies_status_idx").on(t.status),
    /** idempotent re-evaluation: one row per (project, signal, window) however
     * many times an operator drives the sweep */
    uniqueIndex("spend_anomalies_window_uq").on(t.projectId, t.signal, t.windowStart, t.windowEnd),
  ],
);

/** The forecast ARTIFACT, mirroring ADR-0047's `report_runs`. `sufficient` is a
 * real column and `projectedSpendUsd` is nullable, with a DB CHECK tying them
 * together: an insufficient-data answer is stored AS SUCH, so the history can
 * never be mined for a number that was never claimed. */
export const spendForecastRuns = pgTable(
  "spend_forecast_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    scopeKind: text("scope_kind", { enum: ["org", "initiative", "team", "project"] }).notNull(),
    scopeId: uuid("scope_id"),
    /** the honest record of what this forecast was PERMITTED to see; null =
     * the org-wide set, reachable only by an admin under an org-scoped request */
    effectiveProjectIds: jsonb("effective_project_ids").$type<string[] | null>(),
    method: text("method", { enum: FORECAST_METHOD_VALUES }).notNull(),
    period: text("period").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    sufficient: boolean("sufficient").notNull(),
    projectedSpendUsd: doublePrecision("projected_spend_usd"),
    lowUsd: doublePrecision("low_usd"),
    highUsd: doublePrecision("high_usd"),
    spendToDateUsd: doublePrecision("spend_to_date_usd").notNull(),
    payload: jsonb("payload").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spend_forecast_runs_generated_idx").on(t.generatedAt)],
);

export type SpendMonitorPolicyRow = typeof spendMonitorPolicies.$inferSelect;
export type SpendScheduledChangeRow = typeof spendScheduledChanges.$inferSelect;
export type SpendAnomalyRow = typeof spendAnomalies.$inferSelect;
export type SpendForecastRunRow = typeof spendForecastRuns.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0050 (migration 0062) — the DATA-LINEAGE / PROVENANCE GRAPH.
//
// SUPPLIED-INPUTS provenance: which inputs the gateway handed to a dispatch and
// what that dispatch produced, chained across runs through pillar 4's already-
// versioned context items. It deliberately does NOT model which of those inputs
// influenced the output — that is intra-model attribution and is not observable
// from outside a model, so it is not represented here and is not claimed.
//
// This is a DERIVED READ-MODEL over the append-only ledgers
// (`project_context_items`, `usage_events`, `audit_log`), which remain the
// source of truth: if it were lost it could be rebuilt from them.
//
// ORIENTATION: every edge points in the DIRECTION OF DATA FLOW (`from` =
// upstream). `derived_from` is therefore stored predecessor → successor
// (v1 → v2) despite how its name reads, so `backward` means "where did this
// come from" uniformly with no per-edge-kind special case.
// ---------------------------------------------------------------------------

export const LINEAGE_NODE_KIND_VALUES = ["source", "run", "output"] as const;
export const LINEAGE_SUBTYPE_VALUES = [
  "context_item",
  "workflow_artifact",
  "connector_result",
  "mcp_result",
  "document",
  "run_node",
  "agent_dispatch",
  "dispatch_output",
  "pull_request",
  "pm_work_item",
  // ADR-0065 (migration 0077) — the RegulAIt-LLM training chain: a pinned
  // dataset VERSION (source), the job that consumed it (run), and the model
  // that came out (output). Kept in lockstep with LINEAGE_SUBTYPES in
  // @regulait/shared and with the DB CHECK in migration 0077.
  "training_dataset",
  "training_job",
  "model_artifact",
] as const;
export const LINEAGE_EDGE_KIND_VALUES = ["flowed_into", "produced", "derived_from"] as const;

export const lineageNodes = pgTable(
  "lineage_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** THE ENTITLEMENT BOUNDARY: every lineage query narrows to the caller's
     * visible projects at query construction, because for lineage the mere
     * EXISTENCE of a node is the sensitive fact. */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: LINEAGE_NODE_KIND_VALUES }).notNull(),
    subtype: text("subtype", { enum: LINEAGE_SUBTYPE_VALUES }).notNull(),
    /** the DEDUPE IDENTITY, derived (never random) so two captures of the same
     * real thing land on one node rather than silently forking the graph */
    naturalKey: text("natural_key").notNull(),
    refId: uuid("ref_id"),
    refKey: text("ref_key"),
    /** the SPECIFIC version consumed — lineage never points at "the current
     * value of the key", which is the whole reason provenance versions */
    version: integer("version"),
    label: text("label").notNull(),
    /** GOVERNANCE §8.4: metadata by DEFAULT. A DB CHECK ties the flag and the
     * column together in both directions. */
    contentRecorded: boolean("content_recorded").notNull().default(false),
    content: text("content"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lineage_nodes_project_natural_key_uq").on(t.projectId, t.naturalKey),
    index("lineage_nodes_project_kind_idx").on(t.projectId, t.kind),
    index("lineage_nodes_ref_idx").on(t.refId),
  ],
);

export const lineageEdges = pgTable(
  "lineage_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** denormalised so the entitlement narrowing is a SQL predicate rather than
     * a post-join filter */
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromNodeId: uuid("from_node_id")
      .notNull()
      .references(() => lineageNodes.id, { onDelete: "cascade" }),
    toNodeId: uuid("to_node_id")
      .notNull()
      .references(() => lineageNodes.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: LINEAGE_EDGE_KIND_VALUES }).notNull(),
    /** FK-free like the ledgers: a lineage record is a governance record that
     * must survive deletion of the run row it describes */
    runId: uuid("run_id"),
    nodeId: text("node_id"),
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** idempotent capture: one edge per (from, to, kind), however many times a
     * node is re-dispatched */
    uniqueIndex("lineage_edges_from_to_kind_uq").on(t.fromNodeId, t.toNodeId, t.kind),
    index("lineage_edges_from_idx").on(t.fromNodeId),
    index("lineage_edges_to_idx").on(t.toNodeId),
    index("lineage_edges_run_idx").on(t.runId),
    index("lineage_edges_project_idx").on(t.projectId),
  ],
);

export type LineageNodeRow = typeof lineageNodes.$inferSelect;
export type LineageEdgeRow = typeof lineageEdges.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0051 (migration 0063) — METERING & BILLING.
//
// Nothing here meters. `usage_events` (measured) and `cost_events` (estimated
// list price) have been written unconditionally at the point of every governed
// call since ADR-0019/0024; these tables are a READ-SIDE consumer of that one
// ledger and add no counter that could drift from it.
//
// FOUR STRUCTURAL DECISIONS, all about money not being quietly editable:
//  1. rate cards are IMMUTABLE (name, version) rows — a price change is a new
//     version, never an UPDATE;
//  2. a statement carries its own `pricingSnapshot`, so re-derivation replays
//     the frozen price and a newer card cannot reach backwards;
//  3. statements are APPEND-ONLY versions (the ADR-0040/0048 precedent) and an
//     issued one is never edited;
//  4. `effectiveProjectIds` is frozen at generation exactly as ADR-0047's
//     `report_runs` freezes it — widening a scope later must not widen an
//     already-cut document's audience.
// ---------------------------------------------------------------------------

export const BILLING_DIMENSION_VALUES = ["model", "connector", "mcp_tool", "seat"] as const;
export const RATE_UNIT_VALUES = [
  "per_1k_input_tokens",
  "per_1k_output_tokens",
  "per_call",
  "per_seat_month",
] as const;
export const BILLING_PERIOD_STATUS_VALUES = ["open", "closed"] as const;
export const BILLING_STATEMENT_STATUS_VALUES = ["draft", "issued", "superseded"] as const;
export const BILLING_RATING_MODE_VALUES = ["estimated", "reconciled"] as const;
export const BILLING_BACKEND_VALUES = ["noop"] as const;

export const rateCards = pgTable(
  "rate_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** append-only: a "change" writes (name, version+1) and supersedes this */
    version: integer("version").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
    description: text("description"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rate_cards_name_version_uq").on(t.name, t.version),
    index("rate_cards_status_idx").on(t.status),
  ],
);

/** Never updated — there is no UPDATE path in the gateway and no updatedAt
 * column here, because an editable price is an editable invoice. */
export const rateCardEntries = pgTable(
  "rate_card_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rateCardId: uuid("rate_card_id")
      .notNull()
      .references(() => rateCards.id, { onDelete: "cascade" }),
    dimension: text("dimension", { enum: BILLING_DIMENSION_VALUES }).notNull(),
    /** the model name / connector id / tool name, or '*' — exact beats wildcard */
    matchKey: text("match_key").notNull().default("*"),
    unit: text("unit", { enum: RATE_UNIT_VALUES }).notNull(),
    unitPriceUsd: doublePrecision("unit_price_usd").notNull(),
  },
  (t) => [
    uniqueIndex("rate_card_entries_card_key_uq").on(t.rateCardId, t.dimension, t.matchKey, t.unit),
  ],
);

export const billingPeriods = pgTable(
  "billing_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKind: text("scope_kind", { enum: ["org", "initiative", "team", "project"] }).notNull(),
    scopeId: uuid("scope_id"),
    /** derived ('org' when scopeId is null) so the UNIQUE index below actually
     * holds — Postgres treats NULLs in a unique index as DISTINCT, which would
     * otherwise let the same org month be opened twice */
    scopeKey: text("scope_key").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: text("status", { enum: BILLING_PERIOD_STATUS_VALUES }).notNull().default("open"),
    rateCardId: uuid("rate_card_id").references(() => rateCards.id, { onDelete: "set null" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_periods_scope_window_uq").on(t.scopeKind, t.scopeKey, t.periodStart, t.periodEnd),
    index("billing_periods_status_idx").on(t.status),
  ],
);

export const billingStatements = pgTable(
  "billing_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => billingPeriods.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", { enum: BILLING_STATEMENT_STATUS_VALUES }).notNull().default("draft"),
    ratingMode: text("rating_mode", { enum: BILLING_RATING_MODE_VALUES }).notNull().default("estimated"),

    rateCardId: uuid("rate_card_id").references(() => rateCards.id, { onDelete: "set null" }),
    rateCardName: text("rate_card_name").notNull(),
    rateCardVersion: integer("rate_card_version").notNull(),
    /** THE FROZEN PRICE. Re-derivation replays this, never the live card. */
    pricingSnapshot: jsonb("pricing_snapshot").notNull(),

    entitlementScope: text("entitlement_scope", { enum: ["org", "team", "project"] }).notNull(),
    /** the honest record of what this artifact was PERMITTED to see; null =
     * the org-wide set, only ever produced for an admin on an org period */
    effectiveProjectIds: jsonb("effective_project_ids").$type<string[] | null>(),
    /** false = a partial-visibility personal view; it may never be ISSUED */
    coversFullScope: boolean("covers_full_scope").notNull().default(false),

    /** the cut instant — re-derivation replays the ledger as of here */
    derivedThroughAt: timestamp("derived_through_at", { withTimezone: true }).notNull(),

    sourceUsageEventCount: integer("source_usage_event_count").notNull(),
    measuredInputTokens: bigint("measured_input_tokens", { mode: "number" }).notNull(),
    measuredOutputTokens: bigint("measured_output_tokens", { mode: "number" }).notNull(),
    unpricedEventCount: integer("unpriced_event_count").notNull(),
    /** the anchor back to the cost dashboard; kept SEPARATE from the billed
     * total because §5 refuses to flatten estimate and commercial price */
    ledgerEstimatedCostUsd: doublePrecision("ledger_estimated_cost_usd").notNull(),

    seatCount: integer("seat_count").notNull(),
    usageSubtotalUsd: doublePrecision("usage_subtotal_usd").notNull(),
    seatSubtotalUsd: doublePrecision("seat_subtotal_usd").notNull(),
    totalUsd: doublePrecision("total_usd").notNull(),

    payload: jsonb("payload").notNull(),
    generatedByUserId: uuid("generated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id, { onDelete: "set null" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    issueReason: text("issue_reason"),
  },
  (t) => [
    uniqueIndex("billing_statements_period_version_uq").on(t.periodId, t.version),
    index("billing_statements_period_idx").on(t.periodId),
    index("billing_statements_status_idx").on(t.status),
  ],
);

/** ADR-0051 §1: "a double-bill is structurally impossible". The idempotency
 * grain is (period, backend) — a statement covers a period's row set by
 * construction, so shipping the period once IS shipping each of its rows once. */
export const billingExports = pgTable(
  "billing_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => billingStatements.id, { onDelete: "cascade" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => billingPeriods.id, { onDelete: "cascade" }),
    backend: text("backend", { enum: BILLING_BACKEND_VALUES }).notNull().default("noop"),
    format: text("format", { enum: ["csv", "json"] }).notNull(),
    rowCount: integer("row_count").notNull(),
    usageEventCount: integer("usage_event_count").notNull(),
    totalUsd: doublePrecision("total_usd").notNull(),
    exportedByUserId: uuid("exported_by_user_id").references(() => users.id, { onDelete: "set null" }),
    exportedAt: timestamp("exported_at", { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb("detail"),
  },
  (t) => [
    uniqueIndex("billing_exports_period_backend_uq").on(t.periodId, t.backend),
    index("billing_exports_statement_idx").on(t.statementId),
  ],
);

export type RateCardRow = typeof rateCards.$inferSelect;
export type RateCardEntryRow = typeof rateCardEntries.$inferSelect;
export type BillingPeriodRow = typeof billingPeriods.$inferSelect;
export type BillingStatementRow = typeof billingStatements.$inferSelect;
export type BillingExportRow = typeof billingExports.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0052 (migration 0064) — LICENSING & SEAT MANAGEMENT.
//
// A signed, OFFLINE-verifiable license file. ADR-0041 makes BYOC/air-gapped the
// primary motion, so there is no home to phone: the artifact is verified
// locally against a pinned Ed25519 public key, reusing ADR-0041's update-bundle
// posture rather than inventing a second crypto scheme.
//
// `document` is the EXACT BYTES the signature covers, stored verbatim so the
// row stays independently re-verifiable forever. The parsed columns beside it
// are a denormalised READ MODEL, never the authority.
//
// A partial unique index keeps EXACTLY ONE license active, so "which license is
// in force" is never a question answered by picking the newest row. A forged
// artifact never reaches this table: verification precedes the insert and a
// refusal leaves the installed license exactly where it was.
// ---------------------------------------------------------------------------

export const LICENSE_DEPLOYMENT_MODE_VALUES = ["hosted", "byoc", "airgapped"] as const;
export const LICENSE_STATUS_VALUES = ["active", "superseded"] as const;
export const LICENSE_VERIFICATION_TRIGGER_VALUES = ["install", "periodic", "manual"] as const;
export const LICENSE_VERIFICATION_STATE_VALUES = [
  "absent",
  "not_yet_valid",
  "valid",
  "grace",
  "expired",
  "invalid",
] as const;

export const licenses = pgTable(
  "licenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // --- THE SIGNED ARTIFACT (the authority) ---
    document: text("document").notNull(),
    documentSha256: text("document_sha256").notNull(),
    signature: text("signature").notNull(),
    signingKeyId: text("signing_key_id").notNull(),

    // --- THE PARSED READ MODEL (convenience, never the authority) ---
    licenseId: text("license_id").notNull(),
    tenant: text("tenant").notNull(),
    tier: text("tier").notNull(),
    seatCap: integer("seat_cap").notNull(),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    deploymentMode: text("deployment_mode", { enum: LICENSE_DEPLOYMENT_MODE_VALUES }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    graceDays: integer("grace_days").notNull(),
    /** OPT-IN, never the default — a total shutdown on expiry, available only
     * because some customers' own contracts require it */
    hardStopOnExpiry: boolean("hard_stop_on_expiry").notNull().default(false),

    status: text("status", { enum: LICENSE_STATUS_VALUES }).notNull().default("active"),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("licenses_document_sha_uq").on(t.documentSha256)],
);

/** The verification trail. ADR-0052 §1's "periodic timer" is an ENDPOINT here
 * (there is no in-process scheduler in this codebase), and an empty table — or
 * a `last checked` that stops moving — is how a deployment that never wired the
 * cron SEES that. Every REFUSAL lands here too, including artifacts that were
 * refused and therefore never became a `licenses` row. */
export const licenseVerifications = pgTable(
  "license_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null when the artifact was refused and never became a row */
    licenseRowId: uuid("license_row_id").references(() => licenses.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    trigger: text("trigger", { enum: LICENSE_VERIFICATION_TRIGGER_VALUES }).notNull(),
    ok: boolean("ok").notNull(),
    state: text("state", { enum: LICENSE_VERIFICATION_STATE_VALUES }).notNull(),
    ruleId: text("rule_id").notNull(),
    reason: text("reason").notNull(),
    seatCap: integer("seat_cap"),
    activeSeats: integer("active_seats"),
    signingKeyId: text("signing_key_id"),
    checkedByUserId: uuid("checked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    detail: jsonb("detail"),
  },
  (t) => [index("license_verifications_at_idx").on(t.at), index("license_verifications_ok_idx").on(t.ok)],
);

export type LicenseRow = typeof licenses.$inferSelect;
export type LicenseVerificationRow = typeof licenseVerifications.$inferSelect;

// ===========================================================================
// ADR-0054 — ONBOARDING WIZARD & MIGRATION/IMPORT TOOLING (migration 0066)
// ===========================================================================
//
// Only TWO tables, and the shortness of that list is the design. Everything the
// wizard produces — roles, group→role mappings, compliance profiles,
// classifications — lands in the tables it would have landed in had an admin
// clicked through the existing console, because ADR-0054 §4 requires the output
// to be ordinary governed state that the policy-as-code path can export and
// replay. What genuinely exists nowhere else is HOW FAR THROUGH the wizard this
// deployment is, and WHAT AN IMPORT DID.

/**
 * The resumable checklist. `stepKey` is the PRIMARY KEY, and that single fact
 * is the whole idempotence guarantee: there is exactly one row per step in the
 * deployment, so a write can only ever be an upsert and "ran the step twice"
 * and "ran it once" are indistinguishable states. There is no wizard-session
 * id and no per-attempt row, so a piecemeal BYOC install cannot accumulate two
 * contradictory answers to "is the IdP connected?".
 *
 * The status is what an ADMIN ASSERTED, not proof. `GET /v1/onboarding`
 * composes it with a live readiness signal computed from the objects that
 * actually exist and reports both, so a step marked done whose provider was
 * later deleted reads `done` + `satisfied: false` instead of lying.
 */
export const onboardingSteps = pgTable("onboarding_steps", {
  stepKey: text("step_key").primaryKey(),
  status: text("status", { enum: ["pending", "in_progress", "done", "skipped"] })
    .notNull()
    .default("pending"),
  /** evidence the console shows beside the step — which provider, which file,
   * how many rows. Never a credential; the route screens before storing. */
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every import — planned, applied, AND REFUSED. The refusals are the rows that
 * matter: a payload that tried to set `isAdmin` is refused by the strict row
 * schema and by the pre-parse escalation screen, and the refusal lands here
 * beside an `audit_log` deny, because "somebody uploaded a file that tried to
 * mint administrators" has to be findable months later.
 *
 * `mode` separates the preview from the act, and both compute their plan with
 * the same pure planner in `@regulait/shared` — a dry run that is computed
 * differently from the apply it previews is worse than no dry run.
 */
export const onboardingImports = pgTable(
  "onboarding_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["users", "group_roles"] }).notNull(),
    mode: text("mode", { enum: ["dry_run", "apply"] }).notNull(),
    status: text("status", { enum: ["planned", "applied", "refused"] }).notNull(),
    /** fingerprint of the exact screened bytes — "which file did this?" without
     * retaining a directory export forever */
    payloadSha256: text("payload_sha256").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    /** null for a dry run and for a refusal — nothing happened, which is the
     * correct record rather than an empty object implying it did */
    result: jsonb("result").$type<Record<string, unknown>>(),
    /** the same stable id that names the audit_log row, so the two join on a
     * value a human can read */
    ruleId: text("rule_id").notNull(),
    reason: text("reason").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    index("onboarding_imports_created_idx").on(t.createdAt),
    index("onboarding_imports_kind_idx").on(t.kind),
    index("onboarding_imports_status_idx").on(t.status),
  ],
);

export type OnboardingStepRow = typeof onboardingSteps.$inferSelect;
export type OnboardingImportRow = typeof onboardingImports.$inferSelect;

// ===========================================================================
// ADR-0055 — SHADOW-AI DISCOVERY (migration 0068)
//
// The importer/analyzer half of the ADR. RegulAIt ships NO COLLECTOR — see the
// migration header — so these three tables model EVIDENCE THAT ARRIVED, the
// CATALOGUE it is matched against, and the CONCLUSIONS drawn. Nothing here
// implies the platform watched anything itself.
// ===========================================================================

/**
 * THE CATALOGUE, AND IT IS DATA (ADR-0055 §1). The matcher in
 * `@regulait/shared` holds no provider name at all: empty this table and
 * discovery matches nothing. Adding detection for a new provider — including a
 * customer's private in-house endpoint — is a row here, never a deploy.
 *
 * There is deliberately no `pattern` column: an admin-editable regex evaluated
 * against imported strings is a ReDoS primitive. Keys are prefix + minimum
 * length, hosts are exact-or-dot-boundary-suffix. Both linear.
 */
export const aiEndpointSignatures = pgTable(
  "ai_endpoint_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    kind: text("kind", { enum: ["hostname", "sdk_package", "api_key_prefix", "web_app"] }).notNull(),
    /** a hostname, a package name, or a key PREFIX — never a regular expression */
    value: text("value").notNull(),
    matchType: text("match_type", { enum: ["exact_host", "host_suffix", "package", "key_prefix"] }).notNull(),
    /** key signatures only: the minimum length of the FULL observed key */
    minLength: integer("min_length"),
    /** the governed thing that would REPLACE this usage — what makes a finding
     * actionable rather than a complaint. SET NULL on agent delete: retiring an
     * agent must never delete the evidence of ungoverned usage. */
    replacementAgentId: uuid("replacement_agent_id").references(() => agents.id, { onDelete: "set null" }),
    replacementNote: text("replacement_note"),
    /** 'regulait-seed', 'admin', or a vendor advisory URL — with lastUpdatedAt,
     * this is the STALENESS DISCLOSURE the ADR asks for, per row */
    provenance: text("provenance").notNull().default("admin"),
    enabled: boolean("enabled").notNull().default(true),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_endpoint_signatures_provider_idx").on(t.provider)],
);

/**
 * Every evidence file — planned, applied AND REFUSED. The refusals are the rows
 * that matter: a payload that tried to smuggle a privilege word into a
 * description of network traffic is refused twice over (a pre-parse screen and
 * strict row schemas with no such field) and the refusal lands here beside an
 * `audit_log` deny.
 *
 * WHAT AN IMPORT CAN DO, EXHAUSTIVELY: write rows into `shadowAiFindings`.
 */
export const shadowAiImports = pgTable(
  "shadow_ai_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["egress_log", "code_scan", "saas_export", "self_reported"] }).notNull(),
    mode: text("mode", { enum: ["dry_run", "apply"] }).notNull(),
    status: text("status", { enum: ["planned", "applied", "refused"] }).notNull(),
    source: text("source"),
    payloadSha256: text("payload_sha256").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    ruleId: text("rule_id").notNull(),
    reason: text("reason").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    index("shadow_ai_imports_created_idx").on(t.createdAt),
    index("shadow_ai_imports_kind_idx").on(t.kind),
    index("shadow_ai_imports_status_idx").on(t.status),
  ],
);

/**
 * THE CORRELATED INVENTORY. The unique index on
 * (subjectKind, subject, provider) is the dedup story: a second import
 * re-observing the same usage widens `signalSources`, extends `lastSeenAt` and
 * raises confidence — it never creates a second row.
 *
 * Severity (what the signal IMPLIES) and confidence (how many INDEPENDENT
 * collectors corroborate it) are separate axes and are never collapsed into one
 * score — that collapse is exactly the flat alert stream ADR-0055 §6 refuses.
 */
export const shadowAiFindings = pgTable(
  "shadow_ai_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectKind: text("subject_kind", { enum: ["host", "repo", "saas_app", "system"] }).notNull(),
    subject: text("subject").notNull(),
    provider: text("provider").notNull(),
    signalSources: jsonb("signal_sources").$type<string[]>().notNull(),
    signatureKinds: jsonb("signature_kinds").$type<string[]>().notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    observationCount: integer("observation_count").notNull().default(0),
    severity: text("severity", { enum: ["low", "medium", "high", "critical"] }).notNull(),
    confidence: text("confidence", { enum: ["low", "medium", "high"] }).notNull(),
    disposition: text("disposition", {
      enum: ["open", "confirmed", "sanctioned", "false_positive", "remediated"],
    })
      .notNull()
      .default("open"),
    /** carried through from the CATALOGUE — never from the imported file */
    replacementAgentId: uuid("replacement_agent_id").references(() => agents.id, { onDelete: "set null" }),
    replacementNote: text("replacement_note"),
    /** bounded leads, redacted key fragments only — never a credential */
    evidence: jsonb("evidence").$type<Array<Record<string, unknown>>>().notNull(),
    lastImportId: uuid("last_import_id").references(() => shadowAiImports.id, { onDelete: "set null" }),
    dispositionReason: text("disposition_reason"),
    dispositionByUserId: uuid("disposition_by_user_id").references(() => users.id, { onDelete: "set null" }),
    dispositionAt: timestamp("disposition_at", { withTimezone: true }),
    /** the workflow instance opened to pull this usage into governance */
    remediationInstanceId: uuid("remediation_instance_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("shadow_ai_findings_severity_idx").on(t.severity),
    index("shadow_ai_findings_disposition_idx").on(t.disposition),
    index("shadow_ai_findings_last_seen_idx").on(t.lastSeenAt),
  ],
);

export type AiEndpointSignatureRow = typeof aiEndpointSignatures.$inferSelect;
export type ShadowAiImportRow = typeof shadowAiImports.$inferSelect;
export type ShadowAiFindingRow = typeof shadowAiFindings.$inferSelect;

// ===========================================================================
// ADR-0061 — CHATOPS APPROVALS (migration 0069)
//
// THERE IS NO chat_approvals TABLE AND NO SECOND STATUS COLUMN. A ChatOps
// decision is written by the SAME `decideOneApproval` the portal calls, into
// the SAME `approvals` row, with `decidedBy` = the mapped RegulAIt human. The
// chat surface is a COURIER, never a second authority path — and the absence of
// anywhere else to record a decision is what makes that structural.
// ===========================================================================

/**
 * The workspace. The OUTBOUND bot token is NOT here: `connectorId` points at an
 * ordinary `connectors` row whose ordinary `connectorCredentials` row holds it,
 * so it rides the same encrypted-at-rest, write-only credential store and the
 * same connector-provider adapter as every other integration.
 *
 * What genuinely does not exist elsewhere is the INBOUND signing secret — the
 * connector machinery models credentials we PRESENT, and this is one we VERIFY
 * WITH. Encrypted under REGULAIT_DATA_KEY; no endpoint returns it.
 */
export const chatopsConnections = pgTable("chatops_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider", { enum: ["slack", "teams", "outlook"] }).notNull(),
  connectorId: uuid("connector_id")
    .notNull()
    .references(() => connectors.id, { onDelete: "cascade" }),
  /** ADR-0121 — NULLABLE, and null is meaningful rather than missing. This
   * verifies an INBOUND callback's HMAC. Slack signs its bodies and the Bot
   * Connector authenticates its caller; email signs nothing this product can
   * verify, so outlook has no inbound path at all and therefore no secret to
   * hold. A DB check (migration 0112) requires one for slack/teams and forbids
   * one for outlook, so neither state can be created by any path. */
  signingSecretCiphertext: text("signing_secret_ciphertext"),
  /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
   * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
  secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
  defaultChannel: text("default_channel").notNull(),
  /** ADR-0061's sensitivity dial. FALSE (the default) = an approval whose
   * project is in PII mode `block` posts a LINK with no buttons: a chat tap is
   * not a re-authenticated session, so the most sensitive classes are in-app
   * only until an admin deliberately opts this workspace in. */
  allowFencedDecide: boolean("allow_fenced_decide").notNull().default(false),
  /** ADR-0162 (migration 0127) — minimum governance-alert severity posted to
   * this workspace; null = alerts are not posted (opt-in) */
  notifyAlertMinSeverity: text("notify_alert_min_severity", { enum: ["medium", "high"] }),
  enabled: boolean("enabled").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * THE CRUX (ADR-0061 §2). A chat interaction arrives under the BOT's connection
 * carrying a chat user id — an ASSERTION. This admin-managed table is what turns
 * it into a RegulAIt human. Never self-asserted: a self-serve claim would let
 * anyone in the workspace bind themselves to an approver.
 *
 * `emailVerifiedSource` is an honesty column: `idp`/`scim` when the deployment
 * really did verify the email federated, `admin_asserted` when it is what an
 * admin typed. Either way the email must match an existing user — an admin can
 * bind an existing principal, never invent one.
 */
export const chatIdentityLinks = pgTable(
  "chat_identity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatopsConnections.id, { onDelete: "cascade" }),
    chatUserId: text("chat_user_id").notNull(),
    chatUserEmail: text("chat_user_email").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailVerifiedSource: text("email_verified_source", { enum: ["idp", "scim", "admin_asserted"] }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chat_identity_links_chat_user_uq").on(t.connectionId, t.chatUserId),
    uniqueIndex("chat_identity_links_user_uq").on(t.connectionId, t.userId),
  ],
);

/** What we posted. `redacted` records that the sensitivity fence fired and a
 * link went to chat instead of the content — the question a compliance reviewer
 * asks about a third-party workspace, answerable without re-reading Slack. */
export const chatopsMessages = pgTable(
  "chatops_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatopsConnections.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    messageRef: text("message_ref"),
    redacted: boolean("redacted").notNull().default(false),
    decidable: boolean("decidable").notNull().default(true),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [index("chatops_messages_approval_idx").on(t.approvalId)],
);

/**
 * THE DOUBLE-CLICK GUARD. The status machine already makes a double-DECIDE
 * impossible (`decideOneApproval` updates WHERE status = 'pending'), but a
 * second click must also not write a second AUDIT row. The unique index makes
 * the second callback resolve to the first one's recorded outcome.
 *
 * ONLY SUCCESSFUL decisions are recorded. A refusal deliberately gets no row: it
 * must be audited every time (repeated attempts by an unentitled principal are
 * the signal), and an admin who then creates the missing identity link must be
 * able to have the person click again.
 */
export const chatopsInteractions = pgTable(
  "chatops_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatopsConnections.id, { onDelete: "cascade" }),
    /** no FK: the record of who decided outlives the approval's own retention */
    approvalId: uuid("approval_id").notNull(),
    chatUserId: text("chat_user_id").notNull(),
    action: text("action", { enum: ["approve", "reject"] }).notNull(),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    outcome: text("outcome", { enum: ["decided", "already_decided"] }).notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("chatops_interactions_idem_uq").on(t.connectionId, t.approvalId, t.chatUserId, t.action),
    index("chatops_interactions_approval_idx").on(t.approvalId),
  ],
);

export type ChatOpsConnectionRow = typeof chatopsConnections.$inferSelect;
export type ChatIdentityLinkRow = typeof chatIdentityLinks.$inferSelect;
export type ChatOpsMessageRow = typeof chatopsMessages.$inferSelect;
export type ChatOpsInteractionRow = typeof chatopsInteractions.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0057 (migration 0070) — CONTINUOUS RED-TEAMING.
//
// WHAT IS NOT HERE, AND THAT IS THE POINT
//
//   There is no second runner, no second results table, no second gate. A
//   red-team probe is materialized into an `eval_cases` row, run by ADR-0044's
//   `runEvalSuite` through `executeGovernedDispatch`, and scored by the same
//   deterministic scorers — so `eval_runs`/`eval_results` remain the ONE record
//   of what was sent and what came back, and the promotion block is the SAME
//   `automated_check` → `blocked_on_check` route a failed CI check takes.
//
//   The four tables below add exactly what an eval run cannot express: which
//   ATTACK LIBRARY VERSION scored it, which ATTACK CLASS each case belongs to,
//   how SEVERE a defeat is, and which probes actually got through.
//
//   Red-team results reach a model card through the EXISTING
//   `model_card_evidence` table with `kind = 'eval_run'` (ADR-0045 §5). There
//   is deliberately no parallel evidence or approvals surface.
// ---------------------------------------------------------------------------

/** ADR-0068 (migration 0080) extended this from five to ten. These are Drizzle
 * TYPE-level enums over plain `text` columns — there is no Postgres ENUM TYPE.
 * There IS, however, a CHECK constraint from migration 0070 naming the five
 * original values, so 0080 drops and re-adds it with the widened list rather
 * than relaxing it away: a constraint that lists the vocabulary is what stops a
 * typo'd attack class becoming a class nobody ever gates on. The new list is a
 * strict superset, so no existing row is invalidated. */
export const RED_TEAM_ATTACK_CLASS_VALUES = [
  "prompt_injection",
  "jailbreak",
  "data_exfiltration",
  "pii_leak",
  "bias",
  "indirect_prompt_injection",
  "tool_abuse",
  "excessive_agency",
  "system_prompt_extraction",
  "encoding_evasion",
] as const;

export const RED_TEAM_SEVERITY_VALUES = ["low", "medium", "high", "critical"] as const;

/**
 * A VERSIONED ATTACK LIBRARY. Attacks are data, not code (ADR-0057 §1): adding
 * a probe is a row, never a redeploy. A library version FREEZES on publish —
 * the moment it is materialized into an eval dataset that a run can score
 * against — because a result stamped with a library version is meaningless if
 * the library can move underneath it. Editing a published library mints the
 * next version, exactly as an eval dataset does.
 */
export const redteamLibraries = pgTable(
  "redteam_libraries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    note: text("note"),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    /** the eval dataset this library version was materialized into. NULL until
     * published. This column is the whole "reuse ADR-0044's harness" decision,
     * expressed in the schema: there is no red-team runner to point at. */
    evalDatasetId: uuid("eval_dataset_id").references(() => evalDatasets.id, {
      onDelete: "restrict",
    }),
    evalDatasetVersion: integer("eval_dataset_version"),
    /** ADR-0068 §2 — which SHIPPED corpus version seeded this library, when one
     * did. NULL = hand-authored, or seeded before 0080 (which was always
     * corpus v1). Stamped so a result is reproducible against a stated corpus,
     * not merely against a library row somebody could have edited. */
    corpusVersion: integer("corpus_version"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("redteam_libraries_name_version_uq").on(t.name, t.version)],
);

/** One adversarial probe: the prompt, the class it attacks, how bad a defeat
 * is, and the ORACLE that decides whether the agent complied with something it
 * should have refused. The oracle is an ordinary ADR-0044 scorer config with
 * inverted meaning — `forbidden` markers describe the DISCLOSURE. */
export const redteamProbes = pgTable(
  "redteam_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => redteamLibraries.id, { onDelete: "cascade" }),
    probeKey: text("probe_key").notNull(),
    attackClass: text("attack_class", { enum: RED_TEAM_ATTACK_CLASS_VALUES }).notNull(),
    severity: text("severity", { enum: RED_TEAM_SEVERITY_VALUES }).notNull().default("high"),
    input: text("input").notNull(),
    /** ADR-0068 §3 — the REST of a multi-turn sequence, in order. NULL/[] (every
     * pre-0080 row) = an ordinary single-turn probe, materialized into an
     * `eval_cases` row exactly as before. A probe WITH turns cannot be an eval
     * case (a case is one input) and runs through the sequence runner instead —
     * same `executeGovernedDispatch`, same scorer, same audit and cost path. */
    turns: jsonb("turns").$type<string[]>(),
    /** ADR-0068 §4 — tools the agent HOLDS for this probe. A declaration, never
     * a grant: the induced call is adjudicated against the real entitlement
     * layer and is never executed. */
    tools: jsonb("tools").$type<Array<Record<string, unknown>>>(),
    /** ADR-0068 §4 — the agentic vector: which tool/connector the probe tries to
     * induce, named by NAME so an offline corpus can ship without ids from an
     * install it has never seen. */
    agentic: jsonb("agentic").$type<Record<string, unknown>>(),
    scorerKind: text("scorer_kind").notNull(),
    scorerConfig: jsonb("scorer_config").$type<Record<string, unknown>>().notNull().default({}),
    expected: jsonb("expected"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("redteam_probes_library_key_uq").on(t.libraryId, t.probeKey),
    index("redteam_probes_class_idx").on(t.attackClass),
  ],
);

/**
 * ONE RED-TEAM RUN — the security reading of exactly one `eval_runs` row.
 *
 * `eval_run_id` is UNIQUE and RESTRICT: a red-team verdict can never be
 * detached from the governed, metered, audited dispatches that produced it, and
 * two verdicts can never claim the same evidence.
 */
export const redteamRuns = pgTable(
  "redteam_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => redteamLibraries.id, { onDelete: "restrict" }),
    /** stamped, so the result stays readable after the library row is renamed */
    libraryName: text("library_name").notNull(),
    libraryVersion: integer("library_version").notNull(),
    evalRunId: uuid("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    agentName: text("agent_name").notNull(),
    model: text("model"),
    /** the ADR-0023 system prompt the agent carried WHEN PROBED — a red-team
     * result is about a configuration, not about a name */
    systemPromptHash: text("system_prompt_hash"),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id"),
    trigger: text("trigger").notNull().default("manual"),
    probes: integer("probes").notNull().default(0),
    resisted: integer("resisted").notNull().default(0),
    defeated: integer("defeated").notNull().default(0),
    resistRate: doublePrecision("resist_rate"),
    meanScore: doublePrecision("mean_score"),
    /** the per-attack-class aggregates, verbatim from `aggregateRedTeamByClass` */
    classSummary: jsonb("class_summary").$type<unknown[]>().notNull().default([]),
    /** which classes BLOCKED; the rest are reporting-only (ADR-0057 §6) */
    gatingClasses: jsonb("gating_classes").$type<string[]>().notNull().default([]),
    baselineRunId: uuid("baseline_run_id"),
    gatePassed: boolean("gate_passed"),
    regression: boolean("regression").notNull().default(false),
    gateReason: text("gate_reason"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    // --- ADR-0068 §1: N trials and attack-success-rate statistics -----------
    /** trials per probe. 1 (the default, and every pre-0080 row) = the ADR-0057
     * single-shot behaviour, and `measurementQuality` labels it `single-trial`
     * so it is never reported as a measured rate. */
    trials: integer("trials").notNull().default(1),
    /** POOLED attack-success rate across every usable trial of every measured
     * probe: defeats / trials. NULL when no probe produced a usable trial. */
    asr: doublePrecision("asr"),
    /** the Wilson score interval on `asr`, stored so the denominator can never
     * be separated from the rate */
    asrLower: doublePrecision("asr_lower"),
    asrUpper: doublePrecision("asr_upper"),
    /** total usable trials — the DENOMINATOR of `asr` */
    asrTrials: integer("asr_trials").notNull().default(0),
    /** 'not-run' | 'single-trial' | 'low-power' | 'measured' */
    measurementQuality: text("measurement_quality"),
    /** probes with NO usable trial: an unregistered agentic target, or every
     * dispatch errored. Excluded from every rate above, counted here, and NEVER
     * counted as resisted. */
    notRunProbes: integer("not_run_probes").notNull().default(0),
    /** per-probe ASR summaries verbatim from `summarizeProbeAsr`, including the
     * per-trial outcome list a reviewer needs to see the variance */
    probeStats: jsonb("probe_stats").$type<unknown[]>().notNull().default([]),
    /** ADR-0068 §4: how many probes induced the model successfully but were
     * STOPPED by this deployment's own entitlement layer. A first-class result,
     * not an absence — it is the evidence that pillar 1 held. */
    platformHeld: integer("platform_held").notNull().default(0),
    /** ADR-0068 §2: the shipped corpus version behind this result, when known */
    corpusVersion: integer("corpus_version"),
    /** ADR-0068 §5: what the compliance cascade TIGHTENED on this run, and
     * which framework tags said so. Empty on an unclassified project. */
    presetTightened: jsonb("preset_tightened").$type<string[]>().notNull().default([]),
    /** ADR-0072 — the scoring semantics behind this verdict. Version 1 scored a
     * governance-BLOCKED probe dispatch as a DEFEAT; version 2 scores it as a
     * PLATFORM HOLD. A v1 resist rate and a v2 resist rate are different
     * measurements, and `resolveRedTeamBaseline` will not compare them. */
    scoringSemantics: integer("scoring_semantics")
      .notNull()
      .default(SCORING_SEMANTICS_VERSION),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("redteam_runs_eval_run_uq").on(t.evalRunId),
    index("redteam_runs_agent_idx").on(t.agentId, t.startedAt),
    index("redteam_runs_library_idx").on(t.libraryId),
  ],
);

/**
 * ADR-0068 §1 — ONE TRIAL of a red-team run.
 *
 * `redteam_runs.eval_run_id` stays UNIQUE and RESTRICT (a verdict is never
 * detachable from its evidence); it now points at the FIRST trial's eval run.
 * This table holds all N, so "which governed, metered, audited eval runs
 * produced this ASR" is one query rather than a claim.
 *
 * `eval_run_id` is nullable because a trial that contained ONLY sequence /
 * agentic probes has no eval run — those probes cannot be `eval_cases` rows.
 * They still ride `executeGovernedDispatch`, so they are still metered into
 * `usage_events` and still audited; they simply have no eval-run wrapper.
 */
export const redteamTrials = pgTable(
  "redteam_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => redteamRuns.id, { onDelete: "cascade" }),
    /** 1-based */
    trial: integer("trial").notNull(),
    evalRunId: uuid("eval_run_id").references(() => evalRuns.id, { onDelete: "set null" }),
    probes: integer("probes").notNull().default(0),
    defeated: integer("defeated").notNull().default(0),
    errored: integer("errored").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("redteam_trials_run_trial_uq").on(t.runId, t.trial)],
);

/**
 * ADR-0068 §1 — ONE PROBE IN ONE TRIAL. The per-trial outcomes, stored rather
 * than only aggregated, because "2/3 failed" and "40/60 failed" must be
 * distinguishable by a reviewer reading the record and not merely by whoever
 * computed the mean. This is also where an agentic probe's ADJUDICATION lands:
 * what the model was induced to call, what the entitlement kernel decided, and
 * the fact — always — that nothing was executed.
 */
export const redteamProbeTrials = pgTable(
  "redteam_probe_trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => redteamRuns.id, { onDelete: "cascade" }),
    probeKey: text("probe_key").notNull(),
    attackClass: text("attack_class", { enum: RED_TEAM_ATTACK_CLASS_VALUES }).notNull(),
    severity: text("severity", { enum: RED_TEAM_SEVERITY_VALUES }).notNull(),
    trial: integer("trial").notNull(),
    /** true = the agent COMPLIED with what it should have refused */
    defeated: boolean("defeated").notNull(),
    score: doublePrecision("score").notNull(),
    /** why this trial produced no usable result. NOT NULL here means the trial
     * is excluded from the ASR denominator — never scored as resisted. */
    error: text("error"),
    /** how many governed dispatches this trial made (a multi-turn probe makes
     * one per turn) */
    turnsDispatched: integer("turns_dispatched").notNull().default(1),
    outputSnippet: text("output_snippet"),
    /** the ADR-0068 §4 adjudication, when this probe had an agentic vector */
    adjudication: jsonb("adjudication").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("redteam_probe_trials_run_idx").on(t.runId, t.probeKey),
    uniqueIndex("redteam_probe_trials_uq").on(t.runId, t.probeKey, t.trial),
  ],
);

/**
 * A DEFEAT. One row per probe that got through, pointing at the `eval_results`
 * row holding the actual transcript — so "which attack succeeded, and what did
 * the agent say" is one join, and the finding cannot drift from the evidence.
 *
 * Findings are records, not a queue: remediation runs through the EXISTING
 * workflow/approvals surfaces, never a second inbox (ADR-0057 §5).
 */
export const redteamFindings = pgTable(
  "redteam_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => redteamRuns.id, { onDelete: "cascade" }),
    probeId: uuid("probe_id").references(() => redteamProbes.id, { onDelete: "set null" }),
    probeKey: text("probe_key").notNull(),
    attackClass: text("attack_class", { enum: RED_TEAM_ATTACK_CLASS_VALUES }).notNull(),
    severity: text("severity", { enum: RED_TEAM_SEVERITY_VALUES }).notNull(),
    score: doublePrecision("score").notNull(),
    /** the eval_results row with the full transcript and scorer evidence */
    evalResultId: uuid("eval_result_id").references(() => evalResults.id, { onDelete: "set null" }),
    outputSnippet: text("output_snippet"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("redteam_findings_run_idx").on(t.runId),
    index("redteam_findings_class_idx").on(t.attackClass, t.severity),
  ],
);

export type RedTeamLibraryRow = typeof redteamLibraries.$inferSelect;
export type RedTeamProbeRow = typeof redteamProbes.$inferSelect;
export type RedTeamRunRow = typeof redteamRuns.$inferSelect;
export type RedTeamFindingRow = typeof redteamFindings.$inferSelect;
export type RedTeamTrialRow = typeof redteamTrials.$inferSelect;
export type RedTeamProbeTrialRow = typeof redteamProbeTrials.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0058 (migration 0073) — REGULATORY COMPLIANCE PACKS
// ---------------------------------------------------------------------------
//
// A PACK IS ROWS. That is the entire schema decision. There is no pack file
// baked into the image, no framework enum a new regulation would have to be
// added to, and no code path that reads a hard-coded catalogue:
// `DEFAULT_COMPLIANCE_PACKS` in `@regulait/shared` is a SEED an endpoint
// inserts, and the evaluator reads only these tables. Empty them and the
// evaluator evaluates nothing.
//
// WHAT IS DELIBERATELY ABSENT: a `satisfied` column. Nowhere in these tables
// can an admin record that a control is met. Satisfaction is COMPUTED, at
// evaluation time, from a SELECT over `audit_log` / `approvals` /
// `model_card_approvals` / `eval_runs` / `guardrail_configs` / `abac_policies`
// / `lineage_edges` / `usage_events` / `compliance_profiles`. A tick-box would
// have been the whole feature's failure mode, so there is no box.
//
// The one thing a human CAN record is an ATTESTATION — and it lives in its own
// table, resolves to its own status (`attested`, never `satisfied`), and
// carries the human who made it. An organisational control (training, incident
// response, post-market monitoring) is not observable from a control plane, so
// it is reported as outstanding until a named person says otherwise.

export const compliancePacks = pgTable(
  "compliance_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** free text ON PURPOSE — a customer's internal control framework is a
     * first-class pack (ADR-0058 §5) and must not need an enum migration */
    framework: text("framework").notNull(),
    /** a framework revision is a NEW ROW with a higher version, activated;
     * reports keep the version that produced them, so history never rewrites */
    version: integer("version").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** where the mapping came from + who reviewed it. This is what makes
     * staleness LEGIBLE — it cannot make a mapping authoritative. */
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    /** the §8.3 cascade tag this pack drives. A pack ENFORCES NOTHING itself:
     * tagging an Initiative with this drives the EXISTING cascade. */
    cascadeTag: text("cascade_tag"),
    /** batch B1 (migration 0096) — the compliance-profile STARTING POINT this
     * pack's cascade tag seeds on activation: a partial map of enforcing
     * `compliance_profiles` columns, validated at the edge with the same
     * check every profile version body passes. Null = the pack names no
     * starting profile and the admin authors one, exactly as before. Only
     * meaningful when cascadeTag is set; the API refuses a preset without a
     * tag. Activation FIND-OR-CREATES from this and NEVER overwrites an
     * existing profile. */
    cascadePreset: jsonb("cascade_preset").$type<Record<string, unknown>>(),
    status: text("status", { enum: ["draft", "active", "retired"] }).notNull().default("draft"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("compliance_packs_framework_version_uq").on(t.framework, t.version),
    /** AT MOST ONE ACTIVE VERSION PER FRAMEWORK. Two active versions would mean
     * two answers to "which mapping evidenced this report". */
    uniqueIndex("compliance_packs_one_active_uq")
      .on(t.framework)
      .where(sql`status = 'active'`),
    check("compliance_packs_version_check", sql`${t.version} >= 1`),
  ],
);

export const compliancePackControls = pgTable(
  "compliance_pack_controls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => compliancePacks.id, { onDelete: "cascade" }),
    /** the FRAMEWORK's own identifier — 'eu-ai-act:art-12-record-keeping' */
    controlRef: text("control_ref").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** the mapping author's DECLARED posture (ADR-0058 §4) */
    coverage: text("coverage", { enum: ["enforced", "evidenced", "partial", "unaddressed"] }).notNull(),
    /** a NAMED, PARAMETERISED query over a ledger that already exists. Not SQL:
     * a pack is analyst-authored data and must not be an injection primitive. */
    collector: text("collector").notNull(),
    collectorParams: jsonb("collector_params").$type<Record<string, unknown>>().notNull().default({}),
    minEvidenceCount: integer("min_evidence_count").notNull().default(1),
    /** TRUE = organisational control. The evaluator returns before it looks at
     * any count, so this can NEVER resolve to 'satisfied'. */
    attestationRequired: boolean("attestation_required").notNull().default(false),
    ownerNote: text("owner_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("compliance_pack_controls_ref_uq").on(t.packId, t.controlRef),
    index("compliance_pack_controls_pack_idx").on(t.packId),
    check("compliance_pack_controls_min_evidence_check", sql`${t.minEvidenceCount} >= 1`),
    /** the pairing rule, in the DATABASE: an attestation-required control has
     * no collector, so no ledger row can quietly satisfy it */
    check(
      "compliance_pack_controls_attestation_check",
      sql`(${t.attestationRequired} = false) OR (${t.collector} = 'none')`,
    ),
  ],
);

/** The ONE thing a human may record — and it is not "satisfied". An attestation
 * is the customer's own statement about an organisational control, attributed
 * to them, optionally time-boxed, and reported as `attested` (a distinct status
 * from `satisfied`) so a scorecard reader can always tell which is which. */
export const compliancePackAttestations = pgTable(
  "compliance_pack_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => compliancePacks.id, { onDelete: "cascade" }),
    controlRef: text("control_ref").notNull(),
    statement: text("statement").notNull(),
    evidenceRef: text("evidence_ref"),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    attestedByUserId: uuid("attested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("compliance_pack_attestations_lookup_idx").on(t.packId, t.controlRef, t.attestedAt)],
);

/** The generated ARTIFACT — the same posture as `report_runs` (ADR-0047): it is
 * what a generation produced, never an input to another computation. It records
 * the pack VERSION that produced it and the EXACT project ids the caller was
 * entitled to, so "whose evidence is in here" is answerable forever. */
export const compliancePackReports = pgTable(
  "compliance_pack_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** no cascade delete: the artifact outlives a retired pack */
    packId: uuid("pack_id").notNull(),
    framework: text("framework").notNull(),
    packVersion: integer("pack_version").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    scopeKind: text("scope_kind").notNull(),
    scopeId: uuid("scope_id"),
    entitlementScope: text("entitlement_scope").notNull(),
    /** NULL = org-wide (admin under an org-scoped request) */
    effectiveProjectIds: jsonb("effective_project_ids").$type<string[] | null>(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("compliance_pack_reports_pack_idx").on(t.packId, t.generatedAt)],
);

export type CompliancePackRow = typeof compliancePacks.$inferSelect;
export type CompliancePackControlRow = typeof compliancePackControls.$inferSelect;
export type CompliancePackAttestationRow = typeof compliancePackAttestations.$inferSelect;
export type CompliancePackReportRow = typeof compliancePackReports.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0056 (migration 0072) — THE AI GOVERNANCE COPILOT
// ---------------------------------------------------------------------------
//
// THE TABLE THAT IS NOT HERE: anything the copilot can mutate.
//
// The copilot is a READ-MOSTLY tenant of the platform it governs. It writes
// exactly two tables — a record of what it was ASKED and what it RETRIEVED, and
// a record of what it PROPOSED — and neither is a control-plane object. There
// is no `copilot_applied_changes`, no `copilot_policy_writes`, and no column
// anywhere below that names a grant, a role, a rule or an entitlement to
// change. A proposal carries a DIFF and points at an ordinary `approvals` row;
// applying it is a normal governed action performed by the APPROVER under their
// own identity, never by the copilot.
//
// `scope_project_ids` is the honesty column. Every retrieval is narrowed, at
// query construction, to the project ids the INVOKING USER is entitled to, and
// the set it was narrowed to is recorded on the query row. "Could the copilot
// have seen team B's rows when Alice asked?" is therefore answerable from the
// ledger, forever, without re-running anything.

export const copilotQueries = pgTable(
  "copilot_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** WHOSE entitlements, whose budget, whose audit trail. Not nullable: an
     * identity-less copilot query is a contradiction — there would be no
     * entitlement set to inherit. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    /** the STRUCTURED tool call the NL step produced. Recorded so "why did it
     * run that query" is answerable without a model. */
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    /** counts + bounded samples the retrieval returned, already scoped */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** the GROUNDED answer — composed from counts, never from model recall */
    answer: text("answer").notNull(),
    /** 'grounded' = no model was involved. 'model' = a narration was layered on
     * top of the grounded answer by a governed dispatch. */
    generation: text("generation", { enum: ["grounded", "model"] }).notNull().default("grounded"),
    /** the registry agent that narrated, when one did. FK-free deliberately —
     * the record of what was answered outlives the agent row. */
    narratorAgentId: uuid("narrator_agent_id"),
    /** the EXACT project ids the retrieval was permitted to touch. NULL =
     * org-wide (admin). This is what makes containment auditable. */
    scopeProjectIds: jsonb("scope_project_ids").$type<string[] | null>(),
    /** pillar 5: the project the narration dispatch billed to, when there was one */
    projectId: uuid("project_id"),
    /** ADR-0042: set when a guardrail acted on the retrieved evidence or on the
     * answer. The audit log is an injection surface and this is where a hit on
     * it becomes visible. */
    guardrailAction: text("guardrail_action"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("copilot_queries_user_idx").on(t.userId, t.createdAt)],
);

/** THE ONLY ROUTE FROM THE COPILOT TO A CHANGE — and it is not a change. A row
 * here is a diff plus the evidence for it, bound to an ordinary `approvals`
 * row. The copilot has written nothing to the control plane. */
export const copilotProposals = pgTable(
  "copilot_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryId: uuid("query_id")
      .notNull()
      .references(() => copilotQueries.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    /** the concrete, reviewable change — RECORDED, never applied by this module */
    diff: jsonb("diff").$type<Record<string, unknown>>().notNull(),
    /** the query result that justifies it, copied at proposal time so a later
     * ledger change cannot silently restate the justification */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** THE LINK TO THE ONE QUEUE (ADR-0045's rule, applied again): the copilot
     * does not get a second inbox. */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    proposedByUserId: uuid("proposed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * L6b (migration 0100) — THE APPLY LEDGER. NULL (every pre-L6 row) = not
     * applied, which was the only possible state before the applier existed.
     * Set only by `POST /v1/copilot/proposals/:id/apply`, only when the linked
     * approval is APPROVED, and only after the change went through the same
     * public choke point an admin would use by hand. Non-null is also the
     * idempotency gate: a second apply is refused by name, never re-executed.
     */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedByUserId: uuid("applied_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** exactly what the choke point reported back — the honest record of what
     * the apply DID, as distinct from what the diff proposed */
    appliedResult: jsonb("applied_result").$type<Record<string, unknown>>(),
  },
  (t) => [index("copilot_proposals_query_idx").on(t.queryId)],
);

export type CopilotQueryRow = typeof copilotQueries.$inferSelect;
export type CopilotProposalRow = typeof copilotProposals.$inferSelect;
// ADR-0059 (migration 0071) — POLICY SIMULATION / BLAST-RADIUS PREVIEW.
//
// THE DEFINING PROPERTY IS AN ABSENCE. A simulation writes exactly two kinds of
// row — the run and its sampled flips — plus ONE audit row saying a simulation
// happened. It writes no approvals, consumes no rate counters, meters no usage,
// dispatches nothing, and never touches `abac_policies.active_version_id`. The
// dry-run path does not import the dispatch core at all, which is what makes
// "zero side effects" structural rather than a promise.
//
// `policy_version_id` is RESTRICT: a stored blast radius names the exact
// immutable version it previewed (ADR-0048), and that version cannot be deleted
// out from under the preview an admin relied on when they activated.
// ---------------------------------------------------------------------------

export const POLICY_SIMULATION_BUCKET_VALUES = [
  "newly_denied",
  "newly_approval_required",
  "newly_allowed",
  "unchanged",
  "indeterminate",
] as const;

export const policySimulations = pgTable(
  "policy_simulations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id").references(() => abacPolicies.id, { onDelete: "cascade" }),
    /** ADR-0120: nullable since migration 0111 — a simulation of a proposed
     * APPROVAL RULE or RATE LIMIT has no `abac_policy_versions` row to point
     * at. Exactly one of this and `candidateVersionId` is set, enforced by a
     * CHECK rather than by convention. */
    policyVersionId: uuid("policy_version_id").references(() => abacPolicyVersions.id, {
      onDelete: "restrict",
    }),
    /** ADR-0120 — the non-ABAC candidate: which `config_versions` artifact type
     * this preview was run for. Deliberately NOT an FK to `config_versions`:
     * the version may be superseded or deleted after the preview is taken, and
     * a stored preview must survive that exactly as an audit row does. */
    candidateArtifactType: text("candidate_artifact_type", {
      enum: ["approval_rule", "rate_limit"],
    }),
    candidateVersionId: uuid("candidate_version_id"),
    /** stamped, so a stored preview stays readable after a rename */
    policyName: text("policy_name").notNull(),
    policyVersion: integer("policy_version").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** the ADR-0047-shaped scope this run was PERMITTED to replay. NULL = org-
     * wide (admin only). The stored value is what makes a later reader able to
     * tell "nothing flipped" from "nothing in scope could have flipped". */
    scopeUserIds: jsonb("scope_user_ids").$type<string[] | null>(),
    scopeRuleId: text("scope_rule_id").notNull(),
    windowDays: integer("window_days").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    rowCap: integer("row_cap").notNull(),
    /** true when the cap was reached — the preview is then a LOWER BOUND, and
     * saying so is the difference between a bounded answer and a wrong one */
    capped: boolean("capped").notNull().default(false),
    considered: integer("considered").notNull().default(0),
    newlyDenied: integer("newly_denied").notNull().default(0),
    newlyApprovalRequired: integer("newly_approval_required").notNull().default(0),
    newlyAllowed: integer("newly_allowed").notNull().default(0),
    unchanged: integer("unchanged").notNull().default(0),
    indeterminate: integer("indeterminate").notNull().default(0),
    affectedUsers: integer("affected_users").notNull().default(0),
    affectedProjects: integer("affected_projects").notNull().default(0),
    affectedTools: integer("affected_tools").notNull().default(0),
    /** the NAMED blast radius: users, projects and tools, each with a count */
    blastRadius: jsonb("blast_radius").$type<Record<string, unknown>>().notNull().default({}),
    /** derived from the candidate's OWN source, never asserted by the caller */
    fidelityExact: boolean("fidelity_exact").notNull().default(true),
    fidelityCaveats: jsonb("fidelity_caveats").$type<unknown[]>().notNull().default([]),
    headline: text("headline").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("policy_simulations_version_idx").on(t.policyVersionId, t.createdAt),
    index("policy_simulations_requested_idx").on(t.requestedByUserId),
    /** ADR-0120 (migration 0111): exactly one kind of candidate, never both and
     * never neither — a preview naming nothing is one nobody can reproduce. */
    check(
      "policy_simulations_one_candidate_check",
      sql`(${t.policyVersionId} IS NOT NULL AND ${t.candidateVersionId} IS NULL)
          OR (${t.policyVersionId} IS NULL AND ${t.candidateVersionId} IS NOT NULL
              AND ${t.candidateArtifactType} IS NOT NULL)`,
    ),
  ],
);

/**
 * A SAMPLED FLIP: one recorded decision that would have gone differently, kept
 * so "which calls, exactly" is answerable rather than merely counted. Bounded —
 * the parent row carries the full counts, these are the representative rows.
 *
 * FK-free on `audit_log_id` for the same reason `audit_log` itself is FK-free:
 * the preview must survive the retention window of the row it cites.
 */
export const policySimulationFlips = pgTable(
  "policy_simulation_flips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    simulationId: uuid("simulation_id")
      .notNull()
      .references(() => policySimulations.id, { onDelete: "cascade" }),
    auditLogId: uuid("audit_log_id").notNull(),
    userId: uuid("user_id").notNull(),
    userLabel: text("user_label"),
    projectId: uuid("project_id"),
    projectName: text("project_name"),
    serverId: uuid("server_id").notNull(),
    toolName: text("tool_name").notNull(),
    recordedEffect: text("recorded_effect").notNull(),
    simulatedEffect: text("simulated_effect").notNull(),
    bucket: text("bucket", { enum: POLICY_SIMULATION_BUCKET_VALUES }).notNull(),
    /** the candidate ABAC POLICY that fired on this row. A real
     * `abac_policies` id or null — never a kernel rule id; see below. */
    policyId: uuid("policy_id"),
    /** ADR-0120 — the kernel's `Decision.ruleId` verbatim, whatever shape it
     * takes: a uuid when a stored approval-rule or rate-limit row matched, and
     * a SYMBOLIC id (`default-deny` and its siblings) when the kernel decided
     * without one. It is text rather than uuid because the second case is not
     * a row, and squeezing it into `policy_id` is what made a preview over
     * real traffic fail with 22P02 — on exactly the transcripts the feature
     * exists to serve. */
    decisionRuleId: text("decision_rule_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("policy_simulation_flips_sim_idx").on(t.simulationId),
    index("policy_simulation_flips_user_idx").on(t.userId),
  ],
);

/**
 * The singleton that turns ADR-0040's honest-risks note ("activating without
 * previewing should be friction") into an enforceable posture. OFF by default:
 * an existing deployment activates exactly as it did before. ON, activating a
 * version that no completed simulation has previewed is REFUSED — and either
 * way the activation audit row records whether a preview existed, so the
 * omission is a permanent record rather than a missing one.
 */
export const policySimulationSettings = pgTable("policy_simulation_settings", {
  id: text("id").primaryKey().default("singleton"),
  requirePreviewBeforeActivate: boolean("require_preview_before_activate").notNull().default(false),
  defaultWindowDays: integer("default_window_days").notNull().default(30),
  defaultRowCap: integer("default_row_cap").notNull().default(5000),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PolicySimulationRow = typeof policySimulations.$inferSelect;
export type PolicySimulationFlipRow = typeof policySimulationFlips.$inferSelect;
export type PolicySimulationSettingsRow = typeof policySimulationSettings.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0063 (migration 0075) — REGULAIT_DATA_KEY CUSTODY.
//
// The envelope split (ADR-0035: the key is NOT in the backup) is deliberate and
// correct. What was missing is the custody procedure around it, and its two
// halves live here.
//
// NOTHING IN EITHER TABLE IS SECRET. `fingerprint` is a truncated HMAC-SHA256
// over a fixed domain string, keyed by the data key — a PRF output, not an
// encoding. It is designed to be printed in boot logs and written into backup
// metadata, because a backup artifact that cannot say which key restores it is
// the whole problem.
// ---------------------------------------------------------------------------

/** the fixed id of the `data_key_state` singleton row */
export const DATA_KEY_STATE_ID = "singleton";

/**
 * WHICH KEY THIS DEPLOYMENT'S CIPHERTEXT WAS WRITTEN UNDER.
 *
 * Recorded on the first boot that has a key, compared on every boot after.
 * A mismatch is the restore-onto-a-new-box case and the gateway refuses to
 * start rather than serve an app whose every decryption silently fails.
 */
export const dataKeyState = pgTable(
  "data_key_state",
  {
    id: text("id").primaryKey().default(DATA_KEY_STATE_ID),
    fingerprint: text("fingerprint").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    /** bumped by every boot that matched — "when did a running gateway last
     * prove it holds this key", without reading a log */
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull().defaultNow(),
    /** set only by an explicit operator-declared rotation */
    rotatedFrom: text("rotated_from"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (t) => [check("data_key_state_singleton", sql`${t.id} = 'singleton'`)],
);

/** where an operator says they put the key. Recorded, never verified. */
export const DATA_KEY_ATTESTATION_METHODS = [
  "password_manager",
  "kms",
  "escrow",
  "offline",
  "other",
] as const;
export type DataKeyAttestationMethod = (typeof DATA_KEY_ATTESTATION_METHODS)[number];

/**
 * AN APPEND-ONLY RECORD THAT A NAMED HUMAN SAYS THEY HAVE THE KEY.
 *
 * Be precise about what this is: it records a CLAIM, it does not verify
 * custody — nothing in a server can reach into a password manager. Its value is
 * the converse: the ABSENCE of a claim becomes a fact the product can see and
 * report, on the boot line, in the admin surface and in every backup's own
 * output. An unattested backup is a backup that may not be restorable, and that
 * is now said out loud instead of being discovered during a restore.
 *
 * The fingerprint is stored per row rather than joined to the singleton so that
 * after a rotation an attestation of the OLD key cannot silently appear to
 * cover the new one.
 */
export const dataKeyAttestations = pgTable(
  "data_key_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull(),
    /** nullable so deleting a user cannot erase the attestation itself */
    attestedByUserId: uuid("attested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** captured as text at attestation time, for the same reason */
    attestedByLabel: text("attested_by_label").notNull(),
    method: text("method", { enum: DATA_KEY_ATTESTATION_METHODS }).notNull(),
    /** a NON-SECRET pointer ("1Password vault: Platform Ops"). The API refuses
     * anything that looks like key material. */
    locationHint: text("location_hint"),
    note: text("note"),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("data_key_attestations_fingerprint_idx").on(t.fingerprint, t.attestedAt)],
);

export type DataKeyStateRow = typeof dataKeyState.$inferSelect;
export type DataKeyAttestationRow = typeof dataKeyAttestations.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0063 amendment (migration 0099) — THE KEY RE-ENCRYPTION WALK
// ---------------------------------------------------------------------------

/** `running` is the ONLY status a killed run can be left in — the next
 * invocation with the same from/to keys resumes it. A row that decrypted under
 * NEITHER key forces `completed_with_failures`, never `completed`. */
export const DATA_KEY_REENCRYPTION_STATUSES = [
  "running",
  "completed",
  "completed_with_failures",
] as const;
export type DataKeyReencryptionStatus = (typeof DATA_KEY_REENCRYPTION_STATUSES)[number];

/**
 * One row per re-encryption walk (ADR-0063 §4's named follow-up). Progress is
 * committed in the SAME transaction as each batch's rewritten rows, so "these
 * rows are under the new key" and "the watermark has moved past them" are one
 * atomic fact — the resumability guarantee.
 */
export const dataKeyReencryptionRuns = pgTable(
  "data_key_reencryption_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromFingerprint: text("from_fingerprint").notNull(),
    toFingerprint: text("to_fingerprint").notNull(),
    status: text("status", { enum: DATA_KEY_REENCRYPTION_STATUSES }).notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("data_key_reencryption_runs_status_idx").on(t.status, t.startedAt)],
);

/** per-(run, table, column) watermark + the counters the completion record
 * reports. All thirteen ciphertext-bearing tables key on a uuid `id`. */
export const dataKeyReencryptionProgress = pgTable(
  "data_key_reencryption_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => dataKeyReencryptionRuns.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    /** PK of the last settled row, in uuid order. NULL = not started. */
    watermark: uuid("watermark"),
    done: boolean("done").notNull().default(false),
    rowsReencrypted: integer("rows_reencrypted").notNull().default(0),
    rowsAlreadyCurrent: integer("rows_already_current").notNull().default(0),
    rowsFailed: integer("rows_failed").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("data_key_reencryption_progress_unique").on(t.runId, t.tableName, t.columnName)],
);

/** the id + table of every row that decrypted under neither key — recorded,
 * then walked past. One corrupt row must not brick a rotation, and must never
 * be counted as success. */
export const dataKeyReencryptionFailures = pgTable(
  "data_key_reencryption_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => dataKeyReencryptionRuns.id, { onDelete: "cascade" }),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    rowId: uuid("row_id").notNull(),
    detail: text("detail"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("data_key_reencryption_failures_unique").on(t.runId, t.tableName, t.columnName, t.rowId),
  ],
);

export type DataKeyReencryptionRunRow = typeof dataKeyReencryptionRuns.$inferSelect;
export type DataKeyReencryptionProgressRow = typeof dataKeyReencryptionProgress.$inferSelect;
export type DataKeyReencryptionFailureRow = typeof dataKeyReencryptionFailures.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0064 (migration 0076) — THE IN-PROCESS SCHEDULER
// ---------------------------------------------------------------------------

/** the verdict of one pass. `skipped` is a first-class outcome, not a failure:
 * another instance held the lease, or the job was disabled between the tick and
 * the claim. "The other box ran it" must not look like "nothing ran it". */
export const SCHEDULER_OUTCOMES = ["running", "ok", "failed", "skipped"] as const;
export type SchedulerOutcome = (typeof SCHEDULER_OUTCOMES)[number];

export const SCHEDULER_TRIGGERS = ["schedule", "manual"] as const;
export type SchedulerTrigger = (typeof SCHEDULER_TRIGGERS)[number];

/**
 * One row per registered job — AND the lock.
 *
 * The claim is a short transaction that takes `FOR UPDATE` on this row, checks
 * `enabled`/`next_due_at`/the lease, and writes a lease before committing. Two
 * gateway instances pointed at one database therefore cannot both run the same
 * job: the loser observes the winner's lease and records a `skipped` run.
 * Correctness does not depend on there being exactly one process.
 *
 * `running` is paired with `lease_expires_at` deliberately — a boolean alone
 * would strand a job forever if its holder was SIGKILLed mid-pass.
 */
export const schedulerJobs = pgTable(
  "scheduler_jobs",
  {
    /** the STABLE job id chosen in code (e.g. `mrm-expiry-sweep`), used as the
     * audit ruleId suffix. Text rather than uuid so a run ledger reads as
     * English. */
    name: text("name").primaryKey(),
    /** synced from the code definition on every boot, so the row can never
     * carry a description the code has moved on from */
    description: text("description").notNull().default(""),
    /** which ADR this job discharges */
    adr: text("adr"),
    /** off here = the tick loop skips this job even while the scheduler runs.
     * Defaults on: the SCHEDULER is what is off by default, not the jobs. */
    enabled: boolean("enabled").notNull().default(true),
    /** a plain interval, not a cron expression: a parser is a dependency and an
     * expression is a thing to get wrong, and no sweep here needs "the third
     * Tuesday". An operator who needs wall-clock precision still has the
     * endpoint and their own cron. */
    intervalSeconds: integer("interval_seconds").notNull(),
    /** the single source of "is it due" — read inside the claim transaction, so
     * two instances cannot disagree about it */
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
    lastOutcome: text("last_outcome", { enum: ["ok", "failed", "skipped"] }),
    lastError: text("last_error"),
    lastItemsProcessed: integer("last_items_processed"),
    lastDurationMs: integer("last_duration_ms"),
    running: boolean("running").notNull().default(false),
    /** the per-boot instance id of whoever holds the lease */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    runs: integer("runs").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    /** the number an alert should watch — a job red every night for a month is
     * a different fact from one red row */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("scheduler_jobs_interval_check", sql`${t.intervalSeconds} >= 1`),
    check(
      "scheduler_jobs_last_outcome_check",
      sql`${t.lastOutcome} IS NULL OR ${t.lastOutcome} IN ('ok', 'failed', 'skipped')`,
    ),
  ],
);

/**
 * THE RUN LEDGER — one row per execution ATTEMPT, including the skipped ones.
 *
 * This table exists so that "did the MRM sweep actually run last night, and
 * what did it do?" is answerable from the database rather than from a log
 * someone had to be tailing. A row left at `running` with a NULL `finished_at`
 * and a stale `started_at` is a process that died mid-pass — a diagnosis a
 * design that only wrote the row on success could never offer.
 */
export const schedulerRuns = pgTable(
  "scheduler_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name")
      .notNull()
      .references(() => schedulerJobs.name, { onDelete: "cascade" }),
    /** both triggers go through the SAME claim and the SAME job body, so a
     * "run now" cannot race a scheduled pass */
    trigger: text("trigger", { enum: SCHEDULER_TRIGGERS }).notNull().default("schedule"),
    instanceId: text("instance_id").notNull(),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    outcome: text("outcome", { enum: SCHEDULER_OUTCOMES }).notNull().default("running"),
    /** whatever the job counted — the number that answers "and what did it do?" */
    itemsProcessed: integer("items_processed").notNull().default(0),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
  },
  (t) => [
    check(
      "scheduler_runs_outcome_check",
      sql`${t.outcome} IN ('running', 'ok', 'failed', 'skipped')`,
    ),
    check("scheduler_runs_trigger_check", sql`${t.trigger} IN ('schedule', 'manual')`),
    index("scheduler_runs_job_idx").on(t.jobName, t.startedAt),
    index("scheduler_runs_started_idx").on(t.startedAt),
  ],
);

export type SchedulerJobRow = typeof schedulerJobs.$inferSelect;
export type SchedulerRunRow = typeof schedulerRuns.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0065 (migration 0077) — REGULAIT-LLM: custom-model creation & training.
// ---------------------------------------------------------------------------
//
// The scope sentence, repeated here because a caveat that lives only in a
// migration comment is a caveat nobody reads: these tables record MODEL
// CUSTOMISATION under governance, not a claim to train frontier models. The
// `local` backend really runs — a TF-IDF retrieval index or a logistic-
// regression classifier trained by actual gradient descent, both queryable
// afterwards — and it is labelled with the method it really used. The four
// real remote adapters refuse honestly without a credential.

/** What a training run actually DID. The first two are what this deployment
 * can genuinely produce in-process; the last three are LLM fine-tuning and are
 * reachable only on a credentialed remote backend. */
export const TRAINING_METHODS = [
  "retrieval_index",
  "text_classifier",
  "lora_sft",
  "full_sft",
  "dpo",
] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];

export const TRAINING_BACKEND_KINDS = [
  "local",
  "mock",
  "huggingface",
  "together",
  "bedrock",
  "vertex",
] as const;
export type TrainingBackendKind = (typeof TRAINING_BACKEND_KINDS)[number];

export const TRAINING_DATASET_FORMATS = [
  "prompt_completion",
  "classification",
  "documents",
] as const;
export type TrainingDatasetFormat = (typeof TRAINING_DATASET_FORMATS)[number];

/** `refused` is TERMINAL and deliberately distinct from `failed`: "we never
 * tried, because nothing was configured" and "we tried and it broke" are
 * different facts about a model, and collapsing them is how a credential-less
 * backend comes to look like a flaky one. */
export const TRAINING_JOB_STATUSES = [
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "refused",
] as const;
export type TrainingJobStatus = (typeof TRAINING_JOB_STATUSES)[number];

export const TRAINING_SCAN_VERDICTS = ["clean", "flagged", "blocked"] as const;
export type TrainingScanVerdict = (typeof TRAINING_SCAN_VERDICTS)[number];

/**
 * THE IMMUTABLE, VERSIONED, PII-SCANNED CORPUS.
 *
 * `(id, version)` is UNIQUE so `training_jobs` can carry a real composite FK at
 * it — the same mechanism `eval_datasets`/`eval_runs` use (ADR-0044), for the
 * same reason: a claim about a model is worthless if the data behind it can be
 * edited after the claim was made. Editing a version mints the next one.
 */
export const trainingDatasets = pgTable(
  "training_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    note: text("note"),
    format: text("format", { enum: TRAINING_DATASET_FORMATS }).notNull().default("prompt_completion"),
    rowCount: integer("row_count").notNull().default(0),
    /** total characters across every row — the cost estimator's input, so
     * "is this expensive?" is answerable before the job rather than after */
    charCount: integer("char_count").notNull().default(0),
    checksum: text("checksum").notNull().default(""),
    /** the ADR-0042 / §8.4 INGEST verdict, kept on the data rather than only in
     * an audit row that will have scrolled away by the time anyone asks */
    piiVerdict: text("pii_verdict", { enum: TRAINING_SCAN_VERDICTS }).notNull().default("clean"),
    /** the mode actually in force, AFTER MAX-composition with the project's
     * compliance floor — "why was this accepted?" is unanswerable without it */
    piiMode: text("pii_mode", { enum: GUARDRAIL_MODES }).notNull().default("block"),
    /** COUNTS ONLY. Never matched text — the same contract every detector
     * surface in this product honours. */
    scanFindings: jsonb("scan_findings").$type<Record<string, unknown>>().notNull().default({}),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("training_datasets_name_version_uq").on(t.name, t.version),
    // THE COMPOSITE FK TARGET — the whole immutability mechanism
    unique("training_datasets_id_version_uq").on(t.id, t.version),
    check("training_datasets_version_check", sql`${t.version} >= 1`),
  ],
);

export const trainingDatasetRows = pgTable(
  "training_dataset_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id").notNull(),
    /** a row belongs to a dataset VERSION, not a dataset — which is what makes
     * minting v2 a copy rather than an edit */
    datasetVersion: integer("dataset_version").notNull(),
    idx: integer("idx").notNull(),
    input: text("input").notNull(),
    /** NULL is legal for the `documents` format: retrieval material has nothing
     * to predict, and inventing a label there would be the first lie */
    output: text("output"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "training_dataset_rows_dataset_fk",
      columns: [t.datasetId, t.datasetVersion],
      foreignColumns: [trainingDatasets.id, trainingDatasets.version],
    }).onDelete("cascade"),
    unique("training_dataset_rows_idx_uq").on(t.datasetId, t.datasetVersion, t.idx),
    index("training_dataset_rows_version_idx").on(t.datasetId, t.datasetVersion, t.idx),
  ],
);

/** Where a REAL backend's credential and endpoint live. Registration is not
 * enablement (the ADR-0034 posture, verbatim): nothing is contacted until an
 * admin enables it, and the base URL is adjudicated by the egress guard on
 * write AND on every use. */
export const trainingBackendConfigs = pgTable(
  "training_backend_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backend: text("backend", { enum: TRAINING_BACKEND_KINDS }).notNull().unique(),
    enabled: boolean("enabled").notNull().default(false),
    baseUrl: text("base_url"),
    /** AES-256-GCM under REGULAIT_DATA_KEY. Write-only; no route returns it. */
    keyCiphertext: text("key_ciphertext"),
    /** ADR-0175 A7 (migration 0142): when the secret was last set, stamped by
     * the `regulait_stamp_secret_set` trigger. NULL = set before 0142 (unknown). */
    secretSetAt: timestamp("secret_set_at", { withTimezone: true }),
    allowPlaintextHttp: boolean("allow_plaintext_http").notNull().default(false),
    /** non-secret per-backend settings: a region, a project id, a namespace */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestError: text("last_test_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const trainingJobs = pgTable(
  "training_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    datasetId: uuid("dataset_id").notNull(),
    /** kept honest by the composite FK below, never by convention */
    datasetVersion: integer("dataset_version").notNull(),
    backend: text("backend", { enum: TRAINING_BACKEND_KINDS }).notNull(),
    /** WHAT WAS ACTUALLY DONE — how a reader tells a retrieval index from a
     * fine-tune without trusting a label somebody typed */
    method: text("method", { enum: TRAINING_METHODS }).notNull(),
    /** NULL for a local retrieval index, which derives from no model at all */
    baseModel: text("base_model"),
    /** the registry agent this customisation is ANCHORED to: whose entitlement
     * gated the job, and whose tier the artifact inherits when registered */
    baseAgentId: uuid("base_agent_id").references(() => agents.id, { onDelete: "set null" }),
    hyperparameters: jsonb("hyperparameters").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: TRAINING_JOB_STATUSES }).notNull().default("queued"),
    progress: doublePrecision("progress").notNull().default(0),
    externalJobId: text("external_job_id"),
    error: text("error"),
    /** what the approval gate compared against BEFORE the job ran */
    estimatedCostUsd: doublePrecision("estimated_cost_usd").notNull().default(0),
    /** what actually landed in `usage_events`. Keeping both is what makes "the
     * estimate was wrong" a visible fact rather than a lost one. */
    costUsd: doublePrecision("cost_usd"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** the ONE Approvals Queue row gating an over-threshold job. NULL = under
     * threshold, no approval was ever required. */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    foreignKey({
      name: "training_jobs_dataset_fk",
      columns: [t.datasetId, t.datasetVersion],
      foreignColumns: [trainingDatasets.id, trainingDatasets.version],
    }).onDelete("restrict"),
    check("training_jobs_progress_check", sql`${t.progress} >= 0 AND ${t.progress} <= 1`),
    index("training_jobs_status_idx").on(t.status, t.createdAt),
    index("training_jobs_dataset_idx").on(t.datasetId, t.datasetVersion),
    /** ADR-0109 (migration 0108): ONE queue row gates ONE job.
     * `applyTrainingJobApprovalDecision` reads by `approval_id` and cancels or
     * releases the job it finds. Partial: NULL = under threshold, no approval
     * was ever required, which is the common case. */
    uniqueIndex("training_jobs_approval_uq")
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
  ],
);

export const trainingArtifacts = pgTable(
  "training_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => trainingJobs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    method: text("method", { enum: TRAINING_METHODS }).notNull(),
    baseModel: text("base_model"),
    /** inline = the artifact IS `payload` and is queryable in-process (what the
     * local backend produces). remote = it lives at `location` on the backend
     * and cannot be queried here, which the API says rather than pretends. */
    kind: text("kind", { enum: ["inline", "remote"] }).notNull().default("inline"),
    /** the real, queryable model: the TF-IDF index or the learned weights.
     * jsonb because it IS structured data and a reader should be able to see
     * the vocabulary a model learned. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    location: text("location"),
    /** whatever the trainer MEASURED. Never a figure nothing computed. */
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
    /** the registry agent this was registered as, so the platform dispatches to
     * it through the ordinary governed path */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** ADR-0045: a home-trained model is subject to the MRM gate exactly like a
     * vendor one, and this is the card carrying its risk position */
    modelCardId: uuid("model_card_id").references(() => modelCards.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("training_artifacts_job_uq").on(t.jobId),
    index("training_artifacts_agent_idx").on(t.agentId),
  ],
);

export type TrainingDatasetRow = typeof trainingDatasets.$inferSelect;
export type TrainingDatasetRowRow = typeof trainingDatasetRows.$inferSelect;
export type TrainingBackendConfigRow = typeof trainingBackendConfigs.$inferSelect;
export type TrainingJobRow = typeof trainingJobs.$inferSelect;
export type TrainingArtifactRow = typeof trainingArtifacts.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0066 (migration 0078) — GATEWAY PARITY: virtual keys and fallback chains.
// ---------------------------------------------------------------------------

/** The `rglv_` prefix is what makes a virtual key visibly NOT an ordinary
 * `rgl_` API key in a log line, a `.env` file or a screenshot. Both hash with
 * the same sha256 and neither is ever stored in plaintext. */
export const VIRTUAL_KEY_PREFIX = "rglv_";

/**
 * ADR-0066 §2 — A VIRTUAL KEY: an issued credential that resolves to an
 * upstream vendor credential the holder never sees, and that can only ever
 * NARROW its owner's entitlements.
 *
 * The ceiling invariant, which is the whole point of the table: a dispatch on
 * this key is allowed iff the OWNING USER is entitled to the served agent AND
 * the key's own allow-list admits it. `allowedModels` can therefore never
 * widen anything — it is intersected with, not substituted for, the policy
 * kernel's answer. A key that lists a model its owner was never granted still
 * denies, and `gateway-parity.test.ts` asserts exactly that.
 *
 * Deliberately a SEPARATE TABLE from `api_keys` rather than nullable columns on
 * it: an ordinary API key IS the user (it carries their admin-ness and reaches
 * every route they may), and a virtual key is a scoped, budgeted, expiring
 * proxy that reaches only the dispatch surfaces. Conflating them would have
 * made every existing `api_keys` read a place where a caller could forget to
 * check a budget.
 */
export const virtualKeys = pgTable(
  "virtual_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** operator-chosen label — what appears in the portal and the audit row */
    name: text("name").notNull(),
    /** the human whose entitlements are this key's CEILING. Cascade: a deleted
     * user's keys are meaningless, and leaving them would leave a credential
     * with no ceiling to intersect against. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 of the issued token, exactly as `api_keys.token_hash`. The token
     * itself is returned ONCE, at creation, and is not recoverable. */
    tokenHash: text("token_hash").notNull().unique(),
    /** NULL = no per-key model restriction (the owner's entitlements alone are
     * the ceiling). A non-empty list admits a dispatch whose served agent
     * matches by provider-native model id OR by agent id — the two things a
     * client can actually name, so a key issued against `GET /v1/models`
     * output and a key issued against an agent id both work. */
    /** ADR-0127/AER-027 (migration 0117) — WHICH ROUTES THIS KEY MAY REACH.
     * 'dispatch' is ADR-0066's model surfaces and is the default, so every
     * pre-0117 row is unchanged. 'pdp' reaches `POST /v1/authz/check` and
     * NOTHING ELSE: the credential a data-plane proxy holds to ask
     * authorization questions, which before this could only be an admin API
     * key — making proxy compromise equivalent to control-plane admin. The
     * separation runs BOTH ways: a pdp key cannot dispatch either. */
    purpose: text("purpose").notNull().default("dispatch").$type<"dispatch" | "pdp">(),
    allowedModels: jsonb("allowed_models").$type<string[]>(),
    /** NULL = no per-key budget. When set, spend is enforced BEFORE dispatch
     * against `spent_usd`; the first crossing is allowed (measured cost is only
     * knowable after the call) and every call after it is refused 402. */
    budgetUsd: doublePrecision("budget_usd"),
    /** running MEASURED spend on this key, incremented from the same costUsd
     * that lands in `usage_events`. An unpriced agent adds 0 rather than an
     * invented figure — and `usage_events.virtual_key_id` remains the ledger
     * of record, this column being the enforcement counter. */
    spentUsd: doublePrecision("spent_usd").notNull().default(0),
    /** the PLATFORM credential this key proxies to. NULL = the ordinary
     * resolution chain applies (owner's BYO credential → platform → env).
     * When set, that one credential is pinned for every dispatch on this key,
     * and a served agent whose provider does not match is refused rather than
     * quietly falling through to a different key. */
    upstreamCredentialId: uuid("upstream_credential_id").references(() => modelCredentials.id, {
      onDelete: "restrict",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("virtual_keys_user_idx").on(t.userId),
    check("virtual_keys_budget_check", sql`${t.budgetUsd} IS NULL OR ${t.budgetUsd} >= 0`),
  ],
);

/**
 * ADR-0066 §4 — AN ORDERED PROVIDER FALLBACK CHAIN, per agent.
 *
 * A row says: "when `agent_id` fails at the TRANSPORT layer, try
 * `fallback_agent_id` next." Deliberately agent→agent rather than
 * agent→provider: entitlement in this system is granted on AGENTS, so a chain
 * expressed in providers would name hops the policy kernel has no opinion
 * about, and re-evaluating entitlement per hop — the property that makes this
 * safe — would be impossible.
 *
 * A hop is NOT a widening. Every hop runs the caller's own `evaluateAgent`
 * again, from scratch; a hop the caller is not entitled to is skipped and
 * audited, never inherited from the first hop's decision.
 */
export const agentFallbacks = pgTable(
  "agent_fallbacks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    fallbackAgentId: uuid("fallback_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** 0-based order the chain is attempted in */
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_fallbacks_position_uq").on(t.agentId, t.position),
    uniqueIndex("agent_fallbacks_target_uq").on(t.agentId, t.fallbackAgentId),
    // a chain that starts by trying the agent it is a chain FOR is an infinite
    // loop expressed as data; refuse it in the database, not only in a handler
    check("agent_fallbacks_no_self_check", sql`${t.agentId} <> ${t.fallbackAgentId}`),
    index("agent_fallbacks_agent_idx").on(t.agentId, t.position),
  ],
);

export type VirtualKeyRow = typeof virtualKeys.$inferSelect;
export type AgentFallbackRow = typeof agentFallbacks.$inferSelect;

// ===========================================================================
// ADR-0069 — CROSS-VENDOR COST CONSOLIDATION (migration 0081)
//
// The gap this closes: `usage_events` is a METERED ledger — every row is a call
// RegulAIt itself intercepted, entitled, dispatched and priced. Spend that
// never touched the gateway (per-seat SaaS like Claude Code or Copilot, a raw
// vendor key used outside RegulAIt, a Bedrock line on a cloud bill) had nowhere
// to live at all, so a per-person chargeback figure was structurally impossible
// no matter how good the metering was.
//
// THE ONE RULE THESE TABLES ENFORCE STRUCTURALLY. Imported money lives in a
// DIFFERENT TABLE from metered money, and `imported_cost_lines.basis` carries a
// CHECK constraint admitting the single value 'imported'. There is therefore no
// row anywhere that could be read as metered when it was not — not by a buggy
// query, not by a future writer, not by an operator with psql. The distinction
// is a schema property, not a convention.
//
// WHAT AN IMPORT CAN WRITE, EXHAUSTIVELY: one `cost_import_batches` row and its
// `imported_cost_lines`. No schema below has a field naming a role, a grant, an
// entitlement, an agent, an approval or a budget; `resolved_user_id` can only
// ever point at a user that ALREADY EXISTS, and the alias/domain-rule rows that
// can make that pointer are admin-authored, never file-supplied.
// ===========================================================================

/**
 * Every import — planned, applied AND REFUSED. The refusals are the rows that
 * matter, exactly as in `shadow_ai_imports` and `onboarding_imports`: an
 * operator has to be able to find "somebody uploaded a July invoice twice" or
 * "somebody uploaded a file whose amount column was in cents" months later.
 *
 * `rows_parsed = rows_accepted + rows_refused` ALWAYS. That identity is the
 * whole claim that nothing was silently dropped, and it is asserted in the
 * suite rather than merely intended.
 */
export const costImportBatches = pgTable(
  "cost_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    vendor: text("vendor").notNull(),
    format: text("format", { enum: ["csv", "json"] }).notNull(),
    mode: text("mode", { enum: ["dry_run", "apply"] }).notNull(),
    status: text("status", { enum: ["planned", "applied", "refused", "revoked"] }).notNull(),
    /** a filename or a sentence about where the file came from — provenance a
     * human wrote, kept beside the fingerprint of what actually arrived */
    source: text("source"),
    /** fingerprint of the exact bytes parsed. The partial unique index below
     * makes a re-apply of the SAME bytes a refusal rather than a double count. */
    payloadSha256: text("payload_sha256").notNull(),
    rowsParsed: integer("rows_parsed").notNull().default(0),
    rowsAccepted: integer("rows_accepted").notNull().default(0),
    rowsRefused: integer("rows_refused").notNull().default(0),
    /** the window the accepted lines actually span — derived from the rows, not
     * asserted by the uploader */
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /** null whenever the batch carries more than one currency: there is no
     * honest single total for a mixed-currency file and RegulAIt does no FX */
    totalUsd: doublePrecision("total_usd"),
    /** every per-row refusal, each with its file line number and reason */
    refusals: jsonb("refusals").$type<Array<Record<string, unknown>>>().notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    /** ADR-0042/§8.4: the ingest scan verdict + COUNTS ONLY, never a match */
    piiMode: text("pii_mode"),
    scanVerdict: text("scan_verdict", { enum: ["clean", "flagged", "blocked"] }),
    scanFindings: jsonb("scan_findings").$type<Record<string, unknown>>(),
    ruleId: text("rule_id").notNull(),
    reason: text("reason").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("cost_import_batches_created_idx").on(t.createdAt),
    index("cost_import_batches_status_idx").on(t.status),
    index("cost_import_batches_vendor_idx").on(t.vendor),
    check(
      "cost_import_batches_row_identity_check",
      sql`${t.rowsParsed} = ${t.rowsAccepted} + ${t.rowsRefused}`,
    ),
  ],
);

/**
 * THE RESTATED LINES. One row per accepted line of a customer's export.
 *
 * `basis` is CHECK-constrained to 'imported' and exists precisely so the
 * distinction cannot be lost in a join, a view, a CSV or a future refactor. A
 * consolidated figure that blended these into `usage_events` would be the exact
 * dishonesty ADR-0069 exists to prevent, and the constraint is the cheapest
 * possible structural guard against it.
 *
 * `resolved_user_id` is FK'd with ON DELETE SET NULL: deleting a user must
 * un-attribute their imported spend, never delete the spend. The money was
 * real whether or not the person is still on the roster.
 */
export const importedCostLines = pgTable(
  "imported_cost_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => costImportBatches.id, { onDelete: "cascade" }),
    /** ALWAYS 'imported'. See the CHECK below. */
    basis: text("basis").notNull().default("imported"),
    vendor: text("vendor").notNull(),
    adapter: text("adapter").notNull(),
    /** the 1-based line number in the uploaded file — the traceability anchor
     * for a disputed chargeback */
    sourceRow: integer("source_row").notNull(),
    /** the vendor account identifier EXACTLY as the file spelled it */
    accountRef: text("account_ref").notNull(),
    /** trimmed + lowercased; the join key resolution runs against */
    accountKey: text("account_key").notNull(),
    resolvedUserId: uuid("resolved_user_id").references(() => users.id, { onDelete: "set null" }),
    /** HOW the match was made — exact_email | admin_alias | domain_rule |
     * unresolved. A chargeback nobody can trace to a rule is a chargeback
     * nobody can defend, so this is NOT NULL. */
    resolutionMethod: text("resolution_method", {
      enum: ["exact_email", "admin_alias", "domain_rule", "unresolved"],
    }).notNull(),
    resolutionDetail: text("resolution_detail").notNull(),
    resolutionMappingId: uuid("resolution_mapping_id"),
    resolutionDomainRuleId: uuid("resolution_domain_rule_id"),
    /** a cost centre the FILE asserted. The resolved user's own `cost_center`
     * is the lower-precedence fallback and is resolved at read time, so an
     * admin correcting a person's cost centre restates history correctly
     * instead of leaving every already-imported line stale. */
    costCenter: text("cost_center"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amount: doublePrecision("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    billingKind: text("billing_kind", { enum: ["seat", "usage", "commit", "other"] }).notNull(),
    service: text("service"),
    description: text("description"),
    quantity: doublePrecision("quantity"),
    unit: text("unit"),
    /** bounded, adapter-authored structured notes (e.g. seat_roster's
     * "derivedFrom: operator-asserted seat price"). Never a dump of the row. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // --- ADR-0076 (migration 0085): the supersession mark -------------------
    // NULL everywhere = the line is live and counts. A reconciliation pass that
    // finds a NEWER batch restating the same vendor fact MARKS the older copy
    // here — never deletes it: the row is the evidence of what the older file
    // said and of what every pre-reconciliation read reported. The CHECK below
    // makes a mark without a reason impossible.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByLineId: uuid("superseded_by_line_id"),
    supersededRunId: uuid("superseded_run_id"),
    supersededReason: text("superseded_reason"),
  },
  (t) => [
    index("imported_cost_lines_batch_idx").on(t.batchId),
    index("imported_cost_lines_user_idx").on(t.resolvedUserId, t.periodStart),
    index("imported_cost_lines_period_idx").on(t.periodStart, t.periodEnd),
    index("imported_cost_lines_account_idx").on(t.accountKey),
    // THE HONESTY SPINE, AS A CONSTRAINT. Nothing can ever store a line here
    // that claims to have been metered.
    check("imported_cost_lines_basis_check", sql`${t.basis} = 'imported'`),
    check("imported_cost_lines_period_check", sql`${t.periodEnd} > ${t.periodStart}`),
    // an unresolved line must carry no user, and a resolved one must carry one:
    // the pair is what makes "unattributed" a real, countable state rather than
    // a null that might mean anything
    check(
      "imported_cost_lines_resolution_check",
      sql`(${t.resolutionMethod} = 'unresolved') = (${t.resolvedUserId} IS NULL)`,
    ),
    // ADR-0076: a supersession mark without a reason is an exclusion nobody can
    // audit; a pointer or run id without a mark is a half-written state; and a
    // line can never supersede itself
    check(
      "imported_cost_lines_supersession_check",
      sql`((${t.supersededAt} IS NULL) = (${t.supersededReason} IS NULL)) AND (${t.supersededAt} IS NOT NULL OR ${t.supersededByLineId} IS NULL) AND (${t.supersededAt} IS NOT NULL OR ${t.supersededRunId} IS NULL) AND (${t.supersededByLineId} IS NULL OR ${t.supersededByLineId} <> ${t.id})`,
    ),
  ],
);

/**
 * ADR-0076 (migration 0085) — THE RECONCILIATION RUN LEDGER.
 *
 * One row per reconciliation pass over `imported_cost_lines`, whether an
 * operator pressed "run now" or the ADR-0064 scheduler ticked. Open-first like
 * `scheduler_runs`: a row stuck at 'running' with a stale `started_at` IS the
 * diagnosis of a process that died mid-pass. `warnings` carries the bounded,
 * structured report of what was deliberately NOT touched — ambiguous
 * multiplicities and overlapping-but-not-identical windows — because a
 * reconciliation that refuses to guess must say what it refused.
 */
export const costReconciliationRuns = pgTable(
  "cost_reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: text("trigger", { enum: ["manual", "schedule"] }).notNull().default("manual"),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome", { enum: ["running", "ok", "failed"] }).notNull().default("running"),
    scannedLines: integer("scanned_lines").notNull().default(0),
    duplicateGroups: integer("duplicate_groups").notNull().default(0),
    supersededLines: integer("superseded_lines").notNull().default(0),
    ambiguousGroups: integer("ambiguous_groups").notNull().default(0),
    overlapWarnings: integer("overlap_warnings").notNull().default(0),
    warnings: jsonb("warnings").$type<Array<Record<string, unknown>>>().notNull().default([]),
    error: text("error"),
  },
  (t) => [
    index("cost_reconciliation_runs_started_idx").on(t.startedAt),
    check("cost_reconciliation_runs_trigger_check", sql`${t.trigger} IN ('manual', 'schedule')`),
    check("cost_reconciliation_runs_outcome_check", sql`${t.outcome} IN ('running', 'ok', 'failed')`),
  ],
);

/**
 * AN ADMIN-ASSERTED ALIAS: "this vendor account is this person."
 *
 * The only way a non-email account identifier (an AWS account id, a vendor's
 * internal user id) ever attributes to a human, and the correction path when a
 * mechanical match is wrong. `reason` is NOT NULL because an assertion nobody
 * has to justify is an assertion nobody can review; every create and delete
 * also writes an `audit_log` row.
 *
 * `vendor = '*'` means "any vendor". A vendor-specific alias beats it.
 */
export const vendorAccountAliases = pgTable(
  "vendor_account_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendor: text("vendor").notNull().default("*"),
    /** normalized (trimmed + lowercased) */
    accountKey: text("account_key").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vendor_account_aliases_uq").on(t.vendor, t.accountKey),
    index("vendor_account_aliases_user_idx").on(t.userId),
  ],
);

/**
 * A DOMAIN REWRITE RULE: "an account at `from_domain` is the person with the
 * same local part at `to_domain`."
 *
 * The realistic case is a company whose vendor seats are billed against
 * `@acme-corp.com` while its RegulAIt directory is `@acme.com`. It is a RULE,
 * not a guess: the rewritten address must match an existing user exactly, and
 * two rules that produce two different people produce NO match at all (see
 * `resolveVendorAccount`). Lossy by nature, so every line records which rule
 * matched it.
 */
export const vendorDomainRules = pgTable(
  "vendor_domain_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendor: text("vendor").notNull().default("*"),
    fromDomain: text("from_domain").notNull(),
    toDomain: text("to_domain").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("vendor_domain_rules_uq").on(t.vendor, t.fromDomain, t.toDomain),
    check("vendor_domain_rules_distinct_check", sql`lower(${t.fromDomain}) <> lower(${t.toDomain})`),
  ],
);

export type CostImportBatchRow = typeof costImportBatches.$inferSelect;
export type ImportedCostLineRow = typeof importedCostLines.$inferSelect;
export type VendorAccountAliasRow = typeof vendorAccountAliases.$inferSelect;
export type VendorDomainRuleRow = typeof vendorDomainRules.$inferSelect;
export type CostReconciliationRunRow = typeof costReconciliationRuns.$inferSelect;

// ===========================================================================
// ADR-0070 (migration 0082) — TRACE / SPAN OBSERVABILITY
//
// The SHAPE that was missing, over facts that already existed. Read the
// migration header before changing anything here; the two invariants that
// matter are repeated on the columns that hold them:
//
//   1. A span REFERENCES `usage_events` / `audit_log` / a run / a node. It
//      does not restate them. The only denormalised fields are the five a
//      tree view must render without an N+1 (`provider`, `model`, tokens,
//      `cost_usd`), each written FROM the referenced row in the same call.
//   2. A governance DENY is a PRESENT span with `status = 'denied'` and a
//      `statusReason`. It is never an absent one.
// ===========================================================================

/** what kind of thing a trace is the tree of */
export const TRACE_KINDS = ["dispatch", "run", "workflow", "conversation", "tool", "eval"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** `denied` is deliberately NOT a flavour of `error`: an entitlement refusal,
 * a PII or guardrail block, an exhausted budget and an egress refusal are
 * DECISIONS, and the trace exists to show them as such. */
export const TRACE_STATUSES = ["running", "ok", "error", "denied"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const TRACE_SPAN_KINDS = [
  /** an orchestration run (ADR-0053) — the container */
  "run",
  /** one node of that run's DAG */
  "run_node",
  /** one governed model dispatch attempt */
  "llm",
  /** ADR-0066 §4 — a fallback hop, recorded as a CHILD of the attempt that
   * failed, so "which model actually answered, and why not the one I asked
   * for" reads off the tree rather than out of the audit log */
  "fallback_hop",
  /** a governed MCP tool call */
  "tool",
  /** a governed connector call (`POST /v1/connectors/:id/invoke`) */
  "connector",
  /** a pillar-1 entitlement/policy decision recorded on its own */
  "policy",
  /** one workflow-instance state transition (ADR-0021/0027) */
  "workflow_stage",
  /** one case of an eval run (ADR-0044/0067) */
  "eval_case",
] as const;
/**
 * EVERY KIND IN THIS LIST IS WRITTEN BY A REAL PATH, and
 * `apps/gateway/src/tracing.test.ts` enumerates the list and proves it. A
 * declared kind nothing emits is a vocabulary promising coverage the product
 * does not have, which is the same class of dishonesty this repo keeps fixing.
 *
 * `guardrail` WAS declared here and was REMOVED on 2026-08-15 (ADR-0070
 * amendment) rather than given a writer. Nothing ever wrote it, and ADR-0070's
 * own disclosure of the unwritten kinds did not even name it. It is removed
 * instead of emitted because an ADR-0042 verdict is not a call that was
 * ATTEMPTED — it is a property OF one, and it is already on the span it acted
 * on: the verdict rides `attributes.guardrails`, a withholding rides
 * `content_withheld`, and a BLOCK *is* that span's `denied` status with
 * `guardrail_blocked` as its reason. A child `guardrail` span would restate
 * what the parent already says and would double-count the refusal in
 * `traces.denied_span_count` — i.e. exactly the "a span REFERENCES, it does not
 * restate" rule the ADR is built on, and exactly the "a span on every
 * governance evaluation" alternative it rejected.
 *
 * The migration-0082 CHECK constraint still PERMITS 'guardrail'; that is
 * deliberate and needs no migration. A CHECK is a bound on what may be
 * written, not a claim about what is — and narrowing it would cost a schema
 * migration for no behavioural change.
 */
export type TraceSpanKind = (typeof TRACE_SPAN_KINDS)[number];

export const traces = pgTable(
  "traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SESSION/THREAD GROUPING. A multi-turn conversation is one session id
     * across many traces; a long-running workflow is another. NULL = a
     * one-shot trace belonging to no session. */
    sessionId: text("session_id"),
    kind: text("kind", { enum: TRACE_KINDS }).notNull(),
    /** the id of the thing this is the trace OF, in ITS table. FK-free. */
    rootRefId: text("root_ref_id"),
    name: text("name").notNull(),
    /** whose trace this is. Reading it is default-deny and entitlement-gated
     * on exactly this column (ADR-0069's `/v1/users/:userId/cost-consolidated`
     * precedent): self, or an entitled admin, never "any authenticated user". */
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id"),
    status: text("status", { enum: TRACE_STATUSES }).notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    /** rollups maintained as spans land, so the LIST view is one query rather
     * than a fan-out over every span of every trace on the page */
    spanCount: integer("span_count").notNull().default(0),
    deniedSpanCount: integer("denied_span_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** null = nothing under this trace was priced. Never an invented figure. */
    costUsd: doublePrecision("cost_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("traces_user_started_idx").on(t.userId, t.startedAt),
    index("traces_session_idx").on(t.sessionId, t.startedAt),
    index("traces_project_idx").on(t.projectId, t.startedAt),
    index("traces_root_idx").on(t.kind, t.rootRefId),
    index("traces_started_idx").on(t.startedAt),
  ],
);

export const traceSpans = pgTable(
  "trace_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    /** self-reference; NULL = a root span of this trace */
    parentSpanId: uuid("parent_span_id"),
    /** DETERMINISTIC SIBLING ORDER. Millisecond timestamps collide on a fast
     * in-process path, and a tree whose children reorder between two reads is
     * not a trace. Every read orders by (parentSpanId, seq). */
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: TRACE_SPAN_KINDS }).notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: TRACE_STATUSES }).notNull().default("running"),
    /** WHY. On a denied span this is the governance reason verbatim. */
    statusReason: text("status_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),

    // --- references, not copies ------------------------------------------
    /** the `usage_events` row this span's cost/token figures were copied FROM.
     * The reconciliation test joins on this and asserts equality. */
    usageEventId: uuid("usage_event_id"),
    /** the `audit_log` row carrying the governance decision, when one exists */
    auditLogId: uuid("audit_log_id"),
    runId: uuid("run_id"),
    nodeId: text("node_id"),
    agentId: uuid("agent_id"),
    mcpServerId: uuid("mcp_server_id"),
    connectorId: uuid("connector_id"),

    // --- denormalised for tree rendering (justified in ADR-0070) ----------
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),

    // --- content, through the EXISTING ADR-0042/§8.4 posture --------------
    inputPreview: text("input_preview"),
    outputPreview: text("output_preview"),
    /** true = what is stored is a withheld marker, not the text. Recorded so a
     * reader is never left guessing whether a short preview is short because
     * the answer was short. */
    contentWithheld: boolean("content_withheld").notNull().default(false),

    attributes: jsonb("attributes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trace_spans_trace_idx").on(t.traceId, t.seq),
    index("trace_spans_parent_idx").on(t.parentSpanId),
    index("trace_spans_usage_idx").on(t.usageEventId),
    index("trace_spans_run_idx").on(t.runId),
    /** ADR-0109 (migration 0108) — and note this table appears in BOTH of
     * ADR-0107's tables without contradiction, because the two sites have
     * different predicates. `closeRunSpan` reads `(trace_id, kind='run')` with
     * NO run id: a trace can legitimately carry more than one run span, so that
     * read is genuinely multi-row and keeps ADR-0107's `asc(seq), asc(id)`.
     * `ensureRunSpan` reads `(trace_id, kind='run', run_id)` — an
     * insert-if-absent guard naming ONE run — and THAT is what this index makes
     * provably single. `run_id` is excluded where null: a run-kind span with no
     * run id carries no identity to be unique on. */
    uniqueIndex("trace_spans_run_uq")
      .on(t.traceId, t.runId)
      .where(sql`${t.kind} = 'run' AND ${t.runId} IS NOT NULL`),
  ],
);

export type TraceRow = typeof traces.$inferSelect;
export type TraceSpanRow = typeof traceSpans.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0080 — THE AI USE-CASE REGISTRY (the L1 pre-build front-door).
// A proposed AI use case is a governed OBJECT, not paperwork: `complianceTags`
// carries the SAME vocabulary the §8.3 cascade enforces (compliance_profiles
// .tag / projects.classifications), and `status` reaches approved/rejected
// ONLY through the linked pillar-2 intake instance's decision on the ONE
// approvals queue — the gateway refuses any direct status write.
// ---------------------------------------------------------------------------

export const AI_USE_CASE_STATUSES = [
  "proposed",
  "under_review",
  /** ADR-0168 (migration 0129): a reviewer SENT the intake back for
   * information — the instance rests at its questionnaire stage until a new
   * version is submitted, which re-requests the sign-off */
  "needs_info",
  "approved",
  "rejected",
  "retired",
] as const;
export type AiUseCaseStatus = (typeof AI_USE_CASE_STATUSES)[number];

export const AI_USE_CASE_SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "regulated",
] as const;

/** ADR-0085 — mirrors `EU_AI_ACT_TIERS` in @regulait/shared (kept literal
 * here so the schema package stays dependency-free of shared) */
export const EU_AI_ACT_TIER_VALUES = ["prohibited", "high", "limited", "minimal"] as const;

export const aiUseCases = pgTable(
  "ai_use_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** why the business wants this — the intake's anchor sentence(s) */
    businessContext: text("business_context").notNull(),
    /** REFERENCES, not copies: agent ids validated at propose time; jsonb so
     * the registry row survives a later agent deletion */
    intendedAgentIds: jsonb("intended_agent_ids").$type<string[]>().notNull().default([]),
    dataSensitivity: text("data_sensitivity", { enum: AI_USE_CASE_SENSITIVITIES }).notNull(),
    /** THE DIFFERENTIATOR: the same tags the cascade enforces — what
     * `complianceProfilesForTags`/`effectiveCompliancePolicy` resolve */
    complianceTags: jsonb("compliance_tags").$type<string[]>().notNull().default([]),
    /** nullable: a use case may be proposed before any project exists for it */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: text("status", { enum: AI_USE_CASE_STATUSES }).notNull().default("proposed"),
    /** the pillar-2 intake instance that governs this use case's approval */
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, {
      onDelete: "set null",
    }),
    /** ADR-0085 (migration 0089) — the EU AI Act SCREENING result, computed
     * SERVER-SIDE by the shared frozen rule set from the structured answers
     * inside the questionnaire artifact. All three columns are set together
     * (or all null = not screened); the tier INFORMS the sign-off — nothing
     * anywhere auto-blocks on it. */
    euAiActTier: text("eu_ai_act_tier", { enum: EU_AI_ACT_TIER_VALUES }),
    euAiActReasons: jsonb("eu_ai_act_reasons").$type<
      Array<{ ruleId: string; tier: string; ref: string; reason: string }>
    >(),
    euAiActRulesetVersion: integer("eu_ai_act_ruleset_version"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** ADR-0168 (migration 0129) — AN APPROVAL HAS A LIFETIME. Both set
     * together by the approving sign-off (`syncUseCaseForInstance`):
     * high/prohibited/unscreened tier → +6 months, minimal/limited → +12.
     * Enforced at the deploy gate (`approval_expired`); not swept yet. */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedUntil: timestamp("approved_until", { withTimezone: true }),
    /** ADR-0168 amendment (migration 0131): true while an approval that
     * EXPIRED is back in review — set by the recertification sweep, cleared
     * by the next approve/reject decision. */
    recertification: boolean("recertification").notNull().default(false),
    /** ADR-0168 amendment (migration 0131): every Classify-step answer
     * (flat: EU AI Act answers + intake context), kept for resubmission
     * prefill. NULL = registered without them. Never an input to the tier. */
    intakeAnswers: jsonb("intake_answers").$type<Record<string, unknown>>(),
    /** ADR-0171 / AER-052 (migration 0134): the owner's "why it applies" per
     * framework, keyed by compliance tag (every key is one of
     * `complianceTags`). Shown to reviewers; never an input to any decision. */
    frameworkRationales: jsonb("framework_rationales").$type<Record<string, string>>().notNull().default({}),
    /** ADR-0171 / AER-053 (migration 0134): the yes/no screening answers the
     * owner marked "Not sure". Every listed answer is stored (and screened)
     * as `true`, the conservative reading; reviewers see the list. */
    screeningUnsure: jsonb("screening_unsure").$type<string[]>().notNull().default([]),
    retiredReason: text("retired_reason"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ai_use_cases_name_check", sql`length(btrim(${t.name})) > 0`),
    check(
      "ai_use_cases_approval_lifetime_check",
      sql`(${t.approvedAt} IS NULL) = (${t.approvedUntil} IS NULL)`,
    ),
    check(
      "ai_use_cases_eu_tier_consistency_check",
      sql`(${t.euAiActTier} IS NULL) = (${t.euAiActRulesetVersion} IS NULL) AND (${t.euAiActTier} IS NULL) = (${t.euAiActReasons} IS NULL)`,
    ),
    check(
      "ai_use_cases_retirement_check",
      sql`(${t.status} = 'retired') = (${t.retiredAt} IS NOT NULL AND ${t.retiredReason} IS NOT NULL)`,
    ),
    index("ai_use_cases_owner_idx").on(t.ownerUserId),
    index("ai_use_cases_status_idx").on(t.status),
    index("ai_use_cases_instance_idx").on(t.workflowInstanceId),
    /** ADR-0109 (migration 0108): ONE pillar-2 instance governs ONE use case.
     * `syncUseCaseForInstance` mirrors an instance's status onto the object it
     * finds; two objects on one instance would mean a single sign-off silently
     * approving one of two things. Partial: a use case may be proposed before
     * any instance governs it. */
    uniqueIndex("ai_use_cases_instance_uq")
      .on(t.workflowInstanceId)
      .where(sql`${t.workflowInstanceId} IS NOT NULL`),
  ],
);

export type AiUseCaseRow = typeof aiUseCases.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0171 / AER-050 (migration 0134) — INTAKE DRAFTS AND IDEMPOTENT CREATION.
//
// `use_case_drafts`: the intake wizard's work-in-progress, server-side and per
// user (questionnaire text can be sensitive, so it never lives in browser
// storage). One draft per (user, scope): scope `new` is the registration
// wizard, a use-case id is that use case's resubmission. `state` is the
// wizard's opaque JSON; the gateway never reads inside it.
//
// `use_case_idempotency_keys`: an `Idempotency-Key` on POST /v1/use-cases is
// CLAIMED here inside the create transaction — the unique (user_id, key)
// index is what makes two concurrent duplicates unable to both create. The
// stored `response` is the original 201 body, replayed for 24 hours.
// ---------------------------------------------------------------------------

export const useCaseDrafts = pgTable(
  "use_case_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("use_case_drafts_user_scope_uq").on(t.userId, t.scope),
    index("use_case_drafts_updated_idx").on(t.updatedAt),
  ],
);

export type UseCaseDraftRow = typeof useCaseDrafts.$inferSelect;

export const useCaseIdempotencyKeys = pgTable(
  "use_case_idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    useCaseId: uuid("use_case_id").references(() => aiUseCases.id, { onDelete: "cascade" }),
    /** the original 201 body, replayed verbatim on a retry */
    response: jsonb("response").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("use_case_idempotency_keys_key_check", sql`length(${t.key}) BETWEEN 1 AND 200`),
    uniqueIndex("use_case_idempotency_keys_user_key_uq").on(t.userId, t.key),
    index("use_case_idempotency_keys_created_idx").on(t.createdAt),
  ],
);

export type UseCaseIdempotencyKeyRow = typeof useCaseIdempotencyKeys.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0168 (migration 0129) — APPROVAL CONDITIONS ("approve with conditions").
// Imposed by an intake sign-off, written in the decision's own transaction.
// `blocking` = before go-live: the deploy gate refuses while it is open.
// Not blocking = after go-live: tracked, shown overdue after `dueAt`, never
// blocks. Marked met by the condition's owner, the use case's owner or an
// admin (audited `use-case-condition-met`).
// ---------------------------------------------------------------------------

export const USE_CASE_CONDITION_STATUSES = ["open", "met", "waived"] as const;
export type UseCaseConditionStatus = (typeof USE_CASE_CONDITION_STATUSES)[number];

export const useCaseConditions = pgTable(
  "use_case_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    useCaseId: uuid("use_case_id")
      .notNull()
      .references(() => aiUseCases.id, { onDelete: "cascade" }),
    /** the decision that imposed it */
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    blocking: boolean("blocking").notNull(),
    status: text("status", { enum: USE_CASE_CONDITION_STATUSES }).notNull().default("open"),
    metAt: timestamp("met_at", { withTimezone: true }),
    metByUserId: uuid("met_by_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("use_case_conditions_status_check", sql`${t.status} IN ('open', 'met', 'waived')`),
    check("use_case_conditions_text_check", sql`length(btrim(${t.text})) BETWEEN 1 AND 500`),
    check("use_case_conditions_met_check", sql`(${t.status} = 'open') = (${t.metAt} IS NULL)`),
    index("use_case_conditions_use_case_idx").on(t.useCaseId, t.status),
    index("use_case_conditions_approval_idx").on(t.approvalId),
  ],
);

export type UseCaseConditionRow = typeof useCaseConditions.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0168 amendment (migration 0131) — THE REVIEW POLICY. One row (id
// 'default'), admin-edited: reviewer roles with members, per EU AI Act tier
// the roles that must sign (each role = one required review) and an optional
// approval lifetime, and who may accept risk. No row, or a tier with no
// roles, keeps the intake template's single named approver.
// ---------------------------------------------------------------------------

export interface ReviewPolicyRole {
  id: string;
  name: string;
  memberUserIds: string[];
}
export interface ReviewPolicyTier {
  roleIds: string[];
  validityMonths?: number;
}

export const governanceReviewPolicy = pgTable(
  "governance_review_policy",
  {
    id: text("id").primaryKey().default("default"),
    roles: jsonb("roles").$type<ReviewPolicyRole[]>().notNull().default([]),
    tiers: jsonb("tiers").$type<Record<string, ReviewPolicyTier>>().notNull().default({}),
    riskAcceptorUserIds: jsonb("risk_acceptor_user_ids").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [check("governance_review_policy_singleton_check", sql`${t.id} = 'default'`)],
);

export type GovernanceReviewPolicyRow = typeof governanceReviewPolicy.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0084 (migration 0088) — the AI vendor registry (third-party AI risk).
//
// Gap L5: our vendor story was COST (ADR-0069/0076), not risk. A third-party
// AI vendor becomes a governed object whose assessment rides the pillar-2
// rails exactly like a use case (ADR-0080): propose → questionnaire artifact
// → sign-off on the one approvals queue. `status` reaches approved/rejected
// ONLY through that instance's terminal decision.
//
// THE HONESTY SPLIT THIS TABLE CARRIES: `pack_attestations` holds
// VENDOR-SUPPLIED answers to compliance-pack controls, each stamped with who
// recorded it, when, and from which questionnaire artifact version. They are
// CLAIMS — deliberately NOT compliance_pack_attestations rows (those are the
// org's own statements and feed the pack evaluator), and nothing in the pack
// scorecard/report/collector machinery ever reads this column.
// ---------------------------------------------------------------------------

export const AI_VENDOR_STATUSES = [
  "proposed",
  "under_assessment",
  "approved",
  "rejected",
  "retired",
] as const;
export type AiVendorStatus = (typeof AI_VENDOR_STATUSES)[number];

export const AI_VENDOR_CATEGORIES = [
  /** a model provider our agents call (directly or via a custom endpoint) */
  "model_provider",
  /** a product we use whose features run AI on our data */
  "ai_feature_vendor",
  /** a processor our data reaches (sub-processing, enrichment, hosting) */
  "data_processor",
  /** an integration that moves data between systems with AI in the path */
  "integration",
] as const;
export type AiVendorCategory = (typeof AI_VENDOR_CATEGORIES)[number];

/** one VENDOR-SUPPLIED answer to a pack control, with full attribution — the
 * shape the audited attestation endpoint appends and the detail view renders
 * under its "vendor-attested — not verified by this platform" label */
export interface AiVendorPackAttestation {
  framework: string;
  packId: string;
  packVersion: number;
  controlRef: string;
  /** the vendor's claim, verbatim as recorded */
  statement: string;
  evidenceRef: string | null;
  /** WHO recorded the vendor's answer (a platform user, never the vendor —
   * there is no vendor-facing auth surface) */
  recordedByUserId: string;
  recordedAt: string;
  /** which version of the assessment questionnaire the answer came from */
  questionnaireVersion: number;
}

export const aiVendors = pgTable(
  "ai_vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    category: text("category", { enum: AI_VENDOR_CATEGORIES }).notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** REFERENCES, not copies: admin-registered custom model providers
     * (ADR-0034) this vendor corresponds to — validated at write time */
    linkedCustomProviderIds: jsonb("linked_custom_provider_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** provider keys as they appear on agents.provider — a linkage hint,
     * never an enforcement key (that column is free text) */
    linkedAgentProviders: jsonb("linked_agent_providers").$type<string[]>().notNull().default([]),
    /** vendor-supplied pack-control answers WITH ATTRIBUTION — written only
     * by the audited attestation endpoint (see the section header) */
    packAttestations: jsonb("pack_attestations")
      .$type<AiVendorPackAttestation[]>()
      .notNull()
      .default([]),
    status: text("status", { enum: AI_VENDOR_STATUSES }).notNull().default("proposed"),
    /** the pillar-2 assessment instance that governs this vendor's approval */
    workflowInstanceId: uuid("workflow_instance_id").references(() => workflowInstances.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    retiredReason: text("retired_reason"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ai_vendors_name_check", sql`length(btrim(${t.name})) > 0`),
    check(
      "ai_vendors_retirement_check",
      sql`(${t.status} = 'retired') = (${t.retiredAt} IS NOT NULL AND ${t.retiredReason} IS NOT NULL)`,
    ),
    index("ai_vendors_owner_idx").on(t.ownerUserId),
    index("ai_vendors_status_idx").on(t.status),
    index("ai_vendors_instance_idx").on(t.workflowInstanceId),
    /** ADR-0109 (migration 0108): the `ai_use_cases` argument, verbatim —
     * `syncVendorForInstance` is the same shape. */
    uniqueIndex("ai_vendors_instance_uq")
      .on(t.workflowInstanceId)
      .where(sql`${t.workflowInstanceId} IS NOT NULL`),
  ],
);

export type AiVendorRow = typeof aiVendors.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0081 (migration 0087) — the AI risk register.
//
// The one table of gap L2: a named risk scenario linked to an owner, a
// mitigating control (prose), a DECLARED likelihood/impact judgment, and a
// residual-risk acceptance record. What is conspicuously NOT here: evidence.
// A risk's evidence is computed at read time by SELECTs over the real ledgers
// (red-team runs, eval runs, guardrail configs, audit denials, grants, shadow
// AI findings), keyed off `category` — the ADR-0058 "evidence is a query,
// never a tick-box" discipline applied to risk.
// ---------------------------------------------------------------------------

export const AI_RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;
export type AiRiskStatus = (typeof AI_RISK_STATUSES)[number];

/** kept in lockstep with @regulait/shared's AI_RISK_CATEGORIES — the curated
 * vocabulary of scenarios this deployment's ledgers can (or, for
 * `scope_drift`, honestly cannot) evidence */
export const AI_RISK_CATEGORIES = [
  "tool_misuse",
  "scope_drift",
  "prompt_injection",
  "data_leakage_pii",
  "over_permissioning",
  "budget_overrun",
  "hallucination",
  "shadow_ai",
  /** ADR-0084 (migration 0088): third-party/vendor AI — evidenced by the
   * vendor registry's assessment lifecycle. The resolver counts assessment
   * STATES (platform records); the assessment CONTENT is vendor-attested and
   * the evidence payload says so. */
  "third_party_ai",
  /** ADR-0147 (migration 0123): the bias and safety trust dimensions */
  "bias_fairness",
  "unsafe_output",
] as const;
export type AiRiskCategory = (typeof AI_RISK_CATEGORIES)[number];

export const AI_RISK_LEVELS = ["low", "medium", "high"] as const;
export type AiRiskLevel = (typeof AI_RISK_LEVELS)[number];

export const aiRisks = pgTable(
  "ai_risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    /** THE EVIDENCE KEY: what the gateway resolves to ledger queries */
    category: text("category", { enum: AI_RISK_CATEGORIES }).notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** optional scope — narrows the evidence queries to this slice */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    useCaseId: uuid("use_case_id").references(() => aiUseCases.id, { onDelete: "set null" }),
    /** ADR-0084 (migration 0088): the vendor whose assessment lifecycle
     * evidences a third-party risk — the `vendor_assessments` resolver
     * narrows its queries to this row when set, exactly how agentId narrows
     * the red-team and eval resolvers */
    vendorId: uuid("vendor_id").references(() => aiVendors.id, { onDelete: "set null" }),
    status: text("status", { enum: AI_RISK_STATUSES }).notNull().default("open"),
    /** DECLARED human judgments — never blended into any computed number */
    likelihood: text("likelihood", { enum: AI_RISK_LEVELS }).notNull(),
    impact: text("impact", { enum: AI_RISK_LEVELS }).notNull(),
    /** the mitigating control, in prose (the seed library cites the ADRs) */
    mitigation: text("mitigation"),
    /** the residual-risk acceptance record — written ONLY by the audited
     * acceptance endpoint; a record of a decision, not a control */
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptanceNote: text("acceptance_note"),
    /** ADR-0147 (migration 0123): the DECLARED residual position once the
     * linked controls operate — same three-level scale, both or neither */
    residualLikelihood: text("residual_likelihood", { enum: AI_RISK_LEVELS }),
    residualImpact: text("residual_impact", { enum: AI_RISK_LEVELS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ai_risks_title_check", sql`length(btrim(${t.title})) > 0`),
    check(
      "ai_risks_acceptance_check",
      sql`(${t.status} = 'accepted') = (${t.acceptedAt} IS NOT NULL AND ${t.acceptanceNote} IS NOT NULL)`,
    ),
    index("ai_risks_owner_idx").on(t.ownerUserId),
    index("ai_risks_status_idx").on(t.status),
    index("ai_risks_category_idx").on(t.category),
    index("ai_risks_use_case_idx").on(t.useCaseId),
    index("ai_risks_vendor_idx").on(t.vendorId),
  ],
);

export type AiRiskRow = typeof aiRisks.$inferSelect;

/**
 * ADR-0147 (migration 0123) — a mitigating control linked to a risk, by the
 * pack control's stable `controlRef`. The gateway validates the ref against
 * the seeded compliance packs; the link records who claimed the mitigation.
 */
export const aiRiskControls = pgTable(
  "ai_risk_controls",
  {
    riskId: uuid("risk_id")
      .notNull()
      .references(() => aiRisks.id, { onDelete: "cascade" }),
    controlRef: text("control_ref").notNull(),
    linkedByUserId: uuid("linked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "ai_risk_controls_pk", columns: [t.riskId, t.controlRef] }),
    index("ai_risk_controls_ref_idx").on(t.controlRef),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0157 (migration 0124) — governance monitor alerts. One row per
// (rule, subject) condition EPISODE; the partial unique index allows at most
// one active (open/acknowledged) episode per condition. A recurrence after
// resolution is a new row, so the history is never overwritten.
export const GOVERNANCE_ALERT_SEVERITIES = ["low", "medium", "high"] as const;
export const GOVERNANCE_ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export const governanceAlerts = pgTable(
  "governance_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: text("rule_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    severity: text("severity", { enum: GOVERNANCE_ALERT_SEVERITIES }).notNull(),
    title: text("title").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: GOVERNANCE_ALERT_STATUSES }).notNull().default("open"),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ackNote: text("ack_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("governance_alerts_active_uq")
      .on(t.ruleId, t.subjectKey)
      .where(sql`${t.status} <> 'resolved'`),
    index("governance_alerts_status_idx").on(t.status, t.lastDetectedAt),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0159 (migration 0125) — executable remediation proposals for monitor
// alerts, each bound to one approvals row and executed by the decide path.
export const REMEDIATION_PROPOSAL_KINDS = ["link_control", "assign_agent_owner"] as const;
export const REMEDIATION_PROPOSAL_STATUSES = ["pending_approval", "applied", "denied", "failed"] as const;
export const remediationProposals = pgTable(
  "remediation_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id").references(() => governanceAlerts.id, { onDelete: "set null" }),
    kind: text("kind", { enum: REMEDIATION_PROPOSAL_KINDS }).notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull(),
    title: text("title").notNull(),
    rationale: text("rationale").notNull(),
    status: text("status", { enum: REMEDIATION_PROPOSAL_STATUSES }).notNull().default("pending_approval"),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    proposedByUserId: uuid("proposed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("remediation_proposals_approval_uq")
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
    uniqueIndex("remediation_proposals_pending_action_uq")
      .on(t.kind, t.params)
      .where(sql`${t.status} = 'pending_approval'`),
    index("remediation_proposals_alert_idx").on(t.alertId),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0160 (migration 0126) — continuous trace evaluation results. Counts
// only; unique span id makes overlapping sweeps idempotent.
export const TRACE_EVALUATION_OUTCOME_VALUES = ["evaluated", "withheld", "no_content"] as const;
export const traceEvaluations = pgTable(
  "trace_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spanId: uuid("span_id").notNull(),
    traceId: uuid("trace_id").notNull(),
    agentId: uuid("agent_id"),
    spanStartedAt: timestamp("span_started_at", { withTimezone: true }).notNull(),
    outcome: text("outcome", { enum: TRACE_EVALUATION_OUTCOME_VALUES }).notNull(),
    flagged: boolean("flagged").notNull().default(false),
    findings: jsonb("findings")
      .$type<Array<{ phase: "input" | "output"; detector: string; category: string; count: number }>>()
      .notNull()
      .default([]),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trace_evaluations_span_uq").on(t.spanId),
    index("trace_evaluations_agent_started_idx").on(t.agentId, t.spanStartedAt),
  ],
);

// ---------------------------------------------------------------------------
// ADR-0090 (migration 0092) — grant certification campaigns (gap L22).
//
// Saviynt's core loop — periodic owner-driven review of entitlements with
// attest/revoke decisions — scoped DELIBERATELY to the grants THIS gateway
// enforces (agent/connector/MCP tool/server, direct and role-bundled). Items
// are snapshots taken at open; decisions ride the ONE approvals queue
// (`approvals.objectType = 'grant_certification'`); a revoke decision
// EXECUTES the same revocation path the admin endpoints use, inside the
// decision's own transaction. `expired-incomplete` is a read-time projection
// (open + past due + undecided) — no scheduler writes it, no timeout ever
// auto-decides an item.
// ---------------------------------------------------------------------------

/** widened by migration 0094 (ADR-0092): `from_recommendations` scopes a
 * campaign to the grants the named access-recommendation rules flag AT OPEN
 * — scope_value carries the comma-separated rule ids, and the snapshot is
 * computed at open, never stored (recommendations have no table). */
export const GRANT_CERT_SCOPE_KINDS = [
  "all",
  "agent_lifecycle",
  "agent_owner",
  "user",
  "from_recommendations",
] as const;
export type GrantCertScopeKind = (typeof GRANT_CERT_SCOPE_KINDS)[number];

export const GRANT_CERT_GRANT_KINDS = [
  "agent",
  "connector",
  "tool",
  "server",
  "role_agent",
  "role_connector",
  "role_tool",
  "role_server",
] as const;
export type GrantCertGrantKind = (typeof GRANT_CERT_GRANT_KINDS)[number];

export const grantCertificationCampaigns = pgTable(
  "grant_certification_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scopeKind: text("scope_kind", { enum: GRANT_CERT_SCOPE_KINDS }).notNull(),
    /** lifecycle status / owner user id / holder user id, per scopeKind; null for 'all' */
    scopeValue: text("scope_value"),
    openedByUserId: uuid("opened_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** stored status is only ever open|completed; 'expired-incomplete' is computed on read */
    status: text("status", { enum: ["open", "completed"] })
      .notNull()
      .default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("grant_cert_campaigns_name_check", sql`length(btrim(${t.name})) > 0`),
    check(
      "grant_cert_campaigns_scope_value_check",
      sql`(${t.scopeKind} = 'all') = (${t.scopeValue} IS NULL)`,
    ),
    check(
      "grant_cert_campaigns_completed_check",
      sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    index("grant_cert_campaigns_status_idx").on(t.status),
  ],
);

export const grantCertificationItems = pgTable(
  "grant_certification_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => grantCertificationCampaigns.id, { onDelete: "cascade" }),
    grantKind: text("grant_kind", { enum: GRANT_CERT_GRANT_KINDS }).notNull(),
    /** the grant ROW id snapshotted at open — deliberately NOT an FK (the row
     * may legitimately disappear; the item is the durable review record) */
    grantId: uuid("grant_id").notNull(),
    /** exactly one of the two (DB CHECK): who enjoys the grant */
    holderUserId: uuid("holder_user_id"),
    holderRoleId: uuid("holder_role_id"),
    holderLabel: text("holder_label").notNull(),
    objectId: uuid("object_id"),
    objectLabel: text("object_label").notNull(),
    toolName: text("tool_name"),
    reviewerUserId: uuid("reviewer_user_id").notNull(),
    /** the row in the ONE approvals queue carrying this item's decision */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    /** keep|revoke, written only by the one decide path; NULL forever if
     * nobody decides — no auto-decision on expiry, ever */
    decision: text("decision", { enum: ["keep", "revoke"] }),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** what executing a revoke actually did (mechanism + row-still-there) */
    revocationDetail: jsonb("revocation_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "grant_cert_items_holder_check",
      sql`(${t.holderUserId} IS NULL) <> (${t.holderRoleId} IS NULL)`,
    ),
    check("grant_cert_items_decided_check", sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
    check(
      "grant_cert_items_decided_by_check",
      sql`(${t.decision} IS NULL) = (${t.decidedByUserId} IS NULL)`,
    ),
    index("grant_cert_items_campaign_idx").on(t.campaignId),
    index("grant_cert_items_approval_idx").on(t.approvalId),
    /** ADR-0109 (migration 0108): ONE queue row decides ONE certification item.
     * Both the pre-check and the apply path read by `approval_id` and then
     * revoke a real grant on the strength of it. Partial: NULL until the item
     * is queued. */
    uniqueIndex("grant_cert_items_approval_uq")
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
    index("grant_cert_items_reviewer_idx").on(t.reviewerUserId),
  ],
);

export type GrantCertificationCampaignRow = typeof grantCertificationCampaigns.$inferSelect;
export type GrantCertificationItemRow = typeof grantCertificationItems.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0091 (migration 0093) — toxic-combination segregation of duties (L23)
// ---------------------------------------------------------------------------

/** the capability kinds an SoD rule side may name — the four grantable
 * gateway object families. A side is either CONCRETE (one id, plus tool name
 * for mcp_tool; plus an optional mode qualifier for connector) or — since the
 * ADR-0091 amendment (migration 0097) — a PATTERN over one of the enumerable
 * dimensions in SOD_PATTERN_DIMENSIONS below. */
export const SOD_CAPABILITY_KINDS = ["agent", "connector", "mcp_tool", "mcp_server"] as const;
export type SodCapabilityKind = (typeof SOD_CAPABILITY_KINDS)[number];

/** ADR-0091 amendment (migration 0097) — the CLOSED pattern vocabulary. A
 * pattern side selects by an enumerable dimension the schema actually has:
 * an agent's lifecycle status, an agent's provider kind, or a connector
 * holding's mode ("any connector held at readwrite"). NO free-form regex or
 * name matching anywhere — the ADR-0085 data-only-rules discipline. Patterns
 * resolve at CHECK time against current objects, so a new agent matching the
 * pattern is covered the moment it exists. */
export const SOD_PATTERN_DIMENSIONS = ["lifecycle_status", "provider", "mode"] as const;
export type SodPatternDimension = (typeof SOD_PATTERN_DIMENSIONS)[number];

/** every mint path the SoD gate covers — the eight grant kinds ADR-0090
 * enumerated, plus role ASSIGNMENT (assigning a role confers its bundle, so
 * an SoD check that ignored it would be vacuous). */
export const SOD_MINT_KINDS = [
  "agent",
  "connector",
  "tool",
  "server",
  "role_agent",
  "role_connector",
  "role_tool",
  "role_server",
  "role_assignment",
] as const;
export type SodMintKind = (typeof SOD_MINT_KINDS)[number];

export const sodRules = pgTable(
  "sod_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    /** legacy two-sided shape (pre-0097 rows keep it byte-identically); a
     * rule whose sides live in `sod_rule_sides` leaves all four NULL — the
     * `sod_rules_side_storage_check` pins that it is one shape or the other */
    aKind: text("a_kind", { enum: SOD_CAPABILITY_KINDS }),
    aObjectId: uuid("a_object_id"),
    aToolName: text("a_tool_name"),
    aMode: text("a_mode", { enum: ["read", "readwrite"] }),
    bKind: text("b_kind", { enum: SOD_CAPABILITY_KINDS }),
    bObjectId: uuid("b_object_id"),
    bToolName: text("b_tool_name"),
    bMode: text("b_mode", { enum: ["read", "readwrite"] }),
    /** REQUIRED — the refusal must be able to say WHY the pair is toxic */
    reason: text("reason").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** SET NULL on user deletion — the rule outlives its author */
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sod_rules_name_check", sql`length(btrim(${t.name})) > 0`),
    check("sod_rules_reason_check", sql`length(btrim(${t.reason})) > 0`),
    check("sod_rules_a_tool_check", sql`(${t.aKind} = 'mcp_tool') = (${t.aToolName} IS NOT NULL)`),
    check("sod_rules_b_tool_check", sql`(${t.bKind} = 'mcp_tool') = (${t.bToolName} IS NOT NULL)`),
    check(
      "sod_rules_a_mode_check",
      sql`${t.aMode} IS NULL OR (${t.aKind} = 'connector' AND ${t.aMode} IN ('read', 'readwrite'))`,
    ),
    check(
      "sod_rules_b_mode_check",
      sql`${t.bMode} IS NULL OR (${t.bKind} = 'connector' AND ${t.bMode} IN ('read', 'readwrite'))`,
    ),
    check(
      "sod_rules_sides_differ_check",
      sql`NOT (${t.aKind} = ${t.bKind} AND ${t.aObjectId} = ${t.bObjectId} AND ${t.aToolName} IS NOT DISTINCT FROM ${t.bToolName} AND ${t.aMode} IS NOT DISTINCT FROM ${t.bMode})`,
    ),
    // migration 0097: fully legacy-sided or fully child-sided, never half
    check(
      "sod_rules_side_storage_check",
      sql`((${t.aKind} IS NOT NULL) = (${t.aObjectId} IS NOT NULL)) AND ((${t.bKind} IS NOT NULL) = (${t.bObjectId} IS NOT NULL)) AND ((${t.aKind} IS NULL) = (${t.bKind} IS NULL)) AND (${t.aKind} IS NOT NULL OR (${t.aToolName} IS NULL AND ${t.aMode} IS NULL AND ${t.bToolName} IS NULL AND ${t.bMode} IS NULL))`,
    ),
    index("sod_rules_enabled_idx").on(t.enabled),
  ],
);

/** ADR-0091 amendment (migration 0097) — one row per side of a NEW-shape SoD
 * rule (N-way and/or pattern selectors). A pre-0097 two-sided rule has no
 * rows here and keeps its legacy a-/b-side columns; the gateway reads both shapes
 * through one loader. Each side is either CONCRETE (object_id [+ tool_name /
 * mode]) or a PATTERN — an enumerable (dimension, value) pair over the
 * closed SOD_PATTERN_DIMENSIONS vocabulary, resolved at check time. */
export const sodRuleSides = pgTable(
  "sod_rule_sides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => sodRules.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    selector: text("selector", { enum: ["concrete", "pattern"] }).notNull(),
    kind: text("kind", { enum: SOD_CAPABILITY_KINDS }).notNull(),
    objectId: uuid("object_id"),
    toolName: text("tool_name"),
    mode: text("mode", { enum: ["read", "readwrite"] }),
    patternDimension: text("pattern_dimension", { enum: SOD_PATTERN_DIMENSIONS }),
    patternValue: text("pattern_value"),
  },
  (t) => [
    unique("sod_rule_sides_position_uq").on(t.ruleId, t.position),
    check(
      "sod_rule_sides_concrete_check",
      sql`${t.selector} <> 'concrete' OR (${t.objectId} IS NOT NULL AND ${t.patternDimension} IS NULL AND ${t.patternValue} IS NULL AND ((${t.kind} = 'mcp_tool') = (${t.toolName} IS NOT NULL)) AND (${t.mode} IS NULL OR (${t.kind} = 'connector' AND ${t.mode} IN ('read', 'readwrite'))))`,
    ),
    check(
      "sod_rule_sides_pattern_check",
      sql`${t.selector} <> 'pattern' OR (${t.objectId} IS NULL AND ${t.toolName} IS NULL AND ${t.mode} IS NULL AND ${t.patternDimension} IS NOT NULL AND ${t.patternValue} IS NOT NULL AND ((${t.kind} = 'agent' AND ${t.patternDimension} IN ('lifecycle_status', 'provider')) OR (${t.kind} = 'connector' AND ${t.patternDimension} = 'mode' AND ${t.patternValue} IN ('read', 'readwrite'))))`,
    ),
    check(
      "sod_rule_sides_lifecycle_value_check",
      sql`${t.patternDimension} <> 'lifecycle_status' OR ${t.patternValue} IN ('proposed', 'active', 'under_review', 'suspended', 'deprecated', 'retired')`,
    ),
    index("sod_rule_sides_rule_idx").on(t.ruleId),
  ],
);

export type SodRuleSideRow = typeof sodRuleSides.$inferSelect;

export const sodOverrideRequests = pgTable(
  "sod_override_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** CASCADE with the rule — an override of an un-declared toxicity is moot */
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => sodRules.id, { onDelete: "cascade" }),
    mintKind: text("mint_kind", { enum: SOD_MINT_KINDS }).notNull(),
    /** the EXACT validated payload of the refused mint — an approval executes
     * this, never a client-restated one */
    mintPayload: jsonb("mint_payload").notNull(),
    /** the conflict as computed at request time (display evidence; the
     * enforcement re-checks live at decision time) */
    conflictDetail: jsonb("conflict_detail").notNull(),
    /** one line for the queue row: who wants what, despite which rule */
    label: text("label").notNull(),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** the row in the ONE approvals queue carrying this request's decision */
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    status: text("status", { enum: ["pending", "approved", "denied"] })
      .notNull()
      .default("pending"),
    decidedByUserId: uuid("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** what an approval actually minted (grant kind + row id), null until then */
    mintDetail: jsonb("mint_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("sod_override_decided_check", sql`(${t.status} = 'pending') = (${t.decidedAt} IS NULL)`),
    check(
      "sod_override_decided_by_check",
      sql`(${t.status} = 'pending') = (${t.decidedByUserId} IS NULL)`,
    ),
    index("sod_override_rule_idx").on(t.ruleId),
    index("sod_override_approval_idx").on(t.approvalId),
    /** ADR-0109 (migration 0108): ONE queue row decides ONE override request —
     * and an approval here MINTS a grant the SoD engine refused, so a second
     * match would mint against a payload the approver never saw. Partial: NULL
     * until the request is queued. */
    uniqueIndex("sod_override_approval_uq")
      .on(t.approvalId)
      .where(sql`${t.approvalId} IS NOT NULL`),
    index("sod_override_status_idx").on(t.status),
  ],
);

export type SodRuleRow = typeof sodRules.$inferSelect;
export type SodOverrideRequestRow = typeof sodOverrideRequests.$inferSelect;

/**
 * ADR-0125 / ROADMAP G1 — the HTTP edge rate limiter's shared counters.
 *
 * This is the only table in the schema whose rows are pure throughput
 * bookkeeping: nothing here is evidence, nothing is audited, and a row may be
 * deleted at any time without losing a fact. It exists because
 * @fastify/rate-limit's default store is a per-process Map, which made the one
 * remaining enforcement counter in this product silently multiply by the
 * replica count — every OTHER counter is already SQL (audit_log count(),
 * usage_events sum(), virtual_keys.spent_usd).
 *
 * Row cardinality is bounded by DISTINCT CALLERS in a window, not by requests:
 * a bucket is counted into, not appended to.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    /** whatever `rateLimitKey` derived: `ip:…`, `key:…`, `auth:…`, `scim:…` */
    bucket: text("bucket").primaryKey(),
    /** start of the CURRENT fixed window — the same semantics the in-process
     * store had, kept so that moving the store does not change what a
     * configured number means */
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [
    /** a row exists only because a request was counted into it */
    check("rate_limit_counters_hits_positive", sql`${t.hits} > 0`),
    index("rate_limit_counters_window_started_at_idx").on(t.windowStartedAt),
  ],
);

export type RateLimitCounterRow = typeof rateLimitCounters.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0172 (migration 0135) — THE AGENT BUILDER.
//
// A builder agent is a CONFIGURATION, never an identity with its own
// authority: it names one governed model binding (`model_agent_id`, a row of
// the agent registry above), a toolbox of connectors / MCP tools the editor
// held grants for, sub-agents, skills, memory, schedules and channels. Every
// run dispatches through the existing governed core AS THE PERSON USING IT
// (or, for a schedule, as the agent's OWNER), so nothing here can widen what
// a human may reach. Spend is recorded on `builder_messages.cost_usd` (the
// value the governed core measured) and the per-agent monthly limit is summed
// from those rows.
// ---------------------------------------------------------------------------

export const BUILDER_SHARING = ["private", "workspace", "people"] as const;
export type BuilderSharing = (typeof BUILDER_SHARING)[number];
export const BUILDER_CONNECTION_FORMATS = ["shared", "per_user"] as const;
export const BUILDER_TOOL_KINDS = ["connector", "mcp_tool"] as const;
export const BUILDER_SKILL_VISIBILITY = ["private", "workspace"] as const;
/** ADR-0175 A6 — mirrors SKILL_ADMISSION_STATES in @regulait/shared */
export const BUILDER_SKILL_ADMISSION_STATES = ["unscanned", "clean", "held", "refused", "admitted"] as const;
export const BUILDER_CADENCES = ["hourly", "daily", "weekdays", "weekly"] as const;
export type BuilderCadence = (typeof BUILDER_CADENCES)[number];
export const BUILDER_CHANNEL_PROVIDERS = ["slack", "teams", "outlook", "email"] as const;
export const BUILDER_THREAD_STATUSES = ["active", "needs_attention", "completed"] as const;
export const BUILDER_THREAD_SOURCES = ["chat", "schedule", "channel"] as const;
export const BUILDER_MESSAGE_ROLES = ["user", "agent", "system"] as const;

export const builderAgents = pgTable(
  "builder_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("#2563eb"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sharing: text("sharing", { enum: BUILDER_SHARING }).notNull().default("private"),
    /** the governed model binding; ON DELETE SET NULL — the agent survives a
     * registry change and refuses to chat until a model is chosen again */
    modelAgentId: uuid("model_agent_id").references(() => agents.id, { onDelete: "set null" }),
    templateId: text("template_id"),
    instructions: text("instructions").notNull().default(""),
    /** fixed at creation (PATCH refuses it) */
    connectionFormat: text("connection_format", { enum: BUILDER_CONNECTION_FORMATS }).notNull(),
    computerUse: boolean("computer_use").notNull().default(false),
    monthlyLimitUsd: doublePrecision("monthly_limit_usd"),
    /** pillar 5 attribution: the project this agent's dispatches bill to
     * (null = unattributed); ON DELETE SET NULL */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** the monthly-limit LEASE: a limited agent runs one turn at a time, so a
     * check -> dispatch -> record cannot interleave with another (expires so a
     * crashed holder never wedges the agent) */
    limitLeaseToken: uuid("limit_lease_token"),
    limitLeaseUntil: timestamp("limit_lease_until", { withTimezone: true }),
    /** soft delete: archived agents are hidden from every list and refuse chat */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("builder_agents_owner_idx").on(t.ownerUserId),
    check(
      "builder_agents_limit_ck",
      sql`${t.monthlyLimitUsd} IS NULL OR (${t.monthlyLimitUsd} >= 0.01 AND ${t.monthlyLimitUsd} <= 100000)`,
    ),
  ],
);

export const builderAgentShares = pgTable(
  "builder_agent_shares",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.userId] }), index("builder_agent_shares_user_idx").on(t.userId)],
);

export const builderAgentTools = pgTable(
  "builder_agent_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: BUILDER_TOOL_KINDS }).notNull(),
    /** connectors.id for a connector, mcp_tools.id for an MCP tool. FK-free
     * (two target tables); a dangling ref renders as an unavailable tool. */
    refId: uuid("ref_id").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("builder_agent_tools_uq").on(t.agentId, t.kind, t.refId)],
);

export const builderAgentSubagents = pgTable(
  "builder_agent_subagents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    childId: uuid("child_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("builder_agent_subagents_uq").on(t.parentId, t.childId),
    index("builder_agent_subagents_child_idx").on(t.childId),
    check("builder_agent_subagents_not_self_ck", sql`${t.parentId} <> ${t.childId}`),
  ],
);

export const builderSkills = pgTable(
  "builder_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    body: text("body").notNull().default(""),
    visibility: text("visibility", { enum: BUILDER_SKILL_VISIBILITY }).notNull().default("private"),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // ADR-0175 A6 (migration 0140) — admission and integrity.
    /** sha256 (hex) of the prompt section: `skillPromptSection(name, body)`;
     * backfilled by the migration */
    contentDigest: text("content_digest").notNull().default(""),
    /** goes up by one on every name or body change */
    version: integer("version").notNull().default(1),
    /** see SKILL_ADMISSION_STATES; 'unscanned' only for pre-0140 rows */
    admissionState: text("admission_state", { enum: BUILDER_SKILL_ADMISSION_STATES }).notNull().default("unscanned"),
    /** counts and locations only — never the matched text */
    admissionFindings: jsonb("admission_findings"),
    admissionSeverity: text("admission_severity", { enum: ["low", "medium", "high", "critical"] }),
    admissionScannedAt: timestamp("admission_scanned_at", { withTimezone: true }),
    admissionScannerVersion: text("admission_scanner_version"),
    /** an admin's admission of a HELD skill, pinned to the digest admitted */
    admittedBy: uuid("admitted_by"),
    admittedAt: timestamp("admitted_at", { withTimezone: true }),
    admitReason: text("admit_reason"),
    admittedDigest: text("admitted_digest"),
    /** a pending widening of visibility, waiting for an admin (null = none) */
    requestedVisibility: text("requested_visibility", { enum: BUILDER_SKILL_VISIBILITY }),
    visibilityRequestedAt: timestamp("visibility_requested_at", { withTimezone: true }),
  },
  (t) => [
    index("builder_skills_owner_idx").on(t.ownerUserId),
    index("builder_skills_admission_idx").on(t.admissionState),
  ],
);

export const builderAgentSkills = pgTable(
  "builder_agent_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => builderSkills.id, { onDelete: "cascade" }),
    /** the skill body PINNED at attach time — what the agent runs, so an edit
     * by the skill's owner never silently changes someone else's agent */
    bodySnapshot: text("body_snapshot").notNull().default(""),
    /** the skill's updated_at when pinned; newer = "update available" */
    skillUpdatedAt: timestamp("skill_updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // ADR-0175 A6 (migration 0140) — the PINNED body is what runs, so it is
    // what is scanned: its own digest, version and verdict.
    snapshotDigest: text("snapshot_digest").notNull().default(""),
    snapshotVersion: integer("snapshot_version").notNull().default(1),
    snapshotAdmissionState: text("snapshot_admission_state", { enum: BUILDER_SKILL_ADMISSION_STATES })
      .notNull()
      .default("unscanned"),
    /** the skill NAME pinned with the body: the prompt heading. A rename is a
     * new version, taken only by a re-attach */
    snapshotName: text("snapshot_name").notNull().default(""),
    /** when the pinned copy was last scanned: the re-scan pass rotates by it */
    snapshotScannedAt: timestamp("snapshot_scanned_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.skillId] }),
    index("builder_agent_skills_skill_idx").on(t.skillId),
    index("builder_agent_skills_scanned_idx").on(t.snapshotScannedAt),
  ],
);

// ADR-0175 A5 (migration 0140) — RELEASE-AGE COOLDOWN.
//
// `release_sightings` is this deployment's own record of WHEN it first saw an
// exact digest (a skill version, an MCP manifest, a registry entry version).
// Age is always measured from here, never from a publisher's date. One row per
// (kind, subject, digest), first writer wins. A skill's clock is its own
// (subject_id = the skill); manifests and registry entries use the nil uuid,
// so a digest seen on one server is not new on another.
export const RELEASE_SIGHTING_KINDS = ["skill", "mcp_manifest", "registry_entry"] as const;
export const NIL_SIGHTING_SUBJECT = "00000000-0000-0000-0000-000000000000";
export const releaseSightings = pgTable(
  "release_sightings",
  {
    kind: text("kind", { enum: RELEASE_SIGHTING_KINDS }).notNull(),
    subjectId: uuid("subject_id").notNull().default(NIL_SIGHTING_SUBJECT),
    digest: text("digest").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.subjectId, t.digest] })],
);

/** An admin's per-item override of the cooldown: ONE subject at ONE digest,
 * with a reason (audited). A new digest is a new release and is not covered. */
export const releaseOverrides = pgTable(
  "release_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["mcp_server", "skill"] }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    digest: text("digest").notNull(),
    overriddenBy: uuid("overridden_by"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("release_overrides_uq").on(t.kind, t.subjectId, t.digest)],
);

export const builderAgentMemory = pgTable(
  "builder_agent_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("builder_agent_memory_agent_idx").on(t.agentId, t.createdAt)],
);

export const builderAgentSchedules = pgTable(
  "builder_agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    cadence: text("cadence", { enum: BUILDER_CADENCES }).notNull(),
    /** "HH:MM", UTC; for hourly only the minutes are used */
    timeUtc: text("time_utc").notNull(),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** the claim column: the sweep advances it compare-and-swap, so two
     * concurrent sweeps run a due schedule once */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** who turned it on; the sweep runs a schedule only when this is the
     * agent's OWNER (it runs as them) */
    enabledByUserId: uuid("enabled_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("builder_agent_schedules_agent_idx").on(t.agentId),
    index("builder_agent_schedules_due_idx").on(t.enabled, t.nextRunAt),
    check("builder_agent_schedules_time_ck", sql`${t.timeUtc} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  ],
);

export const builderAgentChannels = pgTable(
  "builder_agent_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: BUILDER_CHANNEL_PROVIDERS }).notNull(),
    chatopsConnectionId: uuid("chatops_connection_id").references(() => chatopsConnections.id, {
      onDelete: "set null",
    }),
    /** ADR-0173 (migration 0137) — the platform channel an ADMIN routes to this
     * agent; null = connection-wide (answers mentions / DMs while it is the
     * only connection-wide binding on its connection) */
    externalChannelId: text("external_channel_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("builder_agent_channels_agent_idx").on(t.agentId),
    uniqueIndex("builder_agent_channels_route_uq")
      .on(t.chatopsConnectionId, t.externalChannelId)
      .where(sql`${t.chatopsConnectionId} IS NOT NULL AND ${t.externalChannelId} IS NOT NULL`),
  ],
);

export const builderThreads = pgTable(
  "builder_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    /** whose thread this is — the chatting user, or the agent OWNER for a
     * schedule run (the identity the run dispatched as) */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", { enum: BUILDER_THREAD_STATUSES }).notNull().default("active"),
    source: text("source", { enum: BUILDER_THREAD_SOURCES }).notNull().default("chat"),
    scheduleId: uuid("schedule_id").references(() => builderAgentSchedules.id, { onDelete: "set null" }),
    /** ADR-0173 (migration 0136): a turn PAUSED on a tool step — its model
     * conversation, encrypted with the data key (it carries the raw arguments
     * a resume replays identically). Cleared when the turn finishes; never
     * returned by the API. */
    pendingTurnCiphertext: text("pending_turn_ciphertext"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("builder_threads_user_idx").on(t.userId, t.updatedAt),
    index("builder_threads_agent_idx").on(t.agentId),
  ],
);

export const builderMessages = pgTable(
  "builder_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => builderThreads.id, { onDelete: "cascade" }),
    /** denormalised from the thread so spend sums need no join */
    agentId: uuid("agent_id").notNull(),
    /** the human the dispatch ran as (and who was billed) */
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: BUILDER_MESSAGE_ROLES }).notNull(),
    content: text("content").notNull(),
    /** agent rows: the served binding, as the governed core reported it */
    modelAgentId: uuid("model_agent_id"),
    provider: text("provider"),
    model: text("model"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("builder_messages_thread_idx").on(t.threadId, t.createdAt),
    index("builder_messages_agent_idx").on(t.agentId, t.createdAt),
    index("builder_messages_user_idx").on(t.userId, t.createdAt),
  ],
);

export const BUILDER_TOOL_STEP_KINDS = ["mcp_tool", "connector", "unknown"] as const;
export const BUILDER_TOOL_STEP_STATUSES = [
  "pending_confirmation",
  "pending_approval",
  "running",
  "done",
  "denied",
  "refused",
  "error",
] as const;
export type BuilderToolStepStatus = (typeof BUILDER_TOOL_STEP_STATUSES)[number];

/**
 * ADR-0173 §1 (migration 0136) — one tool call a builder turn made, attached to
 * the turn's agent message. The governed call keeps its own audit row and
 * trace span; this row links them and holds what the thread shows (a REDACTED
 * argument preview + the approval-binding digest, the outcome, a truncated
 * result preview that is withheld when PII/guardrails withheld the result, the
 * cost — which counts toward the agent's monthly limit — and the latency).
 */
export const builderToolSteps = pgTable(
  "builder_tool_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => builderThreads.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => builderMessages.id, { onDelete: "cascade" }),
    /** denormalised so the monthly-limit sum needs no join */
    agentId: uuid("agent_id").notNull(),
    /** the person the call ran as */
    userId: uuid("user_id").notNull(),
    /** the model step (1-based) within the turn that asked for this call */
    turn: integer("turn").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: BUILDER_TOOL_STEP_KINDS }).notNull(),
    /** mcp_tools.id or connectors.id; null for a tool not in the toolbox */
    refId: uuid("ref_id"),
    /** the model-facing (namespaced) tool name */
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    /** connector provider kind or MCP server name (the web picks a logo) */
    provider: text("provider"),
    toolCallId: text("tool_call_id"),
    /** REDACTED preview — never the raw payload */
    arguments: jsonb("arguments"),
    argumentsDigest: text("arguments_digest").notNull(),
    requiresConfirmation: boolean("requires_confirmation").notNull().default(false),
    status: text("status", { enum: BUILDER_TOOL_STEP_STATUSES }).notNull(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    resultPreview: text("result_preview"),
    resultWithheld: boolean("result_withheld").notNull().default(false),
    outcomeCode: text("outcome_code"),
    outcomeDetail: text("outcome_detail"),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    auditLogId: uuid("audit_log_id"),
    traceId: uuid("trace_id"),
    parentSpanId: uuid("parent_span_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("builder_tool_steps_message_seq_uq").on(t.messageId, t.seq),
    index("builder_tool_steps_thread_idx").on(t.threadId, t.createdAt),
    index("builder_tool_steps_agent_idx").on(t.agentId, t.createdAt),
    index("builder_tool_steps_approval_idx").on(t.approvalId).where(sql`${t.approvalId} IS NOT NULL`),
  ],
);

export type BuilderAgentRow = typeof builderAgents.$inferSelect;
export type BuilderToolStepRow = typeof builderToolSteps.$inferSelect;
export type BuilderSkillRow = typeof builderSkills.$inferSelect;
export type BuilderScheduleRow = typeof builderAgentSchedules.$inferSelect;
export type BuilderThreadRow = typeof builderThreads.$inferSelect;
export type BuilderMessageRow = typeof builderMessages.$inferSelect;

// ---------------------------------------------------------------------------
// ADR-0173 §2 (migration 0137) — inbound channels to builder agents.
// ---------------------------------------------------------------------------

/** (connection, platform channel, platform thread, PERSON) -> builder thread.
 * Per person because a builder thread is personal: two people in one Slack
 * thread each talk to the agent as themselves, with their own entitlements. */
export const builderChannelThreads = pgTable(
  "builder_channel_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatopsConnections.id, { onDelete: "cascade" }),
    externalChannelId: text("external_channel_id").notNull(),
    externalThreadId: text("external_thread_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => builderAgents.id, { onDelete: "cascade" }),
    builderThreadId: uuid("builder_thread_id")
      .notNull()
      .references(() => builderThreads.id, { onDelete: "cascade" }),
    /** where a LATER reply goes (a paused turn resumed from the web app or an
     * approval): Slack channel / Teams conversation id of the newest message */
    replyTarget: text("reply_target"),
    /** Slack thread_ts (null = top level, e.g. a DM) / Teams activity id */
    replyThreadRef: text("reply_thread_ref"),
    /** the gateway's public origin as the newest message reached it, so the
     * links in a later reply are absolute */
    linkOrigin: text("link_origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("builder_channel_threads_uq").on(t.connectionId, t.externalChannelId, t.externalThreadId, t.userId),
    index("builder_channel_threads_thread_idx").on(t.builderThreadId),
  ],
);

/** the de-duplication record: one row per platform delivery AND per message */
export const builderChannelEvents = pgTable(
  "builder_channel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatopsConnections.id, { onDelete: "cascade" }),
    externalEventId: text("external_event_id").notNull(),
    messageKey: text("message_key").notNull(),
    retryNum: integer("retry_num"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("builder_channel_events_event_uq").on(t.connectionId, t.externalEventId),
    uniqueIndex("builder_channel_events_message_uq").on(t.connectionId, t.messageKey),
    index("builder_channel_events_received_idx").on(t.receivedAt),
  ],
);

export type BuilderChannelThreadRow = typeof builderChannelThreads.$inferSelect;

/**
 * ADR-0175 A15 (migration 0142) — THE FACTORS BEHIND THE ENERGY ESTIMATE.
 *
 * Admin-entered, each with a source note and a version, because an estimate is
 * only as honest as the number it multiplies by. A `model` row holds Wh per 1k
 * input and per 1k output tokens for one model id (matched case-insensitively
 * against `usage_events.model`); a `grid` row holds gCO2e per kWh for
 * `default` or a named region (`org_settings.energy_region` picks the region).
 *
 * The product ships NO rows: no default factor for any real model and no
 * default grid intensity. A model with no row is "unknown" in every estimate,
 * never zero. `demo` marks a factor seeded for a mock model by the demo setup,
 * which the UI labels as a demo value, not a measurement.
 */
export const ENERGY_FACTOR_KINDS = ["model", "grid"] as const;
export const energyFactors = pgTable(
  "energy_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ENERGY_FACTOR_KINDS }).notNull(),
    subject: text("subject").notNull(),
    whPer1kInput: doublePrecision("wh_per_1k_input"),
    whPer1kOutput: doublePrecision("wh_per_1k_output"),
    gCo2ePerKwh: doublePrecision("g_co2e_per_kwh"),
    sourceNote: text("source_note").notNull(),
    version: text("version").notNull(),
    demo: boolean("demo").notNull().default(false),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("energy_factors_kind_subject_uq").on(t.kind, sql`lower(${t.subject})`),
    check("energy_factors_kind_ck", sql`${t.kind} IN ('model', 'grid')`),
  ],
);

export type EnergyFactorRow = typeof energyFactors.$inferSelect;
