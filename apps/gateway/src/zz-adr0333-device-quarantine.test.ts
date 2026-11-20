/**
 * ADR-0333 §6 (slice 3) — device quarantine as a detection response.
 *
 * Endpoint hook decisions group by device; a `quarantine_device` rule opens one active quarantine per device; it ends
 * once, released by a stepped-up human admin or expired by the sweep; both ends are widening, so both wait for the
 * `normal` execution dial (ADR-0338 §7), while opening one runs under any dial.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  createDb,
  detectionIncidents,
  detectionRulePacks,
  discoverySources,
  endpointDeviceQuarantines,
  endpointDevices,
  endpointEnrolmentTokens,
  eq,
  orgSettings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { EXECUTION_MODES } from "@regulait/policy-kernel";
import { KILL_SWITCH_DIALS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack } from "./detection/pack.js";
import { DETECTION_RESPONSE_RULE_ID } from "./detection/responses.js";
import { QUARANTINE_RULE_IDS } from "./detection/quarantine.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0333q-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const NIL = "00000000-0000-0000-0000-000000000000";
const hex = (s: string, n: number) => createHash("sha256").update(`${s}-${RUN}`).digest("hex").slice(0, n);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let sourceId: string;
let tokenId: string;
const devices: string[] = [];
const restores: Array<() => Promise<void>> = [];

async function mkDevice(label: string): Promise<string> {
  const [dev] = await db
    .insert(endpointDevices)
    .values({ sourceId, tokenId, devicePseudonym: `psn:${hex(label, 24)}`, os: "linux", arch: "amd64", agentVersion: "1.0.0", ticketHash: hex(`t-${label}`, 64), ticketExpiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointDevices.id });
  devices.push(dev!.id);
  return dev!.id;
}

/** one endpoint hook deny, exactly as endpoint-decisions.ts audits it (nil user, the device as the object) */
async function hookDeny(deviceId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({ id, userId: NIL, objectType: "endpoint_device", objectId: deviceId, detail: { subsystem: "endpoint-decision-audit" }, effect: "deny", ruleId: "endpoint-command-deny", ruleChain: [], reason: "t" });
  return id;
}

const QUARANTINE_RULE = {
  id: "endpoint-hook-deny",
  title: "An endpoint hook denied a call",
  severity: "high",
  enabled: true,
  type: "single",
  selector: { objectType: ["endpoint_device"], effect: ["deny"] },
  response: "quarantine_device",
  quarantineHours: 2,
} as const;

/** store the default pack plus the quarantine rule, through the stepped-up route */
async function storeQuarantinePack(extra: Record<string, unknown> = {}): Promise<number> {
  const current = await loadActiveDetectionPack(db);
  const next = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: [...DEFAULT_DETECTION_PACK.rules, { ...QUARANTINE_RULE, ...extra }] });
  const facts = { detection: "rule-pack", fromDigest: current.digest, toDigest: packDigest(next) };
  const req = stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
  const res = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...req, payload: { pack: next, expectedVersion: current.version } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().version as number;
}

const incidentOf = async (trigger: string) => (await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger)))[0];
const quarantinesOf = (deviceId: string) => db.select().from(endpointDeviceQuarantines).where(eq(endpointDeviceQuarantines.deviceId, deviceId));
const setDial = (mode: string) =>
  db.update(orgSettings).set({
    executionMode: mode,
    executionModeReason: mode === "normal" ? null : "adr0333q — the kill-switch guard under test",
    executionModeApproverUserId: mode === "require_approval" ? adminId : null,
  } as never);

const release = async (quarantineId: string, stepUp: boolean) => {
  const req = stepUp
    ? stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { detection: "device-quarantine-release", quarantineId } } as StepUpCheckArgs))
    : { headers: AUTH };
  return app.inject({ method: "POST", url: `/v1/detection/quarantines/${quarantineId}/release`, ...req, payload: {} });
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333q-admin-${RUN}@example.com`, displayName: "admin", isAdmin: true } });
  expect(r.statusCode, r.body).toBe(201);
  adminId = r.json().id as string;
  const [src] = await db
    .insert(discoverySources)
    .values({ name: `adr0333q-${RUN}`, kind: "endpoint_agent", target: {}, scope: { orgLevel: true, include: [] }, createdBy: adminId } as never)
    .returning({ id: discoverySources.id });
  sourceId = src!.id;
  const [tok] = await db
    .insert(endpointEnrolmentTokens)
    .values({ sourceId, label: "adr0333q", tokenHash: hex("tok", 64), deviceCap: 10, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: endpointEnrolmentTokens.id });
  tokenId = tok!.id;
  restores.push(async () => void (await setDial("normal")));
  await setDial("normal");
  await db.delete(endpointDeviceQuarantines);
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await runDetectionSweep(db, adminId);
  await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = (SELECT max(seq) FROM audit_log), replay_cursor_seq = replay_until_seq, lease_until = NULL, lease_token = NULL`);
});

afterAll(async () => {
  if (!db) return;
  await db.delete(endpointDeviceQuarantines);
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await db.delete(discoverySources).where(eq(discoverySources.id, sourceId));
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0333 §6 grouping and the pack", () => {
  it("the guard's dial list equals the kernel's execution modes", () => {
    expect([...KILL_SWITCH_DIALS]).toEqual([...EXECUTION_MODES]);
  });

  it("quarantineHours is refused on any other response", () => {
    expect(() => parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: [...DEFAULT_DETECTION_PACK.rules, { ...QUARANTINE_RULE, response: "alert" }] })).toThrow(/quarantineHours/);
  });

  it("endpoint hook decisions group by device, never into one shared user group", async () => {
    await storeQuarantinePack();
    const [a, b] = [await mkDevice("group-a"), await mkDevice("group-b")];
    const [ta, tb] = [await hookDeny(a), await hookDeny(b)];
    await runDetectionSweep(db, adminId);
    expect((await incidentOf(ta))?.groupKey).toBe(`endpoint:${a}`);
    expect((await incidentOf(tb))?.groupKey).toBe(`endpoint:${b}`);
    expect(await quarantinesOf(a)).toHaveLength(1);
    expect(await quarantinesOf(b)).toHaveLength(1);
  });
});

describe("ADR-0333 §6 quarantine_device", () => {
  it("opens one active quarantine for the rule's hours, audited; a second incident keeps it", async () => {
    await storeQuarantinePack();
    const device = await mkDevice("open");
    const first = await hookDeny(device);
    await runDetectionSweep(db, adminId);
    const incident = await incidentOf(first);
    expect(incident).toMatchObject({ response: "quarantine_device", responseState: "done", responseErrorCode: null });
    const [q] = await quarantinesOf(device);
    expect(q).toMatchObject({ status: "active", incidentId: incident!.id, endedAt: null, releasedBy: null });
    const hours = (q!.expiresAt.getTime() - q!.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(2, 3);
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(audited).toMatchObject({ effect: "deny" });
    expect(audited!.detail).toMatchObject({ outcome: "done", quarantineId: q!.id, deviceId: device, existing: false });

    const second = await hookDeny(device);
    await runDetectionSweep(db, adminId);
    expect(await incidentOf(second)).toMatchObject({ responseState: "done" });
    expect(await quarantinesOf(device)).toHaveLength(1);
    const [again] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, (await incidentOf(second))!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(again!.detail).toMatchObject({ quarantineId: q!.id, existing: true });
  });

  it("a quarantine_device rule on a non-endpoint group fails not_endpoint and quarantines nothing", async () => {
    await storeQuarantinePack({ selector: { objectType: ["mcp_tool"], ruleId: ["adr0333q-user-call"] } });
    const trigger = randomUUID();
    await db.insert(auditLog).values({ id: trigger, userId: adminId, objectType: "mcp_tool", toolName: "noop", effect: "allow", ruleId: "adr0333q-user-call", ruleChain: [], reason: "t" });
    await runDetectionSweep(db, adminId);
    expect(await incidentOf(trigger)).toMatchObject({ groupKey: `user:${adminId}`, responseState: "failed", responseErrorCode: "not_endpoint" });
  });

  it("a revoked device fails device_not_found", async () => {
    await storeQuarantinePack();
    const device = await mkDevice("revoked");
    await db.update(endpointDevices).set({ revokedAt: sql`now()` }).where(eq(endpointDevices.id, device));
    const trigger = await hookDeny(device);
    await runDetectionSweep(db, adminId);
    expect(await incidentOf(trigger)).toMatchObject({ responseState: "failed", responseErrorCode: "device_not_found" });
    expect(await quarantinesOf(device)).toHaveLength(0);
  });

  it("opening is narrowing: it runs while the dial is halted", async () => {
    await storeQuarantinePack();
    const device = await mkDevice("halted-open");
    await setDial("halted");
    try {
      await hookDeny(device);
      await runDetectionSweep(db, adminId);
      expect(await quarantinesOf(device)).toMatchObject([{ status: "active" }]);
    } finally {
      await setDial("normal");
    }
  });
});

describe("ADR-0333 §6 release and expiry", () => {
  async function activeQuarantine(label: string): Promise<{ deviceId: string; quarantineId: string }> {
    await storeQuarantinePack();
    const deviceId = await mkDevice(label);
    await hookDeny(deviceId);
    await runDetectionSweep(db, adminId);
    const [q] = await quarantinesOf(deviceId);
    expect(q?.status).toBe("active");
    return { deviceId, quarantineId: q!.id };
  }

  it("release needs a settings_relax step-up bound to the quarantine; it is audited and happens once", async () => {
    const { deviceId, quarantineId } = await activeQuarantine("release");
    const refused = await release(quarantineId, false);
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect((await quarantinesOf(deviceId))[0]?.status).toBe("active");

    const ok = await release(quarantineId, true);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().quarantine).toMatchObject({ status: "released", releasedBy: adminId, deviceEnforcement: "not_delivered" });
    expect(ok.json().quarantine.lifecycle).toMatchObject({ state: "released", terminal: true });
    const [row] = await quarantinesOf(deviceId);
    expect(row).toMatchObject({ status: "released", releasedBy: adminId });
    expect(row!.releaseStepUp).toMatch(/^[a-z_]+$/);
    expect(row!.endedAt).not.toBeNull();
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectId, deviceId), eq(auditLog.ruleId, QUARANTINE_RULE_IDS.released)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: adminId, effect: "allow" });

    const twice = await release(quarantineId, true);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("quarantine_not_active");
  });

  it("release is widening: refused unless the dial is normal, and the quarantine stays active", async () => {
    const { deviceId, quarantineId } = await activeQuarantine("release-halted");
    for (const dial of ["halted", "read_only", "require_approval"]) {
      await setDial(dial);
      try {
        const res = await release(quarantineId, true);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toBe("execution_dial_not_normal");
      } finally {
        await setDial("normal");
      }
    }
    expect((await quarantinesOf(deviceId))[0]?.status).toBe("active");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.objectId, deviceId), eq(auditLog.ruleId, QUARANTINE_RULE_IDS.released)))).toHaveLength(0);
  });

  it("expiry ends a quarantine past its time under normal, and waits while the dial is halted", async () => {
    const { deviceId, quarantineId } = await activeQuarantine("expire");
    await db
      .update(endpointDeviceQuarantines)
      .set({ createdAt: sql`now() - interval '3 hours'`, expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(endpointDeviceQuarantines.id, quarantineId));
    await setDial("halted");
    try {
      const held = await runDetectionSweep(db, adminId);
      expect(held.quarantinesExpired).toBe(0);
      expect((await quarantinesOf(deviceId))[0]?.status).toBe("active");
    } finally {
      await setDial("normal");
    }
    const out = await runDetectionSweep(db, adminId);
    expect(out.quarantinesExpired).toBeGreaterThanOrEqual(1);
    const [row] = await quarantinesOf(deviceId);
    expect(row).toMatchObject({ status: "expired", releasedBy: null, releaseStepUp: null });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.objectId, deviceId), eq(auditLog.ruleId, QUARANTINE_RULE_IDS.expired)));
    expect(audits).toHaveLength(1);
    // an expired quarantine cannot then be released
    expect((await release(quarantineId, true)).statusCode).toBe(409);
  });

  it("the list and read routes page quarantines and describe what may happen next", async () => {
    const { quarantineId } = await activeQuarantine("list");
    const one = await app.inject({ method: "GET", url: `/v1/detection/quarantines/${quarantineId}`, headers: AUTH });
    expect(one.statusCode, one.body).toBe(200);
    const release = one.json().quarantine.lifecycle.transitions.find((t: { event: string }) => t.event === "release");
    expect(release).toMatchObject({ allowed: true });
    const page = await app.inject({ method: "GET", url: "/v1/detection/quarantines?status=active&limit=1", headers: AUTH });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().quarantines).toHaveLength(1);
    const next = page.json().next as string | null;
    if (next) {
      const more = await app.inject({ method: "GET", url: `/v1/detection/quarantines?status=active&limit=1&before=${encodeURIComponent(next)}`, headers: AUTH });
      expect(more.statusCode).toBe(200);
      expect(more.json().quarantines[0]?.id).not.toBe(page.json().quarantines[0].id);
    }
    expect((await app.inject({ method: "GET", url: `/v1/detection/quarantines/${randomUUID()}`, headers: AUTH })).statusCode).toBe(404);
  });

  it("RLS is enabled and forced on the quarantine table", async () => {
    const res = (await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'endpoint_device_quarantines'`)) as unknown as { rows: Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }> };
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
