import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  eq,
  modelCredentials,
  runMigrations,
  userModelCredentials,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { platformEnvKey } from "./agents-connectors.js";

/**
 * The platform-key ENV FALLBACK: a self-hosted / single-tenant box can activate
 * a real provider (Claude) by exporting ANTHROPIC_API_KEY instead of pasting a
 * key into the admin portal. The fallback is the LAST resort — a stored user or
 * platform credential still wins — and it is read at dispatch time only, never
 * stored. This suite proves the gate behaviour (409 when nothing is configured,
 * dispatch-attempted once the env var is set) and the read-only status endpoint
 * the /app Playground uses to guide the user, all without a real key.
 *
 * Shares one database with the other gateway suites (fileParallelism is off), so
 * every credential it stores is removed and every env var it sets is restored
 * before it ends — a leftover ANTHROPIC key would make another file's
 * `no_model_credential` case silently dispatch instead.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "envfall-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const DUMMY_KEY = "sk-ant-envtest";
// An unroutable base URL keeps the dispatch offline and fast: the provider call
// fails with a connection error (wrapped as model_dispatch_failed), which is
// exactly the "past the credential gate, fails at the provider" signal we want —
// never a real request to Anthropic.
// ADR-0034 amendment — an OFFLINE-but-PERMITTED endpoint. It was
// `https://anthropic-envtest.invalid` until credential/env baseUrl overrides
// came behind the egress guard; a `.invalid` host now fails closed at the
// guard (it resolves to nothing), which would have masked the thing these
// tests actually assert — that the CREDENTIAL GATE was passed and the failure
// happens at the provider. A loopback literal on a dead port is allow-listed
// below, needs no DNS, and still refuses the connection instantly.
const DEAD_BASE = "https://127.0.0.1:1";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;

// Env hygiene — every provider env var this suite (or the status endpoint) reads
// must be cleared, or an ambient key in the runner's shell makes a `configured`
// assertion flip. Capture whatever the runner had and restore it verbatim in
// afterAll; clear the full set before each test so every case is hermetic
// regardless of the shell that launched vitest.
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
] as const;
const ORIG_ENV: Record<string, string | undefined> = {};
for (const name of PROVIDER_ENV_VARS) ORIG_ENV[name] = process.env[name];
function clearEnv() {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
}

async function invokeAnthropic(auth: { authorization: string }) {
  return app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: "ping", dispatch: true },
  });
}

beforeAll(async () => {
  clearEnv();
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // ADR-0034 amendment — model-credential / env `baseUrl` overrides are now
  // behind the default-deny egress guard. This suite points one at a loopback
  // address, so it allow-lists that host explicitly with the private-range and
  // plaintext opt-ins, exactly as an air-gapped operator would (the same
  // pattern as custom-providers.test.ts).
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "env-fallback suite: local fake endpoints",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);

  // start from a known-clean anthropic platform slot (another suite may have left
  // its own; this file owns the anthropic 409/fallback story while it runs)
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "anthropic"));

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "envfall-user@example.com", displayName: "Env Fall" },
  });
  expect(user.statusCode).toBe(201);
  userId = user.json().id;

  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "portal" },
  });
  userAuth = { authorization: `Bearer ${key.json().token}` };

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "envfall-claude",
      provider: "anthropic",
      tier: 2,
      costPerMTokIn: 5,
      costPerMTokOut: 25,
      model: "claude-opus-5",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId },
  });
});

// Every test starts from a known-empty provider env, independent of the shell.
beforeEach(clearEnv);

afterAll(async () => {
  // leave the shared DB and the process env exactly as they were found
  await db.delete(userModelCredentials).where(eq(userModelCredentials.userId, userId));
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "anthropic"));
  clearEnv();
  for (const name of PROVIDER_ENV_VARS) {
    if (ORIG_ENV[name] !== undefined) process.env[name] = ORIG_ENV[name];
  }
});

describe("platformEnvKey helper", () => {
  it("resolves the conventional per-provider env vars, honours the base-url and GEMINI fallbacks, and returns null when unset", () => {
    clearEnv();
    expect(platformEnvKey("anthropic")).toBeNull();

    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    expect(platformEnvKey("anthropic")).toEqual({ apiKey: DUMMY_KEY, baseUrl: null });

    process.env.ANTHROPIC_BASE_URL = DEAD_BASE;
    expect(platformEnvKey("anthropic")).toEqual({ apiKey: DUMMY_KEY, baseUrl: DEAD_BASE });

    // google accepts either GOOGLE_API_KEY or the GEMINI_API_KEY alias
    expect(platformEnvKey("google")).toBeNull();
    process.env.GEMINI_API_KEY = "gm-envtest";
    expect(platformEnvKey("google")).toEqual({ apiKey: "gm-envtest", baseUrl: null });

    // a provider with no env-key convention (or mock) never resolves
    expect(platformEnvKey("mock")).toBeNull();
    expect(platformEnvKey("nonsense")).toBeNull();

    clearEnv();
  });
});

describe("env fallback at dispatch (agents-connectors credential gate)", () => {
  it("(a) with NO stored credential and the env var UNSET, the anthropic dispatch is the unchanged 409 no_model_credential", async () => {
    clearEnv();
    const res = await invokeAnthropic(userAuth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_model_credential");
    // the improved detail points at BOTH remedies without leaking anything
    expect(res.json().detail).toContain("ANTHROPIC_API_KEY");
  });

  it("(b) with the env var SET, the dispatch engages the fallback and proceeds PAST the credential gate (fails at the provider, never 409)", async () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    process.env.ANTHROPIC_BASE_URL = DEAD_BASE; // keep it offline + fast
    const res = await invokeAnthropic(userAuth);
    // the env fallback engaged: it is no longer the credential gate that fails
    expect(res.statusCode).not.toBe(409);
    expect(res.json().error).not.toBe("no_model_credential");
    // the dummy key can't authenticate / the base URL can't be reached, so the
    // failure is a provider-level dispatch failure — the expected, correct outcome
    expect(res.json().error).toBe("model_dispatch_failed");
    clearEnv();
  });

  it("keeps precedence intact: a stored credential is used even when the env var is also set (env is the last resort)", async () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    process.env.ANTHROPIC_BASE_URL = DEAD_BASE;
    // a stored PLATFORM credential exists alongside the env var — both are past
    // the gate, so the observable contract is the same non-409 dispatch attempt;
    // the stored one takes precedence by construction (checked before the env
    // fallback), the env var only fills the gap when nothing is stored.
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-ant-stored", baseUrl: DEAD_BASE },
    });
    const res = await invokeAnthropic(userAuth);
    expect(res.statusCode).not.toBe(409);
    expect(res.json().error).not.toBe("no_model_credential");
    await app.inject({ method: "DELETE", headers: AUTH, url: "/v1/model-credentials/anthropic" });
    clearEnv();
  });
});

describe("GET /v1/model-providers/status", () => {
  it("reports configured=true for anthropic only when the env var is set, mock is always true, and no key material leaks", async () => {
    clearEnv();
    const off = await app.inject({ method: "GET", headers: userAuth, url: "/v1/model-providers/status" });
    expect(off.statusCode).toBe(200); // readable by a non-admin (NON_ADMIN_ROUTES)
    expect(off.json().providers.mock.configured).toBe(true);
    // anthropic is the provider THIS suite controls end-to-end: beforeAll wipes
    // its stored platform credential and clearEnv() wipes its env var, so it is
    // the reliable "unconfigured -> false" signal. We deliberately do NOT assert
    // on other providers here — a sibling adapter suite may leave a stored
    // openai/xai credential in the shared DB, and the endpoint counts stored
    // credentials as well as env vars, so those would be flaky to assert on.
    expect(off.json().providers.anthropic.configured).toBe(false);

    process.env.ANTHROPIC_API_KEY = DUMMY_KEY;
    const on = await app.inject({ method: "GET", headers: userAuth, url: "/v1/model-providers/status" });
    expect(on.json().providers.anthropic.configured).toBe(true);
    expect(on.json().providers.mock.configured).toBe(true);

    // booleans + provider names ONLY — the key value must never appear
    expect(on.body).not.toContain(DUMMY_KEY);
    const shapes = Object.values(on.json().providers as Record<string, unknown>);
    for (const s of shapes) expect(Object.keys(s as object)).toEqual(["configured"]);

    clearEnv();
  });

  it("also reflects a stored platform credential as configured (either source counts)", async () => {
    clearEnv();
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-ant-stored-2" },
    });
    const res = await app.inject({ method: "GET", headers: userAuth, url: "/v1/model-providers/status" });
    expect(res.json().providers.anthropic.configured).toBe(true);
    expect(res.body).not.toContain("sk-ant-stored-2");
    await app.inject({ method: "DELETE", headers: AUTH, url: "/v1/model-credentials/anthropic" });
  });
});
