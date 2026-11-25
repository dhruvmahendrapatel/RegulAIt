import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  workflowInstanceTemplateVersions,
  workflowTemplateCanaries,
  workflowTemplates,
  workflowTemplateVersions,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS, canonicalJson, sha256Hex } from "@regulait/shared";
import { buildApp } from "./app.js";
import { PUBLISH_STEP_UP_OP } from "./workflow-builder.js";
import { CANARY_ROLLBACK_STEP_UP_OP, TEMPLATE_VERSION_RULE_IDS } from "./workflow-template-versions.js";
import { WORKFLOW_MIGRATION_RULE_IDS } from "./workflow-migrations.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * ADR-0340 slice 3, rebuilt on ADR-0341's `workflow_template_versions` (the one version store): every new instance is
 * pinned to the version that served it; a builder publish with `canaryPercent` serves a share of NEW instances the new
 * version until it is promoted or rolled back, and no other publish lands meanwhile; a running instance moves to
 * another version only through a governed migration another admin approves. Fixtures are `tv-<run>`; global state
 * (step-up posture, MFA relaxation) is put back in afterAll (M-068).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `tv-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}`, "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
type U = { id: string; auth: Record<string, string> };
let pia: U;
let adminA: U;
let adminB: U;
const restores: Array<() => Promise<void>> = [];

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const put = (url: string, payload: unknown) => app.inject({ method: "PUT", url, headers: AUTH, payload: payload as object });
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });
const hashOf = (v: unknown) => sha256Hex(canonicalJson(v));

async function makeUser(name: string, isAdmin = false): Promise<U> {
  const user = await post("/v1/users", { email: `tv-${name}-${RUN}@example.com`, displayName: name, ...(isAdmin ? { isAdmin: true } : {}) });
  expect(user.statusCode, user.body).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "tv" });
  expect(key.statusCode, key.body).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}`, "x-regulait-csrf": "1" } };
}
async function newTemplate(name: string, definition: object): Promise<string> {
  const tpl = await post("/v1/workflows/templates", { name, definition });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const id = tpl.json().id as string;
  const rule = await post("/v1/workflows/assignment-rules", { templateId: id, changeType: name });
  expect(rule.statusCode, rule.body).toBe(201);
  return id;
}
async function start(changeType: string) {
  const res = await post(
    "/v1/workflows/instances",
    { change: { description: `tv ${changeType}`, paths: ["src/x.ts"], changeType, environment: `tv-env-${RUN}` } },
    pia.auth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function view(id: string) {
  const res = await get(`/v1/workflows/instances/${id}`, pia.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().instance;
}
async function pins(instanceId: string) {
  return db
    .select({ pin: workflowInstanceTemplateVersions, version: workflowTemplateVersions.version })
    .from(workflowInstanceTemplateVersions)
    .innerJoin(workflowTemplateVersions, eq(workflowTemplateVersions.id, workflowInstanceTemplateVersions.templateVersionId))
    .where(eq(workflowInstanceTemplateVersions.instanceId, instanceId))
    .orderBy(workflowInstanceTemplateVersions.at);
}
async function versionsOf(templateId: string) {
  return db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.templateId, templateId)).orderBy(workflowTemplateVersions.version);
}

// --- the builder-valid template the canary runs on (ADR-0341's standard shape)
type Stage = { id: string; type: string } & Record<string, unknown>;
const builderDef = (extra: Stage[] = []): { workflow: string; stages: Stage[] } => ({
  workflow: `tv-${RUN}`,
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "req", type: "artifact_generation", output: "requirements" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build", scope: "requirements" },
    { id: "checks", type: "automated_check", checks: ["unit", "lint"] },
    ...extra,
  ],
});

/** open a draft of `templateId`, save `definition` and publish it (optionally as a canary) with the bound step-up */
async function publish(templateId: string, definition: object, canaryPercent?: number) {
  const opened = await post(`/v1/workflows/builder/templates/${templateId}/draft`, {});
  expect(opened.statusCode, opened.body).toBe(201);
  const saved = await put(`/v1/workflows/builder/templates/${templateId}/draft`, { revision: opened.json().draft.revision, definition });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().validation.valid, saved.body).toBe(true);
  const latest = (await versionsOf(templateId)).at(-1)!;
  const facts = {
    op: PUBLISH_STEP_UP_OP,
    templateId,
    fromVersion: latest.version,
    contentHash: hashOf(definition),
    ...(canaryPercent !== undefined ? { canaryPercent } : {}),
  };
  const grant = await grantStepUpForTest(db, adminA.id, { kind: "settings_relax", facts });
  return app.inject({
    method: "POST",
    url: `/v1/workflows/builder/templates/${templateId}/publish`,
    ...stepUpRequest(grant),
    payload: { revision: saved.json().draft.revision, ...(canaryPercent !== undefined ? { canaryPercent } : {}) },
  });
}

// --- the template the migration runs on: a gate the instance rests at, so what is ahead of it can change
const gate = () => ({ id: "gate", type: "human_approval", approvers: [adminA.id] });
const m1Stages = () => [{ id: "intake", type: "trigger" }, gate(), { id: "build", type: "automated_build" }];
const m2Stages = () => [{ id: "intake", type: "trigger" }, gate(), { id: "scan", type: "automated_check" }, { id: "build", type: "automated_build" }];
const m3Stages = () => [{ id: "intake", type: "trigger" }, { id: "build", type: "automated_build" }];

/** a version written as a publish would write it (the migration routes read versions, whoever wrote them) */
async function addVersion(templateId: string, stages: object[]) {
  const latest = (await versionsOf(templateId)).at(-1)!;
  const definition = { workflow: `tvm-${RUN}`, stages };
  const [v] = await db
    .insert(workflowTemplateVersions)
    .values({ templateId, version: latest.version + 1, definition, contentHash: hashOf(definition), origin: "builder", publishedBy: adminA.id })
    .returning();
  return v!;
}

let canaryTpl: string;
let migrationTpl: string;
const canaryName = () => `tv-canary-${RUN}`;
const migrationName = () => `tv-migrate-${RUN}`;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  pia = await makeUser("pia");
  adminA = await makeUser("admin-a", true);
  adminB = await makeUser("admin-b", true);
  canaryTpl = await newTemplate(canaryName(), builderDef());
  migrationTpl = await newTemplate(migrationName(), { workflow: `tvm-${RUN}`, stages: m1Stages() });
}, 120_000);

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0340 slice 3: pinning, canary and governed migration on workflow_template_versions", () => {
  it("pins a new instance to the version holding the live definition, recording it once when the template has none", async () => {
    expect(await versionsOf(canaryTpl)).toHaveLength(0);
    const first = await start(canaryName());
    const second = await start(canaryName());
    const versions = await versionsOf(canaryTpl);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, origin: "baseline", contentHash: hashOf(builderDef()) });
    for (const id of [first, second]) {
      expect((await pins(id)).map((p) => ({ ...p.pin, version: p.version }))).toEqual([
        expect.objectContaining({ templateVersionId: versions[0]!.id, version: 1, canary: false, via: "start" }),
      ]);
    }
    const baseline = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, canaryTpl), eq(auditLog.ruleId, TEMPLATE_VERSION_RULE_IDS.baselineAtStart)));
    expect(baseline).toHaveLength(1);
  });

  it("a canary publish serves a share of NEW instances, sticky per instance, pinned and audited; no other publish lands meanwhile", async () => {
    const v2 = builderDef([{ id: "e2e", type: "automated_check", checks: ["e2e"] }]);
    // the step-up is bound to the share: a proof for a plain publish does not open a canary
    const opened = await post(`/v1/workflows/builder/templates/${canaryTpl}/draft`, {});
    const saved = await put(`/v1/workflows/builder/templates/${canaryTpl}/draft`, { revision: opened.json().draft.revision, definition: v2 });
    const plain = await grantStepUpForTest(db, adminA.id, { kind: "settings_relax", facts: { op: PUBLISH_STEP_UP_OP, templateId: canaryTpl, fromVersion: 1, contentHash: hashOf(v2) } });
    const refused = await app.inject({
      method: "POST",
      url: `/v1/workflows/builder/templates/${canaryTpl}/publish`,
      ...stepUpRequest(plain),
      payload: { revision: saved.json().draft.revision, canaryPercent: 50 },
    });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    await app.inject({ method: "DELETE", url: `/v1/workflows/builder/templates/${canaryTpl}/draft`, headers: AUTH });

    const published = await publish(canaryTpl, v2, 50);
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json()).toMatchObject({ version: { version: 2 }, canary: { percent: 50, stableVersion: 1 } });

    // a second publish is refused while the canary is open
    const again = await publish(canaryTpl, builderDef([{ id: "e2e2", type: "automated_check", checks: ["e2e"] }]));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error).toBe("canary_open");
    await app.inject({ method: "DELETE", url: `/v1/workflows/builder/templates/${canaryTpl}/draft`, headers: AUTH });

    const served: boolean[] = [];
    for (let i = 0; i < 16; i++) {
      const id = await start(canaryName());
      const [p] = await pins(id);
      const inst = await view(id);
      const hasE2e = (inst.definition.stages as Array<{ id: string }>).some((s) => s.id === "e2e");
      expect(hasE2e).toBe(p!.pin.canary);
      expect(p!.version).toBe(p!.pin.canary ? 2 : 1);
      const audited = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, TEMPLATE_VERSION_RULE_IDS.canarySelected)));
      expect(audited.length).toBe(p!.pin.canary ? 1 : 0);
      served.push(p!.pin.canary);
    }
    // 16 instance ids over a 50% bucket: both sides are served (fnv1a buckets are effectively uniform)
    expect(served.some(Boolean)).toBe(true);
    expect(served.some((x) => !x)).toBe(true);
    const view1 = await get(`/v1/workflows/builder/templates/${canaryTpl}/canary`);
    expect(view1.statusCode, view1.body).toBe(200);
    expect(view1.json().canary).toMatchObject({ status: "open", percent: 50, canaryVersion: 2, stableVersion: 1 });
    expect(view1.json().canary.served.canary + view1.json().canary.served.stable).toBe(16);
    // a non-admin cannot see or end it
    expect((await get(`/v1/workflows/builder/templates/${canaryTpl}/canary`, pia.auth)).statusCode).toBe(403);
    expect((await post(`/v1/workflows/builder/templates/${canaryTpl}/canary/end`, { outcome: "promote", reason: "looks good to me" }, pia.auth)).statusCode).toBe(403);
  });

  it("a rollback is a publish: it must accept what it weakens and carry the settings_relax step-up bound to it", async () => {
    const url = `/v1/workflows/builder/templates/${canaryTpl}/canary/end`;
    const reason = "the e2e stage is flaky on this runner";
    // rolling back removes the canary's e2e stage: that weakens the live template, so it must be accepted
    const unaccepted = await post(url, { outcome: "rollback", reason });
    expect(unaccepted.statusCode, unaccepted.body).toBe(409);
    expect(unaccepted.json().error).toBe("relaxation_not_accepted");
    expect(unaccepted.json().relaxations.length).toBeGreaterThan(0);
    // a proof for a publish of the same bytes does not roll a canary back
    const [open] = await db.select().from(workflowTemplateCanaries).where(and(eq(workflowTemplateCanaries.templateId, canaryTpl), eq(workflowTemplateCanaries.status, "open")));
    const wrong = await grantStepUpForTest(db, adminA.id, {
      kind: "settings_relax",
      facts: { op: PUBLISH_STEP_UP_OP, templateId: canaryTpl, fromVersion: 2, contentHash: hashOf(builderDef()) },
    });
    // accepted, but from a session with no step-up: refused, and nothing is written
    const noProof = await app.inject({ method: "POST", url, ...sessionRequest(wrong), payload: { outcome: "rollback", reason, acceptRelaxations: true } });
    expect([401, 403, 422], noProof.body).toContain(noProof.statusCode);
    const misbound = await app.inject({ method: "POST", url, ...stepUpRequest(wrong), payload: { outcome: "rollback", reason, acceptRelaxations: true } });
    expect([403, 422], misbound.body).toContain(misbound.statusCode);
    expect((await versionsOf(canaryTpl)).at(-1)!.version).toBe(2);
    expect(open).toMatchObject({ status: "open" });
    const [still] = await db.select().from(workflowTemplateCanaries).where(eq(workflowTemplateCanaries.id, open!.id));
    expect(still!.status).toBe("open");
    // the bound proof rolls it back, and the audit row records the accepted relaxations and the step-up
    const grant = await grantStepUpForTest(db, adminA.id, {
      kind: "settings_relax",
      facts: { op: CANARY_ROLLBACK_STEP_UP_OP, templateId: canaryTpl, canaryId: open!.id, fromVersion: 2, contentHash: hashOf(builderDef()) },
    });
    const ended = await app.inject({ method: "POST", url, ...stepUpRequest(grant), payload: { outcome: "rollback", reason, acceptRelaxations: true } });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json()).toMatchObject({ outcome: "rollback", version: 3 });
    const [rolled] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, canaryTpl), eq(auditLog.ruleId, TEMPLATE_VERSION_RULE_IDS.canaryRolledBack)));
    expect(rolled!.detail).toMatchObject({ stepUpKind: "settings_relax", relaxationReason: reason, relaxations: unaccepted.json().relaxations });
    expect((rolled!.detail as { stepUp: string }).stepUp).toBeTruthy();
  });

  it("the rollback published the stable definition again as the next version; every new instance gets it", async () => {
    expect((await post(`/v1/workflows/builder/templates/${canaryTpl}/canary/end`, { outcome: "rollback", reason: "short" })).statusCode).toBe(400);
    const v3 = (await versionsOf(canaryTpl)).at(-1)!;
    expect(v3).toMatchObject({ version: 3, origin: "canary_rollback", contentHash: hashOf(builderDef()) });
    const [tpl] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, canaryTpl));
    expect(hashOf(tpl!.definition)).toBe(hashOf(builderDef()));
    const [c] = await db.select().from(workflowTemplateCanaries).where(eq(workflowTemplateCanaries.templateId, canaryTpl)).orderBy(desc(workflowTemplateCanaries.startedAt));
    expect(c).toMatchObject({ status: "rolled_back", endReason: "the e2e stage is flaky on this runner" });
    // ended once
    expect((await post(`/v1/workflows/builder/templates/${canaryTpl}/canary/end`, { outcome: "promote", reason: "changed my mind now" })).statusCode).toBe(409);
    for (let i = 0; i < 4; i++) {
      const [p] = await pins(await start(canaryName()));
      expect(p).toMatchObject({ version: 3, pin: expect.objectContaining({ canary: false }) });
    }
  });

  it("a promoted canary serves every new instance", async () => {
    const v4 = builderDef([{ id: "sast", type: "automated_check", checks: ["sast"] }]);
    const published = await publish(canaryTpl, v4, 10);
    expect(published.statusCode, published.body).toBe(201);
    const ended = await post(`/v1/workflows/builder/templates/${canaryTpl}/canary/end`, { outcome: "promote", reason: "the new check is quiet and fast" });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await versionsOf(canaryTpl)).at(-1)!.version).toBe(4);
    for (let i = 0; i < 4; i++) {
      const [p] = await pins(await start(canaryName()));
      expect(p).toMatchObject({ version: 4, pin: expect.objectContaining({ canary: false }) });
    }
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.objectId, canaryTpl), eq(auditLog.ruleId, TEMPLATE_VERSION_RULE_IDS.canaryPromoted)));
    expect(audited).toHaveLength(1);
  });

  it("a running instance migrates to a new version only through another admin's approval, then runs on it", async () => {
    const id = await start(migrationName());
    expect((await view(id)).status).toBe("blocked_on_approval");
    const v2 = await addVersion(migrationTpl, m2Stages());
    const dry = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id }, adminA.auth);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, ok: true, added: ["scan"], targetVersion: v2.version });
    expect(dry.json().diff.length).toBeGreaterThan(0);
    // a version of another template is refused
    const foreign = (await versionsOf(canaryTpl)).at(-1)!;
    const wrong = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: foreign.id }, adminA.auth);
    expect(wrong.json()).toMatchObject({ ok: false, refusals: [expect.objectContaining({ code: "not_this_template" })] });
    // a non-admin cannot reach the route
    expect((await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id }, pia.auth)).statusCode).toBe(403);
    // a request needs a reason, and files approvals for the OTHER admins only
    expect((await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false }, adminA.auth)).statusCode).toBe(400);
    const filed = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false, reason: "add the scan stage" }, adminA.auth);
    expect(filed.statusCode, filed.body).toBe(202);
    const rows = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.objectType, "workflow_migration")));
    expect(rows.map((r) => r.approverUserId)).not.toContain(adminA.id);
    expect(rows.map((r) => r.approverUserId)).toContain(adminB.id);
    const twice = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false, reason: "add the scan again" }, adminA.auth);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("migration_pending");
    const mine = rows.find((r) => r.approverUserId === adminB.id)!;
    // the requester cannot decide it, even with the admin override the decide path allows admins
    const own = await post(`/v1/approvals/${mine.id}/decide`, { decision: "approved", reason: "override" }, adminA.auth);
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_workflow_migration");
    expect((await view(id)).definition.stages).toHaveLength(3);
    const decided = await post(`/v1/approvals/${mine.id}/decide`, { decision: "approved" }, adminB.auth);
    expect(decided.statusCode, decided.body).toBe(200);
    const inst = await view(id);
    expect(inst.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate", "scan", "build"]);
    expect(inst.status).toBe("blocked_on_approval");
    const p = await pins(id);
    expect(p.at(-1)).toMatchObject({ version: v2.version, pin: expect.objectContaining({ via: "migration", templateVersionId: v2.id }) });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, WORKFLOW_MIGRATION_RULE_IDS.applied)));
    expect(audit!.detail).toMatchObject({ targetVersion: v2.version, added: ["scan"], toDefinitionSha256: v2.contentHash });
    // the migrated instance runs on: the gate now leads to the new stage
    const [g] = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.stageId, "gate"), eq(approvals.status, "pending")));
    expect((await post(`/v1/approvals/${g!.id}/decide`, { decision: "approved" }, adminA.auth)).statusCode).toBe(200);
    expect((await view(id)).state.currentStageIndex).toBe(2);
    const listed = await get(`/v1/workflows/instances/${id}/migrations`, adminA.auth);
    expect(listed.json().migrations[0]).toMatchObject({ status: "applied", decidedByUserId: adminB.id, targetVersion: v2.version });
  });

  it("refuses a migration that rewrites the past, and records stale when the instance moved past the change", async () => {
    const id = await start(migrationName());
    const all = await versionsOf(migrationTpl);
    const v2 = all.find((v) => canonicalJson((v.definition as { stages: unknown }).stages) === canonicalJson(m2Stages()))!;
    const v3 = await addVersion(migrationTpl, m3Stages());
    // the new instance started on the live definition (m1), recorded as a version of its own
    expect((await pins(id))[0]!.pin.templateVersionId).not.toBe(v2.id);
    const refused = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v3.id, dryRun: false, reason: "drop the gate stage" }, adminA.auth);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().refusals.map((r: { code: string }) => r.code)).toContain("stage_removed");

    const filed = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false, reason: "add the scan stage" }, adminA.auth);
    expect(filed.statusCode, filed.body).toBe(202);
    // the gate is approved first: the inserted stage is now behind the instance
    const [g] = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.stageId, "gate"), eq(approvals.status, "pending")));
    expect((await post(`/v1/approvals/${g!.id}/decide`, { decision: "approved" }, adminA.auth)).statusCode).toBe(200);
    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.instanceId, id), eq(approvals.objectType, "workflow_migration"), eq(approvals.approverUserId, adminB.id)));
    expect((await post(`/v1/approvals/${row!.id}/decide`, { decision: "approved" }, adminB.auth)).statusCode).toBe(200);
    expect((await view(id)).definition.stages).toHaveLength(3);
    const listed = (await get(`/v1/workflows/instances/${id}/migrations`, adminA.auth)).json().migrations;
    expect(listed[0].status).toBe("stale");
    const stale = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, WORKFLOW_MIGRATION_RULE_IDS.stale)));
    expect(stale).toHaveLength(1);
  });
});
