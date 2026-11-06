/**
 * ADR-0234 (PENDING S7) — the row-level security transaction layer.
 *
 * Migration 0272 enables and FORCES row-level security on the slice-1 tables. Every policy reads two
 * TRANSACTION-LOCAL settings:
 *
 *   regulait.user_id         the authenticated principal (a user id), or unset
 *   regulait.system_context  an explicit, registered system reason, or unset
 *
 * Unset means NULL, and NULL matches no policy: a transaction that sets neither sees zero rows.
 *
 * The only ways to set them are the two wrappers below. Each opens its OWN transaction on a top-level
 * handle and sets the role and the setting with `set_config(..., is_local => true)` in one statement, so:
 *   - the values die with COMMIT or ROLLBACK and a pooled connection goes back to the pool clean;
 *   - nothing is ever set at session level (`SET` without LOCAL), which would leak to the next borrower;
 *   - nesting is impossible by type: a wrapper takes a `Db`, never a transaction. A savepoint would keep a
 *     LOCAL setting alive after RELEASE, for the rest of the outer transaction.
 *
 * The role switch (`role` = `regulait_app`) is what makes the policies apply when the pool logs in as the
 * table owner or a superuser (today's local demo, docker-compose and CI): inside the wrapper the statements
 * run as the non-owner app role, which is subject to RLS whatever the login is.
 *
 * What RLS here defends against: a missing or wrong application predicate (an object-level check that was
 * skipped, a WHERE clause that was dropped). What it does NOT defend against: code that can run arbitrary
 * SQL on the connection, which can set the same settings. Parameterised queries (ADR-0200 item 1) stay the
 * control for that. ADR-0234 says so in its threat model.
 */
import { sql } from "drizzle-orm";

/** the transaction-local setting that carries the principal */
export const RLS_PRINCIPAL_SETTING = "regulait.user_id";
/** the transaction-local setting that carries an explicit system reason */
export const RLS_SYSTEM_SETTING = "regulait.system_context";
/** the non-owner runtime role every wrapped transaction runs as (migration 0272) */
export const RLS_APP_ROLE = "regulait_app";

/**
 * The CLOSED registry of system reasons. Identical to the array in migration 0272's
 * `regulait_rls_system_reason()` (a test compares them); the database raises on any other value.
 *
 * Each reason is reachable only from the tables whose policies name it, so a system context is never a
 * blanket bypass: `authenticate` can read users and MFA challenges, and nothing in approvals or audit_log.
 */
export const RLS_SYSTEM_REASONS = [
  /** sign-in and session resolution, before a principal exists: users (read; no write until ADR-0234 batch 2), auth_mfa_pending */
  "authenticate",
  /** SCIM and the seed: users (all) */
  "identity_provisioning",
  /** the audit chain writer's tip read, under the append lock: audit_log (read) */
  "audit_chain",
  /** chain verification, anchoring and export jobs: audit_log (read) */
  "audit_verify",
  /** expiry, SLA and routing sweeps that act on every approval: approvals (all) */
  "approval_maintenance",
  /** entered only by the SET clause of the 0272 helper functions: users (read) */
  "rls_membership",
  /** a later migration that touches rows of an RLS table: every slice-1 table */
  "migration",
] as const;
export type RlsSystemReason = (typeof RLS_SYSTEM_REASONS)[number];

/** reasons a caller may pass to `withSystemContext`; `rls_membership` belongs to the SQL helpers alone */
export type RlsCallerSystemReason = Exclude<RlsSystemReason, "rls_membership" | "migration">;

export interface RlsPrincipal {
  /** the authenticated user's id (`users.id`) */
  userId: string;
}

/** one entry into a system context, for the audit sink */
export interface RlsSystemContextEntry {
  reason: RlsCallerSystemReason;
  /** a short, static label for the code path (never user input) */
  path: string;
  at: Date;
}

/** Thrown before any SQL runs when a wrapper is handed something it must not set. */
export class RlsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RlsContextError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^[a-z0-9][a-z0-9_.:/-]{0,79}$/;
const CALLER_REASONS: ReadonlySet<string> = new Set(
  RLS_SYSTEM_REASONS.filter((r) => r !== "rls_membership" && r !== "migration"),
);

/** The structural shape the wrappers need: a top-level drizzle handle with `transaction`. */
export interface RlsCapableDb<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
type ExecTx = { execute: (query: ReturnType<typeof sql>) => PromiseLike<unknown> };

let systemContextSink: ((entry: RlsSystemContextEntry) => void) | null = null;
const systemContextCounts = new Map<RlsCallerSystemReason, number>();

/**
 * Wire the audit sink for system-context entries (the gateway passes its logger or metrics). A per-entry
 * audit ROW is deliberately not written: `authenticate` runs on every request, and an audit row per request
 * would drown the chain. ADR-0234 decision 5.
 */
export function setRlsSystemContextSink(sink: ((entry: RlsSystemContextEntry) => void) | null): void {
  systemContextSink = sink;
}

/** entries per reason since process start (for the posture read and tests) */
export function rlsSystemContextCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(systemContextCounts);
}

/**
 * Run `fn` in a transaction scoped to `principal`: role `regulait_app`, `regulait.user_id` set, no system
 * context. Every RLS table then shows exactly the rows its policies give that user, whatever `fn` forgets
 * to filter.
 */
export async function withPrincipal<Tx extends ExecTx, T>(
  db: RlsCapableDb<Tx>,
  principal: RlsPrincipal,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const userId = principal?.userId;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new RlsContextError("withPrincipal: the principal's userId must be a user id (uuid); nothing was run");
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', ${RLS_APP_ROLE}, true), set_config(${RLS_PRINCIPAL_SETTING}, ${userId.toLowerCase()}, true)`,
    );
    return fn(tx);
  });
}

/**
 * Run `fn` in a transaction under an explicit system reason: role `regulait_app`, no principal,
 * `regulait.system_context` = `reason`. The reason opens only the tables whose policies name it.
 * `path` is a static label for the code path, reported to the audit sink.
 */
export async function withSystemContext<Tx extends ExecTx, T>(
  db: RlsCapableDb<Tx>,
  reason: RlsCallerSystemReason,
  path: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!CALLER_REASONS.has(reason)) {
    throw new RlsContextError(`withSystemContext: '${String(reason)}' is not a registered system reason; nothing was run`);
  }
  if (typeof path !== "string" || !PATH_RE.test(path)) {
    throw new RlsContextError("withSystemContext: path must be a short static label; nothing was run");
  }
  systemContextCounts.set(reason, (systemContextCounts.get(reason) ?? 0) + 1);
  systemContextSink?.({ reason, path, at: new Date() });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('role', ${RLS_APP_ROLE}, true), set_config(${RLS_SYSTEM_SETTING}, ${reason}, true)`,
    );
    return fn(tx);
  });
}

/**
 * INSIDE an existing transaction, enter `reason` for one step and restore whatever was set before
 * (the audit chain's tip read). The previous value is read and the new one set in ONE statement; the
 * restore runs only when `fn` succeeds. When `fn` throws, the transaction is already failing and its
 * rollback discards the setting, so no restore is attempted (it would fail on an aborted transaction and
 * hide the real error).
 *
 * Internal to this package: it widens the current transaction, so it is for code that holds the lock that
 * makes the widened read safe.
 */
export async function inSystemReason<T>(tx: ExecTx, reason: RlsSystemReason, fn: () => Promise<T>): Promise<T> {
  const res = (await tx.execute(
    sql`select s.prev, set_config(${RLS_SYSTEM_SETTING}, ${reason}, true) from (select coalesce(current_setting(${RLS_SYSTEM_SETTING}, true), '') as prev) s`,
  )) as { rows?: Array<{ prev: string | null }> };
  const prev = res.rows?.[0]?.prev ?? "";
  const out = await fn();
  await tx.execute(sql`select set_config(${RLS_SYSTEM_SETTING}, ${prev}, true)`);
  return out;
}
