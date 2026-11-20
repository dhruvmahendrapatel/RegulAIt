/**
 * ADR-0315 (G7, slice 2) — revocation reaches outside verifiers, on a real database through the real app:
 *
 *  - Every credential names its entry in the issuer's signed IETF Token Status List (`statuslist+jwt`, ES256, `sub` =
 *    the list URI) and the reference verifier checks it, failing closed.
 *  - INVALID (terminal): an admin revocation by `jti`, and a revoked ancestor grant (the cascade). SUSPENDED
 *    (reversible): a halted agent in the chain and the org dial at `halted`; lifting either makes it VALID again.
 *  - The verifier refuses a list it cannot read, one from another key, one for another URI, and an expired one.
 *  - Gateway configuration shapes: the checks agentgateway's `jwtAuthentication` provider and Kong's `jwt` plugin
 *    document are modelled with jose and pass; the Kong shape does not see revocation, which is why the verifier
 *    guide puts the status check at the upstream.
 *
 * Global state (M-068): signing keys are retired, the org dial and env restored, and every row this file creates is
 * removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, createLocalJWKSet, decodeJwt, exportJWK, exportSPKI, importJWK, importSPKI, jwtVerify, SignJWT, type JSONWebKeySet, type JWK } from "jose";
import {
  agentCredentialAudiences,
  agentCredentialsIssued,
  agents,
  auditLog,
  authSessions,
  createDb,
  eq,
  identitySigningKeys,
  inArray,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, stepUpActionDigest, type AgentCredentialAudienceCreate } from "@regulait/shared";
import { buildApp } from "./app.js";
import { agentCredentialStatusValue, forgetAgentCredentialStatusLists, ISSUED_CREDENTIAL_TRANSITIONS, mintAgentCredential, verifyAgentCredential } from "./agent-credential.js";
import { revokeDelegationGrant } from "./delegation.js";
import { TokenStatusList } from "./token-status-list.js";
import { agentCredentialAudienceStepUpArgs } from "./agent-credential-routes.js";
import { configuredIdentitySigningKeys, rotateIdentitySigningKey } from "./identity-signing-keys.js";
import { agentScopeItem, startInProcessChain } from "./in-process-delegation.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { grantAgentOwnGrantsForTest } from "./testing/agent-own-grants.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `ac315s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`ac315s-${RUN}`).digest("hex");
const PUBLIC = "https://regulait.test";
const ISSUER = `${PUBLIC}/agent-credentials`;
const SYSTEM = "00000000-0000-0000-0000-000000000000";

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let keyDir: string;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const restores: Array<() => Promise<void>> = [];
const audienceIds: string[] = [];
const agentIds: string[] = [];
let prevMode: { executionMode: typeof orgSettings.$inferSelect.executionMode; executionModeReason: string | null } | undefined;

type Method = "GET" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
/** the verifier's status-list fetch, through the real public route */
const statusList = async (uri: string) => {
  const r = await inject("GET", new URL(uri).pathname, {});
  if (r.statusCode !== 200) throw new Error(`status list ${r.statusCode}`);
  return r.body;
};

async function session(args?: StepUpCheckArgs) {
  const token = "rgls_" + randomBytes(32).toString("hex");
  const [s] = await db
    .insert(authSessions)
    .values({ tokenHash: hashToken(token), userId: adminId, origin: "password", expiresAt: new Date(Date.now() + 3_600_000), idleExpiresAt: new Date(Date.now() + 3_600_000), idleMinutes: 60 })
    .returning({ id: authSessions.id });
  let stepUp: string | null = null;
  if (args) {
    stepUp = "rgsu_" + randomBytes(24).toString("hex");
    await db.insert(stepUpGrants).values({ tokenHash: hashToken(stepUp), userId: adminId, sessionId: s!.id, method: "totp", actionKind: args.kind, actionDigest: stepUpActionDigest(args.kind, args.facts), expiresAt: new Date(Date.now() + 120_000) });
  }
  return (method: Method, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { ...CSRF, ...(stepUp ? { "x-regulait-step-up": stepUp } : {}) }, cookies: { regulait_session: token }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function mkAgent(label: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", AUTH, { name: `ac315s-${label}-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], model: "mock-1" });
  expect(r.statusCode, r.body).toBe(201);
  agentIds.push(r.json().id);
  return r.json().id as string;
}

async function register(body: AgentCredentialAudienceCreate): Promise<string> {
  const r = await (await session(agentCredentialAudienceStepUpArgs(body)))("POST", "/v1/agent-credentials/audiences", body);
  expect(r.statusCode, r.body).toBe(201);
  audienceIds.push(r.json().id);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  process.env.REGULAIT_PUBLIC_URL = PUBLIC;
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  keyDir = mkdtempSync(path.join(os.tmpdir(), "adr0315s-issuer-"));
  const pem = (k: KeyObject) => k.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem(generateKeyPairSync("ed25519").privateKey) + pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  for (const k of await configuredIdentitySigningKeys()) {
    const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys).where(eq(identitySigningKeys.algorithm, k.algorithm));
    if (recorded.length > 0) await rotateIdentitySigningKey(db, { kid: k.kid, actorUserId: SYSTEM });
  }
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const u = await inject("POST", "/v1/users", AUTH, { email: `ac315s-admin-${RUN}@example.com`, displayName: "ac315s admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id;
  await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, adminId));
}, 120_000);

afterAll(async () => {
  if (audienceIds.length) {
    await db.delete(agentCredentialsIssued).where(inArray(agentCredentialsIssued.audienceId, audienceIds));
    await db.delete(agentCredentialAudiences).where(inArray(agentCredentialAudiences.id, audienceIds));
  }
  if (prevMode) await db.update(orgSettings).set({ executionMode: prevMode.executionMode, executionModeReason: prevMode.executionModeReason }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  forgetAgentCredentialStatusLists();
  if (agentIds.length) await db.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(inArray(agents.id, agentIds));
  if (adminId) await db.update(users).set({ totpEnabled: false }).where(eq(users.id, adminId));
  await db.execute(sql`update identity_signing_keys set retired_at = now() where activated_at is not null and retired_at is null and revoked_at is null`);
  for (const r of restores.reverse()) await r();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  delete process.env[IDENTITY_SIGNING_KEY_ENV];
  rmSync(keyDir, { recursive: true, force: true });
  await app?.close();
});


describe("ADR-0315 slice 2: status list, revocation and the kill switch", () => {
  let x: string;
  let lead: string;
  let rootGrant: string;
  let leafGrant: string;
  let jkt: string;
  let audId: string;
  let audUri: string;
  let jwks: JSONWebKeySet;
  const fresh = () => forgetAgentCredentialStatusLists();
  const mint = () => mintAgentCredential(db, { grantId: leafGrant, audienceId: audId, holderJkt: jkt, dataKey: DATA_KEY });
  const verify = (token: string, extra: Partial<Parameters<typeof verifyAgentCredential>[1]> = {}) =>
    verifyAgentCredential(token, { jwks, issuer: ISSUER, audience: audUri, algorithm: "ES256", binding: "dpop", holderJkt: jkt, statusList, ...extra });

  it("declares the lifecycle once and derives each status value from it and the chain", () => {
    expect(ISSUED_CREDENTIAL_TRANSITIONS).toEqual({ issued: ["revoked"], revoked: [] });
    const at = new Date();
    expect(agentCredentialStatusValue({ revokedAt: null }, null)).toBe(0);
    expect(agentCredentialStatusValue({ revokedAt: at }, null)).toBe(1);
    expect(agentCredentialStatusValue({ revokedAt: null }, "grant_revoked")).toBe(1);
    expect(agentCredentialStatusValue({ revokedAt: null }, "unknown")).toBe(1);
    expect(agentCredentialStatusValue({ revokedAt: null }, "agent_halted")).toBe(2);
    expect(agentCredentialStatusValue({ revokedAt: null }, "org_halted")).toBe(2);
    expect(agentCredentialStatusValue({ revokedAt: at }, "org_halted")).toBe(1);
  });

  it("puts a status entry in every credential and publishes a signed list the verifier checks", async () => {
    x = await mkAgent("x");
    audUri = `https://mcp.status.test/${RUN}`;
    audId = await register({ audience: audUri, name: "status mcp", algorithm: "ES256", binding: "dpop", maxTtlSeconds: 300, scopes: [{ type: "agent", agentId: x, kind: "write", scope: "x.invoke" }] });
    const sponsor = await inject("POST", "/v1/users", AUTH, { email: `ac315s-ivy-${RUN}@example.com`, displayName: "ivy" });
    const ivy = sponsor.json().id as string;
    expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: ivy, agentId: x })).statusCode).toBeLessThan(300);
    lead = await mkAgent("lead");
    const worker = await mkAgent("worker");
    const own = [{ agentId: x, allowedModes: ["execute"] }];
    const leadId = await grantAgentOwnGrantsForTest(db, lead, { agents: own });
    const workerId = await grantAgentOwnGrantsForTest(db, worker, { agents: own });
    const scope = [agentScopeItem(x, "execute")];
    const chain = await startInProcessChain(db, {
      sponsorUserId: ivy, projectId: null, context: { runId: randomUUID() },
      hops: [{ identityId: leadId, scope, capMicros: 10_000 }, { identityId: workerId, scope, capMicros: 5_000 }],
    });
    rootGrant = chain.grantIds[0]!;
    leafGrant = chain.grantIds[chain.grantIds.length - 1]!;
    jkt = await calculateJwkThumbprint(await exportJWK(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey));

    const m = await mint();
    jwks = (await inject("GET", "/agent-credentials/.well-known/jwks.json", {})).json() as JSONWebKeySet;
    const [row] = await db.select().from(agentCredentialsIssued).where(eq(agentCredentialsIssued.jti, m.jti));
    const listId = Math.floor(row!.statusIndex / 65_536);
    expect(m.claims.status).toEqual({ status_list: { idx: row!.statusIndex % 65_536, uri: `${ISSUER}/status/${listId}` } });
    fresh();
    const r = await inject("GET", `/agent-credentials/status/${listId}`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["content-type"]).toContain("application/statuslist+jwt");
    const { payload, protectedHeader } = await jwtVerify(r.body, createLocalJWKSet(jwks), { algorithms: ["ES256"], typ: "statuslist+jwt", issuer: ISSUER, subject: `${ISSUER}/status/${listId}` });
    expect(protectedHeader.kid).toBeTruthy();
    expect(payload).toMatchObject({ ttl: 60, status_list: { bits: 2 } });
    expect((payload.exp as number) - (payload.iat as number)).toBe(120);
    expect(TokenStatusList.decode((payload as { status_list: { lst: string } }).status_list.lst, 2).get(m.claims.status.status_list.idx)).toBe(0);
    expect((await verify(m.token)).jti).toBe(m.jti);
    // the replica cache answers a second fetch with the same signed list
    expect((await inject("GET", `/agent-credentials/status/${listId}`, {})).body).toBe(r.body);
    // an unallocated list, and ids that are not one, are 404
    for (const bad of [String(listId + 1), "01", "-1", "x"]) expect((await inject("GET", `/agent-credentials/status/${bad}`, {})).statusCode).toBe(404);
  });

  it("revokes by jti: INVALID for verifiers, terminal, audited, and a sibling stays VALID", async () => {
    const a = await mint();
    const b = await mint();
    // NEGATIVE CONTROLS: an unknown jti, a malformed one, no reason
    expect((await inject("POST", `/v1/agent-credentials/issued/${"A".repeat(43)}/revoke`, AUTH, { reason: "x" })).statusCode).toBe(404);
    expect((await inject("POST", "/v1/agent-credentials/issued/short/revoke", AUTH, { reason: "x" })).statusCode).toBe(400);
    expect((await inject("POST", `/v1/agent-credentials/issued/${a.jti}/revoke`, AUTH, {})).statusCode).toBe(400);
    fresh();
    await verify(a.token);
    const r = await inject("POST", `/v1/agent-credentials/issued/${a.jti}/revoke`, AUTH, { reason: "key leaked" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ jti: a.jti, state: "revoked" });
    // no fresh(): the revocation drops this replica's cached list itself
    await expect(verify(a.token)).rejects.toThrow(/INVALID/);
    expect((await verify(b.token)).jti).toBe(b.jti);
    expect((await inject("POST", `/v1/agent-credentials/issued/${a.jti}/revoke`, AUTH, { reason: "again" })).statusCode).toBe(404);
    const audits = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'agent-credential-revoked' AND ${auditLog.detail}->>'jti' = ${a.jti}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.reason).toContain("key leaked");
    const list = await inject("GET", `/v1/agent-credentials/issued?grantId=${leafGrant}&limit=2`, AUTH);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().credentials.map((c: { jti: string; state: string }) => [c.jti, c.state])).toEqual([[b.jti, "issued"], [a.jti, "revoked"]]);
    const next = await inject("GET", `/v1/agent-credentials/issued?grantId=${leafGrant}&limit=2&before=${list.json().next}`, AUTH);
    expect(next.json().credentials.length).toBeGreaterThan(0);
    expect((await inject("GET", "/v1/agent-credentials/issued?limit=999", AUTH)).statusCode).toBe(400);
  });

  it("propagates the kill switch: SUSPENDED while an agent or the org is halted, VALID once lifted", async () => {
    const c = await mint();
    await db.update(agents).set({ haltedAt: sql`now()`, haltedReason: "test", haltedByUserId: adminId }).where(eq(agents.id, lead));
    fresh();
    await expect(verify(c.token)).rejects.toThrow(/SUSPENDED/);
    await db.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(agents.id, lead));
    fresh();
    expect((await verify(c.token)).jti).toBe(c.jti);

    const [before] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    prevMode = { executionMode: before!.executionMode, executionModeReason: before!.executionModeReason };
    await db.update(orgSettings).set({ executionMode: "halted", executionModeReason: "ac315s halt" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    fresh();
    await expect(verify(c.token)).rejects.toThrow(/SUSPENDED/);
    await db.update(orgSettings).set({ executionMode: prevMode.executionMode, executionModeReason: prevMode.executionModeReason }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    fresh();
    expect((await verify(c.token)).jti).toBe(c.jti);
  });

  it("fails closed on a list it cannot trust: unreadable, another key, another URI, expired", async () => {
    const c = await mint();
    fresh();
    const real = await statusList(c.claims.status.status_list.uri);
    await expect(verify(c.token, { statusList: async () => { throw new Error("network down"); } })).rejects.toThrow(/network down/);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const kid = JSON.parse(Buffer.from(real.split(".")[0]!, "base64url").toString()).kid;
    const forge = (claims: Record<string, unknown>) =>
      new SignJWT({ ttl: 60, status_list: decodeJwt(real).status_list as object, ...claims })
        .setProtectedHeader({ alg: "ES256", typ: "statuslist+jwt", kid })
        .setIssuer(ISSUER).setSubject(c.claims.status.status_list.uri).setIssuedAt().setExpirationTime("2m")
        .sign(other.privateKey);
    await expect(verify(c.token, { statusList: async () => forge({}) })).rejects.toThrow();
    await expect(verify(c.token, { statusList: async () => real.replace(/^[^.]+/, (h) => Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url").toString()), typ: "JWT" })).toString("base64url")) })).rejects.toThrow();
    // the real list for another URI, and the real list once it is past its exp
    const elsewhere = await statusList(`${ISSUER}/status/0`);
    if (!c.claims.status.status_list.uri.endsWith("/status/0")) await expect(verify(c.token, { statusList: async () => elsewhere })).rejects.toThrow();
    const exp = decodeJwt(real).exp!;
    await expect(verify(c.token, { statusList: async () => real, now: new Date((exp + 31) * 1000) })).rejects.toThrow();
    // control: the real list is accepted
    expect((await verify(c.token, { statusList: async () => real })).jti).toBe(c.jti);
  });

  it("passes the checks agentgateway's and Kong's JWT configurations document (modelled with jose)", async () => {
    const c = await mint();
    // agentgateway `traffic.jwtAuthentication`: issuer exact, `aud` contains one of `audiences`, keys from an inline
    // (or remote) JWKS; the algorithm comes from the key
    const provider = { mode: "Strict", issuer: ISSUER, audiences: [audUri], jwks: { inline: JSON.stringify(jwks) } };
    const ag = await jwtVerify(c.token, createLocalJWKSet(JSON.parse(provider.jwks.inline) as JSONWebKeySet), { issuer: provider.issuer, audience: provider.audiences });
    expect(ag.payload.jti).toBe(c.jti);
    // Kong `jwt` plugin: a consumer credential { key, algorithm, rsa_public_key: PEM } matched on `key_claim_name`,
    // `claims_to_verify` exp and nbf, and `maximum_expiration`
    const kid = JSON.parse(Buffer.from(c.token.split(".")[0]!, "base64url").toString()).kid as string;
    const jwk = jwks.keys.find((k) => k.kid === kid) as JWK;
    const credential = { key: ISSUER, algorithm: "ES256", rsa_public_key: await exportSPKI((await importJWK(jwk, "ES256")) as CryptoKey) };
    const plugin = { key_claim_name: "iss", claims_to_verify: ["exp", "nbf"], maximum_expiration: 900 };
    const kong = await jwtVerify(c.token, await importSPKI(credential.rsa_public_key, credential.algorithm), { algorithms: [credential.algorithm] });
    expect(kong.payload[plugin.key_claim_name]).toBe(credential.key);
    expect(kong.payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(plugin.maximum_expiration);
    // the documented gap: neither shape reads the status list, so a revoked credential still passes them; the verifier
    // guide therefore puts the status check (and, for Kong, `aud` and DPoP) at the upstream
    expect((await inject("POST", `/v1/agent-credentials/issued/${c.jti}/revoke`, AUTH, { reason: "shape test" })).statusCode).toBe(200);
    await expect(verify(c.token)).rejects.toThrow(/INVALID/);
    expect((await jwtVerify(c.token, await importSPKI(credential.rsa_public_key, "ES256"), { algorithms: ["ES256"] })).payload.jti).toBe(c.jti);
  });

  it("cascades a revoked ancestor grant to INVALID, derived from the grant rather than copied onto the row", async () => {
    const c = await mint();
    fresh();
    await verify(c.token);
    await revokeDelegationGrant(db, { grantId: rootGrant, reason: "admin" });
    fresh();
    await expect(verify(c.token)).rejects.toThrow(/INVALID/);
    // the stored state is still `issued`: the status is derived from the grant, not copied onto the row
    const [row] = await db.select().from(agentCredentialsIssued).where(eq(agentCredentialsIssued.jti, c.jti));
    expect(row!.revokedAt).toBeNull();
  });
});
