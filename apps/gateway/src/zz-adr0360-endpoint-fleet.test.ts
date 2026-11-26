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
  endpointDeviceGroupFleetSettings,
  endpointUpdateRolloutStages,
  endpointUpdateRollouts,
  eq,
  inArray,
  runMigrations,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { ENDPOINT_ROLLOUT_MACHINE as ROLLOUT_MACHINE, ENDPOINT_ROLLOUT_STAGE_MACHINE as ROLLOUT_STAGE_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { haltThresholdRelaxStepUp, rolloutDecisionStepUp, selfUpdateRelaxStepUp } from "./endpoint-fleet-routes.js";
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
let admin2Id: string;
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
async function selfUpdateOn(groupId: string) {
  const g = await grantStepUpForTest(db, adminId, selfUpdateRelaxStepUp(groupId));
  const r = await app.inject({ method: "PUT", url: `/v1/endpoint-device-groups/${groupId}/fleet-settings`, ...stepUpRequest(g), payload: { selfUpdate: true } });
  expect(r.statusCode, r.body).toBe(200);
}
const settingsUrl = (groupId: string) => `/v1/endpoint-device-groups/${groupId}/fleet-settings`;
/** a rollout action by a signed-in admin (slice 1c: a person, never the bootstrap credential) */
const act = async (rolloutId: string, action: string, who?: string) => {
  const g = await grantStepUpForTest(db, who ?? adminId, haltThresholdRelaxStepUp(randomUUID(), 2));
  return app.inject({ method: "POST", url: `/v1/discovery/update-rollouts/${rolloutId}/${action}`, ...sessionRequest(g), payload: {} });
};
/** a start or resume decision by the second admin, with the step-up bound to it */
const decide = async (rolloutId: string, decision: "approve_start" | "reject_start" | "approve_resume" | "reject_resume", who?: string) => {
  const g = await grantStepUpForTest(db, who ?? admin2Id, rolloutDecisionStepUp(rolloutId, decision));
  return app.inject({ method: "POST", url: `/v1/discovery/update-rollouts/${rolloutId}/${decision}`, ...stepUpRequest(g), payload: {} });
};

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
  const a2 = await inject("POST", "/v1/users", AUTH, { email: `e41-admin2-${RUN}@example.com`, displayName: "e41 admin 2" });
  admin2Id = a2.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin2Id));
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
    // ADR-0348: registered, so GET /v1/state-machines lists them and the CHECK-equality test covers both columns
    expect(STATE_MACHINES[ROLLOUT_MACHINE.def.id]).toBe(ROLLOUT_MACHINE);
    expect(STATE_MACHINES[ROLLOUT_STAGE_MACHINE.def.id]).toBe(ROLLOUT_STAGE_MACHINE);
    expect(ROLLOUT_MACHINE.sourcesOf("request_start")).toEqual(["draft"]);
    expect(ROLLOUT_MACHINE.sourcesOf("approve_start")).toEqual(["start_requested"]);
    expect(ROLLOUT_MACHINE.sourcesOf("request_resume")).toEqual(["paused", "halted"]);
    expect(ROLLOUT_MACHINE.sourcesOf("approve_resume")).toEqual(["resume_requested"]);
    // slice 1c: the decisions are a second person's, and an undecided request expires on its own
    for (const e of ["approve_start", "reject_start", "approve_resume", "reject_resume"] as const) expect(ROLLOUT_MACHINE.def.transitions[e].by).toEqual(["approver"]);
    for (const e of ["expire_start", "expire_resume", "halt"] as const) expect(ROLLOUT_MACHINE.def.transitions[e].by).toEqual(["system"]);
    expect(ROLLOUT_MACHINE.sourcesOf("abort")).toEqual(["draft", "start_requested", "running", "paused", "halted", "resume_requested"]);
    expect(ROLLOUT_STAGE_MACHINE.sourcesOf("finish")).toEqual(["active"]);
    const d = ROLLOUT_MACHINE.describe("completed");
    expect(d.terminal).toBe(true);
    expect(d.transitions.every((t) => !t.allowed && t.reason)).toBe(true);
  });
});

describe("ADR-0360: the fleet routes", () => {
  it("is admin-only", async () => {
    const s = await agentSource();
    const g = await group("admin-only");
    const id = randomUUID();
    for (const [m, u] of [
      ["GET", settingsUrl(g)],
      ["PUT", settingsUrl(g)],
      ["PUT", `/v1/discovery/update-rollouts/${id}/halt-threshold`],
      ["GET", `/v1/discovery/sources/${s}/update-rollouts`],
      ["POST", `/v1/discovery/sources/${s}/update-rollouts`],
      ["GET", `/v1/discovery/update-rollouts/${id}`],
      ["POST", `/v1/discovery/update-rollouts/${id}/request_start`],
      ["POST", `/v1/discovery/sources/${s}/one-line-enrolments`],
    ] as const) {
      expect((await inject(m, u, memberKey, m === "GET" ? undefined : {})).statusCode, `${m} ${u}`).toBe(403);
    }
  });
});

describe("ADR-0360: self-update is per device group, off by default, and a relaxation", () => {
  it("needs a step-up bound to the group to turn on, records it, and is free to turn off", async () => {
    const g = await group("self-update");
    const other = await group("self-update-other");
    expect((await inject("GET", settingsUrl(g), AUTH)).json()).toMatchObject({ groupId: g, selfUpdate: false, strict: { selfUpdate: false } });
    expect((await inject("GET", settingsUrl(randomUUID()), AUTH)).statusCode).toBe(404);
    // a session with no grant, and a grant bound to another group, change nothing
    const wrong = await grantStepUpForTest(db, adminId, selfUpdateRelaxStepUp(other));
    const none = await app.inject({ method: "PUT", url: settingsUrl(g), ...sessionRequest(wrong), payload: { selfUpdate: true } });
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json()).toMatchObject({ error: "step_up_unavailable", actionKind: "settings_relax" });
    const mismatched = await app.inject({ method: "PUT", url: settingsUrl(g), ...stepUpRequest(wrong), payload: { selfUpdate: true } });
    expect(mismatched.statusCode, mismatched.body).toBe(422);
    expect(await grantSpent(db, wrong.grantId)).toBe(false);
    expect(await db.select().from(endpointDeviceGroupFleetSettings).where(eq(endpointDeviceGroupFleetSettings.groupId, g))).toEqual([]);
    await selfUpdateOn(g);
    const [row] = await db.select().from(endpointDeviceGroupFleetSettings).where(eq(endpointDeviceGroupFleetSettings.groupId, g));
    expect(row).toMatchObject({ selfUpdate: true, selfUpdateRelaxedBy: adminId });
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, row!.selfUpdateAuditId!));
    expect(a).toMatchObject({ ruleId: "endpoint-fleet-self-update-relaxed", objectType: "endpoint_device_group", objectId: g });
    // the other group is untouched: the setting is per group
    expect((await inject("GET", settingsUrl(other), AUTH)).json().selfUpdate).toBe(false);
    // the CHECK: "on" only with a recorded relaxation
    await expect(db.update(endpointDeviceGroupFleetSettings).set({ selfUpdateStepUp: null }).where(eq(endpointDeviceGroupFleetSettings.groupId, g))).rejects.toThrow();
    const off = await inject("PUT", settingsUrl(g), AUTH, { selfUpdate: false });
    expect(off.json().selfUpdate).toBe(false);
    const [after] = await db.select().from(endpointDeviceGroupFleetSettings).where(eq(endpointDeviceGroupFleetSettings.groupId, g));
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
    // self-update off in both stage groups: start is blocked, and names them
    const blocked = await act(id, "request_start");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "transition_blocked" });
    expect(blocked.json().detail).toMatch(/self-update is off for device groups 'e41-canary-.*', 'e41-broad-/);
    expect((await act(id, "pause")).json().error).toBe("illegal_transition");
    // on in one group only: still blocked, naming the other
    await selfUpdateOn(g1);
    const half = await act(id, "request_start");
    expect(half.json().error).toBe("transition_blocked");
    expect(half.json().detail).toMatch(/self-update is off for device group 'e41-broad-/);
    await selfUpdateOn(g2);
    const asked = await act(id, "request_start");
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().rollout).toMatchObject({ state: "start_requested", approval: { requestedBy: adminId, decidedBy: null } });
    expect(asked.json().rollout.stages.map((x: { state: string }) => x.state)).toEqual(["pending", "pending"]);
    const started = await decide(id, "approve_start");
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().rollout).toMatchObject({ state: "running", approval: { requestedBy: adminId, decidedBy: admin2Id } });
    expect(started.json().rollout.stages.map((x: { state: string }) => x.state)).toEqual(["active", "pending"]);
    expect((await act(id, "complete")).json().error).toBe("transition_blocked");
    expect((await act(id, "pause")).json().rollout.state).toBe("paused");
    expect((await act(id, "request_resume")).json().rollout.state).toBe("resume_requested");
    expect((await decide(id, "approve_resume")).json().rollout.state).toBe("running");
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
      new Set([
        "endpoint-update-rollout-created",
        "endpoint-update-rollout-request-start",
        "endpoint-update-rollout-approve-start",
        "endpoint-update-rollout-pause",
        "endpoint-update-rollout-request-resume",
        "endpoint-update-rollout-approve-resume",
        "endpoint-update-rollout-advance",
        "endpoint-update-rollout-complete",
      ]),
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

  it("pages the rollout list with the list contract's cursor, so older rollouts stay reachable", async () => {
    const s = await agentSource();
    // twelve closed rollouts, a second apart (one open rollout per source, so they are stored aborted)
    await db.insert(endpointUpdateRollouts).values(
      Array.from({ length: 12 }, (_, i) => ({ sourceId: s, targetVersion: `0.${i}.0`, state: "aborted" as const, createdAt: new Date(Date.now() - (12 - i) * 1000) })),
    );
    const first = await inject("GET", `/v1/discovery/sources/${s}/update-rollouts?limit=10`, AUTH);
    expect(first.statusCode, first.body).toBe(200);
    const p1 = first.json() as { items: Array<{ targetVersion: string; lifecycle: { terminal: boolean } }>; nextCursor: string | null };
    expect(p1.items.map((r) => r.targetVersion)).toEqual(Array.from({ length: 10 }, (_, i) => `0.${11 - i}.0`));
    expect(p1.items.every((r) => r.lifecycle.terminal)).toBe(true);
    expect(p1.nextCursor).toBeTruthy();
    const second = await inject("GET", `/v1/discovery/sources/${s}/update-rollouts?limit=10&cursor=${encodeURIComponent(p1.nextCursor!)}`, AUTH);
    const p2 = second.json() as { items: Array<{ targetVersion: string }>; nextCursor: string | null };
    expect(p2.items.map((r) => r.targetVersion)).toEqual(["0.1.0", "0.0.0"]);
    expect(p2.nextCursor).toBeNull();
    // another source's rollouts are not in this list
    const other = await inject("GET", `/v1/discovery/sources/${await agentSource()}/update-rollouts`, AUTH);
    expect(other.json().items).toEqual([]);
  });

  it("keeps a bounded halt threshold: strict by default, free to tighten, a step-up to loosen, capped, audited", async () => {
    const s = await agentSource();
    const g = await group("halt");
    const c = await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "2.0.0", stages: [g] });
    const id = c.json().rollout.id as string;
    expect(c.json().rollout.haltThreshold).toEqual({ value: 1, strict: 1, min: 1, max: 10 });
    const url = `/v1/discovery/update-rollouts/${id}/halt-threshold`;
    // outside the bounds is refused before anything else
    for (const v of [0, 11, 2.5]) expect((await inject("PUT", url, AUTH, { haltThreshold: v })).statusCode, String(v)).toBe(400);
    // loosening needs a step-up bound to this rollout and this value
    // (an admin session; the bootstrap credential passes a step-up only during first-admin setup, B4S-06)
    const wrongValue = await grantStepUpForTest(db, adminId, haltThresholdRelaxStepUp(id, 4));
    const noGrant = await app.inject({ method: "PUT", url, ...sessionRequest(wrongValue), payload: { haltThreshold: 5 } });
    expect(noGrant.statusCode, noGrant.body).toBe(422);
    expect((await app.inject({ method: "PUT", url, ...stepUpRequest(wrongValue), payload: { haltThreshold: 5 } })).statusCode).toBe(422);
    const ok = await grantStepUpForTest(db, adminId, haltThresholdRelaxStepUp(id, 5));
    const loosened = await app.inject({ method: "PUT", url, ...stepUpRequest(ok), payload: { haltThreshold: 5 } });
    expect(loosened.statusCode, loosened.body).toBe(200);
    expect(loosened.json().rollout.haltThreshold.value).toBe(5);
    const [row] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    expect(row).toMatchObject({ haltThreshold: 5 });
    const [a] = await db.select().from(auditLog).where(eq(auditLog.id, row!.haltThresholdAuditId!));
    expect(a).toMatchObject({ ruleId: "endpoint-update-rollout-halt-threshold-relaxed" });
    expect(a!.detail).toMatchObject({ from: 1, to: 5, relaxation: true });
    // tightening needs no step-up, keeps the loosening's evidence while above the default, and clears it at the default
    const tighter = await inject("PUT", url, AUTH, { haltThreshold: 3 });
    expect(tighter.statusCode, tighter.body).toBe(200);
    const [mid] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    expect(mid).toMatchObject({ haltThreshold: 3, haltThresholdAuditId: row!.haltThresholdAuditId });
    expect((await inject("PUT", url, AUTH, { haltThreshold: 1 })).statusCode).toBe(200);
    const [strict] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    expect(strict).toMatchObject({ haltThreshold: 1, haltThresholdStepUp: null, haltThresholdAuditId: null });
    // the CHECKs: never past the cap, and never above the default without a recorded relaxation
    await expect(db.update(endpointUpdateRollouts).set({ haltThreshold: 11 }).where(eq(endpointUpdateRollouts.id, id))).rejects.toThrow();
    await expect(db.update(endpointUpdateRollouts).set({ haltThreshold: 2 }).where(eq(endpointUpdateRollouts.id, id))).rejects.toThrow();
    const audited = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'rolloutId' = ${id}`);
    expect(audited.filter((x) => x.ruleId === "endpoint-update-rollout-halt-threshold-tightened")).toHaveLength(2);
    // a closed rollout's threshold no longer applies
    expect((await act(id, "abort")).statusCode).toBe(200);
    expect((await inject("PUT", url, AUTH, { haltThreshold: 1 })).json().error).toBe("rollout_closed");
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
    // the redemption policy admits only that row: under public_ingest, the same device into another group is refused
    const other = await group("not-the-token's");
    const forged = await runWithRlsSystem("public_ingest", "test.e41-forged-membership", async () =>
      db.insert(endpointDeviceGroupMembers).values({ deviceId: first.json().ticketId as string, groupId: other }).then(
        () => "inserted",
        (e: { message?: string; cause?: { message?: string } }) => e.cause?.message ?? e.message ?? String(e),
      ),
    );
    expect(forged).toMatch(/row-level security/);
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

describe("ADR-0360 slice 1c: a start or resume is decided by two signed-in people", () => {
  it("refuses the bootstrap credential, the requester deciding, and a write that skips the requester", async () => {
    const s = await agentSource();
    const g = await group("two-people");
    await selfUpdateOn(g);
    const id = (await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "2.0.0", stages: [g] })).json().rollout.id as string;
    // no person behind the bootstrap credential: nothing to compare a decider with
    const boot = await inject("POST", `/v1/discovery/update-rollouts/${id}/request_start`, AUTH, {});
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("user_required");
    expect((await act(id, "request_start")).json().rollout.state).toBe("start_requested");
    // the requester cannot approve, even with a step-up bound to the decision; nothing moves
    const self = await decide(id, "approve_start", adminId);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe("caller_cannot_decide");
    // a step-up for the other decision is refused
    const g2 = await grantStepUpForTest(db, admin2Id, rolloutDecisionStepUp(id, "reject_start"));
    expect((await app.inject({ method: "POST", url: `/v1/discovery/update-rollouts/${id}/approve_start`, ...stepUpRequest(g2), payload: {} })).statusCode).toBe(422);
    const [still] = await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id));
    expect(still).toMatchObject({ state: "start_requested", approvalRequestedBy: adminId, approvalDecidedBy: null });
    // the CHECKs: the decider is never the requester; a waiting rollout names its requester
    await expect(db.update(endpointUpdateRollouts).set({ approvalDecidedBy: adminId }).where(eq(endpointUpdateRollouts.id, id))).rejects.toThrow();
    await expect(db.update(endpointUpdateRollouts).set({ approvalRequestedBy: null }).where(eq(endpointUpdateRollouts.id, id))).rejects.toThrow();
    // the second admin rejects: back to draft, nothing was offered
    const rej = await decide(id, "reject_start");
    expect(rej.statusCode, rej.body).toBe(200);
    expect(rej.json().rollout).toMatchObject({ state: "draft", approval: { requestedBy: adminId, decidedBy: admin2Id } });
    expect(rej.json().rollout.stages[0].state).toBe("pending");
    expect((await act(id, "abort")).statusCode).toBe(200);
  });

  it("expires a start or resume nobody decides, back to where it was asked from", async () => {
    const { expireEndpointUpdates } = await import("./endpoint-update-delivery.js");
    const s = await agentSource();
    const g = await group("expiry");
    await selfUpdateOn(g);
    const id = (await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "2.1.0", stages: [g] })).json().rollout.id as string;
    expect((await act(id, "request_start")).statusCode).toBe(200);
    // a fresh request is left alone
    await runWithRlsSystem("system_task", "test", () => expireEndpointUpdates(db));
    expect((await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)))[0]!.state).toBe("start_requested");
    await db.update(endpointUpdateRollouts).set({ approvalRequestedAt: sql`now() - interval '25 hours'` }).where(eq(endpointUpdateRollouts.id, id));
    await runWithRlsSystem("system_task", "test", () => expireEndpointUpdates(db));
    expect((await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)))[0]!.state).toBe("draft");
    // resume: running → paused → resume_requested → (expired) paused
    expect((await act(id, "request_start")).statusCode).toBe(200);
    expect((await decide(id, "approve_start")).statusCode).toBe(200);
    expect((await act(id, "pause")).statusCode).toBe(200);
    expect((await act(id, "request_resume")).json().rollout.state).toBe("resume_requested");
    await db.update(endpointUpdateRollouts).set({ approvalRequestedAt: sql`now() - interval '25 hours'` }).where(eq(endpointUpdateRollouts.id, id));
    await runWithRlsSystem("system_task", "test", () => expireEndpointUpdates(db));
    expect((await db.select().from(endpointUpdateRollouts).where(eq(endpointUpdateRollouts.id, id)))[0]!.state).toBe("paused");
    const rules = (await db.select({ r: auditLog.ruleId }).from(auditLog).where(sql`${auditLog.detail}->>'rolloutId' = ${id}`)).map((x) => x.r);
    expect(rules).toEqual(expect.arrayContaining(["endpoint-update-rollout-expire-start", "endpoint-update-rollout-expire-resume"]));
    expect((await act(id, "abort")).statusCode).toBe(200);
  });
});
