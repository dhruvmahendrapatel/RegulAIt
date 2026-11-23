/**
 * ADR-0361 slice 1 — monitoring Microsoft 365 Copilot through the Graph interaction export, end to end on Postgres.
 *
 * The vendor is a fake (`aiSaasMonitorFetch`, the guarded fetch's test seam, with a pinned public DNS answer). The two
 * Microsoft hosts are put on the egress allow-list for this file only and removed in afterAll. Fixtures are named by
 * this run's id; the policy is turned back off in afterAll so no other file's scheduler pass reads anything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiSaasInteractionFindings,
  aiSaasInteractions,
  aiSaasMonitorConnectorTags,
  aiSaasMonitorConnectors,
  aiSaasMonitorCredentials,
  aiSaasMonitorPolicy,
  aiSaasMonitorRuns,
  and,
  auditLog,
  complianceProfiles,
  createDb,
  eq,
  inArray,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import {
  AI_SAAS_MONITOR_MANUAL_RUNS_PER_MINUTE,
  AI_SAAS_RULE_IDS,
  cascadeForTags,
  cascadeLoosens,
  runAiSaasEvidenceRetentionSweep,
  runAiSaasMonitor,
  runAiSaasMonitorSweep,
} from "./ai-saas-monitor.js";
import { ConnectorError, type ComplianceConnector } from "./ai-saas-connectors.js";
import { encryptSecret } from "./secrets.js";
import { retentionFloor } from "./org-settings.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import type { StepUpCheckArgs } from "./step-up.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0361-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = Date.now();
const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_A = "9fcefe95-9677-483e-a3c1-22c5d501d737";
const SECRET = `client-secret-${RUN}`;
const TAG = `adr0361-${RUN}`;
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** the fake vendor: its roles and pages are swapped per test */
const vendor = {
  roles: ["AiEnterpriseInteraction.Read.All"],
  pages: [] as unknown[][],
  graphCalls: 0,
};
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "login.microsoftonline.com") {
    if (url.pathname.endsWith("/discovery/instance")) {
      return json({
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
        "api-version": "1.1",
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      });
    }
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json({
        token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
        jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: jwt({ roles: vendor.roles, tid: TENANT, n: RUN }) });
    }
  }
  if (url.hostname === "graph.microsoft.com") {
    vendor.graphCalls += 1;
    const page = Number(url.searchParams.get("$skiptoken") ?? "0");
    const value = vendor.pages[page] ?? [];
    const next = page + 1 < vendor.pages.length ? `https://graph.microsoft.com${url.pathname}?$skiptoken=${page + 1}` : undefined;
    return json({ value, ...(next ? { "@odata.nextLink": next } : {}) });
  }
  return json({ error: "unexpected" }, 599);
}) as typeof fetch;

const interaction = (id: string, kind: "userPrompt" | "aiResponse", content: string) => ({
  id: `${RUN}-${id}`,
  sessionId: `19:${RUN}@thread.v2`,
  appClass: "IPM.SkypeTeams.Message.Copilot.BizChat",
  interactionType: kind,
  createdDateTime: new Date(Date.now() - 3600_000).toISOString(),
  from: kind === "userPrompt" ? { user: { id: USER_A } } : { application: { id: "fb8d773d-7ef8-4ec0-a117-179f88add510", displayName: "Microsoft 365 Chat" } },
  body: { contentType: "text", content },
  attachments: [],
});

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let connectorId: string;
let credentialId: string;
const restores: Array<() => Promise<void>> = [];
const allowed = trackEgressAllowHosts();

const stepped = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const config = { tenantId: TENANT, clientId: CLIENT, users: { mode: "listed", ids: [USER_A] }, appClasses: [], backfillDays: 2 };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, aiSaasMonitorFetch: fakeFetch, aiSaasMonitorResolve: resolve });
  for (const host of ["graph.microsoft.com", "login.microsoftonline.com"]) {
    const res = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost(host), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0361 ${RUN}` } }),
    );
    expect([201, 409], res.body).toContain(res.statusCode);
  }
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0361-admin-${RUN}@example.com`, displayName: "monitor admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0361" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  await db.insert(complianceProfiles).values({ tag: TAG, piiMode: "warn", auditRetentionDays: 400 });
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    await db.update(aiSaasMonitorPolicy).set({ enabled: false, contentCapture: "none" });
    await db.update(aiSaasMonitorConnectors).set({ enabled: false }).where(sql`${aiSaasMonitorConnectors.name} like ${`adr0361-${RUN}%`}`);
    await db.delete(aiSaasMonitorConnectorTags).where(eq(aiSaasMonitorConnectorTags.profileTag, TAG));
    await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, TAG));
    for (const r of restores.reverse()) await r();
    await app?.close();
  } finally {
    entries.assertRemoved();
  }
});

describe("ADR-0361 three switches, all off", () => {
  it("is off by default and says what it is", async () => {
    await db.update(aiSaasMonitorPolicy).set({ enabled: false, contentCapture: "none" });
    const res = await app.inject({ method: "GET", url: "/v1/ai-saas-monitoring", headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.policy).toMatchObject({ enabled: false, contentCapture: "none" });
    expect(body.catalogue.find((c: { vendor: string }) => c.vendor === "m365_copilot")).toMatchObject({ built: true, hosts: ["graph.microsoft.com", "login.microsoftonline.com"] });
    expect(body.statement).toContain("nothing is pooled");
  });

  it("is admin-only", async () => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0361-user-${RUN}@example.com`, displayName: "plain user" } });
    const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "plain" } });
    const res = await app.inject({ method: "GET", url: "/v1/ai-saas-monitoring", headers: { authorization: `Bearer ${k.json().token}` } });
    expect(res.statusCode).toBe(403);
  });

  it("turning it on needs a step-up and is refused when air-gapped", async () => {
    const plain = await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/policy", headers: KEY, payload: { enabled: true, reason: "pilot monitoring" } });
    expect(plain.statusCode).toBe(403);
    const prev = process.env.REGULAIT_DEPLOY_MODE;
    process.env.REGULAIT_DEPLOY_MODE = "air_gapped";
    try {
      const gapped = await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/policy", headers: KEY, payload: { enabled: true, reason: "pilot monitoring" } });
      expect(gapped.statusCode).toBe(409);
      expect(gapped.json().error).toBe("ai_saas_monitor_air_gapped");
    } finally {
      if (prev === undefined) delete process.env.REGULAIT_DEPLOY_MODE;
      else process.env.REGULAIT_DEPLOY_MODE = prev;
    }
    const s = await stepped({ aiSaasMonitoring: true, values: { enabled: true } });
    const ok = await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/policy", ...s, payload: { enabled: true, reason: "pilot monitoring" } });
    expect(ok.statusCode, ok.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.policyChanged), eq(auditLog.userId, adminId))).limit(1);
    expect(row?.reason).toContain("off -> on");
  });

  it("a new connector is disabled, validated, and tagged only with real profiles", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: KEY, payload: { vendor: "m365_copilot", name: `adr0361-${RUN}-bad`, config: { ...config, tenantId: "contoso" }, reason: "pilot tenant" } });
    expect(bad.statusCode).toBe(400);
    const badGpt = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: KEY, payload: { vendor: "chatgpt_enterprise", name: `adr0361-${RUN}-gpt`, config: {}, reason: "pilot tenant" } });
    expect(badGpt.statusCode).toBe(400);
    const unknownTag = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: KEY, payload: { vendor: "m365_copilot", name: `adr0361-${RUN}-tag`, config, complianceTags: [`nope-${RUN}`], reason: "pilot tenant" } });
    expect(unknownTag.statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url: "/v1/ai-saas-monitoring/connectors", headers: KEY, payload: { vendor: "m365_copilot", name: `adr0361-${RUN}`, config, complianceTags: [TAG], reason: "pilot tenant" } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().connector).toMatchObject({ enabled: false, credential: null, complianceTags: [TAG], remediation: "none" });
    connectorId = res.json().connector.id;
  });

  it("stores the credential under a step-up, never returns it, and enabling needs a step-up", async () => {
    const plain = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, headers: KEY, payload: { secret: SECRET, replacesCredentialId: null, reason: "pilot app" } });
    expect(plain.statusCode).toBe(403);
    const s = await stepped({ aiSaasConnector: connectorId, values: { credential: "store" } });
    const stored = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...s, payload: { secret: SECRET, replacesCredentialId: null, reason: "pilot app" } });
    expect(stored.statusCode, stored.body).toBe(201);
    credentialId = stored.json().credential.id;
    const [row] = await db.select().from(aiSaasMonitorCredentials).where(eq(aiSaasMonitorCredentials.id, credentialId));
    expect(row!.secretCiphertext).not.toContain(SECRET);
    const list = await app.inject({ method: "GET", url: "/v1/ai-saas-monitoring", headers: KEY });
    expect(list.body).not.toContain(SECRET);
    const enablePlain = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/enabled`, headers: KEY, payload: { enabled: true, reason: "go live" } });
    expect(enablePlain.statusCode).toBe(403);
    const e = await stepped({ aiSaasConnector: connectorId, values: { enabled: true } });
    const enabled = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/enabled`, ...e, payload: { enabled: true, reason: "go live" } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().connector.enabled).toBe(true);
  });
});

describe("ADR-0361 a run: evidence, findings, audit", () => {
  it("records each interaction once, scans it, and keeps no text by default", async () => {
    vendor.pages = [
      [interaction("p1", "userPrompt", `Summarise the contract and email it to jane.doe.${RUN}@example.com please`), interaction("r1", "aiResponse", "Here is a summary of the contract.")],
      [interaction("p2", "userPrompt", "What is on my calendar?")],
    ];
    const res = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().run).toMatchObject({ status: "succeeded", interactionsSeen: 3, interactionsNew: 3, pages: 2, usersRead: 1 });
    const rows = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.connectorId, connectorId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.contentCiphertext === null && /^[0-9a-f]{64}$/.test(r.contentSha256))).toBe(true);
    const p1 = rows.find((r) => r.vendorInteractionId === `${RUN}-p1`)!;
    expect(p1).toMatchObject({ kind: "prompt", actorRef: USER_A, appRef: "IPM.SkypeTeams.Message.Copilot.BizChat" });
    const findings = await db.select().from(aiSaasInteractionFindings).where(eq(aiSaasInteractionFindings.interactionId, p1.id));
    // the connector's tag sets PII mode `warn` (the cascade), so the email is a warn finding
    expect(findings).toContainEqual({ interactionId: p1.id, detector: "pii", category: "email", hitCount: 1, action: "warn" });
    const [auditRow] = await db.select().from(auditLog).where(and(eq(auditLog.objectType, "ai_saas_interaction"), eq(auditLog.objectId, p1.id)));
    expect(auditRow?.ruleId).toBe(AI_SAAS_RULE_IDS.interactionFinding);
    expect(JSON.stringify(auditRow)).not.toContain(`jane.doe.${RUN}`);
    const listed = await app.inject({ method: "GET", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/interactions?withFindings=true`, headers: KEY });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().interactions.map((i: { id: string }) => i.id)).toContain(p1.id);
    expect(listed.body).not.toContain(`jane.doe.${RUN}`);
    // with capture off nothing returned text, so the read is not a content read and writes no audit row
    const reads = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.interactionContentRead), eq(auditLog.objectId, connectorId)));
    expect(reads).toHaveLength(0);
  });

  it("a re-run of an overlapping window writes nothing twice", async () => {
    await db.update(aiSaasMonitorConnectors).set({ monitoredThrough: null }).where(eq(aiSaasMonitorConnectors.id, connectorId));
    const res = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: KEY });
    expect(res.json().run).toMatchObject({ status: "succeeded", interactionsSeen: 3, interactionsNew: 0 });
  });

  it("redacted capture is a step-up; the stored copy has no PII and only an admin reads it", async () => {
    const s = await stepped({ aiSaasMonitoring: true, values: { contentCapture: "redacted" } });
    const ok = await app.inject({ method: "PUT", url: "/v1/ai-saas-monitoring/policy", ...s, payload: { enabled: true, contentCapture: "redacted", reason: "investigations" } });
    expect(ok.statusCode, ok.body).toBe(200);
    vendor.pages = [[interaction("p3", "userPrompt", `call me on jane.doe.${RUN}@example.com tomorrow`)]];
    const res = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: KEY });
    expect(res.json().run.interactionsNew).toBe(1);
    const [row] = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.vendorInteractionId, `${RUN}-p3`));
    expect(row!.contentCiphertext).not.toBeNull();
    const listed = await app.inject({ method: "GET", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/interactions`, headers: KEY });
    const p3 = listed.json().interactions.find((i: { id: string }) => i.id === row!.id);
    expect(p3.redactedContent).toBe("call me on [EMAIL] tomorrow");
    // reading captured text is audited: who read which interactions, never the text (review R7 [4], security S1)
    const [read] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.interactionContentRead), eq(auditLog.objectId, connectorId))).limit(1);
    expect(read?.userId).toBe(adminId);
    expect(JSON.stringify(read)).toContain(row!.id);
    expect(JSON.stringify(read)).not.toContain("tomorrow");
  });

  it("the evidence is append-only: no update, no delete, no truncate", async () => {
    const [row] = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.connectorId, connectorId)).limit(1);
    await expect(db.update(aiSaasInteractions).set({ kind: "other" }).where(eq(aiSaasInteractions.id, row!.id))).rejects.toThrow();
    await expect(db.delete(aiSaasInteractions).where(eq(aiSaasInteractions.id, row!.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE ai_saas_interactions CASCADE`)).rejects.toThrow();
    await expect(db.update(aiSaasInteractionFindings).set({ hitCount: 99 })).rejects.toThrow();
  });

  it("a forged future retention cutoff deletes nothing", async () => {
    const [row] = await db.select().from(aiSaasInteractions).where(eq(aiSaasInteractions.connectorId, connectorId)).limit(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('regulait.ai_saas_retention_cutoff', ${new Date(Date.now() + 86_400_000).toISOString()}, true)`);
        await tx.delete(aiSaasInteractions).where(eq(aiSaasInteractions.id, row!.id));
      }),
    ).rejects.toThrow();
  });

  it("a credential that can write is refused, never used again, and the connector disabled", async () => {
    vendor.roles = ["AiEnterpriseInteraction.Read.All", "Sites.ReadWrite.All"];
    const before = vendor.graphCalls;
    const res = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: KEY });
    expect(res.statusCode).toBe(502);
    expect(res.json().run).toMatchObject({ status: "failed", errorCode: "credential_refused" });
    expect(vendor.graphCalls).toBe(before);
    const [cred] = await db.select().from(aiSaasMonitorCredentials).where(eq(aiSaasMonitorCredentials.id, credentialId));
    expect(cred!.scopePosture).toBe("refused");
    const [c] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, connectorId));
    expect(c!.enabled).toBe(false);
    const e = await stepped({ aiSaasConnector: connectorId, values: { enabled: true } });
    const again = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/enabled`, ...e, payload: { enabled: true, reason: "retry" } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("credential_refused");
    vendor.roles = ["AiEnterpriseInteraction.Read.All"];
  });

  it("rotation replaces the credential; revoking needs no step-up and disables the connector", async () => {
    const s = await stepped({ aiSaasConnector: connectorId, values: { credential: "store" } });
    const conflict = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...s, payload: { secret: `${SECRET}-2`, replacesCredentialId: null, reason: "rotate" } });
    expect(conflict.statusCode).toBe(409);
    const s2 = await stepped({ aiSaasConnector: connectorId, values: { credential: "store" } });
    const rotated = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, ...s2, payload: { secret: `${SECRET}-2`, replacesCredentialId: credentialId, reason: "rotate" } });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const [old] = await db.select().from(aiSaasMonitorCredentials).where(eq(aiSaasMonitorCredentials.id, credentialId));
    expect(old).toMatchObject({ secretCiphertext: null });
    expect(old!.revokedAt).not.toBeNull();
    const revoked = await app.inject({ method: "DELETE", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/credential`, headers: KEY, payload: { reason: "offboard" } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const run = await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers: KEY });
    expect(run.statusCode).toBe(409);
    expect(run.json().run.errorCode).toBe("disabled");
  });

  it("the scheduled sweep runs nothing while the policy is off", async () => {
    await db.update(aiSaasMonitorPolicy).set({ enabled: false });
    expect(await runAiSaasMonitorSweep(db, { dataKey: DATA_KEY })).toEqual({ connectors: 0, interactionsNew: 0, failed: 0 });
  });
});

describe("ADR-0361 retention follows the compliance cascade", () => {
  it("keeps evidence for the longest of the audit floor and the connector's tags, then deletes it, audited", async () => {
    const f = await retentionFloor(db);
    expect(f.retainedDays).not.toBeNull(); // this file's profile (400 days) is a floor of its own
    const days = Math.max(f.retainedDays!, ...f.modeOverrides.map((o) => o.retainedDays), 400);
    const [run] = await db.execute<{ id: string }>(sql`SELECT id FROM ai_saas_monitor_runs WHERE connector_id = ${connectorId} LIMIT 1`).then((r) => (Array.isArray(r) ? r : (r as { rows: Array<{ id: string }> }).rows));
    const old = new Date(Date.now() - (days + 30) * 86_400_000);
    const recent = new Date(Date.now() - (days - 30) * 86_400_000);
    const ins = await db
      .insert(aiSaasInteractions)
      .values(
        [["old", old], ["recent", recent]].map(([name, at]) => ({
          connectorId,
          runId: run!.id,
          vendorInteractionId: `${RUN}-ret-${name as string}`,
          kind: "prompt" as const,
          occurredAt: at as Date,
          contentSha256: "0".repeat(64),
          contentChars: 0,
          receivedAt: at as Date,
        })),
      )
      .returning({ id: aiSaasInteractions.id, vendorInteractionId: aiSaasInteractions.vendorInteractionId });
    const out = await runAiSaasEvidenceRetentionSweep(db);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    const left = await db.select({ v: aiSaasInteractions.vendorInteractionId }).from(aiSaasInteractions).where(inArray(aiSaasInteractions.id, ins.map((i) => i.id)));
    expect(left.map((l) => l.v)).toEqual([`${RUN}-ret-recent`]);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.retentionPurged), eq(auditLog.objectId, connectorId))).limit(1);
    expect(a?.reason).toContain(`retention ${days}d`);
  });
});

describe("ADR-0361 review fixes", () => {
  it("removing a tag that holds retention is a step-up, and the audit row names both values (review R7 [3])", async () => {
    const before = await cascadeForTags(db, [TAG]);
    const after = await cascadeForTags(db, []);
    const loosens = cascadeLoosens(before, after);
    expect(loosens).toContain("retention"); // the tag's 400 days are gone
    const payload = { config, complianceTags: [], reason: "drop the profile" };
    const plain = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/config`, headers: KEY, payload });
    expect(plain.statusCode).toBe(403);
    const [tagsStill] = await db.select().from(aiSaasMonitorConnectorTags).where(eq(aiSaasMonitorConnectorTags.connectorId, connectorId));
    expect(tagsStill?.profileTag).toBe(TAG);
    const s = await stepped({ aiSaasConnector: connectorId, values: { cascade: loosens } });
    const ok = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/config`, ...s, payload });
    expect(ok.statusCode, ok.body).toBe(200);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, AI_SAAS_RULE_IDS.connectorConfigured), eq(auditLog.objectId, connectorId)));
    const last = rows.find((r) => JSON.stringify(r).includes("drop the profile"));
    expect((last?.detail as { retentionDays?: unknown } | undefined)?.retentionDays).toEqual({ from: 400, to: null });
    // putting the tag back keeps evidence longer; it needs a step-up only if it also makes the PII action less strict
    const back = cascadeLoosens(after, before);
    const s2 = back ? await stepped({ aiSaasConnector: connectorId, values: { cascade: back } }) : { headers: KEY };
    const restored = await app.inject({ method: "PUT", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/config`, ...s2, payload: { config, complianceTags: [TAG], reason: "restore the profile" } });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it("a window that holds too much is halved on each bounded failure, then advances (review R7 [1])", async () => {
    const spans: number[] = [];
    const stub: ComplianceConnector = {
      vendor: "m365_copilot",
      validateConfig: () => null,
      authorise: async () => ({ scope: "read_only", permissions: [], headers: {} }),
      async *listInteractions(_ctx: unknown, _auth: unknown, w: { start: Date; end: Date }) {
        const span = w.end.getTime() - w.start.getTime();
        spans.push(span);
        if (span > 3 * 3600_000) throw new ConnectorError("page_limit", "one user had too many pages in the window");
        yield { unit: USER_A, interactions: [] };
      },
    } as unknown as ComplianceConnector;
    const [c] = await db.insert(aiSaasMonitorConnectors).values({ vendor: "m365_copilot", name: `adr0361-${RUN}-window`, enabled: true, publicConfig: config }).returning();
    await db.insert(aiSaasMonitorCredentials).values({ connectorId: c!.id, secretCiphertext: encryptSecret(DATA_KEY, SECRET), scopePosture: "read_only" });
    await db.update(aiSaasMonitorPolicy).set({ enabled: true });
    try {
      const deps = { connectors: new Map([["m365_copilot", stub]]) as never };
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await runAiSaasMonitor(db, c!.id, { trigger: "schedule", dataKey: DATA_KEY, deps })).status);
      expect(statuses).toEqual(["failed", "failed", "failed", "succeeded"]);
      expect(spans).toEqual([24, 12, 6, 3].map((h) => h * 3600_000));
      const runs = await db.select().from(aiSaasMonitorRuns).where(eq(aiSaasMonitorRuns.connectorId, c!.id));
      // a failed run records the window it asked for, so the narrowing is visible
      expect(runs.filter((r) => r.status === "failed").every((r) => r.windowStart !== null && r.errorCode === "page_limit")).toBe(true);
      const [after] = await db.select().from(aiSaasMonitorConnectors).where(eq(aiSaasMonitorConnectors.id, c!.id));
      const ok = runs.find((r) => r.status === "succeeded")!;
      expect(after!.monitoredThrough?.getTime()).toBe(ok.windowEnd!.getTime());
      // a success resets the span
      await runAiSaasMonitor(db, c!.id, { trigger: "schedule", dataKey: DATA_KEY, deps });
      expect(spans[4]).toBe(24 * 3600_000);
    } finally {
      await db.update(aiSaasMonitorPolicy).set({ enabled: false });
      await db.update(aiSaasMonitorConnectors).set({ enabled: false }).where(eq(aiSaasMonitorConnectors.id, c!.id));
    }
  });

  it("serves the guided M365 setup checklist to an admin, and no secret (D-2026-11-22-06)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/setup`, headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    const setup = res.json().setup;
    expect(setup.vendor).toBe("m365_copilot");
    const ids = setup.steps.map((st: { id: string }) => st.id);
    expect(ids).toEqual(expect.arrayContaining(["register_app", "api_permissions", "admin_consent", "client_secret", "egress", "turn_on", "data_flowing"]));
    // this file allowed both hosts
    expect(setup.steps.find((st: { id: string }) => st.id === "egress").state).toBe("done");
    expect(res.body).not.toContain(SECRET);
  });

  it("manual runs are rate limited per admin (security S2)", async () => {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0361-limit-${RUN}@example.com`, displayName: "limit admin", isAdmin: true } });
    const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "limit" } });
    const headers = { authorization: `Bearer ${k.json().token}` };
    const codes: number[] = [];
    for (let i = 0; i <= AI_SAAS_MONITOR_MANUAL_RUNS_PER_MINUTE; i++) {
      codes.push((await app.inject({ method: "POST", url: `/v1/ai-saas-monitoring/connectors/${connectorId}/runs`, headers })).statusCode);
    }
    expect(codes.slice(0, -1).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});
