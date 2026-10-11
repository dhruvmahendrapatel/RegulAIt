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
import {
  agentGrants,
  agentRevocations,
  and,
  auditLog,
  authSessions,
  connectorGrants,
  connectorRevocations,
  connectors,
  createDb,
  eq,
  mcpServers,
  mcpTools,
  revocations,
  roleAssignments,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roles,
  roleToolGrants,
  runMigrations,
  serverGrants,
  sql,
  stepUpGrants,
  toolGrants,
  users,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { stepUpActionDigest, type PutAgentGrants } from "@regulait/shared";
import { buildApp } from "./app.js";
import { listEntitledModels, modelListingGrantId } from "./compat-models.js";
import { agentScopeItem, ensureIdentityFor, startInProcessChain } from "./in-process-delegation.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { hashToken } from "./token-hash.js";
import { firstItemNoStewardHolds, getIdentityGrants, grantSetDigest, identityGrantsStepUp, identityUpdateStepUp, putIdentityGrants, stewardCheckTestHooks } from "./workload-identity-admin.js";
import type { StepUpCheckArgs } from "./step-up.js";
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
      // the admin gate refused it, not some other 403 (review L6)
      expect(r.json().error, `${m} ${url}`).toBe("admin_only");
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

// ---------------------------------------------------------------------------------------------------------------
// Fix round from the #336 review (M1, L2–L7)
// ---------------------------------------------------------------------------------------------------------------

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
const auditRows = (objectId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, objectId), eq(auditLog.ruleId, ruleId)));
const stewardsOf = async (identityId: string) =>
  (
    await db
      .select({ s: workloadIdentities.sponsorUserIds })
      .from(workloadIdentities)
      .where(eq(workloadIdentities.id, identityId))
  )[0]!.s;
async function freshIdentity(label: string) {
  return ensureIdentityFor(db, { kind: "agent", id: await mkAgent(label) });
}

describe("M1: changing the stewards re-checks the current grant set", () => {
  it("refuses stewards who do not hold the current set (422, deny audit row, unchanged); a holder is accepted", async () => {
    const s = await mkUser("m1-s");
    const t = await mkUser("m1-t"); // holds nothing
    const u = await mkUser("m1-u");
    const x = await mkAgent("m1-x");
    await grantUserAgent(s.id, x);
    await grantUserAgent(u.id, x);
    const ident = await freshIdentity("m1-subject");
    expect(
      (
        await inject("PATCH", `/v1/workload-identities/${ident.id}`, AUTH, {
          sponsorUserIds: [s.id],
        })
      ).statusCode,
    ).toBe(200);
    const put = await inject(
      "PUT",
      `/v1/workload-identities/${ident.id}/grants`,
      AUTH,
      {
        ...emptySet,
        revision: 0,
        agents: [{ agentId: x, allowedModes: ["execute"] }],
      },
    );
    expect(put.statusCode, put.body).toBe(200);

    const toT = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [t.id] },
    );
    expect(toT.statusCode, toT.body).toBe(422);
    expect(toT.json()).toMatchObject({ error: "grant_exceeds_stewards" });
    expect(toT.json().detail).toContain(x);
    expect(await stewardsOf(ident.id)).toEqual([s.id]);
    const denied = await auditRows(ident.id, "grant-exceeds-stewards");
    expect(
      denied.some(
        (r) =>
          r.effect === "deny" &&
          (r.detail as { phase?: string }).phase === "update_refused",
      ),
    ).toBe(true);

    // control: a steward who holds the set is accepted
    const toU = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [u.id] },
    );
    expect(toU.statusCode, toU.body).toBe(200);
    expect(await stewardsOf(ident.id)).toEqual([u.id]);
  });
});

describe("L4/L7: PATCH refusals are audited; steward_not_found and a disabled steward", () => {
  it("steward_not_found for an unknown person (deny audit row); an existing person is accepted (allow audit row)", async () => {
    const ident = await freshIdentity("l4-unknown");
    const ghost = randomUUID();
    const r = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [ghost] },
    );
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error).toBe("steward_not_found");
    const [deny] = await auditRows(
      ident.id,
      "workload-identity-update-refused",
    );
    expect(deny).toMatchObject({ effect: "deny" });
    expect(deny!.detail).toMatchObject({
      phase: "update_refused",
      code: "steward_not_found",
      missing: [ghost],
    });
    expect(await stewardsOf(ident.id)).not.toContain(ghost);

    const real = await mkUser("l4-real");
    const ok = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [real.id] },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const [allow] = await auditRows(ident.id, "workload-identity-updated");
    expect(allow).toMatchObject({ effect: "allow" });
    expect(allow!.detail).toMatchObject({
      phase: "updated",
      after: { sponsorUserIds: [real.id] },
    });
  });

  it("a disabled person cannot be named and, once a steward, holds nothing; enabled, the same person works", async () => {
    const d = await mkUser("l7-disabled");
    const x = await mkAgent("l7-dx");
    await grantUserAgent(d.id, x);
    const ident = await freshIdentity("l7-disabled-subject");
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, d.id));
    const named = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [d.id] },
    );
    expect(named.statusCode, named.body).toBe(404);
    expect(named.json().error).toBe("steward_not_found");
    // already a steward when disabled: holds nothing
    await db
      .update(workloadIdentities)
      .set({ sponsorUserIds: [d.id] })
      .where(eq(workloadIdentities.id, ident.id));
    const set = {
      ...emptySet,
      revision: 0,
      agents: [{ agentId: x, allowedModes: ["execute"] }],
    };
    const refused = await inject(
      "PUT",
      `/v1/workload-identities/${ident.id}/grants`,
      AUTH,
      set,
    );
    expect(refused.statusCode, refused.body).toBe(422);
    // control: re-enabled, the same steward holds it
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, d.id));
    const ok = await inject(
      "PUT",
      `/v1/workload-identities/${ident.id}/grants`,
      AUTH,
      set,
    );
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("identity_not_found and a revoked identity are refused with deny audit rows", async () => {
    const someone = await mkUser("l4-someone");
    const missing = randomUUID();
    const nf = await inject(
      "PATCH",
      `/v1/workload-identities/${missing}`,
      AUTH,
      { sponsorUserIds: [someone.id] },
    );
    expect(nf.statusCode, nf.body).toBe(404);
    expect(nf.json().error).toBe("identity_not_found");
    const [nfRow] = await auditRows(
      missing,
      "workload-identity-update-refused",
    );
    expect(nfRow).toMatchObject({ effect: "deny" });
    expect(nfRow!.detail).toMatchObject({ code: "identity_not_found" });

    const ident = await freshIdentity("l4-revoked");
    await db
      .update(workloadIdentities)
      .set({ status: "revoked" })
      .where(eq(workloadIdentities.id, ident.id));
    const rv = await inject(
      "PATCH",
      `/v1/workload-identities/${ident.id}`,
      AUTH,
      { sponsorUserIds: [someone.id] },
    );
    expect(rv.statusCode, rv.body).toBe(409);
    const [rvRow] = await auditRows(
      ident.id,
      "workload-identity-update-refused",
    );
    expect(rvRow).toMatchObject({ effect: "deny" });
    expect(rvRow!.detail).toMatchObject({ code: "identity_not_active" });
  });
});

describe("L7: the PATCH step-up is bound to exactly the change", () => {
  it("a step-up for change A is refused for change B and stays unspent, then works for change A", async () => {
    const admin = await mkUser("l7-su-admin", true);
    const a = await mkUser("l7-su-a");
    const b = await mkUser("l7-su-b");
    const ident = await freshIdentity("l7-su-subject");
    // an enrolled authenticator, so a mismatched token is answered step_up_required (not "unavailable"). This is
    // ORG-GLOBAL state (an admin who can step up ends the bootstrap credential's step-up), so it is undone in the
    // finally below before any other test or file runs (M-040)
    await db
      .update(users)
      .set({ totpEnabled: true })
      .where(eq(users.id, admin.id));
    try {
      const changeA = { sponsorUserIds: [a.id] };
      const changeB = { sponsorUserIds: [b.id] };
      expect(identityUpdateStepUp(ident.id, changeA).facts).not.toEqual(
        identityUpdateStepUp(ident.id, changeB).facts,
      );
      const su = await sessionWithStepUp(
        admin.id,
        identityUpdateStepUp(ident.id, changeA),
      );
      const patch = (body: unknown) =>
        app.inject({
          method: "PATCH",
          url: `/v1/workload-identities/${ident.id}`,
          headers: { ...CSRF, "x-regulait-step-up": su.stepUpToken },
          cookies: { regulait_session: su.sessionToken },
          payload: body as object,
        });
      const forB = await patch(changeB);
      expect(forB.statusCode, forB.body).toBe(403);
      expect(forB.json().error).toBe("step_up_required");
      const [unspent] = await db
        .select({ usedAt: stepUpGrants.usedAt })
        .from(stepUpGrants)
        .where(eq(stepUpGrants.id, su.grantId));
      expect(
        unspent!.usedAt,
        "a step-up for change A was spent on change B",
      ).toBeNull();
      expect(await stewardsOf(ident.id)).not.toContain(b.id);
      // control: the same step-up is good for exactly change A
      const forA = await patch(changeA);
      expect(forA.statusCode, forA.body).toBe(200);
      expect(await stewardsOf(ident.id)).toEqual([a.id]);
    } finally {
      await db
        .update(users)
        .set({ totpEnabled: false, isAdmin: false })
        .where(eq(users.id, admin.id));
    }
  });
});

describe("L2: the grant-set digest has no delimiter collision", () => {
  it('objects ["a","b"] and ["a,b"] digest differently; order still does not matter', () => {
    const c = randomUUID();
    const base = { tools: [], servers: [], agents: [], roleIds: [] };
    const two = grantSetDigest({
      ...base,
      connectors: [
        { connectorId: c, mode: "read", allowedObjects: ["a", "b"] },
      ],
    });
    const one = grantSetDigest({
      ...base,
      connectors: [{ connectorId: c, mode: "read", allowedObjects: ["a,b"] }],
    });
    expect(two).not.toBe(one);
    // control: list order is not part of the set
    expect(
      grantSetDigest({
        ...base,
        connectors: [
          { connectorId: c, mode: "read", allowedObjects: ["b", "a"] },
        ],
      }),
    ).toBe(two);
    const t1 = { serverId: randomUUID(), toolName: "x" };
    const t2 = { serverId: randomUUID(), toolName: "y" };
    expect(grantSetDigest({ ...base, connectors: [], tools: [t1, t2] })).toBe(
      grantSetDigest({ ...base, connectors: [], tools: [t2, t1] }),
    );
    // and a tool name carrying the old delimiters is not confused with another split
    const sv = randomUUID();
    expect(
      grantSetDigest({
        ...base,
        connectors: [],
        tools: [{ serverId: sv, toolName: "a/b" }],
      }),
    ).not.toBe(
      grantSetDigest({
        ...base,
        connectors: [],
        tools: [{ serverId: sv + "/a", toolName: "b" }],
      }),
    );
  });
});

describe("L3/L7: each branch of the steward check, with the revocation subtraction", () => {
  const check = (
    stewards: string[],
    set: Partial<Omit<PutAgentGrants, "revision">>,
  ) =>
    db.transaction((tx) =>
      firstItemNoStewardHolds(tx as unknown as Db, stewards, {
        ...emptySet,
        agents: [],
        revision: 0,
        ...set,
      }),
    );
  let serverId = "";
  let otherServer = "";
  beforeAll(async () => {
    const [s1] = await db
      .insert(mcpServers)
      .values({ name: `s4f-srv-${RUN}`, url: "http://127.0.0.1:9/mcp" })
      .returning({ id: mcpServers.id });
    const [s2] = await db
      .insert(mcpServers)
      .values({ name: `s4f-srv2-${RUN}`, url: "http://127.0.0.1:9/mcp2" })
      .returning({ id: mcpServers.id });
    serverId = s1!.id;
    otherServer = s2!.id;
    await db.insert(mcpTools).values([
      { serverId, name: "rd", kind: "read" },
      { serverId, name: "wr", kind: "write" },
      { serverId: otherServer, name: "rd", kind: "read" },
    ]);
  });

  it("tool: a tool grant holds it; a tool or whole-server revocation takes it; read-only-all holds a READ tool only", async () => {
    const p = await mkUser("l3-tool");
    await db
      .insert(toolGrants)
      .values({ userId: p.id, serverId, toolName: "wr" });
    expect(
      await check([p.id], { tools: [{ serverId, toolName: "wr" }] }),
    ).toBeNull(); // control
    await db
      .insert(revocations)
      .values({ userId: p.id, serverId, toolName: "wr" });
    expect(await check([p.id], { tools: [{ serverId, toolName: "wr" }] })).toBe(
      `tool ${serverId}/wr`,
    );

    const q = await mkUser("l3-tool-ws");
    await db
      .insert(toolGrants)
      .values({ userId: q.id, serverId, toolName: "wr" });
    await db
      .insert(serverGrants)
      .values({ userId: q.id, serverId, readOnlyAll: true });
    expect(
      await check([q.id], { tools: [{ serverId, toolName: "rd" }] }),
    ).toBeNull(); // read tool via read-only-all
    expect(
      await check([q.id], { tools: [{ serverId, toolName: "wr" }] }),
    ).toBeNull();
    await db
      .insert(revocations)
      .values({ userId: q.id, serverId, toolName: null }); // the whole server
    expect(await check([q.id], { tools: [{ serverId, toolName: "wr" }] })).toBe(
      `tool ${serverId}/wr`,
    );
    expect(await check([q.id], { tools: [{ serverId, toolName: "rd" }] })).toBe(
      `tool ${serverId}/rd`,
    );

    const r = await mkUser("l3-tool-ro");
    await db
      .insert(serverGrants)
      .values({ userId: r.id, serverId, readOnlyAll: true });
    expect(await check([r.id], { tools: [{ serverId, toolName: "wr" }] })).toBe(
      `tool ${serverId}/wr`,
    ); // a write tool is not read-only
  });

  it("tool through a ROLE: held, and the steward's own revocation takes it", async () => {
    const p = await mkUser("l3-role-tool");
    const [role] = await db
      .insert(roles)
      .values({ name: `s4f-role-tool-${RUN}` })
      .returning({ id: roles.id });
    await db
      .insert(roleToolGrants)
      .values({ roleId: role!.id, serverId: otherServer, toolName: "rd" });
    await db.insert(roleAssignments).values({ userId: p.id, roleId: role!.id });
    expect(
      await check([p.id], {
        tools: [{ serverId: otherServer, toolName: "rd" }],
      }),
    ).toBeNull(); // control
    await db
      .insert(revocations)
      .values({ userId: p.id, serverId: otherServer, toolName: null });
    expect(
      await check([p.id], {
        tools: [{ serverId: otherServer, toolName: "rd" }],
      }),
    ).toBe(`tool ${otherServer}/rd`);
  });

  it("server: a server grant holds it; read-only-all needs a read-only-all grant; a whole-server revocation takes it", async () => {
    const p = await mkUser("l3-server");
    await db
      .insert(serverGrants)
      .values({ userId: p.id, serverId, readOnlyAll: false });
    expect(
      await check([p.id], { servers: [{ serverId, readOnlyAll: false }] }),
    ).toBeNull(); // control
    expect(
      await check([p.id], { servers: [{ serverId, readOnlyAll: true }] }),
    ).toBe(`server ${serverId} (read-only all)`);
    await db
      .insert(revocations)
      .values({ userId: p.id, serverId, toolName: null });
    expect(
      await check([p.id], { servers: [{ serverId, readOnlyAll: false }] }),
    ).toBe(`server ${serverId}`);
    // a single-tool revocation does not take the server grant
    const q = await mkUser("l3-server-tool-rev");
    await db
      .insert(serverGrants)
      .values({ userId: q.id, serverId, readOnlyAll: false });
    await db
      .insert(revocations)
      .values({ userId: q.id, serverId, toolName: "wr" });
    expect(
      await check([q.id], { servers: [{ serverId, readOnlyAll: false }] }),
    ).toBeNull();
  });

  it("connector: mode and every object by one grant, direct or role; a revocation takes both", async () => {
    const [c] = await db
      .insert(connectors)
      .values({ name: `s4f-conn-${RUN}`, kind: "crm" })
      .returning({ id: connectors.id });
    const cid = c!.id;
    const p = await mkUser("l3-conn");
    await db
      .insert(connectorGrants)
      .values({
        userId: p.id,
        connectorId: cid,
        mode: "read",
        allowedObjects: ["a", "b"],
      });
    expect(
      await check([p.id], {
        connectors: [{ connectorId: cid, mode: "read", allowedObjects: ["a"] }],
      }),
    ).toBeNull(); // control
    expect(
      await check([p.id], {
        connectors: [
          { connectorId: cid, mode: "readwrite", allowedObjects: ["a"] },
        ],
      }),
    ).toBe(`connector ${cid} (readwrite)`);
    expect(
      await check([p.id], {
        connectors: [
          { connectorId: cid, mode: "read", allowedObjects: ["a", "z"] },
        ],
      }),
    ).toBe(`connector ${cid} (read)`);
    await db
      .insert(connectorRevocations)
      .values({ userId: p.id, connectorId: cid });
    expect(
      await check([p.id], {
        connectors: [{ connectorId: cid, mode: "read", allowedObjects: ["a"] }],
      }),
    ).toBe(`connector ${cid} (read)`);

    const q = await mkUser("l3-conn-role");
    const [role] = await db
      .insert(roles)
      .values({ name: `s4f-role-conn-${RUN}` })
      .returning({ id: roles.id });
    await db
      .insert(roleConnectorGrants)
      .values({
        roleId: role!.id,
        connectorId: cid,
        mode: "readwrite",
        allowedObjects: null,
      });
    await db.insert(roleAssignments).values({ userId: q.id, roleId: role!.id });
    expect(
      await check([q.id], {
        connectors: [
          { connectorId: cid, mode: "readwrite", allowedObjects: ["z"] },
        ],
      }),
    ).toBeNull(); // control
    await db
      .insert(connectorRevocations)
      .values({ userId: q.id, connectorId: cid });
    expect(
      await check([q.id], {
        connectors: [
          { connectorId: cid, mode: "readwrite", allowedObjects: ["z"] },
        ],
      }),
    ).toBe(`connector ${cid} (readwrite)`);
  });

  it("role: held only by a steward assigned it; agent: every mode, minus an agent revocation", async () => {
    const p = await mkUser("l3-role");
    const [role] = await db
      .insert(roles)
      .values({ name: `s4f-role-${RUN}` })
      .returning({ id: roles.id });
    expect(await check([p.id], { roleIds: [role!.id] })).toBe(
      `role ${role!.id}`,
    );
    await db.insert(roleAssignments).values({ userId: p.id, roleId: role!.id });
    expect(await check([p.id], { roleIds: [role!.id] })).toBeNull(); // control
    // the system principal holds nothing
    expect(
      await check(["00000000-0000-0000-0000-000000000000"], {
        roleIds: [role!.id],
      }),
    ).toBe(`role ${role!.id}`);

    const x = await mkAgent("l3-agent");
    await db
      .insert(agentGrants)
      .values({ userId: p.id, agentId: x, allowedModes: ["plan"] });
    expect(
      await check([p.id], { agents: [{ agentId: x, allowedModes: ["plan"] }] }),
    ).toBeNull(); // control
    expect(
      await check([p.id], {
        agents: [{ agentId: x, allowedModes: ["plan", "execute"] }],
      }),
    ).toBe(`agent ${x} mode execute`);
    await db.insert(agentRevocations).values({ userId: p.id, agentId: x });
    expect(
      await check([p.id], { agents: [{ agentId: x, allowedModes: ["plan"] }] }),
    ).toBe(`agent ${x} mode plan`);
  });
});

// ---------------------------------------------------------------------------
// S4+S5 follow-up: the three Low items left by the #336 review
// ---------------------------------------------------------------------------
describe("S4+S5 follow-up: role bundles (L3), revocation serialization (L5), force role delete (40P01)", () => {
  let serverId = "";
  let connectorId = "";
  let db2: Db;
  beforeAll(async () => {
    db2 = createDb(process.env.DATABASE_URL!);
    const [s] = await db.insert(mcpServers).values({ name: `s4f45-srv-${RUN}`, url: "http://127.0.0.1:9/mcp45" }).returning({ id: mcpServers.id });
    serverId = s!.id;
    await db.insert(mcpTools).values([
      { serverId, name: "rd", kind: "read" },
      { serverId, name: "wr", kind: "write" },
    ]);
    const [c] = await db.insert(connectors).values({ name: `s4f45-conn-${RUN}`, kind: "crm" }).returning({ id: connectors.id });
    connectorId = c!.id;
  });
  afterAll(async () => {
    stewardCheckTestHooks.afterStewardReads = undefined;
  });
  const check = (stewards: string[], set: Partial<Omit<PutAgentGrants, "revision">>) =>
    db.transaction((tx) => firstItemNoStewardHolds(tx as unknown as Db, stewards, { ...emptySet, agents: [], revision: 0, ...set }));
  const mkRole = async (label: string) => (await db.insert(roles).values({ name: `s4f45-${label}-${RUN}` }).returning({ id: roles.id }))[0]!.id;

  it("L3: a role is held only by a steward for whom none of its tools, servers, agents or connectors is revoked", async () => {
    const agentId = await mkAgent("l3b-agent");
    const role = await mkRole("bundle");
    await db.insert(roleToolGrants).values({ roleId: role, serverId, toolName: "wr" });
    await db.insert(roleServerGrants).values({ roleId: role, serverId, readOnlyAll: true });
    await db.insert(roleAgentGrants).values({ roleId: role, agentId, allowedModes: ["plan"] });
    await db.insert(roleConnectorGrants).values({ roleId: role, connectorId, mode: "read" });

    // one steward per revocation kind, each first proven to hold the role (the positive control)
    const revokers: Array<[string, (userId: string) => Promise<unknown>]> = [
      ["tool", (userId) => db.insert(revocations).values({ userId, serverId, toolName: "wr" })],
      ["server", (userId) => db.insert(revocations).values({ userId, serverId, toolName: null })],
      ["agent", (userId) => db.insert(agentRevocations).values({ userId, agentId })],
      ["connector", (userId) => db.insert(connectorRevocations).values({ userId, connectorId })],
    ];
    for (const [kind, revoke] of revokers) {
      const p = await mkUser(`l3b-${kind}`);
      await db.insert(roleAssignments).values({ userId: p.id, roleId: role });
      expect(await check([p.id], { roleIds: [role] }), `${kind}: control`).toBeNull();
      await revoke(p.id);
      expect(await check([p.id], { roleIds: [role] }), `${kind}: revoked`).toBe(`role ${role}`);
    }
    // a tool revocation for a tool the role does NOT bundle leaves the role whole
    const other = await mkUser("l3b-unrelated");
    await db.insert(roleAssignments).values({ userId: other.id, roleId: role });
    await db.insert(revocations).values({ userId: other.id, serverId, toolName: "rd-not-bundled" });
    expect(await check([other.id], { roleIds: [role] })).toBeNull();

    // "for every steward who holds the role": one revoked steward and one whole steward → held
    const revoked = await mkUser("l3b-revoked");
    const whole = await mkUser("l3b-whole");
    for (const u of [revoked, whole]) await db.insert(roleAssignments).values({ userId: u.id, roleId: role });
    await db.insert(agentRevocations).values({ userId: revoked.id, agentId });
    expect(await check([revoked.id], { roleIds: [role] })).toBe(`role ${role}`);
    expect(await check([revoked.id, whole.id], { roleIds: [role] })).toBeNull();
  });

  /** start `fn` with the steward check paused after its locked reads; resolves once it is paused */
  async function pausedCheck<T>(fn: () => Promise<T>) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const atPause = new Promise<void>((r) => (reached = r));
    stewardCheckTestHooks.afterStewardReads = async () => {
      stewardCheckTestHooks.afterStewardReads = undefined; // this one check only
      reached();
      await gate;
    };
    const done = fn();
    await atPause;
    return { done, release };
  }
  const settledWithin = async (p: Promise<unknown>, ms: number) => {
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, ms));
    return settled;
  };

  it("L5: a revocation of a steward waits for a grant-set write whose check relied on that steward", async () => {
    const p = await mkUser("l5-steward");
    await db.insert(toolGrants).values({ userId: p.id, serverId, toolName: "wr" });
    const subject = await mkAgent("l5-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    await db.update(workloadIdentities).set({ sponsorUserIds: [p.id] }).where(eq(workloadIdentities.id, ident.id));
    const set = { ...emptySet, agents: [], revision: 0, tools: [{ serverId, toolName: "wr" }] };

    const { done, release } = await pausedCheck(() => putIdentityGrants(db, ident.id, set, null));
    // the revocation through the real route takes the person's row and must wait for the check's transaction
    const order: string[] = [];
    const revoke = inject("POST", "/v1/revocations", AUTH, { userId: p.id, serverId, toolName: "wr" }).then((r) => {
      order.push("revocation");
      return r;
    });
    expect(await settledWithin(revoke, 750), "the revocation committed while the steward check was open").toBe(false);
    release();
    const written = await done.then((r) => {
      order.push("grant");
      return r;
    });
    expect(written.revision).toBe(1);
    expect((await revoke).statusCode).toBe(201);
    expect(order).toEqual(["grant", "revocation"]); // a serial history: the grant was valid when it committed
    // the other order is seen: with the revocation committed, the next write is refused
    await expect(putIdentityGrants(db, ident.id, { ...set, revision: 1 }, null)).rejects.toMatchObject({ code: "grant_exceeds_stewards" });

    // positive control: an insert that does NOT take the person's row (the pre-fix route) is not held back by the
    // check's FOR SHARE reads, which is the race L5 named
    const q = await mkUser("l5-control");
    await db.insert(toolGrants).values({ userId: q.id, serverId, toolName: "wr" });
    const subject2 = await mkAgent("l5-subject2");
    const ident2 = await ensureIdentityFor(db, { kind: "agent", id: subject2 });
    await db.update(workloadIdentities).set({ sponsorUserIds: [q.id] }).where(eq(workloadIdentities.id, ident2.id));
    const paused = await pausedCheck(() => putIdentityGrants(db, ident2.id, set, null));
    const raw = db2.insert(revocations).values({ userId: q.id, serverId, toolName: "wr" });
    expect(await settledWithin(raw, 2000), "an unlocked insert slips past the open check").toBe(true);
    paused.release();
    await paused.done; // committed against a revocation that was already committed: the race the lock closes
  });

  it("PR #339 review item 2: an item added to a role waits for a grant-set write whose check read that role", async () => {
    const p = await mkUser("rb-steward");
    const role = await mkRole("rb");
    await db.insert(roleToolGrants).values({ roleId: role, serverId, toolName: "rd" });
    await db.insert(roleAssignments).values({ userId: p.id, roleId: role });
    // the steward has lost "wr"; the role does not bundle it yet, so the steward holds the whole role
    await db.insert(revocations).values({ userId: p.id, serverId, toolName: "wr" });
    const subject = await mkAgent("rb-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    await db.update(workloadIdentities).set({ sponsorUserIds: [p.id] }).where(eq(workloadIdentities.id, ident.id));
    const set = { ...emptySet, agents: [], revision: 0, roleIds: [role] };

    const { done, release } = await pausedCheck(() => putIdentityGrants(db, ident.id, set, null));
    // the revoked tool joins the role through the real route, which takes the role's row first and must wait
    const order: string[] = [];
    const add = inject("POST", `/v1/roles/${role}/grants/tools`, AUTH, { serverId, toolName: "wr" }).then((r) => {
      order.push("role-grant");
      return r;
    });
    expect(await settledWithin(add, 750), "the role gained an item while the steward check was open").toBe(false);
    release();
    const written = await done.then((r) => {
      order.push("identity-grant");
      return r;
    });
    expect(written.revision).toBe(1);
    expect((await add).statusCode).toBe(201);
    expect(order).toEqual(["identity-grant", "role-grant"]); // serial: the role was whole for the steward at the write
    // the other order: with "wr" in the role, the next write of the same set is refused
    await expect(putIdentityGrants(db, ident.id, { ...set, revision: 1 }, null)).rejects.toMatchObject({ code: "grant_exceeds_stewards" });

    // positive control: an insert that does NOT take the role's row (the pre-fix route; its foreign-key check takes
    // only FOR KEY SHARE) is not held back by the check's FOR SHARE on the role, which is the race this closes
    const q = await mkUser("rb-control");
    const role2 = await mkRole("rb-control");
    await db.insert(roleToolGrants).values({ roleId: role2, serverId, toolName: "rd" });
    await db.insert(roleAssignments).values({ userId: q.id, roleId: role2 });
    await db.insert(revocations).values({ userId: q.id, serverId, toolName: "wr" });
    const subject2 = await mkAgent("rb-subject2");
    const ident2 = await ensureIdentityFor(db, { kind: "agent", id: subject2 });
    await db.update(workloadIdentities).set({ sponsorUserIds: [q.id] }).where(eq(workloadIdentities.id, ident2.id));
    const paused = await pausedCheck(() => putIdentityGrants(db, ident2.id, { ...set, roleIds: [role2] }, null));
    const raw = db2.insert(roleToolGrants).values({ roleId: role2, serverId, toolName: "wr" });
    expect(await settledWithin(raw, 2000), "an unlocked role-grant insert slips past the open check").toBe(true);
    paused.release();
    await paused.done; // committed with a role that already bundled a tool its steward had lost: the race the lock closes
  });

  it("deadlock: a force role delete during the steward check waits on the role row; both finish, no 40P01", async () => {
    const p = await mkUser("dl-steward");
    const role = await mkRole("dl");
    await db.insert(roleToolGrants).values({ roleId: role, serverId, toolName: "wr" });
    await db.insert(roleConnectorGrants).values({ roleId: role, connectorId, mode: "read" });
    await db.insert(roleAssignments).values({ userId: p.id, roleId: role });
    const subject = await mkAgent("dl-subject");
    const ident = await ensureIdentityFor(db, { kind: "agent", id: subject });
    await db.update(workloadIdentities).set({ sponsorUserIds: [p.id] }).where(eq(workloadIdentities.id, ident.id));

    const { done, release } = await pausedCheck(() => putIdentityGrants(db, ident.id, { ...emptySet, agents: [], revision: 0, roleIds: [role] }, null));
    const del = app.inject({ method: "DELETE", url: `/v1/roles/${role}`, headers: AUTH, payload: { force: true, reason: "deadlock probe" } });
    expect(await settledWithin(del, 750), "the delete went ahead while the check held the role").toBe(false);
    release();
    const written = await done;
    expect(written.roleIds).toEqual([role]);
    const deleted = await del;
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await db.select().from(roles).where(eq(roles.id, role))).toHaveLength(0);
  });

  it("deadlock positive control: the old lock order (assignments before the role) deadlocks with the cascade", async () => {
    const p = await mkUser("dl-control");
    const role = await mkRole("dl-control");
    await db.insert(roleToolGrants).values({ roleId: role, serverId, toolName: "wr" });
    await db.insert(roleServerGrants).values({ roleId: role, serverId, readOnlyAll: true });
    await db.insert(roleAgentGrants).values({ roleId: role, agentId: await mkAgent("dl-control-agent"), allowedModes: ["plan"] });
    await db.insert(roleConnectorGrants).values({ roleId: role, connectorId, mode: "read" });
    await db.insert(roleAssignments).values({ userId: p.id, roleId: role });
    const errors: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let assignmentsLocked!: () => void;
    const atGate = new Promise<void>((r) => (assignmentsLocked = r));
    // the pre-fix order: the steward's assignment rows FOR SHARE, then (after the delete has started) the role's
    // bundled rows FOR SHARE, never the role row first
    const oldCheck = db
      .transaction(async (tx) => {
        await tx.execute(sql`select role_id from role_assignments where user_id = ${p.id} for share`);
        assignmentsLocked();
        await gate;
        for (const t of ["role_connector_grants", "role_agent_grants", "role_server_grants", "role_tool_grants"]) {
          await tx.execute(sql`select 1 from ${sql.identifier(t)} where role_id = ${role} for share`);
        }
      })
      .catch((e: { cause?: { code?: string }; code?: string }) => errors.push(e.cause?.code ?? e.code ?? "?"));
    await atGate; // the old check holds the assignment row before the delete starts (the two pools race otherwise)
    // a per-run marker in the statement text, so the poll below finds exactly this DELETE
    const marker = `dl-control-delete-${RUN}`;
    const del = db2
      .execute(sql`delete from roles where id = ${role} /* ${sql.raw(marker)} */`)
      .catch((e: { cause?: { code?: string }; code?: string }) => errors.push(e.cause?.code ?? e.code ?? "?"));
    // wait (bounded) until the cascading DELETE is blocked on a lock the old check holds: only then has it taken the
    // role and its bundled rows, so the old check's next reads must close the cycle. A fixed sleep raced this.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = await db.execute(
        sql`select 1 from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and wait_event_type = 'Lock' and query like ${`%${marker}%`}`,
      );
      if ((waiting as unknown as { rows: unknown[] }).rows.length > 0) break;
      if (Date.now() > deadline) {
        const seen = await db.execute(sql`select pid, state, wait_event_type, wait_event, left(query, 120) as q from pg_stat_activity where datname = current_database()`);
        throw new Error(`the cascading DELETE never waited on a lock; errors=${JSON.stringify(errors)} activity=${JSON.stringify((seen as unknown as { rows: unknown[] }).rows)}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await Promise.all([oldCheck, del]);
    expect(errors, "the old order deadlocks (40P01)").toContain("40P01");
  });
});
