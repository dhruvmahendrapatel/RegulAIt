/**
 * ADR-0349 slice 2 (lane E30): the workflow start conflict policy. One OPEN instance per template set + target system
 * + work item; a second start is refused 409 by default, `use_existing` is the audited, step-up relaxation, and the
 * database enforces the key with a partial unique index that an ended instance frees.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, desc, eq, orgSettings, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { WORKFLOW_TERMINAL_STATUSES } from "@regulait/shared";
import type { InstanceStatus } from "@regulait/workflow-kernel";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e30-sc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
// one run id, so a re-run on the same database starts from fresh users, template and work items
const RUN = Date.now().toString(36);
const CHANGE_TYPE = `e30-start-conflict-${RUN}`;
const item = (n: number) => `JIRA-${RUN}-${n}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let pia: { id: string; auth: { authorization: string } };
let bo: { id: string; auth: { authorization: string } };

async function makeUser(email: string, isAdmin = false) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0], ...(isAdmin ? { isAdmin: true } : {}) },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "test" } });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

const start = (auth: { authorization: string }, workItem: string | undefined, targetSystem: string | null = "billing-api") =>
  app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/workflows/instances",
    payload: {
      change: { description: `e30 ${workItem ?? "no item"}`, paths: ["src/a.ts"], changeType: CHANGE_TYPE, environment: "dev", ...(targetSystem ? { targetSystem } : {}) },
      ...(workItem !== undefined ? { workItem } : {}),
    },
  });

const setPolicy = (policy: "refuse" | "use_existing") =>
  app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { workflowStartConflictPolicy: policy } });

const lastAudit = async (ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1))[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  pia = await makeUser(`e30-sc-pia-${RUN}@example.com`);
  bo = await makeUser(`e30-sc-bo-${RUN}@example.com`);
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: CHANGE_TYPE,
      definition: { workflow: CHANGE_TYPE, stages: [{ id: "intake", type: "trigger" }, { id: "req", type: "artifact_generation", output: "requirements" }] },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: CHANGE_TYPE } });
  expect(rule.statusCode).toBe(201);
});

afterAll(async () => {
  // hand the shared database back strict (M-068)
  await db.update(orgSettings).set({ workflowStartConflictPolicy: "refuse" });
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0349 slice 2: one open instance per template set + target + work item", () => {
  it("defaults to refuse", async () => {
    const [row] = await db.select({ p: orgSettings.workflowStartConflictPolicy }).from(orgSettings);
    expect(row!.p).toBe("refuse");
  });

  it("refuses a second start for the same work item with 409, naming the open instance, audited", async () => {
    const first = await start(pia.auth, item(1));
    expect(first.statusCode).toBe(201);
    const second = await start(pia.auth, item(1));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "workflow_start_conflict", existingInstanceId: first.json().id, existingStatus: "blocked_on_artifact" });
    const audit = await lastAudit("workflow:start-conflict");
    expect(audit).toMatchObject({ effect: "deny", objectId: first.json().id, userId: pia.id });
    expect(audit!.detail).toMatchObject({ workItem: item(1), targetSystem: "billing-api", policy: "refuse", existingVisibleToCaller: true });
    const open = await db.select().from(workflowInstances).where(eq(workflowInstances.workItemRef, item(1)));
    expect(open).toHaveLength(1);
  });

  it("keys on the target and the work item: a different item or target starts, and no work item never deduplicates", async () => {
    expect((await start(pia.auth, item(2))).statusCode).toBe(201);
    expect((await start(pia.auth, item(2), "ledger-api")).statusCode).toBe(201);
    // a missing target is a value of its own (NULLS NOT DISTINCT)
    expect((await start(pia.auth, item(2), null)).statusCode).toBe(201);
    expect((await start(pia.auth, item(2), null)).statusCode).toBe(409);
    expect((await start(pia.auth, undefined)).statusCode).toBe(201);
    expect((await start(pia.auth, undefined)).statusCode).toBe(201);
  });

  it("does not name another person's instance", async () => {
    const res = await start(bo.auth, item(1));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("workflow_start_conflict");
    expect(res.json().existingInstanceId).toBeUndefined();
    expect((await lastAudit("workflow:start-conflict"))!.detail).toMatchObject({ existingVisibleToCaller: false });
  });

  it("frees the key when the open instance ends", async () => {
    const first = await start(pia.auth, item(3));
    expect(first.statusCode).toBe(201);
    const abort = await app.inject({ method: "POST", headers: pia.auth, url: `/v1/workflows/instances/${first.json().id}/abort` });
    expect(abort.statusCode).toBe(200);
    const again = await start(pia.auth, item(3));
    expect(again.statusCode).toBe(201);
    expect(again.json().id).not.toBe(first.json().id);
  });

  it("a race between two starts ends with one instance and one 409 (the unique index)", async () => {
    const [a, b] = await Promise.all([start(pia.auth, item(4)), start(pia.auth, item(4))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await db.select().from(workflowInstances).where(eq(workflowInstances.workItemRef, item(4)))).toHaveLength(1);
  });

  it("the database refuses a second open row for the same key, whatever the caller", async () => {
    const [held] = await db.select().from(workflowInstances).where(eq(workflowInstances.workItemRef, item(1)));
    const dup = db.insert(workflowInstances).values({ ...held!, id: undefined, createdAt: undefined, updatedAt: undefined });
    await expect(dup).rejects.toMatchObject({ cause: { code: "23505", constraint: "workflow_instances_open_start_uq" } });
    // an ended row with the same key does not count
    await db.insert(workflowInstances).values({ ...held!, id: undefined, createdAt: undefined, updatedAt: undefined, status: "aborted" });
  });

  it("keys on the template SET: the same templates in another order hold the same key", async () => {
    const [held] = await db.select().from(workflowInstances).where(eq(workflowInstances.workItemRef, item(1)));
    const other = "00000000-0000-4000-8000-000000000001";
    const ids = held!.templateIds as string[];
    // a set of two, written in both orders: the second open row is refused
    await db.insert(workflowInstances).values({ ...held!, id: undefined, createdAt: undefined, updatedAt: undefined, workItemRef: item(90), templateIds: [...ids, other] });
    const swapped = db.insert(workflowInstances).values({ ...held!, id: undefined, createdAt: undefined, updatedAt: undefined, workItemRef: item(90), templateIds: [other, ...ids] });
    await expect(swapped).rejects.toMatchObject({ cause: { code: "23505", constraint: "workflow_instances_open_start_uq" } });
  });

  it("the index predicate is built from the one declared list of terminal statuses, the kernel's", async () => {
    // compile-time: every declared terminal status is a kernel status
    const declared: readonly InstanceStatus[] = WORKFLOW_TERMINAL_STATUSES;
    const res = (await db.execute(sql`SELECT pg_get_indexdef('workflow_instances_open_start_uq'::regclass) AS def`)) as unknown as { rows: Array<{ def: string }> };
    const def = res.rows[0]!.def;
    for (const s of declared) expect(def).toContain(`'${s}'`);
    expect(def).toContain("regulait_workflow_template_set(template_ids)");
  });

  it("an admin's API key cannot relax the policy: the step-up is refused and nothing changes", async () => {
    const ada = await makeUser(`e30-sc-ada-${RUN}@example.com`, true);
    const put = await app.inject({ method: "PUT", headers: ada.auth, url: "/v1/org/settings", payload: { workflowStartConflictPolicy: "use_existing" } });
    expect(put.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.select({ p: orgSettings.workflowStartConflictPolicy }).from(orgSettings))[0]!.p).toBe("refuse");
  });

  it("refuses a work item that is not printable or is too long", async () => {
    expect((await start(pia.auth, " JIRA-1")).statusCode).toBe(400);
    expect((await start(pia.auth, "JIRA\n1")).statusCode).toBe(400);
    expect((await start(pia.auth, "x".repeat(201))).statusCode).toBe(400);
  });

  it("use_existing is a relaxation, audited, and answers 200 with the open instance", async () => {
    const put = await setPolicy("use_existing");
    expect(put.statusCode).toBe(200);
    const settingsAudit = (
      await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "org_settings"), sql`${auditLog.detail}->'relaxed' ? 'workflowStartConflictPolicy'`))
        .orderBy(desc(auditLog.at))
        .limit(1)
    )[0];
    expect(settingsAudit).toBeDefined();

    const [held] = await db
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.workItemRef, item(1)), eq(workflowInstances.status, "blocked_on_artifact")));
    const reused = await start(pia.auth, item(1));
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({ id: held!.id, reused: true, status: "blocked_on_artifact" });
    expect(await lastAudit("workflow:start-reused")).toMatchObject({ effect: "allow", objectId: held!.id });
    // someone who may not read it is still refused, without its id
    const other = await start(bo.auth, item(1));
    expect(other.statusCode).toBe(409);
    expect(other.json().existingInstanceId).toBeUndefined();
    expect((await setPolicy("refuse")).statusCode).toBe(200);
  });
});
