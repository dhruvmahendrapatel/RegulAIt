/**
 * ADR-0349 slice 5 (lane E30): typed, index-served search fields on GET /v1/workflows/instances, and the read-only
 * pending-work view GET /v1/workflows/instances/:id/pending.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createDb, eq, projects, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { describePendingWork, WAITING_ON } from "./workflow-pending.js";
import { CURRENT_STAGE_ID_SQL, instanceSearchConditions } from "./workflows.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e30-vis-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
type Who = { id: string; auth: { authorization: string } };
let pia: Who;
let bo: Who;
let ana: Who;
const tpl: Record<string, string> = {};

async function makeUser(name: string): Promise<Who> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-vis-${name}-${RUN}@example.com`, displayName: name } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function makeTemplate(key: string, stages: unknown[]) {
  const name = `e30-vis-${key}-${RUN}`;
  const t = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/templates", payload: { name, definition: { workflow: name, stages } } });
  expect(t.statusCode).toBe(201);
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: t.json().id, changeType: name } });
  expect(r.statusCode).toBe(201);
  tpl[key] = t.json().id;
}
const start = async (who: Who, key: string, extra: { targetSystem?: string; workItem?: string } = {}) => {
  const res = await app.inject({
    method: "POST",
    headers: who.auth,
    url: "/v1/workflows/instances",
    payload: {
      change: { description: `e30 vis ${key}`, paths: [], changeType: `e30-vis-${key}-${RUN}`, environment: "dev", ...(extra.targetSystem ? { targetSystem: extra.targetSystem } : {}) },
      ...(extra.workItem ? { workItem: extra.workItem } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};
const list = (who: { authorization: string }, q: string) => app.inject({ method: "GET", headers: who, url: `/v1/workflows/instances?${q}` });
const pending = (who: { authorization: string }, id: string) => app.inject({ method: "GET", headers: who, url: `/v1/workflows/instances/${id}/pending` });

let artifactId: string;
let approvalId: string;
let checkId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  pia = await makeUser("pia");
  bo = await makeUser("bo");
  ana = await makeUser("ana");
  await makeTemplate("artifact", [{ id: "intake", type: "trigger" }, { id: "req", type: "artifact_generation", output: "requirements" }]);
  await makeTemplate("approval", [{ id: "intake", type: "trigger" }, { id: "gate", type: "human_approval", approvers: [ana.id] }]);
  await makeTemplate("check", [{ id: "intake", type: "trigger" }, { id: "checks", type: "automated_check", checks: ["unit"] }]);
  artifactId = await start(pia, "artifact", { targetSystem: `billing-${RUN}`, workItem: `VIS-${RUN}-1` });
  approvalId = await start(pia, "approval", { targetSystem: `ledger-${RUN}` });
  checkId = await start(bo, "check", { targetSystem: `billing-${RUN}` });
});

afterAll(async () => {
  await restoreIdentity?.();
  await app.close();
});

const idsOf = (res: { json: () => { instances?: Array<{ id: string }>; items?: Array<{ id: string }> } }) =>
  ((res.json().instances ?? res.json().items) ?? []).map((i) => i.id).sort();

describe("ADR-0349 slice 5: typed instance search", () => {
  it("filters by template, target, work item, owner, stage and status (legacy answer and list contract)", async () => {
    expect(idsOf(await list(AUTH, `template=${tpl.artifact}`))).toEqual([artifactId]);
    expect(idsOf(await list(AUTH, `target=billing-${RUN}`))).toEqual([artifactId, checkId].sort());
    expect(idsOf(await list(AUTH, `workItem=VIS-${RUN}-1`))).toEqual([artifactId]);
    expect(idsOf(await list(AUTH, `owner=${bo.id}`))).toEqual([checkId]);
    expect(idsOf(await list(AUTH, `stage=gate&owner=${pia.id}`))).toEqual([approvalId]);
    expect(idsOf(await list(AUTH, `status=awaiting_execution&owner=${bo.id}`))).toEqual([checkId]);
    // the ADR-0226 contract reads the same fields
    const page = await list(AUTH, `target=billing-${RUN}&sort=created&limit=10`);
    expect(page.statusCode).toBe(200);
    expect(idsOf(page)).toEqual([artifactId, checkId].sort());
  });

  it("filters by compliance tag through the attributed project's classifications", async () => {
    const tag = `pci-${RUN}`;
    const [p] = await db.insert(projects).values({ name: `e30-vis-${RUN}`, classifications: [tag] }).returning();
    await db.update(workflowInstances).set({ projectId: p!.id }).where(eq(workflowInstances.id, approvalId));
    expect(idsOf(await list(AUTH, `complianceTag=${tag}`))).toEqual([approvalId]);
  });

  it("only ever narrows what a non-admin may see, and refuses an unknown field", async () => {
    expect(idsOf(await list(pia.auth, `target=billing-${RUN}`))).toEqual([artifactId]);
    expect(idsOf(await list(pia.auth, `owner=${bo.id}`))).toEqual([]);
    expect((await list(AUTH, "color=red")).statusCode).toBe(400);
    expect((await list(AUTH, "template=not-a-uuid")).statusCode).toBe(400);
  });

  it("every search field's predicate can be served by its index", async () => {
    const fields: Array<[Record<string, string>, string]> = [
      [{ template: randomUUID() }, "workflow_instances_template_ids_gin"],
      [{ target: "x" }, "workflow_instances_target_idx"],
      [{ workItem: "x" }, "workflow_instances_work_item_idx"],
      [{ owner: randomUUID() }, "workflow_instances_initiator_idx"],
      [{ stage: "x" }, "workflow_instances_current_stage_idx"],
      [{ status: "x" }, "workflow_instances_status_idx"],
      [{ complianceTag: "x" }, "projects_classifications_gin"],
    ];
    for (const [f, index] of fields) {
      const where = sql.join(instanceSearchConditions(f), sql` AND `);
      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const r = (await tx.execute(sql`EXPLAIN SELECT id FROM workflow_instances WHERE ${where}`)) as unknown as { rows: Array<Record<string, string>> };
        return r.rows.map((x) => Object.values(x)[0]).join("\n");
      });
      expect(plan, `${Object.keys(f)[0]} → ${index}`).toContain(index);
    }
    void CURRENT_STAGE_ID_SQL;
  });
});

describe("ADR-0349 slice 5: the pending-work view", () => {
  it("names what each instance waits for, machine-readable", async () => {
    const a = (await pending(pia.auth, artifactId)).json();
    expect(a).toMatchObject({ version: 1, waitingOn: "artifact", currentStage: { id: "req", type: "artifact_generation", index: 1 } });
    expect(a.detail).toMatch(/requirements/);

    const g = (await pending(pia.auth, approvalId)).json();
    expect(g).toMatchObject({ waitingOn: "approval", pendingApprovers: [ana.id] });

    const c = (await pending(bo.auth, checkId)).json();
    expect(c).toMatchObject({ waitingOn: "check_report", claim: null });
  });

  it("shows a live claim with its lease, and a failed stage waiting for /advance", async () => {
    await db
      .update(workflowInstances)
      .set({ context: sql`${workflowInstances.context} || jsonb_build_object('executing', 'checks', 'executingClaim', 'c-1', 'executingSince', to_jsonb(now()), 'executingEntry', ${workflowInstances.stageEntry})` })
      .where(eq(workflowInstances.id, checkId));
    const live = (await pending(bo.auth, checkId)).json();
    expect(live.waitingOn).toBe("execution");
    expect(live.claim).toMatchObject({ claimId: "c-1", live: true });
    expect(Date.parse(live.claim.leaseExpiresAt)).toBeGreaterThan(Date.now());

    await db
      .update(workflowInstances)
      .set({ context: sql`(${workflowInstances.context} - 'executing' - 'executingClaim' - 'executingSince' - 'executingEntry') || '{"lastError":"checks: provider 502"}'::jsonb` })
      .where(eq(workflowInstances.id, checkId));
    expect((await pending(bo.auth, checkId)).json()).toMatchObject({ waitingOn: "advance", lastError: "checks: provider 502" });
  });

  it("an ended instance waits for nothing", async () => {
    expect((await app.inject({ method: "POST", headers: pia.auth, url: `/v1/workflows/instances/${artifactId}/abort` })).statusCode).toBe(200);
    expect((await pending(pia.auth, artifactId)).json()).toMatchObject({ waitingOn: "nothing", status: "aborted" });
  });

  it("has the instance's readers: initiator, admins and named approvers; not anyone else", async () => {
    expect((await pending(ana.auth, approvalId)).statusCode).toBe(200);
    expect((await pending(AUTH, approvalId)).statusCode).toBe(200);
    expect((await pending(bo.auth, approvalId)).statusCode).toBe(403);
    expect((await pending(pia.auth, randomUUID())).statusCode).toBe(404);
  });

  it("reports a queued retry and a stage deadline (pure view)", () => {
    const row = {
      id: "i",
      status: "awaiting_execution",
      definition: { workflow: "w", stages: [{ id: "t", type: "trigger" }, { id: "pr", type: "git_operation", action: "open_pr" }] },
      state: { status: "awaiting_execution", currentStageIndex: 1, stageStatuses: ["completed", "active"], artifactVersions: {} },
      context: { lastError: "pr: 502", "sla:pr": { dueAt: "2026-11-20T00:00:00.000Z" } },
      round: 0,
      stageEntry: 2,
    };
    const v = describePendingWork({ row, now: new Date(), leaseMs: 60_000, retry: { state: "created", attempt: 2, maxAttempts: 3, nextRunAt: "2026-11-17T10:00:00.000Z" }, pendingApprovers: [] });
    expect(v).toMatchObject({ waitingOn: "retry", retry: { attempt: 2 }, deadline: { dueAt: "2026-11-20T00:00:00.000Z" } });
    expect(WAITING_ON).toContain(v.waitingOn);
  });
});
