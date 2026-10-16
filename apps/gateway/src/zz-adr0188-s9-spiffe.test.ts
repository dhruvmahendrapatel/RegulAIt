/**
 * ADR-0188 (batch 6 item 1) S9 — SPIFFE TRUST BUNDLES IN AUDITED STORAGE, AND
 * X.509-SVID CLIENT AUTHENTICATION END TO END, on a real database, through the
 * real app (`buildApp`) and its real hooks:
 *
 *  - THE ADMIN ROUTES (`oauth/spiffe-bundles.ts`): admin-only; an admin API key
 *    cannot step up; the `identity_manage` step-up is bound to the trust
 *    domain, the bundle's digest and the bundle it replaces, and a step-up for
 *    one bundle is refused (and not spent) for another; every write and every
 *    refusal is audited; one active bundle per domain (compare-and-set); the
 *    table refuses DELETE, a content change, and a second active row.
 *  - SECURE BY DEFAULT: the S5 environment variable is SET in this file and
 *    IGNORED: before an upload, an SVID of that domain authenticates nothing,
 *    and a SPIFFE ID credential cannot be bound there.
 *  - END TO END: a person's delegation proof, the agent's X.509-SVID forwarded
 *    by an authenticated proxy, the token endpoint → a certificate-bound
 *    token, accepted at `/mcp/:serverId` with that SVID. Then each security
 *    claim, as a refused token request with its recorded reason: a wrong
 *    trust domain, an expired SVID, a URI SAN that is not SPIFFE, two URI
 *    SANs, a CA certificate used as the leaf, and a forwarded certificate from
 *    an untrusted proxy (and from a trusted address with the wrong secret).
 *  - ROTATION AND REVOCATION (decision 12): replacing a bundle supersedes it
 *    (an overlap bundle keeps old SVIDs valid); revoking it revokes the
 *    domain's tokens in the same transaction and cascades their grants; the
 *    resource and the token endpoint refuse at once; the live-chain check
 *    refuses a SPIFFE-authenticated grant even when the cascade failed.
 *
 * Global state (M-068): org settings, interception settings and the active
 * issuer key are put back in afterAll. Bundles and identities cannot be
 * deleted by design, so every trust domain is unique to this run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeJwt } from "jose";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  delegationGrants,
  desc,
  eq,
  identitySigningKeys,
  issuedTokens,
  runMigrations,
  spiffeTrustBundles,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, stepUpActionDigest, type DelegationScope } from "@regulait/shared";
import { buildApp } from "./app.js";
import { loadLiveChain, createRootGrant } from "./delegation.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { deploymentEnvironment } from "./oauth/common.js";
import { grantCascadeTestHooks } from "./oauth/identity-admin.js";
import { parseSpiffeBundle, spiffeBundleRevokeStepUp, spiffeBundleSetStepUp } from "./oauth/spiffe-bundles.js";
import { tokenEndpointTestHooks } from "./oauth/token-endpoint.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { makeCert, type TestCert } from "./testing/x509-fixtures.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s9-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const ISSUER = "http://127.0.0.1:4419";
const DATA_KEY = "s9-synthetic-data-key-".padEnd(64, "q");
const PROXY_SECRET = "s9-proxy-secret-".padEnd(48, "w");
const CERT_HEADER = "x-s9-client-cert";
// every trust domain is this run's own: bundles are never deleted
const TD = `s9-${RUN}.example.org`;
const TD2 = `s9b-${RUN}.example.org`;
const T_READ = `s9_read_${RUN}`;
const EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const AT = "urn:ietf:params:oauth:token-type:access_token";
const BUNDLES = "/v1/identity/spiffe-trust-bundles";

// deployment facts for this file's process (each vitest file runs in its own worker)
process.env.REGULAIT_PUBLIC_URL = ISSUER;
process.env.REGULAIT_CLIENT_CERT_HEADER = CERT_HEADER;
process.env.REGULAIT_CLIENT_CERT_PROXY_SECRET = PROXY_SECRET;
process.env.REGULAIT_TRUSTED_PROXIES = "127.0.0.1";
const ENV = deploymentEnvironment();

let db: Db;
let app: ReturnType<typeof buildApp>;
let sponsorId: string;
let sponsorAuth: { authorization: string };
let memberAuth: { authorization: string };
let serverId: string;
let resource: string;
let projectId: string;
let keyDir: string;
const restores: Array<() => Promise<void>> = [];
let root: TestCert;
let root2: TestCert;
let legacyBefore: string | undefined;

const rows = <R>(r: unknown) => (r as { rows: R[] }).rows;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const fwd = (der: Buffer, secret = PROXY_SECRET) => ({ [CERT_HEADER]: der.toString("base64"), "x-regulait-proxy-auth": secret });
const spiffeId = (td: string, name: string) => `spiffe://${td}/s9/${name}-${RUN}`;

interface SvidAgent {
  identityId: string;
  clientId: string;
  credentialId: string;
}

/** an agent identity in `td` with one `spiffe_id` credential (inserted directly: binding through the route needs a bundle) */
async function svidAgent(td: string, name: string): Promise<SvidAgent> {
  const a = rows<{ id: string }>(await db.execute(sql`insert into agents (name, provider, tier) values (${`s9-${name}-${RUN}`}, 'mock', 1) returning id`))[0]!.id;
  const clientId = spiffeId(td, name);
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
  const r = await inject("POST", "/v1/delegations/proofs", sponsorAuth, {
    agentIdentityId: a.identityId,
    authorizationDetails: scope(),
    resource,
    projectId,
    env: ENV,
    capMicros: 1_000_000,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().proof as string;
}

/** the root exchange authenticated by a forwarded client certificate (no assertion: one mechanism per request) */
const tokenRequest = async (a: SvidAgent, headers: Record<string, string>, remoteAddress?: string) =>
  app.inject({
    method: "POST",
    url: "/oauth/token",
    ...(remoteAddress ? { remoteAddress } : {}),
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams({
      grant_type: EXCHANGE,
      subject_token: await proof(a),
      subject_token_type: "urn:regulait:params:oauth:token-type:delegation-proof",
      requested_token_type: AT,
      resource,
      authorization_details: JSON.stringify(scope()),
      client_id: a.clientId,
    }).toString(),
  });

/** the code the token endpoint recorded for this client's latest request */
const lastTokenCode = async (clientId: string) => {
  const [row] = await db
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "token-exchange-refused"), sql`${auditLog.detail} ->> 'clientId' = ${clientId}`))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return (row?.detail as { code?: string } | undefined)?.code;
};

const mcpCall = (accessToken: string, headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: `/mcp/${serverId}`,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-regulait-project-id": projectId,
      ...headers,
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });

const activeBundle = async (td: string) =>
  (await db.select().from(spiffeTrustBundles).where(and(eq(spiffeTrustBundles.trustDomain, td), sql`superseded_at is null and revoked_at is null`)))[0];

/** upload through the route with the bootstrap credential (the step-up is proved separately below) */
async function upload(td: string, bundle: string, replacesBundleId: string | null) {
  return inject("POST", BUNDLES, AUTH, { trustDomain: td, bundle, replacesBundleId });
}

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `s9-${label}-${RUN}@example.com`, displayName: `s9 ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

/** a browser session for `userId` and a step-up token made for exactly `args` (the real tables, no shortcut) */
async function sessionWithStepUp(userId: string, args: StepUpCheckArgs) {
  const sessionToken = "rgls_" + randomBytes(32).toString("hex");
  const [session] = await db
    .insert(authSessions)
    .values({
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      userId,
      origin: "password",
      expiresAt: new Date(Date.now() + 3_600_000),
      idleExpiresAt: new Date(Date.now() + 3_600_000),
      idleMinutes: 60,
    })
    .returning({ id: authSessions.id });
  const stepUpToken = "rgsu_" + randomBytes(24).toString("hex");
  const [grant] = await db
    .insert(stepUpGrants)
    .values({
      tokenHash: hashToken(stepUpToken),
      userId,
      sessionId: session!.id,
      method: "totp",
      actionKind: args.kind,
      actionDigest: stepUpActionDigest(args.kind, args.facts),
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning({ id: stepUpGrants.id });
  return { sessionToken, stepUpToken, grantId: grant!.id };
}

beforeAll(async () => {
  // SET the retired S5 variable to a bundle for THIS run's domain: S9 must ignore it (restored in afterAll)
  legacyBefore = process.env.REGULAIT_SPIFFE_TRUST_BUNDLES;
  root = await makeCert({ isCA: true, name: `s9-root-${RUN}` });
  root2 = await makeCert({ isCA: true, name: `s9-root2-${RUN}` });
  process.env.REGULAIT_SPIFFE_TRUST_BUNDLES = JSON.stringify({ [TD]: root.pem, [TD2]: root.pem });

  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  keyDir = mkdtempSync(path.join(os.tmpdir(), "s9-issuer-"));
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
  memberAuth = (await mkUser("member")).key;
  const s = await inject("POST", "/v1/servers", AUTH, { name: `s9-server-${RUN}`, url: "http://127.0.0.1:9" });
  expect(s.statusCode, s.body).toBe(201);
  serverId = s.json().id;
  resource = `${ISSUER}/mcp/${serverId}`;
  expect((await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name: T_READ, kind: "read" })).statusCode).toBe(201);
  expect((await inject("POST", "/v1/grants/tools", AUTH, { userId: sponsorId, serverId, toolName: T_READ })).statusCode).toBe(201);
  projectId = rows<{ id: string }>(await db.execute(sql`insert into projects (name) values (${`s9-proj-${RUN}`}) returning id`))[0]!.id;
  await db.execute(sql`insert into project_members (project_id, user_id, role) values (${projectId}, ${sponsorId}, 'contributor')`);
  const ic = await inject("GET", "/v1/interception/settings", AUTH);
  const before = ic.json().settings as { mcpInterceptionEnabled: boolean; anthropicCompatEnabled: boolean; openaiCompatEnabled: boolean };
  const put = await inject("PUT", "/v1/interception/settings", AUTH, { ...before, mcpInterceptionEnabled: true });
  expect(put.statusCode, put.body).toBe(200);
  restores.push(async () => {
    const back = await inject("PUT", "/v1/interception/settings", AUTH, before);
    expect(back.statusCode, back.body).toBe(200);
  });
}, 120_000);

afterAll(async () => {
  grantCascadeTestHooks.failFor = undefined;
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  await app?.close();
  rmSync(keyDir, { recursive: true, force: true });
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
  if (legacyBefore === undefined) delete process.env.REGULAIT_SPIFFE_TRUST_BUNDLES;
  else process.env.REGULAIT_SPIFFE_TRUST_BUNDLES = legacyBefore;
});

// ---------------------------------------------------------------------------
describe("S9 — secure by default: the S5 variable is set and ignored", () => {
  it("before any upload, an SVID of the domain authenticates nothing, and a SPIFFE ID cannot be bound there", async () => {
    const a = await svidAgent(TD, "before-upload");
    const svid = await makeCert({ issuer: root, uris: [a.clientId] });
    const r = await tokenRequest(a, fwd(svid.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("spiffe_trust_domain_unknown");
    const bind = await inject("POST", `/v1/workload-identities/${a.identityId}/credentials`, AUTH, { kind: "spiffe_id", spiffeId: spiffeId(TD, "another") });
    expect([bind.statusCode, bind.json().error]).toEqual([422, "spiffe_trust_domain_unknown"]);
    const list = await inject("GET", BUNDLES, AUTH);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().legacyEnvironmentIgnored).toBe(true);
    expect((list.json().items as Array<{ trustDomain: string }>).filter((b) => b.trustDomain === TD)).toEqual([]);
  });
});

describe("S9 — the admin routes", () => {
  it("admin-only; an admin API key cannot step up; nothing is stored", async () => {
    expect((await inject("GET", BUNDLES, memberAuth)).statusCode).toBe(403);
    expect((await inject("POST", BUNDLES, memberAuth, { trustDomain: TD, bundle: root.pem, replacesBundleId: null })).statusCode).toBe(403);
    const admin = await mkUser("api-admin", true);
    const r = await inject("POST", BUNDLES, admin.key, { trustDomain: TD, bundle: root.pem, replacesBundleId: null });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", credential: "api_key" });
    const rv = await inject("POST", `${BUNDLES}/${randomUUID()}/revoke`, admin.key, {});
    expect(rv.json()).toMatchObject({ error: "step_up_required" });
    expect(await activeBundle(TD)).toBeUndefined();
  });

  it("an invalid bundle is refused before any step-up, audited, nothing stored", async () => {
    const leaf = await makeCert({ issuer: root, uris: [spiffeId(TD, "leaf")] });
    const r = await upload(TD, leaf.pem, null);
    expect([r.statusCode, r.json().error]).toEqual([422, "spiffe_bundle_authority_not_ca"]);
    const bad = await upload(TD, "not a bundle", null);
    expect([bad.statusCode, bad.json().error]).toEqual([422, "spiffe_bundle_invalid"]);
    const malformed = await inject("POST", BUNDLES, AUTH, { trustDomain: "Not A Domain", bundle: root.pem, replacesBundleId: null });
    expect(malformed.statusCode).toBe(400);
    const denies = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "spiffe-trust-bundle-refused"), sql`${auditLog.detail} ->> 'trustDomain' = ${TD}`));
    expect(denies.map((d) => (d.detail as { code: string }).code).sort()).toEqual(["spiffe_bundle_authority_not_ca", "spiffe_bundle_invalid"]);
    expect(await activeBundle(TD)).toBeUndefined();
  });

  it("upload: active, audited with the digest; a second upload must name the active bundle; an identical one is refused", async () => {
    const r = await upload(TD, root.pem, null);
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({ trustDomain: TD, status: "active", format: "pem", supersededAt: null, revokedAt: null });
    expect(b.authorities).toHaveLength(1);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "spiffe-trust-bundle-set"), eq(auditLog.objectId, b.id)));
    expect(row!.detail).toMatchObject({ phase: "add", trustDomain: TD, digest: b.digest, replacedBundleId: null });
    const stale = await upload(TD, root2.pem, null);
    expect([stale.statusCode, stale.json().error]).toEqual([409, "spiffe_bundle_conflict"]);
    const wrong = await upload(TD, root2.pem, randomUUID());
    expect([wrong.statusCode, wrong.json().error]).toEqual([409, "spiffe_bundle_conflict"]);
    const same = await upload(TD, root.pem, b.id);
    expect([same.statusCode, same.json().error]).toEqual([409, "spiffe_bundle_unchanged"]);
    expect((await activeBundle(TD))!.id).toBe(b.id);
  });

  it("the step-up is bound to the bundle: one made for bundle A is refused for bundle B and stays unspent", async () => {
    const admin = await mkUser("su-admin", true);
    // an enrolled authenticator, so a mismatched token is answered step_up_required. ORG-GLOBAL state (an admin who
    // can step up ends the bootstrap credential's step-up): undone in the finally below (M-040)
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, admin.id));
    try {
      const td = `s9su-${RUN}.example.org`;
      const parsedA = parseSpiffeBundle(root.pem, new Date());
      if (!("digest" in parsedA)) throw new Error("fixture bundle refused");
      const su = await sessionWithStepUp(admin.id, spiffeBundleSetStepUp({ trustDomain: td, bundle: root.pem, replacesBundleId: null }, parsedA.digest));
      const post = (bundle: string) =>
        app.inject({
          method: "POST",
          url: BUNDLES,
          headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken },
          cookies: { regulait_session: su.sessionToken },
          payload: { trustDomain: td, bundle, replacesBundleId: null },
        });
      const forB = await post(root2.pem);
      expect(forB.statusCode, forB.body).toBe(403);
      expect(forB.json().error).toBe("step_up_required");
      const [unspent] = await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, su.grantId));
      expect(unspent!.usedAt, "a step-up for bundle A was spent on bundle B").toBeNull();
      expect(await activeBundle(td)).toBeUndefined();
      const forA = await post(root.pem);
      expect(forA.statusCode, forA.body).toBe(201);
      expect(forA.json()).toMatchObject({ trustDomain: td, createdBy: admin.id });
    } finally {
      await db.update(users).set({ totpEnabled: false }).where(eq(users.id, admin.id));
    }
  });

  it("the table: no DELETE, no content change, never two active bundles for one domain", async () => {
    const b = (await activeBundle(TD))!;
    await expect(db.execute(sql`delete from spiffe_trust_bundles where id = ${b.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update spiffe_trust_bundles set authorities_pem = ${root2.pem} where id = ${b.id}`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into spiffe_trust_bundles (trust_domain, format, authorities_pem, authorities, digest, created_by)
        values (${TD}, 'pem', ${root2.pem}, ${JSON.stringify(b.authorities)}::jsonb, ${"b".repeat(64)}, ${sponsorId})`),
    ).rejects.toThrow();
    expect((await activeBundle(TD))!.id).toBe(b.id);
  });
});

describe("S9 — X.509-SVID client authentication end to end", () => {
  let a: SvidAgent;
  let svid: TestCert;
  let accessToken: string;

  beforeAll(async () => {
    a = await svidAgent(TD, "e2e");
    svid = await makeCert({ issuer: root, uris: [a.clientId] });
  });

  it("the genuine SVID through an authenticated proxy: a certificate-bound token, accepted at the resource only with that SVID", async () => {
    const r = await tokenRequest(a, fwd(svid.der));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().token_type).toBe("Bearer");
    accessToken = r.json().access_token as string;
    const claims = decodeJwt(accessToken);
    expect(claims).toMatchObject({ client_id: a.clientId, cnf: { "x5t#S256": createHash("sha256").update(svid.der).digest("base64url") } });
    const [it] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti!));
    expect(it).toMatchObject({ authCredentialId: a.credentialId, bindingKind: "mtls" });
    const ok = await mcpCall(accessToken, fwd(svid.der));
    expect(ok.statusCode, ok.body).not.toBe(401);
    expect((await mcpCall(accessToken, {})).json()).toMatchObject({ error: "invalid_token", code: "client_certificate_required" });
  });

  it("a wrong trust domain is refused", async () => {
    // a genuine certificate from the domain's own CA, whose SPIFFE ID names another domain
    const other = await makeCert({ issuer: root, uris: [spiffeId(TD2, "e2e")] });
    const r = await tokenRequest(a, fwd(other.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("spiffe_trust_domain");
  });

  it("an expired SVID is refused", async () => {
    const expired = await makeCert({ issuer: root, uris: [a.clientId], notBefore: new Date(Date.now() - 7200_000), notAfter: new Date(Date.now() - 60_000) });
    const r = await tokenRequest(a, fwd(expired.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(["certificate_time", "certificate_path"]).toContain(await lastTokenCode(a.clientId));
  });

  it("a URI SAN that is not SPIFFE is refused", async () => {
    const https = await makeCert({ issuer: root, uris: [`https://${TD}/s9/e2e-${RUN}`] });
    const r = await tokenRequest(a, fwd(https.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("spiffe_profile");
  });

  it("multiple URI SANs are refused, even when the first is the registered ID", async () => {
    const two = await makeCert({ issuer: root, uris: [a.clientId, `${a.clientId}-2`] });
    const r = await tokenRequest(a, fwd(two.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("spiffe_san");
  });

  it("a CA SVID used as a leaf is refused", async () => {
    const caSvid = await makeCert({ issuer: root, isCA: true, uris: [a.clientId] });
    const r = await tokenRequest(a, fwd(caSvid.der));
    expect([r.statusCode, r.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("certificate_leaf_ca");
  });

  it("a forwarded SVID from an untrusted proxy, or a trusted address with the wrong secret, is stripped: no client certificate", async () => {
    const untrusted = await tokenRequest(a, fwd(svid.der), "10.9.8.7");
    expect([untrusted.statusCode, untrusted.json().error]).toEqual([401, "invalid_client"]);
    const wrongSecret = await tokenRequest(a, fwd(svid.der, "x".repeat(48)));
    expect([wrongSecret.statusCode, wrongSecret.json().error]).toEqual([401, "invalid_client"]);
    // at the resource too: the genuine token with the genuine SVID, forwarded by an untrusted peer
    const atResource = await app.inject({
      method: "POST",
      url: `/mcp/${serverId}`,
      remoteAddress: "10.9.8.7",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "x-regulait-project-id": projectId, ...fwd(svid.der) },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(atResource.json()).toMatchObject({ error: "invalid_token", code: "client_certificate_required" });
  });
});

describe("S9 — rotation and revocation (decision 12)", () => {
  it("replacing with an overlap bundle keeps old SVIDs valid and admits the new CA; the old bundle is superseded, audited", async () => {
    const td = `s9rot-${RUN}.example.org`;
    const a = await svidAgent(td, "rot");
    const first = await upload(td, root.pem, null);
    expect(first.statusCode, first.body).toBe(201);
    const oldSvid = await makeCert({ issuer: root, uris: [a.clientId] });
    expect((await tokenRequest(a, fwd(oldSvid.der))).statusCode).toBe(200);
    const overlap = await upload(td, `${root.pem}${root2.pem}`, first.json().id);
    expect(overlap.statusCode, overlap.body).toBe(201);
    const [old] = await db.select().from(spiffeTrustBundles).where(eq(spiffeTrustBundles.id, first.json().id));
    expect(old!.supersededByBundleId).toBe(overlap.json().id);
    const newSvid = await makeCert({ issuer: root2, uris: [a.clientId] });
    expect((await tokenRequest(a, fwd(oldSvid.der))).statusCode).toBe(200);
    expect((await tokenRequest(a, fwd(newSvid.der))).statusCode).toBe(200);
    // the rotation completes: the old CA leaves the bundle, and its SVIDs stop authenticating
    const done = await upload(td, root2.pem, overlap.json().id);
    expect(done.statusCode, done.body).toBe(201);
    expect((await tokenRequest(a, fwd(oldSvid.der))).statusCode).toBe(401);
    expect((await tokenRequest(a, fwd(newSvid.der))).statusCode).toBe(200);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "spiffe-trust-bundle-set"), eq(auditLog.objectId, done.json().id)));
    expect(audit!.detail).toMatchObject({ phase: "replace", replacedBundleId: overlap.json().id });
    // a superseded bundle is not the domain's trust any more: revoking it is refused
    const rv = await inject("POST", `${BUNDLES}/${first.json().id}/revoke`, AUTH, {});
    expect([rv.statusCode, rv.json().error]).toEqual([409, "spiffe_bundle_not_active"]);
  });

  it("revoking the bundle revokes the domain's tokens with it, cascades their grants, and refuses at once", async () => {
    const td = `s9rev-${RUN}.example.org`;
    const a = await svidAgent(td, "rev");
    const up = await upload(td, root.pem, null);
    expect(up.statusCode, up.body).toBe(201);
    const svid = await makeCert({ issuer: root, uris: [a.clientId] });
    const r = await tokenRequest(a, fwd(svid.der));
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json().access_token as string;
    const claims = decodeJwt(t);
    expect((await mcpCall(t, fwd(svid.der))).statusCode).not.toBe(401);

    const rv = await inject("POST", `${BUNDLES}/${up.json().id}/revoke`, AUTH, {});
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json()).toMatchObject({ bundle: { status: "revoked" }, tokensRevoked: 1, cascade: "complete" });
    expect(rv.json().grantsRevoked).toContain(claims.grant_id);
    const [tok] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti!));
    expect(tok!.revokedAt).not.toBeNull();
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, claims.grant_id as string));
    expect(g!.revokedAt).not.toBeNull();
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "spiffe-trust-bundle-revoked"), eq(auditLog.objectId, up.json().id)));
    expect(audit!.detail).toMatchObject({ phase: "revoke", trustDomain: td, tokensRevoked: 1 });

    expect((await mcpCall(t, fwd(svid.der))).statusCode).toBe(401);
    const again = await tokenRequest(a, fwd(svid.der));
    expect([again.statusCode, again.json().error]).toEqual([401, "invalid_client"]);
    expect(await lastTokenCode(a.clientId)).toBe("spiffe_trust_domain_unknown");
    const twice = await inject("POST", `${BUNDLES}/${up.json().id}/revoke`, AUTH, {});
    expect([twice.statusCode, twice.json().error]).toEqual([409, "spiffe_bundle_already_revoked"]);
  });

  it("the backstop: when the cascade fails, the live-chain check still refuses a SPIFFE-authenticated grant", async () => {
    const td = TD2;
    const a = await svidAgent(td, "backstop");
    const up = await upload(td, root.pem, null);
    expect(up.statusCode, up.body).toBe(201);
    const grant = await createRootGrant(db, {
      sponsorUserId: sponsorId,
      actorIdentityId: a.identityId,
      scope: scope() as DelegationScope,
      capMicros: null,
      environment: ENV,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      projectId,
      binding: { kind: "mtls", thumbprint: "s9-backstop-thumbprint", authCredentialId: a.credentialId, audience: resource },
    });
    // positive control: live while the bundle is active
    expect((await loadLiveChain(db, grant.id))!.failure).toBeNull();
    grantCascadeTestHooks.failFor = (id) => id === grant.id;
    try {
      const rv = await inject("POST", `${BUNDLES}/${up.json().id}/revoke`, AUTH, {});
      expect(rv.statusCode, rv.body).toBe(200);
      expect(rv.json()).toMatchObject({ cascade: "incomplete", grantsNotRevoked: [grant.id] });
    } finally {
      grantCascadeTestHooks.failFor = undefined;
    }
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grant.id));
    expect(g!.revokedAt, "the cascade was made to fail").toBeNull();
    expect((await loadLiveChain(db, grant.id))!.failure).toMatchObject({ code: "credential_not_live" });
    const [inc] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "workload-identity-cascade-incomplete"), eq(auditLog.objectId, up.json().id)));
    expect(inc!.detail).toMatchObject({ bundleId: up.json().id, trustDomain: td, grantsNotRevoked: [grant.id] });
  });

  it("#389 review M1: re-uploading a bundle never revives what its revocation ended, even when the cascade failed", async () => {
    const td = `s9m1-${RUN}.example.org`;
    const a = await svidAgent(td, "m1");
    const up = await upload(td, root.pem, null);
    expect(up.statusCode, up.body).toBe(201);
    // a real certificate-bound token, and a DPoP-bound grant the same SPIFFE ID authenticated
    const svid = await makeCert({ issuer: root, uris: [a.clientId] });
    const r = await tokenRequest(a, fwd(svid.der));
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json().access_token as string;
    const mtlsGrant = decodeJwt(t).grant_id as string;
    const dpopGrant = await createRootGrant(db, {
      sponsorUserId: sponsorId,
      actorIdentityId: a.identityId,
      scope: scope() as DelegationScope,
      capMicros: null,
      environment: ENV,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      projectId,
      binding: { kind: "dpop", thumbprint: "s9-m1-dpop-thumbprint", authCredentialId: a.credentialId, audience: resource },
    });
    expect((await loadLiveChain(db, dpopGrant.id))!.failure).toBeNull();
    grantCascadeTestHooks.failFor = (id) => id === mtlsGrant || id === dpopGrant.id;
    try {
      const rv = await inject("POST", `${BUNDLES}/${up.json().id}/revoke`, AUTH, {});
      expect(rv.statusCode, rv.body).toBe(200);
      expect(rv.json().cascade).toBe("incomplete");
    } finally {
      grantCascadeTestHooks.failFor = undefined;
    }
    // the trust domain is trusted again, under the same CA
    const again = await upload(td, root.pem, null);
    expect(again.statusCode, again.body).toBe(201);
    for (const id of [mtlsGrant, dpopGrant.id]) {
      const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, id));
      expect(g!.revokedAt, "the cascade was made to fail").toBeNull();
      expect((await loadLiveChain(db, id))!.failure, id).toMatchObject({ code: "credential_not_live" });
    }
    expect((await mcpCall(t, fwd(svid.der))).statusCode).toBe(401);
    // positive control: what the NEW bundle authenticates is live
    const fresh = await tokenRequest(a, fwd(svid.der));
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await loadLiveChain(db, decodeJwt(fresh.json().access_token as string).grant_id as string))!.failure).toBeNull();
  });

  it("#389 review M1: a revocation that arrives while a token is being issued waits for it, then ends it", async () => {
    const td = `s9race-${RUN}.example.org`;
    const a = await svidAgent(td, "race");
    const up = await upload(td, root.pem, null);
    expect(up.statusCode, up.body).toBe(201);
    const svid = await makeCert({ issuer: root, uris: [a.clientId] });
    let revoke: Promise<Awaited<ReturnType<typeof inject>>> | undefined;
    tokenEndpointTestHooks.beforeGrantCommit = async () => {
      // the issuing transaction holds the bundle row FOR SHARE: this revocation blocks on it until the commit
      revoke = inject("POST", `${BUNDLES}/${up.json().id}/revoke`, AUTH, {});
      await new Promise((r) => setTimeout(r, 300));
    };
    let r;
    try {
      r = await tokenRequest(a, fwd(svid.der));
    } finally {
      tokenEndpointTestHooks.beforeGrantCommit = undefined;
    }
    expect(r.statusCode, r.body).toBe(200);
    const claims = decodeJwt(r.json().access_token as string);
    const rv = await revoke!;
    expect(rv.statusCode, rv.body).toBe(200);
    expect(rv.json()).toMatchObject({ tokensRevoked: 1, cascade: "complete" });
    expect(rv.json().grantsRevoked).toContain(claims.grant_id);
    const [tok] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti!));
    expect(tok!.revokedAt).not.toBeNull();
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, claims.grant_id as string));
    const [b] = await db.select().from(spiffeTrustBundles).where(eq(spiffeTrustBundles.id, up.json().id));
    expect(g!.createdAt.getTime()).toBeLessThanOrEqual(b!.revokedAt!.getTime());
  });

  it("#389 review L3: a step-up for a refused write (404, 409) stays unspent; the accepted write spends it", async () => {
    const admin = await mkUser("l3-admin", true);
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, admin.id));
    try {
      const td = `s9l3-${RUN}.example.org`;
      const first = await upload(td, root.pem, null);
      expect(first.statusCode, first.body).toBe(201);
      const parsed = parseSpiffeBundle(root2.pem, new Date());
      if (!("digest" in parsed)) throw new Error("fixture bundle refused");
      const send = (su: { sessionToken: string; stepUpToken: string }, url: string, payload: object) =>
        app.inject({ method: "POST", url, headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken }, cookies: { regulait_session: su.sessionToken }, payload });
      const used = async (id: string) => (await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, id)))[0]!.usedAt;

      // 409: a stale compare-and-set (the domain HAS an active bundle; the request says it has none)
      const stale = await sessionWithStepUp(admin.id, spiffeBundleSetStepUp({ trustDomain: td, bundle: root2.pem, replacesBundleId: null }, parsed.digest));
      const r409 = await send(stale, BUNDLES, { trustDomain: td, bundle: root2.pem, replacesBundleId: null });
      expect([r409.statusCode, r409.json().error]).toEqual([409, "spiffe_bundle_conflict"]);
      expect(await used(stale.grantId), "a refused upload spent its step-up").toBeNull();

      // 404: revoking a bundle that does not exist
      const missing = randomUUID();
      const gone = await sessionWithStepUp(admin.id, spiffeBundleRevokeStepUp(missing));
      const r404 = await send(gone, `${BUNDLES}/${missing}/revoke`, {});
      expect([r404.statusCode, r404.json().error]).toEqual([404, "spiffe_bundle_not_found"]);
      expect(await used(gone.grantId), "a refused revoke spent its step-up").toBeNull();

      // positive control: the right compare-and-set is written, and only then is the step-up spent
      const ok = await sessionWithStepUp(admin.id, spiffeBundleSetStepUp({ trustDomain: td, bundle: root2.pem, replacesBundleId: first.json().id }, parsed.digest));
      const r201 = await send(ok, BUNDLES, { trustDomain: td, bundle: root2.pem, replacesBundleId: first.json().id });
      expect(r201.statusCode, r201.body).toBe(201);
      expect(await used(ok.grantId)).not.toBeNull();
    } finally {
      await db.update(users).set({ totpEnabled: false }).where(eq(users.id, admin.id));
    }
  });

  it("a SPIFFE ID credential binds through the route once a bundle is active for its domain", async () => {
    const td = `s9bind-${RUN}.example.org`;
    const a = await svidAgent(td, "bind");
    const id = spiffeId(td, "bound");
    const before = await inject("POST", `/v1/workload-identities/${a.identityId}/credentials`, AUTH, { kind: "spiffe_id", spiffeId: id });
    expect([before.statusCode, before.json().error]).toEqual([422, "spiffe_trust_domain_unknown"]);
    expect((await upload(td, root.pem, null)).statusCode).toBe(201);
    const after = await inject("POST", `/v1/workload-identities/${a.identityId}/credentials`, AUTH, { kind: "spiffe_id", spiffeId: id });
    expect(after.statusCode, after.body).toBe(201);
    expect(after.json()).toMatchObject({ kind: "spiffe_id", spiffeId: id });
  });
});
