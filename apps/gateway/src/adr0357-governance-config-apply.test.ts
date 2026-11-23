/**
 * ADR-0357 slice 1b: POST /v1/governance-config/apply.
 *
 *  - every apply needs a settings_relax step-up bound to {op, planHash, widenings}: the bootstrap token, a bare
 *    session and a grant for another plan are all refused, and nothing is written;
 *  - a planHash that is not the document's plan against live now is 409 plan_stale; a plan with issues is 422;
 *  - with exactly its grant, every change lands through the UI's own stores (role grants, a versioned rate-limit
 *    edit, a project budget patch), with one audit row per change and one for the apply;
 *  - all or nothing: a writer refusing midway (an archived project) rolls back the changes before it;
 *  - a held role cannot be deleted by a file; sections not yet appliable are refused whole.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  mcpServers,
  mcpTools,
  ORG_SETTINGS_ID,
  orgSettings,
  projects,
  rateLimits,
  roleAssignments,
  roleToolGrants,
  roles,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, GOVERNANCE_CONFIG_API_VERSION } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `ga-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const n = (s: string) => `ga-${s}-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKeyAuth: { authorization: string };
let approverId: string;
let serverId: string;
let roleId: string;
let projectId: string;
const restores: Array<() => Promise<void>> = [];

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();
  const [a] = await db.insert(users).values({ email: `${n("admin")}@example.test`, displayName: "admin", isAdmin: true }).returning({ id: users.id });
  adminId = a!.id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "ga-admin" } });
  expect(key.statusCode, key.body).toBe(201);
  adminKeyAuth = { authorization: `Bearer ${key.json().token}` };
  const [u] = await db.insert(users).values({ email: `${n("approver")}@example.test`, displayName: "approver" }).returning({ id: users.id });
  approverId = u!.id;
  const [s] = await db.insert(mcpServers).values({ name: n("server"), url: "https://mcp.example.test/" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.insert(mcpTools).values([
    { serverId, name: "read_issue", kind: "read" },
    { serverId, name: "close_issue", kind: "write" },
  ]);
  const [r] = await db.insert(roles).values({ name: n("eng") }).returning({ id: roles.id });
  roleId = r!.id;
  await db.insert(roleToolGrants).values({ roleId, serverId, toolName: "read_issue" });
  await db.insert(rateLimits).values({ scope: "role", roleId, serverScope: "server", serverId, maxCalls: 100, windowSeconds: 3600 });
  const [p] = await db.insert(projects).values({ name: n("project"), budgetUsd: 500, budgetApproverUserId: approverId }).returning({ id: projects.id });
  projectId = p!.id;
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await db.delete(rateLimits).where(eq(rateLimits.serverId, serverId));
  for (const name of [n("eng"), n("ops"), n("held")]) await db.delete(roles).where(eq(roles.name, name));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await app.close();
});

/** the document: this file's objects only, in the sections it names */
const doc = (spec: Record<string, unknown>) => ({ apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec });
/** the live state of this file's objects as a document, with `edit` applied to the sections it returns */
async function liveDoc() {
  const r = await app.inject({ method: "GET", url: "/v1/governance-config/export?format=json", headers: AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().spec as { roles: Array<Record<string, unknown>>; rateLimits: Array<Record<string, unknown>>; budgets: Array<Record<string, unknown>> };
}
async function planOf(document: unknown) {
  const r = await app.inject({ method: "POST", url: "/v1/governance-config/plan", headers: AUTH, payload: { document } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const factsOf = (plan: { plan: { planHash: string }; widenings: unknown[] }) => ({
  kind: "settings_relax" as const,
  facts: { op: "governance_config_apply", planHash: plan.plan.planHash, widenings: plan.widenings },
});
const apply = (payload: Record<string, unknown>, auth: { headers?: Record<string, string>; cookies?: Record<string, string> }) =>
  app.inject({ method: "POST", url: "/v1/governance-config/apply", ...auth, payload });

/** the target: role eng swaps read_issue for close_issue (widens), a new role ops, eng's limit raised to 200
 * (widens), a new fleet limit, and the budget lowered (narrows) */
async function targetDocument() {
  const live = await liveDoc();
  return doc({
    roles: [
      ...live.roles.filter((r) => r.name !== n("eng") && r.name !== n("ops")),
      { name: n("eng"), toolGrants: [{ server: n("server"), tool: "close_issue" }] },
      { name: n("ops"), description: "operations" },
    ],
    rateLimits: [
      ...live.rateLimits.filter((l) => l.subject !== n("eng") && l.subject !== n("ops")),
      { scope: "role", subject: n("eng"), server: n("server"), maxCalls: 200, windowSeconds: 3600 },
      { scope: "role", subject: n("ops"), server: n("server"), tool: "close_issue", maxCalls: 5, windowSeconds: 60 },
    ],
    budgets: [...live.budgets.filter((b) => b.project !== n("project")), { project: n("project"), budgetUsd: 300, approverUserId: approverId }],
  });
}

const ourGrants = async () => (await db.select().from(roleToolGrants).where(eq(roleToolGrants.roleId, roleId))).map((g) => g.toolName).sort();

describe("POST /v1/governance-config/apply: the gate", () => {
  it("refuses an admin API key, a bare session and a grant for another plan; writes nothing", async () => {
    const document = await targetDocument();
    const plan = await planOf(document);
    expect(plan.applicable).toBe(true);
    expect(plan.widenings.length).toBeGreaterThan(0);

    // an API key can never step up, so a leaked admin key can never apply a file
    const byKey = await apply({ document, planHash: plan.plan.planHash }, { headers: adminKeyAuth });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(byKey.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax", credential: "api_key" });

    const other = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { op: "governance_config_apply", planHash: "0".repeat(64), widenings: [] } });
    const bare = await apply({ document, planHash: plan.plan.planHash }, sessionRequest(other));
    expect([403, 422], bare.body).toContain(bare.statusCode);
    const wrong = await apply({ document, planHash: plan.plan.planHash }, stepUpRequest(other));
    expect([403, 422], wrong.body).toContain(wrong.statusCode);
    expect(await grantSpent(db, other.grantId)).toBe(false);

    expect(await ourGrants()).toEqual(["read_issue"]);
    expect(await db.select().from(roles).where(eq(roles.name, n("ops")))).toEqual([]);
  });

  it("a planHash that is not this document's plan is 409 plan_stale", async () => {
    const document = await targetDocument();
    const plan = await planOf(document);
    const g = await grantStepUpForTest(db, adminId, factsOf(plan));
    const r = await apply({ document, planHash: "f".repeat(64) }, stepUpRequest(g));
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "plan_stale", planHash: plan.plan.planHash });
    expect(await grantSpent(db, g.grantId)).toBe(false);
  });

  it("a plan with issues is 422, and a section apply does not write yet is refused whole", async () => {
    const bad = doc({ rateLimits: [...(await liveDoc()).rateLimits, { scope: "role", subject: n("nobody"), maxCalls: 1, windowSeconds: 60 }] });
    const badPlan = await planOf(bad);
    const g = await grantStepUpForTest(db, adminId, factsOf(badPlan));
    const r = await apply({ document: bad, planHash: badPlan.plan.planHash }, stepUpRequest(g));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("plan_has_issues");

    const wf = doc({ workflowTemplates: [] });
    const wfPlan = await planOf(wf);
    if (wfPlan.plan.changes.length > 0) {
      const w = await apply({ document: wf, planHash: wfPlan.plan.planHash }, stepUpRequest(await grantStepUpForTest(db, adminId, factsOf(wfPlan))));
      expect(w.statusCode, w.body).toBe(422);
      expect(w.json()).toMatchObject({ error: "section_not_appliable", sections: ["workflowTemplates"] });
    }
  });

  it("a held role cannot be deleted by a file: the plan reports it", async () => {
    const [held] = await db.insert(roles).values({ name: n("held") }).returning({ id: roles.id });
    await db.insert(roleAssignments).values({ userId: approverId, roleId: held!.id });
    const live = await liveDoc();
    const plan = await planOf(doc({ roles: live.roles.filter((r) => r.name !== n("held")) }));
    expect(plan.issues).toContainEqual(expect.objectContaining({ section: "roles", key: n("held"), code: "role_held" }));
    expect(plan.applicable).toBe(false);
    await db.delete(roles).where(eq(roles.id, held!.id));
  });
});

describe("POST /v1/governance-config/apply: writing", () => {
  it("all or nothing: a writer refusing midway rolls back every change before it", async () => {
    const document = await targetDocument();
    const plan = await planOf(document);
    await db.update(projects).set({ archivedAt: new Date(), archivedReason: "archived for the rollback test" }).where(eq(projects.id, projectId));
    try {
      const g = await grantStepUpForTest(db, adminId, factsOf(plan));
      const r = await apply({ document, planHash: plan.plan.planHash }, stepUpRequest(g));
      expect(r.statusCode, r.body).toBe(409);
      // roles and rate limits are written before budgets: none of them survived
      expect(await ourGrants()).toEqual(["read_issue"]);
      expect(await db.select().from(roles).where(eq(roles.name, n("ops")))).toEqual([]);
      const [limit] = await db.select().from(rateLimits).where(eq(rateLimits.roleId, roleId));
      expect(limit!.maxCalls).toBe(100);
      const [refusal] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "governance_config"), eq(auditLog.ruleId, "governance_config.apply")))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(refusal).toMatchObject({ effect: "deny" });
    } finally {
      await db.update(projects).set({ archivedAt: null, archivedReason: null, archivedByUserId: null }).where(eq(projects.id, projectId));
    }
  });

  it("with exactly its grant, every change lands through the UI's stores, audited, and the file now plans clean", async () => {
    const document = await targetDocument();
    const plan = await planOf(document);
    const g = await grantStepUpForTest(db, adminId, factsOf(plan));
    const r = await apply({ document, planHash: plan.plan.planHash }, stepUpRequest(g));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ applied: true, planHash: plan.plan.planHash });
    expect(await grantSpent(db, g.grantId)).toBe(true);

    expect(await ourGrants()).toEqual(["close_issue"]);
    const [ops] = await db.select().from(roles).where(eq(roles.name, n("ops")));
    expect(ops).toMatchObject({ description: "operations" });
    const limits = await db.select().from(rateLimits).where(eq(rateLimits.serverId, serverId));
    expect(limits.find((l) => l.roleId === ops!.id)).toMatchObject({ toolName: "close_issue", maxCalls: 5, windowSeconds: 60 });
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.budgetUsd).toBe(300);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "governance_config"), eq(auditLog.ruleId, "governance_config.apply.change")))
      .orderBy(desc(auditLog.at))
      .limit(plan.plan.changes.length);
    expect(rows.every((row) => (row.detail as { planHash: string }).planHash === plan.plan.planHash)).toBe(true);

    // the enforced limit (a versioned edit's active body over the row) is what export reads: the file plans clean
    const again = await planOf(document);
    expect(again.plan.changes).toEqual([]);

    // a replay of the same planHash is stale now (the live state moved), and the current plan has nothing to do
    const replay = await apply({ document, planHash: plan.plan.planHash }, stepUpRequest(await grantStepUpForTest(db, adminId, factsOf(plan))));
    expect(replay.statusCode, replay.body).toBe(409);
    expect(replay.json()).toMatchObject({ error: "plan_stale", planHash: again.plan.planHash });
    const noop = await apply({ document, planHash: again.plan.planHash }, { headers: AUTH });
    expect(noop.statusCode, noop.body).toBe(200);
    expect(noop.json()).toMatchObject({ applied: false, detail: "nothing to change" });
  });
});
