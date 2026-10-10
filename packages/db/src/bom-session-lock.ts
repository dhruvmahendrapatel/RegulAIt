/**
 * ADR-0189 slice B3 — the per-subject AI BOM lock, taken BEFORE a
 * REPEATABLE READ capture (entry condition 4237346650, R50).
 *
 * Why not `lockAiBomSubject` (the transaction-scoped lock in bom-locks.ts)?
 * Under REPEATABLE READ, Postgres fixes the transaction snapshot when the
 * FIRST statement starts, and a `pg_advisory_xact_lock` taken as that
 * statement waits AFTER the snapshot exists. A capture that waited behind a
 * newer snapshot would then read the state from before it, which is the
 * "older capture after a newer one" the entry condition forbids. B3
 * reproduced it: T2 holds the key, inserts and commits; T1's RR transaction
 * acquires the key as its first statement and still sees no row.
 *
 * So the lock is a SESSION-level `pg_advisory_lock` on the SAME key
 * (namespace 189_002, `hashtext('<kind>:<id>')`), taken on a dedicated
 * connection BEFORE `BEGIN ISOLATION LEVEL REPEATABLE READ`, held through the
 * snapshot and rendering inserts and the audit row, and released in `finally`.
 * Session and transaction advisory locks share one key space, so this
 * conflicts correctly with every `lockAiBomSubject` writer. If the unlock
 * cannot run (a dead connection), the connection is destroyed, which releases
 * the lock in the server.
 *
 * OPEN SOURCE FIRST (ADR-0176): Postgres's own advisory locks; nothing to adopt.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";
import { withAuditChain } from "./audit-chain.js";
import { withProseScrub } from "./prose-scrub.js";
import { BOM_SUBJECT_LOCK_NAMESPACE } from "./bom-locks.js";

/** PR #287: the longest a writer waits for a subject's lock before it is told the subject is busy */
export const BOM_SUBJECT_LOCK_TIMEOUT_MS = 5_000;

/** the subject is being snapshotted by someone else: retry later (409 `bom_snapshot_busy`) */
export class BomSubjectBusyError extends Error {
  readonly code = "bom_snapshot_busy";
  constructor(readonly reason: "in_process" | "lock_timeout") {
    super(reason === "in_process" ? "A snapshot of this subject is already being taken by this process." : "A snapshot of this subject is being taken elsewhere; the lock wait timed out.");
    this.name = "BomSubjectBusyError";
  }
}

/**
 * In-process single-flight: one writer per subject per process, so a burst of
 * requests for one subject never parks several pool connections on one lock.
 */
const inFlight = new Set<string>();

/** the handle `fn` receives: the same wrappers as `createDb`, bound to ONE connection */
export type BoundBomDb = ReturnType<typeof bind>;
const bind = (client: pg.PoolClient) => withProseScrub(withAuditChain(drizzle(client, { schema })));

export async function withAiBomSubjectSessionLock<T>(
  db: { $client: unknown },
  subjectKind: string,
  subjectId: string,
  fn: (bound: BoundBomDb) => Promise<T>,
): Promise<T> {
  const key = `${subjectKind}:${subjectId}`;
  if (inFlight.has(key)) throw new BomSubjectBusyError("in_process");
  inFlight.add(key);
  try {
    const pool = db.$client as pg.Pool;
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      try {
        // BOUNDED WAIT (PR #287): lock_timeout applies to advisory locks too; it is reset before `fn`
        // runs so the capture transaction keeps the server default
        await client.query(`set lock_timeout = ${BOM_SUBJECT_LOCK_TIMEOUT_MS}`);
        try {
          await client.query("select pg_advisory_lock($1::int, hashtext($2))", [BOM_SUBJECT_LOCK_NAMESPACE, key]);
        } catch (e) {
          if ((e as { code?: string }).code === "55P03") {
            await client.query("reset lock_timeout");
            throw new BomSubjectBusyError("lock_timeout");
          }
          throw e;
        }
        await client.query("reset lock_timeout");
      } catch (e) {
        if (!(e instanceof BomSubjectBusyError)) broken = e instanceof Error ? e : new Error(String(e));
        throw e;
      }
      try {
        return await fn(bind(client));
      } finally {
        try {
          await client.query("select pg_advisory_unlock($1::int, hashtext($2))", [BOM_SUBJECT_LOCK_NAMESPACE, key]);
        } catch (e) {
          broken = e instanceof Error ? e : new Error(String(e));
        }
      }
    } finally {
      // a broken connection is destroyed (which releases any lock it held), never returned to the pool
      client.release(broken);
    }
  } finally {
    inFlight.delete(key);
  }
}
