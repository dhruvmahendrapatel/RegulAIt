/**
 * ADR-0188 S6 backend, through the real app: the last seven identity routes
 * that answered 501 (`oauth/identity-admin.ts`).
 *  - create: an identity starts active with no grants; default identifier, or an exact SPIFFE ID for an external
 *    kind only, never in the reserved namespace; one identity per subject, ever; stewards are enabled people;
 *  - revoke: terminal; its credentials, its tokens and every grant naming it end with it;
 *  - credentials: public halves only; a key is registered once, ever; the window is capped; revoking one revokes
 *    every token it authenticated or that is bound to its key, and every grant it authenticated (decision 12);
 *  - grant proposals: observed use in the audit log, minus what is already granted, `proposedSet` holding only
 *    what a steward holds, accepted through the ordinary grant PUT;
 *  - picker sources: only existing objects, subjects that have no identity, enabled people, active workers;
 *  - authz: admin-only on every route; an admin API key cannot step up; a step-up is bound to exactly the write
 *    and is not spent on another; every refusal of a write writes a deny row and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  delegationGrants,
  eq,
  identitySigningKeys,
  issuedTokens,
  runMigrations,
  runWithAuditActor,
  sql,
  stepUpGrants,
  users,
  workloadCredentials,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { resolveDeployMode } from "./deploy-posture.js";
import { createRootGrant } from "./delegation.js";
import { agentScopeItem, resolveTrustDomain } from "./in-process-delegation.js";
import { identityCreateStepUp } from "./oauth/identity-admin.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { makeCert } from "./testing/x509-fixtures.js";
import { hashToken } from "./token-hash.js";
import { putIdentityGrants } from "./workload-identity-admin.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s6-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const ENV = "staging";
const AUDIENCE = "https://gateway.example.test/mcp/s6";
const DAY_MS = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let restoreIdentity: (() => Promise<void>) | undefined;
let signingKid: string;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `s6-${label}-${RUN}@example.com`, displayName: `s6 ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function mkAgent(label: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", AUTH, { name: `s6-${label}-${RUN}`, provider: "mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 2, model: `s6-model-${label}-${RUN}` });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const grantUserAgent = (userId: string, agentId: string) => inject("POST", "/v1/grants/agents", AUTH, { userId, agentId });
const auditRows = (objectId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));
const publicEd25519 = () => {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as Record<string, string>;
  return { kty: "OKP", crv: "Ed25519", x: jwk.x! };
};

/** an identity for a fresh agent, stewarded by `stewardId`, allowed in ENV, created through the route */
async function agentIdentity(label: string, stewardId: string): Promise<{ id: string; agentId: string }> {
  const agentId = await mkAgent(label);
  const r = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId, sponsorUserIds: [stewardId], environments: [ENV] });
  expect(r.statusCode, r.body).toBe(201);
  return { id: r.json().id as string, agentId };
}

/** an external (DPoP-bound) root grant authenticated by `credentialId`, and one issued token for it */
async function externalGrantWithToken(sponsorUserId: string, identityId: string, scopeAgentId: string, credentialId: string, thumbprint: string) {
  const grant = await createRootGrant(db, {
    sponsorUserId,
    actorIdentityId: identityId,
    scope: [agentScopeItem(scopeAgentId, "execute")],
    capMicros: null,
    environment: ENV,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    projectId: null,
    binding: { kind: "dpop", thumbprint, authCredentialId: credentialId, audience: AUDIENCE },
  });
  const jti = randomBytes(24).toString("base64url");
  await db.insert(issuedTokens).values({
    jti,
    grantId: grant.id,
    authCredentialId: credentialId,
    signingKid,
    bindingKind: "dpop",
    bindingThumbprint: thumbprint,
    audience: AUDIENCE,
    env: ENV,
    issuedAt: sql`now()`,
    expiresAt: sql`now() + interval '300 seconds'`,
  } as never);
  return { grantId: grant.id, jti };
}

/** a person who holds agent X (all modes) and an identity granted X/execute with one live JWK credential */
async function credentialedIdentity(label: string) {
  const steward = await mkUser(`${label}-steward`);
  const x = await mkAgent(`${label}-x`);
  expect((await grantUserAgent(steward.id, x)).statusCode).toBeLessThan(300);
  const ident = await agentIdentity(`${label}-subject`, steward.id);
  await putIdentityGrants(db, ident.id, { tools: [], servers: [], agents: [{ agentId: x, allowedModes: ["execute"] }], connectors: [], roleIds: [], revision: 0 }, null);
  const add = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: publicEd25519() });
  expect(add.statusCode, add.body).toBe(201);
  return { steward, x, ident, credential: add.json() as { id: string; jwkThumbprint: string } };
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
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // an admin API key here pins "no step-up possible", not MFA (restored in afterAll, M-068)
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "6".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // an issuer key row for the issued-token fixtures: revoked from the start, so it is never published or used to sign
  signingKid = `s6-${RUN}`;
  const issuerJwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as Record<string, string>;
  await db.insert(identitySigningKeys).values({ kid: signingKid, publicJwk: { kty: "OKP", crv: "Ed25519", x: issuerJwk.x! }, revokedAt: sql`now()` } as never);
}, 120_000);

afterAll(async () => {
  await restoreGates();
  await restoreIdentity?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("POST /v1/workload-identities", () => {
  it("creates an external worker: active, the default identifier, no grants, audited", async () => {
    const steward = await mkUser("create-steward");
    const r = await inject("POST", "/v1/workload-identities", AUTH, { kind: "worker_runtime", sponsorUserIds: [steward.id], environments: [ENV] });
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ kind: "worker_runtime", status: "active", sponsorUserIds: [steward.id], environments: [ENV], grantsRevision: 0, agentId: null });
    expect(body.identifier).toBe(`spiffe://${resolveTrustDomain()}/regulait/worker_runtime/${body.id}`);
    const grants = await inject("GET", `/v1/workload-identities/${body.id}/grants`, AUTH);
    expect(grants.json()).toMatchObject({ revision: 0, tools: [], servers: [], agents: [], connectors: [], roleIds: [] });
    const [row] = await auditRows(body.id, "workload-identity-created");
    expect(row).toMatchObject({ effect: "allow" });
    expect(row!.detail).toMatchObject({ phase: "create", origin: "admin", kind: "worker_runtime", grants: "none" });
  });

  it("one identity per subject, ever: a second create for the same agent is refused 409 and audited", async () => {
    const steward = await mkUser("dup-steward");
    const ident = await agentIdentity("dup-subject", steward.id);
    const again = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId: ident.agentId, sponsorUserIds: [steward.id], environments: [] });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("identity_exists");
    const [deny] = await auditRows(ident.agentId, "workload-identity-create-refused");
    expect(deny).toMatchObject({ effect: "deny" });
    expect(deny!.detail).toMatchObject({ code: "identity_exists", kind: "agent" });
    expect(await db.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, ident.agentId))).toHaveLength(1);
  });

  it("an exact SPIFFE ID only for an external kind, never twice, never in the reserved namespace", async () => {
    const steward = await mkUser("spiffe-steward");
    const custom = `spiffe://example.org/s6/worker-${RUN}`;
    const ok = await inject("POST", "/v1/workload-identities", AUTH, { kind: "worker_runtime", identifier: custom, sponsorUserIds: [steward.id], environments: [] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().identifier).toBe(custom);
    const taken = await inject("POST", "/v1/workload-identities", AUTH, { kind: "pdp", identifier: custom, sponsorUserIds: [steward.id], environments: [] });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.json().error).toBe("identifier_taken");
    const agentId = await mkAgent("spiffe-agent");
    const internal = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId, identifier: `spiffe://example.org/s6/agent-${RUN}`, sponsorUserIds: [steward.id], environments: [] });
    expect(internal.statusCode, internal.body).toBe(422);
    expect(internal.json().error).toBe("identifier_not_allowed");
    const reserved = await inject("POST", "/v1/workload-identities", AUTH, {
      kind: "worker_runtime",
      identifier: `spiffe://${resolveTrustDomain()}/regulait/worker_runtime/${randomUUID()}`,
      sponsorUserIds: [steward.id],
      environments: [],
    });
    expect(reserved.statusCode, reserved.body).toBe(422);
    expect(reserved.json().error).toBe("identifier_reserved");
    // the refused agent got no identity
    expect(await db.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, agentId))).toHaveLength(0);
  });

  it("refuses a missing or disabled steward, a missing subject and a malformed body; nothing is created", async () => {
    const disabled = await mkUser("disabled-steward");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id));
    const agentId = await mkAgent("steward-subject");
    for (const stewardId of [randomUUID(), disabled.id, "00000000-0000-0000-0000-000000000000"]) {
      const r = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId, sponsorUserIds: [stewardId], environments: [] });
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json().error).toBe("steward_not_found");
    }
    expect(await db.select().from(workloadIdentities).where(eq(workloadIdentities.agentId, agentId))).toHaveLength(0);
    expect((await auditRows(agentId, "workload-identity-create-refused")).length).toBe(3);
    const steward = await mkUser("subject-steward");
    const missing = randomUUID();
    const nosubject = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", agentId: missing, sponsorUserIds: [steward.id], environments: [] });
    expect(nosubject.statusCode, nosubject.body).toBe(404);
    expect(nosubject.json().error).toBe("subject_not_found");
    expect(await auditRows(missing, "workload-identity-create-refused")).toHaveLength(1);
    const malformed = await inject("POST", "/v1/workload-identities", AUTH, { kind: "agent", sponsorUserIds: [steward.id], environments: [] });
    expect(malformed.statusCode, malformed.body).toBe(400);
    const bad = await inject("POST", "/v1/workload-identities", AUTH, { kind: "worker_runtime", sponsorUserIds: [steward.id], environments: ["Not An Env"] });
    expect(bad.statusCode, bad.body).toBe(400);
  });
});

describe("POST /v1/workload-identities/:id/revoke", () => {
  it("is terminal and ends its credentials, tokens and grants with it; a second revoke is refused", async () => {
    const { steward, x, ident, credential } = await credentialedIdentity("revoke");
    const { grantId, jti } = await externalGrantWithToken(steward.id, ident.id, x, credential.id, credential.jwkThumbprint);
    const r = await inject("POST", `/v1/workload-identities/${ident.id}/revoke`, AUTH, {});
    expect(r.statusCode, r.body).toBe(200);
    const out = r.json();
    expect(out.identity).toMatchObject({ id: ident.id, status: "revoked" });
    expect(out.credentialsRevoked).toBe(1);
    expect(out.tokensRevoked).toBe(1);
    expect(out.grantsRevoked).toContain(grantId);
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grantId));
    expect(g!.revokedAt).not.toBeNull();
    expect(g!.revokedReason).toBe("identity_revoked");
    const [cred] = await db.select().from(workloadCredentials).where(eq(workloadCredentials.id, credential.id));
    expect(cred!.revokedAt).not.toBeNull();
    const [tok] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, jti));
    expect(tok!.revokedAt).not.toBeNull();
    const [row] = await auditRows(ident.id, "workload-identity-revoked");
    expect(row).toMatchObject({ effect: "allow" });

    const again = await inject("POST", `/v1/workload-identities/${ident.id}/revoke`, AUTH, {});
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("identity_already_revoked");
    expect(await auditRows(ident.id, "workload-identity-revoke-refused")).toHaveLength(1);
    // terminal: it cannot be reinstated, nor given a credential
    const reinstate = await inject("PATCH", `/v1/workload-identities/${ident.id}`, AUTH, { status: "active" });
    expect(reinstate.statusCode).toBe(409);
    const cred2 = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: publicEd25519() });
    expect(cred2.statusCode, cred2.body).toBe(409);
    expect(cred2.json().error).toBe("identity_not_active");
  });

  it("an unknown identity is 404, audited; a body is refused", async () => {
    const missing = randomUUID();
    const r = await inject("POST", `/v1/workload-identities/${missing}/revoke`, AUTH, {});
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error).toBe("identity_not_found");
    expect(await auditRows(missing, "workload-identity-revoke-refused")).toHaveLength(1);
    const withBody = await inject("POST", `/v1/workload-identities/${missing}/revoke`, AUTH, { reason: "x" });
    expect(withBody.statusCode).toBe(400);
  });
});

describe("credentials", () => {
  it("binds a public JWK (members only, capped window), never the same key twice, never a private key", async () => {
    const steward = await mkUser("cred-steward");
    const ident = await agentIdentity("cred-subject", steward.id);
    const empty = await inject("GET", `/v1/workload-identities/${ident.id}/credentials`, AUTH);
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [] });

    const jwk = publicEd25519();
    const r = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: { ...jwk, kid: "mine", use: "sig" } });
    expect(r.statusCode, r.body).toBe(201);
    const view = r.json();
    expect(view.publicJwk).toEqual(jwk);
    expect(view.jwkThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const window = Date.parse(view.notAfter) - Date.parse(view.notBefore);
    expect(window).toBe(90 * DAY_MS);
    const [added] = await auditRows(ident.id, "workload-credential-added");
    expect(added!.detail).toMatchObject({ phase: "credential_add", credentialId: view.id, kind: "jwk", thumbprint: view.jwkThumbprint });
    expect(JSON.stringify(added!.detail)).not.toContain('"d"');

    const listed = await inject("GET", `/v1/workload-identities/${ident.id}/credentials`, AUTH);
    expect(listed.json().items.map((c: { id: string }) => c.id)).toEqual([view.id]);

    const dup = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: jwk });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().error).toBe("credential_already_registered");
    expect(await auditRows(ident.id, "workload-credential-refused")).toHaveLength(1);

    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const secret = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: priv });
    expect(secret.statusCode, secret.body).toBe(400);
    const tooLong = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, {
      kind: "jwk",
      publicJwk: publicEd25519(),
      notAfter: new Date(Date.now() + 91 * DAY_MS).toISOString(),
    });
    expect(tooLong.statusCode, tooLong.body).toBe(422);
    expect(tooLong.json().error).toBe("credential_not_after");
    const past = await inject("POST", `/v1/workload-identities/${ident.id}/credentials`, AUTH, { kind: "jwk", publicJwk: publicEd25519(), notAfter: new Date(Date.now() - 60_000).toISOString() });
    expect(past.statusCode, past.body).toBe(422);
    // only the first key was stored
    expect(await db.select().from(workloadCredentials).where(eq(workloadCredentials.identityId, ident.id))).toHaveLength(1);
    expect((await inject("GET", `/v1/workload-identities/${randomUUID()}/credentials`, AUTH)).statusCode).toBe(404);
  });

  it("binds a self-signed certificate until its own expiry; refuses a private key in the PEM and an unconfigured SPIFFE domain", async () => {
    const steward = await mkUser("cert-steward");
    const r0 = await inject("POST", "/v1/workload-identities", AUTH, { kind: "worker_runtime", sponsorUserIds: [steward.id], environments: [ENV] });
    const identityId = r0.json().id as string;
    const cert = await makeCert({ name: `s6-cert-${RUN}` });
    const r = await inject("POST", `/v1/workload-identities/${identityId}/credentials`, AUTH, { kind: "x509", certificatePem: cert.pem, selfSigned: true });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ kind: "x509", selfSigned: true, publicJwk: null, jwkThumbprint: null });
    expect(Math.abs(Date.parse(r.json().notAfter) - cert.cert.notAfter.value.getTime())).toBeLessThan(1000);
    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const withKey = await inject("POST", `/v1/workload-identities/${identityId}/credentials`, AUTH, { kind: "x509", certificatePem: (await makeCert()).pem + priv, selfSigned: true });
    expect(withKey.statusCode, withKey.body).toBe(422);
    expect(withKey.json().error).toBe("credential_private_material");
    const spiffe = await inject("POST", `/v1/workload-identities/${identityId}/credentials`, AUTH, { kind: "spiffe_id", spiffeId: `spiffe://unconfigured-${RUN}.example/w` });
    expect(spiffe.statusCode, spiffe.body).toBe(422);
    expect(spiffe.json().error).toBe("spiffe_trust_domain_unknown");
    expect(await db.select().from(workloadCredentials).where(eq(workloadCredentials.identityId, identityId))).toHaveLength(1);
  });

  it("DELETE revokes (never deletes) the credential, the tokens it authenticated or binds, and the grants it authenticated", async () => {
    const { steward, x, ident, credential } = await credentialedIdentity("cred-revoke");
    const { grantId, jti } = await externalGrantWithToken(steward.id, ident.id, x, credential.id, credential.jwkThumbprint);
    const r = await inject("DELETE", `/v1/workload-identities/${ident.id}/credentials/${credential.id}`, AUTH);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().credential).toMatchObject({ id: credential.id });
    expect(r.json().credential.revokedAt).not.toBeNull();
    expect(r.json().tokensRevoked).toBe(1);
    expect(r.json().grantsRevoked).toContain(grantId);
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grantId));
    expect(g!.revokedReason).toBe("credential_revoked");
    const [tok] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, jti));
    expect(tok!.revokedAt).not.toBeNull();
    expect(await db.select().from(workloadCredentials).where(eq(workloadCredentials.id, credential.id))).toHaveLength(1);
    expect(await auditRows(ident.id, "workload-credential-revoked")).toHaveLength(1);
    // the identity stays active: only the credential ended
    expect((await inject("GET", `/v1/workload-identities/${ident.id}`, AUTH)).json().status).toBe("active");

    const again = await inject("DELETE", `/v1/workload-identities/${ident.id}/credentials/${credential.id}`, AUTH);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("credential_already_revoked");
    const other = await agentIdentity("cred-revoke-other", steward.id);
    const wrongOwner = await inject("DELETE", `/v1/workload-identities/${other.id}/credentials/${credential.id}`, AUTH);
    expect(wrongOwner.statusCode, wrongOwner.body).toBe(404);
    expect(wrongOwner.json().error).toBe("credential_not_found");
    expect((await auditRows(ident.id, "workload-credential-refused")).length + (await auditRows(other.id, "workload-credential-refused")).length).toBe(2);
  });
});

describe("GET /v1/workload-identities/:id/grant-proposals", () => {
  it("proposes what was observed and not granted; proposedSet holds only what a steward holds; accepted through the PUT", async () => {
    const steward = await mkUser("prop-steward");
    const held = await mkAgent("prop-held");
    const unheld = await mkAgent("prop-unheld");
    const already = await mkAgent("prop-already");
    for (const a of [held, already]) expect((await grantUserAgent(steward.id, a)).statusCode).toBeLessThan(300);
    const ident = await agentIdentity("prop-subject", steward.id);
    await putIdentityGrants(db, ident.id, { tools: [], servers: [], agents: [{ agentId: already, allowedModes: ["plan"] }], connectors: [], roleIds: [], revision: 0 }, null);
    const server = await inject("POST", "/v1/servers", AUTH, { name: `s6-prop-server-${RUN}`, url: "http://127.0.0.1:9" });
    expect(server.statusCode, server.body).toBe(201);

    // observed decisions, stamped with the identity as the acting agent the way the governed paths stamp them
    const stamp = { actorIdentityId: ident.id, delegationGrantId: randomUUID(), actorChain: [ident.id] };
    const decision = (values: Record<string, unknown>) =>
      runWithAuditActor(stamp, () => db.insert(auditLog).values({ userId: steward.id, ruleChain: [], reason: "s6 observed", ...values } as never));
    for (let i = 0; i < 2; i++) await decision({ objectType: "agent", objectId: held, effect: "deny", ruleId: "actor-allow-list", detail: { phase: "delegated-dispatch", mode: "execute", receiptClass: "decision" } });
    await decision({ objectType: "agent", objectId: unheld, effect: "deny", ruleId: "actor-allow-list", detail: { mode: "execute", receiptClass: "decision" } });
    await decision({ objectType: "agent", objectId: already, effect: "allow", ruleId: "agent-allow-list", detail: { mode: "plan", receiptClass: "decision" } });
    // unproposable: a tool the server does not have, and a connector call that named no object
    await decision({ objectType: "mcp_tool", serverId: server.json().id, toolName: "no_such_tool", effect: "deny", ruleId: "actor-allow-list", detail: { receiptClass: "decision" } });
    await decision({ objectType: "connector", objectId: randomUUID(), effect: "deny", ruleId: "actor-allow-list", detail: { operation: "read", receiptClass: "decision" } });
    // not a decision, and not this identity: ignored
    await decision({ objectType: "agent", objectId: unheld, effect: "allow", ruleId: "x", detail: { mode: "execute", receiptClass: "configuration" } });

    const r = await inject("GET", `/v1/workload-identities/${ident.id}/grant-proposals`, AUTH);
    expect(r.statusCode, r.body).toBe(200);
    const view = r.json();
    expect(view).toMatchObject({ identityId: ident.id, windowDays: 30, revision: 1, unproposable: 2, truncated: false });
    const byAgent = new Map(view.proposals.map((p: { grant: { agentId?: string } }) => [p.grant.agentId, p]));
    expect(byAgent.get(held)).toMatchObject({ grant: { kind: "agent", agentId: held, allowedModes: ["execute"] }, observedCalls: 2, refusedCalls: 2, heldByStewards: true });
    expect(byAgent.get(unheld)).toMatchObject({ grant: { kind: "agent", agentId: unheld, allowedModes: ["execute"] }, observedCalls: 1, heldByStewards: false });
    expect(byAgent.has(already)).toBe(false);
    expect(view.proposedSet.revision).toBe(1);
    expect(view.proposedSet.agents).toEqual(
      expect.arrayContaining([
        { agentId: already, allowedModes: ["plan"] },
        { agentId: held, allowedModes: ["execute"] },
      ]),
    );
    expect(view.proposedSet.agents.some((g: { agentId: string }) => g.agentId === unheld)).toBe(false);
    // reading changed nothing
    expect((await inject("GET", `/v1/workload-identities/${ident.id}/grants`, AUTH)).json().revision).toBe(1);

    // accepted through the ordinary grant PUT (step-up and steward check)
    const accept = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, AUTH, view.proposedSet);
    expect(accept.statusCode, accept.body).toBe(200);
    expect(accept.json().revision).toBe(2);
    const after = (await inject("GET", `/v1/workload-identities/${ident.id}/grant-proposals`, AUTH)).json();
    expect(after.proposals.map((p: { grant: { agentId?: string } }) => p.grant.agentId)).toEqual([unheld]);
    expect((await inject("GET", `/v1/workload-identities/${randomUUID()}/grant-proposals`, AUTH)).statusCode).toBe(404);
  });
});

describe("GET /v1/identity/picker-sources", () => {
  it("offers enabled people, subjects with no identity, environments in use and active workers", async () => {
    const person = await mkUser("picker-person");
    const disabled = await mkUser("picker-disabled");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id));
    const free = await mkAgent("picker-free");
    const owned = await agentIdentity("picker-owned", person.id);
    const worker = await inject("POST", "/v1/workload-identities", AUTH, { kind: "worker_runtime", sponsorUserIds: [person.id], environments: [`s6-${RUN}`] });
    expect(worker.statusCode, worker.body).toBe(201);
    const r = await inject("GET", "/v1/identity/picker-sources", AUTH);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    // a shared test database can hold more than the cap; membership is asserted only where nothing was cut
    if (!v.truncated) {
      expect(v.sponsors.some((p: { id: string }) => p.id === person.id)).toBe(true);
      expect(v.subjects.agent.some((o: { id: string }) => o.id === free)).toBe(true);
      expect(v.workerIdentities.some((o: { id: string }) => o.id === worker.json().id)).toBe(true);
    }
    expect(v.sponsors.some((p: { id: string }) => p.id === disabled.id)).toBe(false);
    expect(v.sponsors.some((p: { id: string }) => p.id === "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(v.subjects.agent.some((o: { id: string }) => o.id === owned.agentId)).toBe(false);
    expect(v.environments).toEqual(expect.arrayContaining([resolveDeployMode(), ENV, `s6-${RUN}`]));
    expect(Object.keys(v).sort()).toEqual(["agents", "connectors", "environments", "roles", "servers", "sponsors", "subjects", "truncated", "workerIdentities"]);
  });
});

describe("authorisation and step-up", () => {
  it("a non-admin is refused 403 admin_only on every S6 route", async () => {
    const member = await mkUser("member");
    const steward = await mkUser("authz-steward");
    const ident = await agentIdentity("authz-subject", steward.id);
    const calls: Array<[Method, string, unknown?]> = [
      ["POST", "/v1/workload-identities", { kind: "worker_runtime", sponsorUserIds: [member.id], environments: [] }],
      ["POST", `/v1/workload-identities/${ident.id}/revoke`, {}],
      ["GET", `/v1/workload-identities/${ident.id}/credentials`],
      ["POST", `/v1/workload-identities/${ident.id}/credentials`, { kind: "jwk", publicJwk: publicEd25519() }],
      ["DELETE", `/v1/workload-identities/${ident.id}/credentials/${randomUUID()}`],
      ["GET", `/v1/workload-identities/${ident.id}/grant-proposals`],
      ["GET", "/v1/identity/picker-sources"],
    ];
    for (const [m, url, body] of calls) {
      const r = await inject(m, url, member.key, body);
      expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
      expect(r.json().error, `${m} ${url}`).toBe("admin_only");
    }
    expect((await inject("GET", `/v1/workload-identities/${ident.id}`, AUTH)).json().status).toBe("active");
  });

  it("an admin API key reads, but cannot step up, so every write is refused step_up_required and nothing changes", async () => {
    const admin = await mkUser("key-admin", true);
    const steward = await mkUser("key-steward");
    const ident = await agentIdentity("key-subject", steward.id);
    const writes: Array<[Method, string, unknown?]> = [
      ["POST", "/v1/workload-identities", { kind: "worker_runtime", sponsorUserIds: [steward.id], environments: [] }],
      ["POST", `/v1/workload-identities/${ident.id}/revoke`, {}],
      ["POST", `/v1/workload-identities/${ident.id}/credentials`, { kind: "jwk", publicJwk: publicEd25519() }],
      ["DELETE", `/v1/workload-identities/${ident.id}/credentials/${randomUUID()}`],
    ];
    for (const [m, url, body] of writes) {
      const r = await inject(m, url, admin.key, body);
      expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
      expect(r.json(), `${m} ${url}`).toMatchObject({ error: "step_up_required", credential: "api_key" });
    }
    expect((await inject("GET", `/v1/workload-identities/${ident.id}`, AUTH)).json().status).toBe("active");
    expect(await db.select().from(workloadCredentials).where(eq(workloadCredentials.identityId, ident.id))).toHaveLength(0);
    for (const url of [`/v1/workload-identities/${ident.id}/credentials`, `/v1/workload-identities/${ident.id}/grant-proposals`, "/v1/identity/picker-sources"]) {
      expect((await inject("GET", url, admin.key)).statusCode, url).toBe(200);
    }
  });

  it("a create step-up is bound to exactly the body: one made for body A is refused for body B and stays unspent", async () => {
    const admin = await mkUser("su-admin", true);
    const steward = await mkUser("su-steward");
    // an enrolled authenticator, so a mismatched token is answered step_up_required. ORG-GLOBAL state (an admin
    // who can step up ends the bootstrap credential's step-up): undone in the finally below (M-040)
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, admin.id));
    try {
      const bodyA = { kind: "worker_runtime" as const, sponsorUserIds: [steward.id], environments: ["dev"] };
      const bodyB = { ...bodyA, environments: ["prod"] };
      const su = await sessionWithStepUp(admin.id, identityCreateStepUp(bodyA));
      const post = (body: unknown) =>
        app.inject({
          method: "POST",
          url: "/v1/workload-identities",
          headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken },
          cookies: { regulait_session: su.sessionToken },
          payload: body as object,
        });
      const forB = await post(bodyB);
      expect(forB.statusCode, forB.body).toBe(403);
      expect(forB.json().error).toBe("step_up_required");
      const [unspent] = await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, su.grantId));
      expect(unspent!.usedAt, "a step-up for body A was spent on body B").toBeNull();
      const forA = await post(bodyA);
      expect(forA.statusCode, forA.body).toBe(201);
      expect(forA.json()).toMatchObject({ environments: ["dev"], createdBy: admin.id });
    } finally {
      await db.update(users).set({ totpEnabled: false }).where(eq(users.id, admin.id));
    }
  });
});
