/**
 * ADR-0036 — SAML 2.0 SSO, a SECOND federated login path beside OIDC.
 *
 * The design rule of this file is "twin, not fork": every decision that OIDC
 * already made is re-used rather than re-litigated. Same `createSession`, same
 * default-deny JIT, same `allowed_email_domains` backstop, same audit shape,
 * same ADR-0039 IP-policy gate at the session-creation site, same write-only
 * AES-256-GCM secret handling. What is genuinely new is the protocol, and the
 * protocol is where SAML earns its reputation:
 *
 *   XML digital signatures, and the signature-wrapping (XSW) / canonicalization
 *   attack class against them, are DELEGATED WHOLESALE to
 *   `@node-saml/node-saml`. This file does not canonicalize XML, does not
 *   resolve signature references, and does not verify a signature. That is the
 *   explicit point of the ADR: "If a later security review finds the chosen
 *   library wanting, the decision is to SWAP THE LIBRARY, never to in-house the
 *   crypto."
 *
 * What this file *does* own, because the library does not:
 *
 *  - **Cert PINNING.** `idpCert` is always the provider's stored PEM list.
 *    Nothing is ever read from a `<KeyInfo>` in the document. A list, not a
 *    single value, so a certificate ROLLOVER can stage the incoming cert.
 *  - **Issuer pinning.** node-saml enforces `idpIssuer` for logout messages
 *    only, NOT for a login Response — so the assertion's `<Issuer>` is checked
 *    here against `saml_providers.entity_id`, on the LIBRARY-VERIFIED
 *    assertion (never on raw input).
 *  - **Recipient pinning.** node-saml validates Audience, NotBefore/
 *    NotOnOrAfter and InResponseTo, but does not compare
 *    `SubjectConfirmationData/@Recipient` to our ACS URL. Also checked here,
 *    again only on the verified assertion.
 *  - **Replay.** The assertion `ID` is inserted into `saml_assertion_ids`; the
 *    UNIQUE index IS the refusal, so two concurrent replays cannot both win a
 *    check-then-insert race.
 *  - **Solicited-only by default.** `allow_idp_initiated` is off unless an
 *    admin opts in; when off, `validateInResponseTo: always` plus an explicit
 *    post-check refuse any assertion with no outstanding correlation row.
 *
 * Identity maps on the asserted EMAIL via the shared `loadUserByEmail`, never
 * on `users.username` (ADR-0030): a username is admin/self-managed, and
 * letting an IdP attribute select one would let a misconfigured IdP
 * impersonate an account. `allowed_email_domains` is the mandatory backstop.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";
import type { Profile } from "@node-saml/node-saml";
import {
  and,
  eq,
  gt,
  lt,
  roleAssignments,
  roles,
  samlAssertionIds,
  samlLoginStates,
  samlProviders,
  users,
  type Db,
} from "@regulait/db";
import {
  createSamlProviderSchema,
  OIDC_JIT_DOMAINS_REQUIRED,
  oidcJitDomainsMissing,
  updateSamlProviderSchema,
} from "@regulait/shared";
import { z } from "zod";
import {
  SAML_BINDING_COOKIE,
  auditAuth,
  beginSamlTotpStepUp,
  createSession,
  linkCookie,
  mfaPendingCookie,
  readCookie,
  refuseIpBlockedLogin,
  requestIsSecure,
  sessionCookie,
  ssoBindingCookie,
  ssoBindingMatches,
  ssoBrowserBinding,
} from "./auth.js";
import { refuseIfFeatureNotLicensed } from "./licensing.js";

/** ADR-0181 (FX2, review finding 12): the audited cause, and the holder-facing
 * wording, of a sign-in refused because the IdP did not sign the SAML Response
 * envelope while the provider requires it (strict since migration 0156) */
export const SAML_RESPONSE_SIGNING_REQUIRED = "response_signing_required";
export const SAML_RESPONSE_SIGNING_DETAIL =
  "response signing required: this identity provider did not sign the SAML Response, and the provider requires it " +
  "(wantAuthnResponseSigned). Configure the IdP to sign the Response, or an admin can relax `wantAuthnResponseSigned` " +
  "on this SAML provider (audited) if the IdP signs only the assertion.";
import { loadOrgSettings } from "./org-settings.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { normalizeAssertedGroups, reconcileGroupRoles } from "./group-roles.js";
import { settingTransitions } from "./setting-transitions.js";
import {
  dropProviderLinks,
  LINK_PROOF_MINUTES,
  normalizeClaimEmail,
  orgRequiresMfa,
  raiseLinkRequest,
  recordFederatedLink,
  resolveFederatedLogin,
  samlAnchor,
  samlAuthnContextMfa,
  touchFederatedLink,
  type ProviderRef,
} from "./federated-identity.js";
import {
  providerRemovalRefusal,
  signInInvariantChecked,
  signInInvariantWritten,
  withSignInInvariant,
  type SignInInvariantSite,
} from "./break-glass.js";

export interface SamlRouteOptions {
  dataKey?: string;
}

/** how long an outstanding SP-initiated AuthnRequest correlation row lives —
 * the OIDC state row's ten minutes, for the same reason (a human completing a
 * login at their IdP, not an unbounded window for a captured assertion). */
export const SAML_STATE_MINUTES = 10;
/** ADR-0167 (CFG-06): the two short-lived tables are swept at most this often
 * per process, not on every anonymous ACS post */
export const SAML_SWEEP_INTERVAL_MS = 60_000;
/** ADR-0167 (SEC-02): a base64 SAMLResponse larger than this is refused
 * before it is decoded — 256 KiB of base64 is ~190 KB of XML, several times
 * the largest real assertion and a tiny fraction of the global body limit */
export const SAML_RESPONSE_MAX_CHARS = 256 * 1024;
/** the raw form body the ACS accepts: the response above plus RelayState and
 * encoding slack, well under the 1 MiB global limit */
export const SAML_ACS_BODY_LIMIT_BYTES = SAML_RESPONSE_MAX_CHARS + 16 * 1024;

/**
 * Clock-skew tolerance for NotBefore / NotOnOrAfter, in MINUTES. Bounded and
 * single-digit by construction, mirroring the ±1-step TOTP tolerance already in
 * the codebase: configurable via REGULAIT_SAML_CLOCK_SKEW_MINUTES, but clamped
 * to [0, 9] so a fat-fingered "600" cannot turn expiry enforcement off. There
 * is deliberately NO "unlimited" value — node-saml treats
 * `acceptedClockSkewMs: -1` as "skip timestamp checks entirely", and that
 * value is unreachable from here.
 */
export const SAML_MAX_CLOCK_SKEW_MINUTES = 9;
export function samlClockSkewMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGULAIT_SAML_CLOCK_SKEW_MINUTES;
  if (raw === undefined || raw.trim() === "") return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(Math.floor(n), SAML_MAX_CLOCK_SKEW_MINUTES);
}

/** the deployment-global SP entity id. Derived from the request host exactly
 * like the OIDC redirect_uri (one deployment, one origin), unless an operator
 * pins it explicitly — an entity id that changes because a load balancer
 * renamed a host would silently break every IdP's AudienceRestriction. */
export function spEntityId(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.REGULAIT_SAML_ENTITY_ID;
  if (pinned && pinned.trim().length > 0) return pinned.trim();
  return `${baseUrl}/auth/saml/metadata`;
}

function baseUrlFor(req: FastifyRequest): string {
  const proto = requestIsSecure(req) ? "https" : "http";
  const host = req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

export function acsUrlFor(baseUrl: string, providerId: string): string {
  return `${baseUrl}/auth/saml/${providerId}/acs`;
}

type SamlProviderRow = typeof samlProviders.$inferSelect;

/**
 * Build the library instance for one provider.
 *
 * `idpCert` is the pinned PEM LIST — node-saml tries each, so a staged
 * rollover cert works from the moment it is saved. `audience` is our SP entity
 * id, which is what turns an assertion minted for a DIFFERENT SP into a
 * refusal. `validateInResponseTo` is the solicited-only switch.
 *
 * The `cacheProvider` is backed by `saml_login_states` rather than the
 * library's in-memory default: an in-memory correlation set would (a) not
 * survive a restart, and (b) not be shared across gateway processes, so a
 * legitimate login could land on a process that never saw the request — and
 * the fail-open shape of "we don't remember, so allow it" is exactly the
 * property IdP-initiated SSO is opt-in to avoid.
 */
function samlFor(
  db: Db,
  provider: SamlProviderRow,
  acsUrl: string,
  entityId: string,
  opts: SamlRouteOptions,
  /** set only on the /start leg, where we mint the request id ourselves so the
   * correlation row can be written with the returnTo/relay_state alongside */
  forcedRequestId?: string,
  /** ADR-0181 (FX2): a DIAGNOSTIC instance only — never used to sign anyone in */
  diagnostic?: { ignoreResponseSignature: true },
): SAML {
  const privateKey = provider.spPrivateKeyCiphertext && opts.dataKey
    ? decryptSecret(opts.dataKey, provider.spPrivateKeyCiphertext)
    : undefined;
  return new SAML({
    // --- pinned trust anchors -------------------------------------------
    idpCert: provider.idpSigningCerts,
    issuer: entityId,
    audience: entityId,
    callbackUrl: acsUrl,
    entryPoint: provider.idpSsoUrl,
    // --- posture ---------------------------------------------------------
    wantAssertionsSigned: diagnostic ? true : provider.wantAssertionsSigned,
    wantAuthnResponseSigned: diagnostic ? false : provider.wantAuthnResponseSigned,
    acceptedClockSkewMs: samlClockSkewMinutes() * 60_000,
    requestIdExpirationPeriodMs: SAML_STATE_MINUTES * 60_000,
    // ADR-0036: IdP-initiated is OPT-IN. `always` refuses an assertion that
    // carries no InResponseTo at all as well as one whose InResponseTo names
    // no outstanding request; `ifPresent` still validates a solicited login
    // fully but permits the unsolicited shape the admin opted into.
    // (a diagnostic instance never touches the single-use correlation row)
    validateInResponseTo: diagnostic
      ? ValidateInResponseTo.never
      : provider.allowIdpInitiated
        ? ValidateInResponseTo.ifPresent
        : ValidateInResponseTo.always,
    cacheProvider: loginStateCache(db, provider.id),
    ...(forcedRequestId ? { generateUniqueId: () => forcedRequestId } : {}),
    // optional SP-side signing material (write-only at rest)
    ...(privateKey ? { privateKey } : {}),
    ...(provider.spCertificate ? { publicCert: provider.spCertificate } : {}),
  });
}

/**
 * The library's `CacheProvider` contract, backed by `saml_login_states`.
 *
 * - `saveAsync` is a no-op: the /start route has ALREADY written the row (it
 *   owns the request id, so it can persist relay_state + returnTo + acs_url in
 *   the same insert). Returning the row's shape keeps the contract honest.
 * - `getAsync` returns the row's creation instant, which is what the library
 *   compares against `requestIdExpirationPeriodMs`. A missing/expired row
 *   returns null and the library refuses.
 * - `removeAsync` deletes the row — that is what makes the correlation
 *   SINGLE-USE, exactly like the OIDC state row.
 */
function loginStateCache(db: Db, providerId: string) {
  return {
    async saveAsync(key: string, value: string) {
      return { value, createdAt: Date.now() };
    },
    async getAsync(key: string): Promise<string | null> {
      const [row] = await db
        .select({ createdAt: samlLoginStates.createdAt })
        .from(samlLoginStates)
        .where(
          and(
            eq(samlLoginStates.requestId, key),
            eq(samlLoginStates.providerId, providerId),
            gt(samlLoginStates.expiresAt, new Date()),
          ),
        );
      return row ? row.createdAt.toISOString() : null;
    },
    async removeAsync(key: string | null): Promise<string | null> {
      if (!key) return null;
      await db.delete(samlLoginStates).where(eq(samlLoginStates.requestId, key));
      return key;
    },
  };
}

// ---------------------------------------------------------------------------
// verified-assertion inspection
// ---------------------------------------------------------------------------
// Everything below reads the xml2js projection of the assertion the library
// ALREADY verified the signature of (`profile.getAssertion()`), never the raw
// POST body. Reading an attribute off unverified XML is the whole XSW bug
// class; reading one off verified XML is just reading.

type Xml = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function verifiedAssertion(profile: Profile): Xml | null {
  const parsed = profile.getAssertion?.() as Xml | undefined;
  const assertion = parsed?.Assertion;
  return assertion && typeof assertion === "object" ? (assertion as Xml) : null;
}

/** the assertion's own ID and NotOnOrAfter — the replay guard's key + TTL */
export function assertionIdentity(assertion: Xml | null): {
  id: string | null;
  notOnOrAfter: Date | null;
} {
  const id = typeof assertion?.$?.ID === "string" ? assertion.$.ID : null;
  const raw = assertion?.Conditions?.[0]?.$?.NotOnOrAfter;
  const notOnOrAfter = typeof raw === "string" ? new Date(raw) : null;
  return {
    id,
    notOnOrAfter: notOnOrAfter && !Number.isNaN(notOnOrAfter.getTime()) ? notOnOrAfter : null,
  };
}

/** every `SubjectConfirmationData/@Recipient` the verified assertion carries */
export function assertionRecipients(assertion: Xml | null): string[] {
  const confirmations = assertion?.Subject?.[0]?.SubjectConfirmation;
  if (!Array.isArray(confirmations)) return [];
  const out: string[] = [];
  for (const c of confirmations) {
    const r = c?.SubjectConfirmationData?.[0]?.$?.Recipient;
    if (typeof r === "string") out.push(r);
  }
  return out;
}

export function assertionIssuer(assertion: Xml | null): string | null {
  const raw = assertion?.Issuer?.[0];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw._ === "string") return raw._;
  return null;
}

/** ADR-0174 (finding 1): every `AuthnStatement/AuthnContext/AuthnContextClassRef`
 * of the VERIFIED assertion — the SAML statement of how the person
 * authenticated. Never read from the raw POST body. */
export function assertionAuthnContexts(assertion: Xml | null): string[] {
  const statements = assertion?.AuthnStatement;
  if (!Array.isArray(statements)) return [];
  const out: string[] = [];
  for (const st of statements) {
    const contexts = st?.AuthnContext;
    if (!Array.isArray(contexts)) continue;
    for (const c of contexts) {
      const refs = c?.AuthnContextClassRef;
      if (!Array.isArray(refs)) continue;
      for (const r of refs) {
        const v = typeof r === "string" ? r : r && typeof r._ === "string" ? r._ : null;
        if (v) out.push(v.trim());
      }
    }
  }
  return out;
}

const EMAIL_NAMEID_FORMATS = new Set([
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:emailAddress",
]);

/**
 * ADR-0036 identity mapping: the NameID when its FORMAT says emailAddress,
 * else the provider's configured email attribute, else the conventional
 * carriers node-saml already normalizes (`email` / `mail` / the eduPerson OID).
 *
 * A NameID of some other format (persistent, transient, unspecified) is NOT
 * treated as an email even if it happens to contain an '@' — an
 * `unspecified` NameID is whatever the IdP feels like sending, and silently
 * promoting it to an identity claim is how SSO implementations end up matching
 * on attacker-chosen strings.
 */
export function resolveSamlEmail(
  profile: Profile,
  emailAttribute: string | null,
): { email: string | null; source: string } {
  const { raw, source } = resolveSamlEmailRaw(profile, emailAttribute);
  return { email: raw === null ? null : (normalizeClaimEmail(raw)?.email ?? null), source };
}

/** the email carrier exactly as asserted (trimmed): the ACS normalises it and
 * decides linkability from what the IdP SENT (ADR-0174, finding 7) */
function resolveSamlEmailRaw(
  profile: Profile,
  emailAttribute: string | null,
): { raw: string | null; source: string } {
  const take = (v: unknown): string | null =>
    typeof v === "string" && normalizeClaimEmail(v) !== null ? v.trim() : null;

  if (profile.nameIDFormat && EMAIL_NAMEID_FORMATS.has(profile.nameIDFormat)) {
    const v = take(profile.nameID);
    if (v) return { raw: v, source: "nameid" };
  }
  if (emailAttribute) {
    const v = take((profile as Record<string, unknown>)[emailAttribute]);
    if (v) return { raw: v, source: `attribute:${emailAttribute}` };
  }
  for (const key of ["email", "mail", "urn:oid:0.9.2342.19200300.100.1.3"] as const) {
    const v = take((profile as Record<string, unknown>)[key]);
    if (v) return { raw: v, source: `attribute:${key}` };
  }
  return { raw: null, source: "none" };
}

/**
 * ADR-0038 — the group attribute out of a validated assertion, or `null` for
 * "this assertion carried NO group signal".
 *
 * The null-vs-empty-array distinction is the whole point and is preserved end
 * to end: an assertion that simply does not contain the configured attribute
 * returns `null`, which makes `reconcileGroupRoles` a no-op and leaves existing
 * group-derived roles alone. Only an attribute that IS present (even with zero
 * values) is authoritative, and an authoritative empty list reconciles the user
 * to zero group-derived roles. An IdP that drops the attribute during an
 * incident must not be able to strip an organisation's access.
 *
 * node-saml surfaces attributes both at the top level of the profile and under
 * `profile.attributes`; both are checked, top level first, because a caller
 * configuring `memberOf` means the assertion's `memberOf`, wherever the library
 * chose to put it.
 */
export function resolveSamlGroups(profile: Profile, groupsAttribute: string | null): unknown {
  if (!groupsAttribute) return undefined; // provider emits no group signal
  const bags: Array<Record<string, unknown> | undefined> = [
    profile as unknown as Record<string, unknown>,
    (profile as { attributes?: Record<string, unknown> }).attributes,
  ];
  for (const bag of bags) {
    // hasOwnProperty, NOT `!== undefined`: node-saml creates the key with an
    // `undefined` value when the <Attribute> element is present but its single
    // <AttributeValue> is empty. XML has no empty array, so that is how a SAML
    // IdP says "member of nothing" — and it must stay distinguishable from the
    // attribute being absent altogether, which is the missing-signal case.
    if (bag && Object.prototype.hasOwnProperty.call(bag, groupsAttribute)) {
      const v = bag[groupsAttribute];
      // "" normalises to the authoritative EMPTY list; undefined would
      // normalise to "no signal", which is the opposite meaning.
      return v === undefined || v === null ? "" : v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const providerParam = z.object({ providerId: z.string().uuid() });

/** the admin-visible projection: the SP private key is WRITE-ONLY and is
 * deliberately absent, exactly like oidc_providers.client_secret_ciphertext */
const publicProvider = (p: SamlProviderRow) => ({
  id: p.id,
  name: p.name,
  entityId: p.entityId,
  idpSsoUrl: p.idpSsoUrl,
  idpSigningCerts: p.idpSigningCerts,
  enabled: p.enabled,
  allowedEmailDomains: p.allowedEmailDomains,
  defaultRoleId: p.defaultRoleId,
  jitProvisioning: p.jitProvisioning,
  wantAssertionsSigned: p.wantAssertionsSigned,
  wantAuthnResponseSigned: p.wantAuthnResponseSigned,
  allowIdpInitiated: p.allowIdpInitiated,
  emailAttribute: p.emailAttribute,
  /** ADR-0038: null = this provider emits no group signal, so its logins never
   * reconcile group-derived roles. */
  groupsAttribute: p.groupsAttribute,
  mfaAuthnContexts: p.mfaAuthnContexts,
  /** the operator needs to know whether SP signing material EXISTS without
   * ever being able to read it back */
  spPrivateKeySet: p.spPrivateKeyCiphertext !== null,
  spCertificate: p.spCertificate,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export function registerSamlRoutes(app: FastifyInstance, db: Db, opts: SamlRouteOptions = {}) {
  const loadEnabled = async (providerId: string) => {
    const [p] = await db
      .select()
      .from(samlProviders)
      .where(and(eq(samlProviders.id, providerId), eq(samlProviders.enabled, true)));
    return p ?? null;
  };

  /** opportunistic sweep of both short-lived tables — cheap, indexed, and it
   * keeps the replay seen-set from growing without bound. Rows past their
   * expiry are refused on their own timestamps anyway, so deleting them
   * weakens nothing.
   *
   * ADR-0167 (CFG-06): run at most once a minute per process, not once per
   * request. The ACS is unauthenticated; two DELETEs per anonymous POST made
   * the login surface the cheapest write amplifier in the product. Hygiene,
   * not enforcement — ADR-0064's rule holds, so throttling it costs nothing. */
  let lastSweepAt = 0;
  const sweep = async () => {
    const nowMs = Date.now();
    if (nowMs - lastSweepAt < SAML_SWEEP_INTERVAL_MS) return;
    lastSweepAt = nowMs;
    const now = new Date(nowMs);
    await db.delete(samlLoginStates).where(lt(samlLoginStates.expiresAt, now));
    await db.delete(samlAssertionIds).where(lt(samlAssertionIds.expiresAt, now));
  };

  // ---- the login screen's provider list (auth-exempt, names only) ---------
  app.get("/auth/saml/providers", async () => {
    const rows = await db.select().from(samlProviders).where(eq(samlProviders.enabled, true));
    return { providers: rows.map((p) => ({ id: p.id, name: p.name })) };
  });

  // ---- GET /auth/saml/:providerId/metadata -------------------------------
  // SP metadata for the IdP administrator to consume. Public by definition:
  // it contains our entity id, our ACS URL and (when configured) our PUBLIC
  // certificate — the three things an IdP admin must type in by hand
  // otherwise. No secret is derivable from it.
  app.get("/auth/saml/:providerId/metadata", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const [provider] = await db
      .select()
      .from(samlProviders)
      .where(eq(samlProviders.id, providerId));
    if (!provider) return reply.status(404).send({ error: "unknown_provider" });
    const base = baseUrlFor(req);
    const entityId = spEntityId(base);
    const saml = samlFor(db, provider, acsUrlFor(base, providerId), entityId, opts);
    const xml = saml.generateServiceProviderMetadata(null, provider.spCertificate ?? null);
    return reply.header("content-type", "application/samlmetadata+xml; charset=utf-8").send(xml);
  });

  // ---- GET /auth/saml/:providerId/start ----------------------------------
  // SP-initiated: mint an AuthnRequest, persist the SINGLE-USE correlation row
  // (request id + relay state + returnTo + the ACS URL this request named),
  // and 302 to the IdP. The OIDC /start route, one protocol over.
  app.get("/auth/saml/:providerId/start", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const { returnTo } = z
      .object({ returnTo: z.enum(["/app", "/admin"]).optional() })
      .parse(req.query);
    const provider = await loadEnabled(providerId);
    if (!provider) return reply.status(404).send({ error: "unknown_provider" });
    await sweep();

    // we generate the request id so the correlation row can carry the
    // returnTo/relay state the library knows nothing about. SAML IDs are
    // xsd:ID — they may not start with a digit, hence the leading underscore.
    const requestId = "_" + randomBytes(20).toString("hex");
    const relayState = randomBytes(24).toString("base64url");
    const base = baseUrlFor(req);
    const acsUrl = acsUrlFor(base, providerId);
    await db.insert(samlLoginStates).values({
      providerId,
      requestId,
      relayState,
      returnTo: returnTo ?? "/app",
      acsUrl,
      expiresAt: new Date(Date.now() + SAML_STATE_MINUTES * 60_000),
    });
    const saml = samlFor(db, provider, acsUrl, spEntityId(base), opts, requestId);
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    // ADR-0167 (AUTHZ-04): bind this login to THIS browser. The ACS is a
    // cross-site POST, so the cookie must be SameSite=None + Secure — which
    // only a secure request can set (see the note in auth.ts).
    if (requestIsSecure(req)) {
      void reply.header(
        "set-cookie",
        ssoBindingCookie(SAML_BINDING_COOKIE, ssoBrowserBinding(opts.dataKey, relayState), {
          path: "/auth/saml",
          secure: true,
          crossSite: true,
        }),
      );
    }
    return reply.redirect(url, 302);
  });

  // ---- POST /auth/saml/:providerId/acs -----------------------------------
  // The Assertion Consumer Service. Encapsulated scope: the IdP POSTs a
  // form-urlencoded body (that is what the SAML HTTP-POST binding IS), and the
  // gateway otherwise speaks only JSON — so the parser swap is scoped to this
  // one route and global JSON parsing is untouched, the same pattern the PM
  // webhook route uses for its raw-body capture.
  //
  // No CSRF header: the request originates at the IdP, not at our SPA, and the
  // global CSRF wall only applies to COOKIE-authenticated mutations (this
  // route is auth-exempt and carries no session). The SAML-native replacement
  // for CSRF is exactly the InResponseTo correlation this route enforces.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body: string, done) => {
        try {
          const params = new URLSearchParams(body);
          const out: Record<string, string> = {};
          for (const [k, v] of params) out[k] = v;
          done(null, out);
        } catch (err) {
          done(err as Error);
        }
      },
    );

    // ADR-0167 (SEC-02/CFG-06): the ACS body is bounded well below the global
    // 1 MiB limit. A real SAMLResponse is tens of KB; what a megabyte buys an
    // anonymous caller is a megabyte of attacker XML through a parser with
    // known quadratic paths, synchronously on the event loop. The route-level
    // `bodyLimit` refuses the raw body (413, mapped honestly by the error
    // handler); the zod `max` below refuses a decoded response that would
    // still be too large to parse.
    scope.post("/auth/saml/:providerId/acs", { bodyLimit: SAML_ACS_BODY_LIMIT_BYTES }, async (req, reply) => {
      const { providerId } = providerParam.parse(req.params);
      const body = z
        .object({
          SAMLResponse: z.string().min(1).max(SAML_RESPONSE_MAX_CHARS),
          RelayState: z.string().max(1024).optional(),
        })
        .safeParse(req.body ?? {});
      if (!body.success) {
        const tooBig = body.error.issues.some((i) => i.code === "too_big");
        return reply
          .status(tooBig ? 413 : 400)
          .send({ error: tooBig ? "saml_response_too_large" : "missing_saml_response" });
      }
      const provider = await loadEnabled(providerId);
      if (!provider) return reply.status(404).send({ error: "unknown_provider" });
      await sweep();

      const base = baseUrlFor(req);
      const acsUrl = acsUrlFor(base, providerId);
      const entityId = spEntityId(base);

      /** the audited refusal shape every validation failure below shares —
       * the HTTP body stays deliberately coarse (an IdP-facing endpoint is
       * not a debugging oracle), the audit row carries the real reason. */
      const refuse = async (
        status: number,
        error: string,
        ruleId: string,
        reason: string,
        detail: Record<string, unknown>,
        targetUserId: string | null = null,
        /** ADR-0181 (FX2): a holder-facing explanation, when one helps the
         * person (or their admin) fix the cause rather than retry */
        holderDetail?: string,
      ) => {
        await auditAuth(db, null, targetUserId, ruleId, "deny", reason,
          { phase: "saml-acs", provider: provider.name, ...detail },
          targetUserId ? "user" : "saml_provider");
        return reply.status(status).send(holderDetail ? { error, detail: holderDetail } : { error });
      };

      // Read the correlation row BEFORE validation: the library's
      // cacheProvider consumes (deletes) it as part of enforcing
      // InResponseTo, and we still need its returnTo afterwards.
      const [state] = body.data.RelayState
        ? await db
            .select()
            .from(samlLoginStates)
            .where(
              and(
                eq(samlLoginStates.relayState, body.data.RelayState),
                eq(samlLoginStates.providerId, providerId),
                gt(samlLoginStates.expiresAt, new Date()),
              ),
            )
        : [];

      // ADR-0167 (AUTHZ-04): an SP-initiated login completes only in the
      // browser that started it. Checked BEFORE the XML is parsed, so a
      // planted response is refused at the cost of a cookie comparison. Only
      // over a secure request — the binding cookie cannot exist otherwise
      // (SameSite=None requires Secure) — and only for a correlated login:
      // IdP-initiated stays behind `allowIdpInitiated` below, unchanged.
      if (state && requestIsSecure(req)) {
        const presentedBinding = readCookie(req.headers.cookie, SAML_BINDING_COOKIE);
        if (!ssoBindingMatches(presentedBinding, ssoBrowserBinding(opts.dataKey, state.relayState))) {
          // spent either way, like the OIDC state: a planted RelayState is not
          // retryable until it expires, and the IdP is never contacted for it
          await db
            .delete(samlLoginStates)
            .where(and(eq(samlLoginStates.relayState, state.relayState), eq(samlLoginStates.providerId, providerId)));
          return refuse(401, "login_not_bound_to_this_browser", "saml-login-browser-mismatch",
            `SAML login for provider '${provider.name}' refused: the login was started in a different browser (login CSRF) — no session minted`,
            { bindingCookiePresent: presentedBinding !== null });
        }
      }

      // ---- signature + audience + timestamps + InResponseTo: the LIBRARY --
      let profile: Profile;
      try {
        const saml = samlFor(db, provider, acsUrl, entityId, opts);
        const result = await saml.validatePostResponseAsync({
          SAMLResponse: body.data.SAMLResponse,
          ...(body.data.RelayState ? { RelayState: body.data.RelayState } : {}),
        });
        if (!result.profile) throw new Error("no profile in SAML response");
        profile = result.profile;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // ADR-0181 (FX2, review finding 12): migration 0156 turned
        // wantAuthnResponseSigned on for every provider. An IdP that signs only
        // the assertion now fails here, and the refusal NAMES the setting so an
        // admin can tell a posture choice from a broken certificate. Decided
        // exactly, not guessed from wording: the library's "no valid top-level
        // signature" error, AND the same response validating in full (pinned
        // certs, signed assertion, audience, timestamps) once only the Response
        // signature is set aside. The probe signs nobody in.
        let responseUnsigned = false;
        if (provider.wantAuthnResponseSigned && message === "Invalid document signature") {
          try {
            const probe = samlFor(db, provider, acsUrl, entityId, opts, undefined, { ignoreResponseSignature: true });
            responseUnsigned = Boolean(
              (await probe.validatePostResponseAsync({ SAMLResponse: body.data.SAMLResponse })).profile,
            );
          } catch {
            responseUnsigned = false;
          }
        }
        return refuse(401, "saml_validation_failed", "saml-login-failed",
          `SAML assertion validation failed for provider '${provider.name}'` +
            (responseUnsigned ? ": the SAML Response envelope is not signed (wantAuthnResponseSigned is on)" : ""),
          { error: message, ...(responseUnsigned ? { cause: SAML_RESPONSE_SIGNING_REQUIRED } : {}) },
          null,
          responseUnsigned ? SAML_RESPONSE_SIGNING_DETAIL : undefined);
      }

      const assertion = verifiedAssertion(profile);

      // ---- solicited-only, stated twice on purpose ------------------------
      // `validateInResponseTo: always` already refuses an unsolicited
      // assertion inside the library. This is the belt to that braces: the
      // one property we are least willing to have silently regress if a
      // library default moves is "an unsolicited assertion is not a login".
      if (!provider.allowIdpInitiated && typeof profile.inResponseTo !== "string") {
        return refuse(403, "idp_initiated_not_allowed", "saml-idp-initiated-refused",
          `SAML login refused: unsolicited (IdP-initiated) assertion and allow_idp_initiated is off for provider '${provider.name}'`,
          { allowIdpInitiated: false });
      }

      // ---- issuer pinning (ours: node-saml pins idpIssuer for LOGOUT only)
      const issuer = assertionIssuer(assertion) ?? profile.issuer ?? null;
      if (issuer !== provider.entityId) {
        return refuse(403, "saml_issuer_mismatch", "saml-issuer-refused",
          `SAML login refused: assertion issuer '${issuer ?? "(none)"}' is not the provider's pinned entity id`,
          { issuer, expected: provider.entityId });
      }

      // ---- Recipient pinning (ours: node-saml does not compare it) --------
      // Refused when present-and-wrong AND when absent: a SubjectConfirmation
      // without a Recipient is an assertion nobody addressed to us, which is
      // precisely the token-redirection case this check exists for.
      const recipients = assertionRecipients(assertion);
      if (recipients.length === 0 || !recipients.includes(acsUrl)) {
        return refuse(403, "saml_recipient_mismatch", "saml-recipient-refused",
          `SAML login refused: no SubjectConfirmationData Recipient matches this ACS URL`,
          { recipients, expected: acsUrl });
      }

      // ---- replay: the assertion ID is single-use inside its window -------
      const { id: assertionId, notOnOrAfter } = assertionIdentity(assertion);
      if (!assertionId) {
        return refuse(403, "saml_assertion_id_missing", "saml-assertion-id-missing",
          "SAML login refused: the assertion carries no ID, so replay cannot be prevented",
          {});
      }
      {
        // the UNIQUE index IS the guard: an insert that conflicts is a replay,
        // so two simultaneous presentations cannot both pass a read-then-write
        const skewMs = samlClockSkewMinutes() * 60_000;
        const expiresAt = notOnOrAfter
          ? new Date(notOnOrAfter.getTime() + skewMs)
          : new Date(Date.now() + SAML_STATE_MINUTES * 60_000);
        const inserted = await db
          .insert(samlAssertionIds)
          .values({ providerId, assertionId, expiresAt })
          .onConflictDoNothing()
          .returning({ id: samlAssertionIds.id });
        if (inserted.length === 0) {
          return refuse(403, "saml_assertion_replayed", "saml-assertion-replayed",
            `SAML login refused: assertion '${assertionId}' has already been presented`,
            { assertionId });
        }
      }

      // ---- identity: the asserted EMAIL, never users.username -------------
      const { raw: rawEmail, source } = resolveSamlEmailRaw(profile, provider.emailAttribute);
      const normalized = rawEmail === null ? null : normalizeClaimEmail(rawEmail);
      const email = normalized?.email ?? null;
      if (!normalized || !email) {
        return refuse(403, "saml_no_email", "saml-login-failed",
          `SAML login refused: no email could be resolved from the assertion (provider '${provider.name}')`,
          { nameIDFormat: profile.nameIDFormat ?? null, emailAttribute: provider.emailAttribute });
      }
      const domain = email.slice(email.indexOf("@") + 1);
      if (provider.allowedEmailDomains && !provider.allowedEmailDomains.includes(domain)) {
        return refuse(403, "email_domain_not_allowed", "saml-domain-refused",
          `SAML login refused: '${email}' is outside the provider's allowed domains`,
          { email, domain });
      }

      // ADR-0174 §5: the linked (provider, entity id, NameID format, NameID)
      // first, then the asserted email — the SAME linking rule the OIDC
      // callback answers to. A transient (or absent) NameID is never an
      // anchor: the assertion is anchored on its verified email instead.
      const ref: ProviderRef = { kind: "saml", id: provider.id, name: provider.name };
      const anchor = samlAnchor(ref, provider.entityId, profile.nameID, profile.nameIDFormat, email);
      const subject = anchor.subject;
      // ADR-0174 (finding 1): MFA is read from the VERIFIED assertion only
      const mfa = samlAuthnContextMfa(assertionAuthnContexts(assertion), provider.mfaAuthnContexts ?? null);
      const resolution = await resolveFederatedLogin(db, anchor, normalized);
      if (resolution.kind === "not_linkable") {
        return refuse(403, "email_not_linkable", "saml-login-failed",
          `SAML login refused: provider '${provider.name}' asserted an email outside plain ASCII, which is never matched to an account`,
          { why: "email_not_linkable", emailSource: source });
      }
      let user = resolution.kind === "none" ? null : resolution.user;
      if (user?.disabledAt) {
        await auditAuth(db, null, user.id, "saml-login-failed", "deny",
          `SAML login refused: account '${email}' is deactivated`,
          { phase: "saml-acs", provider: provider.name, email });
        return reply.status(401).send({
          error: "user_disabled",
          detail: "this account has been deactivated — an admin can reactivate it",
        });
      }
      if (resolution.kind === "proof") {
        const link = await raiseLinkRequest(db, anchor, email, resolution.user.id, mfa.asserted);
        await auditAuth(db, null, resolution.user.id, "federated-link-required", "deny",
          `SAML identity from provider '${provider.name}' matched the existing account '${resolution.user.email}', which is already in use — link pending proof or admin approval, no session minted`,
          { phase: "saml-acs", provider: provider.name, providerId: provider.id, providerKind: "saml", email, sub: subject, nameIDFormat: anchor.subjectFormat, why: resolution.why, linkRequestId: link.requestId, refreshed: link.refreshed });
        void reply.header("set-cookie", linkCookie(link.proofToken, requestIsSecure(req), LINK_PROOF_MINUTES * 60));
        return reply.redirect("/ui/login?link=pending", 302);
      }
      if (resolution.kind === "link") {
        await recordFederatedLink(db, anchor, resolution.user.id, resolution.via);
        await auditAuth(db, null, resolution.user.id, "federated-identity-linked", "allow",
          resolution.via === "prior_sso"
            ? `SAML identity from provider '${provider.name}' linked to '${resolution.user.email}', who signed in through this provider before migration 0139 (backfill)`
            : `SAML identity from provider '${provider.name}' linked to the pre-provisioned account '${resolution.user.email}' (never signed in, no local credential)`,
          { phase: "saml-acs", provider: provider.name, providerId: provider.id, providerKind: "saml", email, sub: subject, nameIDFormat: anchor.subjectFormat, linkedVia: resolution.via });
      } else if (resolution.kind === "linked") {
        await touchFederatedLink(db, anchor);
      }
      if (!user) {
        // DEFAULT-DENY, identical to OIDC: an unknown subject is refused
        // unless the admin opted this provider into JIT provisioning.
        if (!provider.jitProvisioning) {
          return refuse(403, "unknown_user", "saml-unknown-subject",
            `SAML login refused: no account for '${email}' and JIT provisioning is off for provider '${provider.name}'`,
            { email, emailSource: source });
        }
        const displayName =
          typeof profile.displayName === "string" && profile.displayName.trim().length > 0
            ? profile.displayName.trim()
            : email.slice(0, email.indexOf("@"));
        // JIT users are NEVER admins; the provider's default role is the ceiling
        const [created] = await db
          .insert(users)
          .values({ email, displayName, isAdmin: false })
          .returning();
        user = created!;
        if (provider.defaultRoleId) {
          await db
            .insert(roleAssignments)
            .values({ userId: user.id, roleId: provider.defaultRoleId })
            .onConflictDoNothing();
        }
        await auditAuth(db, null, user.id, "saml-user-provisioned", "allow",
          `user '${email}' JIT-provisioned via SAML provider '${provider.name}'${provider.defaultRoleId ? " with the provider's default role" : ""} (never admin)`,
          { phase: "saml-jit", provider: provider.name, email, defaultRoleId: provider.defaultRoleId });
        await recordFederatedLink(db, anchor, user.id, "jit");
      }

      // ADR-0038 — group → role reconciliation from the assertion's group
      // attribute, through the SAME shared routine SCIM and OIDC use.
      //
      // The fail-safe, restated at the call site because it is the difference
      // between a safe deploy and a mass access-strip: `groupsAttribute` null =
      // this provider emits no group signal; the attribute configured but
      // ABSENT from this assertion = also no signal, leave current state alone;
      // the attribute PRESENT (including with zero values) = authoritative, and
      // an authoritative empty list reconciles to zero group-derived roles.
      if (provider.groupsAttribute) {
        const asserted = normalizeAssertedGroups(
          resolveSamlGroups(profile, provider.groupsAttribute),
        );
        await reconcileGroupRoles(db, user.id, "saml", asserted, {
          kind: "saml-login",
          actor: `saml provider '${provider.name}'`,
          actorUserId: user.id,
          detail: {
            providerId: provider.id,
            provider: provider.name,
            groupsAttribute: provider.groupsAttribute,
            assertionId,
          },
        });
      }

      const org = await loadOrgSettings(db);
      // ADR-0039: SSO is a HUMAN login — an IdP vouching for the user does not
      // move the request inside the org's network envelope. `saml` is in
      // HUMAN_SESSION_ORIGINS, so session_ip_policy governs it from day one.
      if (
        await refuseIpBlockedLogin(db, req, reply, org, "session_ip_policy", {
          method: "saml",
          userId: user.id,
          email,
          provider: provider.name,
        })
      ) {
        return reply;
      }
      // ADR-0174 (finding 1): when the org requires MFA for this person and
      // the verified assertion names no multi-factor AuthnContextClassRef
      // configured for this IdP, NO session exists yet. An account with TOTP
      // steps up to it (POST /auth/mfa/verify mints the `saml` session); an
      // account without one gets its session and the ordinary MFA gate sends
      // it to enrolment, exactly as before.
      if (orgRequiresMfa(org, user.isAdmin) && !mfa.asserted && user.totpEnabled) {
        const pending = await beginSamlTotpStepUp(db, user.id, provider.id);
        void reply.header("set-cookie", mfaPendingCookie(pending.token, requestIsSecure(req), pending.maxAgeSeconds));
        await auditAuth(db, null, user.id, "saml-mfa-step-up", "deny",
          `SAML login for '${email}' via provider '${provider.name}' held at the TOTP step: the organization requires MFA and the assertion named no multi-factor authentication context`,
          { phase: "saml-acs", provider: provider.name, providerId: provider.id, email, authnContexts: mfa.contexts, mfaRequired: org.mfaRequired });
        return reply.redirect("/ui/login?mfa=pending", 302);
      }
      // ADR-0028: the SAME createSession every other path uses, with the new
      // `saml` origin. Like `oidc`, it NEVER receives the current-password
      // bypass — that is api_key-only and fails closed for every other origin.
      const { token, maxAgeSeconds } = await createSession(db, user.id, org, req, "saml", { idpMfa: mfa.asserted });
      void reply.header("set-cookie", sessionCookie(token, requestIsSecure(req), maxAgeSeconds));
      await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
        `user '${email}' signed in via SAML provider '${provider.name}'`,
        // providerId marks this as a post-0139 row: never backfill evidence
        { phase: "login", email, method: "saml", provider: provider.name, providerId: provider.id, emailSource: source, idpMfa: mfa.asserted, authnContexts: mfa.contexts });
      return reply.redirect(state?.returnTo ?? "/app", 302);
    });
  });

  // ---- admin CRUD (default admin gate applies, audited as saml_provider) --

  /** ADR-0181 (FX2): JIT on with no allowed domains is refused by name, audited */
  const refuseSamlJitWithoutDomains = async (
    reply: FastifyReply,
    actorUserId: string | null,
    name: string,
    providerId: string | null,
  ) => {
    const detail =
      "JIT provisioning creates an account from whatever email the identity provider asserts, so it needs " +
      "allowedEmailDomains: name the domains this provider may provision (or turn JIT off). Nothing was saved.";
    await auditAuth(db, actorUserId, providerId, OIDC_JIT_DOMAINS_REQUIRED, "deny",
      `SAML provider '${name}' write refused: JIT provisioning without allowed email domains`,
      { phase: providerId ? "provider-updated" : "provider-created", name, error: OIDC_JIT_DOMAINS_REQUIRED },
      "saml_provider");
    return reply.status(422).send({ error: OIDC_JIT_DOMAINS_REQUIRED, detail });
  };

  app.get("/v1/auth/saml-providers", async () => {
    const rows = await db.select().from(samlProviders);
    return { providers: rows.map(publicProvider) };
  });

  app.post("/v1/auth/saml-providers", async (req, reply) => {
    // ADR-0052 §4: SSO/SAML is a TIER FEATURE, enforced where it is ENABLED.
    // Creating a provider is the enabling act; sign-in through an existing
    // provider is authentication (governance, fail-open) and is never gated.
    const flagRefusal = await refuseIfFeatureNotLicensed(db, {
      actorUserId: req.authCtx.userId,
      feature: "sso_saml",
      what: "creating a SAML provider",
    });
    if (flagRefusal) return reply.status(flagRefusal.status).send(flagRefusal.body);
    const body = createSamlProviderSchema.parse(req.body);
    // ADR-0181 (FX2, review finding 5): JIT provisioning needs the email
    // domains it accepts — the same rule, wording and error as OIDC
    if (oidcJitDomainsMissing(body)) return refuseSamlJitWithoutDomains(reply, req.authCtx.userId, body.name, null);
    if (body.spPrivateKey && !opts.dataKey) {
      return reply.status(409).send({
        error: "data_key_required",
        detail: "SP private keys are stored encrypted — set REGULAIT_DATA_KEY on the gateway first",
      });
    }
    if (body.defaultRoleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.defaultRoleId));
      if (!role) return reply.status(422).send({ error: "unknown_role" });
    }
    const [row] = await db
      .insert(samlProviders)
      .values({
        name: body.name,
        entityId: body.entityId,
        idpSsoUrl: body.idpSsoUrl,
        idpSigningCerts: body.idpSigningCerts,
        enabled: body.enabled ?? true,
        allowedEmailDomains: body.allowedEmailDomains ?? null,
        defaultRoleId: body.defaultRoleId ?? null,
        jitProvisioning: body.jitProvisioning ?? false,
        wantAssertionsSigned: body.wantAssertionsSigned ?? true,
        wantAuthnResponseSigned: body.wantAuthnResponseSigned ?? true, // ADR-0181: strict by default
        allowIdpInitiated: body.allowIdpInitiated ?? false,
        emailAttribute: body.emailAttribute ?? null,
        // ADR-0038: naming the attribute turns the group SIGNAL on. It grants
        // nothing by itself — an asserted group confers nothing until an admin
        // maps it (`group_role_mappings`), and no mapping reaches isAdmin.
        groupsAttribute: body.groupsAttribute ?? null,
        // ADR-0174: the AuthnContextClassRef values meaning multi-factor
        mfaAuthnContexts: body.mfaAuthnContexts ?? null,
        ...(body.spPrivateKey
          ? { spPrivateKeyCiphertext: encryptSecret(opts.dataKey!, body.spPrivateKey) }
          : {}),
        spCertificate: body.spCertificate ?? null,
      })
      .returning();
    await auditAuth(db, req.authCtx.userId, null, "saml-provider-created", "allow",
      `SAML provider '${body.name}' created (IdP entity ${body.entityId})`,
      {
        phase: "provider-created",
        name: body.name,
        entityId: body.entityId,
        jitProvisioning: body.jitProvisioning ?? false,
        allowIdpInitiated: body.allowIdpInitiated ?? false,
        // the ADR requires an empty domain allow-list to be a CONSCIOUS choice:
        // it is recorded here so "we trusted every email this IdP asserts" is
        // answerable from the audit trail, not only from the current row.
        allowedEmailDomains: body.allowedEmailDomains ?? null,
        wantAssertionsSigned: row!.wantAssertionsSigned,
        wantAuthnResponseSigned: row!.wantAuthnResponseSigned,
        certCount: body.idpSigningCerts.length,
      },
      "saml_provider");
    return reply.status(201).send(publicProvider(row!));
  });

  app.patch("/v1/auth/saml-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const body = updateSamlProviderSchema.parse(req.body);
    const [existing] = await db
      .select()
      .from(samlProviders)
      .where(eq(samlProviders.id, providerId));
    if (!existing) return reply.status(404).send({ error: "unknown_provider" });
    // ADR-0181 (FX2): over the EFFECTIVE values, so a two-step PATCH cannot
    // turn JIT on before (or clear the domains after) naming them
    if (
      oidcJitDomainsMissing({
        jitProvisioning: body.jitProvisioning ?? existing.jitProvisioning,
        allowedEmailDomains: body.allowedEmailDomains !== undefined ? body.allowedEmailDomains : existing.allowedEmailDomains,
      })
    ) {
      return refuseSamlJitWithoutDomains(reply, req.authCtx.userId, existing.name, providerId);
    }
    if (body.spPrivateKey && !opts.dataKey) {
      return reply.status(409).send({ error: "data_key_required" });
    }
    if (body.defaultRoleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.defaultRoleId));
      if (!role) return reply.status(422).send({ error: "unknown_role" });
    }
    // the signature posture is checked against the EFFECTIVE pair (stored
    // values + this patch), not against the patch alone — otherwise a
    // two-step PATCH could reach the (false, false) combination the schema
    // refuses in one step.
    {
      const wantAssertions = body.wantAssertionsSigned ?? existing.wantAssertionsSigned;
      const wantResponse = body.wantAuthnResponseSigned ?? existing.wantAuthnResponseSigned;
      if (!wantAssertions && !wantResponse) {
        return reply.status(422).send({
          error: "unsigned_assertions_refused",
          detail:
            "wantAssertionsSigned may only be turned off when wantAuthnResponseSigned is on — otherwise an unsigned assertion could be accepted",
        });
      }
    }
    const { spPrivateKey, ...rest } = body;
    /** the write and its audit rows, on whichever handle the caller holds */
    const apply = async (x: Pick<Db, "update" | "insert" | "delete">, site?: SignInInvariantSite) => {
      const [row] = await x
        .update(samlProviders)
        .set({
          ...rest,
          ...(spPrivateKey
            ? { spPrivateKeyCiphertext: encryptSecret(opts.dataKey!, spPrivateKey) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(samlProviders.id, providerId))
        .returning();
      if (site) await signInInvariantWritten(site);
      await auditAuth(x, req.authCtx.userId, null, "saml-provider-updated", "allow",
        `SAML provider '${existing.name}' updated: ${Object.keys(body).join(", ")}`,
        {
          phase: "provider-updated",
          name: existing.name,
          changed: Object.keys(body),
          // ADR-0181: a relaxed posture flag is answerable as old -> new
          transitions: settingTransitions(existing, rest, ["idpSigningCerts", "spCertificate"]),
          privateKeyRotated: Boolean(spPrivateKey),
        },
        "saml_provider");
      // ADR-0174 (finding 6): a new entity id is a different identity provider —
      // the NameIDs linked under the old one mean nothing under the new one
      if (body.entityId !== undefined && body.entityId !== existing.entityId) {
        const dropped = await dropProviderLinks(x, { kind: "saml", id: providerId, name: existing.name });
        await auditAuth(x, req.authCtx.userId, providerId, "federated-identities-reset", "allow",
          `SAML provider '${existing.name}' entity id changed: ${dropped.identities} linked identit${dropped.identities === 1 ? "y" : "ies"} and ${dropped.requests} pending link request(s) removed — each person links again on their next sign-in`,
          { phase: "provider-updated", name: existing.name, fromEntityId: existing.entityId, toEntityId: body.entityId, ...dropped },
          "saml_provider");
      }
      return row!;
    };
    if (body.enabled !== false) return publicProvider(await apply(db));
    // ADR-0036: the lockout guard counts OIDC + SAML together; ADR-0174
    // (finding 5): nor while email sign-in is break-glass only. AER-056: the
    // re-read, both guards, the write and its audit are one locked transaction.
    const out = await withSignInInvariant(db, async (tx, org) => {
      const [current] = await tx.select({ enabled: samlProviders.enabled }).from(samlProviders).where(eq(samlProviders.id, providerId));
      if (!current) return { status: 404, body: { error: "unknown_provider" } } as const;
      if (current.enabled) {
        const refusal = await providerRemovalRefusal(tx, org, { kind: "saml_provider", providerId });
        if (refusal) return { status: 409, body: refusal } as const;
        await signInInvariantChecked("saml-provider-disable");
      }
      return { row: await apply(tx, "saml-provider-disable") };
    });
    if (out.status !== undefined) return reply.status(out.status).send(out.body);
    return publicProvider(out.row);
  });

  app.delete("/v1/auth/saml-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    // AER-056: lookup, both lockout guards, delete and audit under one lock
    const out = await withSignInInvariant(db, async (tx, org) => {
      const [existing] = await tx
        .select()
        .from(samlProviders)
        .where(eq(samlProviders.id, providerId));
      if (!existing) return { status: 404, body: { error: "unknown_provider" } } as const;
      if (existing.enabled) {
        const refusal = await providerRemovalRefusal(tx, org, { kind: "saml_provider", providerId });
        if (refusal) return { status: 409, body: refusal } as const;
        await signInInvariantChecked("saml-provider-delete");
      }
      await tx.delete(samlProviders).where(eq(samlProviders.id, providerId));
      await signInInvariantWritten("saml-provider-delete");
      await auditAuth(tx, req.authCtx.userId, null, "saml-provider-deleted", "allow",
        `SAML provider '${existing.name}' deleted`,
        { phase: "provider-deleted", name: existing.name },
        "saml_provider");
      return { removed: true } as const;
    });
    if (out.status !== undefined) return reply.status(out.status).send(out.body);
    return { removed: true };
  });
}
