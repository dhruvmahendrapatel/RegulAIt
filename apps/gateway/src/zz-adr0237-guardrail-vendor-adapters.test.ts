/**
 * ADR-0237 — native adapters for third-party guardrail providers, end to end.
 *
 * No real vendor is called and no real key exists: the three vendor APIs are
 * stood in for by an injected fetch (the egress guard's test seam) that answers
 * in each vendor's documented reply shape, behind the REAL egress guard (the
 * vendor hosts are allow-listed and resolve, through an injected resolver, to a
 * public address) and the REAL dispatch path (`/v1/agents/:id/invoke`).
 *
 * What this file pins:
 *  1. REGISTRATION: a vendor adapter needs a key, claims guardrail kinds only,
 *     and the key is never echoed.
 *  2. ENABLING IS A STEP-UP: an admin API key is refused with settings_relax.
 *  3. EACH ADAPTER BLOCKS on a hit through ADR-0220, the vendor saw its own
 *     dialect and its own auth header, and the call is attributed (usage_events,
 *     the scorer's price, the calling user) and audited without text or key.
 *  4. FAIL CLOSED: a vendor 500, and a Lakera policy that ran no detector for
 *     the kind, both block; a failed call is recorded unpriced.
 *  5. AIR-GAPPED REFUSES: registration, enable and the call itself, with no
 *     request sent.
 *
 * Shared-state discipline: objects are `gva-` prefixed; the trained-detector
 * rows, this file's scorers and allow-list entries are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  externalScorers,
  guardrailTrainedDetectors,
  inArray,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async () => ({
        outputText: "An ordinary answer about quarterly planning.",
        stopReason: "end_turn",
        refusal: false,
        usage: { inputTokens: 10, outputTokens: 10 },
        providerMessageId: "gva-mock-1",
      });
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { relaxDataPostureForTest } = await import("./testing/strict-data-posture.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "gva-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);
const SECRET_PROMPT = `gva-secret-prompt-${RUN}`;
const KEYS = { openai: `sk-gva-openai-${RUN}`, azure: `azkey-gva-${RUN}-0000`, lakera: `sk-gva-lakera-${RUN}` };
const HOSTS = {
  openai: `openai-${RUN}.gva-vendor-mock.com`,
  azure: `azure-${RUN}.gva-vendor-mock.com`,
  lakera: `lakera-${RUN}.gva-vendor-mock.com`,
};

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;
let adminKeyAuth: { authorization: string };
const scorerIds: Record<"openai" | "azure" | "lakera", string> = { openai: "", azure: "", lakera: "" };
const allowIds: string[] = [];
let restoreGates: () => Promise<void> = async () => {};
let restorePosture: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};

interface Seen {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
let vendorMode: "ok" | "http500" | "no_detector" = "ok";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** the three vendor APIs, in their documented reply shapes */
const vendorFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  seen.push({ host: url.hostname, path: `${url.pathname}${url.search}`, headers, body });
  if (vendorMode === "http500") return new Response(`upstream fell over reading ${JSON.stringify(body)}`, { status: 500 });
  const text = JSON.stringify(body);
  const attack = text.includes("<<gva-attack>>");
  const harm = text.includes("<<gva-harm>>");
  if (url.hostname === HOSTS.openai) {
    return json(200, {
      id: "modr-1",
      model: "omni-moderation-latest",
      results: [{ flagged: harm, categories: { violence: harm }, category_scores: { violence: harm ? 0.93 : 0.01, hate: 0.01 } }],
    });
  }
  if (url.hostname === HOSTS.azure) {
    if (url.pathname.endsWith("text:shieldPrompt")) return json(200, { userPromptAnalysis: { attackDetected: attack }, documentsAnalysis: [] });
    return json(200, { blocklistsMatch: [], categoriesAnalysis: [{ category: "Violence", severity: harm ? 6 : 0 }, { category: "Hate", severity: 0 }] });
  }
  if (url.hostname === HOSTS.lakera) {
    if (vendorMode === "no_detector") return json(200, { flagged: false, breakdown: [{ detector_type: "moderated_content/hate", detected: false }] });
    return json(200, {
      flagged: attack,
      breakdown: [
        { detector_type: "prompt_attack", detected: attack, result: attack ? "l1_confident" : "l5_unlikely" },
        { detector_type: "pii/email", detected: false },
      ],
    });
  }
  return new Response("no such vendor", { status: 404 });
}) as typeof fetch;

/** every vendor host resolves to one public address (nothing is actually connected: the fetch is injected) */
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(guardrailTrainedDetectors);
  restorePosture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), trainedDetectorResolve: resolve, trainedDetectorFetch: vendorFetch });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });

  for (const host of Object.values(HOSTS)) {
    const allow = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host, note: "gva suite: mock vendor" } }),
    );
    expect(allow.statusCode, allow.body).toBe(201);
    allowIds.push(allow.json().id);
  }

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `gva-user-${RUN}@example.com`, displayName: "gva user" } });
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "gva" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `gva-agent-${RUN}`, provider: "mock", model: "mock-balanced", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  agentId = a.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId } });

  const adm = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `gva-admin-${RUN}@example.com`, displayName: "gva admin", isAdmin: true },
  });
  const key = await app.inject({ method: "POST", url: `/v1/users/${adm.json().id}/keys`, headers: AUTH, payload: { name: "gva" } });
  adminKeyAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  const removals = [];
  for (const id of allowIds) removals.push(await removeEgressAllowEntry(app, AUTH, { id }));
  try {
    delete process.env.REGULAIT_DEPLOY_MODE;
    await db.delete(guardrailTrainedDetectors);
    const ids = Object.values(scorerIds).filter(Boolean);
    if (ids.length) await db.delete(externalScorers).where(inArray(externalScorers.id, ids));
    await restoreGates();
    await restorePosture();
    await restoreIdentity();
    await app.close();
  } finally {
    for (const r of removals) r.assertRemoved();
  }
});

const register = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/external-scorers", headers: AUTH, payload });
const invoke = (input: string) =>
  app.inject({ method: "POST", url: `/v1/agents/${agentId}/invoke`, headers: userAuth, payload: { mode: "execute", input, dispatch: true } });
const putDetector = (kind: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/v1/guardrails/trained-detectors/${kind}`, headers: AUTH, payload });

async function testAndEnable(id: string) {
  const t = await app.inject({ method: "POST", url: `/v1/external-scorers/${id}/test`, headers: AUTH });
  expect(t.statusCode, t.body).toBe(200);
  const en = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: `/v1/external-scorers/${id}/enabled`, headers: AUTH, payload: { enabled: true } }),
  );
  expect(en.statusCode, en.body).toBe(200);
}

async function vendorUsage(id: string) {
  const [row] = await db.select().from(externalScorers).where(eq(externalScorers.id, id));
  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "external_scorer"), eq(auditLog.objectId, id)))
    .orderBy(desc(auditLog.at));
  return { row: row!, audits };
}

describe("ADR-0237 third-party guardrail adapters", () => {
  it("registration: needs a key, guardrail kinds only, HTTPS only; the key is never echoed", async () => {
    expect((await register({ name: `gva-nokey-${RUN}`, baseUrl: `https://${HOSTS.lakera}`, adapter: "lakera_guard", scorerKinds: ["guardrail_pii"] })).json().error).toBe(
      "api_key_required",
    );
    expect(
      (await register({ name: `gva-eval-${RUN}`, baseUrl: `https://${HOSTS.lakera}`, apiKey: KEYS.lakera, adapter: "lakera_guard", scorerKinds: ["llm_as_judge"] })).statusCode,
    ).toBe(400);

    const o = await register({
      name: `gva-openai-${RUN}`,
      baseUrl: `https://${HOSTS.openai}/v1`,
      apiKey: KEYS.openai,
      adapter: "openai_moderation",
      scorerKinds: ["guardrail_harm"],
      pricePerCallUsd: 0,
    });
    expect(o.statusCode, o.body).toBe(201);
    scorerIds.openai = o.json().id;
    const az = await register({
      name: `gva-azure-${RUN}`,
      baseUrl: `https://${HOSTS.azure}`,
      apiKey: KEYS.azure,
      adapter: "azure_content_safety",
      scorerKinds: ["guardrail_harm", "guardrail_prompt_injection"],
      pricePerCallUsd: 0.00075,
    });
    expect(az.statusCode, az.body).toBe(201);
    scorerIds.azure = az.json().id;
    const lk = await register({
      name: `gva-lakera-${RUN}`,
      baseUrl: `https://${HOSTS.lakera}`,
      apiKey: KEYS.lakera,
      adapter: "lakera_guard",
      adapterOptions: { projectId: `project-${RUN}` },
      scorerKinds: ["guardrail_prompt_injection", "guardrail_pii"],
      pricePerCallUsd: 0.001,
    });
    expect(lk.statusCode, lk.body).toBe(201);
    scorerIds.lakera = lk.json().id;
    expect(lk.json()).toMatchObject({ adapter: "lakera_guard", enabled: false, hasApiKey: true });

    const list = await app.inject({ method: "GET", url: "/v1/external-scorers", headers: AUTH });
    for (const key of Object.values(KEYS)) expect(list.body).not.toContain(key);
    expect(list.body).not.toContain("keyCiphertext");
  });

  it("the connection test speaks each dialect with its own auth header, and is attributed and audited", async () => {
    seen.length = 0;
    for (const id of Object.values(scorerIds)) {
      const t = await app.inject({ method: "POST", url: `/v1/external-scorers/${id}/test`, headers: AUTH });
      expect(t.statusCode, t.body).toBe(200);
    }
    const byHost = (h: string) => seen.find((s) => s.host === h)!;
    expect(byHost(HOSTS.openai).path).toBe("/v1/moderations");
    expect(byHost(HOSTS.openai).headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(byHost(HOSTS.azure).headers["ocp-apim-subscription-key"]).toBe(KEYS.azure);
    expect(byHost(HOSTS.azure).headers.authorization).toBeUndefined();
    expect(byHost(HOSTS.lakera).path).toBe("/v2/guard");
    expect(byHost(HOSTS.lakera).headers.authorization).toBe(`Bearer ${KEYS.lakera}`);
    expect(byHost(HOSTS.lakera).body).toMatchObject({ breakdown: true, project_id: `project-${RUN}` });

    const usage = await db.select().from(usageEvents).where(eq(usageEvents.objectType, "guardrail_scorer")).orderBy(desc(usageEvents.at)).limit(3);
    expect(usage.map((u) => u.provider).sort()).toEqual(["azure", "lakera", "openai"]);
    const { audits } = await vendorUsage(scorerIds.lakera);
    const call = audits.find((a) => a.ruleId === "guardrail-vendor-call")!;
    expect(call.detail).toMatchObject({ adapter: "lakera_guard", source: "connection_test", ok: true });
    for (const key of Object.values(KEYS)) expect(JSON.stringify(audits)).not.toContain(key);
  });

  it("enabling a vendor adapter needs a settings_relax step-up", async () => {
    const refused = await app.inject({
      method: "POST",
      url: `/v1/external-scorers/${scorerIds.azure}/enabled`,
      headers: adminKeyAuth,
      payload: { enabled: true },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    for (const id of Object.values(scorerIds)) await testAndEnable(id);
    const { audits } = await vendorUsage(scorerIds.azure);
    expect(audits.find((a) => a.ruleId === "external-scorer-enabled")?.detail).toMatchObject({ adapter: "azure_content_safety", stepUp: "settings_relax" });
  });

  it("Azure harm blocks a harmful prompt, attributed to the caller at the scorer's price", async () => {
    expect((await putDetector("harm", { enabled: true, scorerId: scorerIds.azure })).statusCode).toBe(200);
    seen.length = 0;
    const res = await invoke(`<<gva-harm>> ${SECRET_PROMPT}`);
    expect(res.statusCode, res.body).toBe(403);
    expect(seen.some((s) => s.host === HOSTS.azure && s.path.includes("text:analyze"))).toBe(true);
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.objectType, "guardrail_scorer"), eq(usageEvents.userId, userId)))
      .orderBy(desc(usageEvents.at))
      .limit(1);
    expect(usage).toMatchObject({ provider: "azure", operation: "guardrail_harm", costUsd: 0.00075 });
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    expect(JSON.stringify(rows)).not.toContain(SECRET_PROMPT);
    expect(rows.some((r) => r.ruleId === "guardrail-vendor-call")).toBe(true);
    // a clean prompt passes
    expect((await invoke("please summarise the plan")).statusCode).toBe(200);
  });

  it("OpenAI Moderation (through the official SDK) blocks a harmful prompt", async () => {
    // switching an enabled detector to another scorer is a relaxation (ADR-0220)
    const sw = await relaxStepUpAround(db, () => putDetector("harm", { enabled: true, scorerId: scorerIds.openai }));
    expect(sw.statusCode, sw.body).toBe(200);
    seen.length = 0;
    expect((await invoke(`<<gva-harm>> ${SECRET_PROMPT}`)).statusCode).toBe(403);
    expect(seen.some((s) => s.host === HOSTS.openai && s.body.model === "omni-moderation-latest")).toBe(true);
    expect((await invoke("please summarise the plan")).statusCode).toBe(200);
    expect((await relaxStepUpAround(db, () => putDetector("harm", { enabled: false }))).statusCode).toBe(200);
  });

  it("Lakera blocks a prompt attack; a policy with no injection detector fails closed", async () => {
    expect((await putDetector("prompt_injection", { enabled: true, scorerId: scorerIds.lakera })).statusCode).toBe(200);
    // the heuristic does not know this marker; only the vendor verdict can block it
    expect((await invoke(`<<gva-attack>> ${SECRET_PROMPT}`)).statusCode).toBe(403);
    expect((await invoke("please summarise the plan")).statusCode).toBe(200);
    vendorMode = "no_detector";
    try {
      expect((await invoke("please summarise the plan")).statusCode).toBe(403);
    } finally {
      vendorMode = "ok";
    }
  });

  it("a vendor 500 fails closed and is recorded unpriced, without the reply body", async () => {
    vendorMode = "http500";
    try {
      expect((await invoke("please summarise the plan")).statusCode).toBe(403);
    } finally {
      vendorMode = "ok";
    }
    const [usage] = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.objectType, "guardrail_scorer"), eq(usageEvents.userId, userId)))
      .orderBy(desc(usageEvents.at))
      .limit(1);
    expect(usage?.costUsd).toBeNull();
    const { audits } = await vendorUsage(scorerIds.lakera);
    const failed = audits.find((a) => a.ruleId === "guardrail-vendor-call-failed")!;
    expect(failed.detail).toMatchObject({ ok: false, errorClass: "http_error" });
    expect(JSON.stringify(failed)).not.toContain("upstream fell over");
  });

  it("long input is scanned in overlapping windows: an attack across the 10,000-character Azure boundary still blocks", async () => {
    const sw = await relaxStepUpAround(db, () => putDetector("prompt_injection", { enabled: true, scorerId: scorerIds.azure }));
    expect(sw.statusCode, sw.body).toBe(200);
    seen.length = 0;
    const straddling = "a".repeat(9_995) + "<<gva-attack>>" + "b".repeat(2_000);
    expect((await invoke(straddling)).statusCode).toBe(403);
    const shields = seen.filter((s) => s.host === HOSTS.azure && s.path.includes("text:shieldPrompt"));
    expect(shields).toHaveLength(2);
    expect(String(shields[0]!.body.userPrompt)).not.toContain("<<gva-attack>>");
    expect(String(shields[1]!.body.userPrompt)).toContain("<<gva-attack>>");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, scorerIds.azure), eq(auditLog.ruleId, "guardrail-vendor-call")))
      .orderBy(desc(auditLog.at))
      .limit(2);
    expect(rows.map((r) => (r.detail as { window?: { of: number } }).window?.of)).toEqual([2, 2]);
  });

  it("air-gapped refuses registration, enable and the call itself, sending nothing", async () => {
    process.env.REGULAIT_DEPLOY_MODE = "air_gapped";
    try {
      const r = await register({
        name: `gva-airgap-${RUN}`,
        baseUrl: `https://${HOSTS.lakera}`,
        apiKey: KEYS.lakera,
        adapter: "lakera_guard",
        scorerKinds: ["guardrail_pii"],
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("air_gapped");
      seen.length = 0;
      // the injection detector is still on: the call is refused before any request, so the dispatch fails closed
      expect((await invoke("please summarise the plan")).statusCode).toBe(403);
      expect(seen).toHaveLength(0);
      const t = await app.inject({ method: "POST", url: `/v1/external-scorers/${scorerIds.lakera}/test`, headers: AUTH });
      expect(t.statusCode).toBe(403);
      expect(seen).toHaveLength(0);
    } finally {
      delete process.env.REGULAIT_DEPLOY_MODE;
    }
  });
});
