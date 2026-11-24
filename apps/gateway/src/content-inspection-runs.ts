/**
 * ADR-0362 slice 1b — THE CONTENT-EXTRACTION RUNS: a `contentextract` `subject` run (trigger `inspection`) turns one
 * request's file bundle into text in the engine sandbox, never in this process (ADR-0362 decision 2, ADR-0190 I5).
 *
 * The request path (slice 1b-ii, not wired yet) calls exactly two functions:
 *   1. `enqueueContentExtractRun` — queue one run for one bundle when the engine is ON (a no-op `engine_off` when off,
 *      the shipped default). The bundle (`{"files": [{id, name, mediaType, dataBase64}], "limits"?}`) is ENCRYPTED
 *      under the data key on the run (`target_subject_input_ciphertext`), and its sha256 is the run's subject digest.
 *      No data key, or a bundle over the extractor's own cap: nothing is queued, the refusal is audited (fail closed).
 *   2. `awaitContentExtractResult` — wait for the run's end (bounded by the caller's deadline) and return the
 *      extractor's result, decrypted and strictly parsed, deleting it as it is read; anything else is `unavailable`,
 *      which the caller treats as a refusal of every file (fail closed). At the deadline it cancels the run, so a late
 *      result is never stored for nobody to read.
 *
 * And the engine hooks (called by admission-scan-runs.ts, engine-tasks.ts and engine-runs.ts):
 *   - `contentExtractInputTx` — the run's one input file, `bundle.json`: the decrypted bundle, checked against the
 *     run's digest. Lease and task start both call it; a refusal ends the run `not_run`.
 *   - `recordContentExtractRunEndTx` — at the run's end, in its transaction: a completed run whose task was placed,
 *     whose placed input was exactly the bundle, that nobody cancelled, and whose report parses with
 *     `contentExtractResultSchema` and names exactly the bundle's files in order, stores the result ENCRYPTED in
 *     `content_inspection_results`. Anything else stores nothing (fail closed). The run's end clears the bundle
 *     ciphertext either way (engine-runs.ts `endLockedRun`), and the raw report is never kept on the run.
 *   - `contentExtractRunSensitivity` — the placement sensitivity of a run with no project.
 *
 * The extracted text is a person's file content: it never reaches a log, an audit row, a route or the run's summary.
 * This module imports nothing from engine-runs.ts (that module imports this one); the data key and the cancel reach it
 * through `setContentInspectionRuntime`, which `setEngineRuntime` calls.
 */
import { createHash } from "node:crypto";
import { and, auditLog, contentInspectionResults, engineRuns, engines, eq, orgSettings, ORG_SETTINGS_ID, type Db, type EngineRunRow } from "@regulait/db";
import {
  CONTENTEXTRACT_MAX_BUNDLE_BYTES,
  CONTENTEXTRACT_SET,
  CONTENTEXTRACT_SUBJECT_FILE,
  contentExtractResultSchema,
  ENGINE_ROW_LIMITS,
  isTerminalEngineRunStatus,
  PLACEMENT_SENSITIVITIES,
  type ContentExtractResult,
  type EngineTerminalRunStatus,
  type PlacementSensitivity,
} from "@regulait/shared";
import { databaseWallNow } from "./db-clock.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export const CONTENTEXTRACT_ENGINE_ID = "contentextract" as const;

/**
 * The placement sensitivity of a content-extraction run with NO project, when the caller names none: the admission
 * scans' (`confidential`, ADR-0242 §6.1), the floor whose shipped class is the gVisor sandbox. With a project, the
 * project's own sensitivity decides (`resolveRequirement`, owner decision D), as for every project run.
 */
export const CONTENT_EXTRACT_DEFAULT_SENSITIVITY: PlacementSensitivity = "confidential";

/**
 * How long a queued run may wait for a lease. The request that queued it waits seconds, not the 24 hours an engine run
 * may queue for (ENGINE_QUEUE_TTL_SECONDS); an expired run ends `not_run` and its bundle ciphertext is cleared.
 */
export const CONTENT_EXTRACT_QUEUE_TTL_SECONDS = 120;

const NIL_USER = "00000000-0000-0000-0000-000000000000";

let dataKey: string | undefined;
let cancelRun: ((db: Db, runId: string, cause: string) => Promise<void>) | undefined;
/** set by `setEngineRuntime` (engine-runs.ts): the data key the bundle and the result are encrypted under, and the cancel */
export function setContentInspectionRuntime(opts: { dataKey?: string | undefined; cancelRun?: (db: Db, runId: string, cause: string) => Promise<void> }): void {
  dataKey = opts.dataKey;
  cancelRun = opts.cancelRun;
}

const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type ContentExtractEnqueueOutcome =
  | { kind: "queued"; runId: string }
  | { kind: "engine_off" }
  | { kind: "refused"; code: "no_data_key" | "bundle_too_large" | "bundle_empty" };

/**
 * Queue a content-extraction run for one bundle. `userId` and `projectId` are the request's (attribution and the
 * placement's sensitivity); `sensitivity` is used only when there is no project.
 */
export async function enqueueContentExtractRun(
  db: Db,
  args: { bundleJson: string; projectId: string | null; userId: string | null; sensitivity?: PlacementSensitivity | null },
): Promise<ContentExtractEnqueueOutcome> {
  // the cheap, lock-free check first: with the engine off (the default) nothing else happens at all
  const [probe] = await db.select({ enabled: engines.enabled }).from(engines).where(eq(engines.id, CONTENTEXTRACT_ENGINE_ID));
  if (!probe?.enabled) return { kind: "engine_off" };

  const bytes = Buffer.byteLength(args.bundleJson, "utf8");
  const refusal: "no_data_key" | "bundle_too_large" | "bundle_empty" | null =
    bytes === 0 ? "bundle_empty" : bytes > CONTENTEXTRACT_MAX_BUNDLE_BYTES ? "bundle_too_large" : !dataKey ? "no_data_key" : null;
  const digest = sha256Hex(args.bundleJson);
  if (refusal) {
    await db.insert(auditLog).values({
      userId: args.userId ?? NIL_USER,
      objectType: "engine_run",
      objectId: null,
      detail: { phase: "content-inspection-queue", engineId: CONTENTEXTRACT_ENGINE_ID, projectId: args.projectId, bytes, code: refusal },
      effect: "deny",
      ruleId: "content-inspection-not-queued",
      ruleChain: [],
      reason: `no content-extraction run was queued for a ${bytes}-byte bundle (${refusal}); every file in it is treated as not inspectable`,
    });
    return { kind: "refused", code: refusal };
  }
  const sensitivity = args.sensitivity && (PLACEMENT_SENSITIVITIES as readonly string[]).includes(args.sensitivity) ? args.sensitivity : CONTENT_EXTRACT_DEFAULT_SENSITIVITY;
  const ciphertext = encryptSecret(dataKey!, args.bundleJson);

  return db.transaction(async (tx) => {
    // lock order as createEngineRun: org settings, then the engine row, both FOR SHARE
    await tx.select({ id: orgSettings.id }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID)).for("share");
    const [engine] = await tx.select().from(engines).where(eq(engines.id, CONTENTEXTRACT_ENGINE_ID)).for("share");
    if (!engine?.enabled) return { kind: "engine_off" as const };
    const now = await databaseWallNow(tx);
    // the run is awaited on a request path: the shortest deadline the row allows (60 s), which is within every engine
    // and org bound (engines_timeout_check, engineMaxRunTimeoutMinutes >= 1); the extractor stops itself at 20 s
    const timeoutSeconds = ENGINE_ROW_LIMITS.timeoutSeconds.min;
    const [row] = await tx
      .insert(engineRuns)
      .values({
        engineId: CONTENTEXTRACT_ENGINE_ID,
        engineVersion: engine.version,
        status: "queued",
        trigger: "inspection",
        runAsUserId: args.userId,
        projectId: args.projectId,
        targetKind: "subject",
        targetSubjectDigest: digest,
        targetSubjectInputCiphertext: ciphertext,
        // the placement sensitivity travels with the run (read only when it has no project); no other parameter
        config: { sets: [CONTENTEXTRACT_SET], params: { sensitivity } },
        configHash: sha256Hex(JSON.stringify({ engineId: CONTENTEXTRACT_ENGINE_ID, digest, sensitivity })),
        trials: 1,
        // no model access: the smallest budget the row allows (the CHECK needs > 0); nothing is ever spent
        budgetUsd: ENGINE_ROW_LIMITS.maxBudgetUsd.min,
        timeoutSeconds,
        queueExpiresAt: new Date(now.getTime() + CONTENT_EXTRACT_QUEUE_TTL_SECONDS * 1000),
      })
      .returning({ id: engineRuns.id });
    await tx.insert(auditLog).values({
      userId: args.userId ?? NIL_USER,
      objectType: "engine_run",
      objectId: row!.id,
      // never the bundle or a file name: its size and digest only
      detail: { phase: "content-inspection-queue", engineId: CONTENTEXTRACT_ENGINE_ID, projectId: args.projectId, bytes, digest },
      effect: "allow",
      ruleId: "engine-run-created",
      ruleChain: [],
      reason: `content extraction queued for a ${bytes}-byte bundle at digest ${digest.slice(0, 12)}`,
    });
    return { kind: "queued" as const, runId: row!.id };
  });
}

/** the placement sensitivity of a content-extraction run with no project (its queued value, else the default) */
export function contentExtractRunSensitivity(run: Pick<EngineRunRow, "config">): PlacementSensitivity {
  const s = (run.config as { params?: Record<string, unknown> } | null)?.params?.sensitivity;
  return typeof s === "string" && (PLACEMENT_SENSITIVITIES as readonly string[]).includes(s) ? (s as PlacementSensitivity) : CONTENT_EXTRACT_DEFAULT_SENSITIVITY;
}

export type ContentExtractInput = { ok: true; file: string; bytes: Buffer; sha256: string } | { ok: false; code: "subject_input_gone" };

/** the bundle a run carries, decrypted and checked against its digest; null when it is gone or does not match */
function bundleOf(run: Pick<EngineRunRow, "targetSubjectInputCiphertext" | "targetSubjectDigest">): string | null {
  if (!run.targetSubjectInputCiphertext || !run.targetSubjectDigest || !dataKey) return null;
  let json: string;
  try {
    json = decryptSecret(dataKey, run.targetSubjectInputCiphertext);
  } catch {
    return null;
  }
  return sha256Hex(json) === run.targetSubjectDigest ? json : null;
}

/** the run's one input file: exactly the bundle the request queued, under the name the extractor reads */
export async function contentExtractInputTx(_tx: Exec, run: EngineRunRow): Promise<ContentExtractInput> {
  const json = bundleOf(run);
  if (json === null) return { ok: false, code: "subject_input_gone" };
  const bytes = Buffer.from(json, "utf8");
  return { ok: true, file: CONTENTEXTRACT_SUBJECT_FILE, bytes, sha256: sha256Hex(bytes) };
}

/** the ids of the bundle's files, in order (null: not a bundle the extractor would read) */
function bundleFileIds(json: string): string[] | null {
  try {
    const b = JSON.parse(json) as { files?: unknown };
    if (!Array.isArray(b.files)) return null;
    return b.files.map((f) => (f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string" ? (f as { id: string }).id : ""));
  } catch {
    return null;
  }
}

/**
 * At a content-extraction run's end, in its transaction (`locked` is the run as it was before the end): store the
 * extractor's result, encrypted, only when every condition holds; otherwise store nothing. Returns whether it stored.
 */
export async function recordContentExtractRunEndTx(
  tx: Tx,
  locked: EngineRunRow,
  args: { status: EngineTerminalRunStatus; placed: boolean; report: unknown },
): Promise<boolean> {
  if (locked.engineId !== CONTENTEXTRACT_ENGINE_ID || locked.targetKind !== "subject" || locked.status !== "leased") return false;
  if (args.status !== "completed" || !args.placed || locked.cancelRequestedAt !== null || !dataKey) return false;
  // the task placed exactly the queued bundle (task start recorded its sha256, which is the bundle's digest)
  if (!locked.targetSubjectInputSha256 || locked.targetSubjectInputSha256 !== locked.targetSubjectDigest) return false;
  const parsed = contentExtractResultSchema.safeParse(args.report);
  if (!parsed.success) return false;
  // the result answers for exactly the bundle's files, in order: an extractor that drops or adds a file is not believed
  const bundle = bundleOf(locked);
  const ids = bundle === null ? null : bundleFileIds(bundle);
  if (ids === null || ids.length !== parsed.data.files.length || ids.some((id, i) => id !== parsed.data.files[i]!.id)) return false;
  const plaintext = JSON.stringify(parsed.data);
  await tx
    .insert(contentInspectionResults)
    .values({ runId: locked.id, resultCiphertext: encryptSecret(dataKey, plaintext), resultSha256: sha256Hex(plaintext) })
    .onConflictDoNothing();
  return true;
}

export type ContentExtractAwaitOutcome =
  | { kind: "result"; result: ContentExtractResult }
  | { kind: "unavailable"; reason: "timeout" | "not_run" | "failed" | "no_result" };

/** read and delete a run's stored result (one statement: a result is read once); null when absent or unreadable */
async function takeResult(db: Db, runId: string): Promise<ContentExtractResult | null> {
  const [row] = await db.delete(contentInspectionResults).where(eq(contentInspectionResults.runId, runId)).returning();
  if (!row || !dataKey) return null;
  let plaintext: string;
  try {
    plaintext = decryptSecret(dataKey, row.resultCiphertext);
  } catch {
    return null;
  }
  if (sha256Hex(plaintext) !== row.resultSha256) return null;
  try {
    const parsed = contentExtractResultSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Wait for a content-extraction run to end, at most `deadlineMs`, polling its status every `pollMs`. Fail closed: only
 * a completed run with a stored, readable result returns `result`; every other outcome is `unavailable`. At the
 * deadline the run is cancelled (so its result, if it comes, is never stored) and any stored result is deleted.
 */
export async function awaitContentExtractResult(db: Db, runId: string, opts: { deadlineMs: number; pollMs?: number }): Promise<ContentExtractAwaitOutcome> {
  const pollMs = Math.max(10, opts.pollMs ?? 100);
  const until = Date.now() + Math.max(0, opts.deadlineMs);
  for (;;) {
    const [run] = await db
      .select({ status: engineRuns.status, engineId: engineRuns.engineId })
      .from(engineRuns)
      .where(and(eq(engineRuns.id, runId), eq(engineRuns.engineId, CONTENTEXTRACT_ENGINE_ID)));
    if (!run) return { kind: "unavailable", reason: "no_result" };
    if (isTerminalEngineRunStatus(run.status)) {
      const result = await takeResult(db, runId);
      if (run.status === "completed") return result ? { kind: "result", result } : { kind: "unavailable", reason: "no_result" };
      return { kind: "unavailable", reason: run.status === "failed" || run.status === "timeout" ? "failed" : "not_run" };
    }
    const left = until - Date.now();
    if (left <= 0) break;
    await new Promise((res) => setTimeout(res, Math.min(pollMs, left)));
  }
  // the caller gave up: end the run (a late result is then never stored) and drop anything that raced in
  try {
    await cancelRun?.(db, runId, "content_inspection_deadline");
  } catch {
    // the run's own deadline and the queue expiry still end it; the result hook stores nothing for a cancelled run
  }
  await db.delete(contentInspectionResults).where(eq(contentInspectionResults.runId, runId));
  return { kind: "unavailable", reason: "timeout" };
}
