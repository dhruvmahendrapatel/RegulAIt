import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  agents,
  desc,
  eq,
  inArray,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { canaryBucket } from "@regulait/shared";

/**
 * Batch B1 — `agent_config` STOPS BEING VOCABULARY (ADR-0048 deviation 2 /
 * ADR-0073 disclosure 1, the last inert artifact type).
 *
 * What this file makes impossible to fake, in the ADR-0073 style:
 *
 *  1. ACTIVATION AND ROLLBACK GENUINELY CHANGE DISPATCH. Every assertion is on
 *     what the PROVIDER actually received (a recording spy on
 *     `resolveModelProvider`) or on the measured usage row — never on a column.
 *     A wiring that updated the row and served the old config cannot pass.
 *
 *  2. THE SHADOW CANNOT TOUCH THE SERVED DISPATCH. With a candidate model
 *     canarying at a percentage that samples the caller, the provider still
 *     receives the ACTIVE model — asserted directly — while an observation row
 *     records both sides and the divergence. A canary that recorded nothing
 *     fails the second half; one that served the candidate fails the first.
 *     Both are required together (the ADR-0073 invariant, verbatim).
 *
 *  3. PILLAR-5 COST ATTRIBUTION READS THE RESOLVED CONFIG. A version that
 *     clears the list price yields a NULL-cost usage row (a measured token
 *     count never becomes an invented dollar figure), and rollback restores
 *     the priced attribution — deterministic either way, no token-count
 *     arithmetic in the test.
 *
 * SHARED-STATE DISCIPLINE: `acfg-` prefixed agents/users owned by this suite;
 * one agent per user (the pillar-6 routing discipline the cfg suite states);
 * afterAll deletes this suite's versions, events, observations and usage rows.
 */

declare global {
  // eslint-disable-next-line no-var
  var __acfgProviderCalls: Array<{ model: string; system: string | null }>;
}
globalThis.__acfgProviderCalls = [];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        globalThis.__acfgProviderCalls.push({ model: req.model, system: req.system ?? null });
        return inner.dispatch(req);
      };
      return wrapped;
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

const BOOT = "acfg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
/** versioned/rolled-back through the API; granted ONLY to ana */
let agentId: string;
let anaId: string;
let anaAuth: { authorization: string };
/** the shadow-canary subject agent; granted to inside + outside */
let shadowAgentId: string;
let insideId: string;
let insideAuth: { authorization: string };
let outsideAuth: { authorization: string };
let canaryPct: number;

function calls() {
  return globalThis.__acfgProviderCalls;
}
function resetCalls() {
  globalThis.__acfgProviderCalls = [];
}

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace("-", " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "acfg" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, grantees: string[]) {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  expect(a.statusCode).toBe(201);
  const id = a.json().id as string;
  for (const g of grantees) {
    await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: g, agentId: id } });
  }
  return id;
}

async function invoke(auth: { authorization: string }, id: string) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${id}/invoke`,
    headers: auth,
    payload: { mode: "execute", input: "acfg probe", dispatch: true },
  });
}

async function versionsOf(artifactId: string) {
  return db
    .select()
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, "agent_config"), eq(configVersions.artifactId, artifactId)))
    .orderBy(configVersions.version);
}

async function observationsOf(artifactId: string) {
  return db
    .select()
    .from(configCanaryObservations)
    .where(
      and(
        eq(configCanaryObservations.artifactType, "agent_config"),
        eq(configCanaryObservations.artifactId, artifactId),
      ),
    )
    .orderBy(desc(configCanaryObservations.at));
}

async function latestUsage(aId: string, userId: string) {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.agentId, aId), eq(usageEvents.userId, userId)))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const ana = await makeUser("acfg-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  agentId = await makeAgent("acfg-versioned", [anaId]);

  shadowAgentId = await makeAgent("acfg-shadow", []);
  // an INSIDE and an OUTSIDE canary subject, chosen with the SAME pure
  // function the resolver samples with (the cfg suite's discipline: if
  // sampling ever stops being a pure function of the stable key, these
  // expectations become unsatisfiable rather than flaky). The invoke path has
  // no run/conversation, so the stable key is the user id.
  const found: Array<{ id: string; auth: { authorization: string }; bucket: number }> = [];
  for (let i = 0; i < 12 && found.length < 2; i++) {
    const u = await makeUser(`acfg-canary-${i}@example.com`);
    const bucket = canaryBucket(shadowAgentId, u.id);
    if (found.length === 0) {
      if (bucket <= 97) found.push({ ...u, bucket });
      continue;
    }
    if (bucket > found[0]!.bucket) found.push({ ...u, bucket });
  }
  expect(found.length).toBe(2);
  insideId = found[0]!.id;
  insideAuth = found[0]!.auth;
  outsideAuth = found[1]!.auth;
  canaryPct = found[0]!.bucket + 1; // samples inside, not outside
  for (const g of [insideId, found[1]!.id]) {
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: g, agentId: shadowAgentId },
    });
  }
  resetCalls();
});

afterAll(async () => {
  const ids = [agentId, shadowAgentId].filter(Boolean);
  await db.delete(usageEvents).where(inArray(usageEvents.agentId, ids));
  await db.delete(configCanaryObservations).where(inArray(configCanaryObservations.artifactId, ids));
  await db.delete(configActivationEvents).where(inArray(configActivationEvents.artifactId, ids));
  await db.delete(configVersions).where(inArray(configVersions.artifactId, ids));
});

// ---------------------------------------------------------------------------

describe("B1 — the ACTIVE agent_config version genuinely governs dispatch", () => {
  it("an UNVERSIONED agent dispatches from its row — byte-identical pre-B1 behaviour, nothing observed", async () => {
    const res = await invoke(anaAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.model).toBe("mock-balanced");
    expect(await observationsOf(agentId)).toEqual([]);
    resetCalls();
  });

  it("activating a version SWAPS THE DISPATCHED MODEL, mints the lazy baseline, and syncs the read-model", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: { body: { model: "mock-premium" }, label: "acfg v2 — premium", activate: true },
    });
    expect(created.statusCode).toBe(201);

    // the lazy baseline is the row exactly as it stood (ADR-0073 §5)
    const rows = await versionsOf(agentId);
    expect(rows.find((r) => r.version === 1)!.body).toMatchObject({
      model: "mock-balanced",
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    });
    expect(rows.find((r) => r.version === 2)!.status).toBe("active");

    // THE ASSERTION A ROW-READ CANNOT FAKE: the provider received the model
    // the ACTIVE VERSION names
    const res = await invoke(anaAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.model).toBe("mock-premium");

    // and the agents row is the read-model, kept in sync for listing surfaces
    const [row] = await db.select({ model: agents.model }).from(agents).where(eq(agents.id, agentId));
    expect(row!.model).toBe("mock-premium");
    resetCalls();
  });

  it("a version that CLEARS the list price makes pillar-5 attribution honestly null; rollback restores it", async () => {
    const priced = await latestUsage(agentId, anaId);
    expect(priced!.costUsd).not.toBeNull();

    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: {
        body: { model: "mock-premium", costPerMTokIn: null, costPerMTokOut: null },
        label: "acfg v3 — unpriced",
        activate: true,
      },
    });
    expect(created.statusCode).toBe(201);
    expect((await invoke(anaAuth, agentId)).statusCode).toBe(200);
    const unpriced = await latestUsage(agentId, anaId);
    // the cost calc read the RESOLVED config: no price, no invented dollars
    expect(unpriced!.costUsd).toBeNull();

    // Restore by re-activating the BASELINE, whose body is TOTAL (the lazy v1
    // states every field, ADR-0074 §2.2). Not v2: that hand-authored body
    // names only `model`, and a partial body inherits the ROW — where v3's
    // read-model write legitimately left the prices null. That inheritance is
    // ADR-0074 disclosure 4's documented partial-body semantics, not a defect,
    // and this comment is here so nobody "fixes" it into one.
    const rb = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}/activate`,
      payload: { version: 1, reason: "acfg suite: back to the priced baseline" },
    });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().rollback).toBe(true);
    expect((await invoke(anaAuth, agentId)).statusCode).toBe(200);
    expect((await latestUsage(agentId, anaId))!.costUsd).not.toBeNull();
    expect(calls().at(-1)!.model).toBe("mock-balanced");
    resetCalls();
  });

  it("rolling back to the BASELINE restores the original model at the provider", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}/activate`,
      payload: { version: 1, reason: "acfg suite: back to the baseline" },
    });
    expect(res.statusCode).toBe(200);
    expect((await invoke(anaAuth, agentId)).statusCode).toBe(200);
    expect(calls().at(-1)!.model).toBe("mock-balanced");
    resetCalls();
  });

  it("versions but NO active FAILS CLOSED — dispatching an unauthorized config is refused, audited", async () => {
    await db
      .update(configVersions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(configVersions.artifactType, "agent_config"),
          eq(configVersions.artifactId, agentId),
          eq(configVersions.status, "active"),
        ),
      );
    const before = (
      await db.select().from(auditLog).where(eq(auditLog.ruleId, "config-version-unresolvable"))
    ).length;

    const res = await invoke(anaAuth, agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("config_version_unresolvable");

    const after = await db.select().from(auditLog).where(eq(auditLog.ruleId, "config-version-unresolvable"));
    expect(after.length).toBe(before + 1);

    await db
      .update(configVersions)
      .set({ status: "active" })
      .where(
        and(
          eq(configVersions.artifactType, "agent_config"),
          eq(configVersions.artifactId, agentId),
          eq(configVersions.version, 1),
        ),
      );
    expect((await invoke(anaAuth, agentId)).statusCode).toBe(200);
    resetCalls();
  });

  it("the authoring surface refuses non-config agent columns — the scope line, at the route", async () => {
    for (const body of [{ provider: "openai" }, { tier: 5 }, { enabled: false }, { systemPrompt: "x" }]) {
      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/config-versions/agent_config/${agentId}`,
        payload: { body, label: "acfg refused" },
      });
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
  });
});

describe("B1 — the agent_config canary SHADOWS: measured, never served", () => {
  it("a sampled dispatch serves the ACTIVE model and records the candidate divergence", async () => {
    // shadow agent: v2 = the active truth (same as row), candidate v3 = a
    // cheaper model that must never serve
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}`,
      payload: { body: { model: "mock-balanced" }, label: "acfg shadow v2", activate: true },
    });
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}`,
      payload: { body: { model: "mock-fast" }, label: "acfg shadow candidate" },
    });
    const candidateVersion = created.json().version.version as number;
    const canary = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}/canary`,
      payload: { version: candidateVersion, pct: canaryPct },
    });
    expect(canary.statusCode).toBe(200);
    expect(canary.json().live).toBe(false);
    expect(canary.json().canaryMode).toBe("shadow");

    resetCalls();
    const res = await invoke(insideAuth, shadowAgentId);
    expect(res.statusCode).toBe(200);

    // HALF ONE — ZERO SERVED-PATH INFLUENCE: the provider received the ACTIVE
    // model, not the candidate, though this caller IS inside the sample
    expect(calls().length).toBe(1);
    expect(calls()[0]!.model).toBe("mock-balanced");

    // HALF TWO — AND IT NEVERTHELESS MEASURED: one observation carrying both
    // sides, diverged, with the sampling provenance. A canary that recorded
    // nothing passes half one and fails here; one that enforced passes here
    // and fails half one.
    const obs = await observationsOf(shadowAgentId);
    expect(obs.length).toBe(1);
    expect(obs[0]!.diverged).toBe(true);
    expect(obs[0]!.servedEffect).toContain("mock-balanced");
    expect(obs[0]!.candidateEffect).toContain("mock-fast");
    expect(obs[0]!.candidateReason).toMatch(/would have executed/);
    expect(obs[0]!.userId).toBe(insideId);
    expect(obs[0]!.canaryPct).toBe(canaryPct);
    expect(obs[0]!.activeVersionId).not.toBeNull();
    expect(obs[0]!.failed).toBe(false);
    resetCalls();
  });

  it("a caller OUTSIDE the sample dispatches identically and records nothing", async () => {
    const before = (await observationsOf(shadowAgentId)).length;
    const res = await invoke(outsideAuth, shadowAgentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.model).toBe("mock-balanced");
    expect((await observationsOf(shadowAgentId)).length).toBe(before);
    resetCalls();
  });

  it("the divergence endpoint renders the comparison an operator promotes on", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}/divergence`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canaryMode).toBe("shadow");
    expect(res.json().totals.observed).toBe(1);
    expect(res.json().totals.diverged).toBe(1);
    expect(res.json().artifactDeleted).toBe(false);
  });

  it("the lineage endpoint discloses shadow — and canaryIsLive stays false for agent_config for ever", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}`,
    });
    expect(res.json().canaryMode).toBe("shadow");
    expect(res.json().canaryIsLive).toBe(false);
    expect(res.json().canaryIsEvaluated).toBe(true);
    expect(res.json().artifactDeleted).toBe(false);
    expect(res.json().note).not.toMatch(/VOCABULARY ONLY/);
  });

  it("abandoning the canary returns the fleet to unobserved dispatch", async () => {
    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${shadowAgentId}/canary`,
    });
    expect(res.statusCode).toBe(200);
    const before = (await observationsOf(shadowAgentId)).length;
    expect((await invoke(insideAuth, shadowAgentId)).statusCode).toBe(200);
    expect(calls().at(-1)!.model).toBe("mock-balanced");
    expect((await observationsOf(shadowAgentId)).length).toBe(before);
    resetCalls();
  });
});
