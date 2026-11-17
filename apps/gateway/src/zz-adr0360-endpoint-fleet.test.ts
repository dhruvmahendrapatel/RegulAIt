/**
 * ADR-0360 slice 1a — endpoint agent fleet operations, end to end (real database).
 *
 *  - every route is admin-only;
 *  - device groups: per-source names, a device is in at most one group (adding moves it), only live devices of the
 *    group's own source, a group a rollout names is kept;
 *  - self-update is off by default; turning it on is a `settings_relax` step-up bound to the source (a missing or
 *    mismatched grant is refused and nothing changes), recorded on the row and audited; the CHECK refuses "on" without
 *    a recorded relaxation; turning it off is free;
 *  - rollouts follow the declared lifecycle: start and resume are refused while self-update is off, stages move
 *    pending → active → done, an illegal or stale event is refused (409) and changes nothing, one open rollout per
 *    source;
 *  - one-line enrolment: one device, 15 minutes by default and at most 60 (also the CHECK), the device joins the
 *    token's group, a second redemption is refused, and the secret is in no audit row.
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
  endpointEnrolmentTokens,
  endpointFleetSettings,
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
async function group(sourceId: string, name: string) {
  const r = await inject("POST", `/v1/discovery/sources/${sourceId}/device-groups`, AUTH, { name });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().group.id as string;
}
async function device(sourceId: string, host: string) {
  const t = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `e41-${RUN}`, deviceCap: 1 });
  expect(t.statusCode, t.body).toBe(201);
  const r = await ticket(t.json().enrolFile.token as string, host);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().ticketId as string;
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
    // rollouts first: a stage's group is ON DELETE RESTRICT
    await db.delete(endpointUpdateRollouts).where(inArray(endpointUpdateRollouts.sourceId, sourceIds));
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
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

describe("ADR-0360: device groups", () => {
  it("is admin-only", async () => {
    const s = await agentSource();
    const id = randomUUID();
    for (const [m, u] of [
      ["GET", `/v1/discovery/sources/${s}/device-groups`],
      ["POST", `/v1/discovery/sources/${s}/device-groups`],
      ["DELETE", `/v1/discovery/device-groups/${id}`],
      ["GET", `/v1/discovery/device-groups/${id}/members`],
      ["POST", `/v1/discovery/device-groups/${id}/members`],
      ["GET", `/v1/discovery/sources/${s}/fleet-settings`],
      ["PUT", `/v1/discovery/sources/${s}/fleet-settings`],
      ["GET", `/v1/discovery/sources/${s}/update-rollouts`],
      ["POST", `/v1/discovery/sources/${s}/update-rollouts`],
      ["GET", `/v1/discovery/update-rollouts/${id}`],
      ["POST", `/v1/discovery/update-rollouts/${id}/start`],
      ["POST", `/v1/discovery/sources/${s}/one-line-enrolments`],
    ] as const) {
      expect((await inject(m, u, memberKey, m === "GET" || m === "DELETE" ? undefined : {})).statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it("keeps a device in one group of its own source, and moves it on a second add", async () => {
    const s = await agentSource();
    const other = await agentSource();
    const ring0 = await group(s, "ring-0");
    const ring1 = await group(s, "ring-1");
    const foreign = await group(other, "ring-0");
    expect((await inject("POST", `/v1/discovery/sources/${s}/device-groups`, AUTH, { name: "ring-0" })).json().error).toBe("group_name_taken");
    const d1 = await device(s, `e41-h1-${RUN}`);
    const d2 = await device(s, `e41-h2-${RUN}`);
    const add = await inject("POST", `/v1/discovery/device-groups/${ring0}/members`, AUTH, { add: [d1, d2] });
    expect(add.statusCode, add.body).toBe(200);
    expect((await inject("POST", `/v1/discovery/device-groups/${foreign}/members`, AUTH, { add: [d1] })).json().error).toBe("device_not_in_source");
    expect((await inject("POST", `/v1/discovery/device-groups/${ring1}/members`, AUTH, { add: [d1] })).statusCode).toBe(200);
    const rows = await db.select().from(endpointDeviceGroupMembers).where(inArray(endpointDeviceGroupMembers.deviceId, [d1, d2]));
    expect(Object.fromEntries(rows.map((r) => [r.deviceId, r.groupId]))).toEqual({ [d1]: ring1, [d2]: ring0 });
    const list = await inject("GET", `/v1/discovery/sources/${s}/device-groups`, AUTH);
    expect(list.json().groups.map((g: { name: string; members: number }) => [g.name, g.members])).toEqual([
      ["ring-0", 1],
      ["ring-1", 1],
    ]);
    const members = await inject("GET", `/v1/discovery/device-groups/${ring0}/members`, AUTH);
    expect(members.json().members.map((m: { deviceId: string }) => m.deviceId)).toEqual([d2]);
    expect(JSON.stringify(members.json())).not.toContain(`e41-h2-${RUN}`);
    const rm = await inject("POST", `/v1/discovery/device-groups/${ring0}/members`, AUTH, { remove: [d2] });
    expect(rm.json()).toEqual({ added: 0, removed: 1 });
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
    const g1 = await group(s, "canary");
    const g2 = await group(s, "broad");
    const bad = await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.2.0", stages: [g1, g1] });
    expect(bad.statusCode).toBe(400);
    const foreign = await group(await agentSource(), "x");
    expect((await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "0.2.0", stages: [foreign] })).json().error).toBe("group_not_in_source");
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
    // a group a rollout names is kept
    expect((await inject("DELETE", `/v1/discovery/device-groups/${g1}`, AUTH)).json().error).toBe("group_in_rollout");
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
    const g = await group(s, "one");
    const id = (await inject("POST", `/v1/discovery/sources/${s}/update-rollouts`, AUTH, { targetVersion: "1.0.0", stages: [g] })).json().rollout.id as string;
    await db.update(endpointUpdateRollouts).set({ state: "aborted" }).where(eq(endpointUpdateRollouts.id, id));
    const r = await act(id, "abort");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("illegal_transition");
  });
});

describe("ADR-0360: one-line enrolment", () => {
  it("issues a single-use, short-lived token that places its device in its group, and never audits the secret", async () => {
    const s = await agentSource();
    const g = await group(s, "laptops");
    const foreign = await group(await agentSource(), "laptops");
    expect((await inject("POST", `/v1/discovery/sources/${s}/one-line-enrolments`, AUTH, { label: "x", deviceGroupId: foreign })).json().error).toBe("group_not_in_source");
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
    const [m] = await db.select().from(endpointDeviceGroupMembers).where(eq(endpointDeviceGroupMembers.deviceId, first.json().ticketId as string));
    expect(m?.groupId).toBe(g);
    const second = await ticket(enrolment.token, `e41-two-${RUN}`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("enrolment_cap_reached");
    const leaked = await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.detail}::text LIKE ${"%" + enrolment.token + "%"} OR ${auditLog.reason} LIKE ${"%" + enrolment.token + "%"}`);
    expect(leaked).toEqual([]);
    // the CHECK holds a single-use token to one device and 60 minutes whatever writes the row
    await expect(db.update(endpointEnrolmentTokens).set({ deviceCap: 2 }).where(eq(endpointEnrolmentTokens.id, token.id))).rejects.toThrow();
    await expect(db.update(endpointEnrolmentTokens).set({ expiresAt: sql`created_at + interval '61 minutes'` }).where(eq(endpointEnrolmentTokens.id, token.id))).rejects.toThrow();
    // the composite FK: a token's group is in its own source
    await expect(db.update(endpointEnrolmentTokens).set({ deviceGroupId: foreign }).where(eq(endpointEnrolmentTokens.id, token.id))).rejects.toThrow();
  });
});
