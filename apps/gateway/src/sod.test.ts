/**
 * ADR-0091 — toxic-combination SoD at the grant choke point (gap L23,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * What this file makes impossible to fake:
 *
 *  1. A GATE THAT ONLY GUARDS ONE DOOR. Refusals are driven through direct
 *     grants (agent, connector-with-mode, MCP tool, MCP server), through a
 *     grant to a ROLE with assignees (the check must reach every current
 *     assignee), through role ASSIGNMENT (the bundle vs the assignee's
 *     holdings AND a bundle-internal pair) — with a delta-0 pinned on the
 *     grant table at every refusal.
 *  2. A CHECK THAT DOESN'T SEE WHAT ENFORCEMENT SEES. Holdings are
 *     direct ∪ role-derived − revocations: a role-derived holding triggers
 *     the refusal, and an ADR-0019 revocation FREES the identity to take
 *     the other side (the subtraction is load-bearing, not decorative).
 *  3. A RULE THAT REVOKES BY SIDE EFFECT. Disabling a rule lets both sides
 *     mint (enabled changes what is ENFORCED); re-enabling surfaces the now-
 *     existing violator in the rules list, the inventory and posture — and
 *     BOTH grants provably survive.
 *  4. A SELF-SIGNED OVERRIDE. The escalation's decider bar is keyed on who
 *     actually signs: the requester deciding their own escalation WITH an
 *     admin-override reason (the strongest credential the decide path
 *     accepts) is refused by name.
 *  5. AN OVERRIDE THAT OUTGROWS ITS RULE. Approving an escalation re-checks
 *     the stored mint: a DIFFERENT rule that started conflicting after the
 *     escalation refuses the approval by name — one override, one rule.
 *  6. A PILLAR-7 SIDE DOOR. A worker agent inherits the INITIATING user's
 *     entitlements (pillar7-inheritance.test.ts pins the mechanism), so a
 *     capability SoD refused at mint never reaches a worker either — proved
 *     here by driving a run at the refused capability.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed sod-. sod_rules / sod_override_requests rows
 * are created only by this file, so per-rule numbers are absolute; anything
 * org-wide (audit counts, posture violation totals) is a delta (M-008). No
 * singleton is touched (M-012).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
// ADR-0186 A (Class C, PR #198 round 4): this suite drives SoD / skill-admission writes through API keys and is
// not about step-up; disabling a SoD rule or admitting a held skill now needs one, so step-up is relaxed for its run
// and the strict policy restored after (M-068). The step-up itself is proved in zz-b4c4-review-fixes.
let restoreStepUpPosture: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  auditLog,
  connectorGrants,
  count,
  createDb,
  eq,
  roleAgentGrants,
  roleAssignments,
  runMigrations,
  sodRules,
  and,
  sodOverrideRequests,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { sodPostureSection } from "./sod.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sod-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let adminId: string; // admin — creates rules, requests overrides
let adminAuth: Auth;
let approverId: string; // second admin — the arm's-length approver
let approverAuth: Auth;
let uPayId: string; // holds side A (the payment agent) directly
let uPayAuth: Auth;
let uCleanId: string; // becomes the surfaced violator (via a disabled-rule window)
let uModeId: string; // the connector-mode case + the approved override's subject
let uModeReadId: string; // control: read-mode grant is NOT refused
let uRoleId: string; // assignee of sod-role (the role-path cases)
let uBothId: string; // fresh — the bundle-internal assignment case
let uRevId: string; // the revocation-subtraction case
let uSrvId: string; // the mcp_server-side case
let approverP7Id: string; // escalation approver for the pillar-7 run

let agentPay: string; // side A of rule 1
let agentVendor: string; // side B of rule 1
let agentFree: string; // side B of rule 3 (vs the server)
let connectorId: string; // rule 2 side A (readwrite qualifier)
let serverId: string; // tool sod_tool_pay lives here; also rule 3 side A
let rule1: string; // agentPay x agentVendor
let rule2: string; // connector(readwrite) x tool sod_tool_pay

async function makeUser(email: string, opts: { admin?: boolean } = {}) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const id = u.json().id as string;
  if (opts.admin) {
    const up = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${id}/admin`,
      payload: { isAdmin: true, reason: "sod coverage" },
    });
    expect(up.statusCode).toBe(200);
  }
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "sod-key" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const grantAgent = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });
const grantConnector = (userId: string, mode: "read" | "readwrite") =>
  app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/connectors",
    payload: { userId, connectorId, mode },
  });
const grantTool = (userId: string, toolName: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } });

const createRule = (payload: Record<string, unknown>, auth: Auth = adminAuth) =>
  app.inject({ method: "POST", headers: auth, url: "/v1/sod/rules", payload });
const decide = (auth: Auth, approvalId: string, decision: "approved" | "denied", reason?: string) =>
  app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/approvals/${approvalId}/decide`,
    payload: { decision, ...(reason ? { reason } : {}) },
  });
const posture = async () => {
  const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/reports/posture" });
  expect(res.statusCode).toBe(200);
  return res.json();
};
async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}
async function agentGrantCount(userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(agentGrants).where(eq(agentGrants.userId, userId));
  return row?.n ?? 0;
}

const selAgent = (id: string) => ({ kind: "agent", objectId: id });
const selConnector = (mode?: "read" | "readwrite") => ({
  kind: "connector",
  objectId: connectorId,
  ...(mode ? { mode } : {}),
});
const selTool = (toolName: string) => ({ kind: "mcp_tool", objectId: serverId, toolName });
const selServer = () => ({ kind: "mcp_server", objectId: serverId });

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStepUpPosture = await relaxStepUpForTest(db);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const admin = await makeUser("sod-admin@example.com", { admin: true });
  adminId = admin.id;
  adminAuth = admin.auth;
  const approver = await makeUser("sod-approver@example.com", { admin: true });
  approverId = approver.id;
  approverAuth = approver.auth;
  const uPay = await makeUser("sod-holder-pay@example.com");
  uPayId = uPay.id;
  uPayAuth = uPay.auth;
  uCleanId = (await makeUser("sod-holder-clean@example.com")).id;
  uModeId = (await makeUser("sod-holder-mode@example.com")).id;
  uModeReadId = (await makeUser("sod-holder-mode-read@example.com")).id;
  uRoleId = (await makeUser("sod-holder-role@example.com")).id;
  uBothId = (await makeUser("sod-holder-both@example.com")).id;
  uRevId = (await makeUser("sod-holder-rev@example.com")).id;
  uSrvId = (await makeUser("sod-holder-srv@example.com")).id;
  approverP7Id = (await makeUser("sod-p7-approver@example.com")).id;

  agentPay = await mkAgent("sod-agent-pay");
  agentVendor = await mkAgent("sod-agent-vendor");
  agentFree = await mkAgent("sod-agent-free");

  const connector = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/connectors",
    payload: { name: "sod-connector", kind: "erp" },
  });
  expect(connector.statusCode).toBe(201);
  connectorId = connector.json().id;

  const server = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "sod-server", url: "http://127.0.0.1:9" },
  });
  expect(server.statusCode).toBe(201);
  serverId = server.json().id;
  for (const name of ["sod_tool_pay", "sod_tool_vendor"]) {
    const t = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/servers/${serverId}/tools`,
      payload: { name, kind: "write" },
    });
    expect(t.statusCode).toBe(201);
  }
});

afterAll(async () => {
  await restoreStepUpPosture?.();
  await restoreAdminKeyMfa?.();
  await restoreStrictAdmission?.();
  await app.close();
  await db.$client.end();
});

describe("rule authoring — reasons required, selectors concrete, surfaces stated", () => {
  it("posture and inventory state outright that no rule is defined — pinned in a rolled-back transaction, order-proof", async () => {
    // Shared DB + size-ordered files (M-008/M-018): another file can create
    // SoD rows first, so global rules===0 is an ordering accident. The
    // none-defined statement is pinned against a transaction that empties
    // sod_rules and rolls back, touching nothing durable.
    const rollback = new Error("rollback");
    await db
      .transaction(async (tx) => {
        await tx.delete(sodRules);
        const s = await sodPostureSection(tx as unknown as Db);
        expect(s.rules).toBe(0);
        expect(s.note).toMatch(/no SoD rule is defined/);
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });
    // live endpoints stay consistent whichever way the shared DB leans
    const p = await posture();
    const inv = await app.inject({ method: "GET", headers: AUTH, url: "/v1/inventory/agents" });
    expect(inv.statusCode).toBe(200);
    for (const section of [p.sod, inv.json().sod]) {
      if (section.rules === 0) expect(section.note).toMatch(/no SoD rule is defined/);
      else expect(section.note).not.toMatch(/no SoD rule is defined/);
    }
  });

  it("refuses by name: unknown object, identical sides, misplaced tool name / mode, missing reason", async () => {
    const ghost = "00000000-0000-4000-8000-00000000dead";
    const bad = await createRule({
      name: "sod-bad-ref",
      reason: "x",
      a: selAgent(agentPay),
      b: selAgent(ghost),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_reference");
    expect(bad.json().field).toBe("b.objectId");

    const same = await createRule({
      name: "sod-bad-same",
      reason: "x",
      a: selAgent(agentPay),
      b: selAgent(agentPay),
    });
    expect(same.statusCode).toBe(422);
    expect(same.json().error).toBe("sod_rule_sides_identical");

    const toolless = await createRule({
      name: "sod-bad-toolless",
      reason: "x",
      a: { kind: "mcp_tool", objectId: serverId },
      b: selAgent(agentPay),
    });
    expect(toolless.statusCode).toBe(422);
    expect(toolless.json().error).toBe("tool_name_required");

    const misMode = await createRule({
      name: "sod-bad-mode",
      reason: "x",
      a: { kind: "agent", objectId: agentPay, mode: "readwrite" },
      b: selAgent(agentVendor),
    });
    expect(misMode.statusCode).toBe(422);
    expect(misMode.json().error).toBe("mode_not_allowed");

    // reason is REQUIRED — an SoD rule without a rationale is cargo cult
    const reasonless = await createRule({ name: "sod-bad-reasonless", a: selAgent(agentPay), b: selAgent(agentVendor) });
    expect(reasonless.statusCode).toBe(400);
  });

  it("creates the agent-pair rule, audited, with zero current violators reported", async () => {
    const before = await auditCount("sod-rule-created");
    const res = await createRule({
      name: "sod-pay-vs-vendor",
      reason: "payment initiation and vendor-master edit together enable invoice fraud",
      a: selAgent(agentPay),
      b: selAgent(agentVendor),
    });
    expect(res.statusCode, res.body).toBe(201);
    rule1 = res.json().id;
    expect(res.json().currentViolators).toEqual([]);
    expect(res.json().a.label).toBe("agent 'sod-agent-pay'");
    expect(res.json().notes.enforcement).toMatch(/never auto-revoked/i);
    expect(await auditCount("sod-rule-created")).toBe(before + 1);

    const dup = await createRule({
      name: "sod-pay-vs-vendor",
      reason: "x",
      a: selAgent(agentPay),
      b: selAgent(agentVendor),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("duplicate_rule_name");
  });
});

describe("mint-time enforcement — direct paths", () => {
  it("a grant that completes no toxic pair proceeds (the gate refuses pairs, not grants)", async () => {
    expect((await grantAgent(uPayId, agentPay)).statusCode).toBe(201);
    // an unrelated identity may hold the OTHER side alone, too
    expect((await grantAgent(uCleanId, agentVendor)).statusCode).toBe(201);
  });

  it("minting the second side is a named 409 carrying the rule, the reason and the existing holding — and no row", async () => {
    const rows = await agentGrantCount(uPayId);
    const refusedBefore = await auditCount("sod-conflict-refused");
    const res = await grantAgent(uPayId, agentVendor);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("sod_conflict");
    expect(body.ruleId).toBe(rule1);
    expect(body.ruleName).toBe("sod-pay-vs-vendor");
    expect(body.ruleReason).toMatch(/invoice fraud/);
    expect(body.conflict.userId).toBe(uPayId);
    expect(body.conflict.existingHolding).toBe("a direct agent grant");
    expect(body.conflict.existingSide).toBe("agent 'sod-agent-pay'");
    // delta-0: the refusal wrote NO grant row
    expect(await agentGrantCount(uPayId)).toBe(rows);
    // and exactly one audited refusal
    expect(await auditCount("sod-conflict-refused")).toBe(refusedBefore + 1);
  });

  it("both orientations refuse: holding side B blocks minting side A", async () => {
    const res = await grantAgent(uCleanId, agentPay); // uClean holds vendor
    expect(res.statusCode).toBe(409);
    expect(res.json().ruleId).toBe(rule1);
    expect(res.json().conflict.existingSide).toBe("agent 'sod-agent-vendor'");
  });

  it("a connector-mode qualifier is honored: readwrite refused, read allowed", async () => {
    const res = await createRule({
      name: "sod-connector-rw-vs-pay-tool",
      reason: "write access to the ERP connector plus the payment tool bypasses maker-checker",
      a: selConnector("readwrite"),
      b: selTool("sod_tool_pay"),
    });
    expect(res.statusCode).toBe(201);
    rule2 = res.json().id;

    expect((await grantTool(uModeId, "sod_tool_pay")).statusCode).toBe(201);
    expect((await grantTool(uModeReadId, "sod_tool_pay")).statusCode).toBe(201);

    const rw = await grantConnector(uModeId, "readwrite");
    expect(rw.statusCode).toBe(409);
    expect(rw.json().ruleId).toBe(rule2);
    expect(rw.json().conflict.existingHolding).toBe("a direct tool grant");
    // the qualifier is 'readwrite' — a read-mode grant completes no pair
    expect((await grantConnector(uModeReadId, "read")).statusCode).toBe(201);
  });

  it("an mcp_server side counts a server read-all grant as the holding", async () => {
    const mk = await createRule({
      name: "sod-server-vs-free-agent",
      reason: "server-wide read plus the free agent exfiltrates the whole surface",
      a: selServer(),
      b: selAgent(agentFree),
    });
    expect(mk.statusCode).toBe(201);
    const sg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/servers",
      payload: { userId: uSrvId, serverId, readOnlyAll: true },
    });
    expect(sg.statusCode).toBe(201);
    const res = await grantAgent(uSrvId, agentFree);
    expect(res.statusCode).toBe(409);
    expect(res.json().conflict.existingHolding).toBe("a direct server read-all grant");
    // clean up this rule so later cases stay about rule1/rule2
    const del = await app.inject({
      method: "DELETE",
      headers: adminAuth,
      url: `/v1/sod/rules/${mk.json().id}`,
    });
    expect(del.statusCode).toBe(200);
  });

  it("an ADR-0019 revocation SUBTRACTS: the revoked side no longer blocks the other", async () => {
    expect((await grantAgent(uRevId, agentPay)).statusCode).toBe(201);
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uRevId}/revocations/agents`,
      payload: { agentId: agentPay, reason: "sod subtraction case" },
    });
    expect(rev.statusCode).toBe(201);
    // the grant ROW still exists, but the EFFECTIVE holding is gone — the
    // check sees direct ∪ role-derived − revocations, like the kernel
    const res = await grantAgent(uRevId, agentVendor);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe("mint-time enforcement — the role paths (the vacuity trap)", () => {
  let roleId: string;
  let roleEmptyId: string;

  it("granting to a role checks EVERY current assignee", async () => {
    const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sod-role" } });
    expect(role.statusCode).toBe(201);
    roleId = role.json().id;
    const assign = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uRoleId}/roles`,
      payload: { roleId },
    });
    expect(assign.statusCode).toBe(201);
    expect((await grantAgent(uRoleId, agentPay)).statusCode).toBe(201);

    const [beforeRow] = await db.select({ n: count() }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId));
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleId}/grants/agents`,
      payload: { agentId: agentVendor },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sod_conflict");
    expect(res.json().ruleId).toBe(rule1);
    expect(res.json().conflict.userId).toBe(uRoleId);
    const [afterRow] = await db.select({ n: count() }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId));
    expect(afterRow!.n).toBe(beforeRow!.n); // delta-0
  });

  it("granting to an EMPTY role is allowed — and assigning that role is where the refusal lands", async () => {
    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "sod-role-vendor" },
    });
    expect(role.statusCode).toBe(201);
    roleEmptyId = role.json().id;
    // no assignees: the grant confers nothing on anybody yet
    const rg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${roleEmptyId}/grants/agents`,
      payload: { agentId: agentVendor },
    });
    expect(rg.statusCode).toBe(201);

    // uRole holds agentPay directly — assigning the vendor-bundling role
    // would complete the pair, so the ASSIGNMENT refuses
    const [beforeRow] = await db
      .select({ n: count() })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, uRoleId), eq(roleAssignments.roleId, roleEmptyId)));
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uRoleId}/roles`,
      payload: { roleId: roleEmptyId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sod_conflict");
    expect(res.json().conflict.existingHolding).toBe("a direct agent grant");
    const [afterRow] = await db
      .select({ n: count() })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, uRoleId), eq(roleAssignments.roleId, roleEmptyId)));
    expect(afterRow!.n).toBe(beforeRow!.n); // delta-0

    // a user holding NEITHER side may take the role (control)
    const ok = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uSrvId}/roles`,
      payload: { roleId: roleEmptyId },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("a role bundling BOTH sides refuses assignment even to a clean user", async () => {
    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "sod-role-both" },
    });
    const bothRoleId = role.json().id as string;
    for (const agentId of [agentPay, agentVendor]) {
      const rg = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/roles/${bothRoleId}/grants/agents`,
        payload: { agentId },
      });
      expect(rg.statusCode).toBe(201); // empty role — nothing conferred yet
    }
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${uBothId}/roles`,
      payload: { roleId: bothRoleId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sod_conflict");
    expect(res.json().conflict.existingHolding).toMatch(/same mint/);
  });

  it("a role-derived holding triggers the refusal exactly like a direct one", async () => {
    // uSrv now holds sod-role-vendor (role-derived agentVendor). Minting
    // agentPay directly must refuse, naming the ROLE as the holding path.
    const res = await grantAgent(uSrvId, agentPay);
    expect(res.statusCode).toBe(409);
    expect(res.json().ruleId).toBe(rule1);
    expect(res.json().conflict.existingHolding).toBe("role 'sod-role-vendor' (agent grant)");
  });
});

describe("existing violations — visible, never auto-revoked", () => {
  it("disabling a rule stops enforcement (an edit changes what is ENFORCED)", async () => {
    const off = await app.inject({
      method: "PATCH",
      headers: adminAuth,
      url: `/v1/sod/rules/${rule1}`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    // uClean holds agentVendor; with rule1 disabled the pair may now mint
    const res = await grantAgent(uCleanId, agentPay);
    expect(res.statusCode, res.body).toBe(201);
  });

  it("re-enabling surfaces the violator everywhere and revokes NOBODY", async () => {
    const postureBefore = await posture();
    const on = await app.inject({
      method: "PATCH",
      headers: adminAuth,
      url: `/v1/sod/rules/${rule1}`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    const violators = on.json().currentViolators as Array<{ userId: string }>;
    expect(violators.map((v) => v.userId)).toContain(uCleanId);

    // the rules list carries the same read-time computation
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/sod/rules" });
    const listed = (list.json().rules as Array<{ id: string; currentViolators: Array<{ userId: string; holdsA: string; holdsB: string }> }>).find(
      (r) => r.id === rule1,
    )!;
    expect(listed.currentViolators.map((v) => v.userId)).toContain(uCleanId);

    // inventory names the rule and the violator
    const inv = await app.inject({ method: "GET", headers: AUTH, url: "/v1/inventory/agents" });
    const invRule = (inv.json().sod.violations as Array<{ ruleId: string; violators: string[] }>).find(
      (v) => v.ruleId === rule1,
    )!;
    expect(invRule.violators.length).toBeGreaterThan(0);

    // posture moves by exactly the violators this file just created (delta)
    const postureAfter = await posture();
    expect(postureAfter.sod.currentViolations).toBeGreaterThan(postureBefore.sod.currentViolations);
    expect(postureAfter.sod.note).toMatch(/never auto-revoked/);

    // and NOTHING was stripped: both grant rows survive
    const access = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${uCleanId}/agents` });
    const held = (access.json().agents as Array<{ agentId?: string; id?: string }>).map((a) => a.agentId ?? a.id);
    expect(held).toContain(agentPay);
    expect(held).toContain(agentVendor);
  });

  it("creating a rule over an already-held pair reports the violators in the creation response", async () => {
    const res = await createRule({
      name: "sod-pay-vs-vendor-second-look",
      reason: "same toxic pair, second rule — creation must surface existing exposure",
      a: selAgent(agentPay),
      b: selAgent(agentVendor),
    });
    expect(res.statusCode).toBe(201);
    const violators = res.json().currentViolators as Array<{ userId: string; holdsA: string; holdsB: string }>;
    expect(violators.map((v) => v.userId)).toContain(uCleanId);
    // delete it again (audited) — rule1 stays the one enforcing this pair
    const del = await app.inject({ method: "DELETE", headers: adminAuth, url: `/v1/sod/rules/${res.json().id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().removed).toBe(true);
  });
});

describe("override — through the one approvals queue, arm's-length only", () => {
  let overrideApprovalId: string;
  let overrideRequestId: string;

  it("escalation refusals: self-approver, clean mint, malformed payload, bootstrap", async () => {
    const selfApprover = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "connector",
        payload: { userId: uModeId, connectorId, mode: "readwrite" },
        approverUserId: adminId,
      },
    });
    expect(selfApprover.statusCode).toBe(422);
    expect(selfApprover.json().error).toBe("approver_is_requester");

    const clean = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "agent",
        payload: { userId: uModeId, agentId: agentFree },
        approverUserId: approverId,
      },
    });
    expect(clean.statusCode).toBe(422);
    expect(clean.json().error).toBe("no_sod_conflict");

    const malformed = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: { mintKind: "connector", payload: { userId: uModeId }, approverUserId: approverId },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().error).toBe("invalid_mint_payload");

    const boot = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "connector",
        payload: { userId: uModeId, connectorId, mode: "readwrite" },
        approverUserId: approverId,
      },
    });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("bootstrap_cannot_escalate");
  });

  it("a refused mint escalates: the conflict is server-derived and the queue row is labeled", async () => {
    const before = await auditCount("sod-override-requested");
    const res = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "connector",
        payload: { userId: uModeId, connectorId, mode: "readwrite" },
        approverUserId: approverId,
        justification: "quarter-end close needs one operator on both sides for a week",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().ruleId).toBe(rule2); // derived by re-check, not asserted by the client
    expect(res.json().status).toBe("pending");
    overrideApprovalId = res.json().approvalId;
    overrideRequestId = res.json().id;
    expect(await auditCount("sod-override-requested")).toBe(before + 1);

    // the approver's queue row says whose mint despite which rule
    const queue = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
    const row = (queue.json().approvals as Array<{ id: string; objectType: string; objectLabel: string | null }>).find(
      (a) => a.id === overrideApprovalId,
    );
    expect(row?.objectType).toBe("sod_override");
    expect(row?.objectLabel).toMatch(/^SoD override · .* · despite rule 'sod-connector-rw-vs-pay-tool'$/);
  });

  it("the requester cannot sign their own escalation — even with an admin-override reason", async () => {
    // adminAuth is an ADMIN and not the named approver: with a reason this
    // would be an accepted admin override on any other row. The bar is
    // keyed on the DECIDER, so it refuses by name.
    const res = await decide(adminAuth, overrideApprovalId, "approved", "quarter-end, signing it myself");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("cannot_approve_own_sod_override");
  });

  it("approving re-checks OTHER rules: a conflict that appeared after escalation refuses by name", async () => {
    // a new rule that ALSO refuses the stored mint (connector readwrite vs
    // the vendor tool, which uMode also holds)
    expect((await grantTool(uModeId, "sod_tool_vendor")).statusCode).toBe(201);
    const other = await createRule({
      name: "sod-connector-rw-vs-vendor-tool",
      reason: "second toxic pair over the same mint",
      a: selConnector("readwrite"),
      b: selTool("sod_tool_vendor"),
    });
    expect(other.statusCode).toBe(201);

    const res = await decide(approverAuth, overrideApprovalId, "approved");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("sod_conflict");
    expect(res.json().ruleName).toBe("sod-connector-rw-vs-vendor-tool");
    expect(res.json().detail).toMatch(/DIFFERENT rule/);

    // retire the second rule — the escalated override covers rule2 only
    const del = await app.inject({
      method: "DELETE",
      headers: adminAuth,
      url: `/v1/sod/rules/${other.json().id}`,
    });
    expect(del.statusCode).toBe(200);
  });

  it("an arm's-length approval mints the refused grant WITH the override recorded", async () => {
    const mintedBefore = await auditCount("sod-override-minted");
    const res = await decide(approverAuth, overrideApprovalId, "approved");
    expect(res.statusCode, res.body).toBe(200);

    // the grant EXISTS now — the very row the mint endpoint refused
    const [grant] = await db
      .select()
      .from(connectorGrants)
      .where(and(eq(connectorGrants.userId, uModeId), eq(connectorGrants.connectorId, connectorId)));
    expect(grant).toBeTruthy();
    expect(grant!.mode).toBe("readwrite");

    // the request records the mint; the audit detail records the override
    const [request] = await db
      .select()
      .from(sodOverrideRequests)
      .where(eq(sodOverrideRequests.id, overrideRequestId));
    expect(request!.status).toBe("approved");
    expect((request!.mintDetail as { table: string }).table).toBe("connector_grants");
    expect(await auditCount("sod-override-minted")).toBe(mintedBefore + 1);
    // Find THIS override's row by its own approval id. Taking the oldest
    // sod-override-minted row assumed nothing else had ever minted one — a
    // claim about every other test in a shared-database suite (M-008/M-020).
    const mintRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "sod-override-minted"))
      .orderBy(auditLog.at);
    const auditRow = mintRows.find(
      (r) =>
        (r.detail as { sodOverride?: { approvalId?: string } } | null)?.sodOverride?.approvalId ===
        overrideApprovalId,
    );
    expect(auditRow, "no sod-override-minted row names this approval").toBeTruthy();
    const detail = auditRow!.detail as { sodOverride?: { ruleId: string; approvalId: string } };
    expect(detail.sodOverride).toEqual({ ruleId: rule2, approvalId: overrideApprovalId });
  });

  it("a denied escalation mints NOTHING", async () => {
    // uPay's refused vendor mint from the direct-path suite, escalated
    const esc = await app.inject({
      method: "POST",
      headers: adminAuth,
      url: "/v1/sod/overrides",
      payload: {
        mintKind: "agent",
        payload: { userId: uPayId, agentId: agentVendor },
        approverUserId: approverId,
      },
    });
    expect(esc.statusCode).toBe(201);
    const rows = await agentGrantCount(uPayId);
    const deniedBefore = await auditCount("sod-override-denied");
    const res = await decide(approverAuth, esc.json().approvalId, "denied", "no business case");
    expect(res.statusCode).toBe(200);
    expect(await agentGrantCount(uPayId)).toBe(rows); // delta-0
    expect(await auditCount("sod-override-denied")).toBe(deniedBefore + 1);
    const list = await app.inject({ method: "GET", headers: adminAuth, url: "/v1/sod/overrides" });
    const mine = (list.json().overrides as Array<{ id: string; status: string; minted: unknown }>).find(
      (o) => o.id === esc.json().id,
    )!;
    expect(mine.status).toBe("denied");
    expect(mine.minted).toBeNull();
  });
});

describe("pillar-7 inheritance needs no separate SoD check", () => {
  it("a worker cannot reach the SoD-refused capability, because it inherits the initiating user's grants", async () => {
    // uPay was refused agentVendor at mint (and the escalation was denied).
    // Pillar 7's conformance suite (pillar7-inheritance.test.ts) pins that a
    // worker/lead agent inherits — and never exceeds — the INITIATING user's
    // entitlements at DISPATCH time. So the only way a worker could hold the
    // toxic pair is for the USER to hold it, and the mint gate made that
    // unreachable. Proof from the outside: a run naming the refused agent
    // for uPay is refused by the same entitlement wall — there is no
    // worker-side hole for SoD to plug.
    const created = await app.inject({
      method: "POST",
      headers: uPayAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "sod-p7-probe",
          escalationApproverUserId: approverP7Id,
          nodes: [
            {
              id: "n1",
              title: "task n1",
              ownerAgentId: agentVendor,
              mode: "execute",
              estimate: { in: 100, out: 100 },
            },
          ],
        },
      },
    });
    expect(created.statusCode).toBeGreaterThanOrEqual(400);
    expect(created.statusCode).toBeLessThan(500);
    // the granted side still works — the wall is the SoD-refused grant, not
    // the orchestration surface
    const ok = await app.inject({
      method: "POST",
      headers: uPayAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "sod-p7-control",
          escalationApproverUserId: approverP7Id,
          nodes: [
            {
              id: "n1",
              title: "task n1",
              ownerAgentId: agentPay,
              mode: "execute",
              estimate: { in: 100, out: 100 },
            },
          ],
        },
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});
