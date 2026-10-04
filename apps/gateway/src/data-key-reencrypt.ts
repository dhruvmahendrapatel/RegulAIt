/**
 * ADR-0063 §4's NAMED FOLLOW-UP — THE KEY RE-ENCRYPTION WALK (batch B4).
 *
 * `REGULAIT_DATA_KEY_ROTATED_FROM` re-records the fingerprint and says
 * outright that it re-encrypted nothing. This module is the other half: with
 * BOTH keys present, every ciphertext row is genuinely re-encrypted under the
 * new key — in bounded batches, each batch inside one transaction, restartable
 * after a crash, and refusing to lie about progress.
 *
 * ## Invocation — a CLI, deliberately NOT an HTTP mutation
 *
 *     REGULAIT_DATA_KEY=<new key> REGULAIT_DATA_KEY_OLD=<old key> \
 *       pnpm --filter @regulait/gateway reencrypt
 *
 * The walk visits every row of thirteen ciphertext columns. On a real
 * deployment that is minutes of work holding two live keys; running it inside
 * an HTTP request invites a proxy/client timeout mid-walk, and a "retry" from
 * a confused operator racing the first attempt. So the walk runs only as a
 * foreground CLI (the seed-script idiom), and the admin surface gets a
 * STATUS-ONLY endpoint (`GET /v1/security/data-key/reencryption`) — an
 * operator watches progress over HTTP, they do not drive it over HTTP.
 *
 * Note the env contract: `REGULAIT_DATA_KEY_ROTATED_FROM` holds the old key's
 * FINGERPRINT (a PRF output — it cannot decrypt anything), so the walk needs a
 * new variable, `REGULAIT_DATA_KEY_OLD`, holding the old key's full 64 hex
 * chars. Both full keys must be present; the walk refuses to start otherwise.
 *
 * ## Resumability — the watermark IS the transaction
 *
 * Progress lives in `data_key_reencryption_progress`, one row per
 * (run, table, column), holding the PK watermark of the last settled row.
 * Every batch commits its re-encrypted rows AND its watermark advance in the
 * SAME transaction, so "these rows are under the new key" and "the walk is
 * past them" can never disagree. A kill at any instant leaves the run
 * `running`; the next invocation with the same two keys finds it and resumes
 * from the exact watermark — no double-processing (already-committed rows are
 * behind the watermark and are never read again), no missed rows (uncommitted
 * work rolled back with its watermark).
 *
 * ## Which key is a row under?
 *
 * Since batch B4, `encryptSecret` embeds the encrypting key's fingerprint as
 * a fourth ciphertext segment. Rows carrying the NEW key's marker are skipped
 * idempotently without decryption. LEGACY three-segment rows (every write
 * before this change) are resolved by trial decryption — old key first, then
 * new — and rewritten WITH the marker either way, so a second walk over the
 * same data does no cryptographic work. The marker is a claim, not a proof:
 * anything actually rewritten went through a real decrypt (GCM tag verified)
 * first.
 *
 * ## Honesty
 *
 * A row that decrypts under NEITHER key is recorded (table + id) in
 * `data_key_reencryption_failures` and the walk CONTINUES — one corrupt row
 * must not brick a key rotation — but the run's final status is
 * `completed_with_failures`, never `completed`. The completion record (rows
 * walked per table, failures, duration) is written to the audit trail.
 *
 * ## Fail closed on registry drift
 *
 * `CIPHERTEXT_COLUMNS` is the single source of truth for what the walk must
 * visit. Before touching anything, the walk asks `information_schema` for
 * every `*_ciphertext` column in the live database and REFUSES to start if
 * one exists that the list does not name — a column the walk would silently
 * leave under the old key is precisely the two-keys-in-one-database state
 * ADR-0063 §3.2 calls the worst outcome. (The custody test already pins the
 * list against schema.ts; this check pins it against the actual database the
 * walk is about to modify.)
 */

import type { FastifyInstance } from "fastify";
import {
  auditLog,
  dataKeyReencryptionFailures,
  dataKeyReencryptionProgress,
  dataKeyReencryptionRuns,
  dataKeyState,
  desc,
  eq,
  sql,
  type DataKeyReencryptionRunRow,
  type Db,
} from "@regulait/db";
import {
  CIPHERTEXT_COLUMNS,
  DATA_KEY_ENV,
  DATA_KEY_OLD_ENV,
  REENCRYPT_COMMAND,
} from "./data-key.js";
import { dataKeyFingerprint, decryptSecret, encryptSecret, storedKeyFingerprint } from "./secrets.js";

export { DATA_KEY_OLD_ENV, REENCRYPT_COMMAND } from "./data-key.js";

/** stable ruleIds, same convention as DATA_KEY_RULE_IDS */
export const REENCRYPTION_RULE_IDS = {
  started: "data-key-reencryption-started",
  resumed: "data-key-reencryption-resumed",
  completed: "data-key-reencryption-completed",
} as const;

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const DEFAULT_BATCH_SIZE = 100;

/** thrown by the test hook that simulates a kill mid-walk. Everything already
 * committed stays committed — that is the point of the simulation. */
export class ReencryptionAborted extends Error {
  constructor(readonly batchesCommitted: number) {
    super(`re-encryption aborted after ${batchesCommitted} committed batch(es) (test hook)`);
    this.name = "ReencryptionAborted";
  }
}

export interface ReencryptWalkOptions {
  /** the NEW key (REGULAIT_DATA_KEY) — 64 hex chars */
  newKeyHex: string | undefined | null;
  /** the OLD key (REGULAIT_DATA_KEY_OLD) — the full key, not the fingerprint */
  oldKeyHex: string | undefined | null;
  batchSize?: number;
  /** TEST HOOK: throw ReencryptionAborted after this many COMMITTED batches,
   * simulating a kill. Committed work stays committed. */
  abortAfterBatches?: number;
  log?: (line: string) => void;
}

export interface ColumnOutcome {
  table: string;
  column: string;
  reencrypted: number;
  alreadyCurrent: number;
  failed: number;
}

export type ReencryptOutcome =
  | { kind: "refused"; reason: string }
  | { kind: "nothing_to_do"; message: string }
  | {
      kind: "completed" | "completed_with_failures";
      runId: string;
      resumed: boolean;
      fromFingerprint: string;
      toFingerprint: string;
      perColumn: ColumnOutcome[];
      failures: Array<{ table: string; column: string; rowId: string }>;
      durationMs: number;
    };

function normalizeKey(raw: string | undefined | null): string | null {
  const k = raw?.trim() ?? "";
  return /^[0-9a-fA-F]{64}$/.test(k) ? k.toLowerCase() : null;
}

function tryDecrypt(keyHex: string, stored: string): string | null {
  try {
    return decryptSecret(keyHex, stored);
  } catch {
    return null;
  }
}

interface ExecRows {
  rows: Array<Record<string, unknown>>;
}
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  return (res as ExecRows).rows ?? [];
}

/**
 * The fail-closed registry check: every `*_ciphertext` column that actually
 * exists in the database must be named by CIPHERTEXT_COLUMNS, and vice versa.
 * Cheap (one information_schema query), so it runs on every invocation.
 */
export async function findCiphertextRegistryDrift(db: Db): Promise<string[]> {
  // `\_` = a literal underscore under LIKE's default backslash escape
  const res = await db.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name LIKE ${"%\\_ciphertext"}
  `);
  const inDb = new Set(rowsOf(res).map((r) => `${r.table_name}.${r.column_name}`));
  const declared = new Set(CIPHERTEXT_COLUMNS.map((c) => `${c.table}.${c.column}`));
  const drift: string[] = [];
  for (const col of inDb) if (!declared.has(col)) drift.push(`${col} exists in the database but is NOT in CIPHERTEXT_COLUMNS`);
  for (const col of declared) if (!inDb.has(col)) drift.push(`${col} is in CIPHERTEXT_COLUMNS but does NOT exist in the database`);
  return drift.sort();
}

/** rows whose stored marker is not the given fingerprint (legacy unmarked rows
 * count — they have not been settled by a walk under this key). */
async function countRowsNotUnder(db: Db, fingerprintBody: string): Promise<number> {
  let total = 0;
  for (const c of CIPHERTEXT_COLUMNS) {
    const res = await db.execute(
      sql.raw(
        `SELECT count(*)::int AS n FROM ${c.table} WHERE ${c.column} IS NOT NULL ` +
          `AND split_part(${c.column}, '.', 4) <> '${fingerprintBody}'`,
      ),
    );
    total += Number(rowsOf(res)[0]?.n ?? 0);
  }
  return total;
}

async function audit(db: Db, ruleId: string, reason: string, detail: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({
    userId: NIL_USER,
    objectType: "data_key",
    objectId: null,
    detail: { subsystem: "data-key-reencryption", ...detail },
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
  });
}

/**
 * THE WALK. See the module header for the design; the shape of the return
 * value is the honesty contract — `refused` never touched anything,
 * `nothing_to_do` proved there was nothing to touch, and a finished run
 * distinguishes `completed` from `completed_with_failures`.
 */
export async function runReencryptionWalk(db: Db, opts: ReencryptWalkOptions): Promise<ReencryptOutcome> {
  const log = opts.log ?? (() => {});
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);

  // -- 1. both keys, well-formed, distinct -------------------------------
  const newKey = normalizeKey(opts.newKeyHex);
  const oldKey = normalizeKey(opts.oldKeyHex);
  if (newKey === null || oldKey === null) {
    return {
      kind: "refused",
      reason:
        `re-encryption needs BOTH keys in the environment: ${DATA_KEY_ENV} (the new key) and ` +
        `${DATA_KEY_OLD_ENV} (the OLD key's full 64 hex chars — not its fingerprint; ` +
        `REGULAIT_DATA_KEY_ROTATED_FROM holds a fingerprint, which cannot decrypt anything). ` +
        `Missing or malformed: ${[
          newKey === null ? DATA_KEY_ENV : null,
          oldKey === null ? DATA_KEY_OLD_ENV : null,
        ]
          .filter(Boolean)
          .join(", ")}.`,
    };
  }
  const fpNew = dataKeyFingerprint(newKey);
  const fpOld = dataKeyFingerprint(oldKey);
  const fpNewBody = fpNew.slice(fpNew.indexOf(":") + 1);
  if (fpNew === fpOld) {
    return { kind: "refused", reason: `${DATA_KEY_ENV} and ${DATA_KEY_OLD_ENV} are the SAME key (${fpNew}) — there is nothing to rotate between.` };
  }

  // -- 2. fail closed on registry drift ----------------------------------
  const drift = await findCiphertextRegistryDrift(db);
  if (drift.length > 0) {
    return {
      kind: "refused",
      reason:
        `REFUSING TO WALK: CIPHERTEXT_COLUMNS disagrees with the live schema, so the walk ` +
        `cannot promise to visit every ciphertext row:\n  - ${drift.join("\n  - ")}\n` +
        `A column the walk silently left under the old key is the two-keys-in-one-database ` +
        `state ADR-0063 exists to prevent. Fix the registry first.`,
    };
  }

  // -- 3. resume, refuse a conflicting run, or start fresh ---------------
  const [pending] = await db
    .select()
    .from(dataKeyReencryptionRuns)
    .where(eq(dataKeyReencryptionRuns.status, "running"))
    .orderBy(desc(dataKeyReencryptionRuns.startedAt))
    .limit(1);

  if (pending && (pending.fromFingerprint !== fpOld || pending.toFingerprint !== fpNew)) {
    return {
      kind: "refused",
      reason:
        `an UNFINISHED walk ${pending.fromFingerprint} -> ${pending.toFingerprint} (run ${pending.id}) ` +
        `exists, and the keys in this environment describe a different rotation (${fpOld} -> ${fpNew}). ` +
        `Finish or investigate the pending run first — two interleaved walks under different keys ` +
        `cannot both keep their promises.`,
    };
  }

  let run: DataKeyReencryptionRunRow;
  let resumed: boolean;
  if (pending) {
    run = pending;
    resumed = true;
    await audit(db, REENCRYPTION_RULE_IDS.resumed, `re-encryption walk ${fpOld} -> ${fpNew} RESUMED (run ${run.id})`, {
      runId: run.id, from: fpOld, to: fpNew,
    });
    log(`resuming unfinished walk ${run.id} (${fpOld} -> ${fpNew})`);
  } else {
    // -- nothing to do? Only checked when no run needs finishing: the
    // recorded fingerprint already names the new key AND zero rows remain
    // outside it. Exit 0 and say so — an idempotent re-invocation is not an
    // error, and pretending work happened would be a lie in the other
    // direction.
    // single-row by PK + CHECK (id='singleton') from migration 0075 — see the
    // note on `readState` in data-key.ts; ADR-0107's "convention only" entry
    // was wrong and ADR-0109 adds no constraint here.
    // single-row by PK + CHECK (id='singleton'); see data-key.ts `readState`.
  const [state] = await db.select().from(dataKeyState).limit(1);
    if (state?.fingerprint === fpNew && (await countRowsNotUnder(db, fpNewBody)) === 0) {
      return {
        kind: "nothing_to_do",
        message:
          `nothing to do: the recorded fingerprint is already ${fpNew} and every ciphertext row ` +
          `carries its marker. The old key (${fpOld}) is no longer needed — destroy it per the ` +
          `custody runbook (docs/ops/DB_BACKUP.md).`,
      };
    }
    const [created] = await db
      .insert(dataKeyReencryptionRuns)
      .values({ fromFingerprint: fpOld, toFingerprint: fpNew })
      .returning();
    run = created!;
    resumed = false;
    await db.insert(dataKeyReencryptionProgress).values(
      CIPHERTEXT_COLUMNS.map((c) => ({ runId: run.id, tableName: c.table, columnName: c.column })),
    );
    await audit(db, REENCRYPTION_RULE_IDS.started, `re-encryption walk ${fpOld} -> ${fpNew} STARTED (run ${run.id})`, {
      runId: run.id, from: fpOld, to: fpNew, batchSize, columns: CIPHERTEXT_COLUMNS.length,
    });
    log(`starting walk ${run.id} (${fpOld} -> ${fpNew}), ${CIPHERTEXT_COLUMNS.length} columns, batches of ${batchSize}`);
  }

  // -- 4. the walk itself -------------------------------------------------
  const startedAt = Date.now();
  let batchesCommitted = 0;

  for (const c of CIPHERTEXT_COLUMNS) {
    const [progress] = await db
      .select()
      .from(dataKeyReencryptionProgress)
      .where(
        sql`${dataKeyReencryptionProgress.runId} = ${run.id}
            AND ${dataKeyReencryptionProgress.tableName} = ${c.table}
            AND ${dataKeyReencryptionProgress.columnName} = ${c.column}`,
      )
      .limit(1);
    if (!progress) throw new Error(`no progress row for ${c.table}.${c.column} in run ${run.id}`);
    if (progress.done) continue;

    let watermark = progress.watermark;
    for (;;) {
      // One batch = one transaction. The SELECT ... FOR UPDATE pins the rows
      // against a concurrent credential edit; the watermark advance commits
      // with the rewrites or not at all.
      const finished = await db.transaction(async (tx) => {
        // ADR-0175 A7: a re-encryption rewrites ciphertext, not the secret —
        // tell migration 0142's `regulait_stamp_secret_set` trigger so the
        // credential's "last set" date stays the date a human set it
        await tx.execute(sql`SELECT set_config('regulait.secret_reencrypt', 'on', true)`);
        const where =
          `${c.column} IS NOT NULL` + (watermark ? ` AND id > '${watermark}'` : "");
        const res = await tx.execute(
          sql.raw(
            `SELECT id, ${c.column} AS v FROM ${c.table} WHERE ${where} ORDER BY id LIMIT ${batchSize} FOR UPDATE`,
          ),
        );
        const rows = rowsOf(res) as Array<{ id: string; v: string }>;

        let reencrypted = 0;
        let alreadyCurrent = 0;
        let failed = 0;
        for (const row of rows) {
          if (storedKeyFingerprint(row.v) === fpNew) {
            // settled by a previous batch/run — idempotent skip, no decryption
            alreadyCurrent += 1;
            continue;
          }
          const underOld = tryDecrypt(oldKey, row.v);
          if (underOld !== null) {
            await tx.execute(
              sql`UPDATE ${sql.raw(c.table)} SET ${sql.raw(c.column)} = ${encryptSecret(newKey, underOld)} WHERE id = ${row.id}`,
            );
            reencrypted += 1;
            continue;
          }
          const underNew = tryDecrypt(newKey, row.v);
          if (underNew !== null) {
            // a LEGACY (unmarked) value already written under the new key —
            // rewrite it with the marker so no future walk decrypts it again
            await tx.execute(
              sql`UPDATE ${sql.raw(c.table)} SET ${sql.raw(c.column)} = ${encryptSecret(newKey, underNew)} WHERE id = ${row.id}`,
            );
            alreadyCurrent += 1;
            continue;
          }
          // NEITHER key opens it. Record the corpse and keep walking — but the
          // run can now never report `completed`.
          await tx
            .insert(dataKeyReencryptionFailures)
            .values({ runId: run.id, tableName: c.table, columnName: c.column, rowId: row.id, detail: "decrypts under neither the old nor the new key" })
            .onConflictDoNothing();
          failed += 1;
        }

        const last = rows.at(-1)?.id ?? null;
        const done = rows.length < batchSize;
        await tx
          .update(dataKeyReencryptionProgress)
          .set({
            watermark: last ?? watermark,
            done,
            rowsReencrypted: sql`${dataKeyReencryptionProgress.rowsReencrypted} + ${reencrypted}`,
            rowsAlreadyCurrent: sql`${dataKeyReencryptionProgress.rowsAlreadyCurrent} + ${alreadyCurrent}`,
            rowsFailed: sql`${dataKeyReencryptionProgress.rowsFailed} + ${failed}`,
            updatedAt: new Date(),
          })
          .where(eq(dataKeyReencryptionProgress.id, progress.id));

        watermark = last ?? watermark;
        return done;
      });

      batchesCommitted += 1;
      if (opts.abortAfterBatches !== undefined && batchesCommitted >= opts.abortAfterBatches) {
        throw new ReencryptionAborted(batchesCommitted);
      }
      if (finished) break;
    }
    log(`  ${c.table}.${c.column}: done`);
  }

  // -- 5. finalize, honestly ---------------------------------------------
  const perColumnRows = await db
    .select()
    .from(dataKeyReencryptionProgress)
    .where(eq(dataKeyReencryptionProgress.runId, run.id));
  const perColumn: ColumnOutcome[] = CIPHERTEXT_COLUMNS.map((c) => {
    const p = perColumnRows.find((r) => r.tableName === c.table && r.columnName === c.column)!;
    return { table: c.table, column: c.column, reencrypted: p.rowsReencrypted, alreadyCurrent: p.rowsAlreadyCurrent, failed: p.rowsFailed };
  });
  const failureRows = await db
    .select()
    .from(dataKeyReencryptionFailures)
    .where(eq(dataKeyReencryptionFailures.runId, run.id));
  const failures = failureRows.map((f) => ({ table: f.tableName, column: f.columnName, rowId: f.rowId }));

  const status = failures.length > 0 ? ("completed_with_failures" as const) : ("completed" as const);
  const durationMs = Date.now() - startedAt;
  await db
    .update(dataKeyReencryptionRuns)
    .set({ status, finishedAt: new Date() })
    .where(eq(dataKeyReencryptionRuns.id, run.id));

  // Re-record the fingerprint: every row that CAN be under the new key now is,
  // so the deployment's ciphertext identity has genuinely changed. This is
  // done even for completed_with_failures — the failed rows decrypt under
  // NEITHER key, so keeping the old fingerprint recorded would not make them
  // readable; it would only force the next boot to declare a rotation it has
  // in fact already performed. The failure record, not the fingerprint, is
  // what says those rows are lost.
  const [state] = await db.select().from(dataKeyState).limit(1);
  if (state && state.fingerprint !== fpNew) {
    await db
      .update(dataKeyState)
      .set({ fingerprint: fpNew, rotatedFrom: state.fingerprint, rotatedAt: new Date(), recordedAt: new Date(), lastVerifiedAt: new Date() })
      .where(eq(dataKeyState.id, state.id));
  } else if (!state) {
    await db.insert(dataKeyState).values({ fingerprint: fpNew });
  }

  const totals = perColumn.reduce(
    (acc, c) => ({ reencrypted: acc.reencrypted + c.reencrypted, alreadyCurrent: acc.alreadyCurrent + c.alreadyCurrent, failed: acc.failed + c.failed }),
    { reencrypted: 0, alreadyCurrent: 0, failed: 0 },
  );
  await audit(
    db,
    REENCRYPTION_RULE_IDS.completed,
    `re-encryption walk ${fpOld} -> ${fpNew} finished: ${status}. ` +
      `${totals.reencrypted} row(s) re-encrypted, ${totals.alreadyCurrent} already current, ` +
      `${totals.failed} FAILED (decrypt under neither key), in ${durationMs}ms.` +
      (failures.length > 0
        ? ` Failed rows: ${failures.map((f) => `${f.table}.${f.column}#${f.rowId}`).join(", ")}.`
        : ` The old key ${fpOld} is no longer needed — destroy it per the custody runbook.`),
    { runId: run.id, from: fpOld, to: fpNew, status, durationMs, perTable: perColumn, failures },
  );

  return { kind: status, runId: run.id, resumed, fromFingerprint: fpOld, toFingerprint: fpNew, perColumn, failures, durationMs };
}

// ---------------------------------------------------------------------------
// STATUS — readable over HTTP; the walk itself is not drivable over HTTP
// ---------------------------------------------------------------------------

export interface ReencryptionStatus {
  run:
    | {
        id: string;
        fromFingerprint: string;
        toFingerprint: string;
        status: string;
        startedAt: Date;
        finishedAt: Date | null;
        perColumn: Array<{ table: string; column: string; watermark: string | null; done: boolean; reencrypted: number; alreadyCurrent: number; failed: number }>;
        failures: Array<{ table: string; column: string; rowId: string; detail: string | null; recordedAt: Date }>;
      }
    | null;
  resumeCommand: string;
  note: string;
}

/** the read behind `GET /v1/security/data-key/reencryption` and the boot-time
 * incomplete-walk warning. */
export async function reencryptionStatus(db: Db): Promise<ReencryptionStatus> {
  const [run] = await db
    .select()
    .from(dataKeyReencryptionRuns)
    .orderBy(desc(dataKeyReencryptionRuns.startedAt))
    .limit(1);
  if (!run) {
    return {
      run: null,
      resumeCommand: REENCRYPT_COMMAND,
      note:
        "No re-encryption walk has ever run on this deployment. The walk runs as a CLI " +
        "(see resumeCommand) — deliberately not over HTTP, where a proxy timeout mid-walk " +
        "and an operator retry racing the first attempt are both live risks.",
    };
  }
  const progress = await db
    .select()
    .from(dataKeyReencryptionProgress)
    .where(eq(dataKeyReencryptionProgress.runId, run.id));
  const failures = await db
    .select()
    .from(dataKeyReencryptionFailures)
    .where(eq(dataKeyReencryptionFailures.runId, run.id));
  return {
    run: {
      id: run.id,
      fromFingerprint: run.fromFingerprint,
      toFingerprint: run.toFingerprint,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      perColumn: progress.map((p) => ({
        table: p.tableName,
        column: p.columnName,
        watermark: p.watermark,
        done: p.done,
        reencrypted: p.rowsReencrypted,
        alreadyCurrent: p.rowsAlreadyCurrent,
        failed: p.rowsFailed,
      })),
      failures: failures.map((f) => ({ table: f.tableName, column: f.columnName, rowId: f.rowId, detail: f.detail, recordedAt: f.recordedAt })),
    },
    resumeCommand: REENCRYPT_COMMAND,
    note:
      run.status === "running"
        ? "This walk is INCOMPLETE — ciphertext currently exists under two keys. Resume it with resumeCommand; the watermark guarantees no row is processed twice or missed."
        : run.status === "completed_with_failures"
          ? "The walk finished but some rows decrypted under NEITHER key — they are enumerated in failures and are unrecoverable without out-of-band action. Everything else is under the new key."
          : "The walk completed. The old key is no longer needed and should be destroyed per the custody runbook.",
  };
}

/** the pending (status = running) walk, or null — what the boot line warns
 * about. */
export async function pendingReencryptionRun(db: Db): Promise<DataKeyReencryptionRunRow | null> {
  const [run] = await db
    .select()
    .from(dataKeyReencryptionRuns)
    .where(eq(dataKeyReencryptionRuns.status, "running"))
    .orderBy(desc(dataKeyReencryptionRuns.startedAt))
    .limit(1);
  return run ?? null;
}

/** Admin-only via the global gate (deliberately NOT in NON_ADMIN_ROUTES),
 * exactly like the other /v1/security/data-key routes. */
export function registerDataKeyReencryptionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/security/data-key/reencryption", async () => reencryptionStatus(db));
}
