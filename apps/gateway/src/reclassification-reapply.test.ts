import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * O1 (ADR-0027) — reclassification REAPPLY to in-flight instances under the
 * ADDITIVE-ONLY rule: strictly-additive changes (newly required templates
 * whose merge only APPENDS not-yet-executed stages) apply automatically,
 * audited; relaxations and restructures are surfaced manual, never silent.
 * Shares one DB (fileParallelism off); prefix o1-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o1-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let piaAuth: { authorization: string };
let secureTplId: string;
let conflictTplId: string;

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "o1" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeTemplate(name: string, stages: unknown[], changeType?: string): Promise<string> {
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages } },
  });
  expect(tpl.statusCode).toBe(201);
  if (changeType) {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType },
    });
  }
  return tpl.json().id as string;
}

async function mkProjectAndInstance(name: string, changeType: string) {
  const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name } });
  const projectId = p.json().id as string;
  const started = await app.inject({
    method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
    payload: { projectId, change: { description: "o1", paths: ["x"], changeType, environment: "dev" } },
  });
  expect(started.statusCode).toBe(201);
  return { projectId, instanceId: started.json().id as string };
}

async function instanceView(instanceId: string) {
  const r = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${instanceId}` });
  return r.json().instance;
}

async function decideGate(instanceId: string, stageId: string) {
  const view = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${instanceId}` });
  const gate = (view.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === stageId);
  expect(gate).toBeTruthy();
  const d = await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${gate.id}/decide`, payload: { decision: "approved" } });
  expect(d.statusCode).toBe(200);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const ana = await makeUser("o1-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  piaAuth = (await makeUser("o1-pia@example.com")).auth;
  // the base template each instance starts from
  await makeTemplate("o1-base", [
    { id: "intake", type: "trigger" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
  ], "o1-change");
  // the framework-required template: identical trigger (dedupes) + one NEW stage
  secureTplId = await makeTemplate("o1-secure", [
    { id: "intake", type: "trigger" },
    { id: "sec-review", type: "human_approval", approvers: [anaId] },
  ]);
  // a CONFLICTING template: same stage id 'gate' with a different config
  conflictTplId = await makeTemplate("o1-conflict", [
    { id: "intake", type: "trigger" },
    { id: "gate", type: "human_approval", approvers: [anaId], quorum: "any" },
  ]);
  for (const [tag, tpl] of [["o1-soc2", secureTplId], ["o1-clash", conflictTplId]] as const) {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: { tag, requiredTemplateIds: [tpl] },
    });
    expect(r.statusCode).toBe(201);
  }
});

describe("strictly-additive reapply — applied automatically, audited, and the appended stage really gates", () => {
  it("classification adds the required template's stages to the in-flight instance; the instance then drives through them", async () => {
    const { projectId, instanceId } = await mkProjectAndInstance("o1-additive", "o1-change");
    const before = await instanceView(instanceId);
    expect(before.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate"]);

    const classify = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-soc2"] },
    });
    expect(classify.statusCode).toBe(200);
    expect(classify.json().inFlight).toMatchObject({ applied: 1, manual: 0 });

    const after = await instanceView(instanceId);
    expect(after.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate", "sec-review"]);
    expect(after.templateIds).toContain(secureTplId);
    expect(after.state.stageStatuses).toHaveLength(3);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "reclassification-reapply-applied"), eq(auditLog.objectId, instanceId)));
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ addedStageIds: ["sec-review"] });

    // the appended stage is REAL: after the original gate, the instance
    // blocks on sec-review and only completes once it too is approved
    await decideGate(instanceId, "gate");
    expect((await instanceView(instanceId)).status).toBe("blocked_on_approval");
    await decideGate(instanceId, "sec-review");
    expect((await instanceView(instanceId)).status).toBe("completed");
  });

  it("the APPROVED-reclassification path reapplies too (the decide hook)", async () => {
    const { projectId, instanceId } = await mkProjectAndInstance("o1-via-review", "o1-change");
    // first classification with NO required templates → nothing to add
    const first = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-untracked-tag"] },
    });
    expect(first.statusCode).toBe(200);
    // CHANGE to the soc2 tag: pends behind the reviewer, then approve
    const proposed = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-soc2"], reviewerUserId: anaId },
    });
    expect(proposed.statusCode).toBe(202);
    const d = await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/approvals/${proposed.json().approvalId}/decide`,
      // the bootstrap-proposed row lists the reviewer as requester too — a
      // self-review needs a recorded reason (SoD guard)
      payload: { decision: "approved", reason: "o1 cascade diff reviewed" },
    });
    expect(d.statusCode).toBe(200);
    const after = await instanceView(instanceId);
    expect(after.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate", "sec-review"]);
  });
});

describe("restructures and relaxations stay manual — surfaced, never silent", () => {
  it("a conflicting required template is surfaced manual; the instance is untouched", async () => {
    const { projectId, instanceId } = await mkProjectAndInstance("o1-restructure", "o1-change");
    const classify = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-clash"] },
    });
    expect(classify.statusCode).toBe(200);
    expect(classify.json().inFlight).toMatchObject({ applied: 0, manual: 1 });
    const after = await instanceView(instanceId);
    expect(after.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate"]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "reclassification-reapply-manual"), eq(auditLog.objectId, instanceId)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit!.reason).toContain("never silent");
  });

  it("a RELAXATION (tag with requirements removed) is surfaced manual and the stricter definition stands", async () => {
    const { projectId, instanceId } = await mkProjectAndInstance("o1-relax", "o1-change");
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-soc2"] },
    });
    expect((await instanceView(instanceId)).definition.stages).toHaveLength(3);
    // reclassify AWAY from soc2 — the requirement disappears
    const proposed = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/classifications`,
      payload: { classifications: ["o1-untracked-tag"], reviewerUserId: anaId },
    });
    expect(proposed.statusCode).toBe(202);
    await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/approvals/${proposed.json().approvalId}/decide`,
      // the bootstrap-proposed row lists the reviewer as requester too — a
      // self-review needs a recorded reason (SoD guard)
      payload: { decision: "approved", reason: "o1 cascade diff reviewed" },
    });
    // the already-merged (stricter) definition STANDS — never auto-relaxed
    const after = await instanceView(instanceId);
    expect(after.definition.stages.map((s: { id: string }) => s.id)).toEqual(["intake", "gate", "sec-review"]);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "reclassification-reapply-manual"), eq(auditLog.objectId, instanceId)));
    expect(rows.some((r) => r.reason.includes("relaxing a running instance"))).toBe(true);
  });
});
