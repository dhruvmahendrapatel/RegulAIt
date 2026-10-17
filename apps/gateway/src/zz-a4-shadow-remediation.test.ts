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
 *  5. Relaxing is the audited template retirement, and a retired default is never re-installed.
 *
 * Shares one DB with the other gateway suites; everything here is prefixed a4-, and the default template and rule
 * are removed in afterAll so the deployment ends as it started.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  inArray,
  runMigrations,
  shadowAiFindings,
  workflowAssignmentRules,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { changeDescriptorSchema, startInstanceSchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
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
let userAuth: { authorization: string };
let repoFindingId: string;
let deviceFindingId: string;
let otherTemplateId: string;

const get = (url: string, headers = AUTH) => app.inject({ method: "GET", url, headers });
const post = (url: string, payload: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

async function makeUser(email: string) {
  const user = await post("/v1/users", { email, displayName: email.split("@")[0] });
  expect(user.statusCode).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "test" });
  return { authorization: `Bearer ${key.json().token}` };
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
  await removeDefault();
  await db.delete(auditLog).where(eq(auditLog.ruleId, SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED));
  userAuth = await makeUser("a4-remediator@example.com");

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
  await db.delete(workflowTemplates).where(eq(workflowTemplates.id, otherTemplateId));
  await db.delete(auditLog).where(eq(auditLog.ruleId, SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED));
  await restoreGates();
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
    const again = await post("/v1/workflows/instances", body, userAuth);
    expect(again.statusCode).toBe(201);
    expect(await installAudits()).toHaveLength(1);

    // the plan now reports a started-but-unlinked workflow (the newest), and stops once it is linked
    const pending = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`);
    expect(pending.json().assignment).toMatchObject({ ruleConfigured: true, defaultTemplate: { state: "active" } });
    expect(pending.json().pendingLink?.instanceId).toBe(again.json().id);
    const linked = await post(`/v1/shadow-ai/findings/${repoFindingId}/remediate`, { instanceId: again.json().id });
    expect(linked.statusCode).toBe(200);
    const after = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan`);
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

  it("relaxing is the audited retirement, and a retired default is never re-installed", async () => {
    const [tpl] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
    const retired = await post(`/v1/workflows/templates/${tpl!.id}/retire`, { reason: "a4: our own remediation workflow replaces it" });
    expect(retired.statusCode).toBe(200);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, tpl!.id), eq(auditLog.ruleId, "workflow-template-retired")));
    expect(audits).toHaveLength(1);

    const plan = await get(`/v1/shadow-ai/findings/${repoFindingId}/remediation-plan?environment=${ENV}`);
    expect(plan.json().assignment.defaultTemplate.state).toBe("retired");
    const start = await post("/v1/workflows/instances", plan.json().workflowRequest.body, userAuth);
    // the rule still names the retired default: the start refuses rather than silently re-installing it
    expect(start.statusCode).toBe(422);
    expect(start.json().error).toBe("template_retired");
    const rows = await db.select().from(workflowTemplates).where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retiredAt).not.toBeNull();
    expect(await installAudits()).toHaveLength(1);
  });
});
