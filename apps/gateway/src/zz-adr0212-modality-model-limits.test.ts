/**
 * ADR-0212 (P12 b and c), on a real database, through the real dispatch path (the mock
 * provider, wrapped so a test can make it report a modality split as a provider would):
 *
 *  (b) - a dispatch whose provider reports image/audio tokens is priced per modality and the
 *        split is stored on the usage row;
 *      - a dispatch with no modality data is priced exactly as before and stores no split;
 *      - the cost dashboard shows the split, with unsplit spend as its own line, and the
 *        chargeback CSV carries the three modality columns;
 *      - the modality-price write is admin-only and audited old -> new.
 *  (c) - per-model limits are off by default: a limit binds nothing until enforcement is on;
 *      - turning enforcement on (and off) needs a settings_relax step-up and is audited;
 *      - a limit is hit (429 model_rate_limited, audited deny row, no usage row), and resets
 *        once the window passes; another model is not affected;
 *      - removing a limit needs the step-up and is audited.
 *
 * Runs on its OWN scratch database (prefix `m212_`), dropped in afterAll, so the org setting
 * it turns on and the rows it writes leave nothing behind (M-068).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  ORG_SETTINGS_ID,
  projects,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { priceDispatchUsage, STEP_UP_HEADER } from "@regulait/shared";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

declare global {
  // eslint-disable-next-line no-var
  var __m212Modality: boolean;
}
globalThis.__m212Modality = false;

// the mock provider reports no modality split; when the flag is on, report half the input as image
// and a quarter of the output as audio, exactly as a provider's usage block would
vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (...args: Parameters<typeof actual.resolveModelProvider>) => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        const out = await inner.dispatch(req);
        if (!globalThis.__m212Modality) return out;
        return {
          ...out,
          usage: {
            ...out.usage,
            modality: {
              image: { inputTokens: Math.floor(out.usage.inputTokens / 2), outputTokens: 0 },
              audio: { inputTokens: 0, outputTokens: Math.floor(out.usage.outputTokens / 4) },
            },
          },
        };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `m212_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `m212-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const PRICES = { costPerMTokIn: 3, costPerMTokOut: 15 };

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void>;
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };
let caller: { id: string; auth: { authorization: string } };
let other: { id: string; auth: { authorization: string } };
let pricedAgent: string;
let limitedAgent: string;
let freeAgent: string;

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const asAdmin = (method: Method, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method,
    url,
    headers: { ...CSRF, ...headers },
    cookies: { regulait_session: admin.token },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const viaKey = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: admin.key, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function grantFor(action: { kind: string; body: Record<string, unknown> }): Promise<string> {
  const o = await asAdmin("POST", "/v1/auth/step-up/options", { action });
  expect(o.statusCode, o.body).toBe(200);
  const v = await asAdmin("POST", "/v1/auth/step-up/verify", {
    stepUpId: o.json().stepUpId,
    method: "passkey",
    response: admin.auth.authenticate(o.json().passkey.options),
  });
  expect(v.statusCode, v.body).toBe(200);
  return v.json().stepUpToken as string;
}

/** refused from an API key and from a session without a grant; admitted with a grant for exactly this action */
async function withProvenStepUp(method: Method, url: string, payload: unknown, values: Record<string, unknown>) {
  const key = await viaKey(method, url, payload);
  expect(key.statusCode, key.body).toBe(403);
  expect(key.json()).toMatchObject({ error: "step_up_required", methods: [] });
  const refused = await asAdmin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  expect(refused.json().action.body.values).toEqual(values);
  const token = await grantFor(refused.json().action);
  const ok = await asAdmin(method, url, payload, { [STEP_UP_HEADER]: token });
  expect(ok.statusCode, ok.body).toBe(200);
  return ok;
}

async function mkUser(label: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `m212-${label}-${RUN}@example.com`, displayName: `m212 ${label}`, isAdmin },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "m212" } });
  expect(k.statusCode, k.body).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string, grantees: string[]) {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `${name}-${RUN}`, provider: "mock", tier: 1, model: "mock-balanced", ...PRICES },
  });
  expect(a.statusCode, a.body).toBe(201);
  const id = a.json().id as string;
  for (const g of grantees) {
    const r = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: g, agentId: id } });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }
  return id;
}

const invoke = (auth: { authorization: string }, agentId: string) =>
  app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: auth,
    payload: { mode: "execute", input: "m212 probe: summarise the attached quarterly figures in two lines", dispatch: true },
  });

async function latestUsage(agentId: string, userId: string) {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.agentId, agentId), eq(usageEvents.userId, userId)))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id))
    .limit(1);
  return row;
}
const usageCount = async (agentId: string, userId: string) =>
  (await db.select().from(usageEvents).where(and(eq(usageEvents.agentId, agentId), eq(usageEvents.userId, userId)))).length;

async function createLimit(body: Record<string, unknown>) {
  const r = await viaKey("POST", "/v1/rules/model-rate-limits", body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb
    WHERE id = ${ORG_SETTINGS_ID}`);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const adm = await mkUser("admin", true);
  const token = "rgls_" + randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: adm.id,
    origin: "password",
    expiresAt: new Date(Date.now() + 3_600_000),
    idleExpiresAt: new Date(Date.now() + 3_600_000),
    idleMinutes: 60,
  });
  admin = { id: adm.id, key: adm.auth, token, auth: new SoftAuthenticator({ origin: ORIGIN }) };
  const opt = await asAdmin("POST", "/v1/auth/passkeys/registration-options", {});
  expect(opt.statusCode, opt.body).toBe(200);
  const reg = await asAdmin("POST", "/v1/auth/passkeys", {
    challengeId: opt.json().challengeId,
    response: admin.auth.register(opt.json().options),
    label: "m212",
  });
  expect(reg.statusCode, reg.body).toBe(201);

  caller = await mkUser("caller");
  other = await mkUser("other");
  pricedAgent = await mkAgent("m212-priced", [caller.id]);
  limitedAgent = await mkAgent("m212-limited", [caller.id, other.id]);
  freeAgent = await mkAgent("m212-free", [caller.id]);
}, 120_000);

afterAll(async () => {
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
  await closeAll([
    async () => restoreGates?.(),
    async () => drainBackgroundWork(db),
    async () => app?.server.closeAllConnections(),
    async () => app?.close(),
    async () => db?.$client.end(),
    async () => dropScratchDatabase(adminDb, SCRATCH_DB),
    async () => adminDb?.$client.end(),
  ]);
});

describe("ADR-0212 (b): modality pricing in cost attribution", () => {
  it("modality prices are an admin write, audited old -> new; a key without admin is refused", async () => {
    const denied = await app.inject({
      method: "PUT",
      url: `/v1/agents/${pricedAgent}/modality-pricing`,
      headers: caller.auth,
      payload: { costPerMTokImageIn: 1 },
    });
    expect(denied.statusCode).toBe(403);
    const bad = await viaKey("PUT", `/v1/agents/${pricedAgent}/modality-pricing`, { costPerMTokImageIn: -1 });
    expect(bad.statusCode).toBe(400);
    const r = await viaKey("PUT", `/v1/agents/${pricedAgent}/modality-pricing`, {
      costPerMTokImageIn: 10,
      costPerMTokAudioOut: 60,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ costPerMTokImageIn: 10, costPerMTokAudioOut: 60, costPerMTokImageOut: null });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "agent-modality-pricing-set"), eq(auditLog.objectId, pricedAgent)));
    expect((row!.detail as { transitions: unknown }).transitions).toEqual({
      costPerMTokImageIn: { from: null, to: 10 },
      costPerMTokAudioOut: { from: null, to: 60 },
    });
  });

  it("a provider-reported split is priced per modality and stored on the usage row", async () => {
    globalThis.__m212Modality = true;
    try {
      const r = await invoke(caller.auth, pricedAgent);
      expect(r.statusCode, r.body).toBe(200);
    } finally {
      globalThis.__m212Modality = false;
    }
    const row = (await latestUsage(pricedAgent, caller.id))!;
    const inTok = row.inputTokens!;
    const outTok = row.outputTokens!;
    const expected = priceDispatchUsage(
      { ...PRICES, costPerMTokImageIn: 10, costPerMTokAudioOut: 60 },
      {
        inputTokens: inTok,
        outputTokens: outTok,
        modality: {
          image: { inputTokens: Math.floor(inTok / 2), outputTokens: 0 },
          audio: { inputTokens: 0, outputTokens: Math.floor(outTok / 4) },
        },
      },
    );
    expect(row.modalityUsage).toEqual(expected.modality);
    expect(row.modalityUsage!.image.inputTokens).toBe(Math.floor(inTok / 2));
    expect(row.modalityUsage!.text.inputTokens).toBe(inTok - Math.floor(inTok / 2));
    expect(row.costUsd).toBeCloseTo(expected.costUsd!, 12);
    // the image half really was priced above the text rate
    expect(row.costUsd!).toBeGreaterThan((inTok / 1e6) * 3 + (outTok / 1e6) * 15);
  });

  it("a dispatch with no modality data is priced exactly as before and stores no split", async () => {
    const r = await invoke(caller.auth, pricedAgent);
    expect(r.statusCode, r.body).toBe(200);
    const row = (await latestUsage(pricedAgent, caller.id))!;
    expect(row.modalityUsage).toBeNull();
    expect(row.costUsd).toBe((row.inputTokens! / 1e6) * 3 + (row.outputTokens! / 1e6) * 15);
  });

  it("the cost dashboard shows the split with unsplit spend apart, and the chargeback CSV carries it", async () => {
    const [p] = await db.insert(projects).values({ name: `m212-project-${RUN}` }).returning({ id: projects.id });
    const split = {
      text: { inputTokens: 600, outputTokens: 100, costUsd: 0.5 },
      image: { inputTokens: 400, outputTokens: 0, costUsd: 0.25 },
      audio: { inputTokens: 0, outputTokens: 50, costUsd: 0.125 },
    };
    await db.insert(usageEvents).values([
      { userId: caller.id, objectType: "agent", agentId: pricedAgent, projectId: p!.id, inputTokens: 1000, outputTokens: 150, costUsd: 0.875, modalityUsage: split },
      { userId: caller.id, objectType: "agent", agentId: pricedAgent, projectId: p!.id, inputTokens: 10, outputTokens: 10, costUsd: 0.0625 },
    ]);
    const costs = await viaKey("GET", `/v1/projects/${p!.id}/costs`);
    expect(costs.statusCode, costs.body).toBe(200);
    expect(costs.json().byModality).toEqual({
      split: [
        { modality: "text", inputTokens: 600, outputTokens: 100, costUsd: 0.5 },
        { modality: "image", inputTokens: 400, outputTokens: 0, costUsd: 0.25 },
        { modality: "audio", inputTokens: 0, outputTokens: 50, costUsd: 0.125 },
      ],
      notSplit: { events: 1, costUsd: 0.0625 },
    });
    const csv = await viaKey("GET", `/v1/projects/${p!.id}/costs.csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]!.endsWith(",textCostUsd,imageCostUsd,audioCostUsd")).toBe(true);
    expect(lines.some((l) => l.endsWith(",0.5,0.25,0.125"))).toBe(true);
    expect(lines.some((l) => l.endsWith(",,,"))).toBe(true);
  });
});

describe("ADR-0212 (c): rate limits per model", () => {
  let callerLimit: string;

  it("refuses a malformed limit and accepts a scoped one, audited", async () => {
    const noUser = await viaKey("POST", "/v1/rules/model-rate-limits", { scope: "user", agentId: limitedAgent, maxCalls: 1, windowSeconds: 60 });
    expect(noUser.statusCode).toBe(400);
    const tooLong = await viaKey("POST", "/v1/rules/model-rate-limits", {
      scope: "fleet",
      agentId: limitedAgent,
      maxCalls: 1,
      windowSeconds: 31 * 24 * 3600,
    });
    expect(tooLong.statusCode).toBe(400);
    const notAdmin = await app.inject({
      method: "POST",
      url: "/v1/rules/model-rate-limits",
      headers: caller.auth,
      payload: { scope: "fleet", agentId: limitedAgent, maxCalls: 1, windowSeconds: 60 },
    });
    expect(notAdmin.statusCode).toBe(403);
    callerLimit = await createLimit({ scope: "user", userId: caller.id, agentId: limitedAgent, maxCalls: 2, windowSeconds: 2 });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "model-rate-limit-created"), eq(auditLog.objectId, callerLimit)));
    expect(row?.effect).toBe("allow");
  });

  it("is off by default: a limit binds nothing until enforcement is turned on", async () => {
    const list = await viaKey("GET", "/v1/rules/model-rate-limits");
    expect(list.json().enforcementEnabled).toBe(false);
    for (let i = 0; i < 3; i++) {
      const r = await invoke(caller.auth, limitedAgent);
      expect(r.statusCode, r.body).toBe(200);
    }
  });

  it("turning enforcement on needs a settings_relax step-up and is audited", async () => {
    await withProvenStepUp("PUT", "/v1/rules/model-rate-limits/enforcement", { enabled: true }, { modelRateLimitsEnabled: true });
    const list = await viaKey("GET", "/v1/rules/model-rate-limits");
    expect(list.json().enforcementEnabled).toBe(true);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-settings-updated"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((row!.detail as { transitions: unknown }).transitions).toEqual({ modelRateLimitsEnabled: { from: false, to: true } });
  });

  it("a limit is hit (429, audited, no usage row), leaves other models and users alone, and resets after its window", async () => {
    // wait out the default-off calls above so the window starts empty
    await new Promise((r) => setTimeout(r, 2_300));
    for (let i = 0; i < 2; i++) {
      const ok = await invoke(caller.auth, limitedAgent);
      expect(ok.statusCode, ok.body).toBe(200);
    }
    const before = await usageCount(limitedAgent, caller.id);
    const hit = await invoke(caller.auth, limitedAgent);
    expect(hit.statusCode, hit.body).toBe(429);
    expect(hit.json()).toMatchObject({ error: "model_rate_limited" });
    expect(hit.json().detail).toContain("2/2 calls in 2s");
    expect(await usageCount(limitedAgent, caller.id)).toBe(before);
    const [deny] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "model-rate-limit"), eq(auditLog.userId, caller.id)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(deny).toMatchObject({ effect: "deny", objectType: "agent", objectId: limitedAgent });
    expect(deny!.detail).toMatchObject({ modelRateLimitId: callerLimit, maxCalls: 2, windowSeconds: 2, used: 2 });
    // another model, and another user on the same model, are not limited
    expect((await invoke(caller.auth, freeAgent)).statusCode).toBe(200);
    expect((await invoke(other.auth, limitedAgent)).statusCode).toBe(200);
    // reset: once the window has passed the calls are admitted again
    await new Promise((r) => setTimeout(r, 2_300));
    const again = await invoke(caller.auth, limitedAgent);
    expect(again.statusCode, again.body).toBe(200);
  });

  it("a fleet limit binds every user; removing it needs the step-up and is audited", async () => {
    const fleet = await createLimit({ scope: "fleet", agentId: freeAgent, maxCalls: 1, windowSeconds: 3600 });
    const r = await invoke(caller.auth, freeAgent);
    // the caller already made one call to this model in the hour above
    expect(r.statusCode, r.body).toBe(429);
    const del = await withProvenStepUp("DELETE", `/v1/rules/model-rate-limits/${fleet}`, undefined, {
      modelRateLimitRemoved: { ruleId: fleet },
    });
    expect(del.json()).toEqual({ deleted: true });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "model-rate-limit-deleted"), eq(auditLog.objectId, fleet)));
    expect(audit?.detail).toMatchObject({ relaxation: true });
    expect((await invoke(caller.auth, freeAgent)).statusCode).toBe(200);
  });

  it("turning enforcement off needs the step-up too, and then no limit binds", async () => {
    await withProvenStepUp("PUT", "/v1/rules/model-rate-limits/enforcement", { enabled: false }, { modelRateLimitsEnabled: false });
    for (let i = 0; i < 3; i++) expect((await invoke(caller.auth, limitedAgent)).statusCode).toBe(200);
  });
});
