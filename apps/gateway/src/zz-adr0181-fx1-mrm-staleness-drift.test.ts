/**
 * ADR-0181 review fixes FX1 — WHAT COUNTS AS STALENESS DRIFT, the judge
 * exemption, and the enforcement route's old -> new.
 *
 * Finding 1 (HIGH): staleness-forces-recertification ships on with threshold
 * 1, and the drift count used to include every eval run, red-team run, grant
 * and revocation since certification. So ONE passing `POST /v1/evals/runs` by
 * an entitled non-admin refused every production dispatch of that model for
 * everyone. Drift is now regressions and governance-level changes only
 * (`StalenessDrift` in mrm-autofill.ts). Each case below is a write through the
 * real route where one exists, or a ledger row inserted the way the runners
 * write it where the outcome (a worse score) cannot be produced by the
 * deterministic mock:
 *
 *  - a non-admin's passing eval run does NOT stale a certified card, and the
 *    model still dispatches;
 *  - a grant addition does NOT;
 *  - a run that scored worse than the certification-era run DOES, and the
 *    gate then refuses; a manual run that failed only its caller-chosen floor
 *    does NOT; a server-started run that failed its gate DOES;
 *  - a red-team run with a worse attack-success rate than the
 *    certification-era run DOES; an equal one does NOT;
 *  - an agent guardrail TIGHTENING does not; a RELAXATION does;
 *  - a risk-register change, a system-prompt change and a card edit DO.
 *
 * Finding 8: a JUDGE is not the agent under test. A judge whose own card is
 * stale is refused (`mrm-staleness-recert-required`), never exempted.
 *
 * Finding 11a: `POST /v1/mrm/enforcement` records `detail.transitions`.
 *
 * SHARED STATE (M-068): the MRM org fields are restored exactly in afterAll;
 * the attribution mandate is relaxed by name and restored; the agent
 * guardrail overrides, risks, cards and inserted ledger rows are this file's
 * own (prefixed fx1-) and are removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  aiRisks,
  and,
  auditLog,
  createDb,
  eq,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  inArray,
  modelCardApprovals,
  modelCards,
  orgSettings,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { ModelBackedJudge } from "./evals.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "fx1-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let rikaId: string;
let rikaAuth: { authorization: string };
let subjectId: string;
let judgeId: string;
let subjectCardId: string;
let judgeCardId: string;
let goldenId: string;
let ledgerDatasetId: string;
let restoreGates: () => Promise<void> = async () => {};
let priorOrg: {
  mrmEnforced: boolean;
  mrmExpiryWarnDays: number;
  mrmStalenessRecertEnabled: boolean;
  mrmStalenessRecertThreshold: number;
} | null = null;
const insertedEvalRunIds: string[] = [];
const insertedRedteamRunIds: string[] = [];
const insertedLibraryIds: string[] = [];
const insertedDatasetIds: string[] = [];
let userSeq = 0;

type Staleness = {
  certified: boolean;
  drifted: boolean;
  driftEvents: number;
  summary: string | null;
  changesSinceCertification: Record<string, number> | null;
  driftSinceCertification: Record<string, number> | null;
};

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "fx1" },
  });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  return a.json().id as string;
}

async function makeCard(agentId: string, intendedUse: string): Promise<string> {
  const card = await app.inject({
    method: "POST",
    url: "/v1/mrm/cards",
    headers: AUTH,
    payload: { agentId, intendedUse },
  });
  expect(card.statusCode).toBe(201);
  return card.json().card.id as string;
}

/** a new granting sign-off: the drift clock restarts here */
async function certify(cardId: string, reason: string) {
  const req = await app.inject({
    method: "POST",
    url: `/v1/mrm/cards/${cardId}/sign-off`,
    headers: AUTH,
    payload: { approverUserId: rikaId, validUntil: new Date(Date.now() + 180 * DAY).toISOString(), reason },
  });
  expect(req.statusCode, req.body).toBe(201);
  const dec = await app.inject({
    method: "POST",
    url: `/v1/approvals/${req.json().approvalId}/decide`,
    headers: rikaAuth,
    payload: { decision: "approved", reason },
  });
  expect(dec.statusCode, dec.body).toBe(200);
}

async function staleness(cardId = subjectCardId): Promise<Staleness> {
  const res = await app.inject({ method: "GET", url: `/v1/mrm/cards/${cardId}`, headers: AUTH });
  expect(res.statusCode).toBe(200);
  return res.json().card.staleness as Staleness;
}

async function invoke() {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${subjectId}/invoke`,
    headers: anaAuth,
    payload: { mode: "execute", input: "fx1 summarize the ticket", dispatch: true },
  });
}

/** an eval_runs row exactly as the runner writes one */
async function insertEvalRun(values: Partial<typeof evalRuns.$inferInsert> & { startedAt: Date }) {
  const [row] = await db
    .insert(evalRuns)
    .values({
      datasetId: ledgerDatasetId,
      datasetVersion: 1,
      agentId: subjectId,
      agentName: "fx1-subject",
      trigger: "manual",
      status: "completed",
      mode: "execute",
      cases: 10,
      passedCases: 9,
      meanScore: 0.9,
      passRate: 0.9,
      tolerance: 0.05,
      gatePassed: true,
      regression: false,
      finishedAt: values.startedAt,
      ...values,
    })
    .returning();
  insertedEvalRunIds.push(row!.id);
  return row!;
}

let libraryId: string;
let rtDatasetId: string;
/** a finished red-team run (with its backing eval row) as the runner writes one */
async function insertRedteamRun(asr: number, startedAt: Date) {
  const er = await insertEvalRun({ datasetId: rtDatasetId, startedAt, tolerance: 1 });
  const [rt] = await db
    .insert(redteamRuns)
    .values({
      libraryId,
      libraryName: "fx1-lib",
      libraryVersion: 1,
      evalRunId: er.id,
      agentId: subjectId,
      agentName: "fx1-subject",
      probes: 10,
      resisted: 10 - Math.round(asr * 10),
      defeated: Math.round(asr * 10),
      trials: 4,
      asr,
      asrTrials: 40,
      measurementQuality: "measured",
      gatePassed: true,
      startedAt,
      finishedAt: startedAt,
    })
    .returning();
  insertedRedteamRunIds.push(rt!.id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // the dispatches here name no project: relax only the attribution mandate
  restoreGates = await relaxGovernanceGatesForTest(db, { dispatchAttributionRequired: false });
  const [org] = await db.select().from(orgSettings);
  priorOrg = org
    ? {
        mrmEnforced: org.mrmEnforced,
        mrmExpiryWarnDays: org.mrmExpiryWarnDays,
        mrmStalenessRecertEnabled: org.mrmStalenessRecertEnabled,
        mrmStalenessRecertThreshold: org.mrmStalenessRecertThreshold,
      }
    : null;
  // the shipped posture, set explicitly so an earlier suite cannot change it
  const armed = await app.inject({
    method: "POST",
    url: "/v1/mrm/enforcement",
    headers: AUTH,
    payload: { enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 },
  });
  expect(armed.statusCode).toBe(200);

  const ana = await makeUser("fx1-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  const rika = await makeUser("fx1-rika@example.com");
  rikaId = rika.id;
  rikaAuth = rika.auth;

  subjectId = await makeAgent("fx1-subject");
  judgeId = await makeAgent("fx1-judge");
  const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: anaId, agentId: subjectId } });
  expect(g.statusCode).toBe(201);

  for (const [name, set] of [
    ["fx1-golden", (id: string) => (goldenId = id)],
    ["fx1-ledger", (id: string) => (ledgerDatasetId = id)],
  ] as const) {
    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: { name, scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
    });
    expect(ds.statusCode).toBe(201);
    set(ds.json().id as string);
    insertedDatasetIds.push(ds.json().id as string);
    const c = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${ds.json().id}/cases`,
      headers: AUTH,
      payload: { input: "say ok", expected: "ok" },
    });
    expect(c.statusCode).toBe(201);
  }
  const [rtDs] = await db.insert(evalDatasets).values({ name: "fx1-rt-ds", version: 1, scorerKind: "contains" }).returning();
  rtDatasetId = rtDs!.id;
  const [lib] = await db.insert(redteamLibraries).values({ name: "fx1-lib", version: 1 }).returning();
  libraryId = lib!.id;
  insertedLibraryIds.push(libraryId);

  subjectCardId = await makeCard(subjectId, "fx1: summarize internal tickets");
  judgeCardId = await makeCard(judgeId, "fx1: grade eval answers");
  await certify(subjectCardId, "fx1: initial certification");
  await certify(judgeCardId, "fx1: judge certification");
});

afterAll(async () => {
  if (priorOrg) await db.update(orgSettings).set(priorOrg).where(eq(orgSettings.id, "singleton"));
  await restoreGates();
  const mine = [subjectId, judgeId].filter(Boolean);
  if (mine.length) {
    await db.delete(guardrailConfigs).where(and(eq(guardrailConfigs.scope, "agent"), inArray(guardrailConfigs.scopeId, mine)));
    await db.delete(aiRisks).where(inArray(aiRisks.agentId, mine));
    const cards = await db.select({ id: modelCards.id }).from(modelCards).where(inArray(modelCards.agentId, mine));
    if (cards.length) {
      await db.delete(modelCardApprovals).where(inArray(modelCardApprovals.cardId, cards.map((c) => c.id)));
      await db.delete(modelCards).where(inArray(modelCards.id, cards.map((c) => c.id)));
    }
  }
  if (insertedRedteamRunIds.length) await db.delete(redteamRuns).where(inArray(redteamRuns.id, insertedRedteamRunIds));
  if (insertedEvalRunIds.length) await db.delete(evalRuns).where(inArray(evalRuns.id, insertedEvalRunIds));
  if (insertedLibraryIds.length) await db.delete(redteamLibraries).where(inArray(redteamLibraries.id, insertedLibraryIds));
  await app.close();
  await db.$client.end();
});

// ---------------------------------------------------------------------------

describe("finding 1 — routine evidence is not drift", () => {
  it("a non-admin's passing eval run does NOT stale a certified card, and the model still dispatches", async () => {
    const run = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: anaAuth,
      payload: { datasetId: goldenId, agentId: subjectId },
    });
    expect(run.statusCode, run.body).toBe(201);
    // the model still dispatches for everyone else
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(200);
    const s = await staleness();
    expect(s.certified).toBe(true);
    expect(s.drifted).toBe(false);
    // the run is visible as activity, and is not drift
    expect(s.changesSinceCertification!.evalRuns).toBeGreaterThanOrEqual(1);
    expect(s.driftEvents).toBe(0);
  });

  it("a grant addition does NOT stale the card", async () => {
    const extra = await makeUser(`fx1-grantee-${++userSeq}@example.com`);
    const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: extra.id, agentId: subjectId } });
    expect(g.statusCode).toBe(201);
    expect((await invoke()).statusCode).toBe(200);
    const s = await staleness();
    expect(s.drifted).toBe(false);
    expect(s.changesSinceCertification!.grantChanges).toBeGreaterThanOrEqual(1);
  });
});

describe("finding 1 — regressions ARE drift", () => {
  it("a manual run that failed only its caller-chosen floor does not; one that scored worse than at certification does, and the gate refuses", async () => {
    // the certification-era reference: before the last sign-off
    await insertEvalRun({ startedAt: new Date(Date.now() - 2 * DAY), meanScore: 0.9, passRate: 0.9 });
    // same score, but the caller asked for a floor of 1.0: their gate, not drift
    await insertEvalRun({ startedAt: new Date(), minScore: 1, gatePassed: false, meanScore: 0.9, passRate: 0.9 });
    let s = await staleness();
    expect(s.driftSinceCertification!.evalRegressions).toBe(0);
    expect(s.drifted).toBe(false);

    // the same suite, measured the same way, now scores 0.5 (past the 0.05 tolerance)
    await insertEvalRun({ startedAt: new Date(), meanScore: 0.5, passRate: 0.5, passedCases: 5 });
    s = await staleness();
    expect(s.driftSinceCertification!.evalRegressions).toBe(1);
    expect(s.drifted).toBe(true);
    expect(s.summary).toContain("1 eval regression");

    const res = await invoke();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mrm_approval_required");
    expect(res.json().detail).toContain("eval regression");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-staleness-recert-required"), eq(auditLog.objectId, subjectCardId)));
    expect((row!.detail as any).staleness.driftSinceCertification.evalRegressions).toBe(1);
    expect((row!.detail as any).staleness.totalChanges).toBe(1);
  });

  it("a server-started (scheduled) run that failed its gate is drift", async () => {
    await certify(subjectCardId, "fx1: recertified after the regression review");
    expect((await staleness()).drifted).toBe(false);
    await insertEvalRun({ startedAt: new Date(), trigger: "scheduled", gatePassed: false, regression: true, datasetVersion: 1 });
    const s = await staleness();
    expect(s.driftSinceCertification!.evalRegressions).toBe(1);
    expect(s.drifted).toBe(true);
  });

  it("a red-team run with a WORSE attack-success rate than at certification is drift; an equal one is not", async () => {
    await certify(subjectCardId, "fx1: recertified");
    await insertRedteamRun(0.1, new Date(Date.now() - 2 * DAY));
    await insertRedteamRun(0.1, new Date());
    let s = await staleness();
    expect(s.changesSinceCertification!.redteamRuns).toBeGreaterThanOrEqual(1);
    // its backing eval row is not counted as an eval run of its own
    expect(s.driftSinceCertification!.evalRegressions).toBe(0);
    expect(s.driftSinceCertification!.redteamRegressions).toBe(0);
    expect(s.drifted).toBe(false);

    await insertRedteamRun(0.3, new Date());
    s = await staleness();
    expect(s.driftSinceCertification!.redteamRegressions).toBe(1);
    expect(s.drifted).toBe(true);
  });
});

describe("finding 1 — governance-level changes ARE drift", () => {
  it("an agent guardrail TIGHTENING is not drift; a RELAXATION is", async () => {
    await certify(subjectCardId, "fx1: recertified");
    const tighten = await app.inject({
      method: "PUT",
      url: `/v1/guardrails/config/agent/${subjectId}`,
      headers: AUTH,
      payload: { modes: { prompt_injection: "block", jailbreak: "block", toxicity: "block", semantic_dlp: "block" } },
    });
    expect(tighten.statusCode, tighten.body).toBe(200);
    let s = await staleness();
    expect(s.changesSinceCertification!.guardrailChanges).toBeGreaterThanOrEqual(1);
    expect(s.driftSinceCertification!.guardrailRelaxations).toBe(0);
    expect(s.drifted).toBe(false);

    const relax = await app.inject({
      method: "PUT",
      url: `/v1/guardrails/config/agent/${subjectId}`,
      headers: AUTH,
      payload: { modes: { prompt_injection: "warn" } },
    });
    expect(relax.statusCode).toBe(200);
    s = await staleness();
    expect(s.driftSinceCertification!.guardrailRelaxations).toBe(1);
    expect(s.summary).toContain("agent guardrail relaxation");
    expect(s.drifted).toBe(true);
    expect((await invoke()).statusCode).toBe(409);
  });

  it("a risk-register change on the subject is drift", async () => {
    await certify(subjectCardId, "fx1: recertified");
    const r = await app.inject({
      method: "POST",
      url: "/v1/risks",
      headers: AUTH,
      payload: {
        title: "fx1 prompt injection via ticket text",
        description: "fx1 risk",
        category: "prompt_injection",
        likelihood: "medium",
        impact: "high",
        ownerUserId: rikaId,
        agentId: subjectId,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const s = await staleness();
    expect(s.driftSinceCertification!.riskChanges).toBe(1);
    expect(s.drifted).toBe(true);
  });

  it("a system-prompt (configuration) change is drift", async () => {
    await certify(subjectCardId, "fx1: recertified");
    const p = await app.inject({
      method: "POST",
      url: `/v1/agents/${subjectId}/system-prompt`,
      headers: AUTH,
      payload: { systemPrompt: "fx1: answer only from the ticket" },
    });
    expect(p.statusCode, p.body).toBeLessThan(300);
    const s = await staleness();
    expect(s.driftSinceCertification!.configChanges).toBeGreaterThanOrEqual(1);
    expect(s.drifted).toBe(true);
  });

  it("an edit of the signed card is drift", async () => {
    await certify(subjectCardId, "fx1: recertified");
    const e = await app.inject({
      method: "PATCH",
      url: `/v1/mrm/cards/${subjectCardId}`,
      headers: AUTH,
      payload: { limitations: "fx1: not for customer-facing answers" },
    });
    expect(e.statusCode, e.body).toBe(200);
    const s = await staleness();
    expect(s.driftSinceCertification!.cardEdits).toBe(1);
    expect(s.drifted).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("finding 8 — a judge is gated in full, staleness included", () => {
  it("a judge whose own card is stale is REFUSED, never exempted as an evaluation", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/risks",
      headers: AUTH,
      payload: {
        title: "fx1 judge leniency",
        description: "fx1 judge risk",
        category: "prompt_injection",
        likelihood: "medium",
        impact: "medium",
        ownerUserId: rikaId,
        agentId: judgeId,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((await staleness(judgeCardId)).drifted).toBe(true);

    const [judgeAgent] = await db.select().from(agents).where(eq(agents.id, judgeId));
    const judge = new ModelBackedJudge(db, DATA_KEY, {
      judgeAgent: judgeAgent!,
      userId: anaId,
      projectId: null,
      threshold: 0.5,
      evalRunId: randomUUID(),
    });
    await expect(
      judge.judge({ caseInput: "say ok", expected: "ok", rubric: null, output: "ok" }),
    ).rejects.toThrow(/mrm_approval_required/);

    const rows = await db
      .select({ ruleId: auditLog.ruleId })
      .from(auditLog)
      .where(eq(auditLog.objectId, judgeCardId));
    expect(rows.some((x) => x.ruleId === "mrm-staleness-recert-required")).toBe(true);
    expect(rows.some((x) => x.ruleId === "mrm-staleness-evaluation-allowed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("finding 11a — the enforcement route records old -> new", () => {
  it("POST /v1/mrm/enforcement writes detail.transitions for exactly the changed settings", async () => {
    const relax = await app.inject({
      method: "POST",
      url: "/v1/mrm/enforcement",
      headers: AUTH,
      payload: { enforced: true, stalenessRecertEnabled: false, stalenessRecertThreshold: 3 },
    });
    expect(relax.statusCode).toBe(200);
    type Detail = { stalenessRecert?: { to?: { threshold?: number } }; transitions?: Record<string, { from: unknown; to: unknown }> };
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, "mrm-enforcement-enabled"));
    const row = rows.find((r) => (r.detail as Detail).stalenessRecert?.to?.threshold === 3);
    expect(row).toBeDefined();
    expect((row!.detail as Detail).transitions).toEqual({
      mrmStalenessRecertEnabled: { from: true, to: false },
      mrmStalenessRecertThreshold: { from: 1, to: 3 },
    });
    // back to the shipped posture (afterAll restores the exact prior values)
    const back = await app.inject({
      method: "POST",
      url: "/v1/mrm/enforcement",
      headers: AUTH,
      payload: { enforced: true, stalenessRecertEnabled: true, stalenessRecertThreshold: 1 },
    });
    expect(back.statusCode).toBe(200);
  });
});
