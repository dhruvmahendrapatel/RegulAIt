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
 *  - the monitor loader reports a passing result that aged out.
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
  evalRuns,
  governanceReviewPolicy,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { agentConfigHash } from "./evals.js";
import { requiredTestStatus, requiredTestsMonitorInput } from "./required-tests.js";

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

/** a completed red-team run of `agentId`, measuring `classes`, finished `ageDays` ago */
async function redteamRun(
  agentId: string,
  opts: { ageDays?: number; configHash?: string; classes?: Array<{ attackClass: string; probes: number; defeated: number }> } = {},
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
  const classes = opts.classes ?? [{ attackClass: "prompt_injection", probes: 3, defeated: 0 }];
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
      classSummary: classes.map((c) => ({ ...c, resisted: c.probes - c.defeated })),
      startedAt: finishedAt,
      finishedAt,
    })
    .returning({ id: redteamRuns.id });
  runIds.push(rr!.id);
  return rr!.id;
}
async function clearRuns() {
  for (const id of runIds.splice(0)) await db.delete(redteamRuns).where(eq(redteamRuns.id, id));
  for (const id of evalRunIds.splice(0)) await db.delete(evalRuns).where(eq(evalRuns.id, id));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
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
    await redteamRun(agentA, { classes: [{ attackClass: "bias", probes: 2, defeated: 0 }] });
    const rows = await requiredTestStatus(db, { id: ucOne, euAiActTier: "limited", intendedAgentIds: [agentA] }, new Date());
    expect(rows.map((r) => r.state)).toEqual(["not_run"]);
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_missing", "block", agentA]]);
  });

  it("a defeated probe fails the strict 0% default", async () => {
    await clearRuns();
    await redteamRun(agentA, { classes: [{ attackClass: "jailbreak", probes: 4, defeated: 1 }] });
    expect(testReasons(await gate(ucOne))).toEqual([["required_test_failing", "block", agentA]]);
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
