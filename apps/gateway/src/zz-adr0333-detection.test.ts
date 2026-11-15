/**
 * ADR-0333 — the detection sweep against a real Postgres: incidents with their evidence chain, one audit row per
 * incident (which the ADR-0303 SIEM sweep then delivers), idempotence, the lease, the signed rule pack (verify on
 * every sweep, fall back to the built-in pack when it does not verify), step-up on relaxation and the incident API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  createDb,
  desc,
  detectionEngineState,
  detectionIncidentEvidence,
  detectionIncidents,
  detectionRulePacks,
  eq,
  builderAgentSkills,
  builderAgents,
  builderSkills,
  mcpServers,
  runAuditV2Cutover,
  runMigrations,
  runWithAuditActor,
  sql,
  type Db,
} from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { DETECTION_RULE_IDS, loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack } from "./detection/pack.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0333-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
const restores: Array<() => Promise<void>> = [];

async function call(toolName: string, over: Partial<typeof auditLog.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({
    id,
    userId: adminId,
    objectType: "mcp_tool",
    toolName,
    effect: "allow",
    ruleId: "allow-list",
    ruleChain: [],
    reason: "test",
    ...over,
  });
  return id;
}
/** move the engine's cursor to the chain head, so each test reads only its own rows */
async function toHead(): Promise<void> {
  await runDetectionSweep(db, adminId);
  // the replay of the shared database's history is not under test here: mark it complete
  await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = (SELECT max(seq) FROM audit_log), replay_cursor_seq = replay_until_seq, lease_until = NULL, lease_token = NULL`);
}
const incidentsFor = (auditId: string) => db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, auditId));
const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) =>
  stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333-admin-${RUN}@example.com`, displayName: "detection admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0333" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  // start from the built-in pack: earlier runs of this file may have stored versions
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
});

afterAll(async () => {
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0333 sweep: incidents with evidence, exported through the audit chain", () => {
  it("raises secret-read-then-egress once, with both rows as evidence and one chained audit row", async () => {
    await toHead();
    const read = await call("vault_get_secret");
    const send = await call("http_fetch");
    const out = await runDetectionSweep(db, adminId);
    expect(out.outcome).toBe("evaluated");
    const [incident] = await incidentsFor(send);
    expect(incident).toMatchObject({ ruleId: "secret-read-then-egress", severity: "high", groupKey: `user:${adminId}`, userId: adminId, status: "open", response: "alert", packVersion: null });
    const evidence = await db.select().from(detectionIncidentEvidence).where(eq(detectionIncidentEvidence.incidentId, incident!.id));
    expect(evidence.sort((a, b) => a.stepIndex - b.stepIndex).map((e) => e.auditId)).toEqual([read, send]);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "detection_incident"), eq(auditLog.objectId, incident!.id)));
    expect(row).toMatchObject({ ruleId: "detection:secret-read-then-egress", effect: "allow" });
    expect(row!.seq).not.toBeNull(); // chained, so the ADR-0303 sweep delivers it
    // a second sweep over the same rows raises nothing more, and never evaluates its own audit row
    await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = cursor_seq - 3`);
    await runDetectionSweep(db, adminId);
    expect(await incidentsFor(send)).toHaveLength(1);
  });

  it("groups by delegation tree, and nulls foreign keys that do not resolve (scratch database, audit v2)", async () => {
    // Actor columns can be written only after the audit v2 cutover, which must not run on the shared database.
    const admin = createDb(DATABASE_URL);
    const name = `adr0333_v2_${process.pid}_${RUN}`;
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
    const u = new URL(DATABASE_URL);
    u.pathname = `/${name}`;
    const sdb = createDb(u.toString());
    try {
      await runMigrations(sdb, migrationsFolder);
      await runAuditV2Cutover(sdb, { setBy: null });
      await runDetectionSweep(sdb, null); // starts the cursor at the head
      const sponsor = randomUUID();
      const identity = randomUUID();
      const grant = randomUUID();
      const write = (toolName: string) =>
        sdb.insert(auditLog).values({ userId: sponsor, objectType: "mcp_tool", toolName, effect: "allow", ruleId: "allow-list", ruleChain: [], reason: "t" }).returning({ id: auditLog.id });
      const stamp = { actorIdentityId: identity, delegationGrantId: grant, actorChain: [identity] };
      await runWithAuditActor(stamp, () => write("read_env"));
      await write("http_fetch"); // the sponsor's own call: another group, so no match across
      const [send] = await runWithAuditActor(stamp, () => write("http_post"));
      await runDetectionSweep(sdb, null);
      const incidents = await sdb.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, send!.id));
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({ groupKey: `grant:${grant}`, userId: null, delegationGrantId: null, actorIdentityId: null, actorChain: [identity] });
    } finally {
      await dropScratchDatabase(admin, name);
    }
  });

  it("raises high-risk-addon-call from the server's admission severity, and denied-call-burst at the threshold", async () => {
    await toHead();
    const [server] = await db.insert(mcpServers).values({ name: `adr0333-${randomUUID()}`, url: "http://127.0.0.1:9/", admissionSeverity: "critical" }).returning({ id: mcpServers.id });
    const risky = await call("noop", { serverId: server!.id });
    const denies: string[] = [];
    for (let i = 0; i < 11; i++) denies.push(await call("noop", { effect: "deny", ruleId: "default-deny" }));
    await runDetectionSweep(db, adminId);
    expect((await incidentsFor(risky)).map((i) => i.ruleId)).toEqual(["high-risk-addon-call"]);
    expect((await incidentsFor(denies[9]!)).map((i) => i.ruleId)).toEqual(["denied-call-burst"]);
    expect(await incidentsFor(denies[10]!)).toHaveLength(0);
    await db.delete(mcpServers).where(eq(mcpServers.id, server!.id));
  });

  it("D1: high-risk-addon-call also fires on a builder agent carrying a High or Critical skill", async () => {
    await toHead();
    const [agent] = await db.insert(builderAgents).values({ name: `adr0333-${RUN}`, ownerUserId: adminId, connectionFormat: "shared" }).returning({ id: builderAgents.id });
    const [skill] = await db.insert(builderSkills).values({ name: `adr0333-${RUN}`, ownerUserId: adminId, admissionSeverity: "high" }).returning({ id: builderSkills.id });
    await db.insert(builderAgentSkills).values({ agentId: agent!.id, skillId: skill!.id });
    try {
      const viaAgent = await call("noop", { objectType: "connector", detail: { builderAgentId: agent!.id } });
      const malformed = await call("noop", { detail: { builderAgentId: "not-a-uuid" } });
      await runDetectionSweep(db, adminId);
      expect((await incidentsFor(viaAgent)).map((i) => i.ruleId)).toEqual(["high-risk-addon-call"]);
      expect(await incidentsFor(malformed)).toHaveLength(0);
    } finally {
      await db.delete(builderAgents).where(eq(builderAgents.id, agent!.id));
      await db.delete(builderSkills).where(eq(builderSkills.id, skill!.id));
    }
  });

  it("D2: the first-run replay covers retained history in checkpointed batches, marks incidents historical, and resumes", async () => {
    await toHead();
    const first = await call("vault_get_secret");
    const replayTrigger = await call("http_fetch");
    // pretend the engine first ran now: history ends here, the live cursor starts here
    await db.execute(sql`UPDATE detection_engine_state SET
      replay_cursor_seq = (SELECT seq - 1 FROM audit_log WHERE id = ${first}::uuid),
      replay_until_seq = (SELECT max(seq) FROM audit_log), cursor_seq = (SELECT max(seq) FROM audit_log), replay_completed_at = NULL`);
    const live = await call("read_env");
    const liveSend = await call("http_post");
    const out = await runDetectionSweep(db, adminId);
    expect(out.replayComplete).toBe(false);
    expect(out.replayed).toBeGreaterThanOrEqual(2);
    void live;
    const [historical] = await incidentsFor(replayTrigger);
    expect(historical).toMatchObject({ ruleId: "secret-read-then-egress", historical: true, response: "alert" });
    const [current] = await incidentsFor(liveSend);
    expect(current).toMatchObject({ ruleId: "secret-read-then-egress", historical: false });
    const [state] = await db.select().from(detectionEngineState);
    expect(state!.replayCursorSeq).toBe(state!.replayUntilSeq);
    expect(state!.replayCompletedAt).not.toBeNull();
    // a further pass replays nothing more and raises nothing twice
    const again = await runDetectionSweep(db, adminId);
    expect(again).toMatchObject({ replayComplete: true, replayed: 0 });
    expect(await incidentsFor(replayTrigger)).toHaveLength(1);
  });

  it("a held lease is not claimed by a second pass", async () => {
    await toHead();
    await db.update(detectionEngineState).set({ leaseToken: randomUUID(), leaseUntil: sql`now() + interval '1 minute'` });
    const out = await runDetectionSweep(db, adminId);
    expect(out.outcome).toBe("not_claimed");
    await db.update(detectionEngineState).set({ leaseToken: null, leaseUntil: null });
  });
});

describe("ADR-0333 rule pack: signed, audited, relaxation needs step-up", () => {
  it("reads the built-in pack", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/detection/rule-pack", headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: "built-in", version: null, digest: packDigest(DEFAULT_DETECTION_PACK) });
  });

  it("refuses an invalid pack, a stale version and a response not yet available", async () => {
    const bad = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", headers: KEY, payload: { pack: { schema: "x" }, expectedVersion: null } });
    expect(bad.statusCode).toBe(400);
    const stale = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", headers: KEY, payload: { pack: DEFAULT_DETECTION_PACK, expectedVersion: 7 } });
    expect(stale.statusCode).toBe(409);
    const strong = { ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.map((r) => ({ ...r, response: "suspend_grant" })) };
    const refused = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", headers: KEY, payload: { pack: strong, expectedVersion: null } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("detection_response_not_available");
  });

  it("an additive change is stored signed and audited without step-up", async () => {
    const added = parseDetectionPack({
      ...DEFAULT_DETECTION_PACK,
      rules: [...DEFAULT_DETECTION_PACK.rules, { id: "any-require-approval", title: "Approval asked", severity: "low", enabled: true, type: "single", selector: { effect: ["require_approval"] } }],
    });
    const res = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", headers: KEY, payload: { pack: added, expectedVersion: null } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ version: 1, relaxed: false, digest: packDigest(added) });
    const active = await loadActiveDetectionPack(db);
    expect(active).toMatchObject({ version: 1, unverifiedVersion: null });
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, DETECTION_RULE_IDS.packUpdated)).orderBy(desc(auditLog.seq)).limit(1);
    expect(row!.detail).toMatchObject({ version: 1, relaxed: false, toDigest: packDigest(added) });
  });

  it("disabling a rule is a relaxation: refused without the step-up, stored with it", async () => {
    const current = await loadActiveDetectionPack(db);
    const next = parseDetectionPack({ ...current.pack, rules: current.pack.rules.map((r) => (r.id === "denied-call-burst" ? { ...r, enabled: false } : r)) });
    const payload = { pack: next, expectedVersion: 1 };
    const refused = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...(await asSession()), payload });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const facts = { detection: "rule-pack", fromDigest: current.digest, toDigest: packDigest(next) };
    const ok = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...(await asSteppedUp(facts)), payload });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ version: 2, relaxed: true });
  });

  it("a stored pack that no longer verifies is not used: the built-in pack runs and the fallback is audited once", async () => {
    // tamper with the stored pack: re-enable nothing, just drop a rule without re-signing
    const [latest] = await db.select().from(detectionRulePacks).orderBy(desc(detectionRulePacks.version)).limit(1);
    const tampered = { ...(latest!.pack as Record<string, unknown>), rules: [] };
    await db.update(detectionRulePacks).set({ pack: tampered }).where(eq(detectionRulePacks.version, latest!.version));
    const active = await loadActiveDetectionPack(db);
    expect(active).toMatchObject({ version: null, unverifiedVersion: latest!.version, digest: packDigest(DEFAULT_DETECTION_PACK) });
    await toHead();
    const read = await call("get_secret");
    void read;
    const send = await call("upload_file");
    await runDetectionSweep(db, adminId);
    await runDetectionSweep(db, adminId);
    expect((await incidentsFor(send)).map((i) => i.ruleId)).toContain("secret-read-then-egress");
    const fallbacks = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, DETECTION_RULE_IDS.packUnverified), sql`${auditLog.detail}->>'version' = ${String(latest!.version)}`));
    expect(fallbacks).toHaveLength(1);
  });
});

describe("ADR-0333 incident API", () => {
  it("lists, reads with evidence, and closes an incident (audited)", async () => {
    await toHead();
    await call("read_secret");
    const send = await call("send_message");
    await runDetectionSweep(db, adminId);
    const [incident] = await incidentsFor(send);
    const list = await app.inject({ method: "GET", url: "/v1/detection/incidents?status=open&limit=1", headers: KEY });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().incidents).toHaveLength(1);
    const one = await app.inject({ method: "GET", url: `/v1/detection/incidents/${incident!.id}`, headers: KEY });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().evidence.map((e: { auditId: string }) => e.auditId)).toHaveLength(2);
    expect(one.json().evidence.every((e: { auditPresent: boolean; rowHash: string }) => e.auditPresent && /^[0-9a-f]{64}$/.test(e.rowHash))).toBe(true);
    const closed = await app.inject({ method: "PUT", url: `/v1/detection/incidents/${incident!.id}/status`, headers: KEY, payload: { status: "closed" } });
    expect(closed.statusCode, closed.body).toBe(200);
    const again = await app.inject({ method: "PUT", url: `/v1/detection/incidents/${incident!.id}/status`, headers: KEY, payload: { status: "acknowledged" } });
    expect(again.statusCode).toBe(404);
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, DETECTION_RULE_IDS.incidentStatus), eq(auditLog.objectId, incident!.id)));
    expect(audited).toHaveLength(1);
    const bad = await app.inject({ method: "GET", url: "/v1/detection/incidents/not-a-uuid", headers: KEY });
    expect(bad.statusCode).toBe(400);
  });
});
