/**
 * ADR-0361 slice 3 — deleting a monitored conversation through the vendor API, end to end on Postgres: off by default,
 * a separate delete key, a request that queues an approval, four-eyes with a fresh step-up in the existing decide
 * path, one execution through the kill switch, an unknown outcome settled by a read, and the declared lifecycle.
 *
 * The vendor is a fake Claude Enterprise Compliance API (`aiSaasMonitorFetch`). Its host is allow-listed for this
 * file only; both switches are turned back off in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiSaasMonitorConnectors, aiSaasMonitorPolicy, aiSaasRemediations, and, approvals, auditLog, createDb, eq, runMigrations, sql, type Db } from "@regulait/db";
import { AI_SAAS_REMEDIATION_MACHINE } from "@regulait/shared";
import { buildApp } from "./app.js";
import { AI_SAAS_REMEDIATION_RULE_IDS } from "./ai-saas-remediation.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import type { StepUpCheckArgs } from "./step-up.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0361s3-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = Date.now();
const CHAT_OK = `claude_chat_ok_${RUN}`;
const CHAT_SLOW = `claude_chat_slow_${RUN}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recent = () => new Date(Date.now() - 2 * 86_400_000 + 3600_000).toISOString();

/** the fake vendor: two chats; the slow one's delete times out; deleted chats answer 404 afterwards */
const vendor = { deleted: new Set<string>(), deletes: [] as Array<{ url: string; key: string | null }> };
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (url.hostname !== "api.anthropic.com") return json({ error: "unexpected" }, 599);
  if (url.pathname === "/v1/compliance/apps/chats" && method === "GET") {
    if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
    return json({ data: [CHAT_OK, CHAT_SLOW].map((id) => ({ id, updated_at: recent(), user: { id: "user_xyz" } })), has_more: false, last_id: "c" });
  }
  const m = /^\/v1\/compliance\/apps\/chats\/([^/]+)(\/messages)?$/.exec(url.pathname);
  if (m && method === "GET" && m[2]) {
    if (vendor.deleted.has(m[1]!)) return json({ error: { type: "not_found_error" } }, 404);
    return json({ id: m[1], user: { id: "user_xyz" }, chat_messages: [{ id: `${m[1]}-m1`, role: "user", created_at: recent(), content: [{ type: "text", text: "hello" }] }], has_more: false, last_id: null });
  }
  if (m && method === "DELETE" && !m[2]) {
    vendor.deletes.push({ url: url.toString(), key: headers.get("x-api-key") });
    vendor.deleted.add(m[1]!);
    if (m[1] === CHAT_SLOW) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    return json({ id: m[1], type: "claude_chat_deleted" });
  }
  return json({ error: "unexpected" }, 599);
}) as typeof fetch;

let db: Db;
let app: ReturnType<typeof buildApp>;
const people: Record<"requester" | "approver", { id: string; key: { authorization: string } }> = {} as never;
let connectorId: string;
const restores: Array<() => Promise<void>> = [];
const allowed = trackEgressAllowHosts();
const relax = async (who: string, facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, who, { kind: "settings_relax", facts } as StepUpCheckArgs));
const decideAs = async (who: string, approvalId: string) =>
  stepUpRequest(await grantStepUpForTest(db, who, { kind: "approval_decide", facts: { op: "ai_saas_remediation", approvalId, decision: "approved" } } as StepUpCheckArgs));

async function interactionOf(chat: string): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`SELECT id FROM ai_saas_interactions WHERE conversation_ref = ${chat} LIMIT 1`);
  const rows = Array.isArray(res) ? res : (res as { rows: Array<{ id: string }> }).rows;
  return rows[0]!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, aiSaasMonitorFetch: fakeFetch, aiSaasMonitorResolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  const res = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost("api.anthropic.com"), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0361s3 ${RUN}` } }),
  );
  expect([201, 409], res.body).toContain(res.statusCode);
  for (const role of ["requester", "approver"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0361s3-${role}-${RUN}@example.com`, displayName: role, isAdmin: true } });
    const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: role } });
    people[role] = { id: u.json().id, key: { authorization: `Bearer ${k.json().token}` } };
  }
  const R = people.requester;
  await db.insert(aiSaasMonitorPolicy).values({ id: "singleton", enabled: true }).onConflictDoUpdate({ target: aiSaasMonitorPolicy.id, set: { enabled: true, remediationEnabled: false } });
  const created = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: R.key, payload: { vendor: "claude_enterprise", name: `adr0361s3-${RUN}`, config: { backfillDays: 2 }, reason: "pilot tenant" } });
  connectorId = created.json().connector.id;
  const stored = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...(await relax(R.id, { aiSaasConnector: connectorId, values: { credential: "store" } })), payload: { secret: `read-${RUN}`, replacesCredentialId: null, attestReadOnly: true, reason: "read key" } });
  expect(stored.statusCode, stored.body).toBe(201);
  const enabled = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/enabled`, ...(await relax(R.id, { aiSaasConnector: connectorId, values: { enabled: true } })), payload: { enabled: true, reason: "go live" } });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: R.key });
  expect(run.json().run).toMatchObject({ status: "succeeded", interactionsNew: 2 });
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    await db.update(aiSaasMonitorPolicy).set({ enabled: false, remediationEnabled: false, contentCapture: "none" });
    await db.update(aiSaasMonitorConnectors).set({ enabled: false }).where(sql`${aiSaasMonitorConnectors.name} like ${`adr0361s3-${RUN}%`}`);
    for (const r of restores.reverse()) await r();
    await app?.close();
  } finally {
    entries.assertRemoved();
  }
});

describe("ADR-0361 slice 3: remediation is off twice by default", () => {
  it("refuses a request while remediation is off, and a delete key before it is on", async () => {
    const R = people.requester;
    const res = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", headers: R.key, payload: { interactionId: await interactionOf(CHAT_OK), action: "delete_conversation", approverUserId: people.approver.id, reason: "leaked data" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ai_saas_remediation_disabled");
    const key = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...(await relax(R.id, { aiSaasConnector: connectorId, values: { credential: "store", purpose: "remediate" } })), payload: { secret: `del-${RUN}`, replacesCredentialId: null, purpose: "remediate", reason: "delete key" } });
    expect(key.statusCode).toBe(409);
  });

  it("turning it on is a step-up; the delete key is separate and needed", async () => {
    const R = people.requester;
    expect((await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/remediation", headers: R.key, payload: { enabled: true, reason: "incident response" } })).statusCode).toBe(403);
    const on = await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/remediation", ...(await relax(R.id, { aiSaasRemediation: true, values: { enabled: true } })), payload: { enabled: true, reason: "incident response" } });
    expect(on.statusCode, on.body).toBe(200);
    const noKey = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", headers: R.key, payload: { interactionId: await interactionOf(CHAT_OK), action: "delete_conversation", approverUserId: people.approver.id, reason: "leaked data" } });
    expect(noKey.json().error).toBe("no_remediation_credential");
    const key = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...(await relax(R.id, { aiSaasConnector: connectorId, values: { credential: "store", purpose: "remediate" } })), payload: { secret: `del-${RUN}`, replacesCredentialId: null, purpose: "remediate", reason: "delete key" } });
    expect(key.statusCode, key.body).toBe(201);
    expect(key.json().credential.purpose).toBe("remediate");
  });
});

describe("ADR-0361 slice 3: request, four-eyes approval, one execution", () => {
  let remediationId: string;
  let approvalId: string;

  it("a request needs a step-up, names an approver other than the requester, and queues an approval", async () => {
    const R = people.requester;
    const interactionId = await interactionOf(CHAT_OK);
    const body = { interactionId, action: "delete_conversation", approverUserId: people.approver.id, reason: "leaked customer data" };
    expect((await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", headers: R.key, payload: body })).statusCode).toBe(403);
    const self = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", headers: R.key, payload: { ...body, approverUserId: R.id } });
    expect(self.json().error).toBe("caller_cannot_approve");
    const res = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", ...(await relax(R.id, { op: "ai_saas_remediation", interactionId, action: "delete_conversation" })), payload: body });
    expect(res.statusCode, res.body).toBe(202);
    const r = res.json().remediation;
    expect(r).toMatchObject({ status: "requested", conversationRef: CHAT_OK });
    expect(r.lifecycle.transitions.find((t: { event: string }) => t.event === "execute").allowed).toBe(false);
    remediationId = r.id;
    approvalId = r.approvalId;
    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(a).toMatchObject({ objectType: "ai_saas_remediation", status: "pending", approverUserId: people.approver.id, userId: R.id });
    // the same request again is idempotent, and nothing runs before approval
    const again = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", headers: R.key, payload: body });
    expect(again.json()).toMatchObject({ idempotent: true });
    const early = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${remediationId}/execute`, ...(await relax(R.id, { op: "ai_saas_remediation_execute", remediationId })) });
    expect(early.statusCode).toBe(409);
    expect(vendor.deletes).toHaveLength(0);
  });

  it("the requester cannot decide it, and a decision without a fresh step-up is refused", async () => {
    const own = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, ...(await decideAs(people.requester.id, approvalId)), payload: { decision: "approved", reason: "mine" } });
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_ai_saas_remediation");
    const viaKey = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: people.approver.key, payload: { decision: "approved", reason: "ok" } });
    expect(viaKey.statusCode).toBe(403);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(a!.status).toBe("pending");
  });

  it("the approver decides with a step-up; only the requester executes, once, with our delete key", async () => {
    const ok = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, ...(await decideAs(people.approver.id, approvalId)), payload: { decision: "approved", reason: "confirmed leak" } });
    expect(ok.statusCode, ok.body).toBe(200);
    const read = await app.inject({ method: "GET", url: `/v1/ai-saas-monitoring/remediations/${remediationId}`, headers: people.requester.key });
    expect(read.json().remediation.status).toBe("approved");
    const notMine = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${remediationId}/execute`, ...(await relax(people.approver.id, { op: "ai_saas_remediation_execute", remediationId })) });
    expect(notMine.json().error).toBe("not_the_requester");
    const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${remediationId}/execute`, ...(await relax(people.requester.id, { op: "ai_saas_remediation_execute", remediationId })) });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().remediation).toMatchObject({ status: "succeeded", outcomeCode: "deleted", vendorStatus: 200 });
    expect(vendor.deletes).toEqual([{ url: `https://api.anthropic.com/v1/compliance/apps/chats/${CHAT_OK}`, key: `del-${RUN}` }]);
    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(a!.status).toBe("consumed");
    const twice = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${remediationId}/execute`, ...(await relax(people.requester.id, { op: "ai_saas_remediation_execute", remediationId })) });
    expect(twice.statusCode).toBe(409);
    expect(vendor.deletes).toHaveLength(1);
    const trail = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "ai_saas_remediation"), eq(auditLog.objectId, remediationId)));
    const moves = trail.filter((t) => t.ruleId === AI_SAAS_REMEDIATION_RULE_IDS.transitioned).map((t) => (t.detail as { transition: { to: string } }).transition.to);
    expect(moves).toEqual(expect.arrayContaining(["approved", "executing", "succeeded"]));
    expect(JSON.stringify(trail)).not.toContain(`del-${RUN}`);
  });

  it("a timed-out delete is unknown, then settled by reading the conversation, never by a second delete", async () => {
    const R = people.requester;
    const interactionId = await interactionOf(CHAT_SLOW);
    const res = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/remediations", ...(await relax(R.id, { op: "ai_saas_remediation", interactionId, action: "delete_conversation" })), payload: { interactionId, action: "delete_conversation", approverUserId: people.approver.id, reason: "leaked customer data" } });
    const { id, approvalId: aid } = res.json().remediation;
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${aid}/decide`, ...(await decideAs(people.approver.id, aid)), payload: { decision: "approved", reason: "ok" } })).statusCode).toBe(200);
    const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${id}/execute`, ...(await relax(R.id, { op: "ai_saas_remediation_execute", remediationId: id })) });
    expect(run.statusCode).toBe(202);
    expect(run.json().remediation).toMatchObject({ status: "unknown", outcomeCode: "outcome_unknown" });
    const deletesBefore = vendor.deletes.length;
    const settled = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/remediations/${id}/settle`, ...(await relax(R.id, { op: "ai_saas_remediation_settle", remediationId: id })) });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().remediation).toMatchObject({ status: "succeeded", outcomeCode: "verified_absent" });
    expect(vendor.deletes).toHaveLength(deletesBefore);
  });

  it("the stored states are exactly the declared machine's", async () => {
    const rows = await db.select({ status: aiSaasRemediations.status }).from(aiSaasRemediations).where(eq(aiSaasRemediations.connectorId, connectorId));
    for (const r of rows) expect(AI_SAAS_REMEDIATION_MACHINE.isState(r.status)).toBe(true);
    const list = await app.inject({ method: "GET", url: "/v1/ai-saas-monitoring/remediations", headers: people.requester.key });
    expect(list.json().machine.id).toBe("ai_saas_remediation");
  });
});
