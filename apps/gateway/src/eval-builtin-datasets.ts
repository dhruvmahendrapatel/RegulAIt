/**
 * ADR-0187 decisions 185–192 — the BUILT-IN eval datasets (CyberSecEval),
 * loaded from the vendored files, seeded idempotently, and verified before
 * every run.
 *
 * INTEGRITY, IN TWO LAYERS
 *   1. The FILE. Its bytes are hashed and compared with the sha256 pinned in
 *      `@regulait/shared` BEFORE they are parsed. A drifted file seeds nothing
 *      and every run of the datasets it feeds is refused
 *      (`builtin_dataset_unverifiable`).
 *   2. The ROWS. A built-in dataset's cases cannot be edited through the API
 *      (the version is always frozen, minting a new version is refused, and
 *      the `builtin:` name prefix is reserved). A row changed by any other
 *      route is caught at run time: the runner recomputes the case-set digest
 *      from the rows and refuses on any difference (`builtin_dataset_drift`).
 *
 * SEEDING never starts a run, never touches a drifted or foreign row, and is
 * idempotent: a re-run finds each (name, version) present and verifies it. Two
 * replicas seeding at once are serialised by the (name, version) unique index;
 * the loser verifies the winner's rows.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, auditLog, eq, evalCases, evalDatasets, type Db, type EvalDatasetRow } from "@regulait/db";
import {
  BUILTIN_EVAL_DATASETS,
  BUILTIN_EVAL_DATASET_PREFIX,
  CYBERSECEVAL_FILES,
  CYBERSECEVAL_PIN,
  builtinEvalCases,
  builtinEvalDatasetByName,
  builtinEvalScorer,
  evalCaseSetDigest,
  vendoredFileSha256,
  type BuiltinEvalCase,
  type BuiltinEvalDatasetSpec,
  type BuiltinEvalScorer,
} from "@regulait/shared";

/** the system actor on audit rows (the column is NOT NULL; the seeder has no person) */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** the vendored directory, from `src/` and from `dist/` alike (the image keeps the whole tree) */
export function builtinEvalVendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../packages/shared/src/eval-datasets", CYBERSECEVAL_PIN.vendorDir);
}

export interface LoadedBuiltinEvalDataset {
  spec: BuiltinEvalDatasetSpec;
  scorer: BuiltinEvalScorer;
  cases: BuiltinEvalCase[];
  /** the case-set digest the seeded rows must have */
  digest: string;
}

export class BuiltinEvalDatasetUnverifiable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuiltinEvalDatasetUnverifiable";
  }
}

/** verified loads only; a failed load is never cached, so a fixed file is picked up */
const loaded = new Map<string, LoadedBuiltinEvalDataset>();

/**
 * Read, verify and map one built-in dataset. Throws
 * `BuiltinEvalDatasetUnverifiable` when the file is missing, its sha256 is not
 * the pinned one, or a record does not match the upstream shape.
 */
export function loadBuiltinEvalDataset(spec: BuiltinEvalDatasetSpec, dir = builtinEvalVendorDir()): LoadedBuiltinEvalDataset {
  const cacheKey = `${dir}\u0000${spec.key}`;
  const hit = loaded.get(cacheKey);
  if (hit) return hit;
  const file = CYBERSECEVAL_FILES[spec.file];
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(dir, file.path));
  } catch (e) {
    throw new BuiltinEvalDatasetUnverifiable(`${spec.key}: vendored file ${file.path} cannot be read (${(e as Error).message})`);
  }
  const actual = vendoredFileSha256(bytes);
  if (actual !== file.sha256) {
    throw new BuiltinEvalDatasetUnverifiable(
      `${spec.key}: vendored file ${file.path} has sha256 ${actual}, not the pinned ${file.sha256}; nothing is seeded or run from it`,
    );
  }
  let cases: BuiltinEvalCase[];
  try {
    cases = builtinEvalCases(spec, JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (e) {
    throw new BuiltinEvalDatasetUnverifiable(`${spec.key}: ${(e as Error).message}`);
  }
  const scorer = builtinEvalScorer(spec);
  const out = { spec, scorer, cases, digest: evalCaseSetDigest(scorer, cases) };
  loaded.set(cacheKey, out);
  return out;
}

/** the case-set digest of a stored dataset version, from its rows */
export async function storedEvalCaseSetDigest(db: Db, dataset: EvalDatasetRow): Promise<{ digest: string; cases: number }> {
  const rows = await db
    .select()
    .from(evalCases)
    .where(and(eq(evalCases.datasetId, dataset.id), eq(evalCases.datasetVersion, dataset.version)))
    .orderBy(asc(evalCases.id));
  return {
    digest: evalCaseSetDigest({ scorerKind: dataset.scorerKind, scorerConfig: dataset.scorerConfig }, rows),
    cases: rows.length,
  };
}

function datasetNote(spec: BuiltinEvalDatasetSpec): string {
  const file = CYBERSECEVAL_FILES[spec.file];
  return (
    `Built-in, read-only (ADR-0187 decisions 185–192). CyberSecEval ${spec.file} records ${spec.range[0]}–${spec.range[1] - 1}, ` +
    `upstream commit ${CYBERSECEVAL_PIN.commit}, file sha256 ${file.sha256}, ${CYBERSECEVAL_PIN.licence} (THIRD_PARTY.md). ` +
    `${spec.measures}. Class: ${spec.sensitivity}` +
    (spec.sensitivity === "offensive" ? "; a run waits for approval." : ".")
  );
}

export type BuiltinSeedOutcome = "seeded" | "unchanged" | "drifted" | "unverifiable";

export interface BuiltinSeedReport {
  datasets: Array<{ key: string; name: string; version: number; outcome: BuiltinSeedOutcome; datasetId: string | null; detail?: string }>;
}

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err?.code ?? err?.cause?.code) === "23505";
};

async function verifyExisting(db: Db, row: EvalDatasetRow, want: LoadedBuiltinEvalDataset) {
  const stored = await storedEvalCaseSetDigest(db, row);
  return stored.digest === want.digest;
}

/**
 * Seed every built-in dataset that is not there yet; verify the ones that are.
 * Never throws for one dataset's problem: each is reported (and audited when
 * it is a refusal), so a drifted file cannot stop a gateway from booting.
 */
export async function seedBuiltinEvalDatasets(
  db: Db,
  opts: { dir?: string; specs?: readonly BuiltinEvalDatasetSpec[] } = {},
): Promise<BuiltinSeedReport> {
  const report: BuiltinSeedReport = { datasets: [] };
  for (const spec of opts.specs ?? BUILTIN_EVAL_DATASETS) {
    const base = { key: spec.key, name: spec.name, version: spec.version };
    let want: LoadedBuiltinEvalDataset;
    try {
      want = loadBuiltinEvalDataset(spec, opts.dir);
    } catch (e) {
      const detail = (e as Error).message;
      await db.insert(auditLog).values({
        userId: SYSTEM_USER_ID,
        objectType: "eval_run",
        objectId: null,
        detail: { phase: "builtin-dataset-seed", builtinDataset: spec.key, version: spec.version },
        effect: "deny",
        ruleId: "builtin_dataset_unverifiable",
        ruleChain: [],
        reason: detail,
      });
      report.datasets.push({ ...base, outcome: "unverifiable", datasetId: null, detail });
      continue;
    }
    const find = async () =>
      (await db.select().from(evalDatasets).where(and(eq(evalDatasets.name, spec.name), eq(evalDatasets.version, spec.version))))[0];
    let row = await find();
    if (!row) {
      try {
        row = await db.transaction(async (tx) => {
          const [ds] = await tx
            .insert(evalDatasets)
            .values({
              name: spec.name,
              version: spec.version,
              note: datasetNote(spec),
              scorerKind: want.scorer.scorerKind,
              scorerConfig: want.scorer.scorerConfig,
              createdByUserId: null,
            })
            .returning();
          for (let i = 0; i < want.cases.length; i += 250) {
            await tx.insert(evalCases).values(
              want.cases.slice(i, i + 250).map((c) => ({
                datasetId: ds!.id,
                datasetVersion: ds!.version,
                input: c.input,
                expected: null,
                rubric: c.rubric as never,
                context: c.context,
                contextInPrompt: c.contextInPrompt,
                tags: c.tags,
                scorerKind: null,
                scorerConfig: null,
              })),
            );
          }
          await tx.insert(auditLog).values({
            userId: SYSTEM_USER_ID,
            objectType: "eval_run",
            objectId: ds!.id,
            detail: {
              phase: "builtin-dataset-seed",
              builtinDataset: spec.key,
              datasetName: spec.name,
              version: spec.version,
              cases: want.cases.length,
              sensitivity: spec.sensitivity,
              upstreamCommit: CYBERSECEVAL_PIN.commit,
              fileSha256: CYBERSECEVAL_FILES[spec.file].sha256,
              caseSetDigest: want.digest,
            },
            effect: "allow",
            ruleId: "builtin-dataset-seeded",
            ruleChain: [],
            reason: `built-in eval dataset ${spec.name} v${spec.version} seeded from the pinned vendored file (${want.cases.length} cases); no run was started`,
          });
          return ds!;
        });
        report.datasets.push({ ...base, outcome: "seeded", datasetId: row.id });
        continue;
      } catch (e) {
        // another replica won the (name, version) race: verify what it wrote
        if (!isUniqueViolation(e)) throw e;
        row = await find();
        if (!row) throw e;
      }
    }
    if (await verifyExisting(db, row, want)) {
      report.datasets.push({ ...base, outcome: "unchanged", datasetId: row.id });
    } else {
      const detail = `${spec.name} v${spec.version} exists but its rows are not the pinned content; nothing was changed and every run of it is refused`;
      await db.insert(auditLog).values({
        userId: SYSTEM_USER_ID,
        objectType: "eval_run",
        objectId: row.id,
        detail: { phase: "builtin-dataset-seed", builtinDataset: spec.key, version: spec.version, expectedDigest: want.digest },
        effect: "deny",
        ruleId: "builtin_dataset_drift",
        ruleChain: [],
        reason: detail,
      });
      report.datasets.push({ ...base, outcome: "drifted", datasetId: row.id, detail });
    }
  }
  return report;
}

/** a dataset whose name carries the reserved prefix (seeded content, read-only) */
export function isBuiltinEvalDataset(dataset: { name: string }): boolean {
  return dataset.name.startsWith(BUILTIN_EVAL_DATASET_PREFIX);
}

export type BuiltinRunCheck =
  | { builtin: false }
  | { builtin: true; spec: BuiltinEvalDatasetSpec; refusal: { status: number; error: string; detail: string } | null };

/**
 * Before a run of a built-in dataset: the version must be the current pin, the
 * file must verify, and the rows must be exactly the pinned content.
 */
export async function checkBuiltinEvalDatasetForRun(db: Db, dataset: EvalDatasetRow, dir?: string): Promise<BuiltinRunCheck> {
  if (!isBuiltinEvalDataset(dataset)) return { builtin: false };
  const spec = builtinEvalDatasetByName(dataset.name);
  if (!spec || spec.version !== dataset.version) {
    // an unknown or retired built-in has no pin to verify against: strictest reading
    const placeholder: BuiltinEvalDatasetSpec = spec ?? {
      key: dataset.name.slice(BUILTIN_EVAL_DATASET_PREFIX.length),
      name: dataset.name,
      version: dataset.version,
      file: "interpreter",
      range: [0, 0],
      sensitivity: "offensive",
      measures: "",
      contentBlock: "refusal",
    };
    return {
      builtin: true,
      spec: { ...placeholder, sensitivity: "offensive" },
      refusal: {
        status: 409,
        error: "builtin_dataset_retired",
        detail: `${dataset.name} v${dataset.version} is not a built-in dataset this release pins; it cannot be run`,
      },
    };
  }
  let want: LoadedBuiltinEvalDataset;
  try {
    want = loadBuiltinEvalDataset(spec, dir);
  } catch (e) {
    return { builtin: true, spec, refusal: { status: 409, error: "builtin_dataset_unverifiable", detail: (e as Error).message } };
  }
  const stored = await storedEvalCaseSetDigest(db, dataset);
  if (stored.digest !== want.digest) {
    return {
      builtin: true,
      spec,
      refusal: {
        status: 409,
        error: "builtin_dataset_drift",
        detail: `${dataset.name} v${dataset.version}'s ${stored.cases} stored cases are not the pinned content (${want.cases.length} cases, digest ${want.digest}); nothing was run`,
      },
    };
  }
  return { builtin: true, spec, refusal: null };
}
