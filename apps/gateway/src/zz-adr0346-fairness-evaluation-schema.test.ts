/**
 * ADR-0346 slice 1 — the fairness-evaluation schema, proved against the database.
 *
 *  1. Existing rows keep their meaning: an ADR-0222 dataset is `supplied_predictions`, an ADR-0222 run is `supplied`.
 *  2. The kind and mode CHECKs tie each shape to its columns (a model-input dataset has no prediction column and a
 *     PII snapshot; a model run names its evaluation and engine run).
 *  3. A definition's strict defaults, and the CHECKs that refuse a looser one than the schema allows (group size below
 *     the hard floor of 30, an unparseable cap above 5%, equal outputs).
 *  4. Signed evidence is checked (sha256, version tag, run id, signature shape) and append-only (UPDATE, DELETE and
 *     TRUNCATE refused).
 *  5. A breach acceptance lasts at most 90 days and only an accepted review carries an end date.
 *  6. model_card_evidence's new kind, the org settings' strict defaults and RLS on every new table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  approvals,
  createDb,
  eq,
  fairnessBreachReviews,
  fairnessDatasetInputColumns,
  fairnessDatasets,
  fairnessEvaluations,
  fairnessRunEvidence,
  fairnessRuns,
  modelCardEvidence,
  modelCards,
  orgSettings,
  ORG_SETTINGS_ID,
  receiptSigningKeys,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  FAIRNESS_BREACH_REVIEW_MACHINE,
  FAIRNESS_DEFAULT_THRESHOLDS,
  FAIRNESS_EVALUATION_DEFAULT_SETTINGS,
  FAIRNESS_EVALUATION_MACHINE,
  FAIRNESS_RUN_EVIDENCE_VERSION,
} from "@regulait/shared";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Date.now().toString(36);
const SIG = "A".repeat(86);
const KEY_ID = `adr0346-test-${RUN}`;

let db: Db;
let cardId: string;
let userId: string;

/** the message Postgres gave, wherever drizzle put it */
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  throw new Error("expected the database to refuse the statement");
}

async function suppliedDataset() {
  const [d] = await db
    .insert(fairnessDatasets)
    .values({
      name: `supplied-${randomUUID()}`,
      labelColumn: "y",
      predictionColumn: "p",
      favourableLabel: "1",
      protectedAttributes: ["g"],
      rowCount: 80,
      csvBytes: 100,
      csvSha256: "0".repeat(64),
      rowsCiphertext: "x",
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  return d!;
}

async function modelInputDataset() {
  const [d] = await db
    .insert(fairnessDatasets)
    .values({
      name: `inputs-${randomUUID()}`,
      kind: "model_inputs",
      labelColumn: "y",
      favourableLabel: "1",
      protectedAttributes: ["g"],
      rowCount: 80,
      csvBytes: 100,
      csvSha256: "0".repeat(64),
      rowsCiphertext: "x",
      expiresAt: new Date(Date.now() + 86_400_000),
      piiMode: "redact",
      piiFindings: 0,
    })
    .returning();
  return d!;
}

async function suppliedRun(datasetId: string) {
  const [r] = await db
    .insert(fairnessRuns)
    .values({ cardId, datasetId, datasetSha256: "0".repeat(64), metricsVersion: "fairness-metrics/1", thresholds: [], minGroupSize: 30, result: {}, outcome: "fail" })
    .returning();
  return r!;
}

function evidenceBody(runId: string) {
  const body = JSON.stringify({ v: FAIRNESS_RUN_EVIDENCE_VERSION, runId, outcome: "fail" });
  return { runId, body, bodySha256: createHash("sha256").update(body, "utf8").digest("hex"), signature: SIG, keyId: KEY_ID };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [a] = await db.insert(agents).values({ name: `fe-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
  const [c] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: `fairness evaluation ${RUN}` }).returning({ id: modelCards.id });
  cardId = c!.id;
  const [u] = await db.insert(users).values({ email: `fe-${RUN}@example.test`, displayName: "fe" }).returning({ id: users.id });
  userId = u!.id;
  await db.insert(receiptSigningKeys).values({ keyId: KEY_ID, publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } }).onConflictDoNothing();
});

afterAll(async () => {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
});

describe("ADR-0346 schema", () => {
  it("1. existing ADR-0222 shapes default to supplied", async () => {
    const d = await suppliedDataset();
    expect(d.kind).toBe("supplied_predictions");
    const r = await suppliedRun(d.id);
    expect(r.mode).toBe("supplied");
    expect(r.evaluationId).toBeNull();
  });

  it("2. the kind and mode CHECKs tie each shape to its columns", async () => {
    // a model-input dataset with a prediction column, or without its PII snapshot, is refused
    expect(
      await refused(
        db.insert(fairnessDatasets).values({
          name: `bad-${RUN}`,
          kind: "model_inputs",
          labelColumn: "y",
          predictionColumn: "p",
          favourableLabel: "1",
          protectedAttributes: ["g"],
          rowCount: 1,
          csvBytes: 1,
          csvSha256: "0".repeat(64),
          rowsCiphertext: "x",
          expiresAt: new Date(Date.now() + 1000),
          piiMode: "block",
          piiFindings: 0,
        }),
      ),
    ).toMatch(/fairness_datasets_kind_shape_check/);
    expect(
      await refused(
        db.insert(fairnessDatasets).values({
          name: `bad2-${RUN}`,
          kind: "model_inputs",
          labelColumn: "y",
          favourableLabel: "1",
          protectedAttributes: ["g"],
          rowCount: 1,
          csvBytes: 1,
          csvSha256: "0".repeat(64),
          rowsCiphertext: "x",
          expiresAt: new Date(Date.now() + 1000),
        }),
      ),
    ).toMatch(/fairness_datasets_kind_shape_check/);
    const mi = await modelInputDataset();
    await db.insert(fairnessDatasetInputColumns).values([
      { datasetId: mi.id, columnName: "summary", position: 0 },
      { datasetId: mi.id, columnName: "history", position: 1 },
    ]);
    expect(await refused(db.insert(fairnessDatasetInputColumns).values({ datasetId: mi.id, columnName: "x", position: 8 }))).toMatch(
      /fairness_dataset_input_columns_position_check/,
    );
    // a model run must name its evaluation and engine run
    expect(
      await refused(
        db.insert(fairnessRuns).values({
          cardId,
          datasetId: mi.id,
          datasetSha256: "0".repeat(64),
          metricsVersion: "fairness-metrics/1",
          thresholds: [],
          minGroupSize: 30,
          result: {},
          outcome: "pass",
          mode: "model",
          unparseableCount: 0,
        }),
      ),
    ).toMatch(/fairness_runs_mode_shape_check/);
  });

  it("3. a definition's strict defaults and its hard limits", async () => {
    const mi = await modelInputDataset();
    const ok = { cardId, datasetId: mi.id, promptTemplate: "{{summary}}", favourableOutput: "approve", unfavourableOutput: "decline" };
    const [e] = await db.insert(fairnessEvaluations).values({ ...ok, name: `ok-${RUN}` }).returning();
    expect(e!.minGroupSize).toBe(30);
    expect(e!.maxUnparseableRate).toBe(0);
    expect(e!.status).toBe("active");
    expect(e!.relaxed).toEqual({});
    expect(await refused(db.insert(fairnessEvaluations).values({ ...ok, name: `g-${RUN}`, minGroupSize: 29 }))).toMatch(/min_group_size_check/);
    expect(await refused(db.insert(fairnessEvaluations).values({ ...ok, name: `u-${RUN}`, maxUnparseableRate: 0.06 }))).toMatch(/unparseable_check/);
    expect(await refused(db.insert(fairnessEvaluations).values({ ...ok, name: `o-${RUN}`, unfavourableOutput: " APPROVE " }))).toMatch(/outputs_check/);
    expect(await refused(db.insert(fairnessEvaluations).values({ ...ok, name: `ok-${RUN}` }))).toMatch(/card_name_uq/);
    // the strict thresholds fit the threshold table; a limit outside 0..1 does not
    await db.execute(sql`INSERT INTO fairness_evaluation_thresholds (evaluation_id, metric, "limit", action)
      SELECT ${e!.id}, m.metric, m.lim, m.act FROM jsonb_to_recordset(${JSON.stringify(
        FAIRNESS_DEFAULT_THRESHOLDS.map((t) => ({ metric: t.metric, lim: t.limit, act: t.action })),
      )}::jsonb) AS m(metric text, lim double precision, act text)`);
    expect(
      await refused(db.execute(sql`INSERT INTO fairness_evaluation_thresholds VALUES (${randomUUID()}, 'disparate_impact_ratio', 1.5, 'fail')`)),
    ).toMatch(/limit_check|foreign key/);
  });

  it("4. signed evidence is checked and append-only", async () => {
    const run = await suppliedRun((await suppliedDataset()).id);
    const good = evidenceBody(run.id);
    expect(await refused(db.insert(fairnessRunEvidence).values({ ...good, bodySha256: "f".repeat(64) }))).toMatch(/body_sha256_check/);
    expect(await refused(db.insert(fairnessRunEvidence).values({ ...good, signature: "short" }))).toMatch(/signature_check/);
    const other = evidenceBody(randomUUID());
    expect(await refused(db.insert(fairnessRunEvidence).values({ ...other, runId: run.id }))).toMatch(/body_check/);
    await db.insert(fairnessRunEvidence).values(good);
    expect(await refused(db.update(fairnessRunEvidence).set({ signature: "B".repeat(86) }).where(eq(fairnessRunEvidence.runId, run.id)))).toMatch(
      /append-only|refuse|not allowed|immutable/i,
    );
    expect(await refused(db.delete(fairnessRunEvidence).where(eq(fairnessRunEvidence.runId, run.id)))).toMatch(/append-only|refuse|not allowed|immutable/i);
    expect(await refused(db.execute(sql`TRUNCATE fairness_run_evidence`))).toMatch(/truncate/i);
    // the run it signs cannot be deleted from under it
    expect(await refused(db.delete(fairnessRuns).where(eq(fairnessRuns.id, run.id)))).toMatch(/foreign key/);
  });

  it("5. a breach acceptance lasts at most 90 days", async () => {
    const run = await suppliedRun((await suppliedDataset()).id);
    const [ap] = await db
      .insert(approvals)
      .values({ userId, approverUserId: userId, objectType: "model_card", stageId: `__fairness_breach__:${run.id}`, status: "pending" })
      .returning({ id: approvals.id });
    const [rv] = await db.insert(fairnessBreachReviews).values({ runId: run.id, approvalId: ap!.id }).returning();
    expect(rv!.status).toBe("pending");
    const now = new Date();
    expect(
      await refused(
        db
          .update(fairnessBreachReviews)
          .set({ status: "accepted", decidedAt: now, acceptedUntil: new Date(now.getTime() + 91 * 86_400_000) })
          .where(eq(fairnessBreachReviews.id, rv!.id)),
      ),
    ).toMatch(/decision_check/);
    expect(
      await refused(db.update(fairnessBreachReviews).set({ status: "rejected", decidedAt: now, acceptedUntil: new Date(now.getTime() + 1000) }).where(eq(fairnessBreachReviews.id, rv!.id))),
    ).toMatch(/decision_check/);
    await db
      .update(fairnessBreachReviews)
      .set({ status: "accepted", decidedAt: now, acceptedUntil: new Date(now.getTime() + 90 * 86_400_000) })
      .where(eq(fairnessBreachReviews.id, rv!.id));
    // a later passing run supersedes it, keeping the acceptance's end date as history
    await db.update(fairnessBreachReviews).set({ status: "superseded", decidedAt: new Date() }).where(eq(fairnessBreachReviews.id, rv!.id));
    expect(await refused(db.insert(fairnessBreachReviews).values({ runId: run.id, approvalId: ap!.id }))).toMatch(/run_uq|approval_uq/);
  });

  it("6. evidence kind, settings defaults and RLS", async () => {
    const run = await suppliedRun((await suppliedDataset()).id);
    await db.insert(modelCardEvidence).values({ cardId, kind: "fairness_run", fairnessRunId: run.id });
    expect(await refused(db.insert(modelCardEvidence).values({ cardId, kind: "fairness_run", fairnessRunId: run.id }))).toMatch(/fairness_run_uq/);
    expect(await refused(db.insert(modelCardEvidence).values({ cardId, kind: "fairness_run" }))).toMatch(/shape_check/);
    expect(await refused(db.insert(modelCardEvidence).values({ cardId, kind: "external", externalRef: "doc", fairnessRunId: run.id }))).toMatch(/shape_check/);

    const [s] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    if (s) {
      expect(s.fairnessPromotionGate).toBe(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessPromotionGate);
      expect(s.fairnessRunMaxAgeDays).toBe(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessRunMaxAgeDays);
    }
    const col = await db.execute<{ column_default: string | null }>(
      sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'org_settings' AND column_name = 'fairness_promotion_gate'`,
    );
    expect(col.rows[0]?.column_default).toBe("false");
    // owner 2026-11-21: the high-risk tiers force the gate by default; the column defaults are the shared defaults
    const tiers = await db.execute<{ column_name: string; column_default: string | null }>(
      sql`SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'org_settings' AND column_name LIKE 'fairness_gate_tier_%' ORDER BY column_name`,
    );
    expect(tiers.rows).toEqual([
      { column_name: "fairness_gate_tier_high", column_default: String(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessGateTierHigh) },
      { column_name: "fairness_gate_tier_limited", column_default: String(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessGateTierLimited) },
      { column_name: "fairness_gate_tier_minimal", column_default: String(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessGateTierMinimal) },
      { column_name: "fairness_gate_tier_prohibited", column_default: String(FAIRNESS_EVALUATION_DEFAULT_SETTINGS.fairnessGateTierProhibited) },
    ]);

    const rls = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('fairness_dataset_input_columns','fairness_evaluations','fairness_evaluation_attributes',
                        'fairness_evaluation_thresholds','fairness_run_evidence','fairness_breach_reviews')`);
    expect(rls.rows).toHaveLength(6);
    for (const r of rls.rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it("7. each ADR-0348 machine's states equal its column's CHECK", async () => {
    for (const [constraint, machine] of [
      ["fairness_breach_reviews_status_check", FAIRNESS_BREACH_REVIEW_MACHINE],
      ["fairness_evaluations_status_check", FAIRNESS_EVALUATION_MACHINE],
    ] as const) {
      const r = await db.execute<{ def: string }>(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${constraint}`);
      const def = r.rows[0]?.def ?? "";
      const values = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
      expect(values, constraint).toEqual([...machine.def.states].sort());
    }
  });
});
