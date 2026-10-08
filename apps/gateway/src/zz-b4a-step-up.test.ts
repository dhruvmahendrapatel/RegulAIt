/**
 * ADR-0186 A — passkeys and step-up, proof by attack (slice A1).
 *
 * Passkeys are driven by a SOFTWARE authenticator (`webauthn-soft-authenticator.ts`)
 * that emits exactly what a browser does, verified by the gateway's real
 * `@simplewebauthn/server` code. The fresh SSO login is driven by an in-test
 * OIDC provider (keys minted per run) and an in-test SAML IdP (a keypair per
 * run, wrapped by openssl in a short-lived self-signed certificate).
 *
 * Covered: enrolment (attestation `none` only, refused BEFORE verification;
 * RP unconfigured → 409; the first-passkey bootstrap rule; a second passkey
 * needs a step-up); every protected action refused without a grant
 * (settings_relax, break_glass, evidence_hold_override, passkey_manage,
 * owner_change); a grant is single use, bound to the kind AND digest, to the
 * session, and expires; API keys, chat taps and bulk operations cannot step
 * up; TOTP step-up and its replay guard; `step_up_unavailable`; turning
 * step-up off is itself a relaxation needing a step-up, audited with
 * transitions; a fresh OIDC login (prompt=login, max_age=0) and SAML login
 * (ForceAuthn) issue a grant only for the session's own identity
 * (`sso_reauth_identity_mismatch`) authenticated after the request
 * (`sso_reauth_stale`), collected once.
 *
 * Global state (org settings, env, SSO providers) is restored in afterAll
 * (M-068); nothing append-only is written outside a rolled-back transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import {
  agents,
  aiIncidentLinks,
  aiIncidentNotifications,
  aiIncidents,
  and,
  auditLog,
  authSessions,
  connectors,
  createDb,
  desc,
  eq,
  federatedIdentities,
  inArray,
  mcpServers,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  samlProviders,
  sql,
  ssoReauthRequests,
  stepUpGrants,
  users as usersTable,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER, stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { checkStepUp, relyingParty } from "./step-up.js";
import { EVIDENCE_HOLD_OVERRIDE_HEADER, incidentEvidenceHoldRefused } from "./incidents.js";
import { totpCode, totpStep } from "./totp.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4a-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const PUBLIC_URL = "http://localhost";
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
/** B4S-07: a fresh SSO step-up is offered only on a secure request — this suite's
 * SSO ceremonies arrive as https through this trusted proxy address */
const PROXY = "10.20.30.41";

let db: Db;
let app: ReturnType<typeof buildApp>;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
let restoreIdentity: (() => Promise<void>) | undefined;
const created = {
  users: [] as string[],
  sessions: [] as string[],
  servers: [] as string[],
  connectors: [] as string[],
  agents: [] as string[],
  oidc: [] as string[],
  saml: [] as string[],
};

type Who = { id: string; email: string; key: { authorization: string } };
const people = {} as Record<"admin" | "member" | "plain" | "oidcUser" | "samlUser" | "other", Who>;

const STRICT_STEP_UP = sql`UPDATE org_settings SET step_up_mode = 'required', step_up_max_age_seconds = 120,
  step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change"]'::jsonb
  WHERE id = ${ORG_SETTINGS_ID}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
async function mkSession(userId: string, opts: { origin?: "password" | "api_key" | "oidc"; ageSeconds?: number } = {}) {
  const token = "rgls_" + randomBytes(32).toString("hex");
  const createdAt = new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000);
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId,
      origin: opts.origin ?? "password",
      createdAt,
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  created.sessions.push(row!.id);
  return { token, sessionId: row!.id };
}
type Session = Awaited<ReturnType<typeof mkSession>>;

const as = (s: Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    ...(headers["x-forwarded-proto"] === "https" ? { remoteAddress: PROXY } : {}),
    headers: { ...CSRF, ...headers },
    cookies: { regulait_session: s.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const withKey = (key: { authorization: string }, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...key, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkUser(label: string, isAdmin: boolean): Promise<Who> {
  const email = `b4a-${label}-${RUN}@example.com`;
  // B4S round 3: creating an account that is already an admin is a settings_relax step-up; the bootstrap
  // credential gives it only during first-admin setup. Once an admin here can step up (this file enrols
  // authenticators), the fixture creates a member and sets the flag directly — the API path with a real step-up is
  // covered by zz-b4s-approver-eligibility
  const first = await withKey(AUTH, "POST", "/v1/users", { email, displayName: `b4a ${label}`, isAdmin });
  const u = isAdmin && first.statusCode === 403 && first.json().credential === "bootstrap" ? await withKey(AUTH, "POST", "/v1/users", { email, displayName: `b4a ${label}` }) : first;
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin && !u.json().isAdmin) await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, id));
  created.users.push(id);
  const key = await withKey(AUTH, "POST", `/v1/users/${id}/keys`, { name: "b4a" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, email, key: { authorization: `Bearer ${key.json().token}` } };
}

/** enrol a soft passkey for `s` (the caller has already satisfied the enrolment rule) */
async function enrolPasskey(s: Session, label = "laptop", headers: Record<string, string> = {}) {
  const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {}, headers);
  expect(opt.statusCode, opt.body).toBe(200);
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const reg = await as(s, "POST", "/v1/auth/passkeys", {
    challengeId: opt.json().challengeId,
    response: auth.register(opt.json().options),
    label,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { auth, passkeyId: reg.json().id as string };
}

/** the member's first passkey (enrolled by the passkey suite below; later suites step up with it) */
let memberAuth: SoftAuthenticator | undefined;

/** run a whole passkey step-up for `action` (what a 403 handed back); returns the grant token */
async function stepUpWithPasskey(s: Session, auth: SoftAuthenticator, action: { kind: string; body: Record<string, unknown> }) {
  const o = await as(s, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  expect(o.json().methods).toContain("passkey");
  const v = await as(s, "POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  expect(v.json().stepUpToken).toMatch(/^rgsu_/);
  return v.json().stepUpToken as string;
}

const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0] ?? null;

async function mkServer(label: string): Promise<string> {
  const [row] = await db
    .insert(mcpServers)
    .values({ name: `b4a-${label}-${RUN}`, url: `https://mcp-${label}-${RUN}.example.com/mcp` })
    .returning({ id: mcpServers.id });
  created.servers.push(row!.id);
  return row!.id;
}

// ---------------------------------------------------------------------------
// an in-test OIDC provider (auth_time is the knob)
// ---------------------------------------------------------------------------
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const idp = { server: null as Server | null, issuer: "", clientId: "b4a-client", clientSecret: `b4a-secret-${RUN}` };
const codes = new Map<string, { nonce: string; challenge: string | null; sub: string; authTime: number | null }>();
function signJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(rsa.privateKey).toString("base64url")}`;
}
async function startIdp() {
  idp.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", idp.issuer);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") {
      const jwk = rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const rec = codes.get(params.get("code") ?? "");
        if (!rec) return json({ error: "invalid_grant" }, 400);
        codes.delete(params.get("code") ?? "");
        const verifier = params.get("code_verifier");
        if (rec.challenge && (verifier === null || createHash("sha256").update(verifier).digest("base64url") !== rec.challenge)) {
          return json({ error: "invalid_grant" }, 400);
        }
        const now = Math.floor(Date.now() / 1000);
        return json({
          access_token: "fake-" + randomBytes(8).toString("hex"),
          token_type: "bearer",
          expires_in: 3600,
          id_token: signJwt({
            iss: idp.issuer,
            sub: rec.sub,
            aud: idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: rec.nonce,
            ...(rec.authTime !== null ? { auth_time: rec.authTime } : {}),
          }),
        });
      });
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((r) => idp.server!.listen(0, "127.0.0.1", r));
  const addr = idp.server!.address();
  if (addr === null || typeof addr === "string") throw new Error("no idp port");
  idp.issuer = `http://127.0.0.1:${addr.port}`;
}

// ---------------------------------------------------------------------------
// an in-test SAML IdP (AuthnInstant is the knob)
// ---------------------------------------------------------------------------
const IDP_ENTITY = `https://idp.b4a-${RUN}.example/metadata`;
const NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
let samlKey: { privateKey: string; certPem: string };
function makeSamlKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-b4a-test-only-"));
  try {
    const keyFile = path.join(dir, "k.pem");
    const certFile = path.join(dir, "c.pem");
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-new", "-sha256", "-days", "1", "-key", keyFile, "-out", certFile, "-subj", "/CN=b4a-idp"]);
    return { privateKey: keyPem, certPem: readFileSync(certFile, "utf8").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
function samlResponse(o: { providerId: string; email: string; inResponseTo: string; authnInstant: string }): string {
  const acs = `${PUBLIC_URL}/auth/saml/${o.providerId}/acs`;
  const aud = `${PUBLIC_URL}/auth/saml/metadata`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(0)}" Destination="${acs}" InResponseTo="${o.inResponseTo}">` +
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_a${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${IDP_ENTITY}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${NAMEID_EMAIL}">${o.email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${acs}" InResponseTo="${o.inResponseTo}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${aud}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${o.authnInstant}" SessionIndex="_s${randomBytes(6).toString("hex")}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement></saml:Assertion></samlp:Response>`;
  const sign = (doc: string, xpath: string, location: string) => {
    const sig = new SignedXml({
      privateKey: samlKey.privateKey,
      publicCert: samlKey.certPem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath,
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(doc, { location: { reference: location, action: "after" } });
    return sig.getSignedXml();
  };
  const signedAssertion = sign(xml, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']");
  return sign(signedAssertion, "/*[local-name(.)='Response']", "/*[local-name(.)='Response']/*[local-name(.)='Issuer']");
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // this suite is about step-up, not the org MFA dial (restored below, M-068)
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(STRICT_STEP_UP);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
  people.admin = await mkUser("admin", true);
  people.member = await mkUser("member", false);
  people.plain = await mkUser("plain", false);
  people.oidcUser = await mkUser("oidc", false);
  people.samlUser = await mkUser("saml", false);
  people.other = await mkUser("other", false);
  await startIdp();
  samlKey = makeSamlKey();
  const egress = await withKey(AUTH, "POST", "/v1/egress-allow-hosts", {
    host: "127.0.0.1",
    allowPrivateRanges: true,
    allowPlaintextHttp: true,
    note: "b4a suite: local fake OIDC IdP",
  });
  expect([201, 409]).toContain(egress.statusCode);
}, 120_000);

afterAll(async () => {
  await db.execute(STRICT_STEP_UP);
  await restoreIdentity?.();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  if (created.users.length) {
    await db.delete(stepUpGrants).where(inArray(stepUpGrants.userId, created.users));
    await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.userId, created.users));
    await db.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, created.users));
    await db.delete(federatedIdentities).where(inArray(federatedIdentities.userId, created.users));
  }
  if (created.oidc.length) await db.delete(oidcProviders).where(inArray(oidcProviders.id, created.oidc));
  if (created.saml.length) await db.delete(samlProviders).where(inArray(samlProviders.id, created.saml));
  if (created.servers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
  if (created.connectors.length) await db.delete(connectors).where(inArray(connectors.id, created.connectors));
  if (created.agents.length) await db.delete(agents).where(inArray(agents.id, created.agents));
  if (created.sessions.length) await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
  await new Promise<void>((r) => (idp.server ? idp.server.close(() => r()) : r()));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("passkey enrolment (attestation none only; the bootstrap rule)", () => {
  it("the relying party is REGULAIT_PUBLIC_URL's hostname; unset → 409 passkey_rp_unconfigured", async () => {
    expect(relyingParty()).toEqual({ rpID: "localhost", origin: ORIGIN, rpName: "RegulAIt" });
    const s = await mkSession(people.plain.id);
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      const r = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("passkey_rp_unconfigured");
    } finally {
      process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
    }
  });

  it("an API key can never manage passkeys (browser session required)", async () => {
    const r = await withKey(people.member.key, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("browser_session_required");
  });

  it("a non-`none` attestation (a valid packed self-attestation) is refused BEFORE verification; nothing is stored", async () => {
    const s = await mkSession(people.plain.id);
    const opt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(opt.statusCode, opt.body).toBe(200);
    expect(opt.json().options.attestation).toBe("none");
    expect(opt.json().options.authenticatorSelection.userVerification).toBe("required");
    expect(opt.json().options.rp.id).toBe("localhost");
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const reg = await as(s, "POST", "/v1/auth/passkeys", {
      challengeId: opt.json().challengeId,
      response: auth.register(opt.json().options, "packed"),
      label: "self-attested",
    });
    expect(reg.statusCode, reg.body).toBe(422);
    expect(reg.json().error).toBe("passkey_attestation_refused");
    expect((await lastAudit("passkey-attestation-refused"))?.detail).toMatchObject({ fmt: "packed" });
    const stored = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.credentialId, auth.id));
    expect(stored).toEqual([]);
    // the ceremony was spent: the same challenge cannot be retried with a `none` response
    const again = await as(s, "POST", "/v1/auth/passkeys", {
      challengeId: opt.json().challengeId,
      response: auth.register(opt.json().options),
      label: "retry",
    });
    expect(again.json().error).toBe("passkey_challenge_used");
  });

  it("first passkey: a STALE or API-key-exchanged session is refused; a fresh human sign-in enrols (label scrubbed)", async () => {
    const stale = await mkSession(people.plain.id, { ageSeconds: 3600 });
    const r1 = await as(stale, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(r1.statusCode, r1.body).toBe(403);
    expect(r1.json().error).toBe("fresh_sign_in_required");
    const viaKey = await mkSession(people.plain.id, { origin: "api_key" });
    expect((await as(viaKey, "POST", "/v1/auth/passkeys/registration-options", {})).json().error).toBe("fresh_sign_in_required");
    const fresh = await mkSession(people.plain.id);
    const opt = await as(fresh, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(opt.statusCode, opt.body).toBe(200);
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const label = "work laptop AKIAZ7XQK3NWQOPXR4LT";
    const reg = await as(fresh, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: auth.register(opt.json().options), label });
    expect(reg.statusCode, reg.body).toBe(201);
    const [row] = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, reg.json().id));
    expect(row!.label).not.toContain("AKIAZ7XQK3NWQOPXR4LT");
    expect(row!.counter).toBe(0);
    expect(row!.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const list = await as(fresh, "GET", "/v1/auth/passkeys");
    expect(list.json()).toMatchObject({ rpConfigured: true, passkeys: [{ id: reg.json().id, backedUp: false, lastUsedAt: null }] });
    expect(JSON.stringify(list.json())).not.toMatch(/publicKey|counter/);
  });

  it("a SECOND passkey needs a passkey_manage step-up, even from a fresh session", async () => {
    const s = await mkSession(people.member.id);
    const { auth } = await enrolPasskey(s, "first");
    memberAuth = auth;
    const s2 = await mkSession(people.member.id);
    const refused = await as(s2, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "passkey_manage", methods: ["passkey"] });
    const token = await stepUpWithPasskey(s2, auth, refused.json().action);
    const second = await enrolPasskey(s2, "second", { [STEP_UP_HEADER]: token });
    expect(second.passkeyId).toBeTruthy();
  });
});

describe("step-up grants: single use, bound to kind+digest, session-bound, expiring", () => {
  let admin: Session;
  let auth: SoftAuthenticator;
  beforeAll(async () => {
    admin = await mkSession(people.admin.id);
    auth = (await enrolPasskey(admin, "admin key")).auth;
  });

  it("owner_change: refused without a grant; a grant for it admits ONCE; reuse is refused", async () => {
    const server = await mkServer("own1");
    const put = (h: Record<string, string> = {}) => as(admin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id }, h);
    const refused = await put();
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({
      error: "step_up_required",
      actionKind: "owner_change",
      action: { kind: "owner_change", body: { objectType: "mcp_server", objectId: server, ownerUserId: people.member.id } },
    });
    const [unchanged] = await db.select({ o: mcpServers.ownerUserId }).from(mcpServers).where(eq(mcpServers.id, server));
    expect(unchanged!.o).toBeNull();
    const token = await stepUpWithPasskey(admin, auth, refused.json().action);
    const ok = await put({ [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    // single use: put the owner back (directly — B4S-06: the bootstrap credential no longer passes a
    // step-up once an admin can give one), then replay the SAME request with the SAME grant
    await db.update(mcpServers).set({ ownerUserId: null }).where(eq(mcpServers.id, server));
    const back = await put({ [STEP_UP_HEADER]: token });
    expect(back.statusCode).toBe(403);
    expect(back.json().presentedGrant).toBe("not_valid_for_this_action");
    expect((await lastAudit("step-up-grant-refused"))?.userId).toBe(people.admin.id);
  });

  it("a grant made for kind/digest X is refused for Y (another owner; another kind)", async () => {
    const server = await mkServer("own2");
    const facts = { objectType: "mcp_server", objectId: server, ownerUserId: people.member.id };
    const token = await stepUpWithPasskey(admin, auth, { kind: "owner_change", body: facts });
    // same kind, different new owner → different digest
    const other = await as(admin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.plain.id }, { [STEP_UP_HEADER]: token });
    expect(other.statusCode).toBe(403);
    // different kind (a settings relaxation) with the same token
    const relax = await as(admin, "PUT", "/v1/org/settings", { stepUpMaxAgeSeconds: 300 }, { [STEP_UP_HEADER]: token });
    expect(relax.statusCode).toBe(403);
    expect(relax.json().actionKind).toBe("settings_relax");
    // the right action still works with it (nothing above spent it)
    const right = await as(admin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id }, { [STEP_UP_HEADER]: token });
    expect(right.statusCode, right.body).toBe(200);
  });

  it("a grant from another session of the same person is refused", async () => {
    const server = await mkServer("own3");
    const facts = { objectType: "mcp_server", objectId: server, ownerUserId: people.member.id };
    const token = await stepUpWithPasskey(admin, auth, { kind: "owner_change", body: facts });
    const elsewhere = await mkSession(people.admin.id);
    const r = await as(elsewhere, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id }, { [STEP_UP_HEADER]: token });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("step_up_required");
  });

  it("an expired grant is refused (the database clock decides)", async () => {
    const server = await mkServer("own4");
    const facts = { objectType: "mcp_server", objectId: server, ownerUserId: people.member.id };
    const token = await stepUpWithPasskey(admin, auth, { kind: "owner_change", body: facts });
    const hash = createHash("sha256").update(token).digest("hex");
    const [g] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, hash));
    expect(g!.expiresAt.getTime() - g!.createdAt.getTime()).toBe(120_000);
    expect(g!.actionDigest).toBe(stepUpActionDigest("owner_change", facts));
    expect(g!.sessionId).toBe(admin.sessionId);
    await db.execute(sql`UPDATE step_up_grants SET created_at = now() - interval '10 minutes', expires_at = now() - interval '8 minutes' WHERE token_hash = ${hash}`);
    const r = await as(admin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id }, { [STEP_UP_HEADER]: token });
    expect(r.statusCode).toBe(403);
  });

  it("the agent and connector owner routes need the same step-up", async () => {
    const [a] = await db.insert(agents).values({ name: `b4a-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    created.agents.push(a!.id);
    const refused = await as(admin, "POST", `/v1/agents/${a!.id}/owner`, { ownerUserId: people.member.id });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action.body).toEqual({ objectType: "agent", objectId: a!.id, ownerUserId: people.member.id });
    const token = await stepUpWithPasskey(admin, auth, refused.json().action);
    const ok = await as(admin, "POST", `/v1/agents/${a!.id}/owner`, { ownerUserId: people.member.id }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    const [c] = await db
      .insert(connectors)
      .values({ name: `b4a-conn-${RUN}`, kind: "webhook", baseUrl: `https://b4a-${RUN}.example.com` } as never)
      .returning({ id: connectors.id })
      .catch(() => [] as Array<{ id: string }>);
    if (c) {
      created.connectors.push(c.id);
      const cr = await as(admin, "PUT", `/v1/connectors/${c.id}/owner`, { ownerUserId: people.member.id });
      expect(cr.statusCode, cr.body).toBe(403);
      expect(cr.json().actionKind).toBe("owner_change");
    }
  });

  it("an API key cannot step up: the protected action is refused with no methods; /options refuses it", async () => {
    const server = await mkServer("own5");
    const r = await withKey(people.admin.key, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", methods: [], credential: "api_key" });
    const o = await withKey(people.admin.key, "POST", "/v1/auth/step-up/options", { action: { kind: "owner_change", body: {} } });
    expect(o.statusCode).toBe(403);
    expect(o.json().error).toBe("browser_session_required");
    // B4S-06: the bootstrap credential is no person either. An admin here can step up (the admin
    // enrolled a passkey), so it is refused the same way: no methods, credential "bootstrap"
    const boot = await withKey(AUTH, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id });
    expect(boot.statusCode, boot.body).toBe(403);
    expect(boot.json()).toMatchObject({ error: "step_up_required", methods: [], credential: "bootstrap" });
  });

  it("a chat tap and a bulk operation can never step up", async () => {
    const fakeReq = {
      headers: {},
      authCtx: { userId: people.admin.id, isAdmin: true, via: "session" },
      sessionAuth: { sessionId: admin.sessionId, origin: "password" },
    };
    const chat = await checkStepUp(db, fakeReq as never, { kind: "approval_decide", facts: { approvalId: randomUUID() }, channel: "chat" });
    expect(chat).toMatchObject({ ok: false, status: 403, body: { error: "chatops_step_up_required" } });
    const bulk = await checkStepUp(db, fakeReq as never, { kind: "approval_decide", facts: {}, channel: "bulk" });
    expect(bulk).toMatchObject({ ok: false, status: 403, body: { error: "step_up_required", methods: [] } });
  });

  it("passkey_manage: revoking a passkey needs a step-up; the passkey is kept, revoked, audited", async () => {
    const s = await mkSession(people.admin.id);
    const extraOpt = await as(s, "POST", "/v1/auth/passkeys/registration-options", {});
    expect(extraOpt.statusCode).toBe(403);
    const t = await stepUpWithPasskey(s, auth, extraOpt.json().action);
    const extra = await enrolPasskey(s, "spare", { [STEP_UP_HEADER]: t });
    const del = await as(s, "DELETE", `/v1/auth/passkeys/${extra.passkeyId}`);
    expect(del.statusCode, del.body).toBe(403);
    expect(del.json().action).toEqual({ kind: "passkey_manage", body: { op: "revoke", passkeyId: extra.passkeyId } });
    const token = await stepUpWithPasskey(s, auth, del.json().action);
    const ok = await as(s, "DELETE", `/v1/auth/passkeys/${extra.passkeyId}`, undefined, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, extra.passkeyId));
    expect(row!.revokedAt).not.toBeNull();
    expect((await lastAudit("passkey-revoked"))?.detail).toMatchObject({ passkeyId: extra.passkeyId, byAdmin: false });
    // a revoked passkey cannot step up
    const o = await as(s, "POST", "/v1/auth/step-up/options", { action: { kind: "owner_change", body: {} } });
    const v = await as(s, "POST", "/v1/auth/step-up/verify", { stepUpId: o.json().stepUpId, method: "passkey", response: extra.auth.authenticate(o.json().passkey.options) });
    expect(v.json().error).toBe("passkey_signature_invalid");
  });

  it("admin revoke of another user's passkey needs the admin's own passkey_manage step-up", async () => {
    const victim = await mkSession(people.other.id);
    const { passkeyId } = await enrolPasskey(victim, "other's");
    const r = await as(admin, "DELETE", `/v1/users/${people.other.id}/passkeys/${passkeyId}`, { reason: "lost device" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().action).toEqual({ kind: "passkey_manage", body: { op: "revoke", userId: people.other.id, passkeyId } });
    const token = await stepUpWithPasskey(admin, auth, r.json().action);
    const ok = await as(admin, "DELETE", `/v1/users/${people.other.id}/passkeys/${passkeyId}`, { reason: "lost device" }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await lastAudit("passkey-revoked"))?.detail).toMatchObject({ passkeyId, byAdmin: true });
    // an admin API key cannot do it at all
    const viaKey = await withKey(people.admin.key, "DELETE", `/v1/users/${people.other.id}/passkeys/${passkeyId}`, {});
    expect([403, 404]).toContain(viaKey.statusCode);
  });

  it("settings_relax: a relaxation is refused without a grant; break_glass likewise; one write may carry both", async () => {
    const relax = await as(admin, "PUT", "/v1/org/settings", { stepUpMaxAgeSeconds: 300 });
    expect(relax.statusCode, relax.body).toBe(403);
    expect(relax.json().action).toEqual({ kind: "settings_relax", body: { values: { stepUpMaxAgeSeconds: 300 } } });
    // a write that is not a relaxation needs nothing
    expect((await as(admin, "PUT", "/v1/org/settings", { stepUpMaxAgeSeconds: 120 })).statusCode).toBe(200);
    const bg = await as(admin, "PUT", "/v1/org/settings", { breakGlassUserIds: [people.admin.id], stepUpMaxAgeSeconds: 300 });
    expect(bg.statusCode, bg.body).toBe(403);
    expect(bg.json().actionKind).toBe("break_glass");
    const bgToken = await stepUpWithPasskey(admin, auth, bg.json().action);
    const second = await as(admin, "PUT", "/v1/org/settings", { breakGlassUserIds: [people.admin.id], stepUpMaxAgeSeconds: 300 }, { [STEP_UP_HEADER]: bgToken });
    expect(second.statusCode).toBe(403);
    expect(second.json().actionKind).toBe("settings_relax"); // the break-glass grant was NOT spent by this refusal
    const relaxToken = await stepUpWithPasskey(admin, auth, second.json().action);
    const both = await as(admin, "PUT", "/v1/org/settings", { breakGlassUserIds: [people.admin.id], stepUpMaxAgeSeconds: 300 }, {
      [STEP_UP_HEADER]: `${bgToken}, ${relaxToken}`,
    });
    expect(both.statusCode, both.body).toBe(200);
    await db.execute(sql`UPDATE org_settings SET break_glass_user_ids = '[]'::jsonb, step_up_max_age_seconds = 120 WHERE id = ${ORG_SETTINGS_ID}`);
  });

  it("re-saving an unchanged break-glass list (a stored null and [], the same ids in another order) asks for nothing", async () => {
    await db.execute(sql`UPDATE org_settings SET break_glass_user_ids = NULL WHERE id = ${ORG_SETTINGS_ID}`);
    const same = await as(admin, "PUT", "/v1/org/settings", { breakGlassUserIds: [], localSignIn: "enabled" });
    expect(same.statusCode, same.body).toBe(200);
    // a real change is still asked for
    const real = await as(admin, "PUT", "/v1/org/settings", { breakGlassUserIds: [people.admin.id] });
    expect(real.statusCode, real.body).toBe(403);
    expect(real.json().actionKind).toBe("break_glass");
  });

  it("step_up_mode=off is itself a relaxation needing a step-up, audited with transitions; while off nothing is asked", async () => {
    const off = await as(admin, "PUT", "/v1/org/settings", { stepUpMode: "off" });
    expect(off.statusCode, off.body).toBe(403);
    expect(off.json()).toMatchObject({ actionKind: "settings_relax", action: { body: { values: { stepUpMode: "off" } } } });
    const token = await stepUpWithPasskey(admin, auth, off.json().action);
    const ok = await as(admin, "PUT", "/v1/org/settings", { stepUpMode: "off" }, { [STEP_UP_HEADER]: token });
    expect(ok.statusCode, ok.body).toBe(200);
    const audit = (await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, people.admin.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1))[0]!;
    expect(audit.detail).toMatchObject({ transitions: { stepUpMode: { from: "required", to: "off" } } });
    try {
      const server = await mkServer("off");
      expect((await as(admin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id })).statusCode).toBe(200);
    } finally {
      await db.execute(STRICT_STEP_UP);
    }
    // removing one action from the list is a relaxation too
    const fewer = await as(admin, "PUT", "/v1/org/settings", { stepUpActions: ["approval_decide", "settings_relax"] });
    expect(fewer.statusCode).toBe(403);
  });

  it("evidence_hold_override: an admin's override needs a step-up bound to the agent, change, incidents and reason", async () => {
    class RolledBack extends Error {}
    await db
      .transaction(async (tx) => {
        const [agent] = await tx.insert(agents).values({ name: `b4a-hold-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
        const [inc] = await tx
          .insert(aiIncidents)
          .values({ title: `b4a ${RUN}`, severity: "high", detectionSource: "manual", awareAt: new Date(), serious: true, seriousCriteria: ["health"] } as never)
          .returning({ id: aiIncidents.id });
        await tx.insert(aiIncidentLinks).values({ incidentId: inc!.id, objectType: "agent", objectId: agent!.id } as never);
        await tx.insert(aiIncidentNotifications).values({
          incidentId: inc!.id,
          regime: "eu-ai-act",
          clockId: "art73-2-general",
          clockStart: new Date(),
          dueAt: new Date(Date.now() + 86_400_000),
        } as never);
        const reason = "patient harm continues, fix now";
        const sent: { status?: number; body?: Record<string, unknown> } = {};
        const reply = { status(c: number) { sent.status = c; return this; }, send(b: Record<string, unknown>) { sent.body = b; return this; } };
        const req = (headers: Record<string, string>) => ({
          headers: { [EVIDENCE_HOLD_OVERRIDE_HEADER]: reason, ...headers },
          authCtx: { userId: people.admin.id, isAdmin: true, via: "session" },
          sessionAuth: { sessionId: admin.sessionId, origin: "password" },
        });
        expect(await incidentEvidenceHoldRefused(tx as never, req({}) as never, reply as never, agent!.id, "system prompt")).toBe(true);
        expect(sent.status).toBe(403);
        expect(sent.body).toMatchObject({
          error: "step_up_required",
          action: { kind: "evidence_hold_override", body: { agentId: agent!.id, change: "system prompt", incidents: [inc!.id], reason } },
        });
        const token = await stepUpWithPasskey(admin, auth, sent.body!.action as { kind: string; body: Record<string, unknown> });
        // the same grant for a different reason is refused
        const otherReq = { ...req({ [STEP_UP_HEADER]: token }), headers: { [EVIDENCE_HOLD_OVERRIDE_HEADER]: "a different reason entirely", [STEP_UP_HEADER]: token } };
        expect(await incidentEvidenceHoldRefused(tx as never, otherReq as never, reply as never, agent!.id, "system prompt")).toBe(true);
        expect(sent.status).toBe(403);
        expect(await incidentEvidenceHoldRefused(tx as never, req({ [STEP_UP_HEADER]: token }) as never, reply as never, agent!.id, "system prompt")).toBe(false);
        throw new RolledBack();
      })
      .catch((e: unknown) => {
        if (!(e instanceof RolledBack)) throw e;
      });
  });
});

describe("TOTP step-up and step_up_unavailable", () => {
  it("a TOTP code steps up once; the same code is refused on a new ceremony (replay); a wrong code burns the ceremony", async () => {
    const s = await mkSession(people.member.id);
    // PR #198 review round 6: the member already holds a passkey, so adding an authenticator app needs passkey_manage
    const refused = await as(s, "POST", "/auth/totp/enroll");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "passkey_manage" });
    const enrolled = await as(s, "POST", "/auth/totp/enroll", undefined, {
      [STEP_UP_HEADER]: await stepUpWithPasskey(s, memberAuth!, refused.json().action),
    });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const secret = enrolled.json().secret as string;
    expect((await as(s, "POST", "/auth/totp/activate", { code: totpCode(secret, totpStep() - 1) })).statusCode).toBe(200);
    const action = { kind: "owner_change", body: { objectType: "mcp_server", objectId: randomUUID(), ownerUserId: null } };
    const o1 = await as(s, "POST", "/v1/auth/step-up/options", { action });
    expect(o1.json().methods).toEqual(["passkey", "totp"]);
    const code = totpCode(secret, totpStep());
    const v1 = await as(s, "POST", "/v1/auth/step-up/verify", { stepUpId: o1.json().stepUpId, method: "totp", code });
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.json()).toMatchObject({ method: "totp", actionKind: "owner_change" });
    const o2 = await as(s, "POST", "/v1/auth/step-up/options", { action });
    const replay = await as(s, "POST", "/v1/auth/step-up/verify", { stepUpId: o2.json().stepUpId, method: "totp", code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_code");
    // that ceremony is spent: even the right next code cannot use it
    const again = await as(s, "POST", "/v1/auth/step-up/verify", { stepUpId: o2.json().stepUpId, method: "totp", code: totpCode(secret, totpStep() + 1) });
    expect(again.json().error).toBe("passkey_challenge_used");
  });

  it("a person with no way to step up gets 422 step_up_unavailable", async () => {
    const lone = await mkUser("lone", true);
    const s = await mkSession(lone.id);
    const server = await mkServer("lone");
    const r = await as(s, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: people.member.id });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "owner_change", methods: [] });
  });
});

describe("fresh SSO login for a step-up", () => {
  /** B4S-07: the ceremony starts on https at the trusted proxy (plain http is proved in zz-b4s-round2) */
  const HTTPS = { "x-forwarded-proto": "https" };
  let oidcProviderId: string;
  let samlProviderId: string;
  beforeAll(async () => {
    const p = await withKey(AUTH, "POST", "/v1/auth/oidc-providers", {
      name: `b4a-oidc-${RUN}`,
      issuerUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
    });
    expect(p.statusCode, p.body).toBe(201);
    oidcProviderId = p.json().id;
    created.oidc.push(oidcProviderId);
    await db.insert(federatedIdentities).values([
      { userId: people.oidcUser.id, oidcProviderId, issuer: idp.issuer, subjectFormat: "", subject: `sub-oidc-${RUN}`, linkedVia: "jit" },
      { userId: people.other.id, oidcProviderId, issuer: idp.issuer, subjectFormat: "", subject: `sub-other-${RUN}`, linkedVia: "jit" },
    ]);
    // inserted directly: creating a SAML provider through the API is license-gated (ADR-0052), which is not this suite's subject
    const [sp] = await db
      .insert(samlProviders)
      .values({ name: `b4a-saml-${RUN}`, entityId: IDP_ENTITY, idpSsoUrl: `https://idp.b4a-${RUN}.example/sso`, idpSigningCerts: [samlKey.certPem] })
      .returning({ id: samlProviders.id });
    samlProviderId = sp!.id;
    created.saml.push(samlProviderId);
    await db.insert(federatedIdentities).values({
      userId: people.samlUser.id,
      samlProviderId,
      issuer: IDP_ENTITY,
      subjectFormat: NAMEID_EMAIL,
      subject: people.samlUser.email,
      linkedVia: "jit",
    });
  });

  const oidcStart = async (s: Session) => {
    const action = { kind: "owner_change", body: { objectType: "mcp_server", objectId: randomUUID(), ownerUserId: null } };
    const o = await as(s, "POST", "/v1/auth/step-up/options", { action }, HTTPS);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().methods).toEqual(["sso"]);
    const url = new URL(o.json().sso.redirectUrl);
    const binding = o.cookies.find((c) => c.name === "regulait_oidc_login")!;
    return { stepUpId: o.json().stepUpId as string, url, binding: binding.value, action };
  };
  const oidcCallback = (st: Awaited<ReturnType<typeof oidcStart>>, sub: string, authTime: number | null) => {
    const code = "code-" + randomBytes(8).toString("hex");
    codes.set(code, { nonce: st.url.searchParams.get("nonce")!, challenge: st.url.searchParams.get("code_challenge"), sub, authTime });
    return app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=${code}&state=${encodeURIComponent(st.url.searchParams.get("state")!)}`,
      headers: { cookie: `regulait_oidc_login=${st.binding}` },
    });
  };

  it("OIDC: prompt=login + max_age=0; a fresh login by the same identity gives ONE grant to the session that asked", async () => {
    const s = await mkSession(people.oidcUser.id, { origin: "oidc" });
    const st = await oidcStart(s);
    expect(st.url.searchParams.get("prompt")).toBe("login");
    expect(st.url.searchParams.get("max_age")).toBe("0");
    expect(st.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`)).statusCode).toBe(202);
    const cb = await oidcCallback(st, `sub-oidc-${RUN}`, Math.floor(Date.now() / 1000) + 2);
    expect(cb.statusCode, cb.body).toBe(200);
    expect(cb.json()).toEqual({ ok: true, stepUpId: st.stepUpId });
    // another session of the same person cannot collect it
    const elsewhere = await mkSession(people.oidcUser.id, { origin: "oidc" });
    expect((await as(elsewhere, "GET", `/v1/auth/step-up/${st.stepUpId}`)).statusCode).toBe(404);
    const got = await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`);
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toMatchObject({ status: "granted", method: "sso", actionKind: "owner_change" });
    const [g] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.tokenHash, createHash("sha256").update(got.json().stepUpToken).digest("hex")));
    expect(g!.actionDigest).toBe(stepUpActionDigest("owner_change", st.action.body));
    // collected once
    const twice = await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("sso_reauth_stale");
    // the state is single use
    const replay = await oidcCallback(st, `sub-oidc-${RUN}`, Math.floor(Date.now() / 1000) + 3);
    expect(replay.statusCode).toBe(409);
  });

  it("OIDC: an auth_time at or before the request (or none) → 409 sso_reauth_stale; no grant", async () => {
    const s = await mkSession(people.oidcUser.id, { origin: "oidc" });
    const st = await oidcStart(s);
    const cb = await oidcCallback(st, `sub-oidc-${RUN}`, Math.floor(Date.now() / 1000) - 600);
    expect(cb.statusCode, cb.body).toBe(409);
    expect(cb.json().error).toBe("sso_reauth_stale");
    expect((await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`)).json().error).toBe("sso_reauth_stale");
    const st2 = await oidcStart(s);
    const none = await oidcCallback(st2, `sub-oidc-${RUN}`, null);
    expect(none.statusCode).toBe(409);
    const [row] = await db.select().from(ssoReauthRequests).where(eq(ssoReauthRequests.stepUpId, st2.stepUpId));
    expect(row!.verifiedAt).toBeNull();
  });

  it("OIDC: another person's identity → 403 sso_reauth_identity_mismatch; no grant", async () => {
    const s = await mkSession(people.oidcUser.id, { origin: "oidc" });
    const st = await oidcStart(s);
    const cb = await oidcCallback(st, `sub-other-${RUN}`, Math.floor(Date.now() / 1000) + 2);
    expect(cb.statusCode, cb.body).toBe(403);
    expect(cb.json().error).toBe("sso_reauth_identity_mismatch");
    expect((await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`)).statusCode).toBe(409);
    // a browser sees a page, not JSON
    const st2 = await oidcStart(s);
    const code = "code-" + randomBytes(8).toString("hex");
    codes.set(code, { nonce: st2.url.searchParams.get("nonce")!, challenge: st2.url.searchParams.get("code_challenge"), sub: `sub-other-${RUN}`, authTime: Math.floor(Date.now() / 1000) + 2 });
    const page = await app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=${code}&state=${encodeURIComponent(st2.url.searchParams.get("state")!)}`,
      headers: { cookie: `regulait_oidc_login=${st2.binding}`, accept: "text/html" },
    });
    expect(page.statusCode).toBe(403);
    expect(page.headers["content-type"]).toContain("text/html");
  });

  it("SAML: ForceAuthn=true; AuthnInstant after the request gives a grant; before → 409 stale", async () => {
    const s = await mkSession(people.samlUser.id);
    const start = async () => {
      const o = await as(s, "POST", "/v1/auth/step-up/options", { action: { kind: "owner_change", body: { x: RUN } } }, HTTPS);
      expect(o.statusCode, o.body).toBe(200);
      expect(o.json().methods).toEqual(["sso"]);
      const url = new URL(o.json().sso.redirectUrl);
      const authnRequest = inflateRawSync(Buffer.from(url.searchParams.get("SAMLRequest")!, "base64")).toString("utf8");
      const [row] = await db.select().from(ssoReauthRequests).where(eq(ssoReauthRequests.stepUpId, o.json().stepUpId));
      return { stepUpId: o.json().stepUpId as string, authnRequest, relayState: url.searchParams.get("RelayState")!, requestId: row!.nonce };
    };
    const post = (xml: string, relayState: string) =>
      app.inject({
        method: "POST",
        url: `/auth/saml/${samlProviderId}/acs`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `SAMLResponse=${encodeURIComponent(Buffer.from(xml).toString("base64"))}&RelayState=${encodeURIComponent(relayState)}`,
      });
    const st = await start();
    expect(st.authnRequest).toContain('ForceAuthn="true"');
    expect(st.authnRequest).toContain(`ID="${st.requestId}"`);
    const ok = await post(samlResponse({ providerId: samlProviderId, email: people.samlUser.email, inResponseTo: st.requestId, authnInstant: iso(2000) }), st.relayState);
    expect(ok.statusCode, ok.body).toBe(200);
    const got = await as(s, "GET", `/v1/auth/step-up/${st.stepUpId}`);
    expect(got.json()).toMatchObject({ status: "granted", method: "sso" });

    const st2 = await start();
    const stale = await post(samlResponse({ providerId: samlProviderId, email: people.samlUser.email, inResponseTo: st2.requestId, authnInstant: iso(-600_000) }), st2.relayState);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("sso_reauth_stale");

    const st3 = await start();
    const other = await post(samlResponse({ providerId: samlProviderId, email: people.other.email, inResponseTo: st3.requestId, authnInstant: iso(2000) }), st3.relayState);
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error).toBe("sso_reauth_identity_mismatch");
  });
});

describe("the sign-in callbacks are unchanged for sign-in states", () => {
  it("an unknown OIDC state is still 401 invalid_or_expired_state", async () => {
    const r = await app.inject({ method: "GET", url: `/auth/oidc/callback?code=x&state=${randomBytes(8).toString("hex")}` });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "invalid_or_expired_state" });
  });
  it("the users table is untouched by a step-up (no login side effects)", async () => {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, people.oidcUser.id));
    expect(u).toBeTruthy();
    const sessions = await db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, people.oidcUser.id));
    // only the sessions this suite minted itself: a fresh SSO step-up mints none
    expect(sessions.every((x) => created.sessions.includes(x.id))).toBe(true);
    void orgSettings;
  });
});
