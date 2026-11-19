/**
 * ADR-0315 (G7, slice 1) — the portable agent credential on a real database through the real app:
 *
 *  - PUBLIC METADATA: the issuer's discovery document and a JWKS of public halves only.
 *  - DEFAULT-DENY REGISTRY: registering an audience needs a `settings_relax` step-up bound to the whole registration
 *    (refused without one and with one for another registration); a scope mapping must name a real resource.
 *  - MINT AND VERIFY OFFLINE: a lead → worker chain's credential carries the RFC 8693 `act` chain (outermost = the
 *    worker), the leaf's SPIFFE id as `client_id`, ONLY the mapped atoms the grant holds (never an unmapped one and
 *    never a mapped atom the grant lacks), the run budget, the grant, and `cnf.jkt`; the reference verifier accepts it
 *    with the pinned algorithm and refuses it under another algorithm, another audience, another DPoP key, or tampered.
 *  - REFUSALS (audited, never a narrower token): unknown audience, disabled audience, DPoP audience without a key,
 *    revoked grant, halted agent in the chain.
 *
 * Global state (M-068): signing keys are retired, env restored, and every row this file creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { fileURLToPath } from "node:url";
import { calculateJwkThumbprint, exportJWK, type JSONWebKeySet } from "jose";
import {
  agentCredentialAudiences,
  agentCredentialsIssued,
  agents,
  auditLog,
  authSessions,
  createDb,
  delegationGrants,
  eq,
  identitySigningKeys,
  inArray,
  runMigrations,
  sql,
  stepUpGrants,
  users,
  type Db,
} from "@regulait/db";
import { IDENTITY_SIGNING_KEY_ENV, stepUpActionDigest, type AgentCredentialAudienceCreate } from "@regulait/shared";
import { buildApp } from "./app.js";
import { AgentCredentialRefused, mintAgentCredential, projectScope, verifyAgentCredential } from "./agent-credential.js";
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
const BOOT = `ac315-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = createHash("sha256").update(`ac315-${RUN}`).digest("hex");
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

type Method = "GET" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

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
  const r = await inject("POST", "/v1/agents", AUTH, { name: `ac315-${label}-${RUN}`, provider: "mock", tier: 0, modes: ["execute"], model: "mock-1" });
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
  keyDir = mkdtempSync(path.join(os.tmpdir(), "adr0315-issuer-"));
  const pem = (k: KeyObject) => k.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path.join(keyDir, "issuer.pem"), pem(generateKeyPairSync("ed25519").privateKey) + pem(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey), { mode: 0o600 });
  process.env[IDENTITY_SIGNING_KEY_ENV] = path.join(keyDir, "issuer.pem");
  for (const k of await configuredIdentitySigningKeys()) {
    const recorded = await db.select({ kid: identitySigningKeys.kid }).from(identitySigningKeys).where(eq(identitySigningKeys.algorithm, k.algorithm));
    if (recorded.length > 0) await rotateIdentitySigningKey(db, { kid: k.kid, actorUserId: SYSTEM });
  }
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const u = await inject("POST", "/v1/users", AUTH, { email: `ac315-admin-${RUN}@example.com`, displayName: "ac315 admin" });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id;
  await db.update(users).set({ isAdmin: true, totpEnabled: true }).where(eq(users.id, adminId));
}, 120_000);

afterAll(async () => {
  if (audienceIds.length) {
    await db.delete(agentCredentialsIssued).where(inArray(agentCredentialsIssued.audienceId, audienceIds));
    await db.delete(agentCredentialAudiences).where(inArray(agentCredentialAudiences.id, audienceIds));
  }
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

describe("ADR-0315 projection (pure)", () => {
  const S = "11111111-1111-4111-8111-111111111111";
  const row = (over: Record<string, unknown>) => ({ id: randomUUID(), audienceId: randomUUID(), serverId: null, toolName: null, connectorId: null, agentId: null, ...over }) as never;
  it("keeps only mapped atoms the grant holds; write covers read, read never covers write", () => {
    const grant = [{ type: "mcp_tool" as const, serverId: S, toolNames: ["search"], kind: "read" as const }, { type: "agent" as const, agentId: S, modes: ["execute"], kind: "write" as const }];
    expect(projectScope(grant, [
      row({ resourceType: "mcp_tool", serverId: S, toolName: "search", kind: "read", scope: "tickets.read" }),
      row({ resourceType: "mcp_tool", serverId: S, toolName: "search", kind: "write", scope: "tickets.write" }),
      row({ resourceType: "mcp_tool", serverId: S, toolName: "delete", kind: "read", scope: "tickets.delete" }),
      row({ resourceType: "agent", agentId: S, kind: "read", scope: "agent.read" }),
      row({ resourceType: "connector", connectorId: S, kind: "read", scope: "crm.read" }),
    ])).toEqual(["agent.read", "tickets.read"]);
    expect(projectScope(grant, [])).toEqual([]);
  });
});

describe("ADR-0315 agent credential", () => {
  let x: string;
  let y: string;
  let z: string;
  let lead: string;
  let leafGrant: string;
  let jkt: string;

  it("publishes discovery and a public-only JWKS", async () => {
    const d = await inject("GET", "/agent-credentials/.well-known/openid-configuration", {});
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, regulait_typ: "at+jwt" });
    const j = await inject("GET", "/agent-credentials/.well-known/jwks.json", {});
    expect(j.statusCode).toBe(200);
    // a signer is activated on first use, so the keys are checked after the first mint (below)
    expect(Array.isArray(j.json().keys)).toBe(true);
  });

  it("registers an audience only with the step-up bound to that exact registration", async () => {
    x = await mkAgent("x");
    y = await mkAgent("y");
    z = await mkAgent("z");
    const body: AgentCredentialAudienceCreate = {
      audience: `https://mcp.vendor.test/${RUN}`, name: "vendor mcp", algorithm: "ES256", binding: "dpop", maxTtlSeconds: 300,
      scopes: [{ type: "agent", agentId: x, kind: "write", scope: "x.invoke" }, { type: "agent", agentId: z, kind: "write", scope: "z.invoke" }],
    };
    // NEGATIVE CONTROLS: no step-up; a step-up for another registration (bearer instead of dpop)
    expect((await (await session())("POST", "/v1/agent-credentials/audiences", body)).statusCode).toBe(403);
    expect((await (await session(agentCredentialAudienceStepUpArgs({ ...body, binding: "bearer" })))("POST", "/v1/agent-credentials/audiences", body)).statusCode).toBe(403);
    expect((await db.select().from(agentCredentialAudiences).where(eq(agentCredentialAudiences.audience, body.audience))).length).toBe(0);
    // shape and resource checks come before the step-up
    expect((await inject("POST", "/v1/agent-credentials/audiences", AUTH, { ...body, audience: "http://insecure.test/" })).statusCode).toBe(400);
    expect((await inject("POST", "/v1/agent-credentials/audiences", AUTH, { ...body, scopes: [{ type: "agent", agentId: randomUUID(), kind: "read", scope: "a" }] })).statusCode).toBe(400);

    const id = await register(body);
    const [a] = await db.select().from(auditLog).where(eq(auditLog.objectId, id));
    expect(a!.ruleId).toBe("agent-credential-audience-registered");
    const list = await inject("GET", "/v1/agent-credentials/audiences", AUTH);
    expect(list.json().audiences.find((r: { id: string }) => r.id === id).scopes).toHaveLength(2);
    expect((await (await session(agentCredentialAudienceStepUpArgs(body)))("POST", "/v1/agent-credentials/audiences", body)).statusCode).toBe(409);
  });

  it("mints a credential that verifies offline, carries the chain, and never more than the grant", async () => {
    const sponsor = await inject("POST", "/v1/users", AUTH, { email: `ac315-ivy-${RUN}@example.com`, displayName: "ivy" });
    const ivy = sponsor.json().id as string;
    for (const a of [x, y]) expect((await inject("POST", "/v1/grants/agents", AUTH, { userId: ivy, agentId: a })).statusCode).toBeLessThan(300);
    lead = await mkAgent("lead");
    const worker = await mkAgent("worker");
    const both = [{ agentId: x, allowedModes: ["execute"] }, { agentId: y, allowedModes: ["execute"] }];
    const leadId = await grantAgentOwnGrantsForTest(db, lead, { agents: both });
    const workerId = await grantAgentOwnGrantsForTest(db, worker, { agents: both });
    const scope = [agentScopeItem(x, "execute"), agentScopeItem(y, "execute")];
    const chain = await startInProcessChain(db, {
      sponsorUserId: ivy, projectId: null, context: { runId: randomUUID() },
      hops: [{ identityId: leadId, scope, capMicros: 10_000 }, { identityId: workerId, scope, capMicros: 5_000 }],
    });
    leafGrant = chain.grantIds[chain.grantIds.length - 1]!;
    const holder = generateKeyPairSync("ec", { namedCurve: "P-256" });
    jkt = await calculateJwkThumbprint(await exportJWK(holder.publicKey));
    const [aud] = await db.select().from(agentCredentialAudiences).where(eq(agentCredentialAudiences.audience, `https://mcp.vendor.test/${RUN}`));

    const minted = await mintAgentCredential(db, { grantId: leafGrant, audienceId: aud!.id, holderJkt: jkt, dataKey: DATA_KEY });
    const jwks = (await inject("GET", "/agent-credentials/.well-known/jwks.json", {})).json() as JSONWebKeySet;
    const opts = { jwks, issuer: ISSUER, audience: aud!.audience, algorithm: "ES256" as const, binding: "dpop" as const, holderJkt: jkt };
    expect(jwks.keys.find((k) => k.kid === minted.kid)).toMatchObject({ alg: "ES256", kty: "EC" });
    expect(jwks.keys.some((k) => "d" in k)).toBe(false);
    const claims = await verifyAgentCredential(minted.token, opts);
    // scope: x is mapped and held; y is held but unmapped; z is mapped but not held
    expect(claims.scope).toBe("x.invoke");
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.regulait_grant).toBe(leafGrant);
    expect(claims.regulait_budget).toEqual({ currency: "USD", cap_micros: 5000, remaining_micros: 5000 });
    expect(claims.cnf).toEqual({ jkt });
    expect(claims.client_id).toMatch(/^spiffe:\/\/.+\/regulait\/agent\//);
    expect(claims.act?.sub).toBe(claims.client_id);
    expect(claims.act?.act?.sub).toMatch(/^spiffe:\/\//);
    expect(claims.act?.act?.sub).not.toBe(claims.client_id);
    expect(claims.sub).not.toContain(ivy);
    // NEGATIVE CONTROLS for the verifier
    await expect(verifyAgentCredential(minted.token, { ...opts, algorithm: "EdDSA" })).rejects.toThrow();
    await expect(verifyAgentCredential(minted.token, { ...opts, audience: "https://other.test/" })).rejects.toThrow();
    await expect(verifyAgentCredential(minted.token, { ...opts, holderJkt: "x".repeat(43) })).rejects.toThrow(/cnf\.jkt/);
    const [h, p, s] = minted.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), scope: "x.invoke z.invoke" })).toString("base64url");
    await expect(verifyAgentCredential(`${h}.${forged}.${s}`, opts)).rejects.toThrow();
    // evidence: the issued row and its audit (never the token)
    const [issued] = await db.select().from(agentCredentialsIssued).where(eq(agentCredentialsIssued.jti, minted.jti));
    expect(issued).toMatchObject({ grantId: leafGrant, audienceId: aud!.id, revokedAt: null });
    const audits = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'agent-credential-issued' AND ${auditLog.detail}->>'jti' = ${minted.jti}`);
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.detail)).not.toContain(minted.token);
  });

  it("refuses, audited, rather than narrowing: unknown or disabled audience, no DPoP key, a halted agent, a revoked grant", async () => {
    const [aud] = await db.select().from(agentCredentialAudiences).where(eq(agentCredentialAudiences.audience, `https://mcp.vendor.test/${RUN}`));
    const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AgentCredentialRefused | null)?.code;
    expect(await code(mintAgentCredential(db, { grantId: leafGrant, audienceId: randomUUID(), holderJkt: jkt, dataKey: DATA_KEY }))).toBe("audience_unknown");
    expect(await code(mintAgentCredential(db, { grantId: leafGrant, audienceId: aud!.id, holderJkt: null, dataKey: DATA_KEY }))).toBe("dpop_required");
    await db.update(agents).set({ haltedAt: sql`now()`, haltedReason: "test", haltedByUserId: adminId }).where(eq(agents.id, lead));
    expect(await code(mintAgentCredential(db, { grantId: leafGrant, audienceId: aud!.id, holderJkt: jkt, dataKey: DATA_KEY }))).toBe("agent_halted");
    await db.update(agents).set({ haltedAt: null, haltedReason: null, haltedByUserId: null }).where(eq(agents.id, lead));
    // a bearer EdDSA audience mints EdDSA with no cnf (control: the chain is mintable again once the halt is lifted)
    const bearer = await register({ audience: `https://gw.vendor.test/${RUN}`, name: "gateway", algorithm: "EdDSA", binding: "bearer", maxTtlSeconds: 120, scopes: [{ type: "agent", agentId: x, kind: "write", scope: "x" }] });
    const ed = await mintAgentCredential(db, { grantId: leafGrant, audienceId: bearer, holderJkt: null, dataKey: DATA_KEY });
    const jwks = (await inject("GET", "/agent-credentials/.well-known/jwks.json", {})).json() as JSONWebKeySet;
    const edClaims = await verifyAgentCredential(ed.token, { jwks, issuer: ISSUER, audience: `https://gw.vendor.test/${RUN}`, algorithm: "EdDSA", binding: "bearer" });
    expect(edClaims.cnf).toBeUndefined();
    expect(edClaims.exp - edClaims.iat).toBe(120);
    const [relaxed] = await db.select().from(auditLog).where(eq(auditLog.objectId, bearer));
    expect(relaxed!.ruleId).toBe("agent-credential-audience-registered-relaxed");
    // disable is free and immediate
    expect((await inject("POST", `/v1/agent-credentials/audiences/${bearer}/disable`, AUTH, {})).statusCode).toBe(200);
    expect(await code(mintAgentCredential(db, { grantId: leafGrant, audienceId: bearer, holderJkt: null, dataKey: DATA_KEY }))).toBe("audience_disabled");
    // a revoked grant is not live
    await db.update(delegationGrants).set({ revokedAt: sql`now()`, revokedReason: "admin" }).where(eq(delegationGrants.id, leafGrant));
    expect(await code(mintAgentCredential(db, { grantId: leafGrant, audienceId: aud!.id, holderJkt: jkt, dataKey: DATA_KEY }))).toBe("grant_not_live");
    const refusals = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'agent-credential-refused' AND ${auditLog.detail}->>'grantId' = ${leafGrant}`);
    expect(refusals.map((r) => (r.detail as { code: string }).code).sort()).toEqual(["agent_halted", "audience_disabled", "audience_unknown", "dpop_required", "grant_not_live"]);
  });
});
