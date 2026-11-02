/**
 * ADR-0180 / ADR-0186 A — an approval-rule write that LOOSENS dual control
 * needs a `settings_relax` step-up: lowering the quorum, widening the eligible
 * pool (a role added, the named approver moved to someone outside the pool),
 * deleting the rule, and activating (or rolling back to) a version with a
 * lower quorum — including an edit of a versioned rule, which mints and
 * activates. Each is refused 403 `step_up_required` without a grant (an API
 * key never can give one), bound to `{ruleId, values}`, and admitted with a
 * grant for exactly that. Raising the quorum or narrowing the pool needs none.
 *
 * Runs on its OWN scratch database (prefix `b4q_`), dropped in afterAll, so
 * the version ledger and audit rows it writes leave nothing behind (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { approvalRules, authSessions, createDb, eq, inArray, mcpServers, ORG_SETTINGS_ID, roleAssignments, roles, runMigrations, sql, type Db } from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `b4q_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4q-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let serverId: string;
let roleId: string;
const U = {} as Record<"caller" | "a" | "b" | "d" | "e", string>;
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: admin.token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const viaKey = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: admin.key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** refused from an API key and from a session without a grant, bound to `values`; admitted with a grant for exactly it */
async function provesStepUp(method: Method, url: string, payload: unknown, ruleId: string, values: Record<string, unknown>) {
  const action = { kind: "settings_relax", body: { ruleId, values } };
  const key = await viaKey(method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await asAdmin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action).toEqual(action);
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

/** an approval rule over the caller's calls; the pool is A plus the role's B and D (3 principals) */
async function mkRule(body: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/rules/approvals",
    headers: AUTH,
    payload: {
      scope: "user",
      serverScope: "server",
      userId: U.caller,
      serverId,
      toolName: `b4q_${RUN}_${randomBytes(3).toString("hex")}`,
      approverUserId: U.a,
      approverRoleId: roleId,
      quorum: 2,
      ...body,
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const quorumOf = async (id: string) => (await db.select().from(approvalRules).where(eq(approvalRules.id, id)))[0];

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const mkUser = async (label: string, isAdmin = false) => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `b4q-${label}-${RUN}@example.com`, displayName: `b4q ${label}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    return u.json().id as string;
  };
  const adminId = await mkUser("admin", true);
  for (const k of ["caller", "a", "b", "d", "e"] as const) U[k] = await mkUser(k);
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "b4q" } });
  expect(key.statusCode, key.body).toBe(201);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: adminId,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  admin = { id: adminId, key: { authorization: `Bearer ${key.json().token}` }, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: admin.auth.register(opt.json().options), label: "b4q" });
  expect(reg.statusCode, reg.body).toBe(201);
  const [srv] = await db.insert(mcpServers).values({ name: `b4q-srv-${RUN}`, url: `https://b4q-${RUN}.example.com/mcp` }).returning({ id: mcpServers.id });
  serverId = srv!.id;
  const [role] = await db.insert(roles).values({ name: `b4q approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  for (const u of [U.b, U.d]) await db.insert(roleAssignments).values({ userId: u, roleId });
}, 120_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

describe("ADR-0180: an approval-rule write that loosens dual control needs settings_relax", () => {
  it("PATCH lowering the quorum needs it; raising it does not", async () => {
    const id = await mkRule({ quorum: 2 });
    const url = `/v1/rules/approvals/${id}`;
    const up = await viaKey("PATCH", url, { quorum: 3 });
    expect(up.statusCode, up.body).toBe(200);
    await provesStepUp("PATCH", url, { quorum: 1 }, id, { quorum: 1, approverRoleId: roleId, approverUserId: U.a });
    expect((await quorumOf(id))!.quorum).toBe(1);
  });

  it("PATCH widening the pool (a role added, the named approver moved outside it) needs it; narrowing does not", async () => {
    const id = await mkRule({ quorum: 1, approverRoleId: null });
    const url = `/v1/rules/approvals/${id}`;
    await provesStepUp("PATCH", url, { approverRoleId: roleId }, id, { quorum: 1, approverRoleId: roleId, approverUserId: U.a });
    // naming a role member as the approver narrows the pool (A, B, D → B, D): nothing asked
    const narrowed = await viaKey("PATCH", url, { approverUserId: U.b });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const noRole = await viaKey("PATCH", url, { approverRoleId: null });
    expect(noRole.statusCode, noRole.body).toBe(200);
    // the same pool size, but someone who could not approve before now can
    await provesStepUp("PATCH", url, { approverUserId: U.e }, id, { quorum: 1, approverRoleId: null, approverUserId: U.e });
  });

  it("DELETE of an approval rule needs it (removing the rule removes the approval requirement)", async () => {
    const id = await mkRule();
    await provesStepUp("DELETE", `/v1/rules/approvals/${id}`, undefined, id, { deleted: true });
    expect(await quorumOf(id)).toBeUndefined();
  });

  it("activating, or rolling back to, a version with a lower quorum needs it (and so does an edit that mints one); a higher one does not", async () => {
    const id = await mkRule({ quorum: 2 });
    const base = `/v1/config-versions/approval_rule/${id}`;
    const values = (quorum: number) => ({ quorum, approverRoleId: roleId, approverUserId: U.a });
    // raising: minted and activated with no step-up
    const v2 = await viaKey("POST", base, { body: { quorum: 3 }, activate: true });
    expect(v2.statusCode, v2.body).toBe(201);
    const v3 = await viaKey("POST", base, { body: { quorum: 1 }, activate: false });
    expect(v3.statusCode, v3.body).toBe(201); // a draft enforces nothing
    await provesStepUp("POST", `${base}/activate`, { version: v3.json().version.version }, id, values(1));
    // back up to 3: tightening
    const up = await viaKey("POST", `${base}/activate`, { version: v2.json().version.version });
    expect(up.statusCode, up.body).toBe(200);
    // an edit of a versioned rule mints and activates: lowering the quorum that way needs it too
    const minted = await provesStepUp("PATCH", `/v1/rules/approvals/${id}`, { quorum: 2 }, id, values(2));
    expect(minted.json().versionMinted).toBeGreaterThan(v3.json().version.version);
    const tighten = await viaKey("POST", `${base}/activate`, { version: v2.json().version.version });
    expect(tighten.statusCode, tighten.body).toBe(200);
    // rollback re-activates the quorum-2 version: a loosening
    await provesStepUp("POST", `${base}/rollback`, { reason: "b4q drill" }, id, values(2));
    expect((await quorumOf(id))!.quorum).toBe(2);
  });
});

// ADR-0229 amendment (review of #662, blocking finding 1): the most specific matching rule names who signs, so a new
// rule as specific as (or more than) an overlapping rule with a narrower pool takes that pool over. That is the same
// loosening as widening the overlapping rule's own pool, and needs the same settings_relax step-up.
describe("ADR-0229 amendment: outranking an overlapping rule's narrower pool needs settings_relax", () => {
  /** a fleet rule over every write tool on every server whose pool is A alone (written directly: the guard is under test) */
  async function fleetRule(): Promise<string> {
    const [row] = await db
      .insert(approvalRules)
      .values({ scope: "fleet", serverScope: "all", userId: null, serverId: null, toolName: null, writeOnly: true, approverUserId: U.a, approverRoleId: null, quorum: 2 })
      .returning({ id: approvalRules.id });
    return row!.id;
  }
  const narrower = (approverUserId: string, toolName = `b4q_${RUN}_${randomBytes(3).toString("hex")}`) => ({
    scope: "user",
    serverScope: "server",
    userId: U.caller,
    serverId,
    toolName,
    approverUserId,
    approverRoleId: null,
    quorum: 1,
  });

  it("a narrower rule with a different pool is refused without the step-up, bound to the fleet rule it outranks", async () => {
    const fleetId = await fleetRule();
    try {
      const body = narrower(U.e);
      const action = { kind: "settings_relax", body: { ruleId: "new-approval-rule", values: { outranksApprovalRules: [fleetId], approverUserId: U.e, approverRoleId: null } } };
      const key = await viaKey("POST", "/v1/rules/approvals", body);
      expect(key.statusCode, key.body).toBe(403);
      expect(key.json()).toMatchObject({ error: "step_up_required" });
      const refused = await asAdmin("POST", "/v1/rules/approvals", body);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().action).toEqual(action);
      expect(await db.select().from(approvalRules).where(eq(approvalRules.toolName, body.toolName))).toHaveLength(0);
      const ok = await asAdmin("POST", "/v1/rules/approvals", body, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(201);
      await db.delete(approvalRules).where(eq(approvalRules.id, ok.json().id));
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, fleetId));
    }
  });

  it("a narrower rule whose pool stays inside the fleet rule's pool needs none, and neither does a broader rule", async () => {
    const fleetId = await fleetRule();
    try {
      const same = await viaKey("POST", "/v1/rules/approvals", narrower(U.a));
      expect(same.statusCode, same.body).toBe(201);
      // a role rule outranks the fleet rule too, but it is not at least as specific as the user rule just created,
      // and its pool (A) is the fleet rule's: nothing is taken over
      const role = await viaKey("POST", "/v1/rules/approvals", { scope: "role", roleId, serverScope: "all", writeOnly: true, approverUserId: U.a, quorum: 1 });
      expect(role.statusCode, role.body).toBe(201);
      await db.delete(approvalRules).where(inArray(approvalRules.id, [same.json().id, role.json().id]));
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, fleetId));
    }
  });

  it("a TIE counts: an equally specific overlapping rule with a different pool needs the step-up too", async () => {
    const fleetId = await fleetRule();
    try {
      const tie = await viaKey("POST", "/v1/rules/approvals", { scope: "fleet", serverScope: "all", writeOnly: true, approverUserId: U.e, quorum: 1 });
      expect(tie.statusCode, tie.body).toBe(403);
      expect(tie.json()).toMatchObject({ error: "step_up_required" });
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, fleetId));
    }
  });

  it("an edit that moves the approver outside the fleet pool carries the takeover in its one step-up", async () => {
    const fleetId = await fleetRule();
    // the caller's rule on one tool, approver A: inside the fleet pool, so created with no step-up
    const created = await viaKey("POST", "/v1/rules/approvals", narrower(U.a));
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    try {
      // A -> E widens this rule's own pool AND takes the fleet rule's pool over: one step-up, bound to both
      const refused = await asAdmin("PATCH", `/v1/rules/approvals/${id}`, { approverUserId: U.e });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().action).toEqual({
        kind: "settings_relax",
        body: { ruleId: id, values: { quorum: 1, approverRoleId: null, approverUserId: U.e, outranksApprovalRules: [fleetId] } },
      });
      const ok = await asAdmin("PATCH", `/v1/rules/approvals/${id}`, { approverUserId: U.e }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await db.delete(approvalRules).where(inArray(approvalRules.id, [id, fleetId]));
    }
  });
});

// ADR-0229 amendment, review round 2: the reverse takeover (B1), the deploy-mode route (blocker), and the
// conservative role/team overlap (N5).
describe("ADR-0229 amendment round 2: who signs can only move to a wider pool with settings_relax", () => {
  type RuleRow = typeof approvalRules.$inferInsert;
  const insertRule = async (r: Partial<RuleRow>) =>
    (
      await db
        .insert(approvalRules)
        .values({ scope: "user", serverScope: "server", userId: U.caller, serverId, toolName: null, writeOnly: false, approverUserId: U.a, approverRoleId: null, quorum: 1, ...r } as RuleRow)
        .returning({ id: approvalRules.id })
    )[0]!.id;
  const tool = () => `b4q_${RUN}_${randomBytes(3).toString("hex")}`;

  it("B1 (four steps): making the narrow rule less specific (tool -> any) lets a wider rule take its calls; needs it", async () => {
    // 1. N: the caller, this server, tool X, pool {A}
    const n = await viaKey("POST", "/v1/rules/approvals", { scope: "user", serverScope: "server", userId: U.caller, serverId, toolName: tool(), approverUserId: U.a, approverRoleId: null, quorum: 1 });
    expect(n.statusCode, n.body).toBe(201);
    const nId = n.json().id as string;
    // 2. B: the caller, this server, any WRITE tool, pool {A, B, D}: less specific than N, so no takeover, no step-up
    const b = await viaKey("POST", "/v1/rules/approvals", { scope: "user", serverScope: "server", userId: U.caller, serverId, writeOnly: true, approverUserId: U.a, approverRoleId: roleId, quorum: 1 });
    expect(b.statusCode, b.body).toBe(201);
    const bId = b.json().id as string;
    try {
      // 3. N: tool X -> any tool. Widening what a rule matches is a tightening on its own, but B (write-only) now
      //    outranks N, so B's wider pool would sign for the caller's write calls N named A alone for
      const url = `/v1/rules/approvals/${nId}`;
      const key = await viaKey("PATCH", url, { toolName: null });
      expect(key.statusCode, key.body).toBe(403);
      expect(key.json()).toMatchObject({ error: "step_up_required" });
      const refused = await asAdmin("PATCH", url, { toolName: null });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().action).toEqual({
        kind: "settings_relax",
        body: { ruleId: nId, values: { outrankedByApprovalRules: [bId], approverUserId: U.a, approverRoleId: null } },
      });
      expect((await quorumOf(nId))!.toolName).not.toBeNull();
      // 4. with the step-up it is admitted, audited like any loosening
      const ok = await asAdmin("PATCH", url, { toolName: null }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await db.delete(approvalRules).where(inArray(approvalRules.id, [nId, bId]));
    }
  });

  it("B1, deploy-mode variant: clearing the narrow rule's mode lets an equally specific wider rule tie it; needs it", async () => {
    const t = tool();
    const nId = await insertRule({ toolName: t, deployMode: "hosted", approverUserId: U.a });
    const bId = await insertRule({ toolName: t, deployMode: null, approverUserId: U.a, approverRoleId: roleId });
    try {
      const url = `/v1/rules/approvals/${nId}/deploy-mode`;
      const key = await viaKey("PATCH", url, { deployMode: null });
      expect(key.statusCode, key.body).toBe(403);
      const refused = await asAdmin("PATCH", url, { deployMode: null });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().action.body.values).toMatchObject({ outrankedByApprovalRules: [bId] });
      const ok = await asAdmin("PATCH", url, { deployMode: null }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await quorumOf(nId))!.deployMode).toBeNull();
    } finally {
      await db.delete(approvalRules).where(inArray(approvalRules.id, [nId, bId]));
    }
  });

  it("deploy-mode route (review blocker): clearing a user rule's mode over a fleet rule with a restricted pool needs it", async () => {
    // A: the caller's rule in mode hosted, approver E. F: a fleet rule in mode byoc, pool {A} (the security lead's).
    // Disjoint while both are mode-scoped; clearing A's mode makes A overlap F and outrank it (user > fleet).
    const aId = await insertRule({ deployMode: "hosted", approverUserId: U.e });
    const fId = await insertRule({ scope: "fleet", serverScope: "all", userId: null, serverId: null, writeOnly: true, deployMode: "byoc", approverUserId: U.a, quorum: 2 });
    try {
      const url = `/v1/rules/approvals/${aId}/deploy-mode`;
      const refused = await asAdmin("PATCH", url, { deployMode: null });
      expect(refused.statusCode, refused.body).toBe(403);
      // the binding names the pool being taken over (review non-blocking 4)
      expect(refused.json().action).toEqual({
        kind: "settings_relax",
        body: { ruleId: aId, values: { outranksApprovalRules: [fId], approverUserId: U.e, approverRoleId: null } },
      });
      expect((await quorumOf(aId))!.deployMode).toBe("hosted");
      const ok = await asAdmin("PATCH", url, { deployMode: null }, { [STEP_UP_HEADER]: await grantFor(refused.json().action) });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      await db.delete(approvalRules).where(inArray(approvalRules.id, [aId, fId]));
    }
  });

  it("N5: a role rule overlaps a fleet rule even for a role nobody holds (membership is never assumed)", async () => {
    const fId = await insertRule({ scope: "fleet", serverScope: "all", userId: null, serverId: null, writeOnly: true, approverUserId: U.a, quorum: 2 });
    const [empty] = await db.insert(roles).values({ name: `b4q nobody ${RUN}` }).returning({ id: roles.id });
    try {
      const r = await viaKey("POST", "/v1/rules/approvals", { scope: "role", roleId: empty!.id, serverScope: "all", writeOnly: true, approverUserId: U.e, quorum: 1 });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ error: "step_up_required" });
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, fId));
    }
  });
});
