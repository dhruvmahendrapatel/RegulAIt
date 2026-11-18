/**
 * ADR-0346 slice 2 — FAIRNESS EVALUATION THROUGH THE GATEWAY, the gateway's half of a model run.
 *
 *   1. `parseModelInputCsv` / `checkModelInputPii` — a model-input dataset upload: the label, the protected attributes
 *      and one to eight input columns are kept (nothing else), each input cell is checked under the cascade PII mode
 *      (block refuses, redact stores the redacted text, warn/log store it and count), and the rows are stored
 *      encrypted in ADR-0222's `fairness_datasets.rows_ciphertext` (encoding v2).
 *   2. `fairnessInputTx` — when a fairlearn run's task starts, the gateway (never the runner) builds the task's one
 *      data file from the evaluation and its dataset, and pins its sha256 (`fairness_engine_inputs`).
 *   3. `recordFairnessRunEndTx` — at the run's end, in its transaction: the task's result is read, checked against
 *      the pinned input, the metrics are recomputed with `computeFairness` on the task's predictions and compared with
 *      fairlearn's; the run lands as an ordinary `fairness_runs` row (mode `model`), so ADR-0222's hold, staleness
 *      and views read it unchanged. Anything short of an agreeing, complete result is `inconclusive` (it holds).
 *   4. `signFairnessRunEvidenceTx` — every run (supplied or model) gets one signed, append-only evidence row and is
 *      cited on its card (`model_card_evidence` kind `fairness_run`).
 *
 * This module imports nothing from engine-runs.ts or engine-tasks.ts (both import it); the data key reaches it through
 * `setFairnessEvaluationRuntime`, which `setEngineRuntime` calls. No reply text and no dataset cell is ever logged,
 * audited or returned.
 */
import { createHash, sign } from "node:crypto";
import { parse as parseCsv, CsvError } from "csv-parse/sync";
import {
  and,
  asc,
  auditLog,
  eq,
  fairnessDatasetInputColumns,
  fairnessDatasets,
  fairnessEngineInputs,
  fairnessEvaluationAttributes,
  fairnessEvaluations,
  fairnessEvaluationThresholds,
  fairnessRunEvidence,
  fairnessRuns,
  modelCardEvidence,
  modelCards,
  orgSettings,
  ORG_SETTINGS_ID,
  receiptSigningKeys,
  sql,
  type Db,
  type EngineRunRow,
  type FairnessRunRow,
} from "@regulait/db";
import {
  canonicalJson,
  computeFairness,
  detectPII,
  FAIRLEARN_ENGINE_VERSION,
  FAIRLEARN_INPUT_FILE,
  FAIRLEARN_INPUT_VERSION,
  FAIRLEARN_LIMITS,
  FAIRLEARN_RESULT_VERSION,
  fairlearnAgrees,
  fairlearnConfigProblem,
  fairlearnEvaluationIdOf,
  fairlearnInputSchema,
  fairlearnResultSchema,
  FAIRNESS_EVALUATION_LIMITS,
  FAIRNESS_LIMITS,
  FAIRNESS_METRICS,
  FAIRNESS_RUN_EVIDENCE_VERSION,
  fillPromptTemplate,
  parsePromptTemplate,
  redactPII,
  unparseableOverCap,
  type CreateModelInputDataset,
  type FairlearnInput,
  type FairnessMetric,
  type FairnessResult,
  type FairnessRows,
  type FairnessThreshold,
  type InternationalPiiCategory,
} from "@regulait/shared";
import { decryptSecret } from "./secrets.js";
import { loadReceiptSigningKey, ReceiptKeyError, registerReceiptSigningKey, sameReceiptPublicKey } from "./decision-receipts.js";

type Exec = Pick<Db, "select" | "insert" | "update" | "execute">;

let dataKey: string | undefined;
/** set by `setEngineRuntime` (engine-runs.ts): the data key the datasets are encrypted under */
export function setFairnessEvaluationRuntime(opts: { dataKey?: string | undefined }): void {
  dataKey = opts.dataKey;
}

const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const FAIRNESS_EVALUATION_RULE_IDS = {
  inputPlaced: "fairness-model-input-placed",
  modelRun: "fairness-model-run",
  evidenceSigned: "fairness-evidence-signed",
  evidenceUnsigned: "fairness-evidence-unsigned",
} as const;

// ---------------------------------------------------------------------------
// 1. The model-input dataset
// ---------------------------------------------------------------------------

/** a model-input dataset's rows, as stored (encoding v2 of `fairness_datasets.rows_ciphertext`) */
export interface ModelInputRows {
  labels: number[];
  attributes: Record<string, string[]>;
  /** input column -> each row's cell (after the PII check: redacted where the mode is `redact`) */
  inputs: Record<string, string[]>;
}

interface StoredModelInputRows {
  v: 2;
  labels: string;
  attributes: Record<string, { groups: string[]; codes: number[] }>;
  inputs: Record<string, string[]>;
}

function dictionary(col: readonly string[]): { groups: string[]; codes: number[] } {
  const groups: string[] = [];
  const index = new Map<string, number>();
  const codes = col.map((g) => {
    let c = index.get(g);
    if (c === undefined) {
      c = groups.length;
      groups.push(g);
      index.set(g, c);
    }
    return c;
  });
  return { groups, codes };
}

export function encodeModelInputRows(rows: ModelInputRows): string {
  const attributes: StoredModelInputRows["attributes"] = {};
  for (const [a, col] of Object.entries(rows.attributes)) attributes[a] = dictionary(col);
  const stored: StoredModelInputRows = { v: 2, labels: rows.labels.join(""), attributes, inputs: rows.inputs };
  return JSON.stringify(stored);
}

export function decodeModelInputRows(json: string): ModelInputRows {
  const s = JSON.parse(json) as StoredModelInputRows;
  if (s.v !== 2) throw new Error("not a model-input dataset encoding");
  const attributes: Record<string, string[]> = {};
  for (const [a, { groups, codes }] of Object.entries(s.attributes)) attributes[a] = codes.map((c) => groups[c]!);
  return { labels: [...s.labels].map((c) => (c === "1" ? 1 : 0)), attributes, inputs: s.inputs };
}

export type ParsedModelInputs =
  | { ok: true; rows: ModelInputRows; rowCount: number; groups: Record<string, number> }
  | { ok: false; status: number; error: string; detail: string };

const refuse = (error: string, detail: string, status = 422): ParsedModelInputs => ({ ok: false, status, error, detail });

/**
 * Parse a model-input CSV and keep only the named columns. A refusal names a line and a column, never a cell (as
 * ADR-0222's parser), and never the CSV parser's own message.
 */
export function parseModelInputCsv(spec: Pick<CreateModelInputDataset, "csv" | "labelColumn" | "favourableLabel" | "protectedAttributes" | "inputColumns">): ParsedModelInputs {
  let records: string[][];
  try {
    records = parseCsv(spec.csv, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
      max_record_size: 64 * 1024,
      to: FAIRLEARN_LIMITS.maxRows + 2,
    }) as string[][];
  } catch (e) {
    const lines = e instanceof CsvError ? (e as unknown as { lines?: unknown }).lines : undefined;
    const at = typeof lines === "number" ? ` near line ${lines}` : "";
    const code = e instanceof CsvError ? e.code : "CSV_INVALID";
    return refuse("dataset_unreadable", `the file is not valid CSV${at} (${code})`);
  }
  const [header, ...data] = records;
  if (!header || data.length === 0) return refuse("dataset_empty", "the file needs a header row and at least one data row");
  if (data.length > FAIRLEARN_LIMITS.maxRows) {
    return refuse("dataset_too_many_rows", `a model-input dataset may hold at most ${FAIRLEARN_LIMITS.maxRows} rows (each row is one call to the model)`, 413);
  }
  if (new Set(header).size !== header.length) return refuse("dataset_duplicate_columns", "two columns in the header row have the same name");
  const col = (name: string) => header.indexOf(name);
  const missing = [spec.labelColumn, ...spec.protectedAttributes, ...spec.inputColumns].filter((c) => col(c) < 0);
  if (missing.length > 0) return refuse("dataset_missing_columns", `the header row has no column named ${missing.map((m) => `'${m}'`).join(", ")}`);
  const li = col(spec.labelColumn);
  const ai = spec.protectedAttributes.map((a) => [a, col(a)] as const);
  const ii = spec.inputColumns.map((c) => [c, col(c)] as const);
  const labelValues = new Set<string>();
  const labels: number[] = new Array(data.length);
  const attributes: Record<string, string[]> = {};
  const groupSets: Record<string, Set<string>> = {};
  for (const [a] of ai) {
    attributes[a] = new Array(data.length);
    groupSets[a] = new Set();
  }
  const inputs: Record<string, string[]> = {};
  for (const [c] of ii) inputs[c] = new Array(data.length);
  let sawFavourable = false;
  for (let r = 0; r < data.length; r++) {
    const row = data[r]!;
    const line = r + 2;
    const y = row[li] ?? "";
    if (y === "") return refuse("dataset_missing_value", `line ${line} has no value in the label column`);
    if (y.length > FAIRNESS_LIMITS.maxCellChars) return refuse("dataset_cell_too_long", `line ${line} has a label longer than ${FAIRNESS_LIMITS.maxCellChars} characters`);
    labelValues.add(y);
    if (labelValues.size > 2) return refuse("dataset_not_binary", `the label column holds more than two distinct values by line ${line}; fairness evaluation here covers binary outcomes`);
    labels[r] = y === spec.favourableLabel ? 1 : 0;
    if (labels[r] === 1) sawFavourable = true;
    for (const [a, i] of ai) {
      const g = row[i] ?? "";
      if (g === "") return refuse("dataset_missing_value", `line ${line} has no value in the protected attribute column '${a}'`);
      if (g.length > FAIRNESS_LIMITS.maxCellChars) return refuse("dataset_cell_too_long", `line ${line} has a value longer than ${FAIRNESS_LIMITS.maxCellChars} characters`);
      groupSets[a]!.add(g);
      if (groupSets[a]!.size > FAIRNESS_LIMITS.maxGroupsPerAttribute) {
        return refuse("dataset_too_many_groups", `the protected attribute column '${a}' has more than ${FAIRNESS_LIMITS.maxGroupsPerAttribute} distinct groups`);
      }
      attributes[a]![r] = g;
    }
    for (const [c, i] of ii) {
      const v = row[i] ?? "";
      if (v === "") return refuse("dataset_missing_value", `line ${line} has no value in the input column '${c}'`);
      if (v.length > FAIRNESS_EVALUATION_LIMITS.maxInputCellChars) {
        return refuse("dataset_cell_too_long", `line ${line} has an input longer than ${FAIRNESS_EVALUATION_LIMITS.maxInputCellChars} characters in '${c}'`);
      }
      inputs[c]![r] = v;
    }
  }
  if (!sawFavourable) return refuse("dataset_no_favourable_label", "no row's label equals the favourable label; check the value that means the favourable outcome");
  const groups: Record<string, number> = {};
  for (const [a] of ai) groups[a] = groupSets[a]!.size;
  return { ok: true, rows: { labels, attributes, inputs }, rowCount: data.length, groups };
}

export type PiiMode = "block" | "redact" | "warn" | "log";
const PII_STRICTNESS: readonly PiiMode[] = ["log", "warn", "redact", "block"];

/** the stricter of two modes (null = no enforcement, read as `log`: the findings are still counted) */
export function strictestPiiMode(...modes: ReadonlyArray<PiiMode | null | undefined>): PiiMode {
  let best = 0;
  for (const m of modes) if (m) best = Math.max(best, PII_STRICTNESS.indexOf(m));
  return PII_STRICTNESS[best]!;
}

export type PiiCheck =
  | { ok: true; rows: ModelInputRows; findings: number; categories: Record<string, number> }
  | { ok: false; status: number; error: string; detail: string };

/**
 * ADR-0346 decision 3: check every input cell under the mode. `block` refuses the upload at the first cell with a
 * finding (naming the line and column, never the value); `redact` replaces each finding with its placeholder;
 * `warn`/`log` keep the text and count. Only counts per category leave this function.
 */
export function checkModelInputPii(rows: ModelInputRows, mode: PiiMode, international: readonly InternationalPiiCategory[]): PiiCheck {
  const categories: Record<string, number> = {};
  let findings = 0;
  const out: Record<string, string[]> = {};
  for (const [c, cells] of Object.entries(rows.inputs)) {
    const kept: string[] = new Array(cells.length);
    for (let r = 0; r < cells.length; r++) {
      const cell = cells[r]!;
      const hits = mode === "redact" ? redactPII(cell, international).hits : detectPII(cell, international);
      const n = hits.reduce((s, h) => s + h.count, 0);
      if (n > 0 && mode === "block") {
        return { ok: false, status: 422, error: "dataset_pii_blocked", detail: `line ${r + 2}, input column '${c}', holds personal data and the PII mode for this upload is block` };
      }
      for (const h of hits) categories[h.category] = (categories[h.category] ?? 0) + h.count;
      findings += n;
      kept[r] = mode === "redact" && n > 0 ? redactPII(cell, international).text : cell;
    }
    out[c] = kept;
  }
  return { ok: true, rows: { ...rows, inputs: out }, findings, categories };
}

// ---------------------------------------------------------------------------
// 2. The task's input file
// ---------------------------------------------------------------------------

export type FairnessInputOutcome =
  | { ok: true; file: string; bytes: Buffer; sha256: string; rowCount: number }
  | {
      ok: false;
      code:
        | "config_invalid"
        | "fairness_testing_off"
        | "evaluation_gone"
        | "evaluation_archived"
        | "card_target_mismatch"
        | "dataset_not_model_inputs"
        | "dataset_rows_gone"
        | "template_invalid"
        | "input_too_large"
        | "no_data_key";
    };

interface LoadedEvaluation {
  expired: boolean;
  evaluation: typeof fairnessEvaluations.$inferSelect;
  dataset: typeof fairnessDatasets.$inferSelect;
  card: typeof modelCards.$inferSelect;
  attributes: string[];
  inputColumns: string[];
  thresholds: FairnessThreshold[];
}

async function loadEvaluation(tx: Exec, evaluationId: string): Promise<LoadedEvaluation | null> {
  const [row] = await tx
    .select({ evaluation: fairnessEvaluations, dataset: fairnessDatasets, card: modelCards, expired: sql<boolean>`${fairnessDatasets.expiresAt} <= now()` })
    .from(fairnessEvaluations)
    .innerJoin(fairnessDatasets, eq(fairnessDatasets.id, fairnessEvaluations.datasetId))
    .innerJoin(modelCards, eq(modelCards.id, fairnessEvaluations.cardId))
    .where(eq(fairnessEvaluations.id, evaluationId));
  if (!row) return null;
  // the database clock decides expiry (M-075), as the retention sweep does
  if (row.expired === true) row.dataset = { ...row.dataset, rowsCiphertext: null };
  const attributes = (
    await tx.select({ a: fairnessEvaluationAttributes.attribute }).from(fairnessEvaluationAttributes).where(eq(fairnessEvaluationAttributes.evaluationId, evaluationId)).orderBy(asc(fairnessEvaluationAttributes.attribute))
  ).map((r) => r.a);
  const inputColumns = (
    await tx.select({ c: fairnessDatasetInputColumns.columnName }).from(fairnessDatasetInputColumns).where(eq(fairnessDatasetInputColumns.datasetId, row.dataset.id)).orderBy(asc(fairnessDatasetInputColumns.position))
  ).map((r) => r.c);
  const thresholds = (
    await tx.select().from(fairnessEvaluationThresholds).where(eq(fairnessEvaluationThresholds.evaluationId, evaluationId)).orderBy(asc(fairnessEvaluationThresholds.metric))
  ).map((t) => ({ metric: t.metric as FairnessMetric, limit: t.limit, action: t.action as FairnessThreshold["action"] }));
  return { ...row, attributes, inputColumns, thresholds };
}

function decryptModelInputs(dataset: typeof fairnessDatasets.$inferSelect): ModelInputRows | null {
  if (!dataKey || !dataset.rowsCiphertext) return null;
  try {
    return decodeModelInputRows(decryptSecret(dataKey, dataset.rowsCiphertext));
  } catch {
    return null;
  }
}

/** the task's input for an evaluation (pure once the rows are decrypted; exported for tests) */
export function buildFairlearnInput(runId: string, ev: LoadedEvaluation, rows: ModelInputRows): { ok: true; input: FairlearnInput } | { ok: false; code: "template_invalid" } {
  const parts = parsePromptTemplate(ev.evaluation.promptTemplate);
  if (!parts) return { ok: false, code: "template_invalid" };
  const n = rows.labels.length;
  const prompts: string[] = new Array(n);
  for (let r = 0; r < n; r++) {
    const cells: Record<string, string> = {};
    for (const c of ev.inputColumns) cells[c] = rows.inputs[c]?.[r] ?? "";
    let p: string;
    try {
      p = fillPromptTemplate(parts, cells);
    } catch {
      return { ok: false, code: "template_invalid" };
    }
    if (p.length === 0 || p.length > FAIRLEARN_LIMITS.maxPromptChars) return { ok: false, code: "template_invalid" };
    prompts[r] = p;
  }
  const attributes: Record<string, string[]> = {};
  for (const a of ev.attributes) {
    const col = rows.attributes[a];
    if (!col) return { ok: false, code: "template_invalid" };
    attributes[a] = col;
  }
  const input: FairlearnInput = {
    v: FAIRLEARN_INPUT_VERSION,
    runId,
    evaluationId: ev.evaluation.id,
    prompts,
    labels: rows.labels.map((l) => (l === 1 ? 1 : 0)),
    attributes,
    outputs: { favourable: ev.evaluation.favourableOutput, unfavourable: ev.evaluation.unfavourableOutput },
    minGroupSize: ev.evaluation.minGroupSize,
  };
  return fairlearnInputSchema.safeParse(input).success ? { ok: true, input } : { ok: false, code: "template_invalid" };
}

/**
 * When a fairlearn run's task starts (engine-tasks.ts, in its transaction): build the one data file and pin it. A
 * refusal is a closed code; the task start ends the run `not_run` with it.
 */
export async function fairnessInputTx(tx: Exec, run: EngineRunRow): Promise<FairnessInputOutcome> {
  if (run.engineId !== "fairlearn" || run.targetKind !== "agent" || fairlearnConfigProblem(run.config) !== null) return { ok: false, code: "config_invalid" };
  if (!dataKey) return { ok: false, code: "no_data_key" };
  const [org] = await tx.select({ on: orgSettings.fairnessTestingEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!org?.on) return { ok: false, code: "fairness_testing_off" };
  const ev = await loadEvaluation(tx, fairlearnEvaluationIdOf(run.config));
  if (!ev) return { ok: false, code: "evaluation_gone" };
  if (ev.evaluation.status !== "active") return { ok: false, code: "evaluation_archived" };
  // the run measures the card's own model: its target must be the card's agent
  if (!ev.card.agentId || ev.card.agentId !== run.targetAgentId) return { ok: false, code: "card_target_mismatch" };
  if (ev.dataset.kind !== "model_inputs") return { ok: false, code: "dataset_not_model_inputs" };
  const rows = decryptModelInputs(ev.dataset);
  if (!rows) return { ok: false, code: "dataset_rows_gone" };
  const built = buildFairlearnInput(run.id, ev, rows);
  if (!built.ok) return built;
  const bytes = Buffer.from(JSON.stringify(built.input), "utf8");
  if (bytes.length > FAIRLEARN_LIMITS.maxInputBytes) return { ok: false, code: "input_too_large" };
  const sha256 = sha256Hex(bytes);
  // the last placement is the one the engine measures (a refused start rolls back with its transaction)
  await tx
    .insert(fairnessEngineInputs)
    .values({ engineRunId: run.id, evaluationId: ev.evaluation.id, inputSha256: sha256, rowCount: built.input.prompts.length })
    .onConflictDoUpdate({ target: fairnessEngineInputs.engineRunId, set: { inputSha256: sha256, rowCount: built.input.prompts.length, placedAt: sql`now()` } });
  return { ok: true, file: FAIRLEARN_INPUT_FILE, bytes, sha256, rowCount: built.input.prompts.length };
}

// ---------------------------------------------------------------------------
// 3. The run's end
// ---------------------------------------------------------------------------

/** why a model run is inconclusive without a usable measurement (each a closed code, recorded on the run) */
export type ModelRunProblem =
  | "no_result"
  | "result_invalid"
  | "input_mismatch"
  | "dataset_rows_gone"
  | "engine_problem"
  | "unparseable_over_cap"
  | "fairlearn_disagrees";

/** decode the task's raw report; anything unreadable is null */
export function fairlearnReportOf(contentBase64: string | undefined): unknown {
  if (contentBase64 === undefined) return null;
  try {
    return JSON.parse(Buffer.from(contentBase64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** the measurement of one model run (pure; exported for tests) */
export function measureModelRun(args: {
  rows: Pick<ModelInputRows, "labels" | "attributes">;
  attributes: readonly string[];
  report: unknown;
  expected: { runId: string; evaluationId: string; inputSha256: string };
  thresholds: readonly FairnessThreshold[];
  minGroupSize: number;
  maxUnparseableRate: number;
}): {
  result: FairnessResult & { model: Record<string, unknown> };
  outcome: FairnessResult["outcome"];
  unparseableCount: number;
  metricsEngine: string | null;
} {
  const n = args.rows.labels.length;
  const inconclusive = (problem: ModelRunProblem, extra: Record<string, unknown> = {}, unparseableCount = n) => ({
    result: {
      metricsVersion: "fairness-metrics/1",
      rowCount: 0,
      minGroupSize: args.minGroupSize,
      attributes: [],
      evaluations: [],
      outcome: "inconclusive" as const,
      model: { problem, ...extra },
    },
    outcome: "inconclusive" as const,
    unparseableCount,
    metricsEngine: null,
  });
  const parsed = fairlearnResultSchema.safeParse(args.report);
  if (!parsed.success) return inconclusive(args.report === null ? "no_result" : "result_invalid");
  const r = parsed.data;
  if (r.v !== FAIRLEARN_RESULT_VERSION || r.runId !== args.expected.runId || r.evaluationId !== args.expected.evaluationId || r.inputSha256 !== args.expected.inputSha256) {
    return inconclusive("input_mismatch");
  }
  if (r.predictions.length !== n) return inconclusive("result_invalid");
  const unparseableCount = r.predictions.filter((p) => p === null).length;
  if (r.problem !== null) return inconclusive("engine_problem", { engineProblem: r.problem }, unparseableCount);
  if (unparseableOverCap(unparseableCount, n, args.maxUnparseableRate)) {
    return inconclusive("unparseable_over_cap", { unparseable: unparseableCount, rows: n, cap: args.maxUnparseableRate }, unparseableCount);
  }
  // the parseable rows, measured exactly as an uploaded dataset's (ADR-0222's suppression runs inside computeFairness)
  const keep = r.predictions.map((p) => p !== null);
  const rows: FairnessRows = {
    labels: args.rows.labels.filter((_, i) => keep[i]),
    predictions: r.predictions.filter((p): p is 0 | 1 => p !== null),
    attributes: Object.fromEntries(args.attributes.map((a) => [a, (args.rows.attributes[a] ?? []).filter((_, i) => keep[i])])),
  };
  const ours = computeFairness(rows, { thresholds: args.thresholds, minGroupSize: args.minGroupSize });
  const oursValues = Object.fromEntries(
    ours.attributes.map((a) => [a.attribute, Object.fromEntries(FAIRNESS_METRICS.map((m) => [m, a.metrics[m].value])) as Record<FairnessMetric, number | null>]),
  );
  const check = fairlearnAgrees(oursValues, r.metrics);
  if (!check.agrees) {
    return {
      result: { ...ours, outcome: "inconclusive", model: { problem: "fairlearn_disagrees" satisfies ModelRunProblem, disagreements: check.disagreements, unparseable: unparseableCount } },
      outcome: "inconclusive",
      unparseableCount,
      metricsEngine: null,
    };
  }
  return {
    result: { ...ours, model: { unparseable: unparseableCount, crossCheckedWith: `fairlearn ${r.fairlearn ?? FAIRLEARN_ENGINE_VERSION}` } },
    outcome: ours.outcome,
    unparseableCount,
    metricsEngine: `fairlearn ${r.fairlearn ?? FAIRLEARN_ENGINE_VERSION}`,
  };
}

/**
 * At a fairlearn run's end, in its transaction (engine-runs.ts `endLockedRun`). Only a run whose task was placed and
 * that ended completed, failed or timed out is recorded: as `inconclusive` unless a complete, agreeing measurement came
 * back, so a broken run holds the card rather than lifting a hold. A cancelled, refused or expired run records nothing.
 */
export async function recordFairnessRunEndTx(
  tx: Exec,
  run: EngineRunRow,
  args: { status: string; placed: boolean; rawReportContentBase64: string | undefined },
): Promise<{ fairnessRunId: string; outcome: string; evidence: "signed" | "unsigned" } | null> {
  if (run.engineId !== "fairlearn" || !args.placed) return null;
  if (!["completed", "failed", "timeout"].includes(args.status)) return null;
  const [pin] = await tx.select().from(fairnessEngineInputs).where(eq(fairnessEngineInputs.engineRunId, run.id));
  if (!pin) return null;
  const ev = await loadEvaluation(tx, pin.evaluationId);
  if (!ev) return null;
  const rows = decryptModelInputs(ev.dataset);
  const thresholds = ev.thresholds;
  const measured = rows
    ? measureModelRun({
        rows,
        attributes: ev.attributes,
        report: args.status === "completed" ? fairlearnReportOf(args.rawReportContentBase64) : null,
        expected: { runId: run.id, evaluationId: ev.evaluation.id, inputSha256: pin.inputSha256 },
        thresholds,
        minGroupSize: ev.evaluation.minGroupSize,
        maxUnparseableRate: ev.evaluation.maxUnparseableRate,
      })
    : {
        result: { metricsVersion: "fairness-metrics/1", rowCount: 0, minGroupSize: ev.evaluation.minGroupSize, attributes: [], evaluations: [], outcome: "inconclusive" as const, model: { problem: "dataset_rows_gone" } },
        outcome: "inconclusive" as const,
        unparseableCount: pin.rowCount,
        metricsEngine: null,
      };
  const [fr] = await tx
    .insert(fairnessRuns)
    .values({
      cardId: ev.card.id,
      datasetId: ev.dataset.id,
      datasetSha256: ev.dataset.csvSha256,
      metricsVersion: measured.result.metricsVersion,
      thresholds,
      minGroupSize: ev.evaluation.minGroupSize,
      result: measured.result,
      outcome: measured.outcome,
      cardModelVersion: ev.card.pinnedModelVersion ?? null,
      relaxed: ev.evaluation.relaxed,
      mode: "model",
      evaluationId: ev.evaluation.id,
      engineRunId: run.id,
      unparseableCount: measured.unparseableCount,
      metricsEngine: measured.metricsEngine,
      createdByUserId: run.runAsUserId,
    })
    .returning();
  const problem = (measured.result.model as { problem?: string }).problem ?? null;
  await tx.insert(auditLog).values({
    userId: run.runAsUserId ?? NO_IDENTITY,
    objectType: "model_card",
    objectId: ev.card.id,
    // counts, ids and closed codes only: never a prompt, a reply or a group value
    detail: {
      phase: "fairness",
      action: "model_run",
      fairnessRunId: fr!.id,
      engineRunId: run.id,
      evaluationId: ev.evaluation.id,
      inputSha256: pin.inputSha256,
      rows: pin.rowCount,
      unparseable: measured.unparseableCount,
      outcome: measured.outcome,
      problem,
      metricsEngine: measured.metricsEngine,
      cardModelVersion: ev.card.pinnedModelVersion ?? null,
    },
    effect: measured.outcome === "fail" || measured.outcome === "inconclusive" ? "deny" : "allow",
    ruleId: FAIRNESS_EVALUATION_RULE_IDS.modelRun,
    ruleChain: [],
    reason: `fairness evaluation '${ev.evaluation.name}' ran the card's model: ${measured.outcome}${problem ? ` (${problem})` : ""}`,
  });
  const evidence = await signFairnessRunEvidenceTx(tx, fr!);
  return { fairnessRunId: fr!.id, outcome: measured.outcome, evidence };
}

// ---------------------------------------------------------------------------
// 4. Signed evidence
// ---------------------------------------------------------------------------

/** the canonical evidence body of one run (pure; exported for tests and verifiers) */
export function fairnessRunEvidenceBody(r: FairnessRunRow): string {
  return canonicalJson({
    v: FAIRNESS_RUN_EVIDENCE_VERSION,
    runId: r.id,
    cardId: r.cardId,
    datasetId: r.datasetId,
    datasetSha256: r.datasetSha256,
    mode: r.mode,
    evaluationId: r.evaluationId,
    engineRunId: r.engineRunId,
    metricsVersion: r.metricsVersion,
    metricsEngine: r.metricsEngine,
    thresholds: r.thresholds,
    minGroupSize: r.minGroupSize,
    unparseableCount: r.unparseableCount,
    outcome: r.outcome,
    result: r.result,
    cardModelVersion: r.cardModelVersion,
    relaxed: r.relaxed,
    createdAt: r.createdAt.toISOString(),
  });
}

/**
 * Sign a run's evidence with the receipt signing key and cite the run on its card, in the caller's transaction. With
 * no usable key the run is kept and the evidence is NOT stored (never unsigned); an audit row says so, and the card's
 * evidence list shows the run as not cited.
 */
export async function signFairnessRunEvidenceTx(tx: Exec, run: FairnessRunRow): Promise<"signed" | "unsigned"> {
  let key: ReturnType<typeof loadReceiptSigningKey> = null;
  try {
    key = loadReceiptSigningKey();
  } catch (e) {
    if (!(e instanceof ReceiptKeyError)) throw e;
  }
  const unsigned = async (why: string) => {
    await tx.insert(auditLog).values({
      userId: run.createdByUserId ?? NO_IDENTITY,
      objectType: "model_card",
      objectId: run.cardId,
      detail: { phase: "fairness", action: "evidence_unsigned", fairnessRunId: run.id, why },
      effect: "deny",
      ruleId: FAIRNESS_EVALUATION_RULE_IDS.evidenceUnsigned,
      ruleChain: [],
      reason: "a fairness run was recorded without signed evidence: no usable receipt signing key",
    });
    return "unsigned" as const;
  };
  if (!key) return unsigned("no_key");
  const [recorded] = await tx.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId)).for("share");
  if (recorded && (!sameReceiptPublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt)) return unsigned("key_conflict_or_retired");
  if (!recorded) {
    try {
      await registerReceiptSigningKey(tx as unknown as Db, key, run.createdAt, "fairness-run");
    } catch (e) {
      if (e instanceof ReceiptKeyError) return unsigned("key_conflict_or_retired");
      throw e;
    }
  }
  const body = fairnessRunEvidenceBody(run);
  const signature = sign(null, Buffer.from(body, "utf8"), key.privateKey).toString("base64url");
  const bodySha256 = sha256Hex(Buffer.from(body, "utf8"));
  await tx.insert(fairnessRunEvidence).values({ runId: run.id, body, bodySha256, signature, keyId: key.keyId });
  await tx
    .insert(modelCardEvidence)
    .values({ cardId: run.cardId, kind: "fairness_run", fairnessRunId: run.id, label: `fairness run (${run.mode}): ${run.outcome}`, attachedByUserId: run.createdByUserId ?? null })
    .onConflictDoNothing();
  await tx.insert(auditLog).values({
    userId: run.createdByUserId ?? NO_IDENTITY,
    objectType: "model_card",
    objectId: run.cardId,
    detail: { phase: "fairness", action: "evidence_signed", fairnessRunId: run.id, bodySha256, keyId: key.keyId },
    effect: "allow",
    ruleId: FAIRNESS_EVALUATION_RULE_IDS.evidenceSigned,
    ruleChain: [],
    reason: "a fairness run's evidence was signed and cited on its model card",
  });
  return "signed";
}

/**
 * Why a card may not be deleted, or null. Signed fairness evidence is kept (its rows are append-only and RESTRICT the
 * run), and an evaluation that has run is the record of what a run measured: deleting either would erase evidence.
 */
export async function fairnessCardDeleteBlock(db: Pick<Db, "select">, cardId: string): Promise<"signed_fairness_evidence" | "fairness_evaluation_runs" | null> {
  const [signed] = await db
    .select({ id: fairnessRunEvidence.runId })
    .from(fairnessRunEvidence)
    .innerJoin(fairnessRuns, eq(fairnessRuns.id, fairnessRunEvidence.runId))
    .where(eq(fairnessRuns.cardId, cardId))
    .limit(1);
  if (signed) return "signed_fairness_evidence";
  const [ran] = await db
    .select({ id: fairnessEngineInputs.engineRunId })
    .from(fairnessEngineInputs)
    .innerJoin(fairnessEvaluations, eq(fairnessEvaluations.id, fairnessEngineInputs.evaluationId))
    .where(and(eq(fairnessEvaluations.cardId, cardId)))
    .limit(1);
  return ran ? "fairness_evaluation_runs" : null;
}

// the measured-evidence SQL predicate lives in a leaf module (fairness-evidence-sql.ts) so the compliance packs can
// read it without importing this module's signing dependencies (an import cycle)
export { fairnessCardMeasuredSql } from "./fairness-evidence-sql.js";
