/**
 * ADR-0333 — the detection sweep against a real Postgres: incidents with their evidence chain, one audit row per
 * incident (which the ADR-0303 SIEM sweep then delivers), idempotence, the lease, the signed rule pack (verify on
 * every sweep, fall back to the built-in pack when it does not verify), step-up on relaxation and the incident API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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
  receiptSigningKeys,
  runAuditV2Cutover,
  runMigrations,
  runWithAuditActor,
  sql,
  withPrincipal,
  withSystemContext,
  type Db,
} from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { DETECTION_RULE_IDS, DETECTION_SWEEP_LIMITS, loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack, signDetectionPack } from "./detection/pack.js";
import { DETECTION_INCIDENT_MACHINE, DETECTION_RESPONSE_MACHINE } from "@regulait/shared";
import { DETECTION_INCIDENT_STATUSES, DETECTION_RESPONSE_STATES } from "@regulait/db";

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
    // earlier runs' open bursts on this user would hold the episode (one incident per window)
    await db.execute(sql`UPDATE detection_incidents SET status = 'closed' WHERE rule_id = 'denied-call-burst'`);
    const [server] = await db.insert(mcpServers).values({ name: `adr0333-${randomUUID()}`, url: "http://127.0.0.1:9/", admissionSeverity: "critical" }).returning({ id: mcpServers.id });
    const risky = await call("noop", { serverId: server!.id });
    const denies: string[] = [];
    for (let i = 0; i < 11; i++) denies.push(await call("noop", { effect: "deny", ruleId: "default-deny" }));
    await runDetectionSweep(db, adminId);
    expect((await incidentsFor(risky)).map((i) => i.ruleId)).toEqual(["high-risk-addon-call"]);
    expect((await incidentsFor(denies[9]!)).map((i) => i.ruleId)).toEqual(["denied-call-burst"]);
    expect(await incidentsFor(denies[10]!)).toHaveLength(0);
    // the probe goes on in the next batch: the open incident holds the episode, so no second burst incident
    const more: string[] = [];
    for (let i = 0; i < 5; i++) more.push(await call("noop", { effect: "deny", ruleId: "default-deny" }));
    await runDetectionSweep(db, adminId);
    for (const id of more) expect(await incidentsFor(id)).toHaveLength(0);
    // once an admin closes it, the next denied call in a still-hot window raises a new incident
    await db.execute(sql`UPDATE detection_incidents SET status = 'closed' WHERE rule_id = 'denied-call-burst'`);
    const next = await call("noop", { effect: "deny", ruleId: "default-deny" });
    await runDetectionSweep(db, adminId);
    expect((await incidentsFor(next)).map((i) => i.ruleId)).toEqual(["denied-call-burst"]);
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

  it("a truncated look-back is audited as degraded detection, never silent (review of #865)", async () => {
    await toHead();
    const before = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, DETECTION_RULE_IDS.degraded));
    // more than one group's look-back budget inside the window: the last batch's look-back must truncate
    const n = DETECTION_SWEEP_LIMITS.lookbackRowsPerGroup + 600;
    await db.insert(auditLog).values(
      Array.from({ length: n }, () => ({ userId: adminId, objectType: "mcp_tool" as const, toolName: "noop_tool", effect: "allow" as const, ruleId: "allow-list", ruleChain: [], reason: "test" })),
    );
    const out = await runDetectionSweep(db, adminId);
    expect(out.lookbackTruncated).toBe(true);
    const after = await db.select().from(auditLog).where(eq(auditLog.ruleId, DETECTION_RULE_IDS.degraded)).orderBy(desc(auditLog.seq));
    expect(after.length).toBeGreaterThan(before.length);
    expect(after[0]!.detail).toMatchObject({ subsystem: "agent-detection", groups: [`user:${adminId}`], perGroupRows: DETECTION_SWEEP_LIMITS.lookbackRowsPerGroup });
    expect(after[0]!.effect).toBe("deny");
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

  it("a pack signed by a key someone INSERTed into receipt_signing_keys is not trusted (review of #865)", async () => {
    const [latest] = await db.select({ version: detectionRulePacks.version }).from(detectionRulePacks).orderBy(desc(detectionRulePacks.version)).limit(1);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
    const keyId = `adr0333-foreign-${RUN}`;
    await db.insert(receiptSigningKeys).values({ keyId, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } });
    const silenced = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.map((r) => ({ ...r, enabled: false })) });
    const version = (latest?.version ?? 0) + 1;
    await db.insert(detectionRulePacks).values({ version, pack: silenced, packDigest: packDigest(silenced), signature: signDetectionPack(silenced, privateKey), keyId });
    const active = await loadActiveDetectionPack(db);
    expect(active).toMatchObject({ version: null, unverifiedVersion: version, digest: packDigest(DEFAULT_DETECTION_PACK) });
    // with no configured key at all, no stored pack is trusted either
    expect(await loadActiveDetectionPack(db, () => null)).toMatchObject({ version: null, unverifiedVersion: version });
    await db.delete(detectionRulePacks).where(eq(detectionRulePacks.version, version));
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
    // ADR-0348: the read says what may happen next, from the machine the route enforces
    expect(one.json().lifecycle.status).toMatchObject({ machine: "detection_incident", state: "open", terminal: false });
    expect(one.json().lifecycle.response).toMatchObject({ machine: "detection_response", state: "none" });
    const closed = await app.inject({ method: "PUT", url: `/v1/detection/incidents/${incident!.id}/status`, headers: KEY, payload: { status: "closed" } });
    expect(closed.statusCode, closed.body).toBe(200);
    const again = await app.inject({ method: "PUT", url: `/v1/detection/incidents/${incident!.id}/status`, headers: KEY, payload: { status: "acknowledged" } });
    expect(again.statusCode).toBe(404);
    const audited = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, DETECTION_RULE_IDS.incidentStatus), eq(auditLog.objectId, incident!.id)));
    expect(audited).toHaveLength(1);
    const after = await app.inject({ method: "GET", url: `/v1/detection/incidents/${incident!.id}`, headers: KEY });
    expect(after.json().lifecycle.status).toMatchObject({ state: "closed", terminal: true });
    expect(after.json().lifecycle.status.transitions.every((t: { allowed: boolean }) => !t.allowed)).toBe(true);
    const bad = await app.inject({ method: "GET", url: "/v1/detection/incidents/not-a-uuid", headers: KEY });
    expect(bad.statusCode).toBe(400);
  });
});

describe("ADR-0333 row-level security (ADR-0234; review of #865)", () => {
  it("both incident tables have row-level security ENABLED and FORCED", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relname in ('detection_incidents', 'detection_incident_evidence') order by relname`);
    expect((r as unknown as { rows: unknown[] }).rows).toEqual([
      { relname: "detection_incident_evidence", on: true, forced: true },
      { relname: "detection_incidents", on: true, forced: true },
    ]);
  });

  it("NEGATIVE: a member principal and a request reason see no incident and cannot write one; an admin and system_task can", async () => {
    await toHead();
    await call("read_secret");
    const send = await call("send_message");
    await runDetectionSweep(db, adminId);
    const member = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333-member-${RUN}@example.com`, displayName: "detection member", isAdmin: false } });
    expect(member.statusCode, member.body).toBe(201);
    const memberId: string = member.json().id;
    const q = (tx: unknown) => (tx as Db).select({ id: detectionIncidents.id }).from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, send));
    const ev = (tx: unknown) => (tx as Db).select({ id: detectionIncidentEvidence.incidentId }).from(detectionIncidentEvidence).innerJoin(detectionIncidents, eq(detectionIncidents.id, detectionIncidentEvidence.incidentId)).where(eq(detectionIncidents.triggerAuditId, send));
    expect(await withPrincipal(db, { userId: adminId }, q)).toHaveLength(1);
    expect(await withSystemContext(db, "system_task", "test.e15", q)).toHaveLength(1);
    expect(await withPrincipal(db, { userId: memberId }, q)).toEqual([]);
    expect(await withPrincipal(db, { userId: memberId }, ev)).toEqual([]);
    expect(await withSystemContext(db, "credential_request", "test.e15", q)).toEqual([]);
    await expect(
      withPrincipal(db, { userId: memberId }, (tx) =>
        (tx as unknown as Db).insert(detectionIncidents).values({ ruleId: "forged", severity: "low", groupKey: `user:${memberId}`, triggerAuditId: randomUUID(), triggerAuditSeq: 1, response: "alert" }),
      ),
    ).rejects.toThrow();
    // and the API is admin-only (the default gate): a member's key is refused on every detection route
    const key = await app.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "adr0333-member" } });
    const MEMBER = { authorization: `Bearer ${key.json().token}` };
    for (const [method, url] of [
      ["GET", "/v1/detection/rule-pack"],
      ["PUT", "/v1/detection/rule-pack"],
      ["GET", "/v1/detection/incidents"],
      ["GET", `/v1/detection/incidents/${randomUUID()}`],
      ["PUT", `/v1/detection/incidents/${randomUUID()}/status`],
    ] as const) {
      const res = await app.inject({ method, url, headers: MEMBER, ...(method === "PUT" ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("ADR-0333 incident list paging", () => {
  it("pages through more incidents than the page size from ONE batch without skipping any (microsecond cursor)", async () => {
    await toHead();
    const mine = new Set<string>();
    // one sweep batch: every incident shares the batch transaction's now()
    for (let i = 0; i < 5; i++) mine.add(await call("delegated_tool", { effect: "deny", ruleId: "delegation-scope" }));
    await runDetectionSweep(db, adminId);
    const raised = await db.select({ createdAt: detectionIncidents.createdAt }).from(detectionIncidents).where(sql`${detectionIncidents.triggerAuditId} IN (${sql.join([...mine].map((id) => sql`${id}::uuid`), sql`, `)})`);
    expect(raised).toHaveLength(5);
    expect(new Set(raised.map((r) => r.createdAt.getTime())).size).toBe(1);
    const seen = new Set<string>();
    let before: string | null = null;
    for (let pages = 0; pages < 500; pages++) {
      const url: string = `/v1/detection/incidents?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const res = await app.inject({ method: "GET", url, headers: KEY });
      expect(res.statusCode, res.body).toBe(200);
      for (const inc of res.json().incidents as Array<{ triggerAuditId: string }>) if (mine.has(inc.triggerAuditId)) seen.add(inc.triggerAuditId);
      before = res.json().next;
      if (!before) break;
    }
    expect(seen.size).toBe(5);
    const tampered = await app.inject({ method: "GET", url: "/v1/detection/incidents?before=not-a-cursor", headers: KEY });
    expect(tampered.statusCode).toBe(400);
  });
});

describe("ADR-0333 lifecycles are ADR-0348 machines", () => {
  it("each machine lists the same values as the column's TypeScript enum (the CHECK equality is the ADR-0348 test)", () => {
    expect([...DETECTION_INCIDENT_MACHINE.def.states]).toEqual([...DETECTION_INCIDENT_STATUSES]);
    expect([...DETECTION_RESPONSE_MACHINE.def.states]).toEqual([...DETECTION_RESPONSE_STATES]);
    expect(DETECTION_INCIDENT_MACHINE.sourcesOf("close")).toEqual(["open", "acknowledged"]);
    expect(DETECTION_RESPONSE_MACHINE.sourcesOf("apply")).toEqual(["none"]);
  });
});
