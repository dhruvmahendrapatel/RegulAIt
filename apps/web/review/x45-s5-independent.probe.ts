/** X45 independent review of S5 frozen 37476e9cb35a723114718f132077648f48ebc9ec.
 * Shared synthetic HTTP fixture scaffolding adapted from the owner's S5 suite;
 * all acceptance scenarios below are independently authored. Copy this file to
 * apps/gateway/src/zz-x45-independent-review.test.ts before running gateway Vitest.
 * X45_EXPECT_RED=1 enables assertions of REQUIRED behavior (known failing at freeze).
 * Seeded step-up rows model a previously verified confirmation; this tests route
 * action binding, not the authenticator ceremony, and does not claim a ceremony bypass.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, decodeJwt, SignJWT, type JWK } from "jose";
import * as oauth from "oauth4webapi";
import { auditLog, authSessions, stepUpGrants, createDb, delegationGrants, eq, identitySigningKeys, issuedTokens, replayClaims, runMigrations, sql, and, type Db } from "@regulait/db";
import { canonicalDelegationBody, stepUpActionDigest, IDENTITY_SIGNING_KEY_ENV, type DelegationBody } from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, issueDpopNonce } from "./delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { COMPAT_ANTHROPIC_ROUTE, COMPAT_MODELS_ROUTE, COMPAT_OPENAI_ROUTE, MCP_PROXY_ROUTE } from "./compat-core.js";
import { WORKLOAD_ROUTES } from "./oauth/resource.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { makeCert, type TestCert } from "./testing/x509-fixtures.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `x45-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4417";
const TOKEN = `${ISSUER}/oauth/token`;
const DATA_KEY = "s5-synthetic-data-key-".padEnd(64, "y");
const SECRETS = deriveIdentitySecrets(DATA_KEY);
const PROXY_SECRET = "s5-proxy-secret-".padEnd(48, "z");
const TD = "s5.example.org";
const T = { read: `s5_read_${RUN}`, write: `s5_write_${RUN}` };
const SPIFFE = (s: string) => `spiffe://${TD}/regulait/s5/${s}-${RUN}`;
const EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const AT = "urn:ietf:params:oauth:token-type:access_token";

// deployment facts for this file's process (each vitest file runs in its own worker)
process.env.REGULAIT_PUBLIC_URL = ISSUER;
process.env.REGULAIT_CLIENT_CERT_HEADER = "x-s5-client-cert";
process.env.REGULAIT_CLIENT_CERT_PROXY_SECRET = PROXY_SECRET;
process.env.REGULAIT_TRUSTED_PROXIES = "127.0.0.1";
const ENV = deploymentEnvironment();

let db: Db;
let db2: Db;
let app: ReturnType<typeof buildApp>;
let app2: ReturnType<typeof buildApp>;
let sponsorId: string;
let sponsorAuth: { authorization: string };
let adminAuth: { authorization: string };
let serverId: string;
let resource: string;
let projectId: string;
let keyDir: string;
const restores: Array<() => Promise<void>> = [];
let root: TestCert;
let otherRoot: TestCert;

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
const b64sha = (v: string) => createHash("sha256").update(v).digest("base64url");

// --- workload fixtures -----------------------------------------------------

interface WKey {
  privateKey: KeyObject;
  jwk: JWK;
}
function wkey(): WKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" }) as JWK;
  return { privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: j.x! } };
}
const jkt = (k: WKey) => calculateJwkThumbprint(k.jwk, "sha256");

interface Agent {
  id: string;
  clientId: string;
  key: WKey;
  credId: string;
}
const agents: Agent[] = [];

async function newAgent(name: string, opts: { grants?: string[]; jwk?: boolean } = {}): Promise<Agent> {
  const a = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s5-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  const clientId = SPIFFE(name);
  const id = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
      values ('agent', ${a}, ${clientId}, ARRAY[${sponsorId}]::uuid[], ARRAY[${ENV}]) returning id`),
  )[0]!.id;
  for (const t of opts.grants ?? [T.read, T.write]) {
    await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${id}, ${serverId}, ${t})`);
  }
  const key = wkey();
  let credId = "";
  if (opts.jwk !== false) {
    credId = rows<{ id: string }>(
      await db.execute(sql`insert into workload_credentials (identity_id, kind, public_jwk, jwk_thumbprint, not_after)
        values (${id}, 'jwk', ${JSON.stringify(key.jwk)}::jsonb, ${await jkt(key)}, now() + interval '30 days') returning id`),
    )[0]!.id;
  }
  return { id, clientId, key, credId };
}

const nowS = () => Math.floor(Date.now() / 1000);

async function assertion(a: Agent, o: { aud?: string; iat?: number; exp?: number; jti?: string; iss?: string } = {}) {
  const iat = o.iat ?? nowS();
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: await jkt(a.key) })
    .setIssuer(o.iss ?? a.clientId)
    .setSubject(a.clientId)
    .setAudience(o.aud ?? TOKEN)
    .setJti(o.jti ?? randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(o.exp ?? iat + 120)
    .sign(a.key.privateKey);
}

async function dpop(k: WKey, o: { htm?: string; htu?: string; iat?: number; jti?: string; nonce?: string | null; ath?: string } = {}) {
  const p: Record<string, unknown> = { htm: o.htm ?? "POST", htu: o.htu ?? TOKEN, iat: o.iat ?? nowS(), jti: o.jti ?? randomUUID() };
  if (o.nonce !== null) p.nonce = o.nonce ?? issueDpopNonce(SECRETS.nonceKey);
  if (o.ath) p.ath = o.ath;
  return new SignJWT(p).setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: k.jwk }).sign(k.privateKey);
}

type Form = Record<string, string>;
const post = (a: ReturnType<typeof buildApp>, url: string, form: Form, headers: Record<string, string> = {}) =>
  a.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, payload: new URLSearchParams(form).toString() });
const token = (form: Form, dpopProof: string | null, headers: Record<string, string> = {}, on = app) =>
  post(on, "/oauth/token", form, { ...(dpopProof ? { dpop: dpopProof } : {}), ...headers });

const scope = (tools: string[] = [T.read], kind: "read" | "write" = "read") => [{ type: "mcp_tool", serverId, toolNames: tools, kind }];

async function makeProof(a: Agent, o: { scope?: unknown; cnf?: string; cap?: number; lifetime?: number; maxDepth?: number; resource?: string; auth?: Record<string, string> } = {}) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/delegations/proofs",
    headers: o.auth ?? sponsorAuth,
    payload: {
      agentIdentityId: a.id,
      authorizationDetails: o.scope ?? scope(),
      resource: o.resource ?? resource,
      projectId,
      env: ENV,
      ...(o.cnf ? { agentKeyThumbprint: o.cnf } : {}),
      ...(o.cap !== undefined ? { capMicros: o.cap } : {}),
      ...(o.lifetime ? { lifetimeSeconds: o.lifetime } : {}),
      ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}),
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().proof as string;
}

const rootForm = async (a: Agent, proof: string, o: { scope?: unknown; resource?: string; assertionOpts?: Parameters<typeof assertion>[1] } = {}): Promise<Form> => ({
  grant_type: EXCHANGE,
  subject_token: proof,
  subject_token_type: "urn:regulait:params:oauth:token-type:delegation-proof",
  requested_token_type: AT,
  resource: o.resource ?? resource,
  authorization_details: JSON.stringify(o.scope ?? scope()),
  client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  client_assertion: await assertion(a, o.assertionOpts),
});

/** a full root exchange; returns the token and the DPoP key it is bound to */
async function rootToken(a: Agent, o: { cap?: number; maxDepth?: number; scope?: unknown } = {}) {
  const bind = wkey();
  const proof = await makeProof(a, { cnf: await jkt(bind), ...(o.cap !== undefined ? { cap: o.cap } : {}), ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}), ...(o.scope ? { scope: o.scope } : {}) });
  const r = await token(await rootForm(a, proof, o.scope ? { scope: o.scope } : {}), await dpop(bind));
  expect(r.statusCode, r.body).toBe(200);
  const t = r.json().access_token as string;
  return { token: t, bind, grantId: decodeJwt(t).grant_id as string };
}

/** A authorises child B (decision 23) */
async function authz(parent: { token: string; bind: WKey; grantId: string }, parentAgent: Agent, childId: string, childJkt: string, body: DelegationBody, idem: string, o: { nonce?: string | null; iat?: number } = {}) {
  const p: Record<string, unknown> = {
    htm: "POST",
    htu: TOKEN,
    ath: b64sha(parent.token),
    iat: o.iat ?? nowS(),
    jti: randomUUID(),
    parent_grant_id: parent.grantId,
    child: childId,
    child_cnf: childJkt,
    delegation: canonicalDelegationBody(body),
    idempotency_key: idem,
  };
  if (o.nonce !== null) p.nonce = o.nonce ?? issueDpopNonce(SECRETS.nonceKey);
  return new SignJWT(p)
    .setProtectedHeader({ alg: "EdDSA", typ: "regulait-delegation-authz+jwt", jwk: parent.bind.jwk })
    .setIssuer(parentAgent.clientId)
    .setAudience(ISSUER)
    .sign(parent.bind.privateKey);
}

function childBody(o: Partial<DelegationBody> = {}): DelegationBody {
  return {
    authorization_details: scope() as DelegationBody["authorization_details"],
    resource,
    project_id: projectId,
    env: ENV,
    cap_micros: null,
    max_depth: 0,
    expires_at: nowS() + 600,
    ...o,
  };
}

async function childForm(child: Agent, parentToken: string, actorToken: string, body: DelegationBody, idem: string): Promise<Form> {
  return {
    grant_type: EXCHANGE,
    subject_token: parentToken,
    subject_token_type: AT,
    actor_token: actorToken,
    actor_token_type: "urn:regulait:params:oauth:token-type:delegation-authz",
    requested_token_type: AT,
    resource: body.resource,
    authorization_details: JSON.stringify(body.authorization_details),
    project_id: body.project_id ?? "null",
    env: body.env,
    cap_micros: body.cap_micros === null ? "null" : String(body.cap_micros),
    max_depth: String(body.max_depth),
    expires_at: String(body.expires_at),
    idempotency_key: idem,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await assertion(child),
  };
}

const claimed = async (ns: string, key: string) =>
  (await db.select().from(replayClaims).where(and(eq(replayClaims.namespace, ns as never), eq(replayClaims.key, key)))).length > 0;
const providerKey = (iss: string, jti: string) => b64sha(`${iss}${jti}`);

// --- setup -----------------------------------------------------------------

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  db2 = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  app2 = buildApp(db2, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  root = await makeCert({ isCA: true, name: `s5-root-${RUN}` });
  otherRoot = await makeCert({ isCA: true, name: `s5-other-${RUN}` });
  process.env.REGULAIT_MTLS_CA_BUNDLE = root.pem;
  process.env.REGULAIT_SPIFFE_TRUST_BUNDLES = JSON.stringify({ [TD]: root.pem });

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s5-issuer-"));
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem, { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });

  const inject = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const u = await inject("POST", "/v1/users", AUTH, { email: `x45-sponsor-${RUN}@example.com`, displayName: `s5 sponsor ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  sponsorId = u.json().id;
  sponsorAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${sponsorId}/keys`, AUTH, { name: "s5" })).json().token}` };
  const adm = await inject("POST", "/v1/users", AUTH, { email: `s5-admin-${RUN}@example.com`, displayName: `s5 admin ${RUN}`, isAdmin: true });
  adminAuth = { authorization: `Bearer ${(await inject("POST", `/v1/users/${adm.json().id}/keys`, AUTH, { name: "s5" })).json().token}` };
  const s = await inject("POST", "/v1/servers", AUTH, { name: `s5-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  resource = `${ISSUER}/mcp/${serverId}`;
  for (const [name, kind] of [
    [T.read, "read"],
    [T.write, "write"],
  ] as const) {
    expect((await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name, kind })).statusCode).toBe(201);
    expect((await inject("POST", "/v1/grants/tools", AUTH, { userId: sponsorId, serverId, toolName: name })).statusCode).toBe(201);
  }
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`s5-proj-${RUN}`}) returning id`))[0]!.id;
  const ic = await inject("GET", "/v1/interception/settings", AUTH);
  const before = ic.json().settings as { mcpInterceptionEnabled: boolean; anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean };
  expect(typeof before.mcpInterceptionEnabled).toBe("boolean");
  const put = await inject("PUT", "/v1/interception/settings", AUTH, { mcpInterceptionEnabled: true, anthropicCompatEnabled: true, openaiCompatEnabled: true });
  expect(put.statusCode, put.body).toBe(200);
  restores.push(async () => {
    const back = await inject("PUT", "/v1/interception/settings", AUTH, {
      mcpInterceptionEnabled: before.mcpInterceptionEnabled,
      anthropicCompatEnabled: before.anthropicCompatEnabled,
      openaiCompatEnabled: before.openaiCompatEnabled,
    });
    expect(back.statusCode, back.body).toBe(200);
  });
  for (let i = 0; i < 6; i++) agents.push(await newAgent(`a${i}`));
}, 120_000);

afterAll(async () => {
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  await app?.close();
  await app2?.close();
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
});


const required = process.env.X45_EXPECT_RED === "1" ? it : it.skip;

describe("X45 independent S5 acceptance", () => {
  it("defaults are exactly uncapped one-hour root authority, tokens remain <=300 seconds", async () => {
    const a = agents[0]!;
    const proof = await makeProof(a);
    const body = JSON.parse(decodeJwt(proof).delegation as string) as DelegationBody;
    expect(body.cap_micros).toBeNull();
    expect(body.expires_at - (decodeJwt(proof).iat as number)).toBe(3600);
    const r = await token(await rootForm(a, proof), await dpop(wkey()));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().expires_in).toBeLessThanOrEqual(300);
  });

  it("explicit root body restatement and root actor_token are refused without burning the proof", async () => {
    const a = agents[0]!;
    const key = wkey();
    const proof = await makeProof(a, { cnf: await jkt(key), cap: 100, maxDepth: 0 });
    const mutations: Form[] = [{ max_depth: "8" }, { cap_micros: "null" }, { actor_token: "forged", actor_token_type: "urn:regulait:params:oauth:token-type:delegation-authz" }];
    for (const extras of mutations) {
      const r = await token({ ...await rootForm(a, proof), ...extras }, await dpop(key));
      expect(r.statusCode, r.body).not.toBe(200);
    }
    expect((await token(await rootForm(a, proof), await dpop(key))).statusCode).toBe(200);
  });

  it("one human proof raced with distinct assertions and DPoP on two pools issues once", async () => {
    const a = agents[0]!;
    const key = wkey();
    const proof = await makeProof(a, { cnf: await jkt(key) });
    const r = await Promise.all([token(await rootForm(a, proof), await dpop(key)), token(await rootForm(a, proof), await dpop(key), {}, app2)]);
    expect(r.map(x => x.statusCode).sort()).toEqual([200, 400]);
  });

  it("one assertion raced across issuance and introspection authenticates once", async () => {
    const a = agents[0]!;
    const key = wkey();
    const proof = await makeProof(a, { cnf: await jkt(key) });
    const form = await rootForm(a, proof);
    const auth = { client_assertion_type: form.client_assertion_type!, client_assertion: form.client_assertion!, token: "unknown" };
    const replies = await Promise.all([token(form, await dpop(key)), post(app2, "/oauth/token/introspection", auth)]);
    expect(replies.filter(r => r.statusCode === 200)).toHaveLength(1);
  });

  it("child resource remains the exact parent audience and mismatch leaves authorization reusable", async () => {
    const a = agents[0]!, b = agents[1]!;
    const parent = await rootToken(a);
    const key = wkey();
    const body = childBody({ resource: `${ISSUER}/v1/models` });
    const idem = randomUUID();
    const signed = await authz(parent, a, b.id, await jkt(key), body, idem);
    const r = await token(await childForm(b, parent.token, signed, body, idem), await dpop(key));
    expect(r.statusCode, r.body).toBe(400);
    expect(await claimed("delegation_authz", `${await jkt(parent.bind)}:${decodeJwt(signed).jti}`)).toBe(false);
    const validBody = childBody();
    const validAuthz = await authz(parent, a, b.id, await jkt(key), validBody, randomUUID());
    const validIdem = decodeJwt(validAuthz).idempotency_key as string;
    const ok = await token(await childForm(b, parent.token, validAuthz, validBody, validIdem), await dpop(key));
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("caller act cannot be injected through the exchange request", async () => {
    const a = agents[0]!;
    const proof = await makeProof(a);
    const r = await token({ ...await rootForm(a, proof), act: JSON.stringify({ sub: "forged-admin" }) }, await dpop(wkey()));
    expect(r.statusCode, r.body).toBe(200);
    expect(decodeJwt(r.json().access_token).act).toEqual({ sub: a.clientId });
  });

  it("introspection and revocation never grant another client control", async () => {
    const a = agents[0]!, b = agents[1]!;
    const parent = await rootToken(a);
    const admin = async (who: Agent, route: string) => post(app, route, { token: parent.token, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(who) });
    expect((await admin(b, "/oauth/token/introspection")).json()).toEqual({ active: false });
    expect((await admin(b, "/oauth/token/revocation")).statusCode).toBe(200);
    expect((await admin(a, "/oauth/token/introspection")).json().active).toBe(true);
    expect((await admin(a, "/oauth/token/revocation")).statusCode).toBe(200);
    expect((await admin(a, "/oauth/token/introspection")).json()).toEqual({ active: false });
  });

  required("I7S5-03 strict fresh-org defaults must reject an omitted root cap", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/delegations/proofs", headers: sponsorAuth, payload: { agentIdentityId: agents[0]!.id, authorizationDetails: scope(), resource, projectId, env: ENV } });
    expect(r.statusCode, `uncapped default status: ${r.statusCode}`).toBe(400);
    expect(r.json().error).toBe("delegation_cap_required");
  });

  required("I7S5-04 assertion replay retention must cover its DB-clock acceptance window despite process skew", async () => {
    const a = agents[0]!, bind = wkey();
    const proof = await makeProof(a, { cnf: await jkt(bind) });
    const form = await rootForm(a, proof), dp = await dpop(bind);
    const claims = decodeJwt(form.client_assertion!);
    const realNow = Date.now();
    const fake = vi.spyOn(Date, "now").mockReturnValue(realNow + 30_000);
    try {
      const r = await token(form, dp);
      expect(r.statusCode, r.body).toBe(200);
      const [claim] = await db.select().from(replayClaims).where(and(eq(replayClaims.namespace, "client_assertion"), eq(replayClaims.key, providerKey(a.clientId, claims.jti!))));
      expect(claim, "successful assertion must be retained").toBeDefined();
      expect(claim!.expiresAt.getTime(), "retention may not expire before signed exp + skew").toBeGreaterThanOrEqual((claims.exp! + 5) * 1000);
    } finally { fake.mockRestore(); }
  });

  required("I7S5-01 a human root proof maxDepth:0 must prohibit the first child", async () => {
    const a = agents[0]!, b = agents[1]!;
    const parent = await rootToken(a, { maxDepth: 0 });
    const key = wkey(), body = childBody(), idem = randomUUID();
    const signed = await authz(parent, a, b.id, await jkt(key), body, idem);
    const r = await token(await childForm(b, parent.token, signed, body, idem), await dpop(key));
    expect(r.statusCode, `signed root maxDepth=0 child status: ${r.statusCode}`).toBe(400);
  });

  required("I7S5-02 a confirmed classified write body must not authorize a substituted scope/cap/depth/lifetime/key", async () => {
    await db.execute(sql`update projects set classifications = '["sensitive"]'::jsonb where id = ${projectId}`);
    const a = agents[0]!;
    const sessionToken = `rgls_${randomUUID().replaceAll("-", "").repeat(2)}`;
    const [session] = await db.insert(authSessions).values({ tokenHash: createHash("sha256").update(sessionToken).digest("hex"), userId: sponsorId, origin: "password", expiresAt: new Date(Date.now()+3600000), idleExpiresAt: new Date(Date.now()+3600000), idleMinutes: 60 }).returning();
    const grantToken = `rgsu_${randomUUID()}`;
    const original = { agentIdentityId: a.id, projectId, resource, env: ENV, authorizationDetails: scope([T.write], "write"), capMicros: 1, lifetimeSeconds: 60, maxDepth: 0, agentKeyThumbprint: await jkt(wkey()) };
    const facts = { op: "delegation_proof", agentIdentityId: a.id, projectId, resource };
    await db.insert(stepUpGrants).values({ tokenHash: createHash("sha256").update(grantToken).digest("hex"), userId: sponsorId, sessionId: session!.id, method: "totp", actionKind: "identity_manage", actionDigest: stepUpActionDigest("identity_manage", facts), expiresAt: new Date(Date.now()+120000) });
    try {
      const r = await app.inject({ method: "POST", url: "/v1/delegations/proofs", cookies: { regulait_session: sessionToken }, headers: { "x-regulait-csrf": "1", "x-regulait-step-up": grantToken }, payload: { ...original, authorizationDetails: scope([T.read, T.write], "write"), capMicros: 1000000, lifetimeSeconds: 3600, maxDepth: 3, agentKeyThumbprint: await jkt(wkey()) } });
      expect(r.statusCode, `substituted confirmation status: ${r.statusCode}`).toBe(403);
    } finally {
      await db.delete(stepUpGrants).where(eq(stepUpGrants.sessionId, session!.id));
      await db.delete(authSessions).where(eq(authSessions.id, session!.id));
      await db.execute(sql`update projects set classifications = '[]'::jsonb where id = ${projectId}`);
    }
  });
});
