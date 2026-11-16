import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, approvals, auditLog, createDb, eq, runMigrations, workflowInstanceTemplateVersions, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

/**
 * ADR-0340 slice 3 — workflow template versions (ADR-0048 `config_versions`, type `workflow_template`), pinning
 * per instance, canary over NEW instances, and governed migration of a running instance through the one approvals
 * queue. Everything is prefixed wv- and run-scoped.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = "wv-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
type U = { id: string; auth: { authorization: string } };
let pia: U;
let adminA: U;
let adminB: U;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });

async function makeUser(name: string, isAdmin = false): Promise<U> {
  const user = await post("/v1/users", { email: `wv-${name}-${RUN}@example.com`, displayName: name, ...(isAdmin ? { isAdmin: true } : {}) });
  expect(user.statusCode, user.body).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "wv" });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}
async function view(id: string) {
  const res = await get(`/v1/workflows/instances/${id}`, pia.auth);
  expect(res.statusCode).toBe(200);
  return res.json().instance;
}
async function start(changeType: string) {
  const res = await post(
    "/v1/workflows/instances",
    { change: { description: `wv ${changeType}`, paths: ["src/x.ts"], changeType, environment: `wv-env-${RUN}` } },
    pia.auth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function pinned(instanceId: string) {
  return db.select().from(workflowInstanceTemplateVersions).where(eq(workflowInstanceTemplateVersions.instanceId, instanceId)).orderBy(workflowInstanceTemplateVersions.at);
}
async function approveGate(instanceId: string, stageId: string) {
  const [a] = await db.select().from(approvals).where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, stageId), eq(approvals.status, "pending")));
  const d = await post(`/v1/approvals/${a!.id}/decide`, { decision: "approved" }, adminA.auth);
  expect(d.statusCode, d.body).toBe(200);
}

const gate = () => ({ id: "gate", type: "human_approval", approvers: [adminA.id] });
const v1Stages = () => [{ id: "intake", type: "trigger" }, gate(), { id: "build", type: "automated_build" }];
const v2Stages = () => [{ id: "intake", type: "trigger" }, gate(), { id: "scan", type: "automated_check" }, { id: "build", type: "automated_build" }];

let templateId: string;
const name = () => `wv-tpl-${RUN}`;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  pia = await makeUser("pia");
  adminA = await makeUser("admin-a", true);
  adminB = await makeUser("admin-b", true);
  const tpl = await post("/v1/workflows/templates", { name: name(), definition: { workflow: name(), stages: v1Stages() } });
  expect(tpl.statusCode, tpl.body).toBe(201);
  templateId = tpl.json().id;
  expect((await post("/v1/workflows/assignment-rules", { templateId, changeType: name() })).statusCode).toBe(201);
});
afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await app.close();
});

describe("ADR-0340 slice 3: template versions, pinning, canary and migration", () => {
  const versions = `/v1/config-versions/workflow_template`;

  it("an instance of a template with no versions is pinned to the template as created", async () => {
    const id = await start(name());
    const rows = await pinned(id);
    expect(rows).toEqual([expect.objectContaining({ templateId, configVersionId: null, canary: false, via: "start" })]);
  });

  it("a version is checked like a new template; activating one updates the template", async () => {
    const bad = await post(`${versions}/${templateId}`, { body: { workflow: name(), stages: [{ id: "x", type: "planning" }] } });
    expect(bad.statusCode).toBe(422);
    const badApprover = await post(`${versions}/${templateId}`, {
      body: { workflow: name(), stages: [{ id: "intake", type: "trigger" }, { id: "g", type: "human_approval", approvers: ["00000000-0000-0000-0000-00000000dead"] }] },
    });
    expect(badApprover.statusCode).toBe(422);
    const v1 = await post(`${versions}/${templateId}`, { body: { workflow: name(), stages: v1Stages() }, activate: true });
    expect(v1.statusCode, v1.body).toBe(201);
    const v2 = await post(`${versions}/${templateId}`, { body: { workflow: name(), stages: v2Stages() } });
    expect(v2.statusCode, v2.body).toBe(201);
    const lineage = await get(`${versions}/${templateId}`);
    expect(lineage.json().canaryMode).toBe("live");
    expect(lineage.json().artifactDeleted).toBe(false);
  });

  it("a canary serves a share of NEW instances, sticky per instance, each pinned and the selection audited", async () => {
    const canary = await post(`${versions}/${templateId}/canary`, { version: 2, pct: 50 });
    expect(canary.statusCode, canary.body).toBe(200);
    const served: boolean[] = [];
    for (let i = 0; i < 16; i++) {
      const id = await start(name());
      const [row] = await pinned(id);
      const inst = await view(id);
      const hasScan = (inst.definition.stages as Array<{ id: string }>).some((s) => s.id === "scan");
      expect(hasScan).toBe(row!.canary);
      const audited = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "workflow:canary-version-selected")));
      expect(audited.length).toBe(row!.canary ? 1 : 0);
      served.push(row!.canary);
    }
    // 16 instance ids over a 50% bucket: both sides are served (fnv1a buckets are effectively uniform)
    expect(served.some(Boolean)).toBe(true);
    expect(served.some((x) => !x)).toBe(true);
    const ended = await app.inject({ method: "DELETE", url: `${versions}/${templateId}/canary`, headers: AUTH, payload: {} });
    expect(ended.statusCode, ended.body).toBe(200);
  });

  it("a running instance migrates to a new version only through another admin's approval, then runs on it", async () => {
    // a fresh instance on v1 (no canary now), resting at its gate
    const id = await start(name());
    expect((await view(id)).status).toBe("blocked_on_approval");
    const [v2] = (await get(`${versions}/${templateId}`)).json().versions.filter((v: { version: number }) => v.version === 2);
    const dry = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id }, adminA.auth);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, ok: true, added: ["scan"] });
    expect(dry.json().diff.length).toBeGreaterThan(0);
    // a non-admin cannot reach the route
    expect((await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id }, pia.auth)).statusCode).toBe(403);
    // a request needs a reason, and files approvals for the OTHER admins only
    expect((await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false }, adminA.auth)).statusCode).toBe(400);
    const filed = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false, reason: "add the scan" }, adminA.auth);
    expect(filed.statusCode, filed.body).toBe(202);
    const rows = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.objectType, "workflow_migration")));
    expect(rows.map((r) => r.approverUserId)).not.toContain(adminA.id);
    expect(rows.map((r) => r.approverUserId)).toContain(adminB.id);
    expect((await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2.id, dryRun: false, reason: "again" }, adminA.auth)).statusCode).toBe(409);
    const mine = rows.find((r) => r.approverUserId === adminB.id)!;
    // the requester cannot decide it, even with the admin override the decide path allows admins
    const own = await post(`/v1/approvals/${mine.id}/decide`, { decision: "approved", reason: "override" }, adminA.auth);
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_workflow_migration");
    // nothing moved yet
    expect((await view(id)).definition.stages).toHaveLength(3);
    const decided = await post(`/v1/approvals/${mine.id}/decide`, { decision: "approved" }, adminB.auth);
    expect(decided.statusCode, decided.body).toBe(200);
    const inst = await view(id);
    expect(inst.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate", "scan", "build"]);
    expect(inst.status).toBe("blocked_on_approval");
    const pins = await pinned(id);
    expect(pins.at(-1)).toMatchObject({ via: "migration", configVersionId: v2.id });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "workflow:instance-migrated")));
    expect(audit!.detail).toMatchObject({ targetVersion: 2, added: ["scan"] });
    // the migrated instance runs on: the gate now leads to the new stage
    await approveGate(id, "gate");
    expect((await view(id)).status).toBe("awaiting_trigger");
    expect((await view(id)).state.currentStageIndex).toBe(2);
    const listed = await get(`/v1/workflows/instances/${id}/migrations`, adminA.auth);
    expect(listed.json().migrations[0]).toMatchObject({ status: "applied", decidedByUserId: adminB.id });
  });

  it("refuses a migration that rewrites the past, and records stale when the instance moved past the change", async () => {
    const id = await start(name());
    // v3 drops the gate the instance rests at
    const v3 = await post(`${versions}/${templateId}`, { body: { workflow: name(), stages: [{ id: "intake", type: "trigger" }, { id: "build", type: "automated_build" }] } });
    expect(v3.statusCode, v3.body).toBe(201);
    const lineage = (await get(`${versions}/${templateId}`)).json().versions;
    const v3row = lineage.find((v: { version: number }) => v.version === 3);
    const refused = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v3row.id, dryRun: false, reason: "drop gate" }, adminA.auth);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().refusals.map((r: { code: string }) => r.code)).toContain("stage_removed");

    // a request filed at the gate, then the gate is approved: the inserted stage is now behind the instance
    const v2row = lineage.find((v: { version: number }) => v.version === 2);
    const filed = await post(`/v1/workflows/instances/${id}/migrations`, { targetVersionId: v2row.id, dryRun: false, reason: "add the scan" }, adminA.auth);
    expect(filed.statusCode, filed.body).toBe(202);
    await approveGate(id, "gate");
    expect((await view(id)).state.currentStageIndex).toBe(2);
    const [row] = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.objectType, "workflow_migration"), eq(approvals.approverUserId, adminB.id)));
    const own = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.objectType, "workflow_migration"), eq(approvals.status, "pending")));
    expect(own.every((r) => r.approverUserId !== adminA.id)).toBe(true);
    expect((await post(`/v1/approvals/${row!.id}/decide`, { decision: "approved" }, adminB.auth)).statusCode).toBe(200);
    const inst = await view(id);
    expect(inst.definition.stages).toHaveLength(3);
    const listed = (await get(`/v1/workflows/instances/${id}/migrations`, adminA.auth)).json().migrations;
    expect(listed[0].status).toBe("stale");
    const stale = await db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "workflow:migration-stale")));
    expect(stale).toHaveLength(1);
  });
});
