/**
 * ADR-0188 S4 follow-up (review of #326, Low items N1–N3), through the real app:
 *  - N1: an identity is granted only what at least one of its STEWARDS holds (422 `grant_exceeds_stewards`,
 *    audited, nothing written); the at-use intersection is unchanged. Control: the held set is written.
 *  - N2: the grant-set PUT's step-up is bound to the identity, the revision and a digest of the set: a step-up
 *    given for set A is refused for set B and stays unspent; it then works for set A.
 *  - N3: an engine key's `/v1/models` is narrowed by its live run grant and empty without one; a non-admin gets
 *    403 on every identity read and write; an admin API key (no step-up possible) is refused on the PUT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, auditLog, authSessions, createDb, eq, runMigrations, stepUpGrants, users, workloadIdentities, type Db } from "@regulait/db";
import { stepUpActionDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { listEntitledModels, modelListingGrantId } from "./compat-models.js";
import { agentScopeItem, ensureIdentityFor, startInProcessChain } from "./in-process-delegation.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";
import { getIdentityGrants, identityGrantsStepUp } from "./workload-identity-admin.js";
import type { VirtualKeyContext } from "./virtual-keys.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s4f-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let restoreIdentity: (() => Promise<void>) | undefined;

const inject = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function mkUser(label: string, isAdmin = false): Promise<{ id: string; key: { authorization: string } }> {
  const u = await inject("POST", "/v1/users", AUTH, { email: `s4f-${label}-${RUN}@example.com`, displayName: `s4f ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}
async function mkAgent(label: string): Promise<string> {
  const r = await inject("POST", "/v1/agents", AUTH, { name: `s4f-${label}-${RUN}`, provider: "mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 2, model: `s4f-model-${label}-${RUN}` });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const grantUserAgent = (userId: string, agentId: string) => inject("POST", "/v1/grants/agents", AUTH, { userId, agentId });
const emptySet = { tools: [], servers: [], connectors: [], roleIds: [] };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // an admin API key here pins "no step-up possible", not MFA (restored in afterAll, M-068)
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
}, 120_000);

afterAll(async () => {
  await restoreGates();
  await restoreIdentity?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("N1: an identity is granted only what one of its stewards holds", () => {
  it("refuses an item no steward holds (422, audited, nothing written); the held set is written", async () => {
    const steward = await mkUser("steward");
    const x = await mkAgent("n1-x");
    const y = await mkAgent("n1-y");
    await grantUserAgent(steward.id, x); // the steward holds x only
    const subject = await mkAgent("n1-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    // the system principal holds nothing: an unowned identity can be granted nothing until a person is named
    const unowned = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, AUTH, {
      ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }],
    });
    expect(unowned.statusCode, unowned.body).toBe(422);
    expect(unowned.json().error).toBe("grant_exceeds_stewards");
    // name the steward through the real route
    const named = await inject("PATCH", `/v1/workload-identities/${ident.id}`, AUTH, { sponsorUserIds: [steward.id] });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().sponsorUserIds).toEqual([steward.id]);

    const over = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, AUTH, {
      ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }, { agentId: y, allowedModes: ["execute"] }],
    });
    expect(over.statusCode, over.body).toBe(422);
    expect(over.json()).toMatchObject({ error: "grant_exceeds_stewards" });
    expect(over.json().detail).toContain(y);
    const [refusal] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, ident.id), eq(auditLog.ruleId, "grant-exceeds-stewards")));
    expect(refusal).toMatchObject({ effect: "deny" });
    expect((await getIdentityGrants(db, ident.id))!).toMatchObject({ revision: 0, agents: [] });

    // control: exactly what the steward holds is written
    const ok = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, AUTH, {
      ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().revision).toBe(1);
  });
});

describe("N2: the PUT's step-up is bound to the identity, the revision and the set", () => {
  it("a step-up given for set A is refused for set B (and stays unspent), then works for set A", async () => {
    const admin = await mkUser("n2-admin", true);
    const x = await mkAgent("n2-x");
    const y = await mkAgent("n2-y");
    await grantUserAgent(admin.id, x);
    await grantUserAgent(admin.id, y);
    const subject = await mkAgent("n2-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    await db.update(workloadIdentities).set({ sponsorUserIds: [admin.id] }).where(eq(workloadIdentities.id, ident.id));
    const setA = { ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }] };
    const setB = { ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }, { agentId: y, allowedModes: ["execute"] }] };
    // the digests differ by set and ignore list order
    const factsA = identityGrantsStepUp(ident.id, setA).facts;
    expect(factsA).toMatchObject({ identityId: ident.id, revision: 0 });
    expect(identityGrantsStepUp(ident.id, setB).facts.grantsDigest).not.toBe(factsA.grantsDigest);
    expect(identityGrantsStepUp(ident.id, { ...setB, agents: [...setB.agents].reverse() }).facts.grantsDigest).toBe(
      identityGrantsStepUp(ident.id, setB).facts.grantsDigest,
    );

    // a browser session for the admin, and a step-up grant made for set A
    const sessionToken = "rgls_" + randomBytes(32).toString("hex");
    const [session] = await db
      .insert(authSessions)
      .values({
        tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
        userId: admin.id,
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
        userId: admin.id,
        sessionId: session!.id,
        method: "totp",
        actionKind: "identity_manage",
        actionDigest: stepUpActionDigest("identity_manage", factsA),
        expiresAt: new Date(Date.now() + 120_000),
      })
      .returning({ id: stepUpGrants.id });
    const put = (body: unknown) =>
      app.inject({
        method: "PUT",
        url: `/v1/workload-identities/${ident.id}/grants`,
        headers: { ...CSRF, "x-regulait-step-up": stepUpToken },
        cookies: { regulait_session: sessionToken },
        payload: body as object,
      });

    const forB = await put(setB);
    expect(forB.statusCode, forB.body).not.toBe(200);
    expect([403, 422]).toContain(forB.statusCode);
    const [unspent] = await db.select({ usedAt: stepUpGrants.usedAt }).from(stepUpGrants).where(eq(stepUpGrants.id, grant!.id));
    expect(unspent!.usedAt, "a grant for set A was spent on set B").toBeNull();
    expect((await getIdentityGrants(db, ident.id))!.revision).toBe(0);

    // control: the same step-up is good for exactly set A
    const forA = await put(setA);
    expect(forA.statusCode, forA.body).toBe(200);
    expect(forA.json().revision).toBe(1);
  });
});

describe("N3: engine-key listing, non-admin refusal, no step-up for an admin key", () => {
  it("an engine run's key lists only what its live run grant covers, and nothing without one", async () => {
    const person = await mkUser("n3-engine");
    const x = await mkAgent("n3-x");
    const y = await mkAgent("n3-y");
    await grantUserAgent(person.id, x);
    await grantUserAgent(person.id, y);
    // the run's actor holds both and is delegated only x for this run (the listing reads only the grant, so an
    // agent-kind identity stands in for the runner's; the engine lease path is covered in the engine suites)
    const runnerAgent = await mkAgent("n3-runner-as-agent");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: runnerAgent });
    await db.update(workloadIdentities).set({ sponsorUserIds: [person.id] }).where(eq(workloadIdentities.id, ident.id));
    const put = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, AUTH, {
      ...emptySet, revision: 0, agents: [{ agentId: x, allowedModes: ["execute"] }, { agentId: y, allowedModes: ["execute"] }],
    });
    expect(put.statusCode, put.body).toBe(200);
    const engineRunId = randomUUID();
    await startInProcessChain(db, {
      sponsorUserId: person.id, projectId: null, context: { engineRunId },
      hops: [{ identityId: ident.id, scope: [agentScopeItem(x, "execute")], capMicros: null }],
    });
    const vk = (runId: string): VirtualKeyContext => ({
      id: randomUUID(), name: "engine", userId: person.id, allowedModels: null, budgetUsd: null, spentUsd: 0,
      upstreamCredentialId: null, purpose: "engine", projectId: null, engineRunId: runId,
    });
    const listed = async (v: VirtualKeyContext | null) =>
      (await listEntitledModels(db, person.id, v, await modelListingGrantId(db, { via: "virtual-key" }, v))).flatMap((m) => m.agentIds);
    // control: the person's own listing has both
    expect(await listed(null)).toEqual(expect.arrayContaining([x, y]));
    const withGrant = await listed(vk(engineRunId));
    expect(withGrant).toContain(x);
    expect(withGrant).not.toContain(y);
    expect(await listed(vk(randomUUID()))).toEqual([]);
  });

  it("a non-admin is refused 403 on every identity read and write", async () => {
    const member = await mkUser("n3-member");
    const subject = await mkAgent("n3-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    const calls: Array<["GET" | "PUT" | "PATCH", string, unknown?]> = [
      ["GET", "/v1/workload-identities"],
      ["GET", `/v1/workload-identities/${ident.id}`],
      ["GET", `/v1/workload-identities/${ident.id}/grants`],
      ["PUT", `/v1/workload-identities/${ident.id}/grants`, { ...emptySet, revision: 0, agents: [] }],
      ["PATCH", `/v1/workload-identities/${ident.id}`, { sponsorUserIds: [member.id] }],
    ];
    for (const [m, url, body] of calls) {
      const r = await inject(m, url, member.key, body);
      expect(r.statusCode, `${m} ${url}: ${r.body}`).toBe(403);
    }
    // control: the bootstrap admin reads it
    expect((await inject("GET", `/v1/workload-identities/${ident.id}`, AUTH)).statusCode).toBe(200);
  });

  it("an admin API key cannot step up, so the PUT is refused step_up_required and nothing is written", async () => {
    const admin = await mkUser("n3-admin", true);
    const subject = await mkAgent("n3-key-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    const r = await inject("PUT", `/v1/workload-identities/${ident.id}/grants`, admin.key, { ...emptySet, revision: 0, agents: [] });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "step_up_required", credential: "api_key" });
    expect((await getIdentityGrants(db, ident.id))!.revision).toBe(0);
    // control: the same key READS (admin, no step-up for a read)
    expect((await inject("GET", `/v1/workload-identities/${ident.id}/grants`, admin.key)).statusCode).toBe(200);
  });
});

