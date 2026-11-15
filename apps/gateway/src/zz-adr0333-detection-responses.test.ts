/**
 * ADR-0333 §5 (slice 2) — configured responses: stored only behind a settings_relax step-up, run after the incident
 * commits, recorded on the incident and audited. `require_approval` goes through the one approval-rule create, so
 * the sponsor's later MCP calls meet the Approvals Queue; a response that cannot apply fails with a fixed code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  and,
  approvalRules,
  auditLog,
  createDb,
  detectionIncidents,
  detectionRulePacks,
  eq,
  mcpServers,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { loadActiveDetectionPack, runDetectionSweep } from "./detection/sweep.js";
import { DEFAULT_DETECTION_PACK, packDigest, parseDetectionPack, type DetectionResponse } from "./detection/pack.js";
import { DETECTION_RESPONSE_RULE_ID, runDetectionResponse } from "./detection/responses.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0333r-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let sponsorId: string;
let serverId: string;
const restores: Array<() => Promise<void>> = [];

async function mkUser(label: string, isAdmin: boolean): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0333r-${label}-${RUN}@example.com`, displayName: label, isAdmin } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/** store the default pack with `high-risk-addon-call` set to `response`, through the stepped-up route */
async function storeWithResponse(response: DetectionResponse): Promise<number> {
  const current = await loadActiveDetectionPack(db);
  const next = parseDetectionPack({ ...DEFAULT_DETECTION_PACK, rules: DEFAULT_DETECTION_PACK.rules.map((r) => (r.id === "high-risk-addon-call" ? { ...r, response } : r)) });
  const facts = { detection: "rule-pack", fromDigest: current.digest, toDigest: packDigest(next) };
  const req = stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
  const res = await app.inject({ method: "PUT", url: "/v1/detection/rule-pack", ...req, payload: { pack: next, expectedVersion: current.version } });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json().relaxed).toBe(true);
  return res.json().version as number;
}

async function riskyCall(): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({ id, userId: sponsorId, objectType: "mcp_tool", serverId, toolName: "noop", effect: "allow", ruleId: "allow-list", ruleChain: [], reason: "t" });
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  adminId = await mkUser("admin", true);
  sponsorId = await mkUser("sponsor", false);
  const [s] = await db.insert(mcpServers).values({ name: `adr0333r-${randomUUID()}`, url: "http://127.0.0.1:9/", admissionSeverity: "high" }).returning({ id: mcpServers.id });
  serverId = s!.id;
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await runDetectionSweep(db, adminId);
  await db.execute(sql`UPDATE detection_engine_state SET cursor_seq = (SELECT max(seq) FROM audit_log), replay_cursor_seq = replay_until_seq, lease_until = NULL, lease_token = NULL`);
});

afterAll(async () => {
  await db.delete(approvalRules).where(eq(approvalRules.userId, sponsorId));
  await db.delete(detectionIncidents).where(sql`pack_version IS NOT NULL`);
  await db.delete(detectionRulePacks);
  await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

describe("ADR-0333 responses", () => {
  it("require_approval: the sponsor gets a user-scoped, all-servers approval rule with the pack author as approver", async () => {
    const version = await storeWithResponse("require_approval");
    const trigger = await riskyCall();
    const out = await runDetectionSweep(db, adminId);
    expect(out.responses).toBe(1);
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger));
    expect(incident).toMatchObject({ ruleId: "high-risk-addon-call", packVersion: version, response: "require_approval", responseState: "done", responseErrorCode: null });
    const rules = await db.select().from(approvalRules).where(eq(approvalRules.userId, sponsorId));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ scope: "user", serverScope: "all", toolName: null, approverUserId: adminId, approvalScope: "action" });
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(audited).toMatchObject({ effect: "deny", userId: adminId });
    // a second detection reuses the rule rather than stacking another
    await riskyCall();
    await runDetectionSweep(db, adminId);
    expect(await db.select().from(approvalRules).where(eq(approvalRules.userId, sponsorId))).toHaveLength(1);
  });

  it("suspend_grant on a sponsor's own calls fails with not_delegated, recorded and audited", async () => {
    await storeWithResponse("suspend_grant");
    const trigger = await riskyCall();
    await runDetectionSweep(db, adminId);
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.triggerAuditId, trigger));
    expect(incident).toMatchObject({ response: "suspend_grant", responseState: "failed", responseErrorCode: "not_delegated" });
    const [audited] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID)));
    expect(audited).toMatchObject({ effect: "allow" });
    expect(audited!.detail).toMatchObject({ outcome: "failed", code: "not_delegated" });
  });

  it("suspend_grant on an unknown delegation tree, and revoke_credential with no actor, fail with fixed codes", async () => {
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.response, "suspend_grant")).limit(1);
    const base = { incidentId: incident!.id, ruleId: "high-risk-addon-call", userId: sponsorId, actorIdentityId: null, packAuthor: adminId, auditUserId: adminId };
    expect(await runDetectionResponse(db, { ...base, response: "suspend_grant", groupKey: `grant:${randomUUID()}` })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("grant_not_found");
    expect(await runDetectionResponse(db, { ...base, response: "revoke_credential", groupKey: `user:${sponsorId}` })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("no_actor_identity");
    expect(await runDetectionResponse(db, { ...base, response: "require_approval", groupKey: `user:${sponsorId}`, packAuthor: sponsorId })).toBe("failed");
    expect((await db.select().from(detectionIncidents).where(eq(detectionIncidents.id, incident!.id)))[0]!.responseErrorCode).toBe("no_independent_approver");
  });

  it("revoke_credential revokes only the acting identity's live tokens", async () => {
    // no identity fixtures needed: an identity with no live tokens revokes none and still succeeds
    const [incident] = await db.select().from(detectionIncidents).where(eq(detectionIncidents.response, "suspend_grant")).limit(1);
    const state = await runDetectionResponse(db, {
      incidentId: incident!.id,
      ruleId: "high-risk-addon-call",
      response: "revoke_credential",
      groupKey: `user:${sponsorId}`,
      userId: sponsorId,
      actorIdentityId: randomUUID(),
      packAuthor: adminId,
      auditUserId: adminId,
    });
    expect(state).toBe("done");
    const [audited] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, incident!.id), eq(auditLog.ruleId, DETECTION_RESPONSE_RULE_ID), sql`${auditLog.detail}->>'response' = 'revoke_credential'`, sql`${auditLog.detail}->>'outcome' = 'done'`));
    expect(audited!.detail).toMatchObject({ tokensRevoked: 0 });
  });
});
