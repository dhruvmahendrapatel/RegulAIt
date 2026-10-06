/**
 * ADR-0174 — enterprise sign-in through a brokered identity provider.
 *
 *  1. GET /auth/sign-in-options: public, the shape the sign-in page needs, and
 *     no configuration or secret (issuer, client id, client secret, domains).
 *  2. Broker-hinted start: `idp` is checked against the global allow-list AND
 *     the provider's own broker list; an unknown or un-offered idp is refused
 *     (audited) and never reaches the IdP; an offered one rides `kc_idp_hint`.
 *  3. MFA enforcement for federated sessions: with the org requiring MFA, an
 *     ID token that asserts no MFA (`amr` per RFC 8176, or a configured `acr`)
 *     is refused with a clear page, audited, no session; one that asserts it is
 *     accepted and satisfies the MFA gate without a RegulAIt TOTP.
 *  4. Local sign-in break-glass mode: only designated break-glass admins may
 *     use a password, the guards refuse a mode nobody could recover from, and a
 *     wrong password stays the uniform 401.
 *  5. Account linking (§5): a federated identity matching an account that
 *     holds a local credential never links silently — it links after proof
 *     (password, + TOTP when enrolled) in the same browser or an admin's
 *     approval; a password-less pre-provisioned account links as before.
 *  6. demo:set-passwords: refuses without a password, on a non-demo licence,
 *     without a valid demo licence (wherever it runs), and on a weak
 *     password; works with a synthetic one, clears the one-time flag, and
 *     audits without the password.
 *  7. The security-review fixes (each `finding N` test fails without its fix):
 *     no silent relink of an account in use (2) and the pre-0139 backfill that
 *     keeps existing SSO users signing in; break-glass decided before the
 *     password result (3); weak amr is not MFA (4); break-glass lockout
 *     invariant (5); issuer-keyed links (6); ASCII-only email linking (7);
 *     demo licence required (8); API-key exchange in break-glass mode (9);
 *     unknown provider writes no audit row (11); confirm ordering and two
 *     approvals for an admin account (12). SAML MFA (1) and SAML anchors (6)
 *     are in adr0174-saml-security.test.ts; compose/realm (10, 2) in
 *     adr0174-deploy-config.test.ts.
 *
 * Shared-database hygiene (mistakes.md M-040/M-060): every provider this file
 * creates is deleted, the org_settings singleton is snapshotted and restored,
 * licences and persona rows it touches are restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  federatedIdentities,
  federatedLinkRequests,
  inArray,
  licenses,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  sql,
  users,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { enrolAdminTotpForTest, relaxIdentityForTest } from "./testing/identity-posture.js";
import { totpCode, totpStep } from "./auth.js";
import { idTokenMfa } from "./federated-identity.js";
import { DEMO_PERSONA_EMAILS, isDemoLicense, setDemoPasswords } from "./demo-set-passwords-lib.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0174-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "d".repeat(64);
/** a synthetic password minted by THIS test, never a value from the repo */
const synthetic = () => `Syn-${randomBytes(12).toString("base64url")}-9a`;

let db: Db;
let app: ReturnType<typeof buildApp>;

// ---------------------------------------------------------------------------
// fake OIDC IdP (the auth.test.ts pattern) whose id_token can carry amr / acr
// ---------------------------------------------------------------------------
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
interface CodeRecord {
  nonce: string;
  challenge: string | null;
  email: string;
  sub: string;
  amr?: string[];
  acr?: string;
}
const idp = {
  server: null as Server | null,
  issuer: "",
  clientId: "adr0174-client",
  clientSecret: "adr0174-client-secret-value",
  codes: new Map<string, CodeRecord>(),
};
function signJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(rsa.privateKey).toString("base64url")}`;
}
async function startIdp(): Promise<void> {
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
        const rec = idp.codes.get(params.get("code") ?? "");
        if (!rec) return json({ error: "invalid_grant" }, 400);
        idp.codes.delete(params.get("code") ?? "");
        const verifier = params.get("code_verifier");
        if (rec.challenge && (verifier === null || createHash("sha256").update(verifier).digest("base64url") !== rec.challenge)) {
          return json({ error: "invalid_grant" }, 400);
        }
        const now = Math.floor(Date.now() / 1000);
        return json({
          access_token: "fake-at-" + randomBytes(8).toString("hex"),
          token_type: "bearer",
          expires_in: 3600,
          id_token: signJwt({
            iss: idp.issuer,
            sub: rec.sub,
            aud: idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: rec.nonce,
            email: rec.email,
            email_verified: true,
            ...(rec.amr ? { amr: rec.amr } : {}),
            ...(rec.acr ? { acr: rec.acr } : {}),
          }),
        });
      });
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => idp.server!.listen(0, "127.0.0.1", resolve));
  const addr = idp.server!.address();
  if (addr === null || typeof addr === "string") throw new Error("no idp port");
  idp.issuer = `http://127.0.0.1:${addr.port}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const createdProviderIds = new Set<string>();
const createdUserIds = new Set<string>();
let orgSnapshot: OrgSettingsRow | null = null;
const tag = randomBytes(3).toString("hex");
const email = (local: string) => `${local}-${tag}@adr0174.example`;

const mkProvider = async (payload: Record<string, unknown>) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
    payload: { issuerUrl: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, ...payload },
  });
  expect(r.statusCode, r.body).toBe(201);
  createdProviderIds.add(r.json().id);
  return r.json() as { id: string; name: string };
};
const mkUser = async (address: string, isAdmin = false): Promise<string> => {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: address, displayName: address.split("@")[0], isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  createdUserIds.add(r.json().id);
  return r.json().id;
};
const login = (identifier: string, password: string) =>
  app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: identifier, password } });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name = "regulait_session") =>
  res.cookies.find((c) => c.name === name)?.value ?? null;
/** one-time password → real password; returns the real password */
const givePassword = async (userId: string, address: string): Promise<string> => {
  const r = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/set-initial-password`, payload: {} });
  expect(r.statusCode, r.body).toBe(200);
  const first = await login(address, r.json().password);
  expect(first.statusCode, first.body).toBe(200);
  const real = synthetic();
  const change = await app.inject({
    method: "POST", url: "/auth/change-password", headers: CSRF,
    cookies: { regulait_session: cookieOf(first)! },
    payload: { currentPassword: r.json().password, newPassword: real },
  });
  expect(change.statusCode, change.body).toBe(200);
  return real;
};
const latestAudit = async (ruleId: string) => {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
};
const putSettings = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload });

/** /start (or /login) → fake IdP code → callback, like a browser would */
const roundTrip = async (
  providerId: string,
  claims: { email: string; sub?: string; amr?: string[]; acr?: string },
  opts: { accept?: string } = {},
) => {
  const start = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start?returnTo=/app` });
  expect(start.statusCode, start.body).toBe(302);
  const binding = start.cookies.find((c) => c.name === "regulait_oidc_login")!;
  const authUrl = new URL(start.headers.location as string);
  const code = "code-" + randomBytes(8).toString("hex");
  idp.codes.set(code, {
    nonce: authUrl.searchParams.get("nonce")!,
    challenge: authUrl.searchParams.get("code_challenge"),
    email: claims.email,
    sub: claims.sub ?? `sub-${claims.email}`,
    ...(claims.amr ? { amr: claims.amr } : {}),
    ...(claims.acr ? { acr: claims.acr } : {}),
  });
  return app.inject({
    method: "GET",
    url: `/auth/oidc/callback?code=${code}&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
    headers: { cookie: `regulait_oidc_login=${binding.value}`, ...(opts.accept ? { accept: opts.accept } : {}) },
  });
};

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await startIdp();
  const egress = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0174 suite: local fake OIDC IdP" },
  });
  // another suite may already have allow-listed the loopback IdP host
  expect([201, 409]).toContain(egress.statusCode);
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  orgSnapshot = settings ?? null;
}, 120_000);

afterAll(async () => {
  try {
    if (orgSnapshot) await db.update(orgSettings).set(orgSnapshot).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    if (createdProviderIds.size > 0) await db.delete(oidcProviders).where(inArray(oidcProviders.id, [...createdProviderIds]));
  } finally {
    await app.close();
    await new Promise<void>((resolve) => idp.server?.close(() => resolve()) ?? resolve());
  }
});

// ===========================================================================
describe("GET /auth/sign-in-options", () => {
  it("is public and names which buttons to show — and nothing of the configuration", async () => {
    const broker = await mkProvider({ name: `broker-${tag}`, brokerIdps: ["github", "microsoft"] });
    const enterprise = await mkProvider({ name: `okta-${tag}`, allowedEmailDomains: ["adr0174.example"] });
    const r = await app.inject({ method: "GET", url: "/auth/sign-in-options" }); // no credential at all
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(["apiKeyExchange", "broker", "enterprise", "local"]);
    // the broker: canonical order, allow-listed values only
    if (body.broker.providerId === broker.id) {
      expect(body.broker).toEqual({ providerId: broker.id, name: `broker-${tag}`, idps: ["microsoft", "github"] });
    }
    expect(body.enterprise).toContainEqual({ id: enterprise.id, name: `okta-${tag}`, protocol: "oidc" });
    expect(body.enterprise.map((e: { id: string }) => e.id)).not.toContain(broker.id);
    expect(body.local).toEqual({ mode: expect.any(String), emailForm: expect.any(Boolean) });
    // no secret, no issuer, no client id, no domain list
    const text = r.body;
    expect(text).not.toContain(idp.clientSecret);
    expect(text).not.toContain(idp.clientId);
    expect(text).not.toContain(idp.issuer);
    expect(text).not.toContain("adr0174.example");
    expect(text).not.toMatch(/iphertext|secret|issuer|clientId/i);
  });
});

// ===========================================================================
describe("broker-hinted sign-in: the idp allow-list", () => {
  it("an offered idp rides kc_idp_hint to the IdP; /login without idp is /start", async () => {
    const p = await mkProvider({ name: `hint-${tag}`, brokerIdps: ["microsoft", "google", "github"] });
    const r = await app.inject({ method: "GET", url: `/auth/oidc/${p.id}/login?idp=google&returnTo=/app` });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    expect(loc.searchParams.get("kc_idp_hint")).toBe("google");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(r.cookies.find((c) => c.name === "regulait_oidc_login")).toBeTruthy(); // AUTHZ-04 binding
    const plain = await app.inject({ method: "GET", url: `/auth/oidc/${p.id}/login` });
    expect(plain.statusCode).toBe(302);
    expect(new URL(plain.headers.location as string).searchParams.get("kc_idp_hint")).toBeNull();
  });

  it("an idp outside the global allow-list is refused (400, audited) and never reaches the IdP", async () => {
    const p = await mkProvider({ name: `hint-unknown-${tag}`, brokerIdps: ["microsoft"] });
    for (const bad of ["facebook", "microsoft%20evil", "", "GOOGLE"]) {
      const r = await app.inject({ method: "GET", url: `/auth/oidc/${p.id}/login?idp=${bad}` });
      expect(r.statusCode, `idp=${bad}`).toBe(400);
      expect(r.json().error).toBe("unknown_idp");
      expect(r.headers.location).toBeUndefined();
    }
    const row = await latestAudit("oidc-idp-hint-refused");
    expect(row?.effect).toBe("deny");
  });

  it("an allow-listed idp the provider does not offer is refused too (the provider's own list)", async () => {
    const p = await mkProvider({ name: `hint-unoffered-${tag}`, brokerIdps: ["microsoft"] });
    const r = await app.inject({ method: "GET", url: `/auth/oidc/${p.id}/login?idp=github` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("idp_not_offered");
    const plainProvider = await mkProvider({ name: `hint-plain-${tag}` });
    const r2 = await app.inject({ method: "GET", url: `/auth/oidc/${plainProvider.id}/login?idp=google` });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe("idp_not_offered");
  });
});

// ===========================================================================
describe("MFA enforcement for federated sessions (org requires MFA)", () => {
  it("the amr/acr reading is RFC 8176 plus the configured acr values", () => {
    expect(idTokenMfa({ amr: ["pwd"] }, null).asserted).toBe(false);
    // something you know + something you have/are
    for (const m of ["otp", "hwk", "swk", "pop", "sms", "fpt", "face"]) expect(idTokenMfa({ amr: ["pwd", m] }, null).asserted).toBe(true);
    expect(idTokenMfa({ amr: ["mfa"] }, null).asserted).toBe(true);
    expect(idTokenMfa({ amr: ["hwk", "fpt"] }, null).asserted).toBe(true); // have + are
    expect(idTokenMfa({ acr: "mfa" }, null).asserted).toBe(false);
    expect(idTokenMfa({ acr: "mfa" }, ["mfa"]).asserted).toBe(true);
    expect(idTokenMfa({ acr: "1" }, ["mfa"]).asserted).toBe(false);
    expect(idTokenMfa({ amr: "mfa" }, null).asserted).toBe(false); // not an array → not an assertion
  });

  it("finding 4: ONE weak method is not MFA — two methods of one class are not either; a single possession factor counts only from an MFA-enforcing broker", () => {
    for (const m of ["otp", "hwk", "swk", "pop", "sms"]) expect(idTokenMfa({ amr: [m] }, null).asserted, m).toBe(false);
    expect(idTokenMfa({ amr: ["pwd", "pin"] }, null).asserted).toBe(false); // know + know
    expect(idTokenMfa({ amr: ["otp", "hwk"] }, null).asserted).toBe(false); // have + have
    expect(idTokenMfa({ amr: ["kba", "pwd"] }, null).asserted).toBe(false);
    // the broker flag admits exactly a single otp/hwk/swk
    for (const m of ["otp", "hwk", "swk"]) expect(idTokenMfa({ amr: [m] }, null, true)).toMatchObject({ asserted: true, via: "broker" });
    expect(idTokenMfa({ amr: ["pop"] }, null, true).asserted).toBe(false);
    expect(idTokenMfa({ amr: ["pwd"] }, null, true).asserted).toBe(false);
  });

  it("finding 4: a single otp from an ordinary IdP is refused; from a provider flagged brokerEnforcesMfa it passes", async () => {
    const plain = await mkProvider({ name: `amr-plain-${tag}` });
    const broker = await mkProvider({ name: `amr-broker-${tag}`, brokerEnforcesMfa: true });
    expect((await app.inject({ method: "GET", headers: AUTH, url: "/v1/auth/oidc-providers" })).json().providers
      .find((x: { id: string }) => x.id === broker.id).brokerEnforcesMfa).toBe(true);
    const address = email("amr-one");
    await mkUser(address);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const refused = await roundTrip(plain.id, { email: address, sub: `amr-one-${tag}`, amr: ["otp"] });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toBe("mfa_required");
      const ok = await roundTrip(broker.id, { email: address, sub: `amr-one-b-${tag}`, amr: ["otp"] });
      expect(ok.statusCode, ok.body).toBe(302);
      expect(ok.headers.location).toBe("/app");
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("refuses a token without MFA (clear page for a browser, JSON otherwise), audited, no session", async () => {
    const p = await mkProvider({ name: `mfa-${tag}` });
    const address = email("mfa-user");
    await mkUser(address);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const json = await roundTrip(p.id, { email: address, amr: ["pwd"] });
      expect(json.statusCode).toBe(403);
      expect(json.json().error).toBe("mfa_required");
      expect(cookieOf(json)).toBeNull();
      const audit = await latestAudit("oidc-mfa-not-asserted");
      expect(audit?.effect).toBe("deny");
      expect((audit?.detail as { email?: string }).email).toBe(address);

      const page = await roundTrip(p.id, { email: address }, { accept: "text/html,application/xhtml+xml" });
      expect(page.statusCode).toBe(403);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("Multi-factor sign-in required");
      expect(page.body).toContain('href="/ui/login"');
      expect(cookieOf(page)).toBeNull();
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("accepts a token whose amr asserts MFA — and that session passes the MFA gate without a TOTP", async () => {
    const p = await mkProvider({ name: `mfa-ok-${tag}` });
    const address = email("mfa-ok");
    const uid = await mkUser(address);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const cb = await roundTrip(p.id, { email: address, amr: ["pwd", "otp"] });
      expect(cb.statusCode, cb.body).toBe(302);
      expect(cb.headers.location).toBe("/app");
      const me = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookieOf(cb)! } });
      expect(me.statusCode, me.body).toBe(200); // not 403 mfa_enrollment_required
      expect(me.json().userId).toBe(uid);
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("a configured acr value counts; an unconfigured one does not", async () => {
    const p = await mkProvider({ name: `mfa-acr-${tag}`, mfaAcrValues: ["mfa"] });
    const address = email("mfa-acr");
    await mkUser(address);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      expect((await roundTrip(p.id, { email: address, acr: "1" })).statusCode).toBe(403);
      const ok = await roundTrip(p.id, { email: address, acr: "mfa" });
      expect(ok.statusCode, ok.body).toBe(302);
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("'admins' requires it of an admin only; with MFA off nothing changes", async () => {
    const p = await mkProvider({ name: `mfa-admins-${tag}` });
    const member = email("mfa-member");
    const admin = email("mfa-admin");
    await mkUser(member);
    await mkUser(admin, true);
    expect((await putSettings({ mfaRequired: "admins" })).statusCode).toBe(200);
    try {
      expect((await roundTrip(p.id, { email: member })).statusCode).toBe(302);
      expect((await roundTrip(p.id, { email: admin })).statusCode).toBe(403);
      expect((await roundTrip(p.id, { email: admin, amr: ["mfa"] })).statusCode).toBe(302);
      expect((await putSettings({ mfaRequired: "off" })).statusCode).toBe(200);
      expect((await roundTrip(p.id, { email: admin })).statusCode).toBe(302);
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });
});

// ===========================================================================
describe("local sign-in: break-glass only", () => {
  let glassId = "";
  let glassEmail = "";
  let glassPassword = "";
  let otherAdminEmail = "";
  let otherAdminPassword = "";
  let otherId = "";
  let memberId = "";
  let bgProviderId = "";

  beforeAll(async () => {
    bgProviderId = (await mkProvider({ name: `bg-sso-${tag}` })).id; // an enabled SSO door
    glassEmail = email("glass");
    glassId = await mkUser(glassEmail, true);
    glassPassword = await givePassword(glassId, glassEmail);
    otherAdminEmail = email("other-admin");
    otherId = await mkUser(otherAdminEmail, true);
    otherAdminPassword = await givePassword(otherId, otherAdminEmail);
    memberId = await mkUser(email("bg-member"));
  });
  afterAll(async () => {
    await db
      .update(orgSettings)
      .set({ localSignIn: orgSnapshot?.localSignIn ?? "enabled", breakGlassUserIds: orgSnapshot?.breakGlassUserIds ?? null })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("refuses to engage without a usable break-glass admin, or with a non-admin named", async () => {
    const none = await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [] });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe("break_glass_needs_admin");
    const notAdmin = await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [memberId] });
    expect(notAdmin.statusCode).toBe(422);
    expect(notAdmin.json().error).toBe("invalid_break_glass_user");
  });

  it("refuses to engage while no SSO provider is enabled", async () => {
    const enabled = await db.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true));
    const { samlProviders } = await import("@regulait/db");
    const enabledSaml = await db.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true));
    try {
      if (enabled.length) await db.update(oidcProviders).set({ enabled: false }).where(inArray(oidcProviders.id, enabled.map((e) => e.id)));
      if (enabledSaml.length) await db.update(samlProviders).set({ enabled: false }).where(inArray(samlProviders.id, enabledSaml.map((e) => e.id)));
      const r = await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [glassId] });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe("break_glass_needs_sso_provider");
    } finally {
      if (enabled.length) await db.update(oidcProviders).set({ enabled: true }).where(inArray(oidcProviders.id, enabled.map((e) => e.id)));
      if (enabledSaml.length) await db.update(samlProviders).set({ enabled: true }).where(inArray(samlProviders.id, enabledSaml.map((e) => e.id)));
    }
  });

  it("engaged: the break-glass admin signs in, anyone else gets the wrong-password 401 (audited)", async () => {
    const r = await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [glassId] });
    expect(r.statusCode, r.body).toBe(200);
    expect((await latestAudit("org-settings-updated"))?.reason).toContain("localSignIn");

    const glass = await login(glassEmail, glassPassword);
    expect(glass.statusCode, glass.body).toBe(200);
    expect(cookieOf(glass)).toBeTruthy();

    // security review, finding 3: the RIGHT password of a non-break-glass
    // account is answered exactly like a wrong one — the mode is no oracle
    const other = await login(otherAdminEmail, otherAdminPassword);
    expect(other.statusCode).toBe(401);
    expect(other.json()).toEqual({ error: "invalid_credentials", detail: "email or password is incorrect" });
    expect(cookieOf(other)).toBeNull();
    expect((await latestAudit("local-sign-in-refused"))?.effect).toBe("deny");

    const wrong = await login(otherAdminEmail, "Wrong-password-123");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toBe(other.body);

    const opts = await app.inject({ method: "GET", url: "/auth/sign-in-options" });
    expect(opts.json().local).toEqual({ mode: "break_glass_only", emailForm: false });

    // back to enabled: everyone with a password signs in again
    expect((await putSettings({ localSignIn: "enabled" })).statusCode).toBe(200);
    expect((await login(otherAdminEmail, otherAdminPassword)).statusCode).toBe(200);
  });

  it("finding 3: a refused break-glass login neither resets nor advances the lockout counter, and leaks nothing about the password", async () => {
    expect((await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [glassId] })).statusCode).toBe(200);
    try {
      const before = new Date();
      await db.update(users).set({ failedLoginCount: 2, lastFailedLoginAt: before }).where(eq(users.id, otherId));
      const right = await login(otherAdminEmail, otherAdminPassword);
      const wrong = await login(otherAdminEmail, "Wrong-password-123");
      expect(right.statusCode).toBe(401);
      expect(right.body).toBe(wrong.body);
      const [row] = await db.select().from(users).where(eq(users.id, otherId));
      expect(row?.failedLoginCount).toBe(2); // NOT reset to 0 by the right password
      expect(row?.lockedUntil).toBeNull();
      const audit = await latestAudit("local-sign-in-refused");
      expect(audit?.objectId).toBe(otherId);
      expect(JSON.stringify(audit)).not.toContain(otherAdminPassword);
    } finally {
      await putSettings({ localSignIn: "enabled" });
      await db.update(users).set({ failedLoginCount: 0, lastFailedLoginAt: null }).where(eq(users.id, otherId));
    }
  });

  it("finding 9: break-glass mode closes the API-key browser exchange to everyone but the break-glass admins", async () => {
    const key = async (uid: string) => {
      const r = await app.inject({ method: "POST", url: `/v1/users/${uid}/keys`, headers: AUTH, payload: { name: `bg-key-${tag}` } });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().token as string;
    };
    const exchange = (apiKey: string) => app.inject({ method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey } });
    // ADR-0181 (FX2): an admin's key answers to mfaRequired; this case is about
    // the break-glass door, so it relaxes the dial for itself and restores it
    onTestFinished(await relaxIdentityForTest(db, { mfaRequired: "off" }));
    const memberKey = await key(memberId);
    const glassKey = await key(glassId);
    expect((await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [glassId] })).statusCode).toBe(200);
    try {
      const member = await exchange(memberKey);
      const unknown = await exchange(`rgl_${randomBytes(24).toString("hex")}`);
      expect(member.statusCode).toBe(401);
      expect(member.json()).toEqual({ error: "invalid_key" });
      expect(member.json()).toEqual(unknown.json()); // the same answer as a key that does not exist
      expect(cookieOf(member)).toBeNull();
      const glass = await exchange(glassKey);
      expect(glass.statusCode, glass.body).toBe(200);
      expect(cookieOf(glass)).toBeTruthy();
      expect((await app.inject({ method: "GET", url: "/auth/sign-in-options" })).json().apiKeyExchange).toBe(false);
      // the key itself still works for programmatic use
      expect((await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${memberKey}` } })).statusCode).toBe(200);
    } finally {
      await putSettings({ localSignIn: "enabled" });
    }
    expect((await exchange(memberKey)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/sign-in-options" })).json().apiKeyExchange).toBe(true);
  });

  it("finding 5: while break-glass is engaged the last usable break-glass admin cannot be demoted or deactivated, nor the last SSO provider disabled or deleted; a demoted admin leaves the list", async () => {
    expect((await putSettings({ localSignIn: "break_glass_only", breakGlassUserIds: [glassId] })).statusCode).toBe(200);
    const { samlProviders } = await import("@regulait/db");
    const otherOidc = (await db.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true)))
      .map((r) => r.id).filter((id) => id !== bgProviderId);
    const otherSaml = (await db.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true))).map((r) => r.id);
    try {
      const demote = await app.inject({ method: "POST", url: `/v1/users/${glassId}/admin`, headers: AUTH, payload: { isAdmin: false } });
      expect(demote.statusCode).toBe(409);
      expect(demote.json().error).toBe("break_glass_last_admin");
      const deactivate = await app.inject({ method: "POST", url: `/v1/users/${glassId}/deactivate`, headers: AUTH, payload: {} });
      expect(deactivate.statusCode).toBe(409);
      expect(deactivate.json().error).toBe("break_glass_last_admin");
      const [still] = await db.select().from(users).where(eq(users.id, glassId));
      expect(still?.isAdmin).toBe(true);
      expect(still?.disabledAt).toBeNull();

      // with a second usable break-glass admin, demoting one is fine — and it
      // drops them from the list
      expect((await putSettings({ breakGlassUserIds: [glassId, otherId] })).statusCode).toBe(200);
      const demoteOther = await app.inject({ method: "POST", url: `/v1/users/${otherId}/admin`, headers: AUTH, payload: { isAdmin: false } });
      expect(demoteOther.statusCode, demoteOther.body).toBe(200);
      const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      expect(settings?.breakGlassUserIds).toEqual([glassId]);
      expect((await app.inject({ method: "POST", url: `/v1/users/${otherId}/admin`, headers: AUTH, payload: { isAdmin: true } })).statusCode).toBe(200);

      // the front door: make bg-sso the last enabled provider
      if (otherOidc.length) await db.update(oidcProviders).set({ enabled: false }).where(inArray(oidcProviders.id, otherOidc));
      if (otherSaml.length) await db.update(samlProviders).set({ enabled: false }).where(inArray(samlProviders.id, otherSaml));
      const disable = await app.inject({ method: "PATCH", url: `/v1/auth/oidc-providers/${bgProviderId}`, headers: AUTH, payload: { enabled: false } });
      expect(disable.statusCode).toBe(409);
      expect(disable.json().error).toBe("break_glass_last_sso_provider");
      const del = await app.inject({ method: "DELETE", url: `/v1/auth/oidc-providers/${bgProviderId}`, headers: AUTH });
      expect(del.statusCode).toBe(409);
      expect(del.json().error).toBe("break_glass_last_sso_provider");
    } finally {
      if (otherOidc.length) await db.update(oidcProviders).set({ enabled: true }).where(inArray(oidcProviders.id, otherOidc));
      if (otherSaml.length) await db.update(samlProviders).set({ enabled: true }).where(inArray(samlProviders.id, otherSaml));
      await putSettings({ localSignIn: "enabled" });
    }
    // with the mode off, the same demotion is an ordinary admin act again
    // (and still cleans the list)
    const demote = await app.inject({ method: "POST", url: `/v1/users/${glassId}/admin`, headers: AUTH, payload: { isAdmin: false } });
    expect(demote.statusCode, demote.body).toBe(200);
    const [after] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(after?.breakGlassUserIds ?? []).not.toContain(glassId);
    expect((await app.inject({ method: "POST", url: `/v1/users/${glassId}/admin`, headers: AUTH, payload: { isAdmin: true } })).statusCode).toBe(200);
  });
});

// ===========================================================================
describe("account linking without takeover (§5)", () => {
  let providerId = "";
  beforeAll(async () => {
    providerId = (await mkProvider({ name: `link-${tag}` })).id;
  });

  const linkRows = (userId: string) =>
    db.select().from(federatedIdentities).where(and(eq(federatedIdentities.userId, userId), eq(federatedIdentities.oidcProviderId, providerId)));

  it("a password-less pre-provisioned account links on the verified email, as before", async () => {
    const address = email("preprov");
    const uid = await mkUser(address);
    const cb = await roundTrip(providerId, { email: address, sub: `pre-${tag}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/app");
    const [row] = await linkRows(uid);
    expect(row?.linkedVia).toBe("preprovisioned");
  });

  it("an account WITH a password is not taken over: no session, a pending request, and proof links it", async () => {
    const address = email("haspw");
    const uid = await mkUser(address);
    const password = await givePassword(uid, address);
    const sub = `haspw-${tag}`;

    const cb = await roundTrip(providerId, { email: address, sub });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/ui/login?link=pending");
    expect(cookieOf(cb)).toBeNull(); // NO session
    const linkCookie = cookieOf(cb, "regulait_link");
    expect(linkCookie).toBeTruthy();
    expect(await linkRows(uid)).toHaveLength(0);
    expect((await latestAudit("federated-link-required"))?.objectId).toBe(uid);

    const pending = await app.inject({ method: "GET", url: "/auth/link/pending", cookies: { regulait_link: linkCookie! } });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ pending: true, provider: `link-${tag}`, protocol: "oidc", email: address });
    expect(pending.body).not.toContain("totp");

    // without the cookie there is nothing to prove; a wrong password is refused uniformly
    expect((await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, payload: { password } })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie! }, payload: { password: "Wrong-password-123" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("invalid_credentials");
    expect(await linkRows(uid)).toHaveLength(0);

    const ok = await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie! }, payload: { password } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().userId).toBe(uid);
    expect(cookieOf(ok)).toBeTruthy();
    const [row] = await linkRows(uid);
    expect(row?.linkedVia).toBe("proof");
    // the proof is single-use
    const again = await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie! }, payload: { password } });
    expect(again.statusCode).toBe(401);

    // the NEXT federated sign-in goes straight through on the linked subject
    const next = await roundTrip(providerId, { email: address, sub });
    expect(next.statusCode).toBe(302);
    expect(next.headers.location).toBe("/app");
    expect(cookieOf(next)).toBeTruthy();
  });

  it("an account with TOTP needs the code too — the password alone does not link it", async () => {
    const address = email("hastotp");
    const uid = await mkUser(address);
    const password = await givePassword(uid, address);
    const pwLogin = await login(address, password);
    const cookie = cookieOf(pwLogin)!;
    const enroll = await app.inject({ method: "POST", url: "/auth/totp/enroll", headers: CSRF, cookies: { regulait_session: cookie } });
    expect(enroll.statusCode, enroll.body).toBe(200);
    const secret = enroll.json().secret as string;
    const activate = await app.inject({
      method: "POST", url: "/auth/totp/activate", headers: CSRF, cookies: { regulait_session: cookie },
      payload: { code: totpCode(secret, totpStep() - 1) },
    });
    expect(activate.statusCode, activate.body).toBe(200);

    const cb = await roundTrip(providerId, { email: address, sub: `hastotp-${tag}` });
    const linkCookie = cookieOf(cb, "regulait_link")!;
    const noCode = await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie }, payload: { password } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().error).toBe("invalid_credentials"); // same answer as a wrong password
    expect(await linkRows(uid)).toHaveLength(0);
    const ok = await app.inject({
      method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie },
      payload: { password, code: totpCode(secret, totpStep()) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await linkRows(uid))[0]?.linkedVia).toBe("proof");
  });

  it("an admin can approve a link request (audited) — and deny one; nobody can approve their own", async () => {
    const address = email("adminlink");
    const uid = await mkUser(address);
    await givePassword(uid, address);
    const sub = `adminlink-${tag}`;
    await roundTrip(providerId, { email: address, sub });
    const list = await app.inject({ method: "GET", url: "/v1/auth/link-requests", headers: AUTH });
    expect(list.statusCode).toBe(200);
    const reqRow = list.json().requests.find((r: { userId: string }) => r.userId === uid);
    expect(reqRow).toMatchObject({ status: "pending", email: address, provider: `link-${tag}`, protocol: "oidc" });

    // self-approval is refused: the request's own user, as an admin
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, uid));
    // ADR-0181 (FX2): an admin's key answers to mfaRequired; this person has a
    // password (so is not enrolled the password-less way), and the case is
    // about self-approval — the dial is relaxed for this case only
    onTestFinished(await relaxIdentityForTest(db, { mfaRequired: "off" }));
    const keyRes = await app.inject({ method: "POST", url: `/v1/users/${uid}/keys`, headers: AUTH, payload: { name: "self" } });
    expect(keyRes.statusCode, keyRes.body).toBe(201);
    const self = await app.inject({
      method: "POST", url: `/v1/auth/link-requests/${reqRow.id}/approve`,
      headers: { authorization: `Bearer ${keyRes.json().token}` }, payload: {},
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toBe("cannot_approve_own_link");
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, uid));

    const approve = await app.inject({ method: "POST", url: `/v1/auth/link-requests/${reqRow.id}/approve`, headers: AUTH, payload: { reason: "verified with the person by phone" } });
    expect(approve.statusCode, approve.body).toBe(200);
    expect((await latestAudit("federated-link-approved"))?.objectId).toBe(uid);
    expect((await linkRows(uid))[0]?.linkedVia).toBe("admin");
    const next = await roundTrip(providerId, { email: address, sub });
    expect(next.headers.location).toBe("/app");

    // deny: the request closes, nothing links, the next sign-in asks again
    const address2 = email("denylink");
    const uid2 = await mkUser(address2);
    await givePassword(uid2, address2);
    await roundTrip(providerId, { email: address2, sub: `denylink-${tag}` });
    const [pend] = await db.select().from(federatedLinkRequests).where(and(eq(federatedLinkRequests.userId, uid2), eq(federatedLinkRequests.status, "pending")));
    const deny = await app.inject({ method: "POST", url: `/v1/auth/link-requests/${pend!.id}/deny`, headers: AUTH, payload: {} });
    expect(deny.statusCode).toBe(200);
    expect((await latestAudit("federated-link-denied"))?.effect).toBe("deny");
    expect(await linkRows(uid2)).toHaveLength(0);
    const twice = await app.inject({ method: "POST", url: `/v1/auth/link-requests/${pend!.id}/approve`, headers: AUTH, payload: {} });
    expect(twice.statusCode).toBe(409);
    expect((await roundTrip(providerId, { email: address2, sub: `denylink-${tag}` })).headers.location).toBe("/ui/login?link=pending");
  });

  // ---- security review --------------------------------------------------

  /** what a pre-0139 federated login left behind: a session of that origin and
   * the `login-succeeded` audit row naming the provider (no providerId key) */
  const legacySsoLogin = async (uid: string, address: string, providerName: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    await db.insert(authSessions).values({
      tokenHash: randomBytes(32).toString("hex"),
      userId: uid,
      origin: "oidc",
      expiresAt: new Date(now - 60_000),
      idleExpiresAt: new Date(now - 60_000),
      idleMinutes: 60,
    });
    await db.insert(auditLog).values({
      userId: uid,
      objectType: "user",
      objectId: uid,
      detail: { phase: "login", email: address, method: "oidc", provider: providerName, ...extra },
      effect: "allow",
      ruleId: "login-succeeded",
      ruleChain: [],
      reason: `user '${address}' signed in via OIDC provider '${providerName}'`,
    });
  };

  it("finding 2: an account already federated to one provider is NOT relinked by another on email alone — even with no password", async () => {
    const providerB = (await mkProvider({ name: `link-b-${tag}` })).id;
    const address = email("fed-a");
    const uid = await mkUser(address);
    const first = await roundTrip(providerId, { email: address, sub: `fed-a-${tag}` });
    expect(first.headers.location).toBe("/app"); // never used: links on the verified email
    const other = await roundTrip(providerB, { email: address, sub: `fed-b-${tag}` });
    expect(other.statusCode).toBe(302);
    expect(other.headers.location).toBe("/ui/login?link=pending");
    expect(cookieOf(other)).toBeNull();
    const rowsB = await db.select().from(federatedIdentities).where(and(eq(federatedIdentities.userId, uid), eq(federatedIdentities.oidcProviderId, providerB)));
    expect(rowsB).toHaveLength(0);
    expect((await latestAudit("federated-link-required"))?.detail).toMatchObject({ why: "already_federated" });
    // the SAME provider under a different subject is no better
    const resubbed = await roundTrip(providerId, { email: address, sub: `fed-a2-${tag}` });
    expect(resubbed.headers.location).toBe("/ui/login?link=pending");
  });

  it("finding 2: an account that has signed in before (never federated, no password) needs proof or approval too", async () => {
    const address = email("used");
    const uid = await mkUser(address);
    const k = await app.inject({ method: "POST", url: `/v1/users/${uid}/keys`, headers: AUTH, payload: { name: "used" } });
    const ex = await app.inject({ method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: k.json().token } });
    expect(ex.statusCode).toBe(200); // a session now exists for the account
    const cb = await roundTrip(providerId, { email: address, sub: `used-${tag}` });
    expect(cb.headers.location).toBe("/ui/login?link=pending");
    expect(cookieOf(cb)).toBeNull();
    expect((await latestAudit("federated-link-required"))?.detail).toMatchObject({ why: "signed_in_before" });
  });

  it("finding 2: a pre-0139 SSO user signing in again through the SAME provider row is linked from the audit trail (backfill) — and only through that row", async () => {
    const providerB = (await mkProvider({ name: `link-c-${tag}` })).id;
    const address = email("legacy");
    const uid = await mkUser(address);
    await legacySsoLogin(uid, address, `link-${tag}`);
    // a DIFFERENT provider row has no evidence: proof or approval
    expect((await roundTrip(providerB, { email: address, sub: `legacy-b-${tag}` })).headers.location).toBe("/ui/login?link=pending");
    // the provider the person already used: straight in, linked as prior_sso
    const cb = await roundTrip(providerId, { email: address, sub: `legacy-${tag}` });
    expect(cb.statusCode, cb.body).toBe(302);
    expect(cb.headers.location).toBe("/app");
    expect(cookieOf(cb)).toBeTruthy();
    const [row] = await linkRows(uid);
    expect(row?.linkedVia).toBe("prior_sso");
    expect((await latestAudit("federated-identity-linked"))?.detail).toMatchObject({ linkedVia: "prior_sso" });
    // the login it just wrote carries providerId, so it is never evidence
    const ok = await latestAudit("login-succeeded");
    expect((ok?.detail as { providerId?: string }).providerId).toBe(providerId);
    // and the backfill is spent: another subject now needs proof
    expect((await roundTrip(providerId, { email: address, sub: `legacy-2-${tag}` })).headers.location).toBe("/ui/login?link=pending");
  });

  it("finding 2: backfill evidence must be pre-0139 (no providerId), for the same email, and no older than the provider row", async () => {
    const withId = email("legacy-id");
    const uidA = await mkUser(withId);
    await legacySsoLogin(uidA, withId, `link-${tag}`, { providerId });
    expect((await roundTrip(providerId, { email: withId, sub: `legacy-id-${tag}` })).headers.location).toBe("/ui/login?link=pending");
    const otherEmail = email("legacy-mail");
    const uidB = await mkUser(otherEmail);
    await legacySsoLogin(uidB, email("someone-else"), `link-${tag}`);
    expect((await roundTrip(providerId, { email: otherEmail, sub: `legacy-mail-${tag}` })).headers.location).toBe("/ui/login?link=pending");
    const old = email("legacy-old");
    const uidC = await mkUser(old);
    await legacySsoLogin(uidC, old, `link-${tag}`);
    await db.update(auditLog).set({ at: new Date(Date.now() - 365 * 86_400_000) })
      .where(and(eq(auditLog.objectId, uidC), eq(auditLog.ruleId, "login-succeeded")));
    expect((await roundTrip(providerId, { email: old, sub: `legacy-old-${tag}` })).headers.location).toBe("/ui/login?link=pending");
  });

  it("finding 6: links are keyed on the issuer — a link recorded under another issuer does not match, and an issuer change drops the provider's links (audited)", async () => {
    const p6 = (await mkProvider({ name: `issuer-${tag}` })).id;
    const address = email("issuer");
    const uid = await mkUser(address);
    expect((await roundTrip(p6, { email: address, sub: `issuer-${tag}` })).headers.location).toBe("/app");
    const [row] = await db.select().from(federatedIdentities).where(eq(federatedIdentities.oidcProviderId, p6));
    expect(row).toMatchObject({ userId: uid, issuer: idp.issuer, subjectFormat: "", subject: `issuer-${tag}` });
    // the same (provider, subject) under a different issuer is somebody else
    await db.update(federatedIdentities).set({ issuer: "https://old-issuer.example" }).where(eq(federatedIdentities.id, row!.id));
    expect((await roundTrip(p6, { email: address, sub: `issuer-${tag}` })).headers.location).toBe("/ui/login?link=pending");
    await db.update(federatedIdentities).set({ issuer: idp.issuer }).where(eq(federatedIdentities.id, row!.id));
    expect((await roundTrip(p6, { email: address, sub: `issuer-${tag}` })).headers.location).toBe("/app");
    // moving the provider to another issuer removes its links
    const moved = await app.inject({ method: "PATCH", url: `/v1/auth/oidc-providers/${p6}`, headers: AUTH, payload: { issuerUrl: `${idp.issuer}/moved` } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.oidcProviderId, p6))).toHaveLength(0);
    const reset = await latestAudit("federated-identities-reset");
    expect(reset?.objectId).toBe(p6);
    expect((reset?.detail as { identities?: number }).identities).toBe(1);
    // a PATCH that does not touch the issuer leaves links alone
    const p6b = (await mkProvider({ name: `issuer-b-${tag}` })).id;
    const addressB = email("issuer-b");
    await mkUser(addressB);
    expect((await roundTrip(p6b, { email: addressB, sub: `issuer-b-${tag}` })).headers.location).toBe("/app");
    expect((await app.inject({ method: "PATCH", url: `/v1/auth/oidc-providers/${p6b}`, headers: AUTH, payload: { jitProvisioning: false } })).statusCode).toBe(200);
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.oidcProviderId, p6b))).toHaveLength(1);
  });

  it("finding 7: a look-alike (non-ASCII) email never reaches an ASCII account, and a non-ASCII stored address never matches an ASCII claim", async () => {
    const jit = (await mkProvider({ name: `jit-${tag}`, jitProvisioning: true, allowedEmailDomains: ["adr0174.example"] })).id;
    const victim = `kate-${tag}@adr0174.example`;
    const victimId = await mkUser(victim);
    // U+212A KELVIN SIGN lower-cases to ASCII k in JavaScript and Postgres
    const kelvin = await roundTrip(jit, { email: `\u212Aate-${tag}@adr0174.example`, sub: `kelvin-${tag}` });
    expect(kelvin.statusCode).toBe(403);
    expect(kelvin.json().error).toBe("email_not_linkable");
    expect(cookieOf(kelvin)).toBeNull();
    // full-width letters fold onto ASCII under NFKC
    const wide = await roundTrip(jit, { email: `\uFF4Bate-${tag}@adr0174.example`, sub: `wide-${tag}` });
    expect(wide.statusCode).toBe(403);
    expect(wide.json().error).toBe("email_not_linkable");
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, victimId))).toHaveLength(0);
    expect(await db.select().from(users).where(sql`lower(${users.email}) = ${victim}`)).toHaveLength(1); // nothing JIT-created
    // the database side: a stored Kelvin address is not an ASCII claim's account
    const [stored] = await db.insert(users).values({ email: `\u212Aim-${tag}@adr0174.example`, displayName: "kelvin" }).returning({ id: users.id });
    createdUserIds.add(stored!.id);
    const ascii = await roundTrip(providerId, { email: `kim-${tag}@adr0174.example`, sub: `kim-${tag}` });
    expect(ascii.statusCode).toBe(403);
    expect(ascii.json().error).toBe("unknown_user");
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, stored!.id))).toHaveLength(0);
    // plain ASCII case differences still match, as they always have
    const upper = await roundTrip(providerId, { email: victim.toUpperCase(), sub: `kate-${tag}` });
    expect(upper.headers.location).toBe("/app");
  });

  it("finding 11: an unknown provider id is a plain 404 that writes no audit row, whatever idp it asks for", async () => {
    const ghost = randomUUID();
    for (const idpValue of ["facebook", "google"]) {
      const r = await app.inject({ method: "GET", url: `/auth/oidc/${ghost}/login?idp=${idpValue}` });
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe("unknown_provider");
    }
    expect(await db.select().from(auditLog).where(eq(auditLog.objectId, ghost))).toHaveLength(0);
  });

  it("finding 12: a refused confirm (identity already linked elsewhere) does not spend the request", async () => {
    const address = email("taken");
    const uid = await mkUser(address);
    const password = await givePassword(uid, address);
    const sub = `taken-${tag}`;
    const cb = await roundTrip(providerId, { email: address, sub });
    const linkCookie = cookieOf(cb, "regulait_link")!;
    // meanwhile the same identity got linked to somebody else
    const otherId = await mkUser(email("taken-other"));
    await db.insert(federatedIdentities).values({ userId: otherId, oidcProviderId: providerId, issuer: idp.issuer, subject: sub, linkedVia: "admin" });
    const r = await app.inject({ method: "POST", url: "/auth/link/confirm", headers: CSRF, cookies: { regulait_link: linkCookie }, payload: { password } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("identity_already_linked");
    const [req] = await db.select().from(federatedLinkRequests).where(eq(federatedLinkRequests.userId, uid));
    expect(req?.status).toBe("pending"); // not "linked" with no link behind it
    expect(cookieOf(r)).toBeNull();
  });

  it("finding 12: linking to an ADMIN account takes two distinct admin approvals", async () => {
    const address = email("admin-target");
    const uid = await mkUser(address, true);
    await givePassword(uid, address);
    const sub = `admin-target-${tag}`;
    // ADR-0181: MFA is required for admins, so the IdP asserts it (RFC 8176)
    expect((await roundTrip(providerId, { email: address, sub, amr: ["mfa"] })).headers.location).toBe("/ui/login?link=pending");
    const [pend] = await db.select().from(federatedLinkRequests).where(and(eq(federatedLinkRequests.userId, uid), eq(federatedLinkRequests.status, "pending")));
    const list = await app.inject({ method: "GET", url: "/v1/auth/link-requests", headers: AUTH });
    expect(list.json().requests.find((x: { id: string }) => x.id === pend!.id)).toMatchObject({ approvals: 0, requiredApprovals: 2 });
    const first = await app.inject({ method: "POST", url: `/v1/auth/link-requests/${pend!.id}/approve`, headers: AUTH, payload: {} });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ status: "pending", approvals: 1, requiredApprovals: 2 });
    expect(await linkRows(uid)).toHaveLength(0);
    expect((await latestAudit("federated-link-approval-recorded"))?.objectId).toBe(uid);
    const again = await app.inject({ method: "POST", url: `/v1/auth/link-requests/${pend!.id}/approve`, headers: AUTH, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_approved_by_you");
    // a second, different administrator completes it
    const secondAdmin = await mkUser(email("second-admin"), true);
    // ADR-0181 (FX2): an admin's key answers to mfaRequired — they enrol first
    await enrolAdminTotpForTest(app, BOOT, secondAdmin);
    const key = await app.inject({ method: "POST", url: `/v1/users/${secondAdmin}/keys`, headers: AUTH, payload: { name: "second" } });
    const second = await app.inject({
      method: "POST", url: `/v1/auth/link-requests/${pend!.id}/approve`,
      headers: { authorization: `Bearer ${key.json().token}` }, payload: { reason: "second approver" },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ status: "approved", approvals: 2 });
    expect((await linkRows(uid))[0]?.linkedVia).toBe("admin");
  });
});

// ===========================================================================
describe("demo:set-passwords", () => {
  const personaSnapshot: Array<typeof users.$inferSelect> = [];
  const createdPersonaIds: string[] = [];
  let parkedLicenseIds: string[] = [];
  const insertedLicenseIds: string[] = [];
  let tmp = "";

  const DEMO_TENANT = "regulAIt capability demo — NOT A PRODUCTION DEPLOYMENT";
  const insertLicense = async (licenseId: string, tenant: string, expiresInMs = 86_400_000) => {
    const now = Date.now();
    const doc = {
      schema: "regulait.license/1",
      licenseId,
      tenant,
      tier: "enterprise",
      seatCap: 25,
      features: [],
      deploymentMode: "hosted",
      issuedAt: new Date(Math.min(now, now + expiresInMs) - 120_000).toISOString(),
      notBefore: new Date(Math.min(now, now + expiresInMs) - 120_000).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      graceDays: 0,
      hardStopOnExpiry: false,
    };
    const text = JSON.stringify(doc);
    const [row] = await db
      .insert(licenses)
      .values({
        document: text,
        documentSha256: createHash("sha256").update(text).digest("hex"),
        signature: "test-only-unverified",
        signingKeyId: "adr0174-test",
        licenseId,
        tenant,
        tier: "enterprise",
        seatCap: 25,
        features: [],
        deploymentMode: "hosted",
        issuedAt: new Date(doc.issuedAt),
        notBefore: new Date(doc.notBefore),
        expiresAt: new Date(doc.expiresAt),
        graceDays: 0,
        status: "active",
      })
      .returning({ id: licenses.id });
    insertedLicenseIds.push(row!.id);
    return row!.id;
  };
  const dropLicense = async (id: string) => {
    await db.delete(licenses).where(eq(licenses.id, id));
  };

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "adr0174-"));
    // the personas: snapshot existing rows, create any that are missing
    const existing = await db.select().from(users).where(inArray(users.email, [...DEMO_PERSONA_EMAILS]));
    personaSnapshot.push(...existing);
    for (const e of DEMO_PERSONA_EMAILS) {
      if (!existing.find((u) => u.email === e)) {
        const [row] = await db.insert(users).values({ email: e, displayName: e.split("@")[0]!, isAdmin: e.startsWith("admin") }).returning({ id: users.id });
        createdPersonaIds.push(row!.id);
      }
    }
    // park any licence another suite left active; restored in afterAll
    const parked = await db.update(licenses).set({ status: "superseded" }).where(eq(licenses.status, "active")).returning({ id: licenses.id });
    parkedLicenseIds = parked.map((p) => p.id);
  });
  afterAll(async () => {
    if (insertedLicenseIds.length) await db.delete(licenses).where(inArray(licenses.id, insertedLicenseIds));
    if (parkedLicenseIds.length) await db.update(licenses).set({ status: "active" }).where(inArray(licenses.id, parkedLicenseIds));
    for (const row of personaSnapshot) {
      await db
        .update(users)
        .set({
          passwordHash: row.passwordHash,
          passwordUpdatedAt: row.passwordUpdatedAt,
          mustChangePassword: row.mustChangePassword,
          failedLoginCount: row.failedLoginCount,
          lastFailedLoginAt: row.lastFailedLoginAt,
          lockedUntil: row.lockedUntil,
        })
        .where(eq(users.id, row.id));
    }
    if (createdPersonaIds.length) await db.delete(users).where(inArray(users.id, createdPersonaIds));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses without a password in the environment (and changes nothing)", async () => {
    const before = await db.select({ h: users.passwordHash }).from(users).where(eq(users.email, "dana@regulait.local"));
    const r = await setDemoPasswords(db, {});
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.lines.join("\n")).toContain("REGULAIT_DEMO_USER_PASSWORD");
    const after = await db.select({ h: users.passwordHash }).from(users).where(eq(users.email, "dana@regulait.local"));
    expect(after[0]?.h).toBe(before[0]?.h);
  });

  it("refuses a password the org policy refuses — without echoing it", async () => {
    const weak = "short";
    const id = await insertLicense(`demo-weak-${tag}`, DEMO_TENANT);
    try {
      const r = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: weak });
      expect(r.ok).toBe(false);
      expect(r.exitCode).toBe(1);
      expect(r.lines.join("\n")).toContain("password policy");
      expect(r.lines.join("\n")).not.toContain(weak);
    } finally {
      await dropLicense(id);
    }
  });

  it("refuses on a real-deployment box (REGULAIT_DEPLOY_MODE) without the demo licence", async () => {
    const r = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: synthetic(), REGULAIT_DEPLOY_MODE: "byoc" });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("real deployment");
  });

  it("finding 8: refuses without a valid demo licence even on a laptop (no deployment signal) — demoLicensed is required, as ADR-0174 §6 says", async () => {
    const before = await db.select({ h: users.passwordHash }).from(users).where(eq(users.email, "avery@regulait.local"));
    const none = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: synthetic() });
    expect(none.ok).toBe(false);
    expect(none.exitCode).toBe(1);
    expect(none.lines.join("\n")).toContain("no valid demo licence");
    expect(none.lines.join("\n")).toContain("demo:setup");
    const after = await db.select({ h: users.passwordHash }).from(users).where(eq(users.email, "avery@regulait.local"));
    expect(after[0]?.h).toBe(before[0]?.h);
    // an EXPIRED demo licence is not a demo licence
    const id = await insertLicense(`demo-expired-${tag}`, DEMO_TENANT, -86_400_000);
    try {
      expect((await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: synthetic() })).ok).toBe(false);
    } finally {
      await dropLicense(id);
    }
  });

  it("refuses when a customer (non-demo) licence is installed, even on a laptop", async () => {
    const id = await insertLicense(`cust-${tag}`, "Acme Bank plc");
    try {
      const r = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: synthetic() });
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toContain("non-demo");
    } finally {
      await dropLicense(id);
    }
    expect(isDemoLicense({ licenseId: "demo-1", tenant: "regulAIt capability demo — NOT A PRODUCTION DEPLOYMENT" })).toBe(true);
    expect(isDemoLicense({ licenseId: "demo-1", tenant: "Acme" })).toBe(false);
    expect(isDemoLicense({ licenseId: "acme-1", tenant: "x — NOT A PRODUCTION DEPLOYMENT" })).toBe(false);
  });

  it("works with a synthetic password: personas sign in with it, the one-time flag is cleared, the audit row has no password", async () => {
    const password = synthetic();
    // put Dana in the one-time state first, the way seed leaves her
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.email, "dana@regulait.local"));
    // the documented order: demo:setup installs the demo licence first
    const licenceId = await insertLicense(`demo-works-${tag}`, DEMO_TENANT);
    const r = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD: password });
    await dropLicense(licenceId);
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).not.toContain(password);
    for (const e of DEMO_PERSONA_EMAILS) {
      const res = await login(e, password);
      expect(res.statusCode, `${e}: ${res.body}`).toBe(200);
      expect(res.json().mustChangePassword).toBe(false);
    }
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, "demo-password-set")).orderBy(desc(auditLog.at)).limit(3);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(password);
      expect(serialized).not.toContain("scrypt$");
      expect((row.detail as { source?: string }).source).toBe("env");
    }
    const dana = rows.find((x) => (x.detail as { email?: string }).email === "dana@regulait.local");
    expect((dana?.detail as { clearedMustChange?: boolean }).clearedMustChange).toBe(true);
  });

  it("reads a secret file too, and a demo licence lets it run on a deployed box", async () => {
    const password = synthetic();
    const file = path.join(tmp, "demo-password");
    writeFileSync(file, `${password}\n`, { mode: 0o600 });
    const id = await insertLicense(`demo-${tag}`, DEMO_TENANT);
    try {
      const r = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD_FILE: file, REGULAIT_DEPLOY_MODE: "hosted" });
      expect(r.ok, r.lines.join("\n")).toBe(true);
      expect((await login("avery@regulait.local", password)).statusCode).toBe(200);
      const both = await setDemoPasswords(db, { REGULAIT_DEMO_USER_PASSWORD_FILE: file, REGULAIT_DEMO_USER_PASSWORD: password });
      expect(both.ok).toBe(false);
    } finally {
      await dropLicense(id);
    }
  });
});
