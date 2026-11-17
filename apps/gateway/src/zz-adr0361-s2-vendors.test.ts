/**
 * ADR-0361 slice 2 — ChatGPT Enterprise and Claude Enterprise end to end on Postgres: the read-only attestation a
 * vendor without a scope probe needs, and a run that records evidence and findings with no raw text.
 *
 * The vendors are fakes (`aiSaasMonitorFetch`, with a pinned public DNS answer). Their hosts are allow-listed for this
 * file only; the policy is turned back off in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { aiSaasInteractionFindings, aiSaasInteractions, aiSaasMonitorConnectors, aiSaasMonitorPolicy, and, auditLog, createDb, eq, inArray, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { AI_SAAS_RULE_IDS } from "./ai-saas-monitor.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import type { StepUpCheckArgs } from "./step-up.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0361s2-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = Date.now();
const STORAGE = "files.adr0361-storage.example";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const recent = () => new Date(Date.now() - 2 * 86_400_000 + 3600_000).toISOString();

const jsonl = [
  { event_id: `${RUN}-e1`, type: "CONVERSATION_MESSAGE", timestamp: recent(), actor: { user_id: "user-1" }, message: { id: "m1", created_at: recent(), author: { type: "user" }, content: { type: "text", value: `send it to jane.s2.${RUN}@example.com` } }, conversation: { id: "c1" } },
  { event_id: `${RUN}-e2`, type: "CONVERSATION_MESSAGE", timestamp: recent(), actor: { user_id: "user-1" }, message: { id: "m2", created_at: recent(), author: { type: "assistant" }, content: { type: "text", value: "Sent." } }, conversation: { id: "c1" } },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.chatgpt.com") {
    if (url.pathname === "/v1/compliance/workspaces/ws-s2/logs") {
      if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_end_time: null });
      return json({ data: [{ id: "log-1", event_type: "CONVERSATION_MESSAGE", end_time: recent(), file_sha256: createHash("sha256").update(jsonl).digest("hex") }], has_more: false, last_end_time: recent() });
    }
    if (url.pathname === "/v1/compliance/workspaces/ws-s2/logs/log-1") return new Response(null, { status: 307, headers: { location: `https://${STORAGE}/log-1?sig=${RUN}` } });
  }
  if (url.hostname === STORAGE) return new Response(jsonl, { status: 200 });
  if (url.hostname === "api.anthropic.com") {
    if (url.pathname === "/v1/compliance/apps/chats") {
      if (url.searchParams.get("limit") === "1") return json({ data: [], has_more: false, last_id: null });
      return json({ data: [{ id: `claude_chat_${RUN}`, updated_at: recent(), user: { id: "user_xyz" } }], has_more: false, last_id: "c1" });
    }
    if (url.pathname === `/v1/compliance/apps/chats/claude_chat_${RUN}/messages`) {
      return json({ id: `claude_chat_${RUN}`, user: { id: "user_xyz" }, chat_messages: [{ id: `${RUN}-cm1`, role: "user", created_at: recent(), content: [{ type: "text", text: `card 4111 1111 1111 1111 for ${RUN}` }] }], has_more: false, last_id: null });
    }
  }
  return json({ error: "unexpected" }, 599);
}) as typeof fetch;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const allowed = trackEgressAllowHosts();
const stepped = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));

/** create, store a credential (with or without the attestation), enable, and return the connector id */
async function connector(vendor: string, config: Record<string, unknown>): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: KEY, payload: { vendor, name: `adr0361s2-${RUN}-${vendor}`, config, reason: "pilot tenant" } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().connector.id as string;
  const unattested = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${id}/credential`, ...(await stepped({ aiSaasConnector: id, values: { credential: "store" } })), payload: { secret: `key-${RUN}-${vendor}`, replacesCredentialId: null, reason: "pilot key" } });
  expect(unattested.statusCode).toBe(409);
  expect(unattested.json().error).toBe("read_only_attestation_required");
  const stored = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${id}/credential`, ...(await stepped({ aiSaasConnector: id, values: { credential: "store" } })), payload: { secret: `key-${RUN}-${vendor}`, replacesCredentialId: null, attestReadOnly: true, reason: "pilot key" } });
  expect(stored.statusCode, stored.body).toBe(201);
  const [a] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.credentialStored), eq(auditLog.objectId, stored.json().credential.id)));
  expect(a?.detail).toMatchObject({ readOnlyAttested: true });
  const enabled = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${id}/enabled`, ...(await stepped({ aiSaasConnector: id, values: { enabled: true } })), payload: { enabled: true, reason: "go live" } });
  expect(enabled.statusCode, enabled.body).toBe(200);
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, aiSaasMonitorFetch: fakeFetch, aiSaasMonitorResolve: async () => [{ address: "93.184.216.34", family: 4 }] });
  for (const host of ["api.chatgpt.com", STORAGE, "api.anthropic.com"]) {
    const res = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost(host), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0361s2 ${RUN}` } }),
    );
    expect([201, 409], res.body).toContain(res.statusCode);
  }
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0361s2-admin-${RUN}@example.com`, displayName: "monitor admin", isAdmin: true } });
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0361s2" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  await db.insert(aiSaasMonitorPolicy).values({ id: "singleton", enabled: true, contentCapture: "none" }).onConflictDoUpdate({ target: aiSaasMonitorPolicy.id, set: { enabled: true, contentCapture: "none" } });
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    await db.update(aiSaasMonitorPolicy).set({ enabled: false, contentCapture: "none" });
    await db.update(aiSaasMonitorConnectors).set({ enabled: false }).where(sql`${aiSaasMonitorConnectors.name} like ${`adr0361s2-${RUN}%`}`);
    for (const r of restores.reverse()) await r();
    await app?.close();
  } finally {
    entries.assertRemoved();
  }
});

describe("ADR-0361 slice 2 vendors", () => {
  it("ChatGPT Enterprise: an attested key, the signed download, evidence and a PII finding, no raw text", async () => {
    const id = await connector("chatgpt_enterprise", { principal: "workspace", principalId: "ws-s2", backfillDays: 2 });
    const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${id}/runs`, headers: KEY });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().run).toMatchObject({ status: "succeeded", interactionsNew: 2 });
    const rows = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.connectorId, id));
    expect(rows.map((r) => [r.vendorInteractionId, r.kind]).sort()).toEqual([[`${RUN}-e1`, "prompt"], [`${RUN}-e2`, "response"]]);
    const findings = await db.select().from(aiSaasInteractionFindings).where(inArray(aiSaasInteractionFindings.interactionId, rows.map((r) => r.id)));
    expect(findings.some((f) => f.detector === "pii" && f.category === "email")).toBe(true);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "ai_saas_interaction"), inArray(auditLog.objectId, rows.map((r) => r.id))));
    expect(JSON.stringify(audit)).not.toContain(`jane.s2.${RUN}`);
    // the signed URL is a credential: it never reaches the run row or its audit row
    const runs = await app.inject({ method: "GET", url: `/v1/ai-saas-monitoring/connectors/${id}/runs`, headers: KEY });
    expect(runs.body).not.toContain(`sig=${RUN}`);
  });

  it("Claude Enterprise: an attested key, org-wide polling, evidence and a card finding", async () => {
    const id = await connector("claude_enterprise", { organizationIds: [], backfillDays: 2 });
    const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${id}/runs`, headers: KEY });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().run).toMatchObject({ status: "succeeded", interactionsNew: 1 });
    const [row] = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.vendorInteractionId, `${RUN}-cm1`));
    expect(row).toMatchObject({ kind: "prompt", actorRef: "user_xyz", conversationRef: `claude_chat_${RUN}`, contentCiphertext: null });
    const findings = await db.select().from(aiSaasInteractionFindings).where(eq(aiSaasInteractionFindings.interactionId, row!.id));
    expect(findings.some((f) => f.detector === "pii" && f.category === "credit_card")).toBe(true);
  });
});
