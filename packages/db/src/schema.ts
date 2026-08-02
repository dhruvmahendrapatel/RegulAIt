import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  boolean,
  doublePrecision,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
  /** login lockout counters (org_settings dials set the thresholds) */
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
});

// --- ADR-0025: OIDC SSO ------------------------------------------------------
export const oidcProviders = pgTable("oidc_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  issuerUrl: text("issuer_url").notNull(),
  clientId: text("client_id").notNull(),
  /** AES-256-GCM under REGULAIT_DATA_KEY; write-only at the API */
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** NULL = any domain; else the verified email claim's domain must be listed */
  allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>(),
  /** role granted to JIT-provisioned users (never admin); NULL = no role */
  defaultRoleId: uuid("default_role_id").references(() => roles.id, { onDelete: "set null" }),
  /** default-deny: an unknown subject with JIT off is 403'd and audited */
  jitProvisioning: boolean("jit_provisioning").notNull().default(false),
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
  /** the matching SP public certificate (PEM) — public by definition, it is
   * published in our SP metadata for the IdP admin to consume. */
  spCertificate: text("sp_certificate"),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["read", "write"] }).notNull(),
    description: text("description"),
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
  },
  (t) => [index("audit_log_user_at_idx").on(t.userId, t.at)],
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
      enum: ["mcp_tool", "workflow", "run", "project", "infra_operation"],
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
      enum: ["pending", "approved", "denied", "consumed", "superseded"],
    })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
  },
  (t) => [
    index("approvals_status_idx").on(t.status),
    index("approvals_user_server_tool_idx").on(t.userId, t.serverId, t.toolName),
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
  },
  (t) => [index("api_keys_user_idx").on(t.userId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("role_assignments_user_role_uq").on(t.userId, t.roleId)],
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
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(),
  tier: integer("tier").notNull(),
  modes: jsonb("modes").$type<string[]>(),
  enabled: boolean("enabled").notNull().default(true),
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
    detail: jsonb("detail"),
  },
  (t) => [index("usage_events_user_idx").on(t.userId, t.at)],
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
  (t) => [index("cert_inventory_resource_idx").on(t.resourceId)],
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
  (t) => [index("backup_runs_resource_idx").on(t.resourceId)],
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
export const BUDGET_ENFORCEMENTS = ["block", "warn_only"] as const;
export const APPROVAL_QUORUMS = ["all", "any"] as const;

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

    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("org_settings_singleton", sql`${t.id} = 'singleton'`)],
);

export type OrgSettingsRow = typeof orgSettings.$inferSelect;
