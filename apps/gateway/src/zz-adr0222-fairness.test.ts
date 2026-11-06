/**
 * ADR-0222 (P13(a)) — fairness testing, proved against the database.
 *
 *  1. Off by default: nothing is stored or computed until an admin turns it on, and turning it on is a
 *     `settings_relax` step-up (an admin API key cannot do it).
 *  2. Data minimisation: an upload keeps only the label, prediction and protected attribute columns, encrypted;
 *     no route returns rows or ciphertext; a refusal or an audit row never quotes a cell.
 *  3. A run reproduces fairlearn's numbers on the golden rows through the API, and is audited.
 *  4. A failing or inconclusive latest run holds the card's sign-off and dispatch while blocking is on.
 *  5. Retention deletes the rows (the sha256 and the runs stay), and a deleted dataset cannot be run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  auditLog,
  createDb,
  eq,
  fairnessDatasets,
  fairnessRuns,
  inArray,
  modelCardApprovals,
  modelCards,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  type Db,
} from "@regulait/db";
import { FAIRNESS_DEFAULT_THRESHOLDS, FAIRNESS_STRICT_SETTINGS } from "@regulait/shared";
import { decryptSecret } from "./secrets.js";
import { FAIRNESS_RULE_IDS, FAIRNESS_WRITE_RATE_PER_MINUTE, decodeRows, fairnessRateCheck, runFairnessRetentionSweep } from "./fairness.js";
import { mrmDispatchGate } from "./mrm.js";
import { STRICT_GOVERNANCE_GATES } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const { buildApp } = await import("./app.js");

const BOOT = "fairness-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);
const RUN = Date.now().toString(36);
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** a value that must never appear in a response, a log line or an audit row */
const SENSITIVE = "SENSITIVE-GROUP-VALUE";

const golden = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/src/__fixtures__/fairness-golden.json"), "utf8"),
) as { rows: Array<{ sex: string; age_band: string; label: number; prediction: number }>; expected: Record<string, Record<string, number>> };

let db: Db;
let restoreIdentity: (() => Promise<void>) | undefined;
let app: ReturnType<typeof buildApp>;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let adminId: string;
let agentId: string;
let cardId: string;
const datasetIds: string[] = [];

/** the golden rows as an upload, with an identifier column that must be dropped */
function goldenCsv(): string {
  const lines = ["applicant_ref,sex,age_band,outcome,predicted"];
  golden.rows.forEach((r, i) => lines.push(`A-${1000 + i},${r.sex},${r.age_band},${r.label},${r.prediction}`));
  return lines.join("\n") + "\n";
}

/** two equal groups: every metric passes */
function fairCsv(): string {
  const lines = ["group,y,p"];
  for (const g of ["north", "south"]) {
    for (let i = 0; i < 40; i++) lines.push(`${g},1,1`);
    for (let i = 0; i < 40; i++) lines.push(`${g},0,0`);
  }
  return lines.join("\n");
}

async function makeUser(email: string, isAdmin: boolean) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " "), isAdmin } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "fairness" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function setFairness(payload: Record<string, unknown>, headers = AUTH) {
  return app.inject({ method: "PUT", url: "/v1/mrm/fairness/settings", headers, payload });
}

async function upload(payload: Record<string, unknown>, headers = AUTH) {
  const res = await app.inject({ method: "POST", url: "/v1/mrm/fairness/datasets", headers, payload });
  if (res.statusCode === 201) datasetIds.push(res.json().dataset.id);
  return res;
}

async function runTest(payload: Record<string, unknown>, headers = AUTH) {
  return app.inject({ method: "POST", url: "/v1/mrm/fairness/runs", headers, payload });
}

async function audits(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

async function resetFairnessSettings() {
  await db
    .update(orgSettings)
    .set({
      fairnessTestingEnabled: FAIRNESS_STRICT_SETTINGS.fairnessTestingEnabled,
      fairnessBlockOnFail: FAIRNESS_STRICT_SETTINGS.fairnessBlockOnFail,
      fairnessDatasetRetentionDays: FAIRNESS_STRICT_SETTINGS.fairnessDatasetRetentionDays,
    })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // an admin API key needs MFA off to authenticate at all; it still can never give a step-up
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  await resetFairnessSettings();
  const admin = await makeUser(`fair-admin-${RUN}@example.test`, true);
  adminId = admin.id;
  adminKey = admin.auth;
  memberKey = (await makeUser(`fair-member-${RUN}@example.test`, false)).auth;
  const [a] = await db.insert(agents).values({ name: `fair-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
  agentId = a!.id;
  const [c] = await db.insert(modelCards).values({ agentId, intendedUse: `credit pre-screening ${RUN}` }).returning({ id: modelCards.id });
  cardId = c!.id;
});

afterAll(async () => {
  // M-068: put the strict values back, not "what was there before"
  await resetFairnessSettings();
  await restoreIdentity?.();
  await db
    .update(orgSettings)
    .set({ mrmEnforced: STRICT_GOVERNANCE_GATES.mrmEnforced, mrmStalenessRecertEnabled: STRICT_GOVERNANCE_GATES.mrmStalenessRecertEnabled })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.delete(modelCards).where(eq(modelCards.id, cardId)); // cascades its runs and approvals
  if (datasetIds.length) await db.delete(fairnessDatasets).where(inArray(fairnessDatasets.id, datasetIds));
  await db.delete(agents).where(eq(agents.id, agentId));
  await app.close();
});

describe("ADR-0222: off until an admin turns it on", () => {
  it("is off on a first load, and nothing can be uploaded or run", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/fairness", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ enabled: false, blockOnFail: true, datasetRetentionDays: 30 });
    const up = await upload({ name: "x", csv: fairCsv(), labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["group"] });
    expect(up.statusCode).toBe(409);
    expect(up.json().error).toBe("fairness_testing_off");
    const run = await runTest({ datasetId: randomUUID(), cardId });
    expect(run.statusCode).toBe(409);
    const status = await app.inject({ method: "GET", url: "/v1/mrm/status", headers: AUTH });
    expect(status.json().fairness).toEqual({ enabled: false, blockOnFail: true });
  });

  it("is admin-only", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mrm/fairness", headers: memberKey });
    expect(res.statusCode).toBe(403);
  });

  it("turning it on is a step-up: an admin API key is refused, and nothing changes", async () => {
    const res = await setFairness({ enabled: true }, adminKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_required");
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org!.fairnessTestingEnabled).toBe(false);
    // tightening needs no step-up
    const tighten = await setFairness({ datasetRetentionDays: 14 }, adminKey);
    expect(tighten.statusCode).toBe(200);
    expect(tighten.json().datasetRetentionDays).toBe(14);
  });

  it("turning it on with the step-up is audited with its transition", async () => {
    const res = await setFairness({ enabled: true, datasetRetentionDays: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, blockOnFail: true, datasetRetentionDays: 30 });
    const rows = await audits(FAIRNESS_RULE_IDS.settings);
    const last = rows.sort((a, b) => b.at.getTime() - a.at.getTime())[0]!;
    expect((last.detail as { relaxed: string[] }).relaxed.sort()).toEqual(["fairnessDatasetRetentionDays", "fairnessTestingEnabled"]);
  });
});

describe("ADR-0222: uploads keep only what the test needs, encrypted", () => {
  it("refuses a malformed file without quoting a cell", async () => {
    const missing = await upload({ name: "m", csv: fairCsv(), labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["region"] });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe("dataset_missing_columns");

    const notBinary = await upload({ name: "nb", csv: `g,y,p\n${SENSITIVE},1,1\n${SENSITIVE},0,2\n`, labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["g"] });
    expect(notBinary.statusCode).toBe(422);
    expect(notBinary.json().error).toBe("dataset_not_binary");
    expect(notBinary.body).not.toContain(SENSITIVE);

    const badQuote = await upload({ name: "q", csv: `g,y,p\n"${SENSITIVE},1,1\n`, labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["g"] });
    expect(badQuote.statusCode).toBe(422);
    expect(badQuote.json().error).toBe("dataset_unreadable");
    expect(badQuote.body).not.toContain(SENSITIVE);

    const noFavourable = await upload({ name: "nf", csv: "g,y,p\na,0,0\nb,0,0\n", labelColumn: "y", predictionColumn: "p", favourableLabel: "yes", protectedAttributes: ["g"] });
    expect(noFavourable.json().error).toBe("dataset_no_favourable_label");
  });

  it("stores the kept columns encrypted, drops the rest, returns no rows, and audits names and counts only", async () => {
    const res = await upload({
      name: `Credit Q3 ${RUN}`,
      csv: goldenCsv(),
      labelColumn: "outcome",
      predictionColumn: "predicted",
      favourableLabel: "1",
      protectedAttributes: ["sex", "age_band"],
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().dataset;
    expect(d).toMatchObject({ rowCount: 240, rowsStored: true, protectedAttributes: ["sex", "age_band"] });
    expect(d.rowsCiphertext).toBeUndefined();
    expect(res.body).not.toContain("A-1000");

    const [row] = await db.select().from(fairnessDatasets).where(eq(fairnessDatasets.id, d.id));
    expect(row!.rowsCiphertext).not.toContain("female");
    const kept = decodeRows(decryptSecret(DATA_KEY, row!.rowsCiphertext!));
    expect(Object.keys(kept.attributes).sort()).toEqual(["age_band", "sex"]);
    expect(decryptSecret(DATA_KEY, row!.rowsCiphertext!)).not.toContain("A-1000");
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(29 * 86_400_000);

    const [audit] = (await audits(FAIRNESS_RULE_IDS.uploaded)).filter((a) => a.objectId === d.id);
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.detail)).not.toMatch(/female|A-1000/);
    expect((audit!.detail as { groupCounts: Record<string, number> }).groupCounts).toEqual({ sex: 2, age_band: 3 });

    const list = await app.inject({ method: "GET", url: "/v1/mrm/fairness", headers: AUTH });
    expect(list.body).not.toContain("rowsCiphertext");
  });
});

describe("ADR-0222: a run measures, and a failing result holds the card", () => {
  let goldenId: string;
  let runId: string;

  it("reproduces fairlearn's values through the API, fails under the strict defaults, and is audited", async () => {
    goldenId = datasetIds.at(-1)!;
    const res = await runTest({ datasetId: goldenId, cardId });
    expect(res.statusCode).toBe(201);
    const run = res.json().run;
    runId = run.id;
    expect(run.outcome).toBe("fail");
    expect(run.blocks).toBe(true);
    for (const attr of run.result.attributes as Array<{ attribute: string; metrics: Record<string, { value: number }> }>) {
      for (const [m, v] of Object.entries(golden.expected[attr.attribute]!)) {
        expect(attr.metrics[m]!.value, `${attr.attribute} ${m}`).toBeCloseTo(v, 12);
      }
    }
    expect(res.json().note).toMatch(/does not run the model/);
    const [audit] = (await audits(FAIRNESS_RULE_IDS.run)).filter((a) => (a.detail as { fairnessRunId: string }).fairnessRunId === runId);
    expect(audit).toMatchObject({ objectType: "model_card", objectId: cardId, effect: "deny" });

    const detail = await app.inject({ method: "GET", url: `/v1/mrm/fairness/runs/${runId}`, headers: AUTH });
    expect(detail.json().run.id).toBe(runId);
    const byCard = await app.inject({ method: "GET", url: `/v1/mrm/fairness?cardId=${cardId}`, headers: AUTH });
    expect(byCard.json().runs.map((r: { id: string }) => r.id)).toEqual([runId]);
  });

  it("holds the card's sign-off request, audited", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/sign-off`,
      headers: AUTH,
      payload: { approverUserId: adminId, validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "fairness_test_failed", fairnessRunId: runId, outcome: "fail" });
    expect((await audits(FAIRNESS_RULE_IDS.signOffHeld)).some((a) => a.objectId === cardId)).toBe(true);
  });

  it("holds dispatch under an approved card on the model-risk 409 path, but not an evaluation of the agent", async () => {
    await db.update(orgSettings).set({ mrmEnforced: true, mrmStalenessRecertEnabled: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await db.insert(modelCardApprovals).values({
      cardId,
      status: "approved",
      approverUserId: adminId,
      decidedBy: adminId,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 30 * 86_400_000),
    });
    const ctx = { userId: NO_IDENTITY, agentId, agentName: `fair-agent-${RUN}`, model: null, customProviderId: null };
    const held = await mrmDispatchGate(db, ctx);
    expect(held).toMatchObject({ status: 409, error: "mrm_approval_required" });
    expect(held!.detail).toMatch(/fairness test/);
    expect((await audits(FAIRNESS_RULE_IDS.dispatchHeld)).some((a) => a.objectId === cardId)).toBe(true);
    expect(await mrmDispatchGate(db, { ...ctx, evaluation: true })).toBeNull();

    // blocking off (a relaxation, with the step-up): the run is recorded but holds nothing
    expect((await setFairness({ blockOnFail: false }, adminKey)).statusCode).toBe(403);
    expect((await setFairness({ blockOnFail: false })).statusCode).toBe(200);
    expect(await mrmDispatchGate(db, ctx)).toBeNull();
    expect((await setFairness({ blockOnFail: true }, adminKey)).statusCode).toBe(200);
    expect(await mrmDispatchGate(db, ctx)).not.toBeNull();

    // a passing latest run lifts the hold
    const fair = await upload({ name: `Fair ${RUN}`, csv: fairCsv(), labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["group"] });
    expect(fair.statusCode).toBe(201);
    const pass = await runTest({ datasetId: fair.json().dataset.id, cardId });
    expect(pass.json().run.outcome).toBe("pass");
    expect(pass.json().run.relaxed).toEqual({});
    expect(await mrmDispatchGate(db, ctx)).toBeNull();
  });

  it("a run looser than the strict defaults needs a step-up, and records what was relaxed", async () => {
    const fairId = datasetIds.at(-1)!;
    const strict = FAIRNESS_DEFAULT_THRESHOLDS.map((t) => ({ ...t }));
    const lenientCases: Array<{ body: Record<string, unknown>; key: string }> = [
      // a metric left out
      { body: { thresholds: strict.slice(1) }, key: "fairnessRun.demographic_parity_difference" },
      // a max limit raised, and a min limit lowered
      { body: { thresholds: strict.map((t) => (t.metric === "equal_opportunity_difference" ? { ...t, limit: 0.5 } : t)) }, key: "fairnessRun.equal_opportunity_difference" },
      { body: { thresholds: strict.map((t) => (t.metric === "disparate_impact_ratio" ? { ...t, limit: 0.5 } : t)) }, key: "fairnessRun.disparate_impact_ratio" },
      // flag where the default is fail
      { body: { thresholds: strict.map((t) => (t.metric === "equalized_odds_difference" ? { ...t, action: "flag" } : t)) }, key: "fairnessRun.equalized_odds_difference" },
      // a minimum group size above 30 leaves small groups out
      { body: { minGroupSize: 31 }, key: "fairnessRun.minGroupSize" },
    ];
    const before = (await db.select({ id: fairnessRuns.id }).from(fairnessRuns).where(eq(fairnessRuns.cardId, cardId))).length;
    for (const c of lenientCases) {
      const res = await runTest({ datasetId: fairId, cardId, ...c.body }, adminKey);
      expect(res.statusCode, c.key).toBe(403);
      expect(res.json().error).toBe("step_up_required");
      expect(res.json().actionKind).toBe("settings_relax");
    }
    // nothing was recorded, so nothing could lift a hold
    expect((await db.select({ id: fairnessRuns.id }).from(fairnessRuns).where(eq(fairnessRuns.cardId, cardId))).length).toBe(before);
    // the strict defaults, or tighter thresholds, need no step-up
    expect((await runTest({ datasetId: fairId, cardId }, adminKey)).statusCode).toBe(201);
    const tighter = strict.map((t) => ({ ...t, limit: t.metric === "disparate_impact_ratio" ? 0.9 : 0.05 }));
    expect((await runTest({ datasetId: fairId, cardId, thresholds: tighter, minGroupSize: 30 }, adminKey)).statusCode).toBe(201);
    // below 30 is a hard privacy floor: refused even with a step-up (the bootstrap token can give one), nothing recorded
    for (const minGroupSize of [1, 10, 29]) {
      const refused = await runTest({ datasetId: fairId, cardId, minGroupSize });
      expect(refused.statusCode, String(minGroupSize)).toBe(400);
    }
    expect((await db.select({ id: fairnessRuns.id }).from(fairnessRuns).where(eq(fairnessRuns.cardId, cardId))).length).toBe(before + 2);
    // with the step-up the lenient run is recorded, and the run and its audit row say what was relaxed
    const stepped = await runTest({ datasetId: fairId, cardId, minGroupSize: 40 });
    expect(stepped.statusCode).toBe(201);
    expect(stepped.json().run.relaxed).toEqual({ "fairnessRun.minGroupSize": 40 });
    const [audit] = (await audits(FAIRNESS_RULE_IDS.run)).filter((a) => (a.detail as { fairnessRunId: string }).fairnessRunId === stepped.json().run.id);
    expect((audit!.detail as { relaxed: Record<string, unknown> }).relaxed).toEqual({ "fairnessRun.minGroupSize": 40 });
    expect(audit!.reason).toMatch(/looser than the strict defaults/);
  });

  it("a run made on another model version is stale and holds the card until a run on the current version", async () => {
    const ctx = { userId: NO_IDENTITY, agentId, agentName: `fair-agent-${RUN}`, model: null, customProviderId: null };
    expect(await mrmDispatchGate(db, ctx)).toBeNull(); // the latest run passed on the current (unpinned) version
    await db.update(modelCards).set({ pinnedModelVersion: `mock-model-${RUN}-v2` }).where(eq(modelCards.id, cardId));
    const held = await mrmDispatchGate(db, ctx);
    expect(held).toMatchObject({ status: 409, error: "mrm_approval_required" });
    expect(held!.detail).toMatch(/different model version/);
    const signOff = await app.inject({
      method: "POST",
      url: `/v1/mrm/cards/${cardId}/sign-off`,
      headers: AUTH,
      payload: { approverUserId: adminId, validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    });
    expect(signOff.statusCode).toBe(409);
    expect(signOff.json()).toMatchObject({ error: "fairness_test_failed", outcome: "pass", stale: true });
    // a run on the current version snapshots it and lifts the hold
    const fresh = await runTest({ datasetId: datasetIds.at(-1)!, cardId });
    expect(fresh.json().run).toMatchObject({ outcome: "pass", cardModelVersion: `mock-model-${RUN}-v2` });
    expect(await mrmDispatchGate(db, ctx)).toBeNull();
  });

  it("a one-person group cannot be recovered by subtraction: the run is the same whatever that person's outcome", async () => {
    // the security review's example: sex M/F all included; ethnicity A large, B one person
    const csvFor = (bLabel: number, bPrediction: number) => {
      const lines = ["sex,ethnicity,y,p"];
      for (let i = 0; i < 200; i++) lines.push(`${i % 2 === 0 ? "M" : "F"},A,${i % 3 === 0 ? 1 : 0},${i % 4 === 0 ? 1 : 0}`);
      lines.push(`F,B,${bLabel},${bPrediction}`);
      return lines.join("\n");
    };
    const results: string[] = [];
    for (const [y, p] of [[0, 0], [1, 1], [0, 1], [1, 0]] as const) {
      const up = await upload({ name: `Subtraction ${y}${p} ${RUN}`, csv: csvFor(y, p), labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["sex", "ethnicity"] });
      expect(up.statusCode).toBe(201);
      const run = await runTest({ datasetId: up.json().dataset.id, cardId });
      expect(run.statusCode).toBe(201);
      const [stored] = await db.select().from(fairnessRuns).where(eq(fairnessRuns.id, run.json().run.id));
      expect(stored!.result).toEqual(run.json().run.result);
      results.push(JSON.stringify(run.json().run.result));
      const b = run.json().run.result.attributes.find((a: { attribute: string }) => a.attribute === "ethnicity").groups.find((g: { group: string }) => g.group === "B");
      expect(b).toEqual({ group: "B", n: null, labelPositives: null, predictedPositives: null, selectionRate: null, truePositiveRate: null, falsePositiveRate: null, included: false });
      expect(run.json().run.result.rowCount).toBe(200);
    }
    // nothing stored or returned depends on the suppressed person's outcome or prediction
    expect(new Set(results).size).toBe(1);
    // keep the fair dataset last for the tests below
    const fair = await upload({ name: `Fair again ${RUN}`, csv: fairCsv(), labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["group"] });
    expect(fair.statusCode).toBe(201);
    expect((await runTest({ datasetId: fair.json().dataset.id, cardId })).json().run.outcome).toBe("pass");
  });

  it("an inconclusive run holds too: too few rows per group is never a pass", async () => {
    const fairId = datasetIds.at(-1)!;
    const res = await runTest({ datasetId: fairId, cardId, minGroupSize: 1000 });
    expect(res.json().run.outcome).toBe("inconclusive");
    // suppressed groups are named only: no size, outcome counts or rates are stored or returned
    for (const g of res.json().run.result.attributes[0].groups) {
      expect(g).toMatchObject({ included: false, n: null, labelPositives: null, predictedPositives: null, selectionRate: null, truePositiveRate: null, falsePositiveRate: null });
    }
    expect(res.json().run.result.rowCount).toBe(0);
    const [stored] = await db.select().from(fairnessRuns).where(eq(fairnessRuns.id, res.json().run.id));
    expect(JSON.stringify(stored!.result)).not.toMatch(/"selectionRate":\d/);
    const ctx = { userId: NO_IDENTITY, agentId, agentName: `fair-agent-${RUN}`, model: null, customProviderId: null };
    expect(await mrmDispatchGate(db, ctx)).not.toBeNull();
  });
});

describe("ADR-0222: retention and delete", () => {
  it("the sweep deletes rows past retention, keeps the sha256 and the runs, and audits it; the dataset cannot be run again", async () => {
    const target = datasetIds[0]!; // the golden dataset, cited by a run
    await db.update(fairnessDatasets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(fairnessDatasets.id, target));
    const out = await runFairnessRetentionSweep(db);
    expect(out.ids).toContain(target);
    const [row] = await db.select().from(fairnessDatasets).where(eq(fairnessDatasets.id, target));
    expect(row).toMatchObject({ rowsCiphertext: null, purgeReason: "retention" });
    expect(row!.csvSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.select().from(fairnessRuns).where(eq(fairnessRuns.datasetId, target))).length).toBeGreaterThan(0);
    expect((await audits(FAIRNESS_RULE_IDS.purged)).length).toBeGreaterThan(0);
    const again = await runTest({ datasetId: target, cardId });
    expect(again.statusCode).toBe(410);
    expect((await runFairnessRetentionSweep(db)).ids).not.toContain(target);
  });

  it("a run applies the current, shortened retention, not only the stored expiry", async () => {
    const target = datasetIds.at(-1)!;
    const [row] = await db.select().from(fairnessDatasets).where(eq(fairnessDatasets.id, target));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await db.update(fairnessDatasets).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(fairnessDatasets.id, target));
    expect((await setFairness({ datasetRetentionDays: 1 }, adminKey)).statusCode).toBe(200);
    const gone = await runTest({ datasetId: target, cardId });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toBe("fairness_dataset_gone");
    expect((await setFairness({ datasetRetentionDays: 30 })).statusCode).toBe(200);
    await db.update(fairnessDatasets).set({ createdAt: row!.createdAt }).where(eq(fairnessDatasets.id, target));
    expect((await runTest({ datasetId: target, cardId })).statusCode).toBe(201);
  });

  it("delete removes the rows once, audited; a second delete and an unknown id are refused", async () => {
    const target = datasetIds.at(-1)!;
    const del = await app.inject({ method: "DELETE", url: `/v1/mrm/fairness/datasets/${target}`, headers: AUTH });
    expect(del.statusCode).toBe(200);
    expect(del.json().dataset).toMatchObject({ rowsStored: false, purgeReason: "deleted" });
    expect((await audits(FAIRNESS_RULE_IDS.deleted)).some((a) => a.objectId === target)).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/v1/mrm/fairness/datasets/${target}`, headers: AUTH })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/v1/mrm/fairness/datasets/${randomUUID()}`, headers: AUTH })).statusCode).toBe(404);
  });

  it("uploads are rate-limited per person", async () => {
    let last = 0;
    for (let i = 0; i <= FAIRNESS_WRITE_RATE_PER_MINUTE; i++) {
      last = (await upload({ name: "r", csv: "g,y,p\n", labelColumn: "y", predictionColumn: "p", favourableLabel: "1", protectedAttributes: ["g"] }, adminKey)).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("ADR-0222: the fairness rate limit fails closed", () => {
  it("a counter that errors or gives no verdict refuses with 503; a count over the limit is 429", async () => {
    const erroring = { incr: (_k: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void) => cb(new Error("counter down")) };
    expect(await fairnessRateCheck(erroring, "k", "run")).toMatchObject({ ok: false, status: 503, body: { error: "rate_limit_unavailable" } });
    const silent = { incr: (_k: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void) => cb(null) };
    expect(await fairnessRateCheck(silent, "k", "upload")).toMatchObject({ ok: false, status: 503 });
    const throwing = {
      incr: () => {
        throw new Error("boom");
      },
    };
    expect(await fairnessRateCheck(throwing, "k", "run")).toMatchObject({ ok: false, status: 503 });
    const over = { incr: (_k: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void) => cb(null, { current: 21, ttl: 5000 }) };
    expect(await fairnessRateCheck(over, "k", "run")).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 5 });
    const under = { incr: (_k: string, cb: (e: Error | null, r?: { current: number; ttl: number }) => void) => cb(null, { current: 1, ttl: 5000 }) };
    expect(await fairnessRateCheck(under, "k", "run")).toEqual({ ok: true });
  });
});
