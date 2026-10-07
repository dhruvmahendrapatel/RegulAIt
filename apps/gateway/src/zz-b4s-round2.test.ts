/**
 * B4S round 2 (ADR-0186 A / ADR-0180) — proof by attack for the second
 * security-fix round:
 *
 *  - B4S-06: the bootstrap credential (header or exchanged session) passes a
 *    step-up only while no active admin has a usable step-up method; after
 *    that a protected action from it is refused 403 step_up_required
 *    (credential "bootstrap", no methods) and the posture reports
 *    `bootstrap_token_configured`. This block runs FIRST, on a database where
 *    no admin has a method yet.
 *  - B4S-07: a fresh SSO sign-in is a step-up method only on a SECURE request
 *    (https, or https at a trusted proxy). Over plain http it is neither listed
 *    in a refusal nor started by /options.
 *  - B4S-04: every strict org setting is covered by ONE strictness registry
 *    (`ORG_SETTING_STRICTNESS`): the registry is walked against the writable
 *    schema and the strict-default constants, and relaxing an identity default,
 *    the approval TTL or an API-key lifetime through PUT /v1/org/settings needs
 *    a settings_relax step-up (tightening needs none).
 *  - B4S-05: deleting ANY governance rule (rate limit, data scope — approval
 *    rules already were) and lifting a revocation (MCP, agent, connector) or
 *    narrowing one to read_only needs a settings_relax step-up.
 *  - B4S-03: a call's sensitivity (and so the sensitive quorum) is decided by
 *    the server: the attributed project OR the caller's project memberships;
 *    the header can only raise it (the queue-time proof through the governed
 *    MCP path is in zz-b4ab-dual-control-signed-approvals).
 *  - G1: an onboarding group→role import that maps a group to a role an
 *    approval rule names as approver_role_id needs a settings_relax step-up
 *    (a dry run, and mappings to other roles, need none).
 *  - G2: adding a member to a team that routes or can claim approvals needs a
 *    settings_relax step-up (a team nobody routes to needs none).
 *
 * Runs on its OWN scratch database (prefix `b4s2_`), dropped in afterAll
 * (M-068), so the global state it needs (which admins have a step-up method,
 * the strict settings) is its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  complianceProfiles,
  projectMembers,
  projects,
  agentRevocations,
  agents,
  approvalAssignmentRules,
  approvalRules,
  groupRoleMappings,
  roles,
  teamMembers,
  auditLog,
  authSessions,
  connectorRevocations,
  connectors,
  createDb,
  desc,
  eq,
  federatedIdentities,
  mcpServers,
  rateLimits,
  dataScopeRules,
  revocations,
  runMigrations,
  samlProviders,
  sql,
  ssoReauthRequests,
  type Db,
} from "@regulait/db";
import {
  ACCOUNTABILITY_STRICT_DEFAULTS,
  BATCH3_STRICT_DEFAULTS,
  BATCH4_STRICT_DEFAULTS,
  STEP_UP_HEADER,
  STRICT_IDENTITY_DEFAULTS,
  updateOrgSettingsSchema,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { ORG_SETTING_STRICTNESS } from "./org-setting-strictness.js";
import { relaxedSettingKeys } from "./org-settings.js";
import { callSensitivity } from "./approval-signatures.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4s2_r2_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4s2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
/** the address the app trusts as its TLS-terminating proxy */
const PROXY = "10.20.30.40";
const SECURE = { remoteAddress: PROXY, headers: { "x-forwarded-proto": "https" } };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
type Person = { id: string; email: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

/** a request as `p`'s browser session; `secure` arrives as https through the trusted proxy */
const as = (
  p: { token: string },
  method: Method,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  secure = false,
) =>
  app.inject({
    method,
    url,
    ...(secure ? { remoteAddress: SECURE.remoteAddress } : {}),
    headers: { ...CSRF, ...(secure ? SECURE.headers : {}), ...headers },
    cookies: { regulait_session: p.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const boot = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...AUTH, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkSession(userId: string): Promise<string> {
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  return token;
}

/** a person with a browser session and an API key; no step-up method until one is enrolled */
async function mkPerson(label: string, isAdmin: boolean): Promise<Person> {
  const email = `b4s2-${label}-${RUN}@example.com`;
  const u = await boot("POST", "/v1/users", { email, displayName: `b4s2 ${label}`, isAdmin });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const key = await boot("POST", `/v1/users/${id}/keys`, { name: "b4s2" });
  expect(key.statusCode, key.body).toBe(201);
  return { id, email, key: { authorization: `Bearer ${key.json().token}` }, token: await mkSession(id), auth: new SoftAuthenticator({ origin: ORIGIN }) };
}

/** enrol a soft passkey on `p`'s (fresh) session */
async function enrolPasskey(p: Person): Promise<void> {
  const opt = await as(p, "POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await as(p, "POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: p.auth.register(opt.json().options), label: "b4s2" });
  expect(reg.statusCode, reg.body).toBe(201);
}

/** a passkey step-up for exactly `action` (what a 403 handed back) */
async function grantFor(p: Person, action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await as(p, "POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await as(p, "POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: p.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** refused without a grant with exactly `body` as the relaxed values, then admitted with a grant for it */
async function needsRelaxStepUp(p: Person, method: Method, url: string, payload: unknown, values: Record<string, unknown>) {
  const refused = await as(p, method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action.body.values).toEqual(values);
  const ok = await as(p, method, url, payload, { [STEP_UP_HEADER]: await grantFor(p, refused.json().action) });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0] ?? null;

async function mkServer(label: string): Promise<string> {
  const [row] = await db
    .insert(mcpServers)
    .values({ name: `b4s2-${label}-${RUN}`, url: `https://mcp-${label}-${RUN}.example.com/mcp` })
    .returning({ id: mcpServers.id });
  return row!.id;
}

function makeSamlCert(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-b4s2-test-only-"));
  try {
    const keyFile = path.join(dir, "k.pem");
    const certFile = path.join(dir, "c.pem");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-new", "-sha256", "-days", "1", "-key", keyFile, "-out", certFile, "-subj", "/CN=b4s2-idp"]);
    return readFileSync(certFile, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // the MFA dial is not this suite's subject (its own database: nothing to restore)
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
  await app.ready();
}, 180_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

// ---------------------------------------------------------------------------
// B4S-06 — the bootstrap credential passes a step-up only before an admin can
// ---------------------------------------------------------------------------

describe("B4S-06: the bootstrap credential passes step-up only during first-admin setup", () => {
  let first: Person;
  let bootSession: string;
  const relax = (minutes: number, headers: Record<string, string> = {}) => boot("PUT", "/v1/org/settings", { sessionIdleMinutes: minutes }, headers);
  const relaxViaSession = (minutes: number) => as({ token: bootSession }, "PUT", "/v1/org/settings", { sessionIdleMinutes: minutes });
  const posture = async () => (await boot("GET", "/v1/org/posture")).json().bootstrap;

  beforeAll(async () => {
    first = await mkPerson("first-admin", true);
    const ex = await app.inject({ method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: BOOT } });
    expect(ex.statusCode, ex.body).toBe(200);
    bootSession = ex.cookies.find((c) => c.name === "regulait_session")!.value;
  });
  afterAll(async () => {
    // put the strict value back through the step-up the admin can now give is not this block's subject
    await db.execute(sql`UPDATE org_settings SET session_idle_minutes = 30`);
  });

  it("while no admin can step up, the bootstrap header and its exchanged session pass (first-admin setup)", async () => {
    expect(await posture()).toEqual({ configured: true, adminWithStepUpMethod: false, passesStepUp: true, findings: [] });
    expect((await relax(40)).statusCode).toBe(200);
    expect((await relaxViaSession(45)).statusCode).toBe(200);
  });

  it("a non-admin's method, or a disabled admin's, does not close the door", async () => {
    const plain = await mkPerson("plain-with-totp", false);
    await db.execute(sql`UPDATE users SET totp_enabled = true WHERE id = ${plain.id}`);
    const gone = await mkPerson("disabled-admin", true);
    await db.execute(sql`UPDATE users SET totp_enabled = true, disabled_at = now() WHERE id = ${gone.id}`);
    expect((await posture()).adminWithStepUpMethod).toBe(false);
    expect((await relax(50)).statusCode).toBe(200);
  });

  it("once an admin enrols a passkey, a protected action from the bootstrap header or its session is refused", async () => {
    await enrolPasskey(first);
    for (const r of [await relax(55), await relaxViaSession(55)]) {
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", methods: [], credential: "bootstrap" });
    }
    // an unprotected write still works (the credential is not revoked, only no longer a step-up)
    const u = await boot("POST", "/v1/users", { email: `b4s2-after-${RUN}@example.com`, displayName: "after" });
    expect(u.statusCode, u.body).toBe(201);
    // and the person who CAN step up does the protected write the real way
    const refused = await as(first, "PUT", "/v1/org/settings", { sessionIdleMinutes: 55 });
    expect(refused.statusCode).toBe(403);
    const ok = await as(first, "PUT", "/v1/org/settings", { sessionIdleMinutes: 55 }, { [STEP_UP_HEADER]: await grantFor(first, refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("the posture reports bootstrap_token_configured while the token is still set", async () => {
    const p = await posture();
    expect(p).toMatchObject({ configured: true, adminWithStepUpMethod: true, passesStepUp: false });
    expect(p.findings.map((f: { code: string }) => f.code)).toEqual(["bootstrap_token_configured"]);
  });

  it("an admin's SSO link counts even when the bootstrap request is plain http; TOTP counts", async () => {
    await db.execute(sql`UPDATE webauthn_credentials SET revoked_at = now(), revoke_reason = 'b4s2 test' WHERE user_id = ${first.id}`);
    expect((await posture()).adminWithStepUpMethod).toBe(false);
    await db.execute(sql`UPDATE users SET totp_enabled = true WHERE id = ${first.id}`);
    expect((await relax(60)).statusCode).toBe(403);
    await db.execute(sql`UPDATE users SET totp_enabled = false WHERE id = ${first.id}`);
    const [sp] = await db
      .insert(samlProviders)
      .values({ name: `b4s2-saml6-${RUN}`, entityId: `https://idp6.b4s2-${RUN}.example/m`, idpSsoUrl: `https://idp6.b4s2-${RUN}.example/sso`, idpSigningCerts: [makeSamlCert()] })
      .returning({ id: samlProviders.id });
    await db.insert(federatedIdentities).values({
      userId: first.id,
      samlProviderId: sp!.id,
      issuer: `https://idp6.b4s2-${RUN}.example/m`,
      subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      subject: first.email,
      linkedVia: "jit",
    });
    expect((await relax(60)).statusCode).toBe(403);
    // the SAML link stays: every later block runs with an admin who can step up
  });
});

// ---------------------------------------------------------------------------
// B4S-07 — SSO step-up only on a secure request
// ---------------------------------------------------------------------------

describe("B4S-07: a fresh SSO sign-in is a step-up method only over https", () => {
  let ssoAdmin: Person;
  let server: string;
  beforeAll(async () => {
    ssoAdmin = await mkPerson("sso-admin", true);
    // inserted directly: creating a SAML provider through the API is license-gated (ADR-0052), not this suite's subject
    const [sp] = await db
      .insert(samlProviders)
      .values({
        name: `b4s2-saml-${RUN}`,
        entityId: `https://idp.b4s2-${RUN}.example/metadata`,
        idpSsoUrl: `https://idp.b4s2-${RUN}.example/sso`,
        idpSigningCerts: [makeSamlCert()],
      })
      .returning({ id: samlProviders.id });
    await db.insert(federatedIdentities).values({
      userId: ssoAdmin.id,
      samlProviderId: sp!.id,
      issuer: `https://idp.b4s2-${RUN}.example/metadata`,
      subjectFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      subject: ssoAdmin.email,
      linkedVia: "jit",
    });
    server = await mkServer("sso");
  });

  const reauthRows = async () => db.select().from(ssoReauthRequests).where(eq(ssoReauthRequests.userId, ssoAdmin.id));

  it("over plain http a protected action does not offer sso: 422 step_up_unavailable naming https", async () => {
    const r = await as(ssoAdmin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: ssoAdmin.id });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "step_up_unavailable", methods: [] });
    expect(r.json().detail).toContain("https");
  });

  it("over plain http /options neither offers nor STARTS an sso step-up (no reauth request is created)", async () => {
    const before = (await reauthRows()).length;
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", {
      action: { kind: "owner_change", body: { objectType: "mcp_server", objectId: server, ownerUserId: ssoAdmin.id } },
    });
    expect(o.statusCode, o.body).toBe(422);
    expect(o.json()).toMatchObject({ error: "step_up_unavailable", methods: [] });
    expect(o.json().sso).toBeUndefined();
    expect((await reauthRows()).length).toBe(before);
  });

  it("over https through the trusted proxy the same person is offered sso and /options starts it (the control)", async () => {
    const r = await as(ssoAdmin, "PUT", `/v1/servers/${server}/owner`, { ownerUserId: ssoAdmin.id }, {}, true);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", methods: ["sso"] });
    const before = (await reauthRows()).length;
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", { action: r.json().action }, {}, true);
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().methods).toEqual(["sso"]);
    expect(o.json().sso.redirectUrl).toMatch(/^https:\/\/idp\.b4s2-/);
    expect((await reauthRows()).length).toBe(before + 1);
  });

  it("a forged x-forwarded-proto from an untrusted peer is still plain http", async () => {
    const o = await as(ssoAdmin, "POST", "/v1/auth/step-up/options", { action: { kind: "owner_change", body: { x: RUN } } }, {
      "x-forwarded-proto": "https",
    });
    expect(o.statusCode, o.body).toBe(422);
    expect(o.json().error).toBe("step_up_unavailable");
  });
});

// ---------------------------------------------------------------------------
// B4S-04 — every strict org setting is covered by one registry
// ---------------------------------------------------------------------------

describe("B4S-04: relaxing ANY strict org setting needs a settings_relax step-up", () => {
  const writable = Object.keys(
    (updateOrgSettingsSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape,
  ).filter((k) => k !== "confirmIpLockout");
  const registry = ORG_SETTING_STRICTNESS as Record<string, { kind: string; strict?: unknown; relaxed?: (v: unknown) => boolean; reason?: string }>;
  /** strict defaults that are NOT org settings (they live on another route, which guards them itself) */
  const ELSEWHERE: Record<string, string> = { samlWantAuthnResponseSigned: "per SAML provider (POST/PATCH /v1/auth/saml-providers)" };

  it("the registry names every writable key, and nothing else (a new key without an entry fails here)", () => {
    expect(writable.length).toBeGreaterThan(100);
    expect(writable.filter((k) => !(k in registry))).toEqual([]);
    expect(Object.keys(registry).filter((k) => !writable.includes(k))).toEqual([]);
    for (const [k, e] of Object.entries(registry)) {
      if (e.kind === "exempt") expect(e.reason!.length, `${k}: an exemption says why`).toBeGreaterThan(20);
      else expect(e.relaxed!(e.strict), `${k}: its strict default is not a relaxation`).toBe(false);
    }
  });

  it("every key of every strict-defaults constant (and the approval TTL) is a RULE whose strict value is that default", () => {
    const constants: Record<string, unknown> = {
      ...STRICT_IDENTITY_DEFAULTS,
      ...ACCOUNTABILITY_STRICT_DEFAULTS,
      ...BATCH3_STRICT_DEFAULTS,
      ...BATCH4_STRICT_DEFAULTS,
      approvalTtlHours: 72,
    };
    for (const [k, strict] of Object.entries(constants)) {
      if (k in ELSEWHERE) {
        expect(writable, k).not.toContain(k);
        continue;
      }
      expect(registry[k]?.kind, `${k} has a relax rule`).toBe("rule");
      expect(registry[k]!.strict, k).toEqual(strict);
    }
  });

  it("the identity defaults, the approval TTL and the API-key lifetimes are relaxations; tightening is not", () => {
    expect(
      relaxedSettingKeys({
        mfaRequired: "off",
        sessionIdleMinutes: 60,
        passwordRequireClasses: 2,
        approvalDelegationEnabled: true,
        approvalTtlHours: null,
        apiKeyDefaultTtlDays: 120,
        apiKeyMaxTtlDays: null,
      }).sort(),
    ).toEqual(
      ["apiKeyDefaultTtlDays", "apiKeyMaxTtlDays", "approvalDelegationEnabled", "approvalTtlHours", "mfaRequired", "passwordRequireClasses", "sessionIdleMinutes"],
    );
    expect(
      relaxedSettingKeys({
        mfaRequired: "all",
        sessionIdleMinutes: 15,
        passwordRequireClasses: 4,
        approvalDelegationEnabled: false,
        approvalTtlHours: 24,
        apiKeyDefaultTtlDays: 30,
        apiKeyMaxTtlDays: 90,
      }),
    ).toEqual([]);
  });

  describe("through PUT /v1/org/settings", () => {
    let admin: Person;
    beforeAll(async () => {
      admin = await mkPerson("settings-admin", true);
      await enrolPasskey(admin);
    });

    it.each([
      ["sessionIdleMinutes", 90],
      ["approvalTtlHours", null],
      ["apiKeyMaxTtlDays", null],
      ["apiKeyDefaultTtlDays", 180],
      ["approvalDelegationEnabled", true],
      ["passwordRequireClasses", 2],
    ] as const)("relaxing %s is refused without a grant, admitted with one, audited as relaxed", async (key, value) => {
      await needsRelaxStepUp(admin, "PUT", "/v1/org/settings", { [key]: value }, { [key]: value });
      const audited = await lastAudit("org-settings-updated");
      expect((audited!.detail as { relaxed?: string[] }).relaxed).toEqual([key]);
    });

    it("tightening them back needs no step-up", async () => {
      const r = await as(admin, "PUT", "/v1/org/settings", {
        sessionIdleMinutes: STRICT_IDENTITY_DEFAULTS.sessionIdleMinutes,
        approvalTtlHours: 72,
        apiKeyMaxTtlDays: STRICT_IDENTITY_DEFAULTS.apiKeyMaxTtlDays,
        apiKeyDefaultTtlDays: STRICT_IDENTITY_DEFAULTS.apiKeyDefaultTtlDays,
        approvalDelegationEnabled: false,
        passwordRequireClasses: 4,
      });
      expect(r.statusCode, r.body).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// B4S-05 — removing a rule or lifting a revocation needs a step-up
// ---------------------------------------------------------------------------

describe("B4S-05: deleting a governance rule or lifting a revocation is a relaxation", () => {
  let admin: Person;
  let subject: Person;
  let server: string;
  beforeAll(async () => {
    admin = await mkPerson("rules-admin", true);
    await enrolPasskey(admin);
    subject = await mkPerson("rules-subject", false);
    server = await mkServer("rules");
  });

  /** an API key never steps up: refused with no methods, nothing changed */
  async function keyRefused(method: Method, url: string, payload?: unknown) {
    const r = await app.inject({ method, url, headers: admin.key, ...(payload !== undefined ? { payload: payload as object } : {}) });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", methods: [] });
  }

  it.each(["rate-limits", "data-scopes"] as const)("DELETE /v1/rules/%s/:id needs a step-up bound to the rule; the rule stays until then", async (kind) => {
    const body =
      kind === "rate-limits"
        ? { scope: "user", userId: subject.id, serverId: server, maxCalls: 5, windowSeconds: 60 }
        : { scope: "user", userId: subject.id, serverId: server, argPath: "repo", allowedValues: ["a"] };
    const created = await as(admin, "POST", `/v1/rules/${kind}`, body);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const table = kind === "rate-limits" ? rateLimits : dataScopeRules;
    await keyRefused("DELETE", `/v1/rules/${kind}/${id}`);
    const refused = await as(admin, "DELETE", `/v1/rules/${kind}/${id}`);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action).toEqual({ kind: "settings_relax", body: { ruleId: id, values: { deleted: true } } });
    expect(await db.select().from(table).where(eq(table.id, id))).toHaveLength(1);
    const ok = await as(admin, "DELETE", `/v1/rules/${kind}/${id}`, undefined, { [STEP_UP_HEADER]: await grantFor(admin, refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await db.select().from(table).where(eq(table.id, id))).toHaveLength(0);
  });

  it("an unknown rule is still 404 (no step-up asked for nothing)", async () => {
    const r = await as(admin, "DELETE", `/v1/rules/rate-limits/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`);
    expect(r.statusCode, r.body).toBe(404);
  });

  it("lifting an MCP revocation needs a step-up bound to it", async () => {
    const [rev] = await db.insert(revocations).values({ userId: subject.id, serverId: server, toolName: null }).returning({ id: revocations.id });
    await keyRefused("DELETE", `/v1/revocations/${rev!.id}`);
    const refused = await as(admin, "DELETE", `/v1/revocations/${rev!.id}`);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action.body).toEqual({ values: { revocationLifted: { kind: "mcp", revocationId: rev!.id } } });
    expect(await db.select().from(revocations).where(eq(revocations.id, rev!.id))).toHaveLength(1);
    const ok = await as(admin, "DELETE", `/v1/revocations/${rev!.id}`, undefined, { [STEP_UP_HEADER]: await grantFor(admin, refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("lifting an agent or a connector revocation needs a step-up bound to it and to the user", async () => {
    const [agent] = await db.insert(agents).values({ name: `b4s2-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    const [conn] = await db.insert(connectors).values({ name: `b4s2-conn-${RUN}`, kind: "crm" }).returning({ id: connectors.id });
    const [ar] = await db.insert(agentRevocations).values({ userId: subject.id, agentId: agent!.id }).returning({ id: agentRevocations.id });
    const [cr] = await db.insert(connectorRevocations).values({ userId: subject.id, connectorId: conn!.id }).returning({ id: connectorRevocations.id });
    for (const [kind, id, path] of [
      ["agent", ar!.id, `/v1/users/${subject.id}/revocations/agents/${ar!.id}`],
      ["connector", cr!.id, `/v1/users/${subject.id}/revocations/connectors/${cr!.id}`],
    ] as const) {
      await keyRefused("DELETE", path);
      const refused = await as(admin, "DELETE", path);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().action.body).toEqual({ values: { revocationLifted: { kind, revocationId: id, userId: subject.id } } });
      const ok = await as(admin, "DELETE", path, undefined, { [STEP_UP_HEADER]: await grantFor(admin, refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(200);
    }
    expect(await db.select().from(agentRevocations).where(eq(agentRevocations.id, ar!.id))).toHaveLength(0);
  });

  it("narrowing a revocation from full to read_only needs a step-up; restoring full needs none", async () => {
    const [rev] = await db.insert(revocations).values({ userId: subject.id, serverId: server, toolName: null }).returning({ id: revocations.id });
    const url = `/v1/revocations/mcp/${rev!.id}/scope`;
    await keyRefused("PATCH", url, { scope: "read_only" });
    const refused = await as(admin, "PATCH", url, { scope: "read_only" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action.body).toEqual({ values: { revocationScope: { kind: "mcp", revocationId: rev!.id, scope: "read_only" } } });
    const ok = await as(admin, "PATCH", url, { scope: "read_only" }, { [STEP_UP_HEADER]: await grantFor(admin, refused.json().action) });
    expect(ok.statusCode, ok.body).toBe(200);
    const back = await as(admin, "PATCH", url, { scope: "full" });
    expect(back.statusCode, back.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// G1 / G2 — the two approver-pool doors round 1 left open
// ---------------------------------------------------------------------------

describe("G1 + G2: an approver pool is never padded through an import or a team without a step-up", () => {
  let admin: Person;
  let member: Person;
  let approverRole: { id: string; name: string };
  let plainRole: { id: string; name: string };
  beforeAll(async () => {
    admin = await mkPerson("pool-admin", true);
    await enrolPasskey(admin);
    member = await mkPerson("pool-member", false);
    const [r1] = await db.insert(roles).values({ name: `b4s2 approvers ${RUN}` }).returning({ id: roles.id, name: roles.name });
    const [r2] = await db.insert(roles).values({ name: `b4s2 readers ${RUN}` }).returning({ id: roles.id, name: roles.name });
    approverRole = r1!;
    plainRole = r2!;
    await db.insert(approvalRules).values({ scope: "fleet", serverScope: "all", approverUserId: admin.id, approverRoleId: approverRole.id });
  });

  const mappingsFor = async (group: string) => db.select().from(groupRoleMappings).where(eq(groupRoleMappings.externalGroup, group));

  it("G1: an import mapping a group to an approver role is refused without a grant; nothing is mapped; a grant admits it", async () => {
    const rows = [
      { source: "oidc", externalGroup: `g1-approvers-${RUN}`, roleName: approverRole.name },
      { source: "scim", externalGroup: `g1-readers-${RUN}`, roleName: plainRole.name },
    ];
    const dry = await as(admin, "POST", "/v1/onboarding/imports/group-roles", { mode: "dry_run", rows });
    expect(dry.statusCode, dry.body).toBe(200);
    const key = await app.inject({ method: "POST", url: "/v1/onboarding/imports/group-roles", headers: admin.key, payload: { mode: "apply", rows } });
    expect(key.statusCode, key.body).toBe(403);
    expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
    const refused = await as(admin, "POST", "/v1/onboarding/imports/group-roles", { mode: "apply", rows });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action).toEqual({
      kind: "settings_relax",
      body: { values: { approverRoleGroups: [{ source: "oidc", externalGroup: `g1-approvers-${RUN}`, roleId: approverRole.id }] } },
    });
    expect(await mappingsFor(`g1-approvers-${RUN}`)).toHaveLength(0);
    expect(await mappingsFor(`g1-readers-${RUN}`)).toHaveLength(0);
    const ok = await as(admin, "POST", "/v1/onboarding/imports/group-roles", { mode: "apply", rows }, {
      [STEP_UP_HEADER]: await grantFor(admin, refused.json().action),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await mappingsFor(`g1-approvers-${RUN}`)).toHaveLength(1);
  });

  it("G1: an import mapping only to roles no approval rule names needs no step-up", async () => {
    const r = await as(admin, "POST", "/v1/onboarding/imports/group-roles", {
      mode: "apply",
      rows: [{ source: "oidc", externalGroup: `g1-plain-${RUN}`, roleName: plainRole.name }],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await mappingsFor(`g1-plain-${RUN}`)).toHaveLength(1);
  });

  it("G2: adding a member to a team a routing rule assigns approvals to needs a step-up bound to team and member", async () => {
    const t = await as(admin, "POST", "/v1/teams", { name: `b4s2-approver-team-${RUN}` });
    expect(t.statusCode, t.body).toBe(201);
    const teamId = t.json().id as string;
    await db.insert(approvalAssignmentRules).values({ name: `b4s2 route ${RUN}`, objectType: "workflow_stage", assigneeKind: "team", assigneeId: teamId });
    const key = await app.inject({ method: "POST", url: `/v1/teams/${teamId}/members`, headers: admin.key, payload: { userId: member.id } });
    expect(key.statusCode, key.body).toBe(403);
    const refused = await as(admin, "POST", `/v1/teams/${teamId}/members`, { userId: member.id });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().action).toEqual({ kind: "settings_relax", body: { values: { approverTeamMember: { teamId, userId: member.id } } } });
    expect(await db.select().from(teamMembers).where(eq(teamMembers.teamId, teamId))).toHaveLength(0);
    const ok = await as(admin, "POST", `/v1/teams/${teamId}/members`, { userId: member.id }, {
      [STEP_UP_HEADER]: await grantFor(admin, refused.json().action),
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("G2: a team nobody routes approvals to takes members with no step-up", async () => {
    const t = await as(admin, "POST", "/v1/teams", { name: `b4s2-plain-team-${RUN}` });
    expect(t.statusCode, t.body).toBe(201);
    const r = await as(admin, "POST", `/v1/teams/${t.json().id}/members`, { userId: member.id });
    expect(r.statusCode, r.body).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// B4S-03 — sensitivity is the server's answer; the header only raises it
// ---------------------------------------------------------------------------

describe("B4S-03: the sensitive quorum does not depend on the client header", () => {
  it("attributed project OR the caller's membership of a sensitive project; never lowered by the header", async () => {
    const caller = await mkPerson("sens-caller", false);
    const outsider = await mkPerson("sens-outsider", false);
    const [profile] = await db
      .insert(complianceProfiles)
      .values({ tag: `b4s2-sensitive-${RUN}`, piiMode: "block", mcpDefaultMode: "read_write" })
      .returning();
    const [sensitive] = await db.insert(projects).values({ name: `b4s2-sens-${RUN}`, classifications: [profile!.tag] }).returning({ id: projects.id });
    const [plain] = await db.insert(projects).values({ name: `b4s2-plain-${RUN}` }).returning({ id: projects.id });
    await db.insert(projectMembers).values({ projectId: sensitive!.id, userId: caller.id, role: "contributor" });
    expect(await callSensitivity(db, { projectId: null, callerUserId: outsider.id })).toEqual([]);
    expect(await callSensitivity(db, { projectId: plain!.id, callerUserId: outsider.id })).toEqual([]);
    expect(await callSensitivity(db, { projectId: sensitive!.id, callerUserId: outsider.id })).toEqual(["attributed_project"]);
    // the member cannot drop it by omitting the header or naming another project
    expect(await callSensitivity(db, { projectId: null, callerUserId: caller.id })).toEqual(["caller_membership"]);
    expect(await callSensitivity(db, { projectId: plain!.id, callerUserId: caller.id })).toEqual(["caller_membership"]);
    expect(await callSensitivity(db, { projectId: sensitive!.id, callerUserId: caller.id })).toEqual(["attributed_project"]);
  });
});
