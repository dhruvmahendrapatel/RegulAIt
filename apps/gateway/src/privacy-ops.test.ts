/**
 * ADR-0224 (P13 c) — privacy operations: the processing limit at dispatch, records of processing, and data-subject
 * requests with locate, erasure and the audit-trail tombstone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  conversationMessages,
  conversations,
  createDb,
  dataSubjectRequests,
  dataSubjectTombstones,
  eq,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";
import { ERASED_MARKER, PRIVACY_RULE_IDS } from "./privacy-ops.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "privacy-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
// reserved example values only: the documentation domain and an invalid SSN
const SUBJECT = "Subject.Person@example.com";
const SSN = "123-45-6789";
const RUN = Math.random().toString(36).slice(2, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;
let proj: string;
let restoreGates: () => Promise<void> = async () => {};
let restoreOrg: () => Promise<void> = async () => {};

async function invoke(input: string, projectId: string | null) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: userAuth,
    payload: { mode: "execute", input, dispatch: true, ...(projectId ? { projectId } : {}) },
  });
}
const usageCount = async (projectId: string) => (await db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId))).length;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  // the org PII floor at 'log', so personal data reaches the processing limit rather than the PII-mode block
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: "log", privacyOpsEnabled: false, dsrSlaDays: 30 });

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `privacy-dana-${RUN}@example.com`, displayName: "Privacy Dana", isAdmin: false } });
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "privacy" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const agent = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `privacy-mock-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  agentId = agent.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId } });
  const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name: `privacy-proj-${RUN}` } });
  expect(p.statusCode).toBe(201);
  proj = p.json().id;
});

afterAll(async () => {
  await restoreOrg();
  await restoreGates();
});

describe("the org setting", () => {
  it("ships off with a 30-day request due date", async () => {
    const cols = await db.execute(
      sql`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'org_settings' AND column_name IN ('privacy_ops_enabled', 'dsr_sla_days') ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "dsr_sla_days", column_default: "30" },
      { column_name: "privacy_ops_enabled", column_default: "false" },
    ]);
    const r = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.privacyOpsEnabled).toBe(false);
    expect(r.json().settings.dsrSlaDays).toBe(30);
  });

  it("off: personal data in a dispatch is not limited", async () => {
    const res = await invoke(`Draft a reply to ${SUBJECT}.`, proj);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("the processing limit at dispatch", () => {
  it("on: personal data with no record of processing is refused before the provider, audited without the value", async () => {
    await setOrgSettingsForTest(db, { privacyOpsEnabled: true });
    const before = await usageCount(proj);
    const res = await invoke(`Draft a reply to ${SUBJECT}.`, proj);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    expect(res.json().detail).toContain("no active record of processing");
    expect(JSON.stringify(res.json())).not.toContain(SUBJECT);
    expect(await usageCount(proj)).toBe(before);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.effect).toBe("deny");
      expect(JSON.stringify(r.detail) + r.reason).not.toContain(SUBJECT.toLowerCase().split("@")[0]);
    }
  });

  it("on: an input with no personal data is untouched", async () => {
    const res = await invoke("Summarise the quarterly plan.", proj);
    expect(res.statusCode).toBe(200);
  });

  it("on: an unattributed dispatch carrying personal data is refused (no record can permit it)", async () => {
    const res = await invoke(`Email ${SUBJECT} the minutes.`, null);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toContain("names no project");
  });

  let recordId: string;
  it("a record permitting email lets email through, and still refuses a category it does not list", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/v1/privacy/processing-records",
      headers: AUTH,
      payload: { name: "No link", purpose: "x", lawfulBasis: "contract", dataCategories: ["email"], retentionDays: 30 },
    });
    expect(bad.statusCode).toBe(400);
    const r = await app.inject({
      method: "POST",
      url: "/v1/privacy/processing-records",
      headers: AUTH,
      payload: {
        name: "Customer support replies",
        purpose: "Drafting replies to customer emails",
        lawfulBasis: "contract",
        dataCategories: ["email"],
        retentionDays: 90,
        recipients: ["Support team"],
        projectId: proj,
      },
    });
    expect(r.statusCode).toBe(201);
    recordId = r.json().record.id;
    expect(r.json().record.projectName).toBe(`privacy-proj-${RUN}`);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectId, recordId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.recordCreated)));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.detail as { relaxation?: boolean }).relaxation).toBe(true);

    expect((await invoke(`Draft a reply to ${SUBJECT}.`, proj)).statusCode).toBe(200);
    const ssn = await invoke(`Draft a reply to ${SUBJECT} about ${SSN}.`, proj);
    expect(ssn.statusCode).toBe(409);
    expect(ssn.json().detail).toContain("ssn");
    expect(ssn.json().detail).not.toContain("email,");
  });

  it("retiring the record takes it out of the limit, and the change is audited", async () => {
    const r = await app.inject({ method: "PATCH", url: `/v1/privacy/processing-records/${recordId}`, headers: AUTH, payload: { status: "retired" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().record.status).toBe("retired");
    expect((await invoke(`Draft a reply to ${SUBJECT}.`, proj)).statusCode).toBe(409);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectId, recordId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.recordUpdated)));
    expect(audit).toHaveLength(1);
    const reactivate = await app.inject({ method: "PATCH", url: `/v1/privacy/processing-records/${recordId}`, headers: AUTH, payload: { status: "active" } });
    expect(reactivate.statusCode).toBe(200);
    const audit2 = await db.select().from(auditLog).where(and(eq(auditLog.objectId, recordId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.recordUpdated)));
    expect(audit2.some((a) => (a.detail as { relaxation?: boolean }).relaxation === true)).toBe(true);
  });

  it("is admin-only: a member can neither read nor write records", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/privacy/processing-records", headers: userAuth })).statusCode).toBe(403);
    const w = await app.inject({
      method: "POST",
      url: "/v1/privacy/processing-records",
      headers: userAuth,
      payload: { name: "x", purpose: "x", lawfulBasis: "consent", dataCategories: ["email"], retentionDays: 1, projectId: proj },
    });
    expect(w.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/privacy/requests", headers: userAuth })).statusCode).toBe(403);
  });

  it("lists records with pagination", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/privacy/processing-records?limit=1", headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.json().records).toHaveLength(1);
  });
});

describe("data-subject requests", () => {
  let requestId: string;
  let messageId: string;
  let auditRowId: string;

  beforeAll(async () => {
    // personal data about the subject in a conversation, and in one audit row
    const [c] = await db.insert(conversations).values({ userId, agentId, projectId: proj, title: "support" }).returning();
    const [m] = await db.insert(conversationMessages).values({ conversationId: c!.id, role: "user", content: `Please contact ${SUBJECT} tomorrow.` }).returning();
    messageId = m!.id;
    const [a] = await db
      .insert(auditLog)
      .values({ userId, objectType: "project", objectId: proj, detail: { note: `contact ${SUBJECT}` }, effect: "allow", ruleId: "privacy-test-fixture", ruleChain: [], reason: "fixture" })
      .returning({ id: auditLog.id });
    auditRowId = a!.id;
  });

  it("records a request with a due date and no personal data", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/privacy/requests", headers: AUTH, payload: { kind: "erasure", identifierKind: "email", identifier: "not-an-email" } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).not.toContain("not-an-email");
    const r = await app.inject({
      method: "POST",
      url: "/v1/privacy/requests",
      headers: AUTH,
      payload: { kind: "erasure", identifierKind: "email", identifier: SUBJECT, reference: "TICKET-1" },
    });
    expect(r.statusCode).toBe(201);
    const v = r.json().request;
    requestId = v.id;
    expect(v.status).toBe("received");
    expect(new Date(v.dueAt).getTime() - new Date(v.receivedAt).getTime()).toBe(30 * 86_400_000);
    expect(JSON.stringify(v)).not.toContain(SUBJECT);
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, requestId));
    expect(JSON.stringify(row)).not.toContain(SUBJECT.toLowerCase());
    expect(row!.subjectDigest).toMatch(/^[0-9a-f]{64}$/);
    const audit = await db.select().from(auditLog).where(eq(auditLog.objectId, requestId));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(SUBJECT.toLowerCase());
  });

  it("locate refuses an identifier the request was not recorded with", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/privacy/requests/${requestId}/locate`, headers: AUTH, payload: { identifier: "someone.else@example.com" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("identifier_mismatch");
  });

  it("locate finds the subject in the stores and returns counts only", async () => {
    // the digest is case-insensitive for email
    const r = await app.inject({ method: "POST", url: `/v1/privacy/requests/${requestId}/locate`, headers: AUTH, payload: { identifier: SUBJECT.toLowerCase() } });
    expect(r.statusCode).toBe(200);
    const v = r.json().request;
    expect(v.status).toBe("in_progress");
    const byStore = Object.fromEntries((v.located as Array<{ store: string; matches: number }>).map((f) => [f.store, f.matches]));
    expect(byStore.conversations).toBeGreaterThanOrEqual(1);
    expect(byStore.audit_trail).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.json())).not.toContain(SUBJECT.toLowerCase());
  });

  it("completing an erasure needs the identifier, erases conversations, and tombstones the audit trail without editing it", async () => {
    const noId = await app.inject({ method: "POST", url: `/v1/privacy/requests/${requestId}/close`, headers: AUTH, payload: { outcome: "completed", note: "done" } });
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error).toBe("identifier_required");
    const [auditBefore] = await db.select().from(auditLog).where(eq(auditLog.id, auditRowId));

    const r = await app.inject({
      method: "POST",
      url: `/v1/privacy/requests/${requestId}/close`,
      headers: AUTH,
      payload: { outcome: "completed", note: "Erased where editable", identifier: SUBJECT },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().request.status).toBe("completed");

    const [m] = await db.select().from(conversationMessages).where(eq(conversationMessages.id, messageId));
    expect(m!.content).toBe(`Please contact ${ERASED_MARKER} tomorrow.`);
    const [auditAfter] = await db.select().from(auditLog).where(eq(auditLog.id, auditRowId));
    expect(auditAfter).toEqual(auditBefore);
    const tombs = await db.select().from(dataSubjectTombstones).where(eq(dataSubjectTombstones.requestId, requestId));
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.store).toBe("audit_trail");
    expect(tombs[0]!.rowIds).toContain(auditRowId);
    const t = await app.inject({ method: "GET", url: `/v1/privacy/requests/${requestId}/tombstones`, headers: AUTH });
    expect(t.json().tombstones[0].rowCount).toBeGreaterThanOrEqual(1);
    const erased = await db.select().from(auditLog).where(and(eq(auditLog.objectId, requestId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.requestErased)));
    expect(erased).toHaveLength(1);
    expect(JSON.stringify(erased[0])).not.toContain(SUBJECT.toLowerCase());
  });

  it("a closed request cannot be located or closed again", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/privacy/requests/${requestId}/locate`, headers: AUTH, payload: { identifier: SUBJECT } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("request_closed");
  });

  it("an access request closes with a note and no erasure", async () => {
    const c = await app.inject({ method: "POST", url: "/v1/privacy/requests", headers: AUTH, payload: { kind: "access", identifierKind: "phone", identifier: "+44 20 7946 0000" } });
    expect(c.statusCode).toBe(201);
    const id = c.json().request.id;
    const open = await app.inject({ method: "GET", url: "/v1/privacy/requests?status=open", headers: AUTH });
    expect(open.json().requests.some((x: { id: string }) => x.id === id)).toBe(true);
    const r = await app.inject({ method: "POST", url: `/v1/privacy/requests/${id}/close`, headers: AUTH, payload: { outcome: "rejected", note: "Identity not verified" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().request.status).toBe("rejected");
    expect(await db.select().from(dataSubjectTombstones).where(eq(dataSubjectTombstones.requestId, id))).toHaveLength(0);
  });
});
