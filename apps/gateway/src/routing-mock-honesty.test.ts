import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  costEvents,
  createDb,
  desc,
  eq,
  inArray,
  modelCredentials,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * B1.5 F1 — MOCK-AGENT ROUTING HONESTY (owner-experienced defect,
 * LIVE_VERIFICATION_2026-08): with a live Gemini credential configured and a
 * cost-sensitive request, right-sizing swapped the selected live agent for a
 * seeded MOCK, which "answered" with canned prose and recorded the swap as
 * measured savings against the live baseline's list price — money nobody saved
 * on work nobody did.
 *
 * The rule this file pins, both directions:
 *
 *  1. A mock-provider agent is a ROUTING candidate ONLY while no credentialed
 *     live agent in the caller's entitled roster can serve — the moment one
 *     can, every mock is withheld from the kernel with the disclosed reason
 *     `mock_shadowed_by_live` (roster decision) and can therefore never be the
 *     served dispatch (dispatch decision).
 *  2. The KEYLESS DEMO is preserved byte-identically: with no credential
 *     anywhere, mocks still route and serve exactly as before.
 *  3. Savings rows never pair a mock SERVING agent with a live BASELINE:
 *     `measuredCostSavedUsd` is null on such a row (the estimated
 *     model_routing ledger keeps its clearly-labelled estimate). Mock-vs-mock
 *     stays measured — the in-file control, and mcp-proxy.test.ts's
 *     "dispatch=true executes the ROUTED model" case is the standing
 *     suite-level control for it.
 *  4. DIRECT invocation of a mock stays allowed even when live agents could
 *     serve — an explicit choice is not routing.
 *
 * The "credentialed live provider" is anthropic with a stored PLATFORM
 * credential; its adapter is stubbed at `resolveModelProvider` (the
 * agent-config-versioning suite's spy pattern) so a live-shaped dispatch
 * SUCCEEDS offline — everything under test (roster filter, kernel decision,
 * served dispatch, usage row) sits upstream of the adapter. Mock and every
 * other provider resolve through the REAL implementation.
 *
 * SHARED-DB DISCIPLINE: `rmh-` prefixed users/agents owned by this file; row
 * assertions are DELTAS (M-008); the stored anthropic credential and this
 * file's usage/cost rows are removed in afterAll; provider env vars cleared
 * per-file and restored verbatim (an ambient GOOGLE key would flip the keyless
 * case). The keyless live agent sits on the GOOGLE provider slot deliberately:
 * no other suite file ever stores a google platform credential (mcp-proxy
 * leaves an xai one behind, which is exactly how the first draft of this file
 * learned the M-020 lesson about asserting global emptiness), and beforeAll
 * clears the slot anyway so the claim is created by this file, not assumed.
 */

declare global {
  // eslint-disable-next-line no-var
  var __rmhLiveCalls: Array<{ model: string; input: string }>;
}
globalThis.__rmhLiveCalls = [];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const [config] = args;
      if (config.provider === "anthropic") {
        // an offline stand-in for a WORKING live provider: the credential gate,
        // roster filter and routing kernel all ran for real before this point
        return {
          kind: "anthropic",
          dispatch: (req: { model: string; input: string }) => {
            globalThis.__rmhLiveCalls.push({ model: req.model, input: req.input });
            return Promise.resolve({
              outputText: `live answer from ${req.model}`,
              stopReason: "end_turn" as const,
              refusal: false,
              usage: { inputTokens: 20, outputTokens: 10 },
              providerMessageId: "rmh-live-msg",
            });
          },
        } as unknown as ReturnType<typeof actual.resolveModelProvider>;
      }
      return actual.resolveModelProvider(...args);
    },
  };
});

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rmh-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

// env hygiene (env-fallback.test.ts discipline): an ambient provider key in
// the runner's shell would make the keyless-demo case silently "credentialed"
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

let db: Db;
let app: ReturnType<typeof buildApp>;
let livId: string;
let livAuth: { authorization: string };
let keyId: string;
let keyAuth: { authorization: string };
/** liv's roster: a live requested agent, a CHEAPER live agent, a CHEAPEST mock */
let reqLiveId: string;
let cheapLiveId: string;
let mockLivId: string;
/** key's roster: an uncredentialed live agent + a mock — the keyless demo */
let liveKeylessId: string;
let mockKeyId: string;

async function makeUser(email: string) {
  // display name must never be email-shaped: the shared-context directory
  // suite asserts the names-only surface leaks no "@example.com" from ANY row
  const displayName = email.split("@")[0]!.replace(/-/g, " ");
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "rmh" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(payload: Record<string, unknown>, grantees: string[]) {
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload });
  expect(a.statusCode).toBe(201);
  const id = a.json().id as string;
  for (const g of grantees) {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: g, agentId: id } });
  }
  return id;
}

async function usageRows(userId: string) {
  return db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.objectType, "agent")))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id));
}

beforeAll(async () => {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const liv = await makeUser("rmh-liv@example.com");
  livId = liv.id;
  livAuth = liv.auth;
  const key = await makeUser("rmh-key@example.com");
  keyId = key.id;
  keyAuth = key.auth;

  reqLiveId = await makeAgent(
    { name: "rmh-live-req", provider: "anthropic", tier: 1, modes: ["execute"], model: "rmh-live-req-model", costPerMTokIn: 3, costPerMTokOut: 15 },
    [livId],
  );
  cheapLiveId = await makeAgent(
    { name: "rmh-live-cheap", provider: "anthropic", tier: 0, modes: ["execute"], model: "rmh-live-cheap-model", costPerMTokIn: 2, costPerMTokOut: 10 },
    [livId],
  );
  mockLivId = await makeAgent(
    { name: "rmh-mock", provider: "mock", tier: 0, modes: ["execute"], model: "mock-fast", costPerMTokIn: 1, costPerMTokOut: 5 },
    [livId],
  );

  liveKeylessId = await makeAgent(
    { name: "rmh-google-live", provider: "google", tier: 2, modes: ["execute"], model: "rmh-gem-model", costPerMTokIn: 15, costPerMTokOut: 75 },
    [keyId],
  );
  // own the keyless story for the google slot while this file runs (the
  // env-fallback suite's discipline for anthropic): no stored platform
  // credential may make the "keyless" roster silently credentialed
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "google"));
  mockKeyId = await makeAgent(
    { name: "rmh-mock-keyless", provider: "mock", tier: 0, modes: ["execute"], model: "mock-fast", costPerMTokIn: 1, costPerMTokOut: 5 },
    [keyId],
  );

  // the CREDENTIAL that makes liv's anthropic agents genuinely servable —
  // the platform slot, exactly what the owner's GOOGLE_API_KEY run exercised
  const cred = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/model-credentials",
    payload: { provider: "anthropic", apiKey: "sk-ant-rmh-not-a-real-key" },
  });
  expect(cred.statusCode).toBe(201);
});

afterAll(async () => {
  const agentIds = [reqLiveId, cheapLiveId, mockLivId, liveKeylessId, mockKeyId].filter(Boolean);
  if (agentIds.length > 0) await db.delete(usageEvents).where(inArray(usageEvents.agentId, agentIds));
  await db.delete(costEvents).where(inArray(costEvents.userId, [livId, keyId].filter(Boolean)));
  await db.delete(modelCredentials).where(eq(modelCredentials.provider, "anthropic"));
  for (const name of PROVIDER_ENV_VARS) {
    if (ORIG_ENV[name] !== undefined) process.env[name] = ORIG_ENV[name];
    else delete process.env[name];
  }
  await restoreSb2Gates();
});

describe("F1 — a mock is not a routing candidate while a credentialed live agent can serve", () => {
  it("cost-sensitive routing lands on the cheapest LIVE agent, never the cheaper mock — roster and dispatch", async () => {
    const before = (await usageRows(livId)).length;
    const res = await app.inject({
      method: "POST",
      headers: livAuth,
      url: `/v1/agents/${reqLiveId}/invoke`,
      payload: {
        mode: "execute",
        input: "rmh one-line ask, deliberately trivial",
        dispatch: true,
        costSensitivity: "cost-sensitive",
      },
    });
    expect(res.statusCode).toBe(200);
    const { routing, dispatch } = res.json();

    // ROSTER decision: the mock was withheld from the kernel, with the reason disclosed
    expect(routing.effect).toBe("routed");
    expect(routing.selectedAgentId).toBe(cheapLiveId);
    expect(routing.selectedAgentId).not.toBe(mockLivId);
    expect(routing.skippedCandidates).toEqual([
      { agentId: mockLivId, name: "rmh-mock", reason: "mock_shadowed_by_live" },
    ]);

    // SERVED dispatch: the live agent answered (through the stubbed adapter)
    expect(dispatch.servedAgentId).toBe(cheapLiveId);
    expect(dispatch.model).toBe("rmh-live-cheap-model");
    expect(dispatch.outputText).toBe("live answer from rmh-live-cheap-model");
    expect(globalThis.__rmhLiveCalls.at(-1)!.model).toBe("rmh-live-cheap-model");

    // usage row delta: exactly one new row, live provider, live-vs-live
    // measured savings intact (the honesty rule narrows MOCK-served rows only)
    const rows = await usageRows(livId);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.provider).toBe("anthropic");
    expect(rows[0]!.agentId).toBe(cheapLiveId);
    expect(rows[0]!.baselineAgentId).toBe(reqLiveId);
    expect(rows[0]!.measuredCostSavedUsd).toBeGreaterThan(0);
  });

  it("an explicitly requested mock still serves — explicit choice is not routing (and mock-vs-mock savings stay measured)", async () => {
    const before = (await usageRows(livId)).length;
    const res = await app.inject({
      method: "POST",
      headers: livAuth,
      url: `/v1/agents/${mockLivId}/invoke`,
      payload: { mode: "execute", input: "rmh direct mock ask, unique wording", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.servedAgentId).toBe(mockLivId);
    const rows = await usageRows(livId);
    expect(rows.length).toBe(before + 1);
    expect(rows[0]!.provider).toBe("mock");
    // baseline is the requested mock itself — mock-vs-mock, so the measured
    // column is a number (0 for a passthrough), never nulled by the honesty rule
    expect(rows[0]!.baselineAgentId).toBe(mockLivId);
    expect(rows[0]!.measuredCostSavedUsd).not.toBeNull();
  });
});

describe("F1 — the keyless demo is preserved, and its savings are honest", () => {
  it("with NO credential anywhere, the mock still routes and serves exactly as before", async () => {
    const before = (await usageRows(keyId)).length;
    const res = await app.inject({
      method: "POST",
      headers: keyAuth,
      url: `/v1/agents/${liveKeylessId}/invoke`,
      payload: { mode: "execute", input: "rmh keyless ask, short", dispatch: true },
    });
    expect(res.statusCode).toBe(200);
    const { routing, dispatch } = res.json();
    // the uncredentialed live baseline was down-routed onto the mock — the
    // out-of-box demo behaviour, byte-identical (no skip reason names the mock)
    expect(routing.effect).toBe("routed");
    expect(routing.selectedAgentId).toBe(mockKeyId);
    expect(routing.skippedCandidates ?? []).toEqual([]);
    expect(dispatch.servedAgentId).toBe(mockKeyId);
    expect(dispatch.outputText.length).toBeGreaterThan(0);
    expect((await usageRows(keyId)).length).toBe(before + 1);
  });

  it("a mock SERVING against a live BASELINE never records measured savings (estimated ledger row remains)", async () => {
    const [row] = await usageRows(keyId);
    expect(row!.provider).toBe("mock");
    expect(row!.agentId).toBe(mockKeyId);
    expect(row!.baselineAgentId).toBe(liveKeylessId);
    // billed honestly…
    expect(row!.costUsd).toBeGreaterThan(0);
    // …but the "saved vs the live model's list price" claim is refused: the
    // canned answer did not do the live model's work
    expect(row!.measuredCostSavedUsd).toBeNull();

    // the clearly-labelled ESTIMATE ledger keeps recording the routing
    // decision itself — unchanged semantics, distinct from measurement
    const est = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, keyId), eq(costEvents.technique, "model_routing")))
      .orderBy(desc(costEvents.at));
    expect(est.length).toBeGreaterThan(0);
    expect(est[0]!.servedAgentId).toBe(mockKeyId);
  });
});
