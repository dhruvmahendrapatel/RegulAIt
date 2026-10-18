/**
 * ADR-0188 S9 follow-ups — THE SPIFFE BUNDLE ENDPOINT FETCH and JWT-SVID CLIENT
 * AUTHENTICATION, on a real database, through the real app (`buildApp`):
 *
 *  - THE ENDPOINT ROUTE (`oauth/spiffe-bundle-endpoint.ts`): admin-only; an
 *    admin API key cannot step up; a bad URL and an `https_spiffe` endpoint in
 *    a domain with no bundle are refused before any step-up, audited.
 *  - THE FETCH, from a loopback `https_spiffe` endpoint through the egress
 *    guard (an allow-list entry for this run's synthetic host): the first
 *    fetch writes the bundle (`source = 'fetch'`, its sequence and JWT
 *    authorities), audited; an unchanged fetch writes nothing; a FAILED fetch
 *    (a 500, a body that does not parse, a sequence that goes backwards)
 *    keeps the last good bundle, is recorded and audited; the trust window
 *    lapses (fail closed) and a good fetch restores it; ROTATION writes a new
 *    bundle and supersedes the old; the scheduler pass claims a due endpoint;
 *    a REVOCATION disables the endpoint and a fetch cannot undo it; an admin's
 *    UPLOAD after the endpoint was set is not superseded by a fetch until the
 *    endpoint is set again; DISABLING the endpoint ends trust in its fetched
 *    bundle at once.
 *  - JWT-SVID AT THE TOKEN ENDPOINT: off by default (`method_not_allowed`);
 *    once allowed, a valid SVID + DPoP gives a DPoP-bound token authenticated
 *    by the `spiffe_id` credential; the SVID is single-use; no DPoP is refused
 *    without burning the SVID; each refusal with its recorded code (wrong trust
 *    domain, aud missing or mismatched, expired, unknown kid, alg none,
 *    another workload's SPIFFE ID); a JWT-key rotation; revoking the bundle
 *    revokes the JWT-SVID token too.
 *
 * Global state (M-040, M-068): the org's auth methods are put back in
 * afterAll, and the egress allow entry is removed through the M-068 helper. Bundles, endpoints and identities are this
 * run's own (unique trust domains).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, randomUUID, X509Certificate, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { base64url, calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  identitySigningKeys,
  issuedTokens,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  spiffeBundleEndpoints,
  spiffeTrustBundles,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { CLIENT_ASSERTION_TYPE_JWT_SPIFFE, IDENTITY_SIGNING_KEY_ENV } from "@regulait/shared";
import { buildApp } from "./app.js";
import { deriveIdentitySecrets, issueDpopNonce } from "./delegated-token.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { refreshSpiffeBundleEndpoint, runSpiffeBundleRefreshSweep, spiffeBundleFetchTestHooks } from "./oauth/spiffe-bundle-endpoint.js";
import { loadSpiffeTrustAnchors } from "./oauth/spiffe-trust-domains.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { bundleEndpointServer, type BundleEndpointFixture } from "./testing/spiffe-endpoint-fixture.js";
import { makeCert, type TestCert } from "./testing/x509-fixtures.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s9b-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ISSUER = "http://127.0.0.1:4421";
const TOKEN = `${ISSUER}/oauth/token`;
const DATA_KEY = "s9b-synthetic-data-key-".padEnd(64, "q");
const SECRETS = deriveIdentitySecrets(DATA_KEY);
// this run's own trust domains (bundles are never deleted) and the synthetic endpoint host
const FTD = `s9f-${RUN}.example.org`;
const TD = `s9j-${RUN}.example.org`;
const TD2 = `s9k-${RUN}.example.org`;
const HOST = `bundle-${RUN}.s9b.example.test`;
const ENDPOINT_ID = `spiffe://${FTD}/spire/server`;
const T_READ = `s9b_read_${RUN}`;
const EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const AT = "urn:ietf:params:oauth:token-type:access_token";
const BUNDLES = "/v1/identity/spiffe-trust-bundles";
const ENDPOINTS = "/v1/identity/spiffe-bundle-endpoints";
const FIVE_METHODS = ["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid", "spiffe_jwt_svid"];

process.env.REGULAIT_PUBLIC_URL = ISSUER;
const ENV = deploymentEnvironment();

let db: Db;
let app: ReturnType<typeof buildApp>;
let sponsorId: string;
let sponsorAuth: { authorization: string };
let serverId: string;
let resource: string;
let projectId: string;
let keyDir: string;
let methodsBefore: unknown;
let allowHostId: string | undefined;
const restores: Array<() => Promise<void>> = [];

let fca: TestCert;
let fca2: TestCert;
let serverSvid: TestCert;
let endpoint: BundleEndpointFixture;
let tdca: TestCert;
let jwtKey: { privateKey: CryptoKey; jwk: Record<string, string> };
let jwtKey2: { privateKey: CryptoKey; jwk: Record<string, string> };

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
type Method = "GET" | "POST" | "PUT";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const nowS = () => Math.floor(Date.now() / 1000);

const x509Key = async (c: TestCert) => ({ use: "x509-svid", ...(await exportJWK(new X509Certificate(c.der).publicKey)), x5c: [c.der.toString("base64")] });
const jwtJwk = (k: { jwk: Record<string, string> }) => ({ use: "jwt-svid", ...k.jwk });
const bundleDoc = async (cas: TestCert[], jwt: Array<{ jwk: Record<string, string> }>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ keys: [...(await Promise.all(cas.map(x509Key))), ...jwt.map(jwtJwk)], ...extra });

const activeBundle = async (td: string) =>
  (await db.select().from(spiffeTrustBundles).where(and(eq(spiffeTrustBundles.trustDomain, td), sql`superseded_at is null and revoked_at is null`)))[0];
const endpointRow = async () => (await db.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, FTD)))[0]!;
const bundleCount = async (td: string) => (await db.select({ id: spiffeTrustBundles.id }).from(spiffeTrustBundles).where(eq(spiffeTrustBundles.trustDomain, td))).length;
const endpointBody = (over: Record<string, unknown> = {}) => ({ url: `https://${HOST}:${endpoint.port}/bundle`, profile: "https_spiffe", endpointSpiffeId: ENDPOINT_ID, enabled: true, ...over });
const auditRows = async (ruleId: string, td: string) =>
  db
    .select({ detail: auditLog.detail, effect: auditLog.effect })
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), sql`${auditLog.detail} ->> 'trustDomain' = ${td}`))
    .orderBy(desc(auditLog.seq));

// --- JWT-SVID workloads ------------------------------------------------------

interface SvidAgent {
  identityId: string;
  clientId: string;
  credentialId: string;
}

/** an agent identity whose identifier is its SPIFFE ID, with one `spiffe_id` credential (inserted directly) */
async function svidAgent(td: string, name: string): Promise<SvidAgent> {
  const a = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s9b-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  const clientId = `spiffe://${td}/s9b/${name}-${RUN}`;
  const identityId = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, agent_id, identifier, sponsor_user_ids, environments)
      values ('agent', ${a}, ${clientId}, ${`{${sponsorId}}`}::uuid[], ARRAY[${ENV}]) returning id`),
  )[0]!.id;
  await db.execute(sql`insert into identity_tool_grants (identity_id, server_id, tool_name) values (${identityId}, ${serverId}, ${T_READ})`);
  const credentialId = rows<{ id: string }>(
    await db.execute(sql`insert into workload_credentials (identity_id, kind, spiffe_id, not_after) values (${identityId}, 'spiffe_id', ${clientId}, now() + interval '30 days') returning id`),
  )[0]!.id;
  return { identityId, clientId, credentialId };
}

const scope = () => [{ type: "mcp_tool", serverId, toolNames: [T_READ], kind: "read" }];

async function proof(a: SvidAgent): Promise<string> {
  const r = await inject("POST", "/v1/delegations/proofs", sponsorAuth, { agentIdentityId: a.identityId, authorizationDetails: scope(), resource, projectId, env: ENV, capMicros: 1_000_000 });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().proof as string;
}

/** a JWT-SVID for `sub`: claims merged over valid defaults (an `undefined` value removes the claim) */
async function jwtSvid(sub: string, o: { key?: { privateKey: CryptoKey; jwk: Record<string, string> }; claims?: Record<string, unknown>; header?: Record<string, unknown> } = {}) {
  const key = o.key ?? jwtKey;
  const claims: Record<string, unknown> = { sub, aud: [ISSUER], exp: nowS() + 120, iat: nowS(), jti: randomUUID(), ...(o.claims ?? {}) };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: key.jwk.kid!, ...(o.header ?? {}) } as never).sign(key.privateKey);
}

interface DKey {
  privateKey: KeyObject;
  jwk: JWK;
}
function dkey(): DKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const j = publicKey.export({ format: "jwk" }) as JWK;
  return { privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: j.x! } };
}
const dpop = (k: DKey) =>
  new SignJWT({ htm: "POST", htu: TOKEN, iat: nowS(), jti: randomUUID(), nonce: issueDpopNonce(SECRETS.nonceKey) })
    .setProtectedHeader({ alg: "EdDSA", typ: "dpop+jwt", jwk: k.jwk })
    .sign(k.privateKey);

/** the root exchange, authenticated by a JWT-SVID (`jwt-spiffe`) */
const jwtTokenRequest = async (a: SvidAgent, assertion: string, dpopProof: string | null) =>
  app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(dpopProof ? { dpop: dpopProof } : {}) },
    payload: new URLSearchParams({
      grant_type: EXCHANGE,
      subject_token: await proof(a),
      subject_token_type: "urn:regulait:params:oauth:token-type:delegation-proof",
      requested_token_type: AT,
      resource,
      authorization_details: JSON.stringify(scope()),
      client_id: a.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_SPIFFE,
      client_assertion: assertion,
    }).toString(),
  });

const lastTokenCode = async (clientId: string) => {
  const [row] = await db
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "token-exchange-refused"), sql`${auditLog.detail} ->> 'clientId' = ${clientId}`))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return (row?.detail as { code?: string } | undefined)?.code;
};

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `s9b-${label}-${RUN}@example.com`, displayName: `s9b ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

beforeAll(async () => {
  fca = await makeCert({ isCA: true, name: `s9b-fetch-root-${RUN}` });
  fca2 = await makeCert({ isCA: true, name: `s9b-fetch-root2-${RUN}` });
  serverSvid = await makeCert({ issuer: fca, uris: [ENDPOINT_ID] });
  tdca = await makeCert({ isCA: true, name: `s9b-jwt-root-${RUN}` });
  const ec = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    return { privateKey, jwk: { ...((await exportJWK(publicKey)) as Record<string, string>), kid } };
  };
  jwtKey = await ec(`k1-${RUN}`);
  jwtKey2 = await ec(`k2-${RUN}`);
  endpoint = await bundleEndpointServer(serverSvid);

  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // the egress guard: this run's synthetic host, allowed into loopback, resolved to the fixture (removed in afterAll
  // through the M-068 helper)
  const egress = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: HOST, allowPrivateRanges: true, allowPlaintextHttp: false, note: "s9b suite: synthetic SPIFFE bundle endpoint" },
    }),
  );
  expect(egress.statusCode, egress.body).toBe(201);
  allowHostId = egress.json().id;
  spiffeBundleFetchTestHooks.deps = { resolve: async () => [{ address: "127.0.0.1", family: 4 }] };
  restores.push(async () => {
    spiffeBundleFetchTestHooks.deps = undefined;
  });
  // the org's auth methods are read now and put back exactly (org-global, M-040)
  methodsBefore = (await db.select({ m: orgSettings.workloadClientAuthMethods }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID)))[0]?.m;
  restores.push(async () => {
    await db.update(orgSettings).set({ workloadClientAuthMethods: methodsBefore as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s9b-issuer-"));
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem, { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  const k0 = (await configuredIdentitySigningKeys())[0]!;
  const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys);
  const [active] = await db.select().from(identitySigningKeys).where(sql`activated_at is not null and retired_at is null and revoked_at is null`);
  if (recorded.length > 0 && active?.kid !== k0.kid) await rotateIdentitySigningKey(db, { kid: k0.kid, actorUserId: "00000000-0000-0000-0000-000000000000" });

  const sponsor = await mkUser("sponsor");
  sponsorId = sponsor.id;
  sponsorAuth = sponsor.key;
  const s = await inject("POST", "/v1/servers", AUTH, { name: `s9b-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  resource = `${ISSUER}/mcp/${serverId}`;
  expect((await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name: T_READ, kind: "read" })).statusCode).toBe(201);
  expect((await inject("POST", "/v1/grants/tools", AUTH, { userId: sponsorId, serverId, toolName: T_READ })).statusCode).toBe(201);
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`s9b-proj-${RUN}`}) returning id`))[0]!.id;
  await db.execute(sql`insert into project_members (project_id, user_id, role) values (${projectId}, ${sponsorId}, 'contributor')`);
}, 120_000);

afterAll(async () => {
  // M-068: the allow entry this file created goes first, while the app is open; asserted after every other restore
  const allow = await removeEgressAllowEntry(app, AUTH, { id: allowHostId });
  try {
    await db?.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
    for (const r of restores.reverse()) await r();
    await endpoint?.close();
    await app?.close();
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
    delete process.env[IDENTITY_SIGNING_KEY_ENV];
  } finally {
    allow.assertRemoved();
  }
});

// ---------------------------------------------------------------------------
describe("S9 follow-up — the bundle endpoint route", () => {
  it("admin-only; an admin API key cannot step up; nothing is stored", async () => {
    const member = await mkUser("member");
    expect((await inject("GET", ENDPOINTS, member.key)).statusCode).toBe(403);
    const admin = await mkUser("api-admin", true);
    const r = await inject("PUT", `${ENDPOINTS}/${FTD}`, admin.key, endpointBody({ profile: "https_web", endpointSpiffeId: null }));
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required" });
    expect((await db.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, FTD))).length).toBe(0);
  });

  it("refused before any step-up, and audited: a non-https URL, userinfo, an https_spiffe endpoint whose domain has no bundle", async () => {
    const bad = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody({ url: `http://${HOST}/bundle` }));
    expect([bad.statusCode, bad.json().error]).toEqual([422, "spiffe_endpoint_url_invalid"]);
    const user = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody({ url: `https://u:p@${HOST}/bundle` }));
    expect([user.statusCode, user.json().error]).toEqual([422, "spiffe_endpoint_url_invalid"]);
    // nothing of FTD is trusted yet, so its endpoint server cannot be authenticated: bootstrap by upload first
    const noBundle = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody());
    expect([noBundle.statusCode, noBundle.json().error]).toEqual([422, "spiffe_endpoint_trust_domain_unknown"]);
    const malformed = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody({ profile: "https_web" }));
    expect(malformed.statusCode).toBe(400);
    const denies = await auditRows("spiffe-bundle-endpoint-refused", FTD);
    expect(denies.map((d) => (d.detail as { code: string }).code)).toEqual(
      expect.arrayContaining(["spiffe_endpoint_url_invalid", "spiffe_endpoint_trust_domain_unknown", "request_invalid"]),
    );
    expect((await db.select().from(spiffeBundleEndpoints).where(eq(spiffeBundleEndpoints.trustDomain, FTD))).length).toBe(0);
  });
});

describe("S9 follow-up — fetching a domain's bundle", () => {
  it("bootstrap by upload, then setting the endpoint fetches at once: the fetched bundle is active, audited, with its sequence and JWT authority", async () => {
    const up = await inject("POST", BUNDLES, AUTH, { trustDomain: FTD, bundle: fca.pem, replacesBundleId: null });
    expect(up.statusCode, up.body).toBe(201);
    endpoint.set(await bundleDoc([fca], [jwtKey], { spiffe_sequence: 1, spiffe_refresh_hint: 600 }));
    const r = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().refresh).toMatchObject({ outcome: "changed", sequence: 1 });
    expect(r.json().endpoint).toMatchObject({ trustDomain: FTD, enabled: true, lastErrorCode: null, consecutiveFailures: 0 });
    const b = (await activeBundle(FTD))!;
    expect(b).toMatchObject({ source: "fetch", sequence: 1, supersededAt: null });
    expect(b.jwtAuthorityViews.map((v) => v.kid)).toEqual([jwtKey.jwk.kid]);
    const [set] = await auditRows("spiffe-trust-bundle-set", FTD);
    expect(set!.detail).toMatchObject({ phase: "replace", source: "fetch", sequence: 1, replacedBundleId: up.json().id });
    expect((await auditRows("spiffe-bundle-endpoint-set", FTD))[0]!.detail).toMatchObject({ phase: "endpoint_add", profile: "https_spiffe", enabled: true });
    // the guard decided and recorded the call
    const [call] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "connector-egress-call"), sql`${auditLog.detail} ->> 'trustDomain' = ${FTD}`))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(call?.detail).toMatchObject({ purpose: "spiffe_bundle_fetch", trustDomain: FTD });
    // the trust window: about 24 h from now, on the database clock; the next fetch follows the hint
    const e = await endpointRow();
    const [{ until, next }] = rows<{ until: number; next: number }>(
      await db.execute(sql`select extract(epoch from (trust_until - now()))::int as until, extract(epoch from (next_refresh_at - now()))::int as next from spiffe_bundle_endpoints where trust_domain = ${FTD}`),
    ) as [{ until: number; next: number }];
    expect(until).toBeGreaterThan(86_400 - 120);
    expect(next).toBeGreaterThan(600 - 120);
    expect(e.lastSuccessAt).not.toBeNull();
  });

  it("an unchanged fetch writes no bundle", async () => {
    const before = await bundleCount(FTD);
    const out = await refreshSpiffeBundleEndpoint(db, await endpointRow());
    expect(out.outcome).toBe("unchanged");
    expect(await bundleCount(FTD)).toBe(before);
  });

  it("a failed fetch keeps the last good bundle: a 500, a body that does not parse, a sequence that goes backwards; each recorded and audited", async () => {
    const good = (await activeBundle(FTD))!;
    endpoint.set("unavailable", 500);
    expect(await refreshSpiffeBundleEndpoint(db, await endpointRow())).toMatchObject({ outcome: "failed", code: "spiffe_bundle_fetch_status" });
    endpoint.set("{ not json");
    expect(await refreshSpiffeBundleEndpoint(db, await endpointRow())).toMatchObject({ outcome: "failed", code: "spiffe_bundle_invalid" });
    // an older bundle replayed by the endpoint (different content, sequence 0 < 1): refused
    endpoint.set(await bundleDoc([fca2], [jwtKey], { spiffe_sequence: 0 }));
    expect(await refreshSpiffeBundleEndpoint(db, await endpointRow())).toMatchObject({ outcome: "failed", code: "spiffe_bundle_sequence_rollback" });
    expect((await activeBundle(FTD))!.id).toBe(good.id);
    const e = await endpointRow();
    expect([e.lastErrorCode, e.consecutiveFailures]).toEqual(["spiffe_bundle_sequence_rollback", 3]);
    const failed = await auditRows("spiffe-bundle-fetch-failed", FTD);
    expect(failed.slice(0, 3).map((f) => (f.detail as { code: string }).code)).toEqual(["spiffe_bundle_sequence_rollback", "spiffe_bundle_invalid", "spiffe_bundle_fetch_status"]);
    expect(failed.every((f) => f.effect === "deny")).toBe(true);
    // the last good bundle still authenticates (its trust window is unchanged)
    expect((await loadSpiffeTrustAnchors(db)).get(FTD)?.bundleId).toBe(good.id);
  });

  it("fail closed: past its trust window the fetched bundle authenticates nothing; a good fetch restores it", async () => {
    await db.execute(sql`update spiffe_bundle_endpoints set trust_until = now() - interval '1 second' where trust_domain = ${FTD}`);
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(false);
    endpoint.set(await bundleDoc([fca], [jwtKey], { spiffe_sequence: 1, spiffe_refresh_hint: 600 }));
    expect((await refreshSpiffeBundleEndpoint(db, await endpointRow())).outcome).toBe("unchanged");
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(true);
    expect((await endpointRow()).lastErrorCode).toBeNull();
  });

  it("rotation: a changed bundle (a new CA added, sequence 2) supersedes the old one, audited with both digests", async () => {
    const old = (await activeBundle(FTD))!;
    endpoint.set(await bundleDoc([fca, fca2], [jwtKey], { spiffe_sequence: 2 }));
    const out = await refreshSpiffeBundleEndpoint(db, await endpointRow());
    expect(out).toMatchObject({ outcome: "changed", sequence: 2 });
    const now = (await activeBundle(FTD))!;
    expect(now.id).not.toBe(old.id);
    expect(now.authorities).toHaveLength(2);
    const [oldRow] = await db.select().from(spiffeTrustBundles).where(eq(spiffeTrustBundles.id, old.id));
    expect([oldRow!.supersededByBundleId, oldRow!.revokedAt]).toEqual([now.id, null]);
    const [set] = await auditRows("spiffe-trust-bundle-set", FTD);
    expect(set!.detail).toMatchObject({ source: "fetch", sequence: 2, previousSequence: 1, previousDigest: old.digest, digest: now.digest });
    expect((await loadSpiffeTrustAnchors(db)).get(FTD)?.authorities).toHaveLength(2);
  });

  it("the scheduler pass claims a due endpoint and schedules its next fetch", async () => {
    await db.execute(sql`update spiffe_bundle_endpoints set next_refresh_at = now() - interval '1 second' where trust_domain = ${FTD}`);
    const before = (await endpointRow()).lastAttemptAt!;
    const served = endpoint.requests;
    const out = await runSpiffeBundleRefreshSweep(db);
    expect(out.refreshed).toBeGreaterThanOrEqual(1);
    expect(endpoint.requests).toBeGreaterThan(served);
    const e = await endpointRow();
    expect(e.lastAttemptAt!.getTime()).toBeGreaterThan(before.getTime());
    expect(e.nextRefreshAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a revocation disables the endpoint, and a fetch cannot undo it; an admin re-uploads and sets it again", async () => {
    const active = (await activeBundle(FTD))!;
    const rv = await inject("POST", `${BUNDLES}/${active.id}/revoke`, AUTH, {});
    expect(rv.statusCode, rv.body).toBe(200);
    const e = await endpointRow();
    expect([e.enabled, e.nextRefreshAt]).toEqual([false, null]);
    expect(await refreshSpiffeBundleEndpoint(db, e)).toMatchObject({ outcome: "skipped" });
    expect(await activeBundle(FTD)).toBeUndefined();
    // an admin uploads a bundle again (the https_spiffe bootstrap). A fetch that ran anyway (a stale enabled row) is
    // still refused, because the revocation is later than the endpoint's last setting: only a stepped-up PUT re-enables
    const reup = await inject("POST", BUNDLES, AUTH, { trustDomain: FTD, bundle: fca.pem, replacesBundleId: null });
    expect(reup.statusCode, reup.body).toBe(201);
    endpoint.set(await bundleDoc([fca], [jwtKey], { spiffe_sequence: 3 }));
    expect(await refreshSpiffeBundleEndpoint(db, { ...e, enabled: true })).toMatchObject({ outcome: "failed", code: "spiffe_bundle_revoked" });
    expect((await activeBundle(FTD))!.id).toBe(reup.json().id);
    const again = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody());
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().refresh).toMatchObject({ outcome: "changed" });
    expect((await activeBundle(FTD))!).toMatchObject({ source: "fetch", sequence: 3 });
  });

  it("the endpoint server must present an SVID for the configured ID", async () => {
    const r = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody({ endpointSpiffeId: `spiffe://${FTD}/someone/else` }));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().refresh).toMatchObject({ outcome: "failed", code: "spiffe_endpoint_id_mismatch" });
    // put it back
    expect((await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody())).json().refresh).toMatchObject({ outcome: "unchanged" });
  });

  it("an admin's upload after the endpoint was set is not superseded by a fetch; setting the endpoint again hands the domain back", async () => {
    const fetched = (await activeBundle(FTD))!;
    const up = await inject("POST", BUNDLES, AUTH, { trustDomain: FTD, bundle: fca2.pem, replacesBundleId: fetched.id });
    expect(up.statusCode, up.body).toBe(201);
    endpoint.set(await bundleDoc([fca], [jwtKey], { spiffe_sequence: 4 }));
    expect(await refreshSpiffeBundleEndpoint(db, await endpointRow())).toMatchObject({ outcome: "failed", code: "spiffe_bundle_upload_newer" });
    expect((await activeBundle(FTD))!).toMatchObject({ id: up.json().id, source: "upload" });
    const again = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody());
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().refresh).toMatchObject({ outcome: "changed", sequence: 4 });
    expect((await activeBundle(FTD))!).toMatchObject({ source: "fetch", sequence: 4 });
  });

  it("disabling the endpoint ends trust in its fetched bundle at once, audited; re-enabling fetches before it trusts again", async () => {
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(true);
    const off = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody({ enabled: false }));
    expect(off.statusCode, off.body).toBe(200);
    const e = await endpointRow();
    expect([e.enabled, e.nextRefreshAt]).toEqual([false, null]);
    expect(e.trustUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(false);
    const [set] = await db
      .select({ reason: auditLog.reason, detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "spiffe-bundle-endpoint-set"), sql`${auditLog.detail} ->> 'trustDomain' = ${FTD}`))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(set!.detail).toMatchObject({ phase: "endpoint_update", enabled: false });
    expect(set!.reason).toMatch(/stopped authenticating now/);
    // a disabled endpoint's bundle is unusable even inside a trust window (a racing write cannot reopen it)
    await db.execute(sql`update spiffe_bundle_endpoints set trust_until = now() + interval '1 hour' where trust_domain = ${FTD}`);
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(false);
    const on = await inject("PUT", `${ENDPOINTS}/${FTD}`, AUTH, endpointBody());
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().refresh).toMatchObject({ outcome: "unchanged" });
    expect((await loadSpiffeTrustAnchors(db)).has(FTD)).toBe(true);
  });
});

describe("S9 follow-up — JWT-SVID client authentication", () => {
  let a: SvidAgent;
  let b: SvidAgent;
  let tdBundleId: string;

  beforeAll(async () => {
    a = await svidAgent(TD, "jwt-a");
    b = await svidAgent(TD, "jwt-b");
    const up = await inject("POST", BUNDLES, AUTH, { trustDomain: TD, bundle: await bundleDoc([tdca], [jwtKey]), replacesBundleId: null });
    expect(up.statusCode, up.body).toBe(201);
    tdBundleId = up.json().id;
    expect(up.json().jwtAuthorities).toHaveLength(1);
  });

  it("off by default: the org's strict auth methods do not include spiffe_jwt_svid", async () => {
    await db.update(orgSettings).set({ workloadClientAuthMethods: methodsBefore as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const r = await jwtTokenRequest(a, await jwtSvid(a.clientId), await dpop(dkey()));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("method_not_allowed");
    // once allowed (the audited relaxation is proved in zz-adr0188-s1-foundation.test.ts), for the rest of this file
    await db.update(orgSettings).set({ workloadClientAuthMethods: FIVE_METHODS as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("a valid JWT-SVID + DPoP: a DPoP-bound token, authenticated by the spiffe_id credential and audited as such", async () => {
    const bind = dkey();
    const r = await jwtTokenRequest(a, await jwtSvid(a.clientId), await dpop(bind));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().token_type).toBe("DPoP");
    const claims = decodeJwt(r.json().access_token as string);
    expect(claims).toMatchObject({ client_id: a.clientId, cnf: { jkt: await calculateJwkThumbprint(bind.jwk, "sha256") } });
    const [it] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti!));
    expect(it).toMatchObject({ authCredentialId: a.credentialId, bindingKind: "dpop" });
    const [row] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "token-exchange-issued"), sql`${auditLog.detail} ->> 'tokenJti' = ${claims.jti!}`));
    expect(row!.detail).toMatchObject({ clientAuth: "spiffe_jwt_svid", clientId: a.clientId });
  });

  it("single-use: the same JWT-SVID is refused the second time", async () => {
    const svid = await jwtSvid(a.clientId);
    expect((await jwtTokenRequest(a, svid, await dpop(dkey()))).statusCode).toBe(200);
    const again = await jwtTokenRequest(a, svid, await dpop(dkey()));
    expect([again.statusCode, again.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("assertion_replayed");
  });

  it("a bearer JWT-SVID with no DPoP proof is refused before it is claimed (the same SVID then succeeds with DPoP)", async () => {
    const svid = await jwtSvid(a.clientId);
    const none = await jwtTokenRequest(a, svid, null);
    expect([none.statusCode, none.json().error]).toEqual([400, "invalid_dpop_proof"]);
    expect((await jwtTokenRequest(a, svid, await dpop(dkey()))).statusCode).toBe(200);
  });

  it("each refusal with its recorded code", async () => {
    const other = await svidAgent(TD2, "jwt-other");
    const cases: Array<[string, SvidAgent, () => Promise<string>, string]> = [
      ["wrong trust domain (no JWT authorities)", other, () => jwtSvid(other.clientId), "spiffe_trust_domain_unknown"],
      ["aud missing", a, () => jwtSvid(a.clientId, { claims: { aud: undefined } }), "jwt_svid_aud_missing"],
      ["aud of another server", a, () => jwtSvid(a.clientId, { claims: { aud: ["https://another.example.test"] } }), "jwt_svid_aud_mismatch"],
      ["two audiences", a, () => jwtSvid(a.clientId, { claims: { aud: [ISSUER, "https://another.example.test"] } }), "jwt_svid_aud_mismatch"],
      ["expired", a, () => jwtSvid(a.clientId, { claims: { exp: nowS() - 60, iat: nowS() - 200 } }), "jwt_svid_expired"],
      ["unknown kid", a, () => jwtSvid(a.clientId, { header: { kid: "not-in-the-bundle" } }), "jwt_svid_kid_unknown"],
      [
        "alg none",
        a,
        async () => `${base64url.encode(JSON.stringify({ alg: "none", kid: jwtKey.jwk.kid }))}.${base64url.encode(JSON.stringify({ sub: a.clientId, aud: [ISSUER], exp: nowS() + 60 }))}.`,
        "jwt_svid_alg",
      ],
      ["another workload's SPIFFE ID", a, () => jwtSvid(b.clientId), "spiffe_id_mismatch"],
    ];
    for (const [label, agent, make, code] of cases) {
      const r = await jwtTokenRequest(agent, await make(), await dpop(dkey()));
      expect([r.statusCode, r.json().error], label).toEqual([401, "invalid_client"]);
      expect(await lastTokenCode(agent.clientId), label).toBe(code);
    }
  });

  it("a JWT-key rotation: a bundle without the old kid refuses its SVIDs; the new key authenticates", async () => {
    const up = await inject("POST", BUNDLES, AUTH, { trustDomain: TD, bundle: await bundleDoc([tdca], [jwtKey2]), replacesBundleId: tdBundleId });
    expect(up.statusCode, up.body).toBe(201);
    tdBundleId = up.json().id;
    const old = await jwtTokenRequest(a, await jwtSvid(a.clientId), await dpop(dkey()));
    expect([old.statusCode, await lastTokenCode(a.clientId)]).toEqual([401, "jwt_svid_kid_unknown"]);
    expect((await jwtTokenRequest(a, await jwtSvid(a.clientId, { key: jwtKey2 }), await dpop(dkey()))).statusCode).toBe(200);
  });

  it("revoking the domain's bundle revokes its JWT-SVID tokens, and no JWT-SVID of the domain authenticates", async () => {
    const r = await jwtTokenRequest(a, await jwtSvid(a.clientId, { key: jwtKey2 }), await dpop(dkey()));
    expect(r.statusCode, r.body).toBe(200);
    const jti = decodeJwt(r.json().access_token as string).jti!;
    const rv = await inject("POST", `${BUNDLES}/${tdBundleId}/revoke`, AUTH, {});
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json().tokensRevoked).toBeGreaterThanOrEqual(1);
    const [it] = await db.select({ revokedAt: issuedTokens.revokedAt }).from(issuedTokens).where(eq(issuedTokens.jti, jti));
    expect(it!.revokedAt).not.toBeNull();
    const after = await jwtTokenRequest(a, await jwtSvid(a.clientId, { key: jwtKey2 }), await dpop(dkey()));
    expect([after.statusCode, await lastTokenCode(a.clientId)]).toEqual([401, "spiffe_trust_domain_unknown"]);
  });
});
