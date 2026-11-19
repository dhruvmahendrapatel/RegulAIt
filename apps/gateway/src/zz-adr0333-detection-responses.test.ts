/**
 * ADR-0333 §5 (slice 2) — configured responses: stored only behind a settings_relax step-up, run after the incident
 * commits, recorded on the incident and audited. `require_approval` goes through the one approval-rule create, so
 * the sponsor's later MCP calls meet the Approvals Queue; a response that cannot apply fails with a fixed code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  and,
  approvalRules,
  auditLog,
  createDb,
  detectionIncidents,
  detectionRulePacks,
  delegationGrants,
  eq,
  identitySigningKeys,
  inArray,
  issuedTokens,
  mcpServers,
  workloadCredentials,
  workloadIdentities,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack, type DetectionResponse } from "./detection/pack.js";
import { DETECTION_RESPONSE_RULE_ID, runDetectionResponse } from "./detection/responses.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0333r-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let sponsorId: string;
let serverId: string;
const restores: Array<() => Promise<void>> = [];

async function mkUser(label: string, isAdmin: boolean): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333r-${label}-${RUN}@example.com`, displayName: label, isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/** store the default pack with `high-risk-addon-call` set to `response`, through the stepped-up route */
async function storeWithResponse(response: DetectionResponse): Promise<number> {
  const current = await loadActiveDetectionPack(db);
  const next = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.map((r) => (r.id === "high-risk-addon-call" ? { ...r, response } : r)) });
  const facts = { detection: "rule-pack", fromDigest: current.digest, toDigest: packDigest(next) };
  const req = stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
  const res = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...req, payload: { pack: next, expectedVersion: current.version } });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json().relaxed).toBe(true);
  return res.json().version as number;
}

async function riskyCall(): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({ id, userId: sponsorId, objectType: "mcp_tool", serverId, toolName: "noop", effect: "allow", ruleId: "allow-list", ruleChain: [], reason: "t" });
  return id;
}


const b64u43 = () => randomBytes(32).toString("base64url");
let signingKid: string;

/** a worker-runtime identity with one JWK credential (no agent needed), stewarded by the sponsor */
async function mkIdentity(): Promise<{ identityId: string; credentialId: string }> {
  const [ident] = await db
    .insert(workloadIdentities)
    .values({ kind: "worker_runtime", identifier: `spiffe://regulait.test/regulait/worker_runtime/${randomUUID()}`, sponsorUserIds: [sponsorId] } as never)
    .returning({ id: workloadIdentities.id });
  const x = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
  const [cred] = await db
    .insert(workloadCredentials)
    .values({ identityId: ident!.id, kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x }, jwkThumbprint: b64u43(), notAfter: new Date(Date.now() + 3_600_000) } as never)
    .returning({ id: workloadCredentials.id });
  return { identityId: ident!.id, credentialId: cred!.id };
}

/** a self token for `identityId`: live, or expired an hour ago */
async function mkToken(identityId: string, credentialId: string, live: boolean): Promise<string> {
  const jti = randomBytes(24).toString("base64url");
  await db.insert(issuedTokens).values({
    jti,
    subjectIdentityId: identityId,
    authCredentialId: credentialId,
    signingKid,
    bindingKind: "dpop",
    bindingThumbprint: b64u43(),
    audience: "https://gateway.test",
    env: "test",
    issuedAt: live ? sql`now()` : sql`now() - interval '2 hours'`,
    expiresAt: live ? sql`now() + interval '300 seconds'` : sql`now() - interval '1 hour'`,
  } as never);
  return jti;
}

/** a pending incident to run a response against (the fixture rows are reused; done/failed are terminal) */
async function pendingIncident(): Promise<string> {
  const [incident] = await db.select({ id: detectionIncidents.id }).from(detectionIncidents).where(eq(detectionIncidents.response, "suspend_grant")).limit(1);
  await db.update(detectionIncidents).set({ responseState: "none", responseErrorCode: null }).where(eq(detectionIncidents.id, incident!.id));
  return incident!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  adminId = await mkUser("admin", true);
  sponsorId = await mkUser("sponsor", false);
  const [s] = await db.insert(mcpServers).values({ name: `adr0333r-${randomUUID()}`, url: "http://127.0.0.1:9/", admissionSeverity: "high" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  // an issuer key row for the token fixtures: revoked from the start, so it is never published or used to sign
  signingKid = `adr0333r-${RUN}`;
  const issuer = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
  await db.insert(identitySigningKeys).values({ kid: signingKid, publicJwk: { kty: "OKP", crv: "Ed25519", x: issuer }, revokedAt: sql`now()` } as never);
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await runDetectionSweep(db, adminId);
  await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = (SELECT max(seq) FROM audit_log), replay_cursor_seq = replay_until_seq, lease_until = NULL, lease_token = NULL`);
});

afterAll(async () => {
  await db.delete(approvalRules).where(eq(approvalRules.userId, sponsorId));
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0333 responses", () => {
  it("require_approval: the sponsor gets a user-scoped, all-servers approval rule with the pack author as approver", async () => {
    const version = await storeWithResponse("require_approval");
    const trigger = await riskyCall();
    const out = await runDetectionSweep(db, adminId);
    expect(out.responses).toBe(1);
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger));
    expect(incident).toMatchObject({ ruleId: "high-risk-addon-call", packVersion: version, response: "require_approval", responseState: "done", responseErrorCode: null });
    const rules = await db.select().from(approvalRules).where(eq(approvalRules.userId, sponsorId));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ scope: "user", serverScope: "all", toolName: null, approverUserId: adminId, approvalScope: "action" });
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(audited).toMatchObject({ effect: "deny", userId: adminId });
    // a second detection reuses the rule rather than stacking another
    await riskyCall();
    await runDetectionSweep(db, adminId);
    expect(await db.select().from(approvalRules).where(eq(approvalRules.userId, sponsorId))).toHaveLength(1);
  });

  it("suspend_grant on a sponsor's own calls fails with not_delegated, recorded and audited", async () => {
    await storeWithResponse("suspend_grant");
    const trigger = await riskyCall();
    await runDetectionSweep(db, adminId);
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger));
    expect(incident).toMatchObject({ response: "suspend_grant", responseState: "failed", responseErrorCode: "not_delegated" });
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(audited).toMatchObject({ effect: "allow" });
    expect(audited!.detail).toMatchObject({ outcome: "failed", code: "not_delegated" });
  });

  it("suspend_grant on an unknown delegation tree, and revoke_credential with no actor, fail with fixed codes", async () => {
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.response, "suspend_grant")).limit(1);
    const base = { incidentId: incident!.id, ruleId: "high-risk-addon-call", userId: sponsorId, actorIdentityId: null, packAuthor: adminId, auditUserId: adminId };
    // one fixture incident is reused: put it back to the pending state before each run (done/failed are terminal)
    const pending = () => db.update(detectionIncidents).set({ responseState: "none", responseErrorCode: null }).where(eq(detectionIncidents.id, incident!.id));
    await pending();
    expect(await runDetectionResponse(db, { ...base, response: "suspend_grant", groupKey: `grant:${randomUUID()}` })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("grant_not_found");
    await pending();
    expect(await runDetectionResponse(db, { ...base, response: "revoke_credential", groupKey: `user:${sponsorId}` })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("no_actor_identity");
    await pending();
    expect(await runDetectionResponse(db, { ...base, response: "require_approval", groupKey: `user:${sponsorId}`, packAuthor: sponsorId })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("no_independent_approver");
  });

  it("a terminal response state is never overwritten (DETECTION_RESPONSE_MACHINE)", async () => {
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.response, "suspend_grant")).limit(1);
    await db.update(detectionIncidents).set({ responseState: "done", responseErrorCode: null }).where(eq(detectionIncidents.id, incident!.id));
    await runDetectionResponse(db, {
      incidentId: incident!.id,
      ruleId: "high-risk-addon-call",
      response: "suspend_grant",
      groupKey: `grant:${randomUUID()}`,
      userId: sponsorId,
      actorIdentityId: null,
      packAuthor: adminId,
      auditUserId: adminId,
    });
    const [after] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id));
    expect(after!.responseState).toBe("done");
    expect(after!.responseErrorCode).toBeNull();
  });

  it("revoke_credential revokes exactly the acting identity's LIVE tokens, nobody else's and no expired one (review of #1060)", async () => {
    const target = await mkIdentity();
    const other = await mkIdentity();
    const live = [await mkToken(target.identityId, target.credentialId, true), await mkToken(target.identityId, target.credentialId, true)];
    const expired = await mkToken(target.identityId, target.credentialId, false);
    const othersLive = await mkToken(other.identityId, other.credentialId, true);
    const incidentId = await pendingIncident();
    const state = await runDetectionResponse(db, {
      incidentId,
      ruleId: "high-risk-addon-call",
      response: "revoke_credential",
      groupKey: `user:${sponsorId}`,
      userId: sponsorId,
      actorIdentityId: target.identityId,
      packAuthor: adminId,
      auditUserId: adminId,
    });
    expect(state).toBe("done");
    const rows = await db.select({ jti: issuedTokens.jti, revokedAt: issuedTokens.revokedAt }).from(issuedTokens).where(inArray(issuedTokens.jti, [...live, expired, othersLive]));
    const revoked = new Set(rows.filter((r) => r.revokedAt !== null).map((r) => r.jti));
    expect([...revoked].sort()).toEqual([...live].sort());
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, incidentId), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID), sql`${auditLog.detail}->>'response' = 'revoke_credential'`))
      .orderBy(sql`${auditLog.seq} DESC`)
      .limit(1);
    expect(audited!.detail).toMatchObject({ outcome: "done", tokensRevoked: 2, actorIdentityId: target.identityId });
  });

  it("suspend_grant revokes a real delegation tree at its root, cascading to the child (review of #1060)", async () => {
    const { identityId } = await mkIdentity();
    const rootId = randomUUID();
    const childId = randomUUID();
    const base = { sponsorUserId: sponsorId, actorIdentityId: identityId, scope: [], environment: "test", bindingKind: "in_process", depthLimit: 2, expiresAt: new Date(Date.now() + 3_600_000) };
    await db.insert(delegationGrants).values({ ...base, id: rootId, rootGrantId: rootId, depth: 0, path: [] } as never);
    await db.insert(delegationGrants).values({ ...base, id: childId, rootGrantId: rootId, parentGrantId: rootId, depth: 1, path: [rootId] } as never);
    const incidentId = await pendingIncident();
    const state = await runDetectionResponse(db, {
      incidentId,
      ruleId: "high-risk-addon-call",
      response: "suspend_grant",
      groupKey: `grant:${rootId}`,
      userId: sponsorId,
      actorIdentityId: identityId,
      packAuthor: adminId,
      auditUserId: adminId,
    });
    expect(state).toBe("done");
    const grants = await db.select({ id: delegationGrants.id, revokedAt: delegationGrants.revokedAt, reason: delegationGrants.revokedReason }).from(delegationGrants).where(inArray(delegationGrants.id, [rootId, childId]));
    expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
    expect(grants.find((g) => g.id === rootId)!.reason).toBe("admin");
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, incidentId), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID), sql`${auditLog.detail}->>'response' = 'suspend_grant'`, sql`${auditLog.detail}->>'outcome' = 'done'`))
      .limit(1);
    expect(audited!.detail).toMatchObject({ rootGrantId: rootId, revokedGrants: 2 });
  });

  it("a failure AFTER the action rolls the action back: nothing applied, recorded as response_error (review of #1060)", async () => {
    const target = await mkIdentity();
    const jti = await mkToken(target.identityId, target.credentialId, true);
    const incidentId = await pendingIncident();
    const state = await runDetectionResponse(
      db,
      { incidentId, ruleId: "high-risk-addon-call", response: "revoke_credential", groupKey: `user:${sponsorId}`, userId: sponsorId, actorIdentityId: target.identityId, packAuthor: adminId, auditUserId: adminId },
      { afterAction: async () => { throw new Error("injected crash between the action and its record"); } },
    );
    expect(state).toBe("failed");
    const [token] = await db.select({ revokedAt: issuedTokens.revokedAt }).from(issuedTokens).where(eq(issuedTokens.jti, jti));
    expect(token!.revokedAt).toBeNull();
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incidentId));
    expect(incident).toMatchObject({ responseState: "failed", responseErrorCode: "response_error" });
    // and an already-recorded incident is left alone: the action is rolled back with it
    const again = await runDetectionResponse(db, { incidentId, ruleId: "high-risk-addon-call", response: "revoke_credential", groupKey: `user:${sponsorId}`, userId: sponsorId, actorIdentityId: target.identityId, packAuthor: adminId, auditUserId: adminId });
    expect(again).toBe("unchanged");
    expect((await db.select({ revokedAt: issuedTokens.revokedAt }).from(issuedTokens).where(eq(issuedTokens.jti, jti)))[0]!.revokedAt).toBeNull();
  });

  it("require_approval does not count a NARROWER existing rule (write-only) as done: it creates the full rule (review of #1060)", async () => {
    const sponsor2 = await mkUser("sponsor-narrow", false);
    await db.insert(approvalRules).values({ scope: "user", serverScope: "all", userId: sponsor2, toolName: null, approvalScope: "action", approverUserId: adminId, quorum: 1, writeOnly: true } as never);
    const incidentId = await pendingIncident();
    const state = await runDetectionResponse(db, { incidentId, ruleId: "high-risk-addon-call", response: "require_approval", groupKey: `user:${sponsor2}`, userId: sponsor2, actorIdentityId: null, packAuthor: adminId, auditUserId: adminId });
    expect(state).toBe("done");
    const rules = await db.select().from(approvalRules).where(eq(approvalRules.userId, sponsor2));
    expect(rules).toHaveLength(2);
    expect(rules.some((r) => !r.writeOnly && r.deployMode === null && r.approvalScope === "action")).toBe(true);
    await db.delete(approvalRules).where(eq(approvalRules.userId, sponsor2));
  });

  it("D2: a historical (replayed) incident is stored alert-only and runs no response (review of #1060)", async () => {
    await storeWithResponse("require_approval");
    const trigger = await riskyCall();
    const [row] = await db.select({ seq: auditLog.seq }).from(auditLog).where(eq(auditLog.id, trigger));
    // the live cursor is already past the row; the replay covers exactly it
    await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = ${row!.seq}, replay_cursor_seq = ${Number(row!.seq) - 1}, replay_until_seq = ${row!.seq}, replay_completed_at = NULL, lease_until = NULL, lease_token = NULL`);
    await runDetectionSweep(db, adminId);
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger));
    expect(incident).toMatchObject({ historical: true, response: "alert", responseState: "none" });
    const responded = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(responded).toEqual([]);
  });
});
