/**
 * ADR-0082 — the boardroom posture one-pager (gap L8).
 *
 * The load-bearing property under test: EVERY NUMBER IS A SELECT OVER THE
 * REAL LEDGERS AT REQUEST TIME — no rollup, no snapshot. The differentiator
 * tests seed actual ledger rows (usage events against a budgeted project,
 * deny/PII audit rows, a red-team run with its full ASR statistics, a
 * groundedness eval, register rows) and watch the posture document move by
 * exactly those deltas. Non-vacuity was proven the M-002 way during review:
 * constant-ify the governance denials query and the delta test here fails;
 * no-op the observed-edge aggregation and the inventory suite's feed tests
 * fail (documented in ADR-0082).
 *
 * The honesty half: an ASR never travels without its Wilson interval, trial
 * denominator and quality label; a section with no data says "unmeasured"/
 * "none recorded" rather than a reassuring zero; tamper resistance is the
 * OBSERVED grading (this harness passes sink=null, so the document must say
 * NOT tamper-resistant in as many words).
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed po-. All cross-suite numbers are asserted as
 * DELTAS (M-008), and the usage rows this suite adds to the ONE spend ledger
 * are deleted in afterAll so no other suite's totals move.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  and,
  auditLog,
  count,
  createDb,
  eq,
  gte,
  evalDatasets,
  evalRuns,
  inArray,
  lt,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { POSTURE_UNMEASURED_REDTEAM } from "./posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "po-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const PACK_FRAMEWORK = "po-posture-framework";

let db: Db;
let app: ReturnType<typeof buildApp>;
let omarId: string;
let omarAuth: { authorization: string };
let projectId: string;
const createdUsageIds: string[] = [];

interface PostureDoc {
  window: { days: number; start: string; end: string };
  packs: { active: Array<Record<string, unknown>>; note: string };
  risks: { open: number; mitigating: number; accepted: number; closed: number; total: number; attestationOnly: number; disclaimer: string };
  redteam: {
    measured: boolean;
    runsInWindow: number;
    latest: Record<string, unknown> | null;
    trend: Array<Record<string, unknown>>;
    note: string;
  };
  evals: { runsInWindow: number; groundedness: { runsInWindow: number; latest: Record<string, unknown> | null; note?: string } };
  spend: {
    totalCostUsd: number;
    events: number;
    unattributedCostUsd: number;
    budgets: Array<{ projectId: string; budgetUsd: number; spentUsd: number; overBudget: boolean; budgetPeriod: string }>;
    overBudgetProjects: number;
    dailyTrend: Array<{ day: string; costUsd: number }>;
    estimate: boolean;
    disclaimer: string;
  };
  governance: { denials: number; piiBlocks: number; approvalsPending: number; approvalsDecidedInWindow: number };
  auditChain: { sink: { tamperResistant: boolean } | null; disclosure: string; anchors: number };
  useCases: { proposed: number; underReview: number; approved: number; rejected: number; retired: number; total: number };
  note: string;
}

async function posture(auth = AUTH): Promise<{ statusCode: number; body: PostureDoc }> {
  const res = await app.inject({ method: "GET", headers: auth, url: "/v1/reports/posture" });
  return { statusCode: res.statusCode, body: res.json() as PostureDoc };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // sink: null ON PURPOSE — the anchoring section must then say, in words,
  // that nothing here is tamper-resistant (observed posture, not config)
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64), auditAnchorSink: null });
  // ADR-0052 §4: pack ACTIVATION is now tier-gated on `compliance_packs` —
  // run under a real signed license granting it (removed in afterAll; the
  // deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["compliance_packs"], auth: AUTH });

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "po-omar@example.com", displayName: "po omar" },
  });
  expect(user.statusCode).toBe(201);
  omarId = user.json().id;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${omarId}/keys`,
    payload: { name: "po-key" },
  });
  omarAuth = { authorization: `Bearer ${key.json().token}` };

  // a budgeted, MONTHLY project — the budget standing the spend section reads
  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "po-budgeted", budgetUsd: 5, budgetPeriod: "monthly", budgetApproverUserId: omarId },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

afterAll(async () => {
  // this suite's additions to the ONE shared spend ledger must go, or other
  // suites' org-wide totals move under them (the reporting.test discipline)
  if (createdUsageIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.id, createdUsageIds));
  }
  await removeLicenseFixture(db);
  await app.close();
  await db.$client.end();
});

describe("scoping — the posture view is the org-wide read, admin-only (the ADR-0047 org position)", () => {
  it("refuses a non-admin outright", async () => {
    const res = await posture(omarAuth);
    expect(res.statusCode).toBe(403);
  });

  it("serves the whole document to an admin, with the no-snapshot note on its face", async () => {
    const res = await posture();
    expect(res.statusCode).toBe(200);
    expect(res.body.note).toMatch(/no rollup table, no\s+stored snapshot/);
    expect(res.body.note).toMatch(/window over what the ledgers hold, not\s+a measure of real-world exposure/);
    for (const section of ["packs", "risks", "redteam", "evals", "spend", "governance", "auditChain", "useCases"]) {
      expect(res.body, `section ${section} missing`).toHaveProperty(section);
    }
  });
});

describe("EVERY NUMBER IS A SELECT AT REQUEST TIME (the differentiator)", () => {
  it("spend vs budget moves by exactly the usage rows written, and the budget standing is computed per the project's own period semantics", async () => {
    const before = await posture();
    const at = new Date(); // now — inside the current month AND the daily-trend window
    const rows = await db
      .insert(usageEvents)
      .values([
        { userId: omarId, objectType: "agent", projectId, provider: "mock", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 4, at },
        { userId: omarId, objectType: "agent", projectId, provider: "mock", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 2.5, at },
        // an UNATTRIBUTED row — must land in the unattributed bucket, never a project's
        { userId: omarId, objectType: "agent", projectId: null, provider: "mock", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0.25, at },
      ])
      .returning({ id: usageEvents.id });
    createdUsageIds.push(...rows.map((r) => r.id));

    const after = await posture();
    expect(after.body.spend.totalCostUsd).toBeCloseTo(before.body.spend.totalCostUsd + 6.75, 6);
    expect(after.body.spend.events).toBe(before.body.spend.events + 3);
    expect(after.body.spend.unattributedCostUsd).toBeCloseTo(before.body.spend.unattributedCostUsd + 0.25, 6);

    // OUR budgeted project: monthly budget 5, month spend 6.5 -> over budget
    const line = after.body.spend.budgets.find((b) => b.projectId === projectId);
    expect(line).toBeTruthy();
    expect(line!.budgetPeriod).toBe("monthly");
    expect(line!.spentUsd).toBeCloseTo(6.5, 6);
    expect(line!.overBudget).toBe(true);
    expect(after.body.spend.overBudgetProjects).toBeGreaterThanOrEqual(1);

    // the estimate label is on the face of the document, and the daily trend
    // carries today's delta
    expect(after.body.spend.estimate).toBe(true);
    expect(after.body.spend.disclaimer).toMatch(/list price/i);
    const day = at.toISOString().slice(0, 10);
    const beforeDay = before.body.spend.dailyTrend.find((d) => d.day === day)?.costUsd ?? 0;
    const afterDay = after.body.spend.dailyTrend.find((d) => d.day === day)?.costUsd ?? 0;
    expect(afterDay).toBeCloseTo(beforeDay + 6.75, 6);
  });

  it("governance activity moves by exactly the deny rows written to the audit ledger", async () => {
    const before = await posture();
    for (const ruleId of ["pii-blocked", "pii-blocked", "po-denied-rule"]) {
      await db.insert(auditLog).values({
        userId: omarId,
        objectType: "agent",
        objectId: null,
        detail: { note: "po-seeded governance row" },
        effect: "deny",
        ruleId,
        ruleChain: [],
        reason: "po-seeded deny for the posture suite",
      });
    }
    const after = await posture();
    // The window is ROLLING: between the two reads its start moved forward too,
    // so a deny row another file left near the 30-day edge can slide out of it
    // (CI 37130757454 read 727 for an expected 728). Account for exactly the
    // rows that left at the old start and arrived at the new end, from the
    // ledger itself — and require this test's own rows to be among the arrivals.
    const span = async (from: string, to: string, pii: boolean) => {
      const [row] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(and(
          gte(auditLog.at, new Date(from)),
          lt(auditLog.at, new Date(to)),
          eq(auditLog.effect, "deny"),
          ...(pii ? [sql`${auditLog.ruleId} LIKE 'pii-%'`] : []),
        ));
      return row?.n ?? 0;
    };
    const w0 = before.body.window, w1 = after.body.window;
    for (const [field, pii, own] of [["denials", false, 3], ["piiBlocks", true, 2]] as const) {
      const left = await span(w0.start, w1.start, pii);
      const arrived = await span(w0.end, w1.end, pii);
      expect(arrived).toBeGreaterThanOrEqual(own);
      expect(after.body.governance[field]).toBe(before.body.governance[field] + arrived - left);
    }
  });

  it("risk-register counts move with the register, and the attestation-only count is NAMED", async () => {
    const before = await posture();
    const mk = (title: string, category: string) =>
      app.inject({
        method: "POST",
        headers: omarAuth,
        url: "/v1/risks",
        payload: { title, description: "po scenario", category, likelihood: "low", impact: "low" },
      });
    expect((await mk("po-risk-open", "tool_misuse")).statusCode).toBe(201);
    // scope_drift maps to ["none"] — the attestation-only category (ADR-0081)
    expect((await mk("po-risk-attestation", "scope_drift")).statusCode).toBe(201);

    const after = await posture();
    expect(after.body.risks.open).toBe(before.body.risks.open + 2);
    expect(after.body.risks.total).toBe(before.body.risks.total + 2);
    expect(after.body.risks.attestationOnly).toBe(before.body.risks.attestationOnly + 1);
    expect(after.body.risks.disclaimer).toBeTruthy();
  });

  it("the use-case pipeline counts move with the registry", async () => {
    const before = await posture();
    await db.insert(aiUseCases).values({
      name: "po-use-case",
      description: "po pipeline row",
      ownerUserId: omarId,
      businessContext: "po",
      dataSensitivity: "internal",
    });
    const after = await posture();
    expect(after.body.useCases.proposed).toBe(before.body.useCases.proposed + 1);
    expect(after.body.useCases.total).toBe(before.body.useCases.total + 1);
  });

  it("pack coverage is COMPUTED per active pack from its control mapping — and says coverage, never compliance", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/packs",
      payload: {
        framework: PACK_FRAMEWORK,
        version: 1,
        title: "po posture pack",
        provenance: { source: "posture suite" },
        controls: [
          {
            controlRef: "po:1.1-decisions-logged",
            title: "decisions are logged",
            coverage: "enforced",
            collector: "audit_decisions",
            collectorParams: { ruleIdPrefix: "po-" },
            minEvidenceCount: 1,
            attestationRequired: false,
          },
          {
            controlRef: "po:9.9-unmeasurable",
            title: "an organisational control no ledger evidences",
            coverage: "unaddressed",
            collector: "none",
            collectorParams: {},
            minEvidenceCount: 1,
            attestationRequired: true,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const packId = created.json().pack.id as string;
    const activated = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/compliance/packs/${packId}/activate`,
      payload: {},
    });
    expect(activated.statusCode).toBe(200);

    const res = await posture();
    const pack = res.body.packs.active.find((p) => p.framework === PACK_FRAMEWORK) as {
      totals: { controls: number; satisfied: number; attestationRequired: number };
      evidencedPct: number;
      statement: string;
    };
    expect(pack, "our activated pack must appear").toBeTruthy();
    expect(pack.totals.controls).toBe(2);
    // the po- deny rows seeded above are real audit evidence in the window
    expect(pack.totals.satisfied).toBe(1);
    expect(pack.totals.attestationRequired).toBe(1);
    expect(pack.evidencedPct).toBe(50);
    expect(pack.statement).toMatch(/NOT a compliance verdict/);
    expect(res.body.packs.note).toMatch(/never a compliance verdict/);
  });

  it("red-team posture surfaces the latest ASR VERBATIM — rate, Wilson interval, denominator and quality label together", async () => {
    const before = await posture();
    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "po-redteam-ds", version: 1, scorerKind: "contains" })
      .returning();
    const [er] = await db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentName: "po-agent", trigger: "manual", status: "completed" })
      .returning();
    const [lib] = await db.insert(redteamLibraries).values({ name: "po-lib", version: 1 }).returning();
    await db.insert(redteamRuns).values({
      libraryId: lib!.id,
      libraryName: "po-lib",
      libraryVersion: 1,
      evalRunId: er!.id,
      agentName: "po-agent",
      probes: 10,
      resisted: 8,
      defeated: 2,
      trials: 5,
      asr: 0.2,
      asrLower: 0.09,
      asrUpper: 0.38,
      asrTrials: 50,
      measurementQuality: "measured",
      platformHeld: 3,
    });

    const after = await posture();
    expect(after.body.redteam.measured).toBe(true);
    expect(after.body.redteam.runsInWindow).toBe(before.body.redteam.runsInWindow + 1);
    // VERBATIM, and never a bare rate: the interval, denominator and quality
    // label ride the same object (ADR-0068 via ADR-0081)
    expect(after.body.redteam.latest).toMatchObject({
      agentName: "po-agent",
      asr: 0.2,
      asrLower: 0.09,
      asrUpper: 0.38,
      asrTrials: 50,
      measurementQuality: "measured",
      platformHeld: 3,
    });
    // the trend ends at the newest run (rendered left-to-right in time)
    const last = after.body.redteam.trend[after.body.redteam.trend.length - 1];
    expect(last).toMatchObject({ asr: 0.2, agentName: "po-agent" });
  });

  it("groundedness evals move by exactly the runs written", async () => {
    const before = await posture();
    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "po-grounded-ds", version: 1, scorerKind: "claim_support" })
      .returning();
    await db.insert(evalRuns).values({
      datasetId: ds!.id,
      datasetVersion: 1,
      agentName: "po-agent",
      trigger: "manual",
      status: "completed",
      cases: 10,
      passedCases: 8,
      passRate: 0.8,
    });
    const after = await posture();
    expect(after.body.evals.groundedness.runsInWindow).toBe(before.body.evals.groundedness.runsInWindow + 1);
    expect(after.body.evals.runsInWindow).toBeGreaterThanOrEqual(before.body.evals.runsInWindow + 1);
    expect(after.body.evals.groundedness.latest).toMatchObject({ passRate: 0.8, scorerKind: "claim_support" });
  });
});

describe("empty never reads as good", () => {
  it("with NO anchor sink, the anchoring section says NOT tamper-resistant in words — observed posture, never config", async () => {
    const res = await posture();
    expect(res.body.auditChain.sink).toBeNull();
    expect(res.body.auditChain.disclosure).toMatch(/NOT tamper-resistant/);
  });

  it("the unmeasured red-team branch is structurally honest: measured=false carries the 'unmeasured, not resisted' phrasing, never an ASR of zero", async () => {
    // this shared DB has red-team history by the time this file runs, so the
    // branch contract is pinned two ways: the constant itself carries the
    // ADR-0081 phrasing, and the served document is internally consistent —
    // measured:false ⇒ latest is null and the note says unmeasured;
    // measured:true ⇒ the latest block exists and is never a bare rate.
    expect(POSTURE_UNMEASURED_REDTEAM).toMatch(/unmeasured, not resisted/);
    const res = await posture();
    if (res.body.redteam.measured) {
      expect(res.body.redteam.latest).toBeTruthy();
      expect(res.body.redteam.latest).toHaveProperty("asrTrials");
      expect(res.body.redteam.latest).toHaveProperty("measurementQuality");
    } else {
      expect(res.body.redteam.latest).toBeNull();
      expect(res.body.redteam.note).toBe(POSTURE_UNMEASURED_REDTEAM);
    }
  });
});
