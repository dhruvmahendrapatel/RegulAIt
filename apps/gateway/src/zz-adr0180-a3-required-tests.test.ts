/**
 * ADR-0180 A3 — REQUIRED AI TEST CLASSES PER RISK TIER, through the real app
 * on a real database, and the deploy gate's composition of the checks.
 *
 * Pinned:
 *  - GET (any signed-in user) shows the strict defaults when the column is
 *    empty; PUT is admin-only, refuses an unmeasurable OWASP id (422
 *    `required_test_unmeasurable`, naming it) and an unknown one, caps
 *    freshness at 90 days, and is audited with the old and new value;
 *  - the gate, under the default `enforce`, holds a use case whose agent has
 *    no run; a fresh passing run on the current configuration clears it; a
 *    stale run, a configuration change, a run that did not measure the class
 *    and a second agent without a run each hold it again;
 *  - `warn` lists the reasons without holding; `off` skips them and says so;
 *  - the monitor loader reports a passing result that aged out;
 *  - FA3: the evidence is the probe-trial ledger, not the stored summary: a run
 *    whose probes the PLATFORM held (budget, entitlement) is never evidence of
 *    the agent, a single-trial run is not evidence, a run whose configuration
 *    hash was ADOPTED by the legacy-pin sweep is not evidence, and two admins
 *    writing the policy at once each audit the value they really replaced.
 *
 * Evidence rows are inserted directly (a red-team run's own machinery is
 * pinned by redteam.test.ts); their configuration hash is the real
 * `agentConfigHash` of the agent, so the hash rule is exercised for real.
 *
 * Global state (M-068): the required-tests policy is restored to `{}` and the
 * gate mode to `enforce` before the file ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  evalDatasets,
  evalResults,
  evalRuns,
  governanceReviewPolicy,
  redteamLibraries,
  redteamProbeTrials,
  redteamRuns,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { agentConfigHash } from "./evals.js";
import { requiredTestStatus, requiredTestsMonitorInput } from "./required-tests.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const PATH = "/v1/governance/review-policy/required-tests";
const MODE_PATH = "/v1/org/settings/assurance-gate-mode";
const DAY = 86_400_000;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;
let agentA = "";
let agentB = "";
let ucOne = "";
let ucTwo = "";
let datasetId = "";
let libraryId = "";
const runIds: string[] = [];
const evalRunIds: string[] = [];

const inject = (method: "GET" | "PUT" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const gate = async (useCaseId: string) => {
  const r = await inject("POST", "/v1/gates/deploy", users.admin.auth, { useCaseId, environment: "a3-test", ref: `a3-${RUN}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { decision: string; reasons: Array<{ code: string; severity: string; message: string; explanation?: string; ref?: { id: string } }>; assurance: { mode: string; status: string; label: string } };
};
const testReasons = (g: Awaited<ReturnType<typeof gate>>) =>
  g.reasons.filter((r) => r.code.startsWith("required_test_")).map((r) => [r.code, r.severity, r.ref?.id]);

/** every red-team class the catalog maps to OWASP LLM01 (the limited tier's default) */
const LLM01_CLASSES = ["prompt_injection", "jailbreak", "indirect_prompt_injection", "encoding_evasion"];
/** per class: `probes` probes, of which the first `defeated` are defeated and
 * the last `held` were stopped by the PLATFORM in every trial (ADR-0072
 * governance_stop: stored as resisted, adjudication.platformHeld) */
type ClassSpec = { attackClass: string; probes?: number; defeated?: number; held?: number };
const llm01 = (over: Record<string, Partial<ClassSpec>> = {}): ClassSpec[] =>
  LLM01_CLASSES.map((attackClass) => ({ attackClass, probes: 1, ...over[attackClass] }));

/**
 * A completed red-team run of `agentId`, finished `ageDays` ago, written the
 * way `redteam.ts` writes one: the per-probe, per-trial ledger, and the stored
 * class summary in which a platform-held probe reads as RESISTED.
 */
async function redteamRun(
  agentId: string,
  opts: { ageDays?: number; configHash?: string; classes?: ClassSpec[]; trials?: number; quality?: string | null } = {},
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  const finishedAt = new Date(Date.now() - (opts.ageDays ?? 1) * DAY);
  const [er] = await db
    .insert(evalRuns)
    .values({
      datasetId,
      datasetVersion: 1,
      agentId,
      agentName: agent!.name,
      model: agent!.model,
      tier: agent!.tier,
      trigger: "manual",
      status: "completed",
      configHash: opts.configHash ?? (await agentConfigHash(db, agent!)),
      startedAt: finishedAt,
      finishedAt,
    })
    .returning({ id: evalRuns.id });
  evalRunIds.push(er!.id);
  const classes = (opts.classes ?? llm01()).map((c) => ({ probes: 1, defeated: 0, held: 0, ...c }));
  const trials = opts.trials ?? 3;
  const held = classes.reduce((a, c) => a + c.held, 0);
  const [rr] = await db
    .insert(redteamRuns)
    .values({
      libraryId,
      libraryName: `a3 lib ${RUN}`,
      libraryVersion: 1,
      evalRunId: er!.id,
      agentId,
      agentName: agent!.name,
      probes: classes.reduce((a, c) => a + c.probes, 0),
      resisted: classes.reduce((a, c) => a + c.probes - c.defeated, 0),
      defeated: classes.reduce((a, c) => a + c.defeated, 0),
      classSummary: classes.map((c) => ({ attackClass: c.attackClass, probes: c.probes, defeated: c.defeated, resisted: c.probes - c.defeated })),
      trials,
      measurementQuality: opts.quality === undefined ? (trials === 1 ? "single-trial" : trials < 10 ? "low-power" : "measured") : opts.quality,
      platformHeld: held,
      startedAt: finishedAt,
      finishedAt,
    })
    .returning({ id: redteamRuns.id });
  const rows = classes.flatMap((c) =>
    Array.from({ length: c.probes }, (_, k) => k).flatMap((k) =>
      Array.from({ length: trials }, (_, t) => {
        const isHeld = k >= c.probes - c.held;
        const defeated = !isHeld && k < c.defeated;
        return {
          runId: rr!.id,
          probeKey: `${c.attackClass}-${k}`,
          attackClass: c.attackClass as "prompt_injection",
          severity: "high" as const,
          trial: t + 1,
          defeated,
          score: defeated ? 0 : 1,
          error: null,
          adjudication: isHeld ? { vector: "eval-dispatch-blocked", platformHeld: true, executed: false, stoppedBy: "budget_exceeded" } : null,
        };
      }),
    ),
  );
  if (rows.length) await db.insert(redteamProbeTrials).values(rows);
  runIds.push(rr!.id);
  return { id: rr!.id, evalRunId: er!.id };
}
async function clearRuns() {
  for (const id of runIds.splice(0)) await db.delete(redteamRuns).where(eq(redteamRuns.id, id));
  for (const id of evalRunIds.splice(0)) await db.delete(evalRuns).where(eq(evalRuns.id, id));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a3-${k}-${RUN}@example.com`, displayName: `a3 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a3" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  const [a] = await db.insert(agents).values({ name: `a3-a-${RUN}`, provider: "mock", tier: 1, model: "m-a", ownerUserId: users.admin.id }).returning({ id: agents.id });
  const [b] = await db.insert(agents).values({ name: `a3-b-${RUN}`, provider: "mock", tier: 1, model: "m-b", ownerUserId: users.admin.id }).returning({ id: agents.id });
  agentA = a!.id;
  agentB = b!.id;
  const base = { description: "synthetic", businessContext: "a3 gate test", dataSensitivity: "internal" as const, ownerUserId: users.admin.id, status: "approved" as const, euAiActTier: "limited" as const, euAiActReasons: [], euAiActRulesetVersion: 1 };
  const [u1] = await db.insert(aiUseCases).values({ ...base, name: `a3 one ${RUN}`, intendedAgentIds: [agentA] }).returning({ id: aiUseCases.id });
  const [u2] = await db.insert(aiUseCases).values({ ...base, name: `a3 two ${RUN}`, intendedAgentIds: [agentA, agentB] }).returning({ id: aiUseCases.id });
  ucOne = u1!.id;
  ucTwo = u2!.id;
  const [ds] = await db.insert(evalDatasets).values({ name: `a3 ds ${RUN}` }).returning({ id: evalDatasets.id });
  datasetId = ds!.id;
  const [lib] = await db.insert(redteamLibraries).values({ name: `a3 lib ${RUN}` }).returning({ id: redteamLibraries.id });
  libraryId = lib!.id;
  // a first load: the column is empty, so the strict defaults apply
  await db.update(governanceReviewPolicy).set({ requiredTests: {} });
}, 120_000);

afterAll(async () => {
  // M-068: leave the strict defaults and the strict gate mode behind
  await db.update(governanceReviewPolicy).set({ requiredTests: {} });
  await db.execute(sql`UPDATE org_settings SET assurance_gate_mode = 'enforce'`);
  await clearRuns();
  for (const id of [ucOne, ucTwo].filter(Boolean)) await db.delete(aiUseCases).where(eq(aiUseCases.id, id));
  if (libraryId) await db.delete(redteamLibraries).where(eq(redteamLibraries.id, libraryId));
  if (datasetId) await db.delete(evalDatasets).where(eq(evalDatasets.id, datasetId));
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

describe("ADR-0180 A3 the required-tests policy routes", () => {
  it("GET (any signed-in user): an empty column reads as the strict defaults", async () => {
    const r = await inject("GET", PATH, users.member.auth);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.policy).toEqual({});
    expect(v.effective.high.source).toBe("default");
    expect(v.effective.high.freshnessDays).toBe(30);
    expect(v.effective.high.classes.map((c: { testClass: string }) => c.testClass)).toEqual(
      expect.arrayContaining(["owasp:llm:01", "owasp:llm:02", "owasp:llm:06", "owasp:agentic:asi01"]),
    );
    expect(v.effective.limited.classes).toEqual([expect.objectContaining({ testClass: "owasp:llm:01", name: "Prompt Injection", maxAsr: 0 })]);
    expect(v.testClasses.find((c: { id: string }) => c.id === "owasp:llm:03").measurable).toBe(false);
  });

  it("PUT is admin-only", async () => {
    const r = await inject("PUT", PATH, users.member.auth, { high: { classes: [] } });
    expect(r.statusCode).toBe(403);
  });

  it("refuses an unmeasurable id (422 required_test_unmeasurable, naming it) and changes nothing", async () => {
    const r = await inject("PUT", PATH, users.admin.auth, { high: { classes: [{ testClass: "owasp:llm:01" }, { testClass: "owasp:llm:04" }] } });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json()).toMatchObject({ error: "required_test_unmeasurable", testClass: "owasp:llm:04", tier: "high" });
    expect(r.json().detail).toContain("Data and Model Poisoning");
    const unknown = await inject("PUT", PATH, users.admin.auth, { limited: { classes: [{ testClass: "owasp:llm:42" }] } });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toBe("unknown_test_class");
    const tooLong = await inject("PUT", PATH, users.admin.auth, { limited: { classes: [], freshnessDays: 91 } });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error).toBe("invalid_required_tests");
    const [row] = await db.select().from(governanceReviewPolicy);
    expect(row?.requiredTests ?? {}).toEqual({});
  });

  it("an admin relaxes a tier; the change is audited with the old and new value, then restored", async () => {
    const next = { limited: { classes: [], freshnessDays: 60 } };
    try {
      const r = await inject("PUT", PATH, users.admin.auth, next);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().effective.limited).toMatchObject({ source: "policy", classes: [], freshnessDays: 60 });
      expect(r.json().effective.high.source).toBe("default");
      const [a] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "review-policy-required-tests-set"), eq(auditLog.userId, users.admin.id)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(a!.detail).toMatchObject({ setting: "requiredTests", from: {}, to: next, relaxedTiers: ["limited"] });
      expect(a!.reason).toContain("RELAXED for limited");
    } finally {
      expect((await inject("PUT", PATH, users.admin.auth, {})).statusCode).toBe(200);
    }
  });

  // ---- FA3 finding 5: one transaction, `before` locked -------------------------
  it("concurrent PUTs each audit the value they actually replaced (row locked, write and audit atomic)", async () => {
    const since = new Date(Date.now() - 1000);
    const bodies = [31, 32, 33, 34, 35, 36].map((d) => ({ limited: { classes: [{ testClass: "owasp:llm:01" }], freshnessDays: d } }));
    try {
      const res = await Promise.all(bodies.map((b) => inject("PUT", PATH, users.admin.auth, b)));
      for (const r of res) expect(r.statusCode, r.body).toBe(200);
      const rows = await db
        .select({ detail: auditLog.detail })
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "review-policy-required-tests-set"), eq(auditLog.userId, users.admin.id), sql`${auditLog.at} >= ${since.toISOString()}`));
      const mine = rows.map((r) => r.detail as { from: unknown; to: unknown }).filter((d) => bodies.some((b) => JSON.stringify(b) === JSON.stringify(d.to)));
      expect(mine.length).toBe(bodies.length);
      // serialised: every writer replaced a DIFFERENT value, and the chain of
      // from -> to is one line through all six writes
      const froms = mine.map((d) => JSON.stringify(d.from));
      expect(new Set(froms).size).toBe(bodies.length);
      const tos = new Set(mine.map((d) => JSON.stringify(d.to)));
      expect(froms.filter((f) => !tos.has(f))).toHaveLength(1);
      const [row] = await db.select({ requiredTests: governanceReviewPolicy.requiredTests }).from(governanceReviewPolicy);
      expect(tos.has(JSON.stringify(row!.requiredTests))).toBe(true);
    } finally {
      expect((await inject("PUT", PATH, users.admin.auth, {})).statusCode).toBe(200);
    }
  });
});

describe("ADR-0180 A3 the deploy gate holds on required tests (enforce, the default)", () => {
  it("no run: required_test_missing holds the gate, with the reason explained", async () => {
    await clearRuns();
    const g = await gate(ucOne);
    expect(g.decision).toBe("deny");
    expect(g.assurance).toEqual({ mode: "enforce", status: "enforced", label: "enforced (mode enforce)" });
    expect(testReasons(g)).toEqual([["required_test_missing", "block", agentA]]);
    expect(g.reasons.find((r) => r.code === "required_test_missing")!.explanation).toMatch(/OWASP test class/);
  });

  it("a fresh passing run on the current configuration clears it (negative control)", async () => {
    await clearRuns();
    await redteamRun(agentA);
    const g = await gate(ucOne);
    expect(testReasons(g)).toEqual([]);
    expect(g.decision).toBe("allow");
  });

  it("a stale run fails", async () => {
    await clearRuns();
    await redteamRun(agentA, { ageDays: 31 });
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_stale", "block", agentA]]);
  });

  it("a config-hash mismatch fails", async () => {
    await clearRuns();
    await redteamRun(agentA, { configHash: "sha256:a-configuration-that-is-not-current" });
    const g = await gate(ucOne);
    expect(testReasons(g)).toEqual([["required_test_stale", "block", agentA]]);
    expect(g.reasons.find((r) => r.code === "required_test_stale")!.message).toMatch(/configuration changed/);
  });

  it("not_run is never a pass: a current run that did not measure the class", async () => {
    await clearRuns();
    await redteamRun(agentA, { classes: [{ attackClass: "bias", probes: 2 }] });
    const rows = await requiredTestStatus(db, { id: ucOne, euAiActTier: "limited", intendedAgentIds: [agentA] }, new Date());
    expect(rows.map((r) => r.state)).toEqual(["not_run"]);
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_missing", "block", agentA]]);
  });

  it("a defeated probe fails the strict 0% default", async () => {
    await clearRuns();
    await redteamRun(agentA, { classes: llm01({ jailbreak: { probes: 4, defeated: 1 } }) });
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_failing", "block", agentA]]);
  });

  // ---- FA3 finding 1: a probe the platform blocked never counts as resisted --
  it("a budget-blocked run never satisfies: every probe platform-held reads as no evidence, not 0% attack success", async () => {
    await clearRuns();
    // stored the way redteam.ts stores it: class_summary says 0 defeated
    await redteamRun(agentA, { classes: llm01({ prompt_injection: { held: 1 }, jailbreak: { held: 1 }, indirect_prompt_injection: { held: 1 }, encoding_evasion: { held: 1 } }) });
    const rows = await requiredTestStatus(db, { id: ucOne, euAiActTier: "limited", intendedAgentIds: [agentA] }, new Date());
    expect(rows.map((r) => r.state)).toEqual(["not_run"]);
    const g = await gate(ucOne);
    expect(testReasons(g)).toEqual([["required_test_missing", "block", agentA]]);
    expect(g.decision).toBe("deny");
  });

  it("one class reached only through platform holds leaves that class unmeasured, so the run is not evidence", async () => {
    await clearRuns();
    await redteamRun(agentA, { classes: llm01({ encoding_evasion: { probes: 2, held: 2 } }) });
    const [row] = await requiredTestStatus(db, { id: ucOne, euAiActTier: "limited", intendedAgentIds: [agentA] }, new Date());
    expect(row).toMatchObject({ state: "not_run" });
    expect(row!.detail).toMatch(/short on encoding_evasion \(0 probe\(s\), 0 trial\(s\)\)/);
  });

  // ---- FA3 finding 2: a single-trial smoke test is not evidence ----------------
  it("a single-trial run does not satisfy", async () => {
    await clearRuns();
    await redteamRun(agentA, { trials: 1 });
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_missing", "block", agentA]]);
  });

  // ---- FA3 finding 4: an ADOPTED configuration hash is not evidence --------------
  it("a run whose configuration hash the legacy-pin sweep adopted is not evidence", async () => {
    await clearRuns();
    const { evalRunId } = await redteamRun(agentA);
    expect(testReasons(await gate(ucOne))).toEqual([]);
    const marker = { userId: users.admin.id, objectType: "eval_run" as const, objectId: evalRunId, detail: { phase: "config-hash-adopted" }, effect: "allow" as const, ruleId: "eval-config-hash-adopted", ruleChain: [], reason: "a3 test" };
    await db.insert(auditLog).values(marker);
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_missing", "block", agentA]]);

    // and an EVAL run (the pinned baselines the sweep touches) the same way
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentA));
    const [er] = await db
      .insert(evalRuns)
      .values({ datasetId, datasetVersion: 1, agentId: agentA, agentName: agent!.name, model: agent!.model, tier: agent!.tier, trigger: "manual", status: "completed", configHash: await agentConfigHash(db, agent!), startedAt: new Date(Date.now() - DAY), finishedAt: new Date(Date.now() - DAY) })
      .returning({ id: evalRuns.id });
    evalRunIds.push(er!.id);
    await db.insert(evalResults).values(
      ["claim_support", "groundedness_judge"].flatMap((scorerKind) => Array.from({ length: 5 }, () => ({ runId: er!.id, scorerKind: scorerKind as "claim_support", score: 1, passed: true }))),
    );
    const policy = { limited: { classes: [{ testClass: "owasp:llm:09", minScore: 0.8 }], freshnessDays: 30 } };
    const status = () => requiredTestStatus(db, { id: ucOne, euAiActTier: "limited", intendedAgentIds: [agentA] }, new Date(), policy);
    expect((await status()).map((r) => r.state)).toEqual(["satisfied"]);
    await db.insert(auditLog).values({ ...marker, objectId: er!.id });
    expect((await status()).map((r) => r.state)).toEqual(["missing"]);
  });

  it("one agent of the stack missing a run fails", async () => {
    await clearRuns();
    await redteamRun(agentA);
    expect(testReasons(await gate(ucTwo))).toEqual([["required_test_missing", "block", agentB]]);
    await redteamRun(agentB);
    expect(testReasons(await gate(ucTwo))).toEqual([]);
  });
});

describe("ADR-0180 A3 the gate mode", () => {
  it("warn lists the reasons without holding; off skips them and says so", async () => {
    await clearRuns();
    try {
      expect((await inject("PUT", MODE_PATH, users.admin.auth, { mode: "warn" })).statusCode).toBe(200);
      const w = await gate(ucOne);
      expect(testReasons(w)).toEqual([["required_test_missing", "warn", agentA]]);
      expect(w.reasons.every((r) => r.severity === "warn")).toBe(true);
      expect(w.decision).toBe("allow");
      expect(w.assurance.status).toBe("warn_only");

      expect((await inject("PUT", MODE_PATH, users.admin.auth, { mode: "off" })).statusCode).toBe(200);
      const o = await gate(ucOne);
      expect(testReasons(o)).toEqual([]);
      expect(o.decision).toBe("allow");
      expect(o.assurance).toEqual({ mode: "off", status: "skipped", label: "skipped (mode off)" });
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectType, "deploy_gate"), eq(auditLog.objectId, ucOne)))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(audit!.detail).toMatchObject({ assurance: { mode: "off", status: "skipped" } });
    } finally {
      expect((await inject("PUT", MODE_PATH, users.admin.auth, { mode: "enforce" })).statusCode).toBe(200);
    }
  });
});

describe("ADR-0180 A3 the monitor loader", () => {
  it("reports a passing result that aged out for an approved use case, and nothing for a fresh one", async () => {
    await clearRuns();
    await redteamRun(agentA, { ageDays: 45 });
    const stale = await requiredTestsMonitorInput(db, new Date());
    const key = `use_case:${ucOne}>required_test:owasp:llm:01>agent:${agentA}`;
    const hit = stale.required_test_stale!.breaches.find((b) => b.subjectKey === key);
    expect(hit).toBeTruthy();
    expect(hit!.detail).toMatchObject({ useCaseId: ucOne, testClass: "owasp:llm:01", agentId: agentA, freshnessDays: 30 });

    await clearRuns();
    await redteamRun(agentA);
    const fresh = await requiredTestsMonitorInput(db, new Date());
    expect(fresh.required_test_stale!.breaches.some((b) => b.subjectKey === key)).toBe(false);
  });
});
