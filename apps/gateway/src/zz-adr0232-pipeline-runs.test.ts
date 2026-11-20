/**
 * ADR-0232 §2–§5, lane E49 slice 1 — the pipeline step catalogue and governed pipeline runs, on a real database
 * through the real app:
 *
 *  - the catalogue's available steps are exactly the workflow kernel's executable stage types, and no step that
 *    writes is ever retried automatically;
 *  - admin only: a member's session is refused on every pipeline route;
 *  - a run starts THROUGH the workflow engine: one workflow instance, the baseline version recorded, the plan's steps
 *    recorded with their catalogue class, an audit row, and a lifecycle view;
 *  - the run settles from its instance: an abort through the engine's own route cancels the run once (one audit row);
 *  - version binding: an unknown version is 404, a version that is not live is 409, a live definition that differs
 *    from its latest version is 409; a retired template is refused by the engine and recorded as a refused run;
 *    an intake template is refused; an idempotency key replays the same run;
 *  - the database holds the machine: an illegal status move, a delete of a run and any change to a step are refused.
 *
 * Fixtures are `pr-<run>`. No global setting is changed except the MFA relaxation, put back in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  pipelineRuns,
  pipelineRunSteps,
  runMigrations,
  sql,
  users,
  workflowInstances,
  workflowTemplates,
  workflowTemplateVersions,
  complianceProfiles,
  type Db,
} from "@regulait/db";
import { canonicalJson, PIPELINE_STEP_CATALOGUE, sha256Hex } from "@regulait/shared";
import { EXECUTABLE_STAGE_TYPES } from "@regulait/workflow-kernel";
import { buildApp } from "./app.js";
import { PIPELINE_RULE_IDS } from "./pipelines.js";
import { grantStepUpForTest, sessionRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `pr-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}`, "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberId: string;
let asAdmin: { headers: Record<string, string>; cookies: Record<string, string> };
let asMember: { headers: Record<string, string>; cookies: Record<string, string> };
const restores: Array<() => Promise<void>> = [];

const definition = (name: string) => ({
  workflow: name,
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "req", type: "artifact_generation", output: "requirements" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build", scope: "requirements" },
    { id: "checks", type: "automated_check", checks: ["unit", "lint"] },
  ],
});
const change = { description: "pipeline run", paths: ["src/a.ts"], changeType: `pr-${RUN}`, environment: "dev" };

async function newTemplate(name: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/workflows/templates", headers: AUTH, payload: { name, definition: definition(name) } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
const startRun = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/pipeline-runs", ...asAdmin, payload: { change, ...payload } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const a = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `pr-admin-${RUN}@example.com`, displayName: "pr admin" } });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const m = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `pr-member-${RUN}@example.com`, displayName: "pr member" } });
  memberId = m.json().id as string;
  asAdmin = sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: {} }));
  asMember = sessionRequest(await grantStepUpForTest(db, memberId, { kind: "settings_relax", facts: {} }));
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0232 the pipeline step catalogue", () => {
  it("offers exactly the executable stage types as available steps, and never auto-retries a write", async () => {
    const available = PIPELINE_STEP_CATALOGUE.filter((s) => s.availability === "available");
    expect(available.map((s) => s.stageType).sort()).toEqual([...EXECUTABLE_STAGE_TYPES].sort());
    expect(new Set(PIPELINE_STEP_CATALOGUE.map((s) => s.id)).size).toBe(PIPELINE_STEP_CATALOGUE.length);
    for (const s of PIPELINE_STEP_CATALOGUE) {
      if (s.writes) expect(s.autoRetry, s.id).toBe(false);
      expect(s.availability === "planned" ? s.plannedSlice !== null && s.stageType === null : s.plannedSlice === null, s.id).toBe(true);
    }
    const r = await app.inject({ method: "GET", url: "/v1/pipelines/catalogue", ...asAdmin });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().steps).toHaveLength(PIPELINE_STEP_CATALOGUE.length);
  });

  it("is admin only: a member's session is refused on every pipeline route", async () => {
    for (const [method, url] of [
      ["GET", "/v1/pipelines/catalogue"],
      ["GET", "/v1/pipeline-runs"],
      ["POST", "/v1/pipeline-runs"],
      ["GET", `/v1/pipeline-runs/${adminId}`],
    ] as const) {
      const r = await app.inject({ method, url, ...asMember, ...(method === "POST" ? { payload: {} } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("ADR-0232 governed pipeline runs", () => {
  let templateId: string;
  let runId: string;
  let instanceId: string;

  it("starts a run through the workflow engine and records its plan", async () => {
    templateId = await newTemplate(`pr-${RUN}-main`);
    const r = await startRun({ templateId, idempotencyKey: `k-${RUN}` });
    expect(r.statusCode, r.body).toBe(201);
    const run = r.json().run;
    runId = run.id;
    instanceId = run.workflowInstanceId;
    expect(run).toMatchObject({ status: "running", trigger: "manual", requestedBy: adminId, template: { id: templateId, version: 1 } });
    const [t] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    expect(run.template.contentHash).toBe(sha256Hex(canonicalJson(t!.definition)));
    expect(run.lifecycle).toMatchObject({ machine: "pipeline_run", state: "running", terminal: false });
    expect(run.lifecycle.transitions.filter((x: { allowed: boolean }) => x.allowed).map((x: { event: string }) => x.event).sort()).toEqual(["cancel", "fail", "succeed"]);

    // the engine created the instance, with the server-side change attributes
    const [inst] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    expect(inst!.templateIds).toEqual([templateId]);
    expect(inst!.initiatorUserId).toBe(adminId);
    expect(inst!.change).toMatchObject({ changeType: change.changeType, initiatorRoles: [], dataSensitivities: [] });
    // the baseline version was recorded under the lock
    expect(await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, templateId))).toHaveLength(1);

    const steps = await db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId, runId)).orderBy(pipelineRunSteps.ordinal);
    expect(steps.map((s) => [s.stageId, s.stepType, s.writes, s.autoRetry])).toEqual([
      ["intake", "trigger", false, true],
      ["plan", "planning", false, true],
      ["req", "artifact_generation", false, true],
      ["signoff", "human_approval", false, true],
      ["build", "automated_build", true, false],
      ["checks", "automated_check", false, true],
    ]);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "pipeline_run"), eq(auditLog.objectId, runId)));
    expect(audits.map((a) => a.ruleId)).toEqual([PIPELINE_RULE_IDS.started]);

    const d = await app.inject({ method: "GET", url: `/v1/pipeline-runs/${runId}`, ...asAdmin });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().steps).toHaveLength(6);
    // each step's status is the instance's own, read live; exactly one step is current
    expect(d.json().steps.every((s: { status: string | null }) => s.status !== null)).toBe(true);
    expect(d.json().steps.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
  });

  it("replays the same run for the same idempotency key", async () => {
    const r = await startRun({ templateId, idempotencyKey: `k-${RUN}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ replayed: true, run: { id: runId } });
    expect(await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId))).toHaveLength(1);
  });

  it("settles from its instance: an abort through the engine cancels the run, once", async () => {
    const ab = await app.inject({ method: "POST", url: `/v1/workflows/instances/${instanceId}/abort`, ...asAdmin, payload: {} });
    expect(ab.statusCode, ab.body).toBeLessThan(300);
    const g = await app.inject({ method: "GET", url: `/v1/pipeline-runs/${runId}`, ...asAdmin });
    expect(g.json().run).toMatchObject({ status: "cancelled", lifecycle: { terminal: true } });
    expect(g.json().run.finishedAt).not.toBeNull();
    const again = await app.inject({ method: "GET", url: `/v1/pipeline-runs?runStatus=cancelled`, ...asAdmin });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().items.map((x: { id: string }) => x.id)).toContain(runId);
    const finished = await db.select().from(auditLog).where(and(eq(auditLog.objectId, runId), eq(auditLog.ruleId, PIPELINE_RULE_IDS.finished)));
    expect(finished).toHaveLength(1);
  });

  it("runs only the live version", async () => {
    expect((await startRun({ templateId, version: 9 })).statusCode).toBe(404);
    // a recorded version the live definition no longer matches (a publish the live row has not caught up with)
    const other = await newTemplate(`pr-${RUN}-stale`);
    expect((await startRun({ templateId: other })).statusCode).toBe(201);
    await db.insert(workflowTemplateVersions).values({ templateId: other, version: 2, definition: { changed: true }, contentHash: sha256Hex(`pr-${RUN}`), origin: "builder" });
    const stale = await startRun({ templateId: other, version: 2 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("live_version_unrecorded");
  });

  it("records a run the engine refuses, and refuses an intake template outright", async () => {
    const retired = await newTemplate(`pr-${RUN}-retired`);
    await db.update(workflowTemplates).set({ retiredAt: sql`now()`, retiredReason: "test" }).where(eq(workflowTemplates.id, retired));
    const r = await startRun({ templateId: retired });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "template_retired", run: { status: "refused", refusalCode: "template_retired", workflowInstanceId: null } });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, r.json().run.id), eq(auditLog.ruleId, PIPELINE_RULE_IDS.refused)));
    expect(audit!.effect).toBe("deny");

    // written directly: creating an intake variant through the API needs a decision-regression preview (ADR-0182)
    const [intakeRow] = await db.insert(workflowTemplates).values({ name: `ai-use-case-intake/pr-${RUN}`, definition: definition(`pr-${RUN}-intake`) }).returning();
    const intake = intakeRow!.id;
    const i = await startRun({ templateId: intake });
    expect(i.statusCode, i.body).toBe(409);
    expect(i.json().error).toBe("intake_template_not_runnable");
  });

  it("derives the same server-side change and cascade as the workflow start route (one shared helper)", async () => {
    // a role the admin holds, and a classified project whose framework forces a second template in
    const role = await app.inject({ method: "POST", url: "/v1/roles", headers: AUTH, payload: { name: `pr-${RUN}-role` } });
    expect(role.statusCode, role.body).toBe(201);
    const assign = await app.inject({ method: "POST", url: `/v1/users/${adminId}/roles`, headers: AUTH, payload: { roleId: role.json().id } });
    expect(assign.statusCode, assign.body).toBeLessThan(300);
    const forced = await newTemplate(`pr-${RUN}-forced`);
    const tag = `pr-${RUN}-tag`;
    await db.insert(complianceProfiles).values({ tag, requiredTemplateIds: [forced] });
    const proj = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name: `pr-${RUN}-proj`, classifications: [tag] } });
    expect(proj.statusCode, proj.body).toBe(201);
    const projectId = proj.json().id as string;
    const tpl = await newTemplate(`pr-${RUN}-parity`);

    const viaPipeline = await startRun({ templateId: tpl, projectId });
    expect(viaPipeline.statusCode, viaPipeline.body).toBe(201);
    const viaWorkflow = await app.inject({ method: "POST", url: "/v1/workflows/instances", ...asAdmin, payload: { templateId: tpl, projectId, change } });
    expect(viaWorkflow.statusCode, viaWorkflow.body).toBe(201);

    const [a] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, viaPipeline.json().run.workflowInstanceId));
    const [b] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, viaWorkflow.json().id));
    expect(a!.templateIds).toEqual([tpl, forced]);
    expect(a!.templateIds).toEqual(b!.templateIds);
    expect(a!.change).toEqual(b!.change);
    expect(a!.change).toMatchObject({ initiatorRoles: [`pr-${RUN}-role`], dataSensitivities: [tag] });
    expect(canonicalJson(a!.definition)).toBe(canonicalJson(b!.definition));
  });

  it("holds the machine in the database: no illegal move, no delete, steps append-only", async () => {
    await expect(db.update(pipelineRuns).set({ status: "running" }).where(eq(pipelineRuns.id, runId))).rejects.toThrow();
    await expect(db.delete(pipelineRuns).where(eq(pipelineRuns.id, runId))).rejects.toThrow();
    await expect(db.update(pipelineRunSteps).set({ writes: false }).where(eq(pipelineRunSteps.runId, runId))).rejects.toThrow();
    await expect(db.delete(pipelineRunSteps).where(eq(pipelineRunSteps.runId, runId))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE pipeline_run_steps`)).rejects.toThrow();
  });
});
