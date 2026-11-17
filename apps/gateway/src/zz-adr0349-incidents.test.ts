/**
 * ADR-0349 incident console (slice 5 extension): stuck or failed workflow instances, and retry / skip / cancel on
 * them. Admin-only, audited, skip behind a step-up and the template's `skippable`, and every move a kernel event.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, sql, workflowEvents, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e30-inc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
let restoreStepUp: (() => Promise<void>) | undefined;
type Who = { id: string; auth: { authorization: string } };
let admin: Who;
let pia: Who;
let ana: Who;

async function makeUser(name: string, isAdmin = false): Promise<Who> {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `e30-inc-${name}-${RUN}@example.com`, displayName: name, ...(isAdmin ? { isAdmin: true } : {}) } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function makeTemplate(key: string, skippable: boolean) {
  const name = `e30-inc-${key}-${RUN}`;
  const t = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name,
      definition: {
        workflow: name,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "checks", type: "automated_check", checks: ["e2e"], ...(skippable ? { skippable: true } : {}) },
          { id: "gate", type: "human_approval", approvers: [ana.id] },
        ],
      },
    },
  });
  expect(t.statusCode).toBe(201);
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: t.json().id, changeType: name } });
  expect(r.statusCode).toBe(201);
}
const start = async (key: string) => {
  const res = await app.inject({
    method: "POST",
    headers: pia.auth,
    url: "/v1/workflows/instances",
    payload: { change: { description: `e30 inc ${key}`, paths: [], changeType: `e30-inc-${key}-${RUN}`, environment: "dev" } },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};
/** a failing check report from an arm's-length admin, bound to the current round */
const failCheck = async (id: string) => {
  const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, id));
  const res = await app.inject({
    method: "POST",
    headers: admin.auth,
    url: `/v1/workflows/instances/${id}/checks`,
    payload: { stageId: "checks", round: row!.round, results: [{ check: "e2e", status: "failed", detail: "runner outage" }] },
  });
  expect(res.statusCode).toBeLessThan(300);
};
const incidents = async (who: { authorization: string } = admin.auth) => app.inject({ method: "GET", headers: who, url: "/v1/workflows/incidents?limit=100" });
const act = (id: string, action: string, payload: Record<string, unknown>, who: { authorization: string } = admin.auth) =>
  app.inject({ method: "POST", headers: who, url: `/v1/workflows/instances/${id}/incident/${action}`, payload });
const statusOf = async (id: string) => (await db.select({ s: workflowInstances.status }).from(workflowInstances).where(eq(workflowInstances.id, id)))[0]!.s;
const auditsOf = async (id: string, ruleId: string) => db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, ruleId)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  admin = await makeUser("admin", true);
  pia = await makeUser("pia");
  ana = await makeUser("ana");
  await makeTemplate("skippable", true);
  await makeTemplate("strict", false);
});

afterEach(async () => {
  await restoreStepUp?.();
  restoreStepUp = undefined;
});

afterAll(async () => {
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0349 incident console", () => {
  it("lists a failed check as an incident with its actions, and only to admins", async () => {
    const id = await start("skippable");
    // waiting for a report is normal waiting, not an incident
    expect((await incidents()).json().incidents.find((i: { instanceId: string }) => i.instanceId === id)).toBeUndefined();
    await failCheck(id);
    expect(await statusOf(id)).toBe("blocked_on_check");
    const listed = (await incidents()).json();
    expect(listed.version).toBe(1);
    const inc = listed.incidents.find((i: { instanceId: string }) => i.instanceId === id);
    expect(inc).toMatchObject({ incident: "check_failed", waitingOn: "check_failed", currentStage: { id: "checks" } });
    expect(inc.actions).toEqual([
      { action: "retry", allowed: true },
      { action: "skip", allowed: true, stepUp: "settings_relax" },
      { action: "cancel", allowed: true },
    ]);
    expect((await incidents(pia.auth)).statusCode).toBe(403);
    expect((await act(id, "cancel", { note: "x" }, pia.auth)).statusCode).toBe(403);
  });

  it("skip needs the template's opt-in, a note and a step-up; it is audited and stops at the next sign-off", async () => {
    const strict = await start("strict");
    await failCheck(strict);
    const refused = await act(strict, "skip", { stageId: "checks", note: "outage" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatch(/template does not allow/);

    const id = await start("skippable");
    await failCheck(id);
    expect((await act(id, "skip", { stageId: "checks" })).statusCode).toBe(400);
    // strict step-up posture: an API key cannot answer it, so nothing moves
    const noStepUp = await act(id, "skip", { stageId: "checks", note: "e2e runner outage" });
    expect(noStepUp.statusCode).toBeGreaterThanOrEqual(400);
    expect(await statusOf(id)).toBe("blocked_on_check");

    restoreStepUp = await relaxStepUpForTest(db);
    const ok = await act(id, "skip", { stageId: "checks", note: "e2e runner outage" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("blocked_on_approval");
    expect(await auditsOf(id, "workflow:incident-skip")).toHaveLength(1);
    const events = await db.select().from(workflowEvents).where(eq(workflowEvents.instanceId, id));
    expect(events.map((e) => (e.event as { kind: string }).kind)).toContain("stage_skipped");
    // a sign-off cannot be skipped
    const again = await act(id, "skip", { stageId: "gate", note: "x" });
    expect(again.statusCode).toBe(409);
  });

  it("retry rechecks a failed check through the kernel, audited", async () => {
    const id = await start("skippable");
    await failCheck(id);
    const res = await act(id, "retry", { note: "runner is back" });
    expect(res.statusCode).toBe(200);
    expect(await auditsOf(id, "workflow:incident-retry")).toHaveLength(1);
    const kinds = (await db.select().from(workflowEvents).where(eq(workflowEvents.instanceId, id))).map((e) => (e.event as { kind: string }).kind);
    expect(kinds).toContain("recheck");
  });

  it("a lapsed claim is a stuck incident; a live one blocks retry and skip", async () => {
    const id = await start("skippable");
    await db
      .update(workflowInstances)
      .set({ context: sql`${workflowInstances.context} || jsonb_build_object('executing', 'checks', 'executingClaim', 'c-old', 'executingSince', '2000-01-01T00:00:00.000Z', 'executingEntry', ${workflowInstances.stageEntry})` })
      .where(eq(workflowInstances.id, id));
    const inc = (await incidents()).json().incidents.find((i: { instanceId: string }) => i.instanceId === id);
    expect(inc).toMatchObject({ incident: "stuck_claim" });

    await db
      .update(workflowInstances)
      .set({ context: sql`jsonb_set(${workflowInstances.context}, '{executingSince}', to_jsonb(now()))` })
      .where(eq(workflowInstances.id, id));
    const retry = await act(id, "retry", { note: "x" });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().detail).toMatch(/executor is running/);
  });

  it("cancel aborts through the kernel, audited; an ended instance has no actions", async () => {
    const id = await start("skippable");
    await failCheck(id);
    const res = await act(id, "cancel", { note: "superseded by another change" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("aborted");
    expect(await auditsOf(id, "workflow:incident-cancel")).toHaveLength(1);
    const twice = await act(id, "cancel", { note: "again" });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().detail).toMatch(/has ended/);
  });
});
