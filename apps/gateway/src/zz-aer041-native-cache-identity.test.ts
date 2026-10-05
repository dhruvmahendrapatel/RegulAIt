/**
 * AER-041 / ADR-0146 — the native `/invoke` semantic cache answers only the
 * request it was asked, under the configuration that answered it.
 *
 * The defect: the key was `body.input` lower-cased and whitespace-collapsed,
 * scoped by user and agent. Case-sensitive identifiers collided, a small
 * `maxTokens` request got a prior long answer, the caller's `system` was
 * ignored, and re-pointing the agent at another model or system prompt left
 * every old answer servable. The prior test suite PINNED that behaviour — its
 * case (a) asserted a case/whitespace variant hits — so this file is also the
 * replacement for that assertion, which is changed in `semantic-cache.test.ts`.
 *
 * THE INSTRUMENT. "Did it miss?" is answered by the ledger, not only by the
 * `cached` flag: a miss must add exactly one usage row (a real dispatch) and a
 * hit must add none. Every miss case below is paired with the byte-identical
 * control that still hits (M-033), or the matrix could pass with the cache
 * simply broken.
 *
 * Writes agents, prompt versions and cache rows, so `zz-` (M-018); every
 * assertion is scoped to ids created here (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, runMigrations, semanticCache, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import {
  lookupSemanticCache,
  semanticCacheNativeKey,
  type NativeCacheConfig,
  type NativeCacheRequest,
} from "./semantic-cache-shared.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `aer041-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
/**
 * THE CURRENT CALLER. Reassigned by `freshUser()` at the start of every test,
 * and that is load-bearing rather than tidy: pillar-6 routing chooses among the
 * CALLER's entitled agents, so if one user were shared, an agent created by an
 * earlier test becomes a routing candidate in a later one, the call is served
 * by that peer, and — correctly, under ADR-0146 — nothing is cached. The first
 * run of this file failed exactly that way (M-040: never rest an assertion on
 * state another test created).
 */
let userId = "";
let auth = { authorization: "" };

async function freshUser(tag: string) {
  const u = await post("/v1/users", { email: `aer041-${tag}-${RUN}@example.com`, displayName: `AER041 ${tag}` });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;
  auth = { authorization: `Bearer ${(await post(`/v1/users/${userId}/keys`, { name: "k" })).json().token}` };
}

const post = (url: string, payload: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

async function makeAgent(name: string, extra: Record<string, unknown> = {}) {
  const res = await post("/v1/agents", {
    name: `${name}-${RUN}`,
    provider: "mock",
    tier: 1,
    modes: ["chat"],
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    model: "mock-balanced",
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  expect((await post("/v1/grants/agents", { userId, agentId: id })).statusCode).toBeLessThan(300);
  return id;
}

async function invoke(agentId: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: auth,
    payload: { mode: "chat", dispatch: true, semanticCache: true, ...payload },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { cached?: boolean; dispatch: { outputText: string; servedAgentId?: string } };
}

const usage = async () =>
  (await db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, userId))).length;
const cacheRows = async (agentId: string) =>
  (await db.select().from(semanticCache).where(eq(semanticCache.userId, userId))).filter(
    (r) => r.agentId === agentId,
  );

/** One call, classified by the ledger rather than by the response flag. */
async function classify(agentId: string, payload: Record<string, unknown>) {
  const before = await usage();
  const res = await invoke(agentId, payload);
  const dispatched = (await usage()) - before;
  if (res.cached === true) {
    expect(dispatched, "a hit must not dispatch").toBe(0);
    return "hit" as const;
  }
  expect(dispatched, "a miss must dispatch exactly once").toBe(1);
  // every agent in this file is the only one its user can reach (except in the
  // routing test, which does not use classify), so a dispatch served by any
  // other agent means the fixture is wrong, not the cache
  expect(res.dispatch.servedAgentId, "served by the requested agent").toBe(agentId);
  return "miss" as const;
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the semantic cache ships OFF and the org PII floor at block. This file pins
  // the opt-in cache key, so it sets opt_in and the floor off explicitly; restored in afterAll.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { semanticCachePolicy: "opt_in", defaultPiiMode: "none" }, interception: false, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
}, 120_000);

afterAll(async () => {
  await restoreSb1Posture?.();
  app.server.closeAllConnections();
  await app.close();
});

describe("the request the answer was produced for", () => {
  it("misses on every generation-affecting change, and the byte-identical control still hits", async () => {
    await freshUser("request");
    const agentId = await makeAgent("aer041-request");
    const project = await post("/v1/projects", { name: `aer041-project-${RUN}` });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id as string;
    expect(
      (await post(`/v1/projects/${projectId}/members`, { userId, role: "contributor" })).statusCode,
    ).toBe(201);

    const base = { input: `Is getUserId defined in module ${RUN}?`, maxTokens: 400 };
    expect(await classify(agentId, base), "seed").toBe("miss");
    // POSITIVE CONTROL: without it, every miss below is satisfied by a cache
    // that never hits at all.
    expect(await classify(agentId, base), "byte-identical re-ask").toBe("hit");

    const variants: Array<[string, Record<string, unknown>]> = [
      ["case of an identifier", { ...base, input: base.input.replace("getUserId", "getuserid") }],
      ["whitespace", { ...base, input: base.input.replace("defined in", "defined  in") }],
      ["maxTokens", { ...base, maxTokens: 20 }],
      ["no maxTokens", { input: base.input }],
      ["caller system", { ...base, system: "Answer in French." }],
      ["baseline", { ...base, baseline: "export const getUserId = () => 1;" }],
      ["reference content", { ...base, referenceContent: "module docs v2" }],
      ["mode-independent cost sensitivity", { ...base, costSensitivity: "quality-sensitive" }],
      ["project attribution", { ...base, projectId }],
    ];
    for (const [label, payload] of variants) {
      expect(await classify(agentId, payload), label).toBe("miss");
    }
    // and each variant now has its OWN row rather than overwriting the seed's
    expect(await classify(agentId, base), "the original is still cached").toBe("hit");
  });

  it("stores only a commitment: no request text reaches the cache row", async () => {
    await freshUser("plaintext");
    const agentId = await makeAgent("aer041-plaintext");
    const secret = `private-system-${RUN}`;
    expect(await classify(agentId, { input: `plaintext probe ${RUN}`, system: secret })).toBe("miss");
    const [row] = await cacheRows(agentId);
    expect(row).toBeDefined();
    expect(row!.normalizedInput.startsWith("native-v2:")).toBe(true);
    expect(row!.normalizedInput).not.toContain(secret);
    expect(row!.normalizedInput).not.toContain("plaintext probe");
  });
});

describe("the configuration that answered it", () => {
  it("a model change misses; a system-prompt change misses; re-activating the old version hits again", async () => {
    await freshUser("config");
    const agentId = await makeAgent("aer041-config");
    const q = { input: `config identity ${RUN}` };

    expect((await post(`/v1/agents/${agentId}/system-prompt`, { systemPrompt: "You are terse." })).statusCode).toBe(200);
    expect(await classify(agentId, q), "seed under prompt v1").toBe("miss");
    expect(await classify(agentId, q), "control").toBe("hit");

    // a new system prompt is a new served configuration
    expect((await post(`/v1/agents/${agentId}/system-prompt`, { systemPrompt: "You are verbose." })).statusCode).toBe(200);
    expect(await classify(agentId, q), "after the prompt changed").toBe("miss");

    // rolling the prompt back to the IDENTICAL immutable version restores the
    // identity the first answer was produced under — it is servable again
    const activated = await post(`/v1/config-versions/agent_system_prompt/${agentId}/activate`, { version: 1 });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(await classify(agentId, q), "the original configuration is back").toBe("hit");

    // the model is part of the identity too
    const patched = await app.inject({
      method: "PATCH", url: `/v1/agents/${agentId}`, headers: AUTH, payload: { model: "mock-fast" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await classify(agentId, q), "after the model changed").toBe("miss");
  });

  it("an answer routing served from a DIFFERENT agent is not stored under the requested agent", async () => {
    // the requested agent is the expensive one; an entitled cheaper agent in
    // the same mode is what cost-sensitive routing downroutes to
    await freshUser("routing");
    const requested = await makeAgent("aer041-premium", { tier: 3, costPerMTokIn: 30, costPerMTokOut: 150 });
    await makeAgent("aer041-cheap", { tier: 1, costPerMTokIn: 0.1, costPerMTokOut: 0.5 });
    const res = await invoke(requested, { input: `hi ${RUN}`, costSensitivity: "cost-sensitive" });
    // PRECONDITION, not decoration: if routing did not move the call, this
    // test would pass with the guard deleted. Fail loudly instead.
    expect(res.dispatch.servedAgentId, "fixture must actually downroute").toBeDefined();
    expect(res.dispatch.servedAgentId).not.toBe(requested);
    expect(await cacheRows(requested), "no row filed under the requested agent").toHaveLength(0);
  });
});

describe("negative controls on the key itself", () => {
  const request: NativeCacheRequest = {
    input: "x",
    mode: "chat",
    system: null,
    baseline: null,
    referenceContent: null,
    attachments: [],
    maxTokens: null,
    costSensitivity: null,
    projectId: null,
    planner: { filePreprocessing: "auto", minPreprocessTokens: 1, editVsRewrite: "auto", minEditableBaselineTokens: 1 },
  };
  const config: NativeCacheConfig = {
    agentId: "00000000-0000-0000-0000-000000000001",
    provider: "mock",
    model: "m",
    customProvider: null,
    systemPrompt: null,
    agentConfigVersion: null,
    promptVersion: null,
  };
  const attachment = { kind: "image", name: "a.png", mediaType: "image/png", dataBase64: "AAAA" };
  /**
   * FIELD-OMISSION CONTROL. One mutation per field, and the table is checked
   * against the objects' own keys — so a field added to the request or config
   * shape without a mutation here fails this test, instead of silently not
   * being covered the way the old key silently ignored `maxTokens`.
   */
  const requestMutations: Record<keyof NativeCacheRequest, Partial<NativeCacheRequest>> = {
    input: { input: "X" },
    mode: { mode: "plan" },
    system: { system: "s" },
    baseline: { baseline: "b" },
    referenceContent: { referenceContent: "r" },
    attachments: { attachments: [attachment] },
    maxTokens: { maxTokens: 1 },
    costSensitivity: { costSensitivity: "cost-sensitive" },
    projectId: { projectId: "00000000-0000-0000-0000-000000000002" },
    planner: { planner: { ...request.planner, filePreprocessing: "passthrough" } },
  };
  const configMutations: Record<keyof NativeCacheConfig, Partial<NativeCacheConfig>> = {
    agentId: { agentId: "00000000-0000-0000-0000-000000000003" },
    provider: { provider: "anthropic" },
    model: { model: "n" },
    customProvider: { customProvider: { id: "c", wireProtocol: "openai_chat", baseUrl: "http://x" } },
    systemPrompt: { systemPrompt: "p" },
    agentConfigVersion: { agentConfigVersion: { id: "v", version: 1 } },
    promptVersion: { promptVersion: { id: "v", version: 1, canary: false } },
  };

  it("every request and config field changes the key, and no field is untested", () => {
    expect(Object.keys(requestMutations).sort()).toEqual(Object.keys(request).sort());
    expect(Object.keys(configMutations).sort()).toEqual(Object.keys(config).sort());
    const baseKey = semanticCacheNativeKey(request, config).norm;
    for (const [field, m] of Object.entries(requestMutations)) {
      expect(semanticCacheNativeKey({ ...request, ...m }, config).norm, `request.${field}`).not.toBe(baseKey);
    }
    for (const [field, m] of Object.entries(configMutations)) {
      expect(semanticCacheNativeKey(request, { ...config, ...m }).norm, `config.${field}`).not.toBe(baseKey);
    }
    // a canary flip on the same version id is a different identity as well
    const v = { id: "v", version: 1 };
    expect(semanticCacheNativeKey(request, { ...config, promptVersion: { ...v, canary: true } }).norm).not.toBe(
      semanticCacheNativeKey(request, { ...config, promptVersion: { ...v, canary: false } }).norm,
    );
    // and determinism: identical inputs, identical key
    expect(semanticCacheNativeKey({ ...request }, { ...config }).norm).toBe(baseKey);
  });

  it("COLLISION CONTROL: a row matching the index hash but not the commitment is refused", async () => {
    await freshUser("collision");
    const agentId = await makeAgent("aer041-collision");
    expect(await classify(agentId, { input: `collision ${RUN}` })).toBe("miss");
    const [row] = await cacheRows(agentId);
    const forged = await lookupSemanticCache(db, {
      userId,
      agentId,
      key: { hash: row!.promptHash, norm: `${row!.normalizedInput}x` },
      ttlSeconds: 3600,
    });
    expect(forged).toBeNull();
    // and the pre-ADR-0146 shape — normalised plain text in the same row —
    // can never match a native-v2 key: the upgrade misses closed
    await db.update(semanticCache).set({ normalizedInput: `collision ${RUN}` }).where(eq(semanticCache.id, row!.id));
    expect(await classify(agentId, { input: `collision ${RUN}` }), "legacy-shaped row").toBe("miss");
  });
});
