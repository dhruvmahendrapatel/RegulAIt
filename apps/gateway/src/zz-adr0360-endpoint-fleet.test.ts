/**
 * ADR-0360 slice 1a — endpoint agent fleet operations, end to end (real database).
 *
 *  - every route is admin-only;
 *  - device groups are ADR-0350's (lane E31's routes and table, reused): a stage or a one-line token names one, and
 *    deleting the group is never blocked by either (the stage keeps the name as evidence and offers nothing);
 *  - self-update is off by default; turning it on is a `settings_relax` step-up bound to the source (a missing or
 *    mismatched grant is refused and nothing changes), recorded on the row and audited; the CHECK refuses "on" without
 *    a recorded relaxation; turning it off is free;
 *  - rollouts follow the declared lifecycle: start and resume are refused while self-update is off, stages move
 *    pending → active → done, an illegal or stale event is refused (409) and changes nothing, one open rollout per
 *    source;
 *  - one-line enrolment: one device, 15 minutes by default and at most 60 (also the CHECK), the device joins the
 *    token's ADR-0350 group, a second redemption is refused, and the secret is in no audit row.
 *
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  discoveryPseudonymKeys,
  discoverySources,
  endpointDeviceGroupMembers,
  endpointDeviceGroups,
  endpointEnrolmentTokens,
  endpointFleetSettings,
  endpointUpdateRolloutStages,
  endpointUpdateRollouts,
  eq,
  inArray,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { ROLLOUT_MACHINE, ROLLOUT_STAGE_MACHINE, describe as describeState, sourcesOf } from "./endpoint-fleet-lifecycle.js";
import { selfUpdateRelaxStepUp } from "./endpoint-fleet-routes.js";
import { hashToken } from "./token-hash.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantSpent, grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e41-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`e41-data-key-${RUN}`).digest("hex");
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberKey: { authorization: string };
let adminId: string;
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
const groupIds: string[] = [];

type Method = "GET" | "POST" | "PUT" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

let seq = 0;
async function agentSource(enabled = true) {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e41-agent-${RUN}-${++seq}`, kind: "endpoint_agent", target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  sourceIds.push(id);
  if (enabled) await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, id));
  return id;
}
/** an ADR-0350 device group, through lane E31's own route (org-wide, so the name carries the run) */
async function group(name: string) {
  const r = await inject("POST", "/v1/endpoint-device-groups", AUTH, { name: `e41-${name}-${RUN}-${++seq}` });
  expect(r.statusCode, r.body).toBe(201);
  groupIds.push(r.json().id as string);
  return r.json().id as string;
}
const ticket = (bulk: string, hostname: string) =>
  inject("POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${bulk}` }, { hostname, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
async function selfUpdateOn(sourceId: string) {
  const g = await grantStepUpForTest(db, adminId, selfUpdateRelaxStepUp(sourceId));
  const r = await app.inject({ method: "PUT", url: `/v1/discovery/sources/${sourceId}/fleet-settings`, ...stepUpRequest(g), payload: { selfUpdate: true } });
  expect(r.statusCode, r.body).toBe(200);
}
const act = (rolloutId: string, action: string) => inject("POST", `/v1/discovery/update-rollouts/${rolloutId}/${action}`, AUTH, {});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  const priorPseudonymKeys = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (priorPseudonymKeys.length) await db.insert(discoveryPseudonymKeys).values(priorPseudonymKeys);
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const u = await inject("POST", "/v1/users", AUTH, { email: `e41-member-${RUN}@example.com`, displayName: "e41 member" });
  const k = await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" });
  memberKey = { authorization: `Bearer ${k.json().token}` };
  const a = await inject("POST", "/v1/users", AUTH, { email: `e41-admin-${RUN}@example.com`, displayName: "e41 admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    await db.delete(endpointUpdateRollouts).where(inArray(endpointUpdateRollouts.sourceId, sourceIds));
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  if (groupIds.length) await db.delete(endpointDeviceGroups).where(inArray(endpointDeviceGroups.id, groupIds));
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("ADR-0360: the declared lifecycles", () => {
  it("guards every write with the event's source states and says why a step is not allowed", () => {
    expect(sourcesOf(ROLLOUT_MACHINE, "start")).toEqual(["draft"]);
    expect(sourcesOf(ROLLOUT_MACHINE, "resume")).toEqual(["paused", "halted"]);
    expect(sourcesOf(ROLLOUT_MACHINE, "abort")).toEqual(["draft", "running", "paused", "halted"]);
    expect(sourcesOf(ROLLOUT_STAGE_MACHINE, "finish")).toEqual(["active"]);
    // no event leaves a terminal state
    for (const t of Object.values(ROLLOUT_MACHINE.transitions)) for (const s of ROLLOUT_MACHINE.terminal) expect(t.from).not.toContain(s);
    const d = describeState(ROLLOUT_MACHINE, "completed");
    expect(d.terminal).toBe(true);
    expect(d.transitions.every((t) => !t.allowed && t.reason)).toBe(true);
  });
});

describe("ADR-0360: the fleet routes", () => {
  it("is admin-only", async () => {
    const s = await agentSource();
    const id = randomUUID();
    for (const [m, u] of [
      ["GET", `/v1/discovery/sources/${s}/fleet-settings`],
      ["PUT", `/v1/discovery/sources/${s}/fleet-settings`],
      ["GET", `/v1/discovery/sources/${s}/update-rollouts`],
      ["POST", `/v1/discovery/sources/${s}/update-rollouts`],
      ["GET", `/v1/discovery/update-rollouts/${id}`],
      ["POST", `/v1/discovery/update-rollouts/${id}/start`],
      ["POST", `/v1/discovery/sources/${s}/one-line-enrolments`],
    ] as const) {
      expect((await inject(m, u, memberKey, m === "GET" ? undefined : {})).statusCode, `${m} ${u}`).toBe(403);
    }
  });
});

describe("ADR-0360: self-update is off by default and a relaxation", () => {
  it("needs a step-up bound to the source to turn on, records it, and is free to turn off", async () => {
    const s = await agentSource();
    const other = await agentSource();
    expect((await inject("GET", `/v1/discovery/sources/${s}/fleet-settings`, AUTH)).json()).toMatchObject({ selfUpdate: false, strict: { selfUpdate: false } });
    // a session with no grant, and a grant bound to another source, change nothing
    const wrong = await grantStepUpForTest(db, adminId, selfUpdateRelaxStepUp(other));
    const none = await app.inject({ method: "PUT", url: `/v1/discovery/sources/${s}/fleet-settings`, ...sessionRequest(wrong), payload: { selfUpdate: true } });
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "settings_relax" });
    const mismatched = await app.inject({ method: "PUT", url: `/v1/discovery/sources/${s}/fleet-settings`, ...stepUpRequest(wrong), payload: { selfUpdate: true } });
    expect(mismatched.statusCode, mismatched.body).toBe(422);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect(await db.select().from(endpointFleetSettings).where(eq(endpointFleetSettings.sourceId, s))).toEqual([]);
    await selfUpdateOn(s);
    const [row] = await db.select().from(endpointFleetSettings).where(eq(endpointFleetSettings.sourceId, s));
    expect(row).toMatchObject({ selfUpdate: true, selfUpdateRelaxedBy: adminId });
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, row!.selfUpdateAuditId!));
    expect(a).toMatchObject({ ruleId: "endpoint-fleet-self-update-relaxed", objectId: s });
    // the CHECK: "on" only with a recorded relaxation
    await expect(db.update(endpointFleetSettings).set({ selfUpdateStepUp: null }).where(eq(endpointFleetSettings.sourceId, s))).rejects.toThrow();
    const off = await inject("PUT", `/v1/discovery/sources/${s}/fleet-settings`, AUTH, { selfUpdate: false });
    expect(off.json().selfUpdate).toBe(false);
    const [after] = await db.select().from(endpointFleetSettings).where(eq(endpointFleetSettings.sourceId, s));
    expect(after).toMatchObject({ selfUpdate: false, selfUpdateStepUp: null, selfUpdateAuditId: null });
  });
});

describe("ADR-0360: staged rollouts", () => {
  it("follows the declared lifecycle and refuses what the table does not allow", async () => {
    const s = await agentSource();
    const g1 = await group("canary");
    const g2 = await group("broad");
    const bad = await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.2.0", stages: [g1, g1] });
    expect(bad.statusCode).toBe(400);
    expect((await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.2.0", stages: [randomUUID()] })).json().error).toBe("group_not_found");
    const c = await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.2.0", stages: [g1, g2] });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().rollout.id as string;
    expect(c.json().rollout.state).toBe("draft");
    expect((await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.3.0", stages: [g1] })).json().error).toBe("rollout_open");
    // self-update off: start is blocked, and says why
    const blocked = await act(id, "start");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "transition_blocked" });
    expect(blocked.json().detail).toMatch(/self-update is off/);
    expect((await act(id, "pause")).json().error).toBe("illegal_transition");
    await selfUpdateOn(s);
    const started = await act(id, "start");
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().rollout.stages.map((x: { state: string }) => x.state)).toEqual(["active", "pending"]);
    expect((await act(id, "complete")).json().error).toBe("transition_blocked");
    expect((await act(id, "pause")).json().rollout.state).toBe("paused");
    expect((await act(id, "resume")).json().rollout.state).toBe("running");
    const adv = await act(id, "advance");
    expect(adv.json().rollout.stages.map((x: { state: string }) => x.state)).toEqual(["done", "active"]);
    expect((await act(id, "advance")).json().error).toBe("transition_blocked");
    const done = await act(id, "complete");
    expect(done.json().rollout).toMatchObject({ state: "completed" });
    expect(done.json().rollout.stages.map((x: { state: string }) => x.state)).toEqual(["done", "done"]);
    expect(done.json().rollout.lifecycle.terminal).toBe(true);
    expect((await act(id, "abort")).json().error).toBe("illegal_transition");
    expect((await act(id, "halt")).statusCode).toBe(400);
    const audited = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'rolloutId' = ${id}`);
    expect(new Set(audited.map((a) => a.ruleId))).toEqual(
      new Set(["endpoint-update-rollout-created", "endpoint-update-rollout-start", "endpoint-update-rollout-pause", "endpoint-update-rollout-resume", "endpoint-update-rollout-advance", "endpoint-update-rollout-complete"]),
    );
    // a new rollout may open once the last one is terminal
    expect((await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.3.0", stages: [g2] })).statusCode).toBe(201);
  });

  it("refuses a stale write: a state moved underneath matches no row", async () => {
    const s = await agentSource();
    const g = await group("one");
    const id = (await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "1.0.0", stages: [g] })).json().rollout.id as string;
    await db.update(endpointUpdateRollouts).set({ state: "aborted" }).where(eq(endpointUpdateRollouts.id, id));
    const r = await act(id, "abort");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("illegal_transition");
  });

  it("never blocks deleting an ADR-0350 group: the stage keeps its name as evidence and offers nothing", async () => {
    const s = await agentSource();
    const g = await group("gone");
    const c = await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "1.1.0", stages: [g] });
    expect(c.statusCode, c.body).toBe(201);
    const name = c.json().rollout.stages[0].groupName as string;
    expect(name).toMatch(/^e41-gone-/);
    // the delete is ADR-0350's (a step-up there); the foreign key is SET NULL, so a rollout never makes it fail
    await db.delete(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, g));
    const [stage] = await db.select().from(endpointUpdateRolloutStages).where(eq(endpointUpdateRolloutStages.rolloutId, c.json().rollout.id as string));
    expect(stage).toMatchObject({ groupId: null, groupName: name });
    const read = await inject("GET", `/v1/discovery/update-rollouts/${c.json().rollout.id}`, AUTH);
    expect(read.json().rollout.stages[0]).toMatchObject({ groupId: null, groupName: name });
  });
});

describe("ADR-0360: one-line enrolment", () => {
  it("issues a single-use, short-lived token that places its device in its group, and never audits the secret", async () => {
    const s = await agentSource();
    const g = await group("laptops");
    expect((await inject("POST", `/v1/discovery/sources/${s}/one-line-enrolments`, AUTH, { label: "x", deviceGroupId: randomUUID() })).json().error).toBe("group_not_found");
    expect((await inject("POST", `/v1/discovery/sources/${s}/one-line-enrolments`, AUTH, { label: "x", expiresInMinutes: 61 })).statusCode).toBe(400);
    const r = await inject("POST", `/v1/discovery/sources/${s}/one-line-enrolments`, AUTH, { label: `one-${RUN}`, deviceGroupId: g });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const { token, enrolment } = r.json() as { token: { id: string; expiresAt: string }; enrolment: { token: string; command: string } };
    expect(enrolment.command).toBe(`printf '%s\\n' '${enrolment.token}' | sudo regulait-agent enrol`);
    const minutes = (new Date(token.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThanOrEqual(15);
    const [row] = await db.select().from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, token.id));
    expect(row).toMatchObject({ singleUse: true, deviceCap: 1, deviceGroupId: g, tokenHash: hashToken(enrolment.token) });
    const first = await ticket(enrolment.token, `e41-one-${RUN}`);
    expect(first.statusCode, first.body).toBe(201);
    // the device joins the token's ADR-0350 group (which only narrows its policy)
    const m = await db.select().from(endpointDeviceGroupMembers).where(eq(endpointDeviceGroupMembers.deviceId, first.json().ticketId as string));
    expect(m.map((x) => x.groupId)).toEqual([g]);
    const second = await ticket(enrolment.token, `e41-two-${RUN}`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("enrolment_cap_reached");
    const leaked = await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.detail}::text LIKE ${"%" + enrolment.token + "%"} OR ${auditLog.reason} LIKE ${"%" + enrolment.token + "%"}`);
    expect(leaked).toEqual([]);
    // the CHECK holds a single-use token to one device and 60 minutes whatever writes the row
    await expect(db.update(endpointEnrolmentTokens).set({ deviceCap: 2 }).where(eq(endpointEnrolmentTokens.id, token.id))).rejects.toThrow();
    await expect(db.update(endpointEnrolmentTokens).set({ expiresAt: sql`created_at + interval '61 minutes'` }).where(eq(endpointEnrolmentTokens.id, token.id))).rejects.toThrow();
    // deleting the group leaves the token without one (ON DELETE SET NULL)
    await db.delete(endpointDeviceGroups).where(eq(endpointDeviceGroups.id, g));
    const [after] = await db.select({ g: endpointEnrolmentTokens.deviceGroupId }).from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, token.id));
    expect(after?.g).toBeNull();
  });
});
