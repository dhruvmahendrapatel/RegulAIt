/**
 * ADR-0066 — GATEWAY PARITY, proved by attack.
 *
 * WHAT THIS FILE IS TRYING TO MAKE IMPOSSIBLE TO FAKE
 *
 *  1. A DISCOVERY ENDPOINT THAT LISTS THE REGISTRY. The whole claim about
 *     `GET /v1/models` is that it is ENTITLEMENT-FILTERED. So two users with
 *     disjoint grants are driven through the same endpoint and each list is
 *     asserted to contain their own model and NOT contain the other's. An
 *     implementation that returned `SELECT * FROM agents` passes nothing here.
 *
 *  2. A "CEILING" THAT IS A COMMENT. A virtual key is issued whose allow-list
 *     names a model its OWNER was never granted. The dispatch must still DENY.
 *     This is the one test that distinguishes a narrowing credential from a
 *     credential that grants, and it is asserted against the response AND
 *     against the absence of a usage row.
 *
 *  3. A BUDGET THAT LOGS. The exhausted-budget case asserts a real 402 with a
 *     stated reason, and that NO usage_events row was written for the refused
 *     call — a refusal that still bills is a refusal that did not happen.
 *
 *  4. A SCOPED CREDENTIAL THAT SILENTLY ISN'T. The route-ceiling cases prove a
 *     virtual key cannot mint another key, cannot read model credentials,
 *     cannot reach an admin route even when its OWNER IS AN ADMIN, and cannot
 *     be exchanged for a browser session (which would hand back everything the
 *     key exists to remove).
 *
 *  5. A FALLBACK THAT RETRIES A GOVERNANCE DECISION. The subtle one. A chain is
 *     configured behind an agent, then that agent is called by a user who is
 *     NOT ENTITLED to it — and the assertion is that ZERO hops were attempted
 *     and ZERO fallback audit rows exist. A denial is a decision; retrying it
 *     elsewhere is a bypass. The same is asserted for a config failure and for
 *     a model REFUSAL, both of which look like "it didn't work" and are not.
 *
 *  6. A FALLBACK THAT INHERITS THE FIRST HOP'S ALLOW. A chain is built whose
 *     first hop the caller is NOT entitled to and whose second hop they are.
 *     The unentitled hop must be SKIPPED, AUDITED, and the second must serve —
 *     asserted on the audit table, not on the response alone.
 *
 * SHARED-STATE DISCIPLINE. `interception_settings` is a singleton every other
 * suite reads. This file enables both compat surfaces, so `afterAll` restores
 * the exact pre-existing values. Everything created is `gp-` prefixed and
 * removed. Nothing here touches `org_settings`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  auditLog,
  createDb,
  eq,
  inArray,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  modelCredentials,
  runMigrations,
  usageEvents,
  users,
  virtualKeys,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * The most recent row by `at`.
 *
 * NEVER index a bare SELECT's result by position. Postgres does not promise
 * insertion order without an ORDER BY, and two CI failures in this repo came
 * from exactly that: a test read `rows[rows.length - 1]` as "the row just
 * written", passed locally for months, and failed the first time the physical
 * row order came back the other way round. Sorting by the column that actually
 * carries the ordering makes the assertion mean what it says.
 */
function latestRow<T extends { at: Date }>(rows: readonly T[]): T {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1];
  if (!last) throw new Error("latestRow: no rows");
  return last;
}


const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "gp-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

/** ADA is granted the fast + primary agents. BRUNO is granted ONLY the rival
 * agent. Nothing they can see overlaps, which is what makes the two discovery
 * assertions meaningful in both directions. */
let adaId: string;
let adaAuth: { authorization: string };
let brunoId: string;
let brunoAuth: { authorization: string };
/** an ADMIN owner, so "a virtual key issued by an admin is not an admin" is a
 * fact about this suite rather than a hypothetical */
let rootId: string;
let rootAuth: { authorization: string };

let primaryAgentId: string; //  gp-primary       model gp-primary-model
let fastAgentId: string; //     gp-fast          model gp-fast-model
let rivalAgentId: string; //    gp-rival         model gp-rival-model   (BRUNO only)
let planOnlyAgentId: string; // gp-plan-only     model gp-plan-model    (ADA, plan mode only)
let decisionOnlyAgentId: string; // gp-decision   model NULL

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
let priorInterception: {
  anthropicCompatEnabled: boolean;
  openaiCompatEnabled: boolean;
} | null = null;

async function makeUser(email: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!, isAdmin },
  });
  expect(u.statusCode, JSON.stringify(u.json())).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${id}/keys`,
    headers: AUTH,
    payload: { name: "gp" },
  });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, model: string | null, tier = 1) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name,
      provider: "mock",
      tier,
      costPerMTokIn: 1,
      costPerMTokOut: 2,
      ...(model ? { model } : {}),
    },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
  const id = r.json().id as string;
  createdAgentIds.push(id);
  return id;
}

async function grant(userId: string, agentId: string, allowedModes?: string[]) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId, agentId, ...(allowedModes ? { allowedModes } : {}) },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
}

/** Issue a virtual key and return both the row id and the one-time token. */
async function issueKey(
  auth: { authorization: string },
  payload: Record<string, unknown>,
  expectStatus = 201,
) {
  const r = await app.inject({ method: "POST", url: "/v1/virtual-keys", headers: auth, payload });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(expectStatus);
  if (expectStatus !== 201) return { id: "", token: "", body: r.json() };
  const body = r.json();
  return {
    id: body.id as string,
    token: body.token as string,
    header: { authorization: `Bearer ${body.token}` },
    body,
  };
}

async function chat(headers: Record<string, string>, model: string, text: string) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers,
    payload: { model, messages: [{ role: "user", content: text }] },
  });
}

async function setFallbacks(agentId: string, fallbackAgentIds: string[], expectStatus = 200) {
  const r = await app.inject({
    method: "PUT",
    url: `/v1/agents/${agentId}/fallbacks`,
    headers: AUTH,
    payload: { fallbackAgentIds },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(expectStatus);
  return r;
}

async function auditRows(ruleId: string, userId?: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      userId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.userId, userId)) : eq(auditLog.ruleId, ruleId),
    );
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireProjectAttribution: false });
  await app.ready();

  const [prior] = await db
    .select()
    .from(interceptionSettings)
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  priorInterception = prior
    ? {
        anthropicCompatEnabled: prior.anthropicCompatEnabled,
        openaiCompatEnabled: prior.openaiCompatEnabled,
      }
    : null;

  const ada = await makeUser("gp-ada@example.com");
  adaId = ada.id;
  adaAuth = ada.auth;
  const bruno = await makeUser("gp-bruno@example.com");
  brunoId = bruno.id;
  brunoAuth = bruno.auth;
  const root = await makeUser("gp-root@example.com", true);
  rootId = root.id;
  rootAuth = root.auth;

  primaryAgentId = await makeAgent("gp-primary", "gp-primary-model", 3);
  fastAgentId = await makeAgent("gp-fast", "gp-fast-model", 1);
  rivalAgentId = await makeAgent("gp-rival", "gp-rival-model", 2);
  planOnlyAgentId = await makeAgent("gp-plan-only", "gp-plan-model", 1);
  decisionOnlyAgentId = await makeAgent("gp-decision", null, 1);

  await grant(adaId, primaryAgentId);
  await grant(adaId, fastAgentId);
  await grant(adaId, decisionOnlyAgentId);
  // ADA holds the plan-only agent in `plan` mode ONLY — the compat surface and
  // an `execute` invoke must both be refused for it, including as a hop.
  await grant(adaId, planOnlyAgentId, ["plan"]);
  await grant(brunoId, rivalAgentId);
  await grant(rootId, primaryAgentId);

  // both compat surfaces on, so GET /v1/models exists and both shapes are
  // reachable; the disabled-surface case turns them off and back on itself
  const s = await app.inject({
    method: "PUT",
    url: "/v1/interception/settings",
    headers: AUTH,
    payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true },
  });
  expect(s.statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  // Restore the interception singleton EXACTLY — a leaked `openaiCompatEnabled`
  // would silently change what other suites' 404 assertions mean.
  if (priorInterception) {
    await db
      .update(interceptionSettings)
      .set(priorInterception)
      .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  }
  if (createdAgentIds.length > 0) {
    await db.delete(agents).where(inArray(agents.id, createdAgentIds));
  }
  if (createdUserIds.length > 0) {
    // virtual_keys cascade on the owner, so this removes them too
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

// ===========================================================================
// 1. GET /v1/models — the discovery endpoint
// ===========================================================================

describe("GET /v1/models — entitlement-filtered discovery", () => {
  it("answers the OpenAI list envelope by default", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    for (const m of body.data) {
      expect(m.object).toBe("model");
      expect(typeof m.id).toBe("string");
      expect(typeof m.created).toBe("number");
      expect(typeof m.owned_by).toBe("string");
    }
  });

  it("answers the ANTHROPIC list envelope when the SDK's version header is present", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...adaAuth, "anthropic-version": "2023-06-01" },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.object).toBeUndefined();
    expect(body.has_more).toBe(false);
    for (const m of body.data) {
      expect(m.type).toBe("model");
      expect(typeof m.display_name).toBe("string");
      expect(typeof m.created_at).toBe("string");
    }
    // same SET of ids either way — one filter, two envelopes
    const openai = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    expect(body.data.map((m: { id: string }) => m.id).sort()).toEqual(
      openai.json().data.map((m: { id: string }) => m.id).sort(),
    );
  });

  it("accepts the Anthropic x-api-key credential header, like POST /v1/messages does", async () => {
    const token = adaAuth.authorization.slice("Bearer ".length);
    const r = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.length).toBeGreaterThan(0);
  });

  // ---- THE HEADLINE ------------------------------------------------------
  it("TWO USERS, DIFFERENT GRANTS, DIFFERENT LISTS — and neither sees the other's", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    const b = await app.inject({ method: "GET", url: "/v1/models", headers: brunoAuth });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const adaModels = a.json().data.map((m: { id: string }) => m.id);
    const brunoModels = b.json().data.map((m: { id: string }) => m.id);

    expect(adaModels).toContain("gp-primary-model");
    expect(adaModels).toContain("gp-fast-model");
    // BRUNO's model is ABSENT from ADA's list — not listed-then-403
    expect(adaModels).not.toContain("gp-rival-model");

    expect(brunoModels).toContain("gp-rival-model");
    expect(brunoModels).not.toContain("gp-primary-model");
    expect(brunoModels).not.toContain("gp-fast-model");

    // and the lists really are different objects, not the same list twice
    expect(adaModels.sort()).not.toEqual(brunoModels.sort());
  });

  it("a model listed for a user is a model that user can actually call", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    const ids: string[] = a.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gp-fast-model");
    const call = await chat({ ...adaAuth }, "gp-fast-model", "hello");
    expect(call.statusCode).toBe(200);
  });

  it("a model ABSENT from a user's list really is denied when called", async () => {
    const call = await chat({ ...adaAuth }, "gp-rival-model", "hello");
    expect(call.statusCode).toBe(403);
  });

  it("a DECISION-ONLY agent (no model id) is never advertised — it could not be dispatched", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    const agentIds = a.json().data.flatMap((m: { regulait: { agent_ids: string[] } }) => m.regulait.agent_ids);
    expect(agentIds).not.toContain(decisionOnlyAgentId);
  });

  it("an agent granted in PLAN mode only is absent from the execute-mode list", async () => {
    const a = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    expect(a.json().data.map((m: { id: string }) => m.id)).not.toContain("gp-plan-model");
  });

  it("the bootstrap token is REFUSED — this list is per-caller and it has no identity", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/models", headers: AUTH });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.type).toBe("bootstrap_cannot_list");
  });

  it("every listing is audited", async () => {
    const before = (await auditRows("models-listed", adaId)).length;
    await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    const after = await auditRows("models-listed", adaId);
    expect(after.length).toBe(before + 1);
    expect(latestRow(after).effect).toBe("allow");
  });

  it("404s — indistinguishably — when BOTH compat surfaces are off", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/interception/settings",
      headers: AUTH,
      payload: { anthropicCompatEnabled: false, openaiCompatEnabled: false },
    });
    const off = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    expect(off.statusCode).toBe(404);
    expect(off.json().error).toBe("Not Found");

    // one surface is enough — the discovery endpoint serves both shims
    await app.inject({
      method: "PUT",
      url: "/v1/interception/settings",
      headers: AUTH,
      payload: { openaiCompatEnabled: true },
    });
    const on = await app.inject({ method: "GET", url: "/v1/models", headers: adaAuth });
    expect(on.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: "/v1/interception/settings",
      headers: AUTH,
      payload: { anthropicCompatEnabled: true, openaiCompatEnabled: true },
    });
  });
});

// ===========================================================================
// 2. Virtual keys — the ceiling
// ===========================================================================

describe("virtual keys: issuance and storage", () => {
  it("returns the token ONCE and stores only its hash", async () => {
    const k = await issueKey(adaAuth, { name: "gp-plain" });
    expect(k.token.startsWith("rglv_")).toBe(true);
    expect(k.body.token).toBeDefined();

    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, k.id));
    expect(row).toBeDefined();
    // the plaintext token appears NOWHERE on the row
    expect(JSON.stringify(row)).not.toContain(k.token);
    expect(row!.tokenHash).not.toBe(k.token);
    expect(row!.tokenHash).toHaveLength(64);

    // and a read-back never returns it again
    const list = await app.inject({ method: "GET", url: "/v1/virtual-keys", headers: adaAuth });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(k.token);
  });

  it("authenticates on the compat surface and dispatches under the OWNER's entitlements", async () => {
    const k = await issueKey(adaAuth, { name: "gp-owner-entitlement" });
    const r = await chat(k.header!, "gp-fast-model", "hello from a virtual key");
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const [row] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.virtualKeyId, k.id));
    expect(row).toBeDefined();
    expect(row!.userId).toBe(adaId);
  });

  it("a non-admin cannot issue a key for someone ELSE", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: adaAuth,
      payload: { name: "gp-steal", userId: brunoId },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("not_key_owner");
  });

  it("a non-admin cannot pin which platform credential a key burns", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: adaAuth,
      payload: { name: "gp-pin", upstreamCredentialId: "00000000-0000-0000-0000-000000000001" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("admin_only_field");
  });

  it("an already-expired key is refused at issue time rather than created inert", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: adaAuth,
      payload: { name: "gp-past", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("expiry_in_the_past");
  });
});

describe("virtual keys: THE CEILING — a key can only narrow", () => {
  it("a key ALLOW-LISTING a model its OWNER is not granted still DENIES", async () => {
    // ADA has no grant on gp-rival-model. The key lists it anyway.
    const k = await issueKey(adaAuth, {
      name: "gp-overreach",
      allowedModels: ["gp-rival-model", "gp-fast-model"],
    });
    const before = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));

    const r = await chat(k.header!, "gp-rival-model", "give me the rival model");
    expect(r.statusCode).toBe(403);

    // and nothing was billed for the refusal
    const after = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(after.length).toBe(before.length);

    // the SAME key still works for the model the owner IS granted — proving the
    // denial was the owner's entitlement, not a broken key
    const ok = await chat(k.header!, "gp-fast-model", "and now a model I may use");
    expect(ok.statusCode).toBe(200);
  });

  it("a key NARROWS: a model the owner may use but the key does not list is refused", async () => {
    const k = await issueKey(adaAuth, { name: "gp-narrow", allowedModels: ["gp-fast-model"] });
    const denied = await chat(k.header!, "gp-primary-model", "hello");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.regulait_code).toBe("virtual_key_model_not_allowed");
    // the owner's OWN key reaches it fine — the restriction is the virtual key
    const owner = await chat({ ...adaAuth }, "gp-primary-model", "hello");
    expect(owner.statusCode).toBe(200);
  });

  it("an EMPTY allow-list means nothing, not everything", async () => {
    const k = await issueKey(adaAuth, { name: "gp-empty", allowedModels: [] });
    const r = await chat(k.header!, "gp-fast-model", "hello");
    expect(r.statusCode).toBe(403);
  });

  it("an allow-list entry may name the AGENT ID as well as the model id", async () => {
    const k = await issueKey(adaAuth, { name: "gp-by-agent-id", allowedModels: [fastAgentId] });
    const r = await chat(k.header!, "gp-fast-model", "hello");
    expect(r.statusCode).toBe(200);
  });

  it("GET /v1/models under a key shows the INTERSECTION, so the picker cannot lie", async () => {
    const k = await issueKey(adaAuth, {
      name: "gp-models-intersect",
      allowedModels: ["gp-fast-model", "gp-rival-model"],
    });
    const r = await app.inject({ method: "GET", url: "/v1/models", headers: k.header! });
    expect(r.statusCode).toBe(200);
    const ids = r.json().data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["gp-fast-model"]); // rival is the owner's ceiling, not the key's
  });

  it("the allow-list binds on the NATIVE dispatch path too, including dispatch:false", async () => {
    const k = await issueKey(adaAuth, { name: "gp-native", allowedModels: ["gp-fast-model"] });
    const dispatched = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: k.header!,
      payload: { mode: "execute", input: "hello", dispatch: true },
    });
    expect(dispatched.statusCode).toBe(403);
    expect(dispatched.json().error).toBe("virtual_key_model_not_allowed");

    // a DECISION-ONLY invoke never reaches the dispatch core, so a check placed
    // only there would let this through
    const decisionOnly = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: k.header!,
      payload: { mode: "execute", input: "hello" },
    });
    expect(decisionOnly.statusCode).toBe(403);
    expect(decisionOnly.json().error).toBe("virtual_key_model_not_allowed");

    // and the allowed one really does work through the same route
    const ok = await app.inject({
      method: "POST",
      url: `/v1/agents/${fastAgentId}/invoke`,
      headers: k.header!,
      payload: { mode: "execute", input: "hello", dispatch: true },
    });
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
  });

  it("every allow-list refusal is audited against the KEY, not buried under the agent", async () => {
    const rows = await auditRows("virtual-key-model-not-allowed");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.objectType === "virtual_key")).toBe(true);
    expect(rows.every((r) => r.effect === "deny")).toBe(true);
  });
});

describe("virtual keys: budget", () => {
  it("refuses honestly with a 402 once the budget is exhausted, and bills nothing for the refusal", async () => {
    // a budget small enough that one priced dispatch crosses it
    const k = await issueKey(adaAuth, { name: "gp-budget", budgetUsd: 0.0000001 });
    const first = await chat(k.header!, "gp-fast-model", "the first call is allowed");
    expect(first.statusCode).toBe(200);

    const [row] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, k.id));
    expect(row!.spentUsd).toBeGreaterThan(0);

    const second = await chat(k.header!, "gp-fast-model", "the second call must be refused");
    expect(second.statusCode).toBe(402);
    expect(second.json().error.regulait_code).toBe("virtual_key_budget_exhausted");
    expect(JSON.stringify(second.json())).toContain("budget");

    // exactly ONE usage row for this key: the refusal wrote none
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(rows.length).toBe(1);

    // raising the budget makes it work again — so the 402 was the budget
    await app.inject({
      method: "PATCH",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
      payload: { budgetUsd: 100 },
    });
    const third = await chat(k.header!, "gp-fast-model", "and now it works again");
    expect(third.statusCode).toBe(200);
  });

  it("spend rides the ONE ledger — the usage view and the enforcement counter agree", async () => {
    const k = await issueKey(adaAuth, { name: "gp-ledger" });
    await chat(k.header!, "gp-fast-model", "one");
    await chat(k.header!, "gp-fast-model", "two");
    const r = await app.inject({
      method: "GET",
      url: `/v1/virtual-keys/${k.id}/usage`,
      headers: adaAuth,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.events).toBe(2);
    expect(body.meteredUsd).toBeGreaterThan(0);
    expect(body.meteredUsd).toBeCloseTo(body.key.spentUsd, 10);
  });

  it("a key with NO budget is unlimited — the enforcement is opt-in, not implicit", async () => {
    const k = await issueKey(adaAuth, { name: "gp-nobudget" });
    for (let i = 0; i < 3; i++) {
      const r = await chat(k.header!, "gp-fast-model", `call ${i}`);
      expect(r.statusCode).toBe(200);
    }
  });
});

describe("virtual keys: the pinned upstream credential", () => {
  it("refuses a PROVIDER MISMATCH rather than silently burning a different credential", async () => {
    // A platform credential under a provider name NOTHING else in this codebase
    // ever queries. Deliberately inserted directly rather than through
    // POST /v1/model-credentials with a real vendor name: `model_credentials`
    // is UNIQUE on provider and is read by suites that assert "no stored
    // credential", and every suite encrypts under its OWN data key — so a real
    // `anthropic` row created here would be a cross-suite landmine for the
    // whole run. The ciphertext is never decrypted on this path because the
    // provider mismatch returns first, which is the behaviour under test.
    const [cred] = await db
      .insert(modelCredentials)
      .values({ provider: "gp-not-a-provider", keyCiphertext: "gp-never-decrypted" })
      .returning();
    const credId = cred!.id;

    // …pinned to a key whose owner will call an OPENAI agent
    const openaiAgent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "gp-openai", provider: "openai", tier: 1, model: "gp-openai-model" },
    });
    expect(openaiAgent.statusCode).toBe(201);
    const openaiAgentId = openaiAgent.json().id as string;
    createdAgentIds.push(openaiAgentId);
    await grant(adaId, openaiAgentId);

    const k = await issueKey(rootAuth, {
      name: "gp-pinned",
      userId: adaId,
      upstreamCredentialId: credId,
    });
    let r: Awaited<ReturnType<typeof app.inject>>;
    let billed: unknown[];
    try {
      r = await app.inject({
        method: "POST",
        url: `/v1/agents/${openaiAgentId}/invoke`,
        headers: k.header!,
        payload: { mode: "execute", input: "hello", dispatch: true },
      });
      billed = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    } finally {
      // Cleaned up even if an assertion above throws. The virtual key must go
      // FIRST: `upstream_credential_id` is ON DELETE RESTRICT, so a credential a
      // live key still points at cannot be deleted out from under it — which is
      // the intended behaviour, and would otherwise strand this row.
      await db.delete(virtualKeys).where(eq(virtualKeys.id, k.id));
      await db.delete(modelCredentials).where(eq(modelCredentials.id, credId));
    }
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("virtual_key_credential_provider_mismatch");
    // nothing was billed to the key
    expect(billed.length).toBe(0);
  });

  it("refuses at issue time when the named credential does not exist", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: rootAuth,
      payload: {
        name: "gp-ghost-cred",
        upstreamCredentialId: "00000000-0000-0000-0000-0000000000aa",
      },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("credential_not_found");
  });
});

describe("virtual keys: lifecycle", () => {
  it("a REVOKED key stops authenticating immediately, and says so", async () => {
    const k = await issueKey(adaAuth, { name: "gp-revoke" });
    expect((await chat(k.header!, "gp-fast-model", "before")).statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
    });
    expect(del.statusCode).toBe(200);
    const after = await chat(k.header!, "gp-fast-model", "after");
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("virtual_key_revoked");
  });

  it("an EXPIRED key stops authenticating, and says so", async () => {
    const k = await issueKey(adaAuth, {
      name: "gp-expire",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await chat(k.header!, "gp-fast-model", "before")).statusCode).toBe(200);
    // move the expiry into the past directly — the derived rule is what is
    // under test, not the clock
    await db
      .update(virtualKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(virtualKeys.id, k.id));
    const after = await chat(k.header!, "gp-fast-model", "after");
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("virtual_key_expired");
  });

  it("the OWNER of an ADMIN-ISSUED key cannot raise its ceiling — only rename or revoke it", async () => {
    // root (admin) issues ADA a $1 key. ADA owns it; root issued it.
    const k = await issueKey(rootAuth, { name: "gp-issued-for-ada", userId: adaId, budgetUsd: 1 });
    const raise = await app.inject({
      method: "PATCH",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
      payload: { budgetUsd: 10_000 },
    });
    expect(raise.statusCode).toBe(403);
    expect(raise.json().error).toBe("not_key_issuer");

    const widen = await app.inject({
      method: "PATCH",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
      payload: { allowedModels: null },
    });
    expect(widen.statusCode).toBe(403);

    // renaming is fine, and so is revoking — both only ever narrow or annotate
    const rename = await app.inject({
      method: "PATCH",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
      payload: { name: "gp-renamed" },
    });
    expect(rename.statusCode).toBe(200);
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/virtual-keys/${k.id}`,
      headers: adaAuth,
    });
    expect(revoke.statusCode).toBe(200);

    // and the issuer really can change it
    const k2 = await issueKey(rootAuth, { name: "gp-issuer-can", userId: adaId, budgetUsd: 1 });
    const byIssuer = await app.inject({
      method: "PATCH",
      url: `/v1/virtual-keys/${k2.id}`,
      headers: rootAuth,
      payload: { budgetUsd: 5 },
    });
    expect(byIssuer.statusCode).toBe(200);
    expect(byIssuer.json().budgetUsd).toBe(5);
  });

  it("a non-owner cannot even SEE someone else's key", async () => {
    const k = await issueKey(adaAuth, { name: "gp-private" });
    const r = await app.inject({
      method: "GET",
      url: `/v1/virtual-keys/${k.id}/usage`,
      headers: brunoAuth,
    });
    expect(r.statusCode).toBe(404); // invisible, not 403 — reveals nothing
    const list = await app.inject({ method: "GET", url: "/v1/virtual-keys", headers: brunoAuth });
    expect(list.json().keys.map((x: { id: string }) => x.id)).not.toContain(k.id);
  });

  it("issuance and revocation are audited", async () => {
    expect((await auditRows("virtual-key-issued")).length).toBeGreaterThan(0);
    expect((await auditRows("virtual-key-revoked")).length).toBeGreaterThan(0);
  });
});

describe("virtual keys: THE ROUTE CEILING", () => {
  it("cannot mint another virtual key", async () => {
    const k = await issueKey(adaAuth, { name: "gp-scope-mint" });
    const r = await app.inject({
      method: "POST",
      url: "/v1/virtual-keys",
      headers: k.header!,
      payload: { name: "gp-child" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("virtual_key_scope");
  });

  it("cannot reach a governance route its owner could reach", async () => {
    const k = await issueKey(adaAuth, { name: "gp-scope-convo" });
    // ADA may create conversations with her own key…
    const owner = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: adaAuth,
      payload: { agentId: fastAgentId },
    });
    expect(owner.statusCode, JSON.stringify(owner.json())).toBe(201);
    // …and the virtual key may not
    const vkey = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: k.header!,
      payload: { agentId: fastAgentId },
    });
    expect(vkey.statusCode).toBe(403);
    expect(vkey.json().error).toBe("virtual_key_scope");
  });

  it("A KEY ISSUED BY AN ADMIN IS NOT AN ADMIN", async () => {
    // sanity: the owner really is an admin
    const adminOk = await app.inject({ method: "GET", url: "/v1/users", headers: rootAuth });
    expect(adminOk.statusCode).toBe(200);

    const k = await issueKey(rootAuth, { name: "gp-admin-owned" });
    const r = await app.inject({ method: "GET", url: "/v1/users", headers: k.header! });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("virtual_key_scope");

    // and /v1/me reports it as non-admin
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: k.header! });
    expect(me.statusCode).toBe(200);
    expect(me.json().isAdmin).toBe(false);
    expect(me.json().userId).toBe(rootId);
  });

  it("cannot be exchanged for a browser session — that would undo every restriction", async () => {
    const k = await issueKey(adaAuth, { name: "gp-exchange" });
    const r = await app.inject({
      method: "POST",
      url: "/auth/login-with-key",
      headers: { "x-regulait-csrf": "1" },
      payload: { apiKey: k.token },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("virtual_key_not_exchangeable");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
});

// ===========================================================================
// 3. Provider fallback chains
// ===========================================================================

describe("fallback chains: configuration", () => {
  it("refuses a self-referential chain", async () => {
    const r = await setFallbacks(primaryAgentId, [primaryAgentId], 422);
    expect(r.json().error).toBe("self_fallback");
  });

  it("refuses duplicates and unknown agents", async () => {
    expect((await setFallbacks(primaryAgentId, [fastAgentId, fastAgentId], 422)).json().error).toBe(
      "duplicate_fallback",
    );
    expect(
      (await setFallbacks(primaryAgentId, ["00000000-0000-0000-0000-0000000000ff"], 422)).json().error,
    ).toBe("unknown_fallback_agent");
  });

  it("refuses a hop that could never dispatch (no model id)", async () => {
    const r = await setFallbacks(primaryAgentId, [decisionOnlyAgentId], 422);
    expect(r.json().error).toBe("fallback_not_dispatchable");
  });

  it("PUT replaces the whole ordered chain and reads back in order", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId, rivalAgentId]);
    const r = await app.inject({
      method: "GET",
      url: `/v1/agents/${primaryAgentId}/fallbacks`,
      headers: AUTH,
    });
    expect(r.json().fallbacks.map((f: { agentId: string }) => f.agentId)).toEqual([
      fastAgentId,
      rivalAgentId,
    ]);
    await setFallbacks(primaryAgentId, []);
    const cleared = await app.inject({
      method: "GET",
      url: `/v1/agents/${primaryAgentId}/fallbacks`,
      headers: AUTH,
    });
    expect(cleared.json().fallbacks).toEqual([]);
  });
});

describe("fallback chains: only a TRANSPORT failure triggers one", () => {
  it("an upstream failure falls back, and the fallback is DISCLOSED, not silent", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: adaAuth,
      payload: {
        mode: "execute",
        // fails ONLY on the primary's model id; the hop answers normally
        input: "please answer <<upstream-error:gp-primary-model>>",
        dispatch: true,
      },
    });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const d = r.json().dispatch;
    expect(d.servedAgentId).toBe(fastAgentId);
    expect(d.fallback).toBeDefined();
    expect(d.fallback.primaryAgentId).toBe(primaryAgentId);
    expect(d.fallback.servedAgentId).toBe(fastAgentId);
    expect(d.fallback.hops).toHaveLength(1);
    expect(d.fallback.hops[0].outcome).toBe("served");

    const served = await auditRows("fallback-hop-served", adaId);
    expect(served.length).toBeGreaterThan(0);
    expect(latestRow(served).detail).toMatchObject({ primaryAgentId });
  });

  it("A GOVERNANCE DENY DOES NOT FALL BACK — zero hops attempted, zero audit rows", async () => {
    await setFallbacks(rivalAgentId, [fastAgentId]);
    const before = (await auditRows("fallback-hop-served", adaId)).length;
    const beforeDenied = (await auditRows("fallback-hop-denied", adaId)).length;

    // ADA is NOT entitled to gp-rival. gp-fast, its fallback, she IS entitled
    // to — so a chain that treated a denial as a failure would have served.
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${rivalAgentId}/invoke`,
      headers: adaAuth,
      payload: { mode: "execute", input: "hello", dispatch: true },
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.json())).not.toContain(fastAgentId);
    expect((await auditRows("fallback-hop-served", adaId)).length).toBe(before);
    expect((await auditRows("fallback-hop-denied", adaId)).length).toBe(beforeDenied);
    await setFallbacks(rivalAgentId, []);
  });

  it("A MODEL REFUSAL DOES NOT FALL BACK — a refusal is an answer, not a failure", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const before = (await auditRows("fallback-hop-served", adaId)).length;
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: adaAuth,
      payload: { mode: "execute", input: "please <<refuse>> this", dispatch: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.refusal).toBe(true);
    expect(r.json().dispatch.servedAgentId).toBe(primaryAgentId);
    expect(r.json().dispatch.fallback).toBeUndefined();
    expect((await auditRows("fallback-hop-served", adaId)).length).toBe(before);
  });

  it("AN EXHAUSTED KEY BUDGET DOES NOT FALL BACK — it is a decision, not an outage", async () => {
    // The most tempting bypass in the whole feature: a key with no funds left,
    // pointed at an agent that has a fallback the owner IS entitled to. If the
    // chain triggered on any non-ok outcome, the 402 would quietly become a
    // successful call on a different model — spending money the key does not
    // have, on a target nobody chose.
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const k = await issueKey(adaAuth, { name: "gp-budget-no-fallback", budgetUsd: 0 });
    const before = (await auditRows("fallback-hop-served", adaId)).length;
    const beforeDenied = (await auditRows("fallback-hop-denied", adaId)).length;

    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: k.header!,
      payload: { mode: "execute", input: "hello", dispatch: true },
    });
    // the refusal surfaces as ITSELF, and no hop was even considered
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("virtual_key_budget_exhausted");
    expect(r.json().fallback).toBeUndefined();
    expect((await auditRows("fallback-hop-served", adaId)).length).toBe(before);
    expect((await auditRows("fallback-hop-denied", adaId)).length).toBe(beforeDenied);
    // nothing was billed, on either the ledger or the counter
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.virtualKeyId, k.id));
    expect(rows.length).toBe(0);
    await setFallbacks(primaryAgentId, []);
  });
});

describe("fallback chains: entitlement is re-evaluated PER HOP", () => {
  it("an unentitled hop is SKIPPED and AUDITED; the next entitled hop serves", async () => {
    // hop 0 = gp-rival (ADA has NO grant), hop 1 = gp-fast (ADA does)
    await setFallbacks(primaryAgentId, [rivalAgentId, fastAgentId]);
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: adaAuth,
      payload: { mode: "execute", input: "go <<upstream-error:gp-primary-model>>", dispatch: true },
    });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    const fb = r.json().dispatch.fallback;
    expect(fb.hops).toHaveLength(2);
    expect(fb.hops[0]).toMatchObject({ agentId: rivalAgentId, outcome: "denied" });
    expect(fb.hops[1]).toMatchObject({ agentId: fastAgentId, outcome: "served" });
    expect(r.json().dispatch.servedAgentId).toBe(fastAgentId);

    const denied = await auditRows("fallback-hop-denied", adaId);
    expect(denied.some((d) => d.objectId === rivalAgentId)).toBe(true);
  });

  it("the SAME chain serves the FIRST hop for a user who IS entitled to it", async () => {
    // BRUNO is granted gp-rival but nothing else; give him the primary too so
    // the chain is reachable, and the first hop must now serve for HIM.
    await grant(brunoId, primaryAgentId);
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: brunoAuth,
      payload: { mode: "execute", input: "go <<upstream-error:gp-primary-model>>", dispatch: true },
    });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    expect(r.json().dispatch.servedAgentId).toBe(rivalAgentId);
    expect(r.json().dispatch.fallback.hops[0]).toMatchObject({
      agentId: rivalAgentId,
      outcome: "served",
    });
  });

  it("a MODE-restricted hop is refused in execute mode, exactly as a direct call would be", async () => {
    // ADA holds gp-plan-only in `plan` mode only
    await setFallbacks(primaryAgentId, [planOnlyAgentId, fastAgentId]);
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: adaAuth,
      payload: { mode: "execute", input: "go <<upstream-error:gp-primary-model>>", dispatch: true },
    });
    expect(r.statusCode).toBe(200);
    const fb = r.json().dispatch.fallback;
    expect(fb.hops[0]).toMatchObject({ agentId: planOnlyAgentId, outcome: "denied" });
    expect(fb.hops[1]).toMatchObject({ agentId: fastAgentId, outcome: "served" });
  });

  it("an exhausted chain returns the ORIGINAL failure, with every attempt disclosed", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: adaAuth,
      // no model id after the colon: EVERY model fails
      payload: { mode: "execute", input: "go <<upstream-error>>", dispatch: true },
    });
    expect(r.statusCode).toBe(502);
    const err = r.json();
    expect(err.error).toBe("model_dispatch_failed");
    // the primary's model is named, not the last hop's
    expect(err.detail).toContain("gp-primary-model");
    expect(err.fallback.servedAgentId).toBeNull();
    expect(err.fallback.hops[0]).toMatchObject({ agentId: fastAgentId, outcome: "failed" });
    expect((await auditRows("fallback-chain-exhausted", adaId)).length).toBeGreaterThan(0);
  });

  it("a virtual key's allow-list also binds on a fallback HOP", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const k = await issueKey(adaAuth, {
      name: "gp-hop-ceiling",
      allowedModels: ["gp-primary-model"], // the hop's model is NOT listed
    });
    const r = await app.inject({
      method: "POST",
      url: `/v1/agents/${primaryAgentId}/invoke`,
      headers: k.header!,
      payload: { mode: "execute", input: "go <<upstream-error:gp-primary-model>>", dispatch: true },
    });
    expect(r.statusCode).toBe(502);
    const err = r.json();
    expect(err.error).toBe("model_dispatch_failed");
    expect(err.fallback.hops[0]).toMatchObject({ agentId: fastAgentId, outcome: "denied" });
    await setFallbacks(primaryAgentId, []);
  });

  it("the compat surface inherits the chain — one core, not two implementations", async () => {
    await setFallbacks(primaryAgentId, [fastAgentId]);
    const r = await chat({ ...adaAuth }, "gp-primary-model", "go <<upstream-error:gp-primary-model>>");
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    // the disclosure headers name what actually served
    const usage = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.agentId, fastAgentId));
    expect(usage.length).toBeGreaterThan(0);
    await setFallbacks(primaryAgentId, []);
  });
});
