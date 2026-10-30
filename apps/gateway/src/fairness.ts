/**
 * ADR-0222 (P13(a)) — FAIRNESS TESTING, the gateway half.
 *
 *   `packages/shared/src/fairness.ts`  the metrics, thresholds and outcome (pure,
 *                                      pinned against fairlearn)
 *   THIS FILE                          the CSV parse, the encrypted dataset store,
 *                                      the runs, the settings, the retention
 *                                      sweep, and the hold the model-risk gate reads
 *
 * WHAT A RUN IS. An admin uploads a labelled evaluation dataset: for each row,
 * the true outcome, the model's prediction and one or more protected
 * attributes. A run computes the group metrics on it for ONE model card and
 * judges them against thresholds. The predictions are the ones in the file —
 * the gateway does not run the model — and the response says so.
 *
 * THE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. OFF UNTIL AN ADMIN TURNS IT ON. `fairnessTestingEnabled` is false on a
 *     first load (ADR-0180). Turning it on starts storing sensitive attributes,
 *     so it is a relaxation with a `settings_relax` step-up, like turning
 *     blocking off or lengthening retention. Every route is admin-only through
 *     app.ts's default-deny gate.
 *  2. DATA MINIMISATION. Only the label, prediction and protected attribute
 *     columns are kept; every other column of the upload is dropped before
 *     anything is stored. The kept rows are enveloped under the data key
 *     (`rows_ciphertext`, in CIPHERTEXT_COLUMNS), never returned by any route,
 *     never written to a log or an audit row (refusals name a line and a column,
 *     never a cell), and set to NULL at the retention date or on delete. Runs
 *     store aggregates only.
 *  3. EVERY WRITE IS AUDITED IN ITS OWN TRANSACTION: an upload, a delete, a run,
 *     a settings change and a retention purge.
 *  4. A FAILING RESULT HOLDS THE MODEL. While blocking is on, a card whose
 *     latest run failed or was inconclusive cannot be sent for sign-off, and
 *     dispatch under it is refused on the model-risk gate's 409 path
 *     (`fairnessHold`, read by mrm.ts). Inconclusive is never read as a pass.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parse as parseCsv, CsvError } from "csv-parse/sync";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  auditLog,
  desc,
  eq,
  fairnessDatasets,
  fairnessRuns,
  isNotNull,
  lt,
  modelCards,
  or,
  orgSettings,
  sql,
  type Db,
  type FairnessDatasetRow,
  type FairnessRunRow,
} from "@regulait/db";
import {
  FAIRNESS_DEFAULT_THRESHOLDS,
  FAIRNESS_LIMITS,
  computeFairness,
  createFairnessDatasetSchema,
  fairnessOutcomeBlocks,
  fairnessSettingsRelaxed,
  runFairnessTestSchema,
  updateFairnessSettingsSchema,
  type CreateFairnessDataset,
  type FairnessOutcome,
  type FairnessResult,
  type FairnessRows,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadOrgSettings } from "./org-settings.js";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";
import { SharedRateLimitStore } from "./rate-limit-store.js";
import { settingTransitions } from "./setting-transitions.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const ORG_SETTINGS_ID = "singleton";
/** the audit actor when the caller is the identity-less bootstrap token, or the scheduler */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** uploads, and separately runs, per person per minute (parsing and computing are the costly paths) */
export const FAIRNESS_WRITE_RATE_PER_MINUTE = 20;
/** the most rows a list read returns */
const LIST_LIMIT = 100;

export const FAIRNESS_RULE_IDS = {
  settings: "fairness-settings-changed",
  uploaded: "fairness-dataset-uploaded",
  deleted: "fairness-dataset-deleted",
  purged: "fairness-dataset-retention-purged",
  run: "fairness-run-recorded",
  signOffHeld: "fairness-sign-off-held",
  dispatchHeld: "fairness-dispatch-held",
} as const;

const PREDICTIONS_NOTE =
  "The metrics are computed on the predictions in the uploaded file; regulAIt does not run the model against the dataset.";

// ---------------------------------------------------------------------------
// Parsing an upload
// ---------------------------------------------------------------------------

export type ParsedDataset =
  | { ok: true; rows: FairnessRows; rowCount: number; groups: Record<string, number> }
  | { ok: false; status: number; error: string; detail: string };

const refuse = (error: string, detail: string, status = 422): ParsedDataset => ({ ok: false, status, error, detail });

/**
 * Parse the CSV and keep only the named columns. A refusal names the line and
 * the column, never a cell's value (a cell can be a protected attribute), and
 * never the parser's own message, which can quote one.
 */
export function parseFairnessCsv(spec: Pick<CreateFairnessDataset, "csv" | "labelColumn" | "predictionColumn" | "favourableLabel" | "protectedAttributes">): ParsedDataset {
  let records: string[][];
  try {
    records = parseCsv(spec.csv, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
      max_record_size: 64 * 1024,
      to: FAIRNESS_LIMITS.maxRows + 2,
    }) as string[][];
  } catch (e) {
    const lines = e instanceof CsvError ? (e as unknown as { lines?: unknown }).lines : undefined;
    const at = typeof lines === "number" ? ` near line ${lines}` : "";
    const code = e instanceof CsvError ? e.code : "CSV_INVALID";
    return refuse("dataset_unreadable", `the file is not valid CSV${at} (${code})`);
  }
  const [header, ...data] = records;
  if (!header || data.length === 0) return refuse("dataset_empty", "the file needs a header row and at least one data row");
  if (data.length > FAIRNESS_LIMITS.maxRows) {
    return refuse("dataset_too_many_rows", `a dataset may hold at most ${FAIRNESS_LIMITS.maxRows} rows`, 413);
  }
  if (new Set(header).size !== header.length) return refuse("dataset_duplicate_columns", "two columns in the header row have the same name");
  const col = (name: string) => header.indexOf(name);
  const wanted = [spec.labelColumn, spec.predictionColumn, ...spec.protectedAttributes];
  const missing = wanted.filter((c) => col(c) < 0);
  if (missing.length > 0) {
    return refuse("dataset_missing_columns", `the header row has no column named ${missing.map((m) => `'${m}'`).join(", ")}`);
  }
  const li = col(spec.labelColumn);
  const pi = col(spec.predictionColumn);
  const ai = spec.protectedAttributes.map((a) => [a, col(a)] as const);

  const outcomes = new Set<string>();
  const labels: number[] = new Array(data.length);
  const predictions: number[] = new Array(data.length);
  const attributes: Record<string, string[]> = {};
  const groupSets: Record<string, Set<string>> = {};
  for (const [a] of ai) {
    attributes[a] = new Array(data.length);
    groupSets[a] = new Set();
  }
  let sawFavourableLabel = false;
  for (let r = 0; r < data.length; r++) {
    const row = data[r]!;
    const line = r + 2;
    const y = row[li] ?? "";
    const p = row[pi] ?? "";
    if (y === "" || p === "") return refuse("dataset_missing_value", `line ${line} has no value in the label or prediction column`);
    if (y.length > FAIRNESS_LIMITS.maxCellChars || p.length > FAIRNESS_LIMITS.maxCellChars) {
      return refuse("dataset_cell_too_long", `line ${line} has a value longer than ${FAIRNESS_LIMITS.maxCellChars} characters`);
    }
    outcomes.add(y);
    outcomes.add(p);
    if (outcomes.size > 2) {
      return refuse(
        "dataset_not_binary",
        `the label and prediction columns hold more than two distinct values by line ${line}; fairness testing here covers binary outcomes`,
      );
    }
    labels[r] = y === spec.favourableLabel ? 1 : 0;
    predictions[r] = p === spec.favourableLabel ? 1 : 0;
    if (labels[r] === 1) sawFavourableLabel = true;
    for (const [a, i] of ai) {
      const g = row[i] ?? "";
      if (g === "") return refuse("dataset_missing_value", `line ${line} has no value in the protected attribute column '${a}'`);
      if (g.length > FAIRNESS_LIMITS.maxCellChars) {
        return refuse("dataset_cell_too_long", `line ${line} has a value longer than ${FAIRNESS_LIMITS.maxCellChars} characters`);
      }
      groupSets[a]!.add(g);
      if (groupSets[a]!.size > FAIRNESS_LIMITS.maxGroupsPerAttribute) {
        return refuse(
          "dataset_too_many_groups",
          `the protected attribute column '${a}' has more than ${FAIRNESS_LIMITS.maxGroupsPerAttribute} distinct groups`,
        );
      }
      attributes[a]![r] = g;
    }
  }
  if (!sawFavourableLabel) {
    return refuse("dataset_no_favourable_label", "no row's label equals the favourable label; check the value that means the favourable outcome");
  }
  const groups: Record<string, number> = {};
  for (const [a] of ai) groups[a] = groupSets[a]!.size;
  return { ok: true, rows: { labels, predictions, attributes }, rowCount: data.length, groups };
}

/** the stored form: outcomes as '0'/'1' strings, each attribute as a group dictionary and one index per row */
interface StoredRows {
  v: 1;
  labels: string;
  predictions: string;
  attributes: Record<string, { groups: string[]; codes: number[] }>;
}

export function encodeRows(rows: FairnessRows): string {
  const attributes: StoredRows["attributes"] = {};
  for (const [a, col] of Object.entries(rows.attributes)) {
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
    attributes[a] = { groups, codes };
  }
  const stored: StoredRows = { v: 1, labels: rows.labels.join(""), predictions: rows.predictions.join(""), attributes };
  return JSON.stringify(stored);
}

export function decodeRows(json: string): FairnessRows {
  const s = JSON.parse(json) as StoredRows;
  if (s.v !== 1) throw new Error("unknown fairness dataset encoding");
  const attributes: Record<string, string[]> = {};
  for (const [a, { groups, codes }] of Object.entries(s.attributes)) attributes[a] = codes.map((c) => groups[c]!);
  return {
    labels: [...s.labels].map((c) => (c === "1" ? 1 : 0)),
    predictions: [...s.predictions].map((c) => (c === "1" ? 1 : 0)),
    attributes,
  };
}

// ---------------------------------------------------------------------------
// Views (metadata only: no route ever returns rows or ciphertext)
// ---------------------------------------------------------------------------

export function datasetView(d: FairnessDatasetRow) {
  const { rowsCiphertext, ...rest } = d;
  return { ...rest, rowsStored: rowsCiphertext !== null };
}

export function runView(r: FairnessRunRow) {
  return { ...r, result: r.result as FairnessResult, blocks: fairnessOutcomeBlocks(r.outcome as FairnessOutcome) };
}

// ---------------------------------------------------------------------------
// The hold the model-risk gate reads
// ---------------------------------------------------------------------------

export interface FairnessHold {
  runId: string;
  outcome: FairnessOutcome;
  createdAt: Date;
  detail: string;
}

/**
 * The latest run on a card, when it holds the card: fairness testing is on,
 * blocking is on, and the latest run failed or was inconclusive. null = no
 * hold. A card with no run is not held (fairness applies to the models an
 * admin tests; ADR-0222 lists a per-card requirement as a follow-up).
 */
export async function fairnessHold(
  db: Db,
  cardId: string,
  org?: { fairnessTestingEnabled: boolean; fairnessBlockOnFail: boolean },
): Promise<FairnessHold | null> {
  const o = org ?? (await loadOrgSettings(db));
  if (!o.fairnessTestingEnabled || !o.fairnessBlockOnFail) return null;
  const [latest] = await db
    .select({ id: fairnessRuns.id, outcome: fairnessRuns.outcome, createdAt: fairnessRuns.createdAt })
    .from(fairnessRuns)
    .where(eq(fairnessRuns.cardId, cardId))
    .orderBy(desc(fairnessRuns.createdAt), desc(fairnessRuns.id))
    .limit(1);
  if (!latest || !fairnessOutcomeBlocks(latest.outcome as FairnessOutcome)) return null;
  return {
    runId: latest.id,
    outcome: latest.outcome as FairnessOutcome,
    createdAt: latest.createdAt,
    detail:
      latest.outcome === "fail"
        ? "the latest fairness test on this model card breached a failing threshold; run a passing test, or an admin turns blocking off"
        : "the latest fairness test on this model card was inconclusive (too few rows in a group, or a metric could not be computed); run a test on a fuller dataset",
  };
}

// ---------------------------------------------------------------------------
// The retention sweep
// ---------------------------------------------------------------------------

/**
 * Delete the rows of every dataset past its retention date. Retention is the
 * setting NOW applied from the upload (shortening it shortens what is stored;
 * the stored expiry can only end one sooner), judged on the database clock.
 */
export async function runFairnessRetentionSweep(db: Db, opts: { actorUserId?: string | null } = {}) {
  const org = await loadOrgSettings(db);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const purged = await tx
      .update(fairnessDatasets)
      .set({ rowsCiphertext: null, purgedAt: sql`now()`, purgeReason: "retention" })
      .where(
        and(
          isNotNull(fairnessDatasets.rowsCiphertext),
          or(
            lt(fairnessDatasets.expiresAt, sql`now()`),
            sql`${fairnessDatasets.createdAt} + make_interval(days => ${org.fairnessDatasetRetentionDays}) < now()`,
          ),
        ),
      )
      .returning({ id: fairnessDatasets.id, sha: fairnessDatasets.csvSha256 });
    if (purged.length > 0) {
      await tx.insert(auditLog).values({
        userId: opts.actorUserId ?? NO_IDENTITY,
        objectType: "fairness_dataset",
        objectId: purged.length === 1 ? purged[0]!.id : null,
        detail: { phase: "retention", datasets: purged.map((p) => ({ id: p.id, csvSha256: p.sha })), retentionDays: org.fairnessDatasetRetentionDays },
        effect: "allow",
        ruleId: FAIRNESS_RULE_IDS.purged,
        ruleChain: [],
        reason: `${purged.length} fairness dataset${purged.length === 1 ? "" : "s"} reached the retention date; the rows were deleted and the sha256 kept`,
      });
    }
    return { purged: purged.length, ids: purged.map((p) => p.id) };
  });
}

export const FAIRNESS_RETENTION_JOB_NAME = "fairness-dataset-retention-sweep";

export function fairnessJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: FAIRNESS_RETENTION_JOB_NAME,
      description:
        "Delete the rows of every fairness evaluation dataset past its retention date (strict 30 days), audited; the " +
        "dataset's sha256 and the runs that cite it stay.",
      adr: "ADR-0222",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const out = await runFairnessRetentionSweep(ctx.db, { actorUserId: ctx.actorUserId });
        return { itemsProcessed: out.purged, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ cardId: z.string().uuid().optional() }).strict();

function settingsView(o: { fairnessTestingEnabled: boolean; fairnessBlockOnFail: boolean; fairnessDatasetRetentionDays: number }) {
  return {
    enabled: o.fairnessTestingEnabled,
    blockOnFail: o.fairnessBlockOnFail,
    datasetRetentionDays: o.fairnessDatasetRetentionDays,
    limits: FAIRNESS_LIMITS,
    defaultThresholds: FAIRNESS_DEFAULT_THRESHOLDS,
  };
}

export function registerFairnessRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const limiter = new SharedRateLimitStore(db);
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NO_IDENTITY;

  /** per-person limit on the two costly writes; fail-open on a counter outage, as the global tier does */
  const rateLimited = async (req: FastifyRequest, reply: FastifyReply, action: "upload" | "run"): Promise<boolean> => {
    const max = FAIRNESS_WRITE_RATE_PER_MINUTE;
    const verdict = await new Promise<{ current: number; ttl: number }>((resolve) =>
      limiter.incr(`fairness-${action}:${actor(req)}`, (_e, r) => resolve(r ?? { current: 0, ttl: 0 }), 60_000, max),
    );
    if (verdict.current <= max) return false;
    const retry = Math.max(1, Math.ceil(verdict.ttl / 1000));
    await reply
      .status(429)
      .header("retry-after", String(retry))
      .send({ error: "rate_limited", detail: `too many fairness ${action}s; the limit is ${max} a minute`, retryAfterSeconds: retry });
    return true;
  };

  const featureOff = (reply: FastifyReply) =>
    reply.status(409).send({
      error: "fairness_testing_off",
      detail: "fairness testing is turned off for this organisation; an admin turns it on in the fairness settings",
    });

  /** settings, datasets (metadata only) and runs, newest first; `cardId` narrows the runs to one card */
  app.get("/v1/mrm/fairness", async (req) => {
    const q = listQuery.parse(req.query ?? {});
    const org = await loadOrgSettings(db);
    const datasets = await db.select().from(fairnessDatasets).orderBy(desc(fairnessDatasets.createdAt)).limit(LIST_LIMIT);
    const runs = await db
      .select()
      .from(fairnessRuns)
      .where(q.cardId ? eq(fairnessRuns.cardId, q.cardId) : undefined)
      .orderBy(desc(fairnessRuns.createdAt), desc(fairnessRuns.id))
      .limit(LIST_LIMIT);
    return {
      settings: settingsView(org),
      datasets: datasets.map(datasetView),
      runs: runs.map(runView),
      note: PREDICTIONS_NOTE,
    };
  });

  app.get("/v1/mrm/fairness/runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [run] = await db.select().from(fairnessRuns).where(eq(fairnessRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_fairness_run" });
    return { run: runView(run), note: PREDICTIONS_NOTE };
  });

  app.put("/v1/mrm/fairness/settings", async (req, reply) => {
    const body = updateFairnessSettingsSchema.parse(req.body ?? {});
    const org = await loadOrgSettings(db);
    // turning the feature on, blocking off or a longer retention: a settings_relax step-up bound to the new values
    if (!(await requireRelaxStepUp(db, req, reply, fairnessSettingsRelaxed(body, org)))) return reply;
    const patch = {
      ...(body.enabled !== undefined ? { fairnessTestingEnabled: body.enabled } : {}),
      ...(body.blockOnFail !== undefined ? { fairnessBlockOnFail: body.blockOnFail } : {}),
      ...(body.datasetRetentionDays !== undefined ? { fairnessDatasetRetentionDays: body.datasetRetentionDays } : {}),
    };
    if (Object.keys(patch).length === 0) return settingsView(org);
    const updated = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // compare-and-set on the values the step-up was decided on
      const [row] = await tx
        .update(orgSettings)
        .set({ ...patch, updatedBy: req.authCtx.userId ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(orgSettings.id, ORG_SETTINGS_ID),
            eq(orgSettings.fairnessTestingEnabled, org.fairnessTestingEnabled),
            eq(orgSettings.fairnessBlockOnFail, org.fairnessBlockOnFail),
            eq(orgSettings.fairnessDatasetRetentionDays, org.fairnessDatasetRetentionDays),
          ),
        )
        .returning();
      if (!row) return null;
      const relaxed = fairnessSettingsRelaxed(body, org);
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "org_settings",
        objectId: null,
        detail: { phase: "fairness", transitions: settingTransitions(org, patch), relaxed: Object.keys(relaxed) },
        effect: "allow",
        ruleId: FAIRNESS_RULE_IDS.settings,
        ruleChain: [],
        reason:
          `fairness testing ${row.fairnessTestingEnabled ? "on" : "off"}; a failing or inconclusive result ` +
          `${row.fairnessBlockOnFail ? "holds" : "does not hold"} the model card; datasets kept ${row.fairnessDatasetRetentionDays} days`,
      });
      return row;
    });
    if (!updated) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return settingsView(updated);
  });

  app.post(
    "/v1/mrm/fairness/datasets",
    { bodyLimit: FAIRNESS_LIMITS.maxCsvBytes + 64 * 1024 },
    async (req, reply) => {
      const org = await loadOrgSettings(db);
      if (!org.fairnessTestingEnabled) return featureOff(reply);
      if (await rateLimited(req, reply, "upload")) return reply;
      const parsedBody = createFairnessDatasetSchema.safeParse(req.body);
      if (!parsedBody.success) {
        // the issue paths and messages only: zod never echoes the CSV
        return reply.status(400).send({
          error: "invalid_request",
          issues: parsedBody.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      const body = parsedBody.data;
      if (!opts.dataKey) {
        return reply.status(503).send({ error: "no_data_key", detail: "datasets are stored encrypted, and this deployment has no data key configured" });
      }
      const parsed = parseFairnessCsv(body);
      if (!parsed.ok) return reply.status(parsed.status).send({ error: parsed.error, detail: parsed.detail });
      const csvBytes = Buffer.byteLength(body.csv, "utf8");
      const csvSha256 = createHash("sha256").update(body.csv, "utf8").digest("hex");
      const ciphertext = encryptSecret(opts.dataKey, encodeRows(parsed.rows));
      const row = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [d] = await tx
          .insert(fairnessDatasets)
          .values({
            name: body.name,
            description: body.description ?? null,
            labelColumn: body.labelColumn,
            predictionColumn: body.predictionColumn,
            favourableLabel: body.favourableLabel,
            protectedAttributes: body.protectedAttributes,
            rowCount: parsed.rowCount,
            csvBytes,
            csvSha256,
            rowsCiphertext: ciphertext,
            expiresAt: sql`now() + make_interval(days => ${org.fairnessDatasetRetentionDays})` as unknown as Date,
            uploadedByUserId: req.authCtx.userId ?? null,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: actor(req),
          objectType: "fairness_dataset",
          objectId: d!.id,
          // names, counts and the hash only: never a row, never a group value
          detail: {
            phase: "dataset",
            action: "uploaded",
            name: d!.name,
            rowCount: d!.rowCount,
            csvBytes,
            csvSha256,
            protectedAttributes: body.protectedAttributes,
            groupCounts: parsed.groups,
            expiresAt: d!.expiresAt,
          },
          effect: "allow",
          ruleId: FAIRNESS_RULE_IDS.uploaded,
          ruleChain: [],
          reason: `a fairness evaluation dataset of ${d!.rowCount} rows was uploaded; only the label, prediction and protected attribute columns were kept, encrypted`,
        });
        return d!;
      });
      return reply.status(201).send({ dataset: datasetView(row) });
    },
  );

  /** deletes the rows now; the metadata row, its sha256 and the runs that cite it stay for the audit trail */
  app.delete("/v1/mrm/fairness/datasets/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [d] = await tx
        .update(fairnessDatasets)
        .set({ rowsCiphertext: null, purgedAt: sql`now()`, purgeReason: "deleted" })
        .where(and(eq(fairnessDatasets.id, id), isNotNull(fairnessDatasets.rowsCiphertext)))
        .returning();
      if (!d) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "fairness_dataset",
        objectId: id,
        detail: { phase: "dataset", action: "deleted", name: d.name, csvSha256: d.csvSha256 },
        effect: "allow",
        ruleId: FAIRNESS_RULE_IDS.deleted,
        ruleChain: [],
        reason: "a fairness evaluation dataset's rows were deleted; its sha256 and the runs that cite it are kept",
      });
      return d;
    });
    if (out) return { dataset: datasetView(out) };
    const [exists] = await db.select({ id: fairnessDatasets.id }).from(fairnessDatasets).where(eq(fairnessDatasets.id, id));
    if (!exists) return reply.status(404).send({ error: "unknown_fairness_dataset" });
    return reply.status(409).send({ error: "fairness_dataset_already_deleted", detail: "this dataset's rows were already deleted" });
  });

  app.post("/v1/mrm/fairness/runs", async (req, reply) => {
    const org = await loadOrgSettings(db);
    if (!org.fairnessTestingEnabled) return featureOff(reply);
    if (await rateLimited(req, reply, "run")) return reply;
    const body = runFairnessTestSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "datasets are stored encrypted, and this deployment has no data key configured" });
    }
    const [card] = await db.select({ id: modelCards.id, intendedUse: modelCards.intendedUse }).from(modelCards).where(eq(modelCards.id, body.cardId));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const [dataset] = await db.select().from(fairnessDatasets).where(eq(fairnessDatasets.id, body.datasetId));
    if (!dataset) return reply.status(404).send({ error: "unknown_fairness_dataset" });
    if (dataset.rowsCiphertext === null || dataset.expiresAt.getTime() <= Date.now()) {
      return reply.status(410).send({
        error: "fairness_dataset_gone",
        detail: "this dataset's rows were deleted or reached the retention date; upload the dataset again to run a test",
      });
    }
    let rows: FairnessRows;
    try {
      rows = decodeRows(decryptSecret(opts.dataKey, dataset.rowsCiphertext));
    } catch {
      return reply.status(500).send({ error: "fairness_dataset_unreadable", detail: "the stored dataset could not be decrypted with this deployment's data key" });
    }
    const thresholds = body.thresholds ?? [...FAIRNESS_DEFAULT_THRESHOLDS];
    const minGroupSize = body.minGroupSize ?? FAIRNESS_LIMITS.minGroupSize.default;
    const result = computeFairness(rows, { thresholds, minGroupSize });
    const run = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [r] = await tx
        .insert(fairnessRuns)
        .values({
          cardId: card.id,
          datasetId: dataset.id,
          datasetSha256: dataset.csvSha256,
          metricsVersion: result.metricsVersion,
          thresholds,
          minGroupSize,
          result,
          outcome: result.outcome,
          createdByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      const breaches = result.evaluations.filter((e) => e.status !== "pass").map((e) => ({ attribute: e.attribute, metric: e.metric, status: e.status, action: e.action, value: e.value, limit: e.limit }));
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "model_card",
        objectId: card.id,
        detail: {
          phase: "fairness",
          action: "run",
          fairnessRunId: r!.id,
          datasetId: dataset.id,
          datasetSha256: dataset.csvSha256,
          metricsVersion: result.metricsVersion,
          outcome: result.outcome,
          breaches,
          blocks: org.fairnessBlockOnFail && fairnessOutcomeBlocks(result.outcome),
        },
        effect: fairnessOutcomeBlocks(result.outcome) ? "deny" : "allow",
        ruleId: FAIRNESS_RULE_IDS.run,
        ruleChain: [],
        reason: `fairness test on model card '${card.intendedUse}': ${result.outcome}`,
      });
      return r!;
    });
    return reply.status(201).send({ run: runView(run), note: PREDICTIONS_NOTE });
  });
}
