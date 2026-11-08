/**
 * ADR-0241 (P21) — the configurable usage extractor, on a real database, through the real dispatch path (the mock
 * provider, wrapped so a test can hand it the decoded response body a real provider would return):
 *
 *  - off by default: an active, tested mapping changes nothing until the org switch is on;
 *  - versioned: each save is the next version, invalid and malicious mappings are refused with 422, every write is
 *    audited in its own transaction;
 *  - test before activation: no test, or a failing latest test, refuses activation with 409 before any step-up is
 *    asked for; a passing test of that exact version allows it, with a settings_relax step-up;
 *  - turning the switch on needs the step-up; turning it off and deactivating do not;
 *  - at dispatch the mapped counts are priced (ADR-0212 modality split included) and the row names the version;
 *  - fail closed: a response the mapping cannot read keeps the adapter's built-in counts, stamps a fallback on the
 *    usage row and writes an audit row.
 *
 * Runs on its OWN scratch database (prefix `u241_`), dropped in afterAll (M-068).
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
  runMigrations,
  sql,
  usageEvents,
  usageExtractorTests,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER } from "@regulait/shared";
import { USAGE_MAPPING_FORMAT } from "@regulait/model-provider";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";
import { drainBackgroundWork } from "./background-work.js";

declare global {
  // eslint-disable-next-line no-var
  var __u241Body: unknown;
}
globalThis.__u241Body = undefined;

// the mock reports its own counts and no body; when a test sets a body, the dispatch carries it as usageSource
vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (...args: Parameters<typeof actual.resolveModelProvider>) => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        const out = await inner.dispatch(req);
        return globalThis.__u241Body === undefined ? out : { ...out, usageSource: globalThis.__u241Body };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { resolveDispatchUsage } = await import("./usage-extractors.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `u241_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

const RUN = randomBytes(3).toString("hex");
const BOOT = `u241-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
// text $3 / $15 per million; image input $10, audio output $40
const PRICES = { costPerMTokIn: 3, costPerMTokOut: 15 };

/** an OpenAI chat-completions-shaped body (documented field names) */
const BODY = {
  id: "chatcmpl-u241",
  object: "chat.completion",
  choices: [],
  usage: {
    prompt_tokens: 100_000,
    completion_tokens: 20_000,
    prompt_tokens_details: { cached_tokens: 50_000, image_tokens: 40_000 },
    completion_tokens_details: { audio_tokens: 5_000 },
  },
};
const MAPPING = {
  format: USAGE_MAPPING_FORMAT,
  fields: {
    inputTokens: { pointer: "/usage/prompt_tokens" },
    outputTokens: { pointer: "/usage/completion_tokens" },
    cacheReadInputTokens: { pointer: "/usage/prompt_tokens_details/cached_tokens" },
    imageInputTokens: { pointer: "/usage/prompt_tokens_details/image_tokens" },
    audioOutputTokens: { pointer: "/usage/completion_tokens_details/audio_tokens" },
  },
};
const EXPECTED = { inputTokens: 100_000, outputTokens: 20_000, cacheReadInputTokens: 50_000, imageInputTokens: 40_000, audioOutputTokens: 5_000 };

let adminDb: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void>;
let admin: { id: string; key: { authorization: string }; token: string; auth: SoftAuthenticator };
let caller: { id: string; auth: { authorization: string } };
let agentId: string;

type Method = "GET" | "PUT" | "POST";
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
    payload: { email: `u241-${label}-${RUN}@example.com`, displayName: `u241 ${label}`, isAdmin },
  });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "u241" } });
  expect(k.statusCode, k.body).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const invoke = () =>
  app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: caller.auth,
    payload: { mode: "execute", input: "u241 probe: summarise the attached figures in two lines", dispatch: true },
  });

async function latestUsage() {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.agentId, agentId), eq(usageEvents.userId, caller.id)))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id))
    .limit(1);
  return row!;
}
async function audits(ruleId: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, agentId))).orderBy(desc(auditLog.at));
}
const base = () => `/v1/agents/${agentId}/usage-extractor`;

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  adminDb = createDb(DATABASE_URL);
  await adminDb.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await adminDb.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await db.execute(sql`UPDATE org_settings SET step_up_mode = 'required',
    step_up_actions = '["approval_decide", "settings_relax", "evidence_hold_override", "break_glass", "passkey_manage", "owner_change", "identity_manage", "pseudonym_reveal", "key_management"]'::jsonb,
    routing_enabled = false
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
    label: "u241",
  });
  expect(reg.statusCode, reg.body).toBe(201);

  caller = await mkUser("caller");
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `u241-agent-${RUN}`, provider: "mock", tier: 1, model: "mock-balanced", ...PRICES },
  });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id as string;
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: caller.id, agentId } });
  expect(g.statusCode, g.body).toBeLessThan(300);
  const mp = await viaKey("PUT", `/v1/agents/${agentId}/modality-pricing`, { costPerMTokImageIn: 10, costPerMTokAudioOut: 40 });
  expect(mp.statusCode, mp.body).toBe(200);
}, 120_000);

afterAll(async () => {
  globalThis.__u241Body = undefined;
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

describe("ADR-0241 usage extractor", () => {
  let v1: string;
  let v2: string;

  it("is off by default", async () => {
    const r = await viaKey("GET", "/v1/usage-extractors");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ enabled: false, active: [] });
  });

  it("refuses invalid and malicious mappings with 422 and saves nothing", async () => {
    const missing = await viaKey("POST", `${base()}/versions`, {});
    expect(missing.statusCode, missing.body).toBe(400);
    for (const mapping of [
      null,
      [MAPPING],
      { ...MAPPING, format: "other" },
      { ...MAPPING, script: "process.exit()" },
      { ...MAPPING, fields: { ...MAPPING.fields, inputTokens: { pointer: "$.usage.prompt_tokens" } } },
      { ...MAPPING, fields: { ...MAPPING.fields, inputTokens: { pointer: "/" + "a".repeat(300) } } },
    ]) {
      const r = await viaKey("POST", `${base()}/versions`, { mapping });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("invalid_usage_mapping");
    }
    const list = await viaKey("GET", `${base()}/versions`);
    expect(list.json().versions).toEqual([]);
  });

  it("saves versions 1 and 2, each audited", async () => {
    const r1 = await viaKey("POST", `${base()}/versions`, { mapping: { ...MAPPING, fields: { ...MAPPING.fields, outputTokens: { pointer: "/usage/wrong" } } } });
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().version).toBe(1);
    v1 = r1.json().id;
    const r2 = await viaKey("POST", `${base()}/versions`, { mapping: MAPPING });
    expect(r2.statusCode, r2.body).toBe(201);
    expect(r2.json().version).toBe(2);
    v2 = r2.json().id;
    expect((await audits("usage-extractor-version-saved")).length).toBe(2);
  });

  it("refuses activation without a passing test, before asking for a step-up", async () => {
    const r = await asAdmin("POST", `${base()}/versions/${v2}/activate`, {});
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("sample_test_required");
    // a failing test of v1 (its outputTokens pointer names nothing) does not let it activate
    const t = await viaKey("POST", `${base()}/versions/${v1}/test`, { sample: BODY, expected: EXPECTED });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().passed).toBe(false);
    expect(t.json().failure).toMatch(/outputTokens/);
    expect((await asAdmin("POST", `${base()}/versions/${v1}/activate`, {})).statusCode).toBe(409);
  });

  it("a test passes only on exactly the expected counts, and keeps only the sample's hash", async () => {
    const wrong = await viaKey("POST", `${base()}/versions/${v2}/test`, { sample: BODY, expected: { ...EXPECTED, imageInputTokens: 1 } });
    expect(wrong.json().passed).toBe(false);
    expect(wrong.json().failure).toMatch(/imageInputTokens/);
    const ok = await viaKey("POST", `${base()}/versions/${v2}/test`, { sample: BODY, expected: EXPECTED });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().passed).toBe(true);
    const [row] = await db.select().from(usageExtractorTests).where(eq(usageExtractorTests.id, ok.json().testId));
    expect(row!.sampleSha256).toBe(createHash("sha256").update(JSON.stringify(BODY)).digest("hex"));
    expect(JSON.stringify(row)).not.toContain("chatcmpl-u241");
  });

  it("refuses an oversized sample with 413", async () => {
    const r = await viaKey("POST", `${base()}/versions/${v2}/test`, { sample: { pad: "x".repeat(1_048_600) }, expected: EXPECTED });
    expect(r.statusCode, r.body).toBe(413);
  });

  it("activates the tested version with a settings_relax step-up, audited old -> new", async () => {
    await withProvenStepUp("POST", `${base()}/versions/${v2}/activate`, {}, { usageExtractorActivated: { agentId, versionId: v2 } });
    const [a] = await audits("usage-extractor-activated");
    expect((a!.detail as { transitions: unknown }).transitions).toEqual({ usageExtractorVersionId: { from: null, to: v2 } });
  });

  it("while the switch is off, an active mapping changes nothing", async () => {
    globalThis.__u241Body = BODY;
    const r = await invoke();
    expect(r.statusCode, r.body).toBe(200);
    const row = await latestUsage();
    expect(row.usageExtractorVersionId).toBeNull();
    expect(row.inputTokens).not.toBe(100_000);
  });

  it("turning the switch on needs the step-up", async () => {
    await withProvenStepUp("PUT", "/v1/usage-extractors/enabled", { enabled: true }, { usageExtractorEnabled: true });
    expect((await viaKey("GET", "/v1/usage-extractors")).json()).toMatchObject({ enabled: true, active: [{ agentId, versionId: v2, version: 2 }] });
  });

  it("prices the mapped counts, with the ADR-0212 modality split, and stamps the version", async () => {
    globalThis.__u241Body = BODY;
    const r = await invoke();
    expect(r.statusCode, r.body).toBe(200);
    const row = await latestUsage();
    expect(row.inputTokens).toBe(100_000);
    expect(row.outputTokens).toBe(20_000);
    expect(row.usageExtractorVersionId).toBe(v2);
    expect((row.detail as { usageExtractor: unknown }).usageExtractor).toEqual({ versionId: v2, version: 2, result: "mapped" });
    // text in 60k x $3 + image in 40k x $10 + text out 15k x $15 + audio out 5k x $40, per million
    const expected = (60_000 * 3 + 40_000 * 10 + 15_000 * 15 + 5_000 * 40) / 1_000_000;
    expect(row.costUsd).toBeCloseTo(expected, 10);
    expect(row.modalityUsage).toMatchObject({ image: { inputTokens: 40_000 }, audio: { outputTokens: 5_000 } });
  });

  it("fails closed: a response the mapping cannot read keeps the built-in counts, stamped and audited", async () => {
    globalThis.__u241Body = { usage: { prompt_tokens: "100000", completion_tokens: 1 } };
    const r = await invoke();
    expect(r.statusCode, r.body).toBe(200);
    const row = await latestUsage();
    expect(row.usageExtractorVersionId).toBeNull();
    expect(row.inputTokens).not.toBe(100_000);
    expect((row.detail as { usageExtractor: { result: string; failure: string } }).usageExtractor).toMatchObject({ result: "fallback", versionId: v2 });
    expect((await audits("usage-extractor-fallback")).length).toBe(1);
    // no body at all (an adapter with none) falls back the same way
    globalThis.__u241Body = undefined;
    await invoke();
    expect(((await latestUsage()).detail as { usageExtractor: { failure: string } }).usageExtractor.failure).toMatch(/no response body/);
    // review finding 2: repeated fallbacks (an adapter with no usageSource falls back on every call) are each stamped
    // on their usage row, but audited at most once per version per window
    await invoke();
    expect(((await latestUsage()).detail as { usageExtractor: { result: string } }).usageExtractor.result).toBe("fallback");
    expect((await audits("usage-extractor-fallback")).length).toBe(1);
  });

  it("review finding 4: a database error after the provider call keeps the built-in counts, never fails the dispatch", async () => {
    const broken = new Proxy({} as Db, {
      get: () => () => {
        throw new Error("connection terminated: secret-detail");
      },
    });
    const usage = { inputTokens: 7, outputTokens: 3 };
    const out = await resolveDispatchUsage(broken, { agentId, userId: caller.id, result: { usage, usageSource: BODY } });
    expect(out.usage).toBe(usage);
    expect(out.versionId).toBeNull();
    expect(out.outcome).toEqual({ versionId: null, result: "error", failure: expect.stringMatching(/built-in counts/) });
    expect(JSON.stringify(out)).not.toContain("secret-detail");
  });

  it("deactivating and turning the switch off need no step-up and are audited", async () => {
    const d = await asAdmin("POST", `${base()}/deactivate`, {});
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toEqual({ agentId, deactivated: true });
    expect((await audits("usage-extractor-deactivated")).length).toBe(1);
    const off = await asAdmin("PUT", "/v1/usage-extractors/enabled", { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ enabled: false, changed: true });
    globalThis.__u241Body = BODY;
    await invoke();
    expect((await latestUsage()).usageExtractorVersionId).toBeNull();
  });

  it("is admin-only", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/usage-extractors", headers: caller.auth });
    expect(r.statusCode).toBe(403);
    const w = await app.inject({ method: "POST", url: `${base()}/versions`, headers: caller.auth, payload: { mapping: MAPPING } });
    expect(w.statusCode).toBe(403);
  });
});
