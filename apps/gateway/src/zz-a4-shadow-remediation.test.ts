/**
 * ADR-0195 A4 — the shadow-AI remediation plan's body STARTS a workflow as it stands.
 *
 *  1. The plan's body, fed straight to `POST /v1/workflows/instances`, starts a workflow once an environment is
 *     stated (`?environment=`, validated against the environments an admin already uses). Without one, the body
 *     keeps the explicit `unstated` placeholder and the start route refuses it (fail closed, never a default).
 *  2. A strict default ships for the change type: the first start installs the template (plan-only, then a human
 *     sign-off) and its rule, audited once; the instance rests at the plan stage.
 *  3. A workflow started but never linked is reported back by the plan (the screen's retry survives a reload).
 *  4. A pseudonymised subject never reaches the body; repo evidence paths do.
 *  5. Relaxing is the audited template retirement, which also deletes the default's rule (so the admin's own
 *     assignment then decides alone), and a retired default is never re-installed.
 *  6. The default is never installed over an admin's rule for the change type, nor by a start that is refused.
 *  7. The default's sign-off is decided by an admin other than the initiator, never by the initiator.
 *  8. A workflow that ended denied, aborted or rolled back is never linked; a finding linked to one takes a new
 *     workflow through the audited replace, and a link to a live workflow is never replaced.
 *
 * Shares one DB with the other gateway suites; everything here is prefixed a4-, and the default template and rule
 * are removed in afterAll so the deployment ends as it started.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  inArray,
  runMigrations,
  shadowAiFindings,
  users,
  workflowAssignmentRules,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { changeDescriptorSchema, startInstanceSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import {
  SHADOW_AI_REMEDIATION_CHANGE_TYPE,
  SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED,
  SHADOW_AI_REMEDIATION_TEMPLATE_NAME,
} from "./shadow-ai-remediation.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "a4-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ENV = "a4-staging";
const PSEUDONYM = "psn:0123456789abcdef01234567";

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let restoreAdminKeyMfa: () => Promise<void> = async () => {};
let userAuth: { authorization: string };
let adminA: { auth: { authorization: string }; id: string };
let adminB: { auth: { authorization: string }; id: string };
let repoFindingId: string;
let deviceFindingId: string;
let otherTemplateId: string;
const adminTemplateIds: string[] = [];

const get = (url: string, headers = AUTH) => app.inject({ method: "GET", url, headers });
const post = (url: string, payload: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

async function makeUser(email: string, isAdmin = false) {
  const user = await post("/v1/users", { email, displayName: email.split("@")[0], ...(isAdmin ? { isAdmin } : {}) });
  expect(user.statusCode).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "test" });
  return { auth: { authorization: `Bearer ${key.json().token}` }, id: user.json().id as string };
}

/** an admin's own template assigned to the change type */
async function adminAssignment(name: string) {
  const tpl = await post("/v1/workflows/templates", { name, definition: { workflow: name, stages: [{ id: "intake", type: "trigger" }] } });
  expect(tpl.statusCode).toBe(201);
  adminTemplateIds.push(tpl.json().id);
  const rule = await post("/v1/workflows/assignment-rules", { templateId: tpl.json().id, changeType: SHADOW_AI_REMEDIATION_CHANGE_TYPE });
  expect(rule.statusCode).toBe(201);
  return { templateId: tpl.json().id as string, ruleId: rule.json().id as string };
}

async function removeDefault() {
  const rows = await db
    .select({ id: workflowTemplates.id })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
  if (rows.length > 0) {
    // the rule cascades with its template
    await db.delete(workflowTemplates).where(inArray(workflowTemplates.id, rows.map((r) => r.id)));
  }
}

const installAudits = () => db.select().from(auditLog).where(eq(auditLog.ruleId, SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  // ADR-0181 (FX2): an admin's API key answers to mfaRequired. This suite drives two admins through keys and is not
  // about MFA, so it relaxes the dial and hands the shared database back strict in afterAll (M-068)
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await removeDefault();
  await db.delete(auditLog).where(eq(auditLog.ruleId, SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED));
  userAuth = (await makeUser("a4-remediator@example.com")).auth;
  adminA = await makeUser("a4-admin-a@example.com", true);
  adminB = await makeUser("a4-admin-b@example.com", true);

  // an admin has given `a4-staging` a meaning: a rule for an unrelated change type names it
  const tpl = await post("/v1/workflows/templates", {
    name: "a4-unrelated",
    definition: { workflow: "a4-unrelated", stages: [{ id: "intake", type: "trigger" }] },
  });
  expect(tpl.statusCode).toBe(201);
  otherTemplateId = tpl.json().id;
  const rule = await post("/v1/workflows/assignment-rules", { templateId: otherTemplateId, changeType: "a4-unrelated", environment: ENV });
  expect(rule.statusCode).toBe(201);

  const now = new Date();
  const [repo] = await db
    .insert(shadowAiFindings)
    .values({
      subjectKind: "repo",
      subject: "a4-acme/billing",
      provider: "example-provider",
      signalSources: ["repo_scan"],
      signatureKinds: ["sdk_package"],
      firstSeenAt: now,
      lastSeenAt: now,
      observationCount: 1,
      severity: "high",
      confidence: "low",
      evidence: [
        { source: "repo_scan", matchedValue: "example-sdk", reason: "r", observedAt: now.toISOString(), location: { path: "src/llm.ts", line: 3 }, actor: PSEUDONYM },
        { source: "repo_scan", matchedValue: "example-sdk", reason: "r", observedAt: now.toISOString(), location: { path: "../escape.ts" } },
      ],
    })
    .returning({ id: shadowAiFindings.id });
  repoFindingId = repo!.id;
  const [device] = await db
    .insert(shadowAiFindings)
    .values({
      subjectKind: "device",
      subject: PSEUDONYM,
      provider: "example-provider",
      signalSources: ["endpoint_osquery"],
      signatureKinds: ["desktop_app"],
      firstSeenAt: now,
      lastSeenAt: now,
      observationCount: 1,
      severity: "medium",
      confidence: "low",
      evidence: [{ source: "endpoint_osquery", matchedValue: "app", reason: "r", observedAt: now.toISOString(), location: { path: "~/.config/app/config.json" }, actor: PSEUDONYM }],
    })
    .returning({ id: shadowAiFindings.id });
  deviceFindingId = device!.id;
});

afterAll(async () => {
  await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.id, [repoFindingId, deviceFindingId]));
  await removeDefault();
  await db.delete(workflowTemplates).where(inArray(workflowTemplates.id, [otherTemplateId, ...adminTemplateIds]));
  // the two admins this file made leave the shared deployment as non-admins (other suites count admins)
  await db.update(users).set({ isAdmin: false, disabledAt: new Date() }).where(inArray(users.id, [adminA.id, adminB.id]));
  await db.delete(auditLog).where(eq(auditLog.ruleId, SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED));
  await restoreGates();
  await restoreAdminKeyMfa();
  await app.close();
});

describe("ADR-0195 A4: the remediation plan body starts a workflow", () => {
  it("without a stated environment, the body is the explicit placeholder and the start route refuses it", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`);
    expect(plan.statusCode).toBe(200);
    const body = plan.json().workflowRequest.body;
    expect(startInstanceSchema.safeParse(body).success).toBe(true);
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
    expect(body.change.environment).toBe("unstated");
    expect(plan.json().workflowRequest.needsInput).toEqual(["change.environment"]);
    expect(plan.json().assignment.defaultTemplate).toEqual({ name: SHADOW_AI_REMEDIATION_TEMPLATE_NAME, state: "not_installed" });

    const start = await post("/v1/workflows/instances", body, userAuth);
    expect(start.statusCode).toBe(422);
    expect(start.json().error).toBe("environment_unstated");
    // a refused start installs nothing
    expect(await installAudits()).toHaveLength(0);
  });

  it("an environment no admin has used is refused, with the allowed list", async () => {
    for (const env of ["a4-nowhere", "unstated", "Not A Slug"]) {
      const res = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${encodeURIComponent(env)}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("environment_not_allowed");
      expect(res.json().allowed).toContain(ENV);
    }
  });

  it("the start route applies the same allow-list: a made-up or differently cased environment is refused", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    const body = plan.json().workflowRequest.body;
    for (const [environment, error] of [
      ["UNSTATED", "environment_unstated"],
      ["Unstated", "environment_unstated"],
      ["a4-made-up", "environment_not_allowed"],
      ["A4-STAGING", "environment_not_allowed"],
    ] as const) {
      const start = await post("/v1/workflows/instances", { ...body, change: { ...body.change, environment } }, userAuth);
      expect(start.statusCode).toBe(422);
      expect(start.json().error).toBe(error);
    }
    expect(await installAudits()).toHaveLength(0);
  });

  it("a start refused for its project installs nothing", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    const start = await post(
      "/v1/workflows/instances",
      { ...plan.json().workflowRequest.body, projectId: "00000000-0000-4000-8000-0000000000a4" },
      userAuth,
    );
    expect(start.statusCode).toBeGreaterThanOrEqual(400);
    expect(await installAudits()).toHaveLength(0);
    expect(await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME))).toHaveLength(0);
  });

  it("an admin's own rule for the change type decides alone: the default is not installed over it", async () => {
    const own = await adminAssignment("a4-admin-first");
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    const start = await post("/v1/workflows/instances", plan.json().workflowRequest.body, userAuth);
    expect(start.statusCode).toBe(201);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, start.json().id));
    expect(instance!.templateIds).toEqual([own.templateId]);
    expect(await installAudits()).toHaveLength(0);
    expect(await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME))).toHaveLength(0);
    // the admin withdraws it again, so the cases below see an unassigned change type
    await db.delete(workflowAssignmentRules).where(eq(workflowAssignmentRules.id, own.ruleId));
  });

  it("with a stated environment, the body starts the strict default workflow as it stands", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    expect(plan.statusCode).toBe(200);
    expect(plan.json().workflowRequest.needsInput).toEqual([]);
    const body = plan.json().workflowRequest.body;
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
    expect(body.change).toMatchObject({ environment: ENV, changeType: SHADOW_AI_REMEDIATION_CHANGE_TYPE, targetSystem: "a4-acme/billing" });
    // the repo and the repo-relative location from the evidence; never a path that climbs out, never a pseudonym
    expect(body.change.paths).toEqual(["a4-acme/billing", "src/llm.ts"]);
    expect(JSON.stringify(body)).not.toContain("psn:");
    expect(body.change.description).toContain(`shadow-AI finding ${repoFindingId}`);

    const start = await post("/v1/workflows/instances", body, userAuth);
    expect(start.statusCode).toBe(201);
    expect(start.json().status).toBe("blocked_on_plan");
    const [tpl] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
    expect(tpl).toBeDefined();
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, start.json().id));
    expect(instance!.templateIds).toEqual([tpl!.id]);
    const types = (tpl!.definition as { stages: Array<{ type: string }> }).stages.map((s) => s.type);
    expect(types).toEqual(["trigger", "planning", "artifact_generation", "human_approval"]);
    const rules = await db.select().from(workflowAssignmentRules).where(eq(workflowAssignmentRules.templateId, tpl!.id));
    expect(rules.map((r) => r.changeType)).toEqual([SHADOW_AI_REMEDIATION_CHANGE_TYPE]);
    expect(await installAudits()).toHaveLength(1);

    // a second start installs nothing more
    const again = await post("/v1/workflows/instances", body, adminA.auth);
    expect(again.statusCode).toBe(201);
    expect(await installAudits()).toHaveLength(1);

    // the plan reports the VIEWER's own started-but-unlinked workflow (the newest), never another user's, and stops
    // once it is linked
    const pending = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`, adminA.auth);
    expect(pending.json().assignment).toMatchObject({ ruleConfigured: true, defaultTemplate: { state: "active" } });
    expect(pending.json().pendingLink?.instanceId).toBe(again.json().id);
    const otherViewer = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`, adminB.auth);
    expect(otherViewer.json().pendingLink).toBeNull();
    const bootstrapViewer = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`);
    expect(bootstrapViewer.json().pendingLink).toBeNull();
    // the link is the initiator's own act: another admin, the bootstrap token, or the initiator naming someone
    // else's workflow is refused
    const link = (instanceId: string, headers = adminA.auth, findingId = repoFindingId) =>
      post(`/v1/shadow-ai/findings/${findingId}/remediate`, { instanceId }, headers);
    const byOther = await link(again.json().id, adminB.auth);
    expect(byOther.statusCode).toBe(403);
    expect(byOther.json().error).toBe("not_your_workflow");
    const byBootstrap = await link(again.json().id, AUTH);
    expect(byBootstrap.statusCode).toBe(403);
    const othersInstance = await link(start.json().id);
    expect(othersInstance.statusCode).toBe(403);
    // a workflow of another change type is refused, even one the caller started with this finding's reference
    const unrelated = await post(
      "/v1/workflows/instances",
      { ...body, change: { ...body.change, changeType: "a4-unrelated" } },
      adminA.auth,
    );
    expect(unrelated.statusCode).toBe(201);
    const wrongType = await link(unrelated.json().id);
    expect(wrongType.statusCode).toBe(422);
    expect(wrongType.json().error).toBe("workflow_not_linkable");
    // the caller's own remediation workflow for THIS finding is not linkable to another finding
    const wrongFinding = await link(again.json().id, adminA.auth, deviceFindingId);
    expect(wrongFinding.statusCode).toBe(422);
    const linked = await link(again.json().id);
    expect(linked.statusCode).toBe(200);
    // a link is set once: a second link, even of the caller's own other workflow, never re-points it
    const relink = await link(again.json().id);
    expect(relink.statusCode).toBe(409);
    expect(relink.json().error).toBe("already_linked");
    const [stillLinked] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.id, repoFindingId));
    expect(stillLinked!.remediationInstanceId).toBe(again.json().id);
    const after = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`, adminA.auth);
    expect(after.json().pendingLink).toBeNull();
  });

  it("a pseudonymised subject never reaches the body", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan?environment=${ENV}`);
    expect(plan.statusCode).toBe(200);
    const body = plan.json().workflowRequest.body;
    expect(changeDescriptorSchema.strict().safeParse(body.change).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("psn:");
    expect(body.change.paths).toEqual([]);
    expect(body.change).not.toHaveProperty("targetSystem");
    expect(body.change.description).toContain("a device (pseudonymised)");
    const start = await post("/v1/workflows/instances", body, userAuth);
    expect(start.statusCode).toBe(201);
  });

  it("an aborted workflow is never offered as the one to link", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan?environment=${ENV}`, adminA.auth);
    const start = await post("/v1/workflows/instances", plan.json().workflowRequest.body, adminA.auth);
    expect(start.statusCode).toBe(201);
    const before = await get(`/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan`, adminA.auth);
    expect(before.json().pendingLink?.instanceId).toBe(start.json().id);
    const aborted = await post(`/v1/workflows/instances/${start.json().id}/abort`, {}, adminA.auth);
    expect(aborted.json().status).toBe("aborted");
    const after = await get(`/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan`, adminA.auth);
    expect(after.json().pendingLink).toBeNull();
    // and the server refuses to link it, not only the screen
    const linked = await post(`/v1/shadow-ai/findings/${deviceFindingId}/remediate`, { instanceId: start.json().id }, adminA.auth);
    expect(linked.statusCode).toBe(422);
    expect(linked.json()).toMatchObject({ error: "workflow_not_linkable", detail: "the workflow is aborted" });
  });

  it("a denied plan is never linkable, and a finding whose linked workflow ended unsuccessfully takes a new one, audited", async () => {
    const planUrl = `/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan`;
    const link = (instanceId: string) => post(`/v1/shadow-ai/findings/${deviceFindingId}/remediate`, { instanceId }, adminA.auth);
    const startOne = async () => {
      const plan = await get(`${planUrl}?environment=${ENV}`, adminA.auth);
      const start = await post("/v1/workflows/instances", plan.json().workflowRequest.body, adminA.auth);
      expect(start.statusCode).toBe(201);
      return start.json().id as string;
    };
    // walk to the sign-off, where admin B (the second approver) denies the plan
    const deny = async (instanceId: string) => {
      await post(`/v1/workflows/instances/${instanceId}/advance`, { stageId: "plan" }, adminA.auth);
      const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, { stageId: "remediation_plan", content: "# a4 plan" }, adminA.auth);
      expect(art.json().status).toBe("blocked_on_approval");
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending"), eq(approvals.approverUserId, adminB.id)));
      const denied = await post(`/v1/approvals/${row!.id}/decide`, { decision: "denied", reason: "a4: plan rejected" }, adminB.auth);
      expect(denied.statusCode).toBe(200);
      const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
      expect(instance!.status).toBe("denied");
    };

    // denied before the link landed: no longer pending, and the server refuses to link it
    const rejected = await startOne();
    expect((await get(planUrl, adminA.auth)).json().pendingLink?.instanceId).toBe(rejected);
    await deny(rejected);
    expect((await get(planUrl, adminA.auth)).json().pendingLink).toBeNull();
    const refused = await link(rejected);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "workflow_not_linkable", detail: "the workflow is denied" });

    // linked while live, then denied: the link no longer stands, and a new workflow replaces it
    const first = await startOne();
    expect((await link(first)).statusCode).toBe(200);
    const live = await get(planUrl, adminA.auth);
    expect(live.json().currentLink).toMatchObject({ instanceId: first, replaceable: false });
    // a live link is never replaced
    const early = await startOne();
    const tooEarly = await link(early);
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error).toBe("already_linked");
    expect((await post(`/v1/workflows/instances/${early}/abort`, {}, adminA.auth)).json().status).toBe("aborted");
    await deny(first);
    const dead = await get(planUrl, adminA.auth);
    expect(dead.json().currentLink).toEqual({ instanceId: first, status: "denied", replaceable: true });
    expect(dead.json().pendingLink).toBeNull();
    // a dead workflow never comes back as the replacement
    expect((await link(rejected)).statusCode).toBe(422);
    const second = await startOne();
    expect((await get(planUrl, adminA.auth)).json().pendingLink?.instanceId).toBe(second);
    // only the initiator replaces, as for any link
    expect((await post(`/v1/shadow-ai/findings/${deviceFindingId}/remediate`, { instanceId: second }, adminB.auth)).statusCode).toBe(403);
    const replaced = await link(second);
    expect(replaced.statusCode).toBe(200);
    const [row] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.id, deviceFindingId));
    expect(row!.remediationInstanceId).toBe(second);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, deviceFindingId), eq(auditLog.ruleId, "shadow-ai-finding-remediation-linked")));
    const audit = audits.find((a) => (a.detail as { instanceId?: string } | null)?.instanceId === second);
    expect(audit?.detail).toMatchObject({ instanceId: second, replacedInstanceId: first, replacedInstanceStatus: "denied" });
    // the first link carries no replace
    const firstAudit = audits.find((a) => (a.detail as { instanceId?: string } | null)?.instanceId === first);
    expect(firstAudit?.detail).not.toHaveProperty("replacedInstanceId");
    // and the new link stands again
    const again = await get(planUrl, adminA.auth);
    expect(again.json().currentLink).toMatchObject({ instanceId: second, replaceable: false });
    expect((await link(rejected)).statusCode).toBe(409);
  });

  it("the sign-off goes to admins other than the initiator, and the initiator can never decide it", async () => {
    const plan = await get(`/v1/shadow-ai/findings/${deviceFindingId}/remediation-plan?environment=${ENV}`, adminA.auth);
    const start = await post("/v1/workflows/instances", plan.json().workflowRequest.body, adminA.auth);
    expect(start.statusCode).toBe(201);
    const instanceId = start.json().id as string;
    const left = await post(`/v1/workflows/instances/${instanceId}/advance`, { stageId: "plan" }, adminA.auth);
    expect(left.json().status).toBe("blocked_on_artifact");
    const art = await post(`/v1/workflows/instances/${instanceId}/artifacts`, { stageId: "remediation_plan", content: "# a4 plan" }, adminA.auth);
    expect(art.json().status).toBe("blocked_on_approval");

    const rows = await db.select().from(approvals).where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending")));
    const approverIds = rows.map((r) => r.approverUserId);
    expect(approverIds).toContain(adminB.id);
    expect(approverIds).not.toContain(adminA.id);
    const rowB = rows.find((r) => r.approverUserId === adminB.id)!;

    // the initiator is an admin, but no route lets them decide their own remediation's sign-off
    const self = await post(`/v1/approvals/${rowB.id}/decide`, { decision: "approved", reason: "a4: override attempt" }, adminA.auth);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("initiator_cannot_sign_off");

    const other = await post(`/v1/approvals/${rowB.id}/decide`, { decision: "approved" }, adminB.auth);
    expect(other.statusCode).toBe(200);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(instance!.status).not.toBe("blocked_on_approval");
  });

  it("relaxing is the audited retirement: it deletes the default's rule, and the admin's own template then decides alone", async () => {
    const [tpl] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
    const [defaultRule] = await db.select().from(workflowAssignmentRules).where(eq(workflowAssignmentRules.templateId, tpl!.id));
    expect(defaultRule).toBeDefined();
    const retired = await post(`/v1/workflows/templates/${tpl!.id}/retire`, { reason: "a4: our own remediation workflow replaces it" });
    expect(retired.statusCode).toBe(200);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, tpl!.id), eq(auditLog.ruleId, "workflow-template-retired")));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ ruleId: defaultRule!.id, ruleIds: [defaultRule!.id] });
    expect(await db.select().from(workflowAssignmentRules).where(eq(workflowAssignmentRules.templateId, tpl!.id))).toHaveLength(0);

    // nothing is assigned now: the plan says so, and a start is refused rather than re-installing the default
    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    expect(plan.json().assignment).toMatchObject({ ruleConfigured: false, defaultTemplate: { state: "retired" } });
    const body = plan.json().workflowRequest.body;
    const refused = await post("/v1/workflows/instances", body, userAuth);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("no_workflow_matches_change");
    const rows = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retiredAt).not.toBeNull();
    expect(await installAudits()).toHaveLength(1);

    // the admin assigns their own: the plan counts it, and a start runs it alone
    const own = await adminAssignment("a4-admin-after-retire");
    const replan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    expect(replan.json().assignment.ruleConfigured).toBe(true);
    const start = await post("/v1/workflows/instances", body, userAuth);
    expect(start.statusCode).toBe(201);
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, start.json().id));
    expect(instance!.templateIds).toEqual([own.templateId]);
  });
});
