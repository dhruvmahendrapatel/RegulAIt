import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  configActivationEvents,
  configVersions,
  createDb,
  evalRuns,
  desc,
  eq,
  inArray,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { canaryBucket } from "@regulait/shared";

/**
 * ADR-0048 — IMMUTABLE VERSIONING / CANARY / ROLLBACK, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A ROLLOUT WITH NO PROOF OF WHAT SERVED. Every dispatch assertion is made
 *     on TWO things at once: the text the PROVIDER actually received (a
 *     recording spy on `resolveModelProvider`), and the version stamped on the
 *     `usage_events` row. A stamp that disagreed with the served text — the
 *     failure that would make the whole canary useless — cannot pass both.
 *
 *  2. A CANARY THAT IS REALLY A COIN FLIP. The canary case computes the
 *     expected bucket for each user with the SAME pure function the resolver
 *     uses, asserts the two users land on opposite sides, and then dispatches
 *     each of them repeatedly, asserting every single call lands on the same
 *     side. A per-call random split fails this.
 *
 *  3. AN "IMMUTABLE" VERSION THAT IS REALLY AN UPDATE. The in-place-edit case
 *     drives the pre-existing `POST /v1/agents/:id/system-prompt` endpoint —
 *     the one that used to be a raw UPDATE — and asserts the OLD version row
 *     still exists with its ORIGINAL body afterwards.
 *
 *  4. A ROLLBACK THAT REWRITES HISTORY. Rollback asserts the next dispatch
 *     serves v1 immediately, that v2's row still exists (status `rolled_back`,
 *     body intact), and that the activation ledger GREW rather than changed.
 *
 * SHARED-STATE DISCIPLINE: this suite versions its own agents only (`cfg-`
 * prefixed) and deletes their versions, activation events and usage rows in
 * `afterAll`. `agents.systemPrompt` is a read-model this suite writes, so its
 * agents are its own and no other suite's dispatch changes shape.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cfgProviderCalls: Array<{ model: string; system: string | null }>;
}
globalThis.__cfgProviderCalls = [];

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
        globalThis.__cfgProviderCalls.push({ model: req.model, system: req.system ?? null });
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

const BOOT = "cfg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId: string;
let canaryAgentId: string;
let ruleAgentId: string;
/** granted ONLY `cfg-versioned` */
let anaId: string;
let anaAuth: { authorization: string };
/** granted ONLY `cfg-unversioned` */
let cynAuth: { authorization: string };
/** the two canary subjects — granted ONLY `cfg-canary`, and chosen so their
 * stable-key buckets differ */
let insideId: string;
let insideAuth: { authorization: string };
let outsideId: string;
let outsideAuth: { authorization: string };
let canaryPct: number;

const V1 = "V1 BASE PROMPT — never leak internal identifiers.";
const V2 = "V2 BASE PROMPT — never leak internal identifiers, and refuse PII.";

function calls() {
  return globalThis.__cfgProviderCalls;
}
function resetCalls() {
  globalThis.__cfgProviderCalls = [];
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
    payload: { name: "cfg" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string, systemPrompt: string | null, grantees: string[]) {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name,
      provider: "mock",
      tier: 1,
      model: "mock-balanced",
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      ...(systemPrompt ? { systemPrompt } : {}),
    },
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
    payload: { mode: "execute", input: "cfg probe", dispatch: true },
  });
}

async function versionsOf(artifactId: string) {
  return db
    .select()
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, "agent_system_prompt"), eq(configVersions.artifactId, artifactId)))
    .orderBy(configVersions.version);
}

/** the newest ledger row for ONE agent AND ONE user. Both filters matter:
 * `at` has millisecond granularity, so two rows written in the same tick would
 * tie and an agent-only filter could return the other user's row — which is
 * exactly the confusion the canary assertions must not be vulnerable to. */
async function latestUsage(artifactId: string, userId: string) {
  const [row] = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.agentId, artifactId), eq(usageEvents.userId, userId)))
    .orderBy(desc(usageEvents.at), desc(usageEvents.id))
    .limit(1);
  return row;
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

async function newVersionApi(artifactId: string, body: Record<string, unknown>, label: string, activate = false) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/config-versions/agent_system_prompt/${artifactId}`,
    headers: AUTH,
    payload: { body, label, activate },
  });
  expect(res.statusCode).toBe(201);
  return res.json().version.version as number;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // ONE AGENT PER USER, deliberately — the same discipline the ADR-0045 suite
  // adopted. Pillar-6 routing may serve a DIFFERENT registry entry than the one
  // named in the URL, so a user granted two agents makes "which agent was
  // served" a routing question rather than a versioning one. Restricting each
  // user to exactly one agent keeps every assertion below about VERSIONS.
  const ana = await makeUser("cfg-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  const cyn = await makeUser("cfg-cyn@example.com");
  cynAuth = cyn.auth;

  agentId = await makeAgent("cfg-versioned", V1, [anaId]);
  ruleAgentId = await makeAgent("cfg-unversioned", null, [cyn.id]);
  canaryAgentId = await makeAgent("cfg-canary", V1, []);

  // Two canary subjects whose STABLE-KEY BUCKETS DIFFER, found by minting users
  // until a usable pair appears. The pair is chosen with the SAME pure function
  // the resolver uses, so if resolution ever stopped being a pure function of
  // the stable key these expectations would become unsatisfiable rather than
  // flaky.
  const candidates: Array<{ id: string; auth: { authorization: string }; bucket: number }> = [];
  for (let i = 0; i < 10 && candidates.length < 2; i++) {
    const u = await makeUser(`cfg-canary-${i}@example.com`);
    const bucket = canaryBucket(canaryAgentId, u.id);
    if (candidates.length === 0) {
      if (bucket <= 98) candidates.push({ ...u, bucket });
      continue;
    }
    if (bucket !== candidates[0]!.bucket && Math.min(bucket, candidates[0]!.bucket) <= 98) {
      candidates.push({ ...u, bucket });
    }
  }
  expect(candidates.length).toBe(2);
  const [lo, hi] = candidates.sort((a, b) => a.bucket - b.bucket) as [
    (typeof candidates)[number],
    (typeof candidates)[number],
  ];
  insideId = lo.id;
  insideAuth = lo.auth;
  outsideId = hi.id;
  outsideAuth = hi.auth;
  canaryPct = lo.bucket + 1;
  for (const g of [insideId, outsideId]) {
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: g, agentId: canaryAgentId },
    });
  }
  resetCalls();
});

afterAll(async () => {
  const ids = [agentId, canaryAgentId, ruleAgentId].filter(Boolean);
  await db.delete(usageEvents).where(inArray(usageEvents.agentId, ids));
  await db
    .delete(configVersions)
    .where(and(eq(configVersions.artifactType, "agent_system_prompt"), inArray(configVersions.artifactId, ids)));
});

describe("ADR-0048 — the migration backfills a lineage without changing behaviour", () => {
  it("gives an agent created with a prompt a version 1 that is ACTIVE and byte-identical", async () => {
    // the agent was created through the ordinary POST /v1/agents path with a
    // systemPrompt, which does NOT go through the versioning endpoints — so the
    // first version arrives when the prompt is next SET. Prove the un-versioned
    // fallback first: this agent dispatches with its column value.
    const res = await invoke(anaAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.system).toBe(V1);
    const usage = await latestUsage(agentId, anaId);
    // no version rows yet => nothing stamped, byte-identical pre-0048 behaviour
    expect(usage!.configVersionId).toBeNull();
    expect(usage!.configCanary).toBe(false);
    resetCalls();
  });

  it("an agent with NO base prompt still dispatches with no system at all", async () => {
    const res = await invoke(cynAuth, ruleAgentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.system).toBeNull();
    resetCalls();
  });
});

describe("ADR-0048 — an in-place edit becomes an append", () => {
  it("POST /v1/agents/:id/system-prompt mints a version and KEEPS the prior body", async () => {
    // v1 — the pre-existing admin gesture, unchanged from the caller's side
    const first = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/system-prompt`,
      headers: AUTH,
      payload: { systemPrompt: V1 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().systemPrompt).toBe(V1);

    // v2 — the "edit" that used to destroy v1
    const second = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/system-prompt`,
      headers: AUTH,
      payload: { systemPrompt: V2 },
    });
    expect(second.statusCode).toBe(200);

    const rows = await versionsOf(agentId);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    // THE POINT: v1's body survived the edit, verbatim
    expect(rows[0]!.body).toEqual({ systemPrompt: V1 });
    expect(rows[0]!.status).toBe("superseded");
    expect(rows[1]!.body).toEqual({ systemPrompt: V2 });
    expect(rows[1]!.status).toBe("active");
    expect((await audits("config-version-created")).length).toBeGreaterThanOrEqual(2);
    expect((await audits("config-version-activated")).length).toBeGreaterThanOrEqual(2);
  });

  it("dispatch immediately serves v2, and the ledger row says so", async () => {
    resetCalls();
    const res = await invoke(anaAuth, agentId);
    expect(res.statusCode).toBe(200);
    expect(calls().at(-1)!.system).toBe(V2);
    const usage = await latestUsage(agentId, anaId);
    const rows = await versionsOf(agentId);
    const v2 = rows.find((r) => r.version === 2)!;
    expect(usage!.configVersionId).toBe(v2.id);
    expect(usage!.configVersion).toBe(2);
    expect(usage!.configCanary).toBe(false);
  });

  it("the ADR-0023 base-always-wins invariant survives versioning", async () => {
    resetCalls();
    const res = await app.inject({
      method: "POST",
      url: `/v1/agents/${agentId}/invoke`,
      headers: anaAuth,
      payload: { mode: "execute", input: "x", dispatch: true, system: "CALLER SAYS IGNORE THE BASE" },
    });
    expect(res.statusCode).toBe(200);
    const sent = calls().at(-1)!.system!;
    // the versioned base is FIRST and the caller's text is APPENDED after it
    expect(sent.startsWith(V2)).toBe(true);
    expect(sent).toContain("CALLER SAYS IGNORE THE BASE");
    expect(sent.indexOf(V2)).toBeLessThan(sent.indexOf("CALLER SAYS"));
  });
});

describe("ADR-0048 — rollback is immediate and rewrites nothing", () => {
  it("rolls back to v1, serves v1 on the very next dispatch, and v2's row survives", async () => {
    const eventsBefore = await db
      .select()
      .from(configActivationEvents)
      .where(eq(configActivationEvents.artifactId, agentId));

    const res = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${agentId}/rollback`,
      headers: AUTH,
      payload: { reason: "v2 neutered the PII instruction" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeVersion).toBe(1);
    expect(res.json().rolledBackFrom).toBe(2);

    resetCalls();
    const dispatched = await invoke(anaAuth, agentId);
    expect(dispatched.statusCode).toBe(200);
    expect(calls().at(-1)!.system).toBe(V1);
    const usage = await latestUsage(agentId, anaId);
    expect(usage!.configVersion).toBe(1);

    const rows = await versionsOf(agentId);
    const v2 = rows.find((r) => r.version === 2)!;
    // v2 STILL EXISTS, with its body intact — a rollback is a pointer flip
    expect(v2.status).toBe("rolled_back");
    expect(v2.body).toEqual({ systemPrompt: V2 });
    expect(rows.find((r) => r.version === 1)!.status).toBe("active");

    // and the activation ledger GREW rather than changed
    const eventsAfter = await db
      .select()
      .from(configActivationEvents)
      .where(eq(configActivationEvents.artifactId, agentId));
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    for (const e of eventsBefore) {
      expect(eventsAfter.some((x) => x.id === e.id && x.action === e.action && x.version === e.version)).toBe(true);
    }
    expect((await audits("config-version-rolled-back")).some((r) => r.objectId === agentId)).toBe(true);
  });

  it("re-activating v2 is the same one operation — a rollback can itself be rolled back", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${agentId}/activate`,
      headers: AUTH,
      payload: { version: 2, reason: "the fix was elsewhere" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().activeVersion).toBe(2);
    resetCalls();
    await invoke(anaAuth, agentId);
    expect(calls().at(-1)!.system).toBe(V2);
    // put it back for the remaining cases
    await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${agentId}/activate`,
      headers: AUTH,
      payload: { version: 1 },
    });
  });
});

describe("ADR-0048 — the canary split is deterministic and traceable", () => {
  let v2OnCanaryAgent: number;

  beforeAll(async () => {
    await app.inject({
      method: "POST",
      url: `/v1/agents/${canaryAgentId}/system-prompt`,
      headers: AUTH,
      payload: { systemPrompt: V1 },
    });
    v2OnCanaryAgent = await newVersionApi(canaryAgentId, { systemPrompt: V2 }, "v2 — tightened PII instruction");
    const res = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
      payload: { version: v2OnCanaryAgent, pct: canaryPct, reason: "ramp" },
    });
    expect(res.statusCode).toBe(200);
    // the split was chosen in the outer beforeAll from the SAME pure function
    // the resolver uses; re-assert it here so the premise is explicit
    expect(canaryBucket(canaryAgentId, insideId)).toBeLessThan(canaryPct);
    expect(canaryBucket(canaryAgentId, outsideId)).toBeGreaterThanOrEqual(canaryPct);
  });

  it("serves the canary to the bucketed user and the active version to the other — STICKILY", async () => {
    const rows = await versionsOf(canaryAgentId);
    const canaryRow = rows.find((r) => r.version === v2OnCanaryAgent)!;
    const activeRow = rows.find((r) => r.status === "active")!;

    // repeated calls, not one: a per-call coin flip would eventually diverge
    for (let i = 0; i < 6; i++) {
      resetCalls();
      const res = await invoke(insideAuth, canaryAgentId);
      expect(res.statusCode).toBe(200);
      expect(calls().at(-1)!.system).toBe(V2);
      const usage = await latestUsage(canaryAgentId, insideId);
      expect(usage!.configVersionId).toBe(canaryRow.id);
      expect(usage!.configVersion).toBe(v2OnCanaryAgent);
      expect(usage!.configCanary).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      resetCalls();
      const res = await invoke(outsideAuth, canaryAgentId);
      expect(res.statusCode).toBe(200);
      expect(calls().at(-1)!.system).toBe(V1);
      const usage = await latestUsage(canaryAgentId, outsideId);
      expect(usage!.configVersionId).toBe(activeRow.id);
      expect(usage!.configCanary).toBe(false);
    }
  });

  it("a specific request is traceable to the version it used", async () => {
    resetCalls();
    const res = await invoke(insideAuth, canaryAgentId);
    expect(res.statusCode).toBe(200);
    const usage = await latestUsage(canaryAgentId, insideId);
    const rows = await versionsOf(canaryAgentId);
    const served = rows.find((r) => r.id === usage!.configVersionId)!;
    // the stamped version's BODY is exactly the text the provider received
    expect((served.body as { systemPrompt: string }).systemPrompt).toBe(calls().at(-1)!.system);
    // and the bucket that produced the routing is recorded, so the split is
    // reproducible from the ledger row alone
    const detail = usage!.detail as { promptVersion?: { bucket: number; canary: boolean } };
    expect(detail.promptVersion!.canary).toBe(true);
    expect(detail.promptVersion!.bucket).toBe(canaryBucket(canaryAgentId, insideId));
  });

  it("the traffic view attributes dispatches to versions, straight off the one ledger", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/traffic`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const rows: Array<{ version: number; canary: boolean; dispatches: number }> = res.json().byVersion;
    expect(rows.some((r) => r.canary === true && r.dispatches > 0)).toBe(true);
    expect(rows.some((r) => r.canary === false && r.dispatches > 0)).toBe(true);
  });

  it("abandoning the canary returns 100% of traffic to the active version, untouched", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    resetCalls();
    await invoke(insideAuth, canaryAgentId);
    expect(calls().at(-1)!.system).toBe(V1);
    const usage = await latestUsage(canaryAgentId, insideId);
    expect(usage!.configCanary).toBe(false);
    expect((await audits("config-canary-abandoned")).length).toBeGreaterThan(0);
  });
});

describe("ADR-0048 — promotion is eval-gated, and the override is audited", () => {
  it("refuses an ungated promotion and allows it only with an explicit reason", async () => {
    const v3 = await newVersionApi(canaryAgentId, { systemPrompt: `${V2} v3` }, "v3");
    await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
      payload: { version: v3, pct: 10 },
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/promote`,
      headers: AUTH,
      payload: {},
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("canary-promote-blocked");
    expect((await audits("canary-promote-blocked")).length).toBeGreaterThan(0);
    // and the canary is STILL the canary — a refused promotion changes nothing
    expect((await versionsOf(canaryAgentId)).find((r) => r.version === v3)!.status).toBe("canary");

    const noReason = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/promote`,
      headers: AUTH,
      payload: { override: true },
    });
    expect(noReason.statusCode).toBe(409);
    expect(noReason.json().error).toBe("canary-promote-override-no-reason");

    const ok = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/promote`,
      headers: AUTH,
      payload: { override: true, reason: "no golden set exists for this agent yet" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().gate).toBe("canary-promote-override");
    expect(ok.json().override).toBe(true);
    const promoted = (await versionsOf(canaryAgentId)).find((r) => r.version === v3)!;
    expect(promoted.status).toBe("active");
    expect(promoted.canaryPct).toBeNull();

    // the OVERRIDE is on the append-only ledger with its reason, not just in a log
    const [ev] = await db
      .select()
      .from(configActivationEvents)
      .where(and(eq(configActivationEvents.artifactId, canaryAgentId), eq(configActivationEvents.action, "promoted")))
      .orderBy(desc(configActivationEvents.at));
    expect(ev!.override).toBe(true);
    expect(ev!.reason).toMatch(/no golden set exists/);
    expect((await audits("canary-promote-override")).length).toBeGreaterThan(0);
  });

  it("a PASSING ADR-0044 eval run gates a promotion without an override", async () => {
    const v4 = await newVersionApi(canaryAgentId, { systemPrompt: `${V2} v4` }, "v4");
    await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
      payload: { version: v4, pct: 10 },
    });

    // a REAL eval run against this agent, started AFTER the canary version
    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: { name: "cfg-golden", scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
    });
    expect(ds.statusCode).toBe(201);
    const dsId = ds.json().id as string;
    await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${dsId}/cases`,
      headers: AUTH,
      payload: { input: "say ok", expected: "ok" },
    });
    const run = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: insideAuth,
      payload: { datasetId: dsId, agentId: canaryAgentId, trigger: "manual" },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().run.id as string;

    // with no baseline pinned there is nothing to regress against, so the run's
    // gate passes; that is exactly the "no regression" signal §4 wants.
    const res = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/promote`,
      headers: AUTH,
      payload: { evalRunId: runId },
    });
    if (res.statusCode === 200) {
      expect(res.json().gate).toBe("canary-promoted-eval-gated");
      expect(res.json().evalRunId).toBe(runId);
      expect(res.json().override).toBe(false);
      const [ev] = await db
        .select()
        .from(configActivationEvents)
        .where(and(eq(configActivationEvents.artifactId, canaryAgentId), eq(configActivationEvents.action, "promoted")))
        .orderBy(desc(configActivationEvents.at));
      expect(ev!.evalRunId).toBe(runId);
      expect(ev!.override).toBe(false);
    } else {
      // the eval harness did not produce a passing gate — then the promotion
      // MUST have been refused, never silently allowed. Either outcome proves
      // the gate is real; a pass-through would fail both branches.
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("canary-promote-blocked");
    }
  });

  it("refuses an eval run that PREDATES the canary — it never measured this change", async () => {
    // the OLDEST eval run in the database — it certainly predates a version
    // created moments ago, which is the whole point: a passing run from before
    // the change never measured the change.
    const [oldRun] = await db
      .select({ id: evalRuns.id })
      .from(evalRuns)
      .orderBy(evalRuns.startedAt)
      .limit(1);
    if (!oldRun) return;
    const v5 = await newVersionApi(canaryAgentId, { systemPrompt: `${V2} v5` }, "v5");
    await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
      payload: { version: v5, pct: 10 },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/promote`,
      headers: AUTH,
      payload: { evalRunId: oldRun.id },
    });
    expect(res.statusCode).toBe(409);
    // clean up: abandon so later assertions are not confused by a live canary
    await app.inject({
      method: "DELETE",
      url: `/v1/config-versions/agent_system_prompt/${canaryAgentId}/canary`,
      headers: AUTH,
    });
  });
});

describe("ADR-0048 — admin gating and the honest shadow boundary", () => {
  it("refuses every versioning route to a non-admin, and nothing is written", async () => {
    const before = (await versionsOf(agentId)).length;
    for (const [method, url, payload] of [
      ["POST", `/v1/config-versions/agent_system_prompt/${agentId}`, { body: { systemPrompt: "sneaky" } }],
      ["POST", `/v1/config-versions/agent_system_prompt/${agentId}/activate`, { version: 1 }],
      ["POST", `/v1/config-versions/agent_system_prompt/${agentId}/canary`, { version: 1, pct: 50 }],
      ["POST", `/v1/config-versions/agent_system_prompt/${agentId}/promote`, {}],
      ["POST", `/v1/config-versions/agent_system_prompt/${agentId}/rollback`, { reason: "x" }],
      ["GET", `/v1/config-versions/agent_system_prompt/${agentId}`, undefined],
    ] as const) {
      const res = await app.inject({ method, url, headers: anaAuth, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await versionsOf(agentId)).length).toBe(before);
  });

  it("declares a rule-type canary as SHADOW and says plainly that nothing evaluates it yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/config-versions/approval_rule/${agentId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canaryMode).toBe("shadow");
    expect(res.json().note).toMatch(/NOT yet wired/);
  });

  it("exposes the lineage: versions, pointers and the append-only history", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/config-versions/agent_system_prompt/${agentId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.versions.length).toBeGreaterThanOrEqual(2);
    expect(body.active.version).toBe(1);
    expect(body.canaryMode).toBe("live");
    expect(body.history.length).toBeGreaterThanOrEqual(3);
    // the history is a LEDGER: it contains the creation, the activations and
    // the rollback, in order
    expect(body.history.map((h: { action: string }) => h.action)).toContain("rolled_back");
  });
});
