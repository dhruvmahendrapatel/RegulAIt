/**
 * ADR-0188 (batch 6 item 1) S5 — THE TOKEN ENDPOINT AND EXTERNAL CALLERS, on a
 * real database, through the real app (`buildApp`) and its real hooks:
 *
 *  - RFC 8693 ROOT EXCHANGE (decision 15): a person's one-use delegation proof
 *    + the agent's `private_key_jwt` + DPoP → a token bound to the agent's
 *    DPoP key, `act` rebuilt from the stored path; every refusal.
 *  - `private_key_jwt`: a replayed, expired or wrong-audience assertion is
 *    refused BEFORE ANY CLAIM (the DPoP proof and the human proof stay usable);
 *    the same assertion raced on two pools ("replicas") wins once.
 *  - DPoP at the token endpoint: nonce issue and retry with the SAME unused
 *    assertion, stale and future proofs, wrong htm/htu, replay across pools.
 *  - CHILD EXCHANGE (decision 23): substitutions are refused WITHOUT
 *    consuming A's authorization; a child resource other than the parent's.
 *    S5 review item 1: until the signed root depth is persisted and enforced
 *    (S4 follow-up), EVERY external child exchange is refused
 *    `delegation_depth_unenforced`, before any claim (the reviewer's probe).
 *  - S5 REVIEW: steward and project checks on proofs (item 2), strict root
 *    caps and lifetimes (item 6), the timeout race (item 5), introspection's
 *    single-string `aud` (item 7).
 *  - mTLS / SPIFFE (decision 21): `tls_client_auth` through an authenticated
 *    proxy header; SPIFFE X.509-SVID; wrong trust root, expired, wrong SPIFFE
 *    ID, forged header; an mTLS parent cannot hand off.
 *  - REVOCATION AND INTROSPECTION: authentication required; a client sees and
 *    revokes only its own tokens.
 *  - THE RESOURCE: delegated tokens on `/mcp/:serverId` and the compat routes
 *    are verified (dead chain → 401) and then held back (403) until S4 wires
 *    the governed paths; nowhere else; schemes case-insensitive.
 *  - GRANT ADMIN: list/tree, detail, cascade revoke behind the step-up.
 *  - CLOCK SKEW: the process clock ±500 ms changes nothing (database clock).
 *
 * Global state (M-068): org settings, interception settings and the active
 * issuer key are put back in afterAll. Identity rows cannot be deleted by
 * design; every fixture is scoped by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, decodeJwt, SignJWT, type JWK } from "jose";
import * as oauth from "oauth4webapi";
import { auditLog, createDb, delegationGrants, eq, identitySigningKeys, issuedTokens, orgSettings, replayClaims, runMigrations, sql, and, desc, type Db } from "@regulait/db";
import { canonicalDelegationBody, IDENTITY_SIGNING_KEY_ENV, type DelegationBody } from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, issueDpopNonce } from "./delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { COMPAT_ANTHROPIC_ROUTE, COMPAT_MODELS_ROUTE, COMPAT_OPENAI_ROUTE, MCP_PROXY_ROUTE } from "./compat-core.js";
import { WORKLOAD_ROUTES } from "./oauth/resource.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { setTokenRequestTimeoutForTest, tokenEndpointTestHooks } from "./oauth/token-endpoint.js";
import { admitChildGrant } from "./delegation.js";
import { makeCert, type TestCert } from "./testing/x509-fixtures.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s5-boot-${RUN}`;
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

async function newAgent(name: string, opts: { grants?: string[]; jwk?: boolean; sponsors?: string[] } = {}): Promise<Agent> {
  const a = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s5-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  const clientId = SPIFFE(name);
  const id = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
      values ('agent', ${a}, ${clientId}, ${`{${(opts.sponsors ?? [sponsorId]).join(",")}}`}::uuid[], ARRAY[${ENV}]) returning id`),
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

async function assertion(a: Agent, o: { aud?: string | string[]; iat?: number; exp?: number; jti?: string; iss?: string } = {}) {
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

/** a proof request (S5 review item 6: a cap is required by default, so fixtures name one unless `cap: null`) */
const proofRequest = (a: Agent, o: { scope?: unknown; cnf?: string; cap?: number | null; lifetime?: number; maxDepth?: number; resource?: string; auth?: Record<string, string>; project?: string } = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/delegations/proofs",
    headers: o.auth ?? sponsorAuth,
    payload: {
      agentIdentityId: a.id,
      authorizationDetails: o.scope ?? scope(),
      resource: o.resource ?? resource,
      projectId: o.project ?? projectId,
      env: ENV,
      ...(o.cnf ? { agentKeyThumbprint: o.cnf } : {}),
      ...(o.cap === null ? {} : { capMicros: o.cap ?? 1_000_000 }),
      ...(o.lifetime ? { lifetimeSeconds: o.lifetime } : {}),
      ...(o.maxDepth !== undefined ? { maxDepth: o.maxDepth } : {}),
    },
  });

async function makeProof(a: Agent, o: Parameters<typeof proofRequest>[1] = {}) {
  const r = await proofRequest(a, o);
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
  const u = await inject("POST", "/v1/users", AUTH, { email: `s5-sponsor-${RUN}@example.com`, displayName: `s5 sponsor ${RUN}` });
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
  // S5 review: a delegation needs EXPLICIT project membership
  await db.execute(sql`insert into project_members (project_id, user_id, role) values (${projectId}, ${sponsorId}, 'contributor')`);
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

// ---------------------------------------------------------------------------
describe("S5 — wiring facts", () => {
  it("the workload route allow-list is exactly the MCP proxy and the compat routes", () => {
    expect([...WORKLOAD_ROUTES].sort()).toEqual([MCP_PROXY_ROUTE, COMPAT_ANTHROPIC_ROUTE, COMPAT_OPENAI_ROUTE, COMPAT_MODELS_ROUTE].sort());
  });
});

describe("S5 — root exchange (decision 15) and the DPoP nonce", () => {
  it("nonce challenge, then the SAME unused assertion succeeds; the token is bound to the agent's DPoP key and rebuilds act", async () => {
    const a = agents[0]!;
    const bind = wkey();
    const proof = await makeProof(a, { cnf: await jkt(bind) });
    const form = await rootForm(a, proof);
    const first = await token(form, await dpop(bind, { nonce: null }));
    expect(first.statusCode, first.body).toBe(400);
    expect(first.json().error).toBe("use_dpop_nonce");
    const nonce = first.headers["dpop-nonce"] as string;
    expect(nonce).toBe(issueDpopNonce(SECRETS.nonceKey));
    const ok = await token(form, await dpop(bind, { nonce }));
    expect(ok.statusCode, ok.body).toBe(200);
    const body = ok.json();
    expect(body).toMatchObject({ token_type: "DPoP", issued_token_type: AT });
    expect(body.expires_in).toBeLessThanOrEqual(300);
    const c = decodeJwt(body.access_token);
    expect(c).toMatchObject({ iss: ISSUER, aud: resource, client_id: a.clientId, env: ENV, cnf: { jkt: await jkt(bind) }, act: { sub: a.clientId } });
    expect(c.sub).not.toBe(sponsorId); // pairwise, never the user id
    const [it] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, c.jti!));
    expect(it).toMatchObject({ authCredentialId: a.credId, bindingKind: "dpop", bindingThumbprint: await jkt(bind) });
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, c.grant_id as string));
    expect(g).toMatchObject({ sponsorUserId: sponsorId, actorIdentityId: a.id, depth: 0, audience: resource, projectId, environment: ENV });
    // audited, with codes and ids only
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "token-exchange-issued"), eq(auditLog.objectId, g!.id)));
    expect(JSON.stringify(audit!.detail)).not.toContain(body.access_token);
  });

  it("refusals: a reused proof, another agent's proof, a changed scope, a foreign resource, a key other than the proof's, no DPoP", async () => {
    const a = agents[0]!;
    const b = agents[1]!;
    const bind = wkey();
    const proof = await makeProof(a, { cnf: await jkt(bind) });
    expect((await token(await rootForm(a, proof), await dpop(bind))).statusCode).toBe(200);
    const reused = await token(await rootForm(a, proof), await dpop(bind));
    expect([reused.statusCode, reused.json().error]).toEqual([400, "invalid_grant"]);

    const proof2 = await makeProof(a, { cnf: await jkt(bind) });
    const other = await token(await rootForm(b, proof2), await dpop(bind));
    expect([other.statusCode, other.json().error]).toEqual([400, "invalid_grant"]);
    const wider = await token(await rootForm(a, proof2, { scope: scope([T.read, T.write]) }), await dpop(bind));
    expect([wider.statusCode, wider.json().error]).toEqual([400, "invalid_grant"]);
    const foreign = await token(await rootForm(a, proof2, { resource: "https://elsewhere.example/mcp/x" }), await dpop(bind));
    expect([foreign.statusCode, foreign.json().error]).toEqual([400, "invalid_target"]);
    const wrongKey = await token(await rootForm(a, proof2), await dpop(wkey()));
    expect([wrongKey.statusCode, wrongKey.json().error]).toEqual([400, "invalid_grant"]);
    const noDpop = await token(await rootForm(a, proof2), null);
    expect([noDpop.statusCode, noDpop.json().error]).toEqual([400, "invalid_dpop_proof"]);
    // none of those consumed proof2: it still works
    expect((await token(await rootForm(a, proof2), await dpop(bind))).statusCode).toBe(200);
  });

  it("OWNER DECISION 4: the bootstrap token cannot start a delegation; an unknown client is invalid_client", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/delegations/proofs", headers: AUTH, payload: { agentIdentityId: agents[0]!.id, authorizationDetails: scope(), resource, projectId, env: ENV } });
    expect(r.statusCode).toBe(403);
    const ghost = { ...agents[0]!, clientId: SPIFFE("ghost") };
    const bind = wkey();
    const proof = await makeProof(agents[0]!, { cnf: await jkt(bind) });
    const res = await token(await rootForm(ghost, proof), await dpop(bind));
    expect([res.statusCode, res.json().error]).toEqual([401, "invalid_client"]);
  });
});

describe("S5 — private_key_jwt refused before any claim", () => {
  for (const [label, opts] of [
    ["expired (iat 6 minutes ago)", { iat: nowS() - 360, exp: nowS() - 240 }],
    ["wrong audience (the issuer, not the token endpoint)", { aud: ISSUER }],
    ["iss is not sub", { iss: "spiffe://evil.example/x" }],
  ] as const) {
    it(`${label} → invalid_client, and neither the DPoP proof nor the person's proof was claimed`, async () => {
      const a = agents[1]!;
      const bind = wkey();
      const proof = await makeProof(a, { cnf: await jkt(bind) });
      const jti = randomUUID();
      const proofJti = decodeJwt(proof).jti!;
      const r = await token(await rootForm(a, proof, { assertionOpts: opts }), await dpop(bind, { jti }));
      expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
      expect(await claimed("as_dpop", providerKey(a.clientId, jti))).toBe(false);
      expect(await claimed("human_delegation_proof", proofJti)).toBe(false);
      // positive control: the same proof and the same DPoP jti, with a good assertion, now succeed
      const ok = await token(await rootForm(a, proof), await dpop(bind, { jti }));
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await claimed("human_delegation_proof", proofJti)).toBe(true);
    });
  }

  it("a replayed assertion is refused; the same assertion raced on two replicas wins exactly once", async () => {
    const a = agents[1]!;
    const bind = wkey();
    const form = await rootForm(a, await makeProof(a, { cnf: await jkt(bind) }));
    expect((await token(form, await dpop(bind))).statusCode).toBe(200);
    const again = await token({ ...form, subject_token: await makeProof(a, { cnf: await jkt(bind) }) }, await dpop(bind));
    expect([again.statusCode, again.json().error]).toEqual([401, "invalid_client"]);

    const shared = await assertion(a);
    const p1 = await makeProof(a, { cnf: await jkt(bind) });
    const p2 = await makeProof(a, { cnf: await jkt(bind) });
    const [r1, r2] = await Promise.all([
      token({ ...(await rootForm(a, p1)), client_assertion: shared }, await dpop(bind), {}, app),
      token({ ...(await rootForm(a, p2)), client_assertion: shared }, await dpop(bind), {}, app2),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 401]);
  });
});

describe("S5 — DPoP at the token endpoint", () => {
  const cases: Array<[string, (k: WKey) => Promise<string>, string]> = [
    ["stale (61 s)", (k) => dpop(k, { iat: nowS() - 61 }), "invalid_dpop_proof"],
    ["from the future (6 s)", (k) => dpop(k, { iat: nowS() + 6 }), "invalid_dpop_proof"],
    ["wrong htm", (k) => dpop(k, { htm: "GET" }), "invalid_dpop_proof"],
    ["wrong htu", (k) => dpop(k, { htu: `${ISSUER}/oauth/other` }), "invalid_dpop_proof"],
    ["a stale nonce", (k) => dpop(k, { nonce: issueDpopNonce(SECRETS.nonceKey, new Date(Date.now() - 600_000)) }), "use_dpop_nonce"],
  ];
  for (const [label, make, error] of cases) {
    it(`${label} → ${error}`, async () => {
      const a = agents[2]!;
      const bind = wkey();
      const proof = await makeProof(a);
      const r = await token(await rootForm(a, proof), await make(bind));
      expect([r.statusCode, r.json().error]).toEqual([400, error]);
    });
  }

  it("the same DPoP proof raced on two replicas is accepted once", async () => {
    const a = agents[2]!;
    const bind = wkey();
    const proofJwt = await dpop(bind);
    const [r1, r2] = await Promise.all([
      token(await rootForm(a, await makeProof(a)), proofJwt, {}, app),
      token(await rootForm(a, await makeProof(a)), proofJwt, {}, app2),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);
    expect([r1, r2].find((r) => r.statusCode === 400)!.json().error).toBe("invalid_dpop_proof");
  });

  it("the same person's proof raced on two replicas admits exactly one grant", async () => {
    const a = agents[2]!;
    const bind = wkey();
    const proof = await makeProof(a, { cnf: await jkt(bind) });
    const [r1, r2] = await Promise.all([token(await rootForm(a, proof), await dpop(bind), {}, app), token(await rootForm(a, proof), await dpop(bind), {}, app2)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 400]);
  });

  it("X45 I7S5-04: with the process clock 30 s ahead, the replay claims still last the whole signed window", async () => {
    const a = agents[2]!;
    const bind = wkey();
    const assertionJti = randomUUID();
    const dpopJti = randomUUID();
    const iat = nowS();
    const form = await rootForm(a, await makeProof(a, { cnf: await jkt(bind) }), { assertionOpts: { jti: assertionJti, iat, exp: iat + 120 } });
    const proofJwt = await dpop(bind, { jti: dpopJti, iat });
    vi.useFakeTimers({ now: Date.now() + 30_000, toFake: ["Date"] });
    let r;
    try {
      r = await token(form, proofJwt);
    } finally {
      vi.useRealTimers();
    }
    expect(r.statusCode, r.body).toBe(200);
    const claim = async (ns: string, key: string) =>
      (await db.select().from(replayClaims).where(and(eq(replayClaims.namespace, ns as never), eq(replayClaims.key, key))))[0]!;
    const ca = await claim("client_assertion", providerKey(a.clientId, assertionJti));
    expect(ca.expiresAt.getTime()).toBeGreaterThanOrEqual((iat + 120 + 5) * 1000);
    const dp = await claim("as_dpop", providerKey(a.clientId, dpopJti));
    expect(dp.expiresAt.getTime()).toBeGreaterThanOrEqual((iat + 60 + 5) * 1000);
  });

  it("the process clock ±500 ms changes nothing: every window is judged on the database clock", async () => {
    const a = agents[2]!;
    for (const skew of [500, -500]) {
      const bind = wkey();
      const form = await rootForm(a, await makeProof(a, { cnf: await jkt(bind) }));
      const proofJwt = await dpop(bind, { iat: Math.floor((Date.now() + skew) / 1000) });
      vi.useFakeTimers({ now: Date.now() + skew, toFake: ["Date"] });
      try {
        const r = await token(form, proofJwt);
        expect(r.statusCode, `${skew}: ${r.body}`).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});

describe("S5 — child exchange (decision 23)", () => {
  const lastRefusal = async () =>
    (await db.select().from(auditLog).where(eq(auditLog.ruleId, "token-exchange-refused")).orderBy(desc(auditLog.seq)).limit(1))[0]!;

  it("substitutions are refused WITHOUT consuming A's authorization; the intended request is then refused delegation_depth_unenforced, still unconsumed", async () => {
    const A = agents[3]!;
    const B = agents[4]!;
    const C = agents[5]!;
    const parent = await rootToken(A);
    const bBind = wkey();
    const body = childBody();
    const idem = `idem-${randomUUID()}`;
    const actor = await authz(parent, A, B.id, await jkt(bBind), body, idem);
    // a different authenticated child (C) with A's genuine authorization
    const asC = await token(await childForm(C, parent.token, actor, body, idem), await dpop(bBind));
    expect([asC.statusCode, asC.json().error]).toEqual([400, "invalid_grant"]);
    // the right child, but a DPoP key other than child_cnf
    const wrongKey = await token(await childForm(B, parent.token, actor, body, idem), await dpop(wkey()));
    expect([wrongKey.statusCode, wrongKey.json().error]).toEqual([400, "invalid_grant"]);
    // a changed cap / depth / scope
    for (const changed of [childBody({ cap_micros: 5 }), childBody({ max_depth: 1 }), childBody({ authorization_details: scope([T.read, T.write]) as DelegationBody["authorization_details"] })]) {
      const r = await token(await childForm(B, parent.token, actor, { ...changed, expires_at: body.expires_at }, idem), await dpop(bBind));
      expect(r.statusCode, r.body).toBe(400);
    }
    // a stolen parent token presented with a DIFFERENT key's authorization
    const thief = { ...parent, bind: wkey() };
    const stolen = await token(await childForm(B, parent.token, await authz(thief, A, B.id, await jkt(bBind), body, idem), body, idem), await dpop(bBind));
    expect([stolen.statusCode, stolen.json().error]).toEqual([400, "invalid_grant"]);
    // S5 review item 1: the intended request passes every check above and is refused for depth, before any claim,
    // so a second identical attempt is refused the same way (not as a replay) and no child grant exists
    for (let i = 0; i < 2; i++) {
      const r = await token(await childForm(B, parent.token, actor, body, idem), await dpop(bBind));
      expect(r.json(), r.body).toMatchObject({ error: "invalid_grant", error_code: "delegation_depth_unenforced" });
    }
    expect(await db.select().from(delegationGrants).where(eq(delegationGrants.parentGrantId, parent.grantId))).toHaveLength(0);
  });

  it("the reviewer's probe: a person signs max_depth 0, the root exchange succeeds, A authorises child B → refused and audited", async () => {
    const A = agents[3]!;
    const B = agents[4]!;
    const parent = await rootToken(A, { maxDepth: 0 });
    const bBind = wkey();
    const body = childBody({ max_depth: 0 });
    const r = await token(await childForm(B, parent.token, await authz(parent, A, B.id, await jkt(bBind), body, "d1"), body, "d1"), await dpop(bBind));
    expect([r.statusCode, r.json().error, r.json().error_code]).toEqual([400, "invalid_grant", "delegation_depth_unenforced"]);
    const audit = await lastRefusal();
    expect(audit.detail).toMatchObject({ phase: "token-exchange", code: "delegation_depth_unenforced", status: 400 });
    expect(await db.select().from(delegationGrants).where(eq(delegationGrants.parentGrantId, parent.grantId))).toHaveLength(0);
    // and with the org's full depth signed, the same: no external child until the signed depth is enforced (S4)
    const deep = await rootToken(A, { maxDepth: 3 });
    const body3 = childBody({ max_depth: 2 });
    const r3 = await token(await childForm(B, deep.token, await authz(deep, A, B.id, await jkt(bBind), body3, "d3"), body3, "d3"), await dpop(bBind));
    expect(r3.json()).toMatchObject({ error: "invalid_grant", error_code: "delegation_depth_unenforced" });
  });

  it("another resource than the parent's → invalid_target (decided before the depth guard)", async () => {
    const A = agents[3]!;
    const B = agents[4]!;
    const parent = await rootToken(A, { cap: 1000 });
    const bBind = wkey();
    const otherRes = childBody({ cap_micros: 10, resource: `${ISSUER}/v1/chat/completions` });
    const t = await token(await childForm(B, parent.token, await authz(parent, A, B.id, await jkt(bBind), otherRes, "b2"), otherRes, "b2"), await dpop(bBind));
    expect([t.statusCode, t.json().error]).toEqual([400, "invalid_target"]);
  });
});

describe("S5 — revocation and introspection (RFC 7009 / 7662)", () => {
  it("authentication is required; a client sees and revokes only its own tokens", async () => {
    const A = agents[0]!;
    const B = agents[1]!;
    const t = await rootToken(A);
    const intro = async (as: Agent, tok: string) => post(app, "/oauth/token/introspection", { token: tok, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(as) });
    const revoke = async (as: Agent, tok: string) => post(app, "/oauth/token/revocation", { token: tok, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(as) });
    expect((await post(app, "/oauth/token/introspection", { token: t.token })).statusCode).toBe(401);
    expect((await post(app, "/oauth/token/revocation", { token: t.token })).statusCode).toBe(401);
    const mine = await intro(A, t.token);
    expect(mine.json()).toMatchObject({ active: true, client_id: A.clientId, token_type: "DPoP", aud: resource });
    expect((await intro(B, t.token)).json()).toEqual({ active: false });
    expect((await intro(A, "not.a.token")).json()).toEqual({ active: false });
    // B's revocation of A's token: 200, no effect
    expect((await revoke(B, t.token)).statusCode).toBe(200);
    expect((await intro(A, t.token)).json().active).toBe(true);
    // A revokes its own
    expect((await revoke(A, t.token)).statusCode).toBe(200);
    expect((await intro(A, t.token)).json()).toEqual({ active: false });
    // a replayed client assertion is refused here too
    const used = await assertion(A);
    expect((await post(app, "/oauth/token/introspection", { token: t.token, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: used })).statusCode).toBe(200);
    expect((await post(app, "/oauth/token/introspection", { token: t.token, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: used })).statusCode).toBe(401);
  });
});

describe("S5 — delegated tokens at the resource", () => {
  const call = async (t: { token: string; bind: WKey }, o: { url?: string; method?: "POST" | "GET"; scheme?: string; proof?: string; nonce?: string | null } = {}) => {
    const url = o.url ?? `/mcp/${serverId}`;
    const method = o.method ?? "POST";
    const proof = o.proof ?? (await dpop(t.bind, { htm: method, htu: `${ISSUER}${url}`, ath: b64sha(t.token), ...(o.nonce !== undefined ? { nonce: o.nonce } : {}) }));
    return app.inject({ method, url, headers: { authorization: `${o.scheme ?? "DPoP"} ${t.token}`, dpop: proof, "content-type": "application/json" }, ...(method === "POST" ? { payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } } : {}) });
  };

  it("a live token is VERIFIED and then held back until S4 wires the governed paths (403, not 401); any scheme case", async () => {
    const t = await rootToken(agents[0]!);
    for (const scheme of ["DPoP", "dpop", "DPOP"]) {
      const r = await call(t, { scheme });
      expect([r.statusCode, r.json().error], r.body).toEqual([403, "delegated_route_not_wired"]);
    }
  });

  it("refused 401 when the chain is not live, the proof is replayed, stale, nonce-less, or for another URL", async () => {
    const t = await rootToken(agents[0]!);
    const proof = await dpop(t.bind, { htm: "POST", htu: resource, ath: b64sha(t.token) });
    expect((await call(t, { proof })).statusCode).toBe(403);
    expect((await call(t, { proof })).json()).toMatchObject({ error: "invalid_dpop_proof", code: "dpop_proof_replayed" });
    const noNonce = await call(t, { nonce: null });
    expect(noNonce.statusCode).toBe(401);
    expect(noNonce.headers["dpop-nonce"]).toBe(issueDpopNonce(SECRETS.nonceKey));
    expect((await call(t, { proof: await dpop(t.bind, { htm: "POST", htu: resource, ath: b64sha(t.token), iat: nowS() - 61 }) })).statusCode).toBe(401);
    expect((await call(t, { proof: await dpop(t.bind, { htm: "POST", htu: `${ISSUER}/mcp/${randomUUID()}`, ath: b64sha(t.token) }) })).statusCode).toBe(401);
    // revoke the root: the very next call is refused (no cache)
    await db.execute(sql`update delegation_grants set revoked_at = now(), revoked_reason = 'admin' where id = ${t.grantId}`);
    const dead = await call(t);
    expect([dead.statusCode, dead.json().code]).toEqual([401, "chain_grant_revoked"]);
  });

  it("the same resource DPoP proof raced on two replicas passes once", async () => {
    const t = await rootToken(agents[0]!);
    const proof = await dpop(t.bind, { htm: "POST", htu: resource, ath: b64sha(t.token) });
    const req = (on: ReturnType<typeof buildApp>) =>
      on.inject({ method: "POST", url: `/mcp/${serverId}`, headers: { authorization: `DPoP ${t.token}`, dpop: proof, "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const [r1, r2] = await Promise.all([req(app), req(app2)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([401, 403]);
  });

  it("the compat routes take a token for THEIR resource only; any other route refuses a workload token", async () => {
    const a = agents[2]!;
    const bind = wkey();
    const compat = `${ISSUER}/v1/chat/completions`;
    const r = await token(await rootForm(a, await makeProof(a, { cnf: await jkt(bind), resource: compat }), { resource: compat }), await dpop(bind));
    expect(r.statusCode, r.body).toBe(200);
    const t = { token: r.json().access_token as string, bind };
    expect((await call(t, { url: "/v1/chat/completions" })).json().error).toBe("delegated_route_not_wired");
    // the MCP route is another audience
    expect((await call(t)).statusCode).toBe(401);
    // a route outside the allow-list
    expect((await call(t, { url: "/v1/me", method: "GET" })).json().error).toBe("workload_scope");
  });

  it("an ordinary API key still authenticates exactly as before (and with a lower-case scheme)", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: sponsorAuth.authorization.replace("Bearer", "bearer") } });
    expect([me.statusCode, me.json().userId]).toEqual([200, sponsorId]);
  });

  it("negative control: the bare library accepts a 120 s old, nonce-less proof that our wrapper refuses", async () => {
    const t = await rootToken(agents[0]!);
    const old = await dpop(t.bind, { htm: "POST", htu: resource, ath: b64sha(t.token), iat: nowS() - 120, nonce: null });
    const keys = (await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).json();
    const claims = await oauth.validateJwtAccessToken(
      { issuer: ISSUER, jwks_uri: "https://local.invalid/jwks" },
      new Request(resource, { method: "POST", headers: { authorization: `DPoP ${t.token}`, dpop: old } }),
      resource,
      { requireDPoP: true, [oauth.customFetch]: async () => new Response(JSON.stringify(keys), { headers: { "content-type": "application/json" } }) },
    );
    expect(claims.grant_id).toBe(t.grantId);
    expect((await call(t, { proof: old })).statusCode).toBe(401);
  });
});

describe("S5 — mTLS and SPIFFE (decision 21)", () => {
  const fwd = (der: Buffer, secret = PROXY_SECRET) => ({ "x-s5-client-cert": der.toString("base64"), "x-regulait-proxy-auth": secret });
  let mtlsAgent: Agent;
  let mtlsLeaf: TestCert;
  let svidAgent: Agent;

  beforeAll(async () => {
    mtlsAgent = await newAgent("mtls", { jwk: false });
    mtlsLeaf = await makeCert({ issuer: root, uris: [mtlsAgent.clientId] });
    await db.execute(sql`insert into workload_credentials (identity_id, kind, x5t_s256, not_after) values (${mtlsAgent.id}, 'x509', ${b64sha2(mtlsLeaf.der)}, now() + interval '30 days')`);
    svidAgent = await newAgent("svid", { jwk: false });
    await db.execute(sql`insert into workload_credentials (identity_id, kind, spiffe_id, not_after) values (${svidAgent.id}, 'spiffe_id', ${svidAgent.clientId}, now() + interval '30 days')`);
  });
  const b64sha2 = (d: Buffer) => createHash("sha256").update(d).digest("base64url");
  const mtlsForm = (a: Agent, proof: string): Form => ({
    grant_type: EXCHANGE,
    subject_token: proof,
    subject_token_type: "urn:regulait:params:oauth:token-type:delegation-proof",
    requested_token_type: AT,
    resource,
    authorization_details: JSON.stringify(scope()),
    client_id: a.clientId,
  });

  it("tls_client_auth through an authenticated proxy: a certificate-bound token, accepted at the resource only with that certificate", async () => {
    const r = await token(mtlsForm(mtlsAgent, await makeProof(mtlsAgent)), null, fwd(mtlsLeaf.der));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().token_type).toBe("Bearer");
    const t = r.json().access_token as string;
    expect(decodeJwt(t).cnf).toEqual({ "x5t#S256": b64sha2(mtlsLeaf.der) });
    const at = (headers: Record<string, string>) => app.inject({ method: "POST", url: `/mcp/${serverId}`, headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...headers }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect((await at(fwd(mtlsLeaf.der))).json().error).toBe("delegated_route_not_wired");
    expect((await at({})).json()).toMatchObject({ error: "invalid_token", code: "client_certificate_required" });
    // forged header: the right certificate, but the proxy did not authenticate (wrong secret) → stripped → no certificate
    expect((await at(fwd(mtlsLeaf.der, "x".repeat(48)))).json().code).toBe("client_certificate_required");
    // from an untrusted peer
    const untrusted = await app.inject({ method: "POST", url: `/mcp/${serverId}`, remoteAddress: "10.1.2.3", headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...fwd(mtlsLeaf.der) }, payload: {} });
    expect(untrusted.json().code).toBe("client_certificate_required");
  });

  it("a certificate from the wrong trust root, or expired, does not authenticate the client EVEN WHEN its thumbprint is registered", async () => {
    // both are registered credentials of the client, so only path validation can refuse them
    const wrongRoot = await makeCert({ issuer: otherRoot, uris: [mtlsAgent.clientId] });
    const expired = await makeCert({ issuer: root, uris: [mtlsAgent.clientId], notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    for (const c of [wrongRoot, expired]) {
      await db.execute(sql`insert into workload_credentials (identity_id, kind, x5t_s256, not_after) values (${mtlsAgent.id}, 'x509', ${b64sha2(c.der)}, now() + interval '30 days')`);
    }
    const r1 = await token(mtlsForm(mtlsAgent, await makeProof(mtlsAgent)), null, fwd(wrongRoot.der));
    expect([r1.statusCode, r1.json().error]).toEqual([401, "invalid_client"]);
    const r2 = await token(mtlsForm(mtlsAgent, await makeProof(mtlsAgent)), null, fwd(expired.der));
    expect([r2.statusCode, r2.json().error]).toEqual([401, "invalid_client"]);
  });

  it("a genuine certificate from the trusted CA that is NOT the registered one does not authenticate the client", async () => {
    const sibling = await makeCert({ issuer: root, uris: [mtlsAgent.clientId] });
    const r = await token(mtlsForm(mtlsAgent, await makeProof(mtlsAgent)), null, fwd(sibling.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
  });

  it("SPIFFE X.509-SVID: the registered ID authenticates; another ID in the same domain does not", async () => {
    const svid = await makeCert({ issuer: root, uris: [svidAgent.clientId] });
    const ok = await token(mtlsForm(svidAgent, await makeProof(svidAgent)), null, fwd(svid.der));
    expect(ok.statusCode, ok.body).toBe(200);
    const wrongId = await makeCert({ issuer: root, uris: [SPIFFE("someone-else")] });
    const bad = await token(mtlsForm(svidAgent, await makeProof(svidAgent)), null, fwd(wrongId.der));
    expect([bad.statusCode, bad.json().error]).toEqual([401, "invalid_client"]);
  });

  it("an mTLS-bound parent cannot hand off across processes (mtls_parent_handoff_unsupported)", async () => {
    const r = await token(mtlsForm(mtlsAgent, await makeProof(mtlsAgent)), null, fwd(mtlsLeaf.der));
    const parentToken = r.json().access_token as string;
    const B = agents[4]!;
    const bBind = wkey();
    const body = childBody();
    // A has no DPoP key; any authorization is refused before its signature is even looked at
    const fake = { token: parentToken, bind: wkey(), grantId: decodeJwt(parentToken).grant_id as string };
    const c = await token(await childForm(B, parentToken, await authz(fake, mtlsAgent, B.id, await jkt(bBind), body, "m1"), body, "m1"), await dpop(bBind));
    expect(c.json()).toMatchObject({ error: "invalid_grant", error_code: "mtls_parent_handoff_unsupported" });
  });
});

describe("S5 review item 2 — only a steward with project access may start a delegation", () => {
  const lastProofRefusal = async () =>
    (await db.select().from(auditLog).where(eq(auditLog.ruleId, "delegation-proof-refused")).orderBy(desc(auditLog.seq)).limit(1))[0]!;

  it("a project with NO members is not open for delegation (unlike ADR-0011 attribution); an explicit member is allowed", async () => {
    const open = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`s5-memberless-${RUN}`}) returning id`))[0]!.id;
    const a = agents[0]!;
    const refused = await proofRequest(a, { project: open });
    expect([refused.statusCode, refused.json().error]).toEqual([403, "delegation_project_access"]);
    expect((await lastProofRefusal()).detail).toMatchObject({ code: "delegation_project_access", projectId: open });
    await db.execute(sql`insert into project_members (project_id, user_id, role) values (${open}, ${sponsorId}, 'viewer')`);
    expect((await proofRequest(a, { project: open })).statusCode).toBe(201);
  });

  it("a person who is not a steward of the agent is refused, audited", async () => {
    const other = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `s5-other-${RUN}@example.com`, displayName: `s5 other ${RUN}` } });
    expect(other.statusCode, other.body).toBe(201);
    const foreign = await newAgent("not-mine", { sponsors: [other.json().id] });
    const r = await proofRequest(foreign);
    expect([r.statusCode, r.json().error]).toEqual([403, "delegation_not_steward"]);
    expect((await lastProofRefusal()).detail).toMatchObject({ code: "delegation_not_steward", agentIdentityId: foreign.id });
  });

  it("a steward without access to the project is refused; the same steward, once a member, is allowed", async () => {
    const owner = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `s5-owner-${RUN}@example.com`, displayName: `s5 owner ${RUN}` } });
    const closed = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`s5-closed-${RUN}`}) returning id`))[0]!.id;
    await db.execute(sql`insert into project_members (project_id, user_id, role) values (${closed}, ${owner.json().id}, 'owner')`);
    const a = agents[0]!;
    const refused = await proofRequest(a, { project: closed });
    expect([refused.statusCode, refused.json().error]).toEqual([403, "delegation_project_access"]);
    expect((await lastProofRefusal()).detail).toMatchObject({ code: "delegation_project_access", projectId: closed });
    await db.execute(sql`insert into project_members (project_id, user_id, role) values (${closed}, ${sponsorId}, 'contributor')`);
    const ok = await proofRequest(a, { project: closed });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("a steward removed after the proof was issued cannot exchange it", async () => {
    const a = await newAgent("steward-removed");
    const bind = wkey();
    const proof = await makeProof(a, { cnf: await jkt(bind) });
    await db.execute(sql`update workload_identities set sponsor_user_ids = ${`{${(await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `s5-heir-${RUN}@example.com`, displayName: `s5 heir ${RUN}` } })).json().id}}`}::uuid[] where id = ${a.id}`);
    const r = await token(await rootForm(a, proof), await dpop(bind));
    expect([r.statusCode, r.json().error]).toEqual([400, "invalid_grant"]);
  });
});

describe("S5 review item 6 — strict root grants: a cap is required, 15 minutes by default (ADR-0180)", () => {
  type RootSettings = Pick<typeof orgSettings.$inferSelect, "delegationUncappedRootAllowed" | "delegationRootDefaultCapMicros" | "delegationRootMaxLifetimeSeconds">;
  /** set the three settings directly for one test and put them back (their audited relaxation is the S1 suite's) */
  async function withRootSettings(v: Partial<RootSettings>, fn: () => Promise<void>) {
    const [before] = await db
      .select({ a: orgSettings.delegationUncappedRootAllowed, c: orgSettings.delegationRootDefaultCapMicros, l: orgSettings.delegationRootMaxLifetimeSeconds })
      .from(orgSettings);
    await db.update(orgSettings).set(v);
    try {
      await fn();
    } finally {
      await db.update(orgSettings).set({ delegationUncappedRootAllowed: before!.a, delegationRootDefaultCapMicros: before!.c, delegationRootMaxLifetimeSeconds: before!.l });
    }
  }

  it("the strict defaults: no cap → refused delegation_cap_required (audited); no lifetime → 900 s; longer → refused delegation_lifetime", async () => {
    const a = agents[0]!;
    const noCap = await proofRequest(a, { cap: null });
    expect([noCap.statusCode, noCap.json().error]).toEqual([400, "delegation_cap_required"]);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "delegation-proof-refused")).orderBy(desc(auditLog.seq)).limit(1);
    expect(audit!.detail).toMatchObject({ code: "delegation_cap_required" });
    const dflt = await proofRequest(a);
    expect(dflt.statusCode, dflt.body).toBe(201);
    const p = decodeJwt(dflt.json().proof);
    expect(dflt.json().delegation.expires_at - (p.iat as number)).toBe(900);
    const long = await proofRequest(a, { lifetime: 3600 });
    expect([long.statusCode, long.json().error]).toEqual([400, "delegation_lifetime"]);
    expect((await proofRequest(a, { lifetime: 900 })).statusCode).toBe(201);
  });

  it("relaxed: a default cap fills in; uncapped roots allowed; a longer limit admits a longer lifetime", async () => {
    const a = agents[0]!;
    await withRootSettings({ delegationRootDefaultCapMicros: 4242 }, async () => {
      const r = await proofRequest(a, { cap: null });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().delegation.cap_micros).toBe(4242);
    });
    await withRootSettings({ delegationUncappedRootAllowed: true, delegationRootMaxLifetimeSeconds: 7200 }, async () => {
      const r = await proofRequest(a, { cap: null, lifetime: 3600 });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().delegation.cap_micros).toBeNull();
    });
  });

  it("the root exchange re-judges against the CURRENT settings: an uncapped or long proof issued while relaxed is refused once tightened", async () => {
    const a = agents[1]!;
    const bind = wkey();
    let uncapped = "";
    let long = "";
    await withRootSettings({ delegationUncappedRootAllowed: true, delegationRootMaxLifetimeSeconds: 7200 }, async () => {
      uncapped = await makeProof(a, { cnf: await jkt(bind), cap: null });
      long = await makeProof(a, { cnf: await jkt(bind), lifetime: 3600 });
    });
    const r1 = await token(await rootForm(a, uncapped), await dpop(bind));
    expect(r1.json()).toMatchObject({ error: "invalid_grant", error_code: "delegation_cap_required" });
    const r2 = await token(await rootForm(a, long), await dpop(bind));
    expect(r2.json()).toMatchObject({ error: "invalid_grant", error_code: "delegation_lifetime" });
  });
});

describe("S5 review item 5 — a timed-out exchange leaves no live grant", () => {
  it("the timeout fires while the grant is being made: the grant is revoked in its own transaction and the audit row names it", async () => {
    const a = agents[2]!;
    const bind = wkey();
    const form = await rootForm(a, await makeProof(a, { cnf: await jkt(bind) }));
    const before = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from delegation_grants where actor_identity_id = ${a.id}`))[0]!.n;
    const restore = setTokenRequestTimeoutForTest(150);
    tokenEndpointTestHooks.beforeGrantCommit = () => new Promise((r) => setTimeout(r, 600));
    try {
      await token(form, await dpop(bind)).catch(() => null);
    } finally {
      delete tokenEndpointTestHooks.beforeGrantCommit;
      restore();
    }
    // the request's audit row is written once the handler has settled
    let audit: typeof auditLog.$inferSelect | undefined;
    for (let i = 0; i < 50 && !audit; i++) {
      [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "token-exchange-refused"), sql`${auditLog.detail}->>'code' = 'timeout_grant_revoked'`, sql`${auditLog.detail}->>'clientId' = ${a.clientId}`))
        .limit(1);
      if (!audit) await new Promise((r) => setTimeout(r, 100));
    }
    expect(audit, "the timed-out request's audit row").toBeDefined();
    expect(audit!.detail).toMatchObject({ status: 499, grantRevokedReason: "request_aborted" });
    const grantId = (audit!.detail as { grantId: string }).grantId;
    expect(audit!.objectId).toBe(grantId);
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grantId));
    expect(g).toMatchObject({ actorIdentityId: a.id, revokedReason: "request_aborted" });
    expect(g!.revokedAt).not.toBeNull();
    // exactly one grant was made for the request, and it is that revoked one: nothing live was left behind
    const total = rows<{ n: number }>(await db.execute(sql`select count(*)::int as n from delegation_grants where actor_identity_id = ${a.id}`))[0]!.n;
    expect(total).toBe(before + 1);
  });
});

describe("S5 review item 7 — introspection reads aud as one string", () => {
  it("a client assertion whose aud is an array containing the token endpoint is refused (as at the token endpoint)", async () => {
    const A = agents[0]!;
    const t = await rootToken(A);
    const form = async (aud: string | string[]) => ({ token: t.token, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await assertion(A, { aud }) });
    expect((await post(app, "/oauth/token/introspection", await form([TOKEN, "https://elsewhere.example/"]))).statusCode).toBe(401);
    expect((await post(app, "/oauth/token/introspection", await form([TOKEN]))).statusCode).toBe(401);
    // positive control
    const ok = await post(app, "/oauth/token/introspection", await form(TOKEN));
    expect(ok.json()).toMatchObject({ active: true, aud: resource });
    // the token endpoint refuses the same array-aud assertion
    const bind = wkey();
    const proof = await makeProof(A, { cnf: await jkt(bind) });
    const r = await token(await rootForm(A, proof, { assertionOpts: { aud: [TOKEN] } }), await dpop(bind));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
  });
});

describe("S5 — delegation grant admin backend", () => {
  it("list (by root, with edges), detail, and a cascade revoke that needs the identity_manage step-up", async () => {
    const A = agents[3]!;
    const B = agents[4]!;
    const parent = await rootToken(A, { cap: 10_000 });
    const bBind = wkey();
    // external child exchanges are refused until S4 (review item 1), so the child is admitted in-process (decision 6)
    const body = childBody({ cap_micros: 100 });
    const admitted = await admitChildGrant(db, {
      parentGrantId: parent.grantId,
      idempotencyKey: "g1",
      actorIdentityId: B.id,
      scope: body.authorization_details,
      capMicros: 100,
      expiresAt: new Date(body.expires_at * 1000),
      maxFurtherDepth: 0,
      environment: ENV,
      projectId,
      binding: { kind: "in_process" },
    });
    const childId = admitted.grant.id;
    const list = await app.inject({ method: "GET", url: `/v1/delegation-grants?rootGrantId=${parent.grantId}`, headers: adminAuth });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((g: { id: string }) => g.id).sort()).toEqual([parent.grantId, childId].sort());
    expect(list.json().edges).toEqual([expect.objectContaining({ parentGrantId: parent.grantId, childGrantId: childId, amountMicros: 100 })]);
    expect(JSON.stringify(list.json())).not.toContain(await jkt(bBind));
    const detail = await app.inject({ method: "GET", url: `/v1/delegation-grants/${parent.grantId}`, headers: adminAuth });
    expect(detail.json().childAllocations).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/v1/delegation-grants`, headers: sponsorAuth })).statusCode).toBe(403);
    // the strict step-up refuses an API key
    const refused = await app.inject({ method: "POST", url: `/v1/delegation-grants/${parent.grantId}/revoke`, headers: adminAuth, payload: {} });
    expect(refused.statusCode).toBe(403);
    const restore = await relaxStepUpForTest(db);
    try {
      const ok = await app.inject({ method: "POST", url: `/v1/delegation-grants/${parent.grantId}/revoke`, headers: adminAuth, payload: {} });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().revokedGrantIds.sort()).toEqual([parent.grantId, childId].sort());
    } finally {
      await restore();
    }
  });
});
