/**
 * ADR-0189 — THE LOCK TARGETS of the Decision BOM and AI BOM writers, defined
 * once so every slice takes the same lock (entry conditions 4237322632,
 * 4237344247 and 4237346650; amendments R35, R40, R50).
 *
 *  - PER DECISION: `SELECT … FOR UPDATE` on the decision's capture-status marker
 *    (`decision_capture_status`), a row that exists for every receipt-eligible
 *    decision from migration 0182 on. A decision older than the marker has no
 *    row, so it gets a transaction-scoped advisory lock keyed by its audit id.
 *    Every writer of a decision's addenda (R35), and every Decision BOM assembly
 *    and version allocation (R40), takes THIS lock first; two concurrent first
 *    requests then serialise and return the same frozen BOM.
 *  - PER SUBJECT: an advisory lock keyed by the AI BOM subject (kind and id),
 *    namespace `BOM_SUBJECT_LOCK_NAMESPACE`, key `hashtext('<kind>:<id>')`, held
 *    through the snapshot insert (R50). No row exists for every subject (the
 *    install has none), so the key is advisory by design.
 *
 *    ORDERING CAVEAT (B3 finding): a REPEATABLE READ transaction takes its
 *    snapshot when its FIRST statement starts, which is before that statement
 *    waits for a lock. So `lockAiBomSubject` called as the first statement of
 *    an RR transaction does NOT order the capture after the previous holder's
 *    commit: the snapshot can predate it. A writer that captures under RR must
 *    take a SESSION-level `pg_advisory_lock` on the same (namespace, key) on its
 *    own connection BEFORE `BEGIN ISOLATION LEVEL REPEATABLE READ`, and unlock it
 *    in `finally` (B3 does). `lockAiBomSubject` (xact-scoped) is correct only in
 *    READ COMMITTED transactions, and it conflicts with that session lock.
 *
 * The per-decision lock is `_xact_` (row lock or advisory): released at commit
 * or rollback, never leaked. A hash collision between two keys only makes
 * unrelated writers wait; the database guards (contiguous versions, the
 * addendum chain) stay the integrity backstop.
 *
 * OPEN SOURCE FIRST (ADR-0176): Postgres's own row and advisory locks; nothing to adopt.
 */
import { sql, type SQL } from "drizzle-orm";

/** the first int4 key of each advisory namespace (ADR number + a slot) */
export const BOM_DECISION_LOCK_NAMESPACE = 189_001;
export const BOM_SUBJECT_LOCK_NAMESPACE = 189_002;

type Tx = { execute: (query: SQL) => PromiseLike<unknown> };
const rowsOf = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;

/** take the per-decision lock; says which target held it */
export async function lockDecisionForBom(tx: Tx, auditId: string): Promise<{ target: "capture_marker" | "advisory" }> {
  const marker = rowsOf(
    await tx.execute(sql`select "audit_id" from "decision_capture_status" where "audit_id" = ${auditId} for update`),
  );
  if (marker.length) return { target: "capture_marker" };
  await tx.execute(sql`select pg_advisory_xact_lock(${BOM_DECISION_LOCK_NAMESPACE}::int, hashtext(${auditId}))`);
  return { target: "advisory" };
}

/** take the per-subject lock of an AI BOM subject, transaction-scoped: READ COMMITTED writers only (see the caveat above) */
export async function lockAiBomSubject(tx: Tx, subjectKind: string, subjectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${BOM_SUBJECT_LOCK_NAMESPACE}::int, hashtext(${`${subjectKind}:${subjectId}`}))`);
}
