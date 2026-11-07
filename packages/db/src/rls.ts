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
import { AsyncLocalStorage } from "node:async_hooks";
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
  /**
   * batch 2 (0289): entered only by the audit chain writer, for the INSERT of a row that names a user other than
   * the principal (audit_log.user_id is the sponsor or subject, ADR-0188): audit_log (append, and read its own row)
   */
  "audit_subject",
] as const;
export type RlsSystemReason = (typeof RLS_SYSTEM_REASONS)[number];

/** reasons a caller may pass to `withSystemContext`; `rls_membership` belongs to the SQL helpers alone */
export type RlsCallerSystemReason = Exclude<RlsSystemReason, "rls_membership" | "migration" | "audit_subject">;

export interface RlsPrincipal {
  /** the authenticated user's id (`users.id`) */
  userId: string;
}

/** one entry into a system context, for the audit sink */
export interface RlsSystemContextEntry {
  reason: RlsCallerSystemReason | "audit_subject";
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
  RLS_SYSTEM_REASONS.filter((r) => r !== "rls_membership" && r !== "migration" && r !== "audit_subject"),
);

/** The structural shape the wrappers need: a top-level drizzle handle with `transaction`. */
export interface RlsCapableDb<Tx> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
type ExecTx = { execute: (query: ReturnType<typeof sql>) => PromiseLike<unknown> };

let systemContextSink: ((entry: RlsSystemContextEntry) => void) | null = null;
const systemContextCounts = new Map<RlsSystemReason, number>();

/** Internal to this package: count and report an entry into a reason the SQL side decided (audit_subject). */
export function noteInternalSystemReason(reason: Extract<RlsSystemReason, "audit_subject">, path: string): void {
  systemContextCounts.set(reason, (systemContextCounts.get(reason) ?? 0) + 1);
  systemContextSink?.({ reason, path, at: new Date() });
}

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
 * ADR-0234 batch 2: INSIDE an existing transaction (a `tx` a request scope already scoped as its principal), run
 * one step under a registered caller reason and go back to the principal afterwards. For an effect a request
 * triggers on someone else's behalf (a workflow advancing creates the next stage's approval in the initiator's name,
 * whoever advanced it). Validated, counted and reported to the sink like `withSystemContext`.
 */
export async function withinSystemReason<T>(
  tx: ExecTx,
  reason: RlsCallerSystemReason,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!CALLER_REASONS.has(reason)) {
    throw new RlsContextError(`withinSystemReason: '${String(reason)}' is not a registered system reason; nothing was run`);
  }
  if (typeof path !== "string" || !PATH_RE.test(path)) {
    throw new RlsContextError("withinSystemReason: path must be a short static label; nothing was run");
  }
  systemContextCounts.set(reason, (systemContextCounts.get(reason) ?? 0) + 1);
  systemContextSink?.({ reason, path, at: new Date() });
  return inSystemReason(tx, reason, fn);
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

// ---------------------------------------------------------------------------------------------------------------
// ADR-0234 batch 2: request-scoped row-level security without touching every call site.
//
// The gateway has about 1,100 query sites on the slice-1 tables; wrapping each in `withPrincipal` is neither
// reviewable nor safe in one batch. Instead a request (or a sweep) declares its scope ONCE with
// `runWithRlsPrincipal` / `runWithRlsSystem`, an AsyncLocalStorage carries it, and the pool every drizzle handle
// is built on (`scopePoolForRls`, called by `createDb`) applies it to each statement issued inside that async
// context:
//
//   - a plain statement (`pool.query`) runs as  BEGIN; set role + setting (LOCAL); <statement>; COMMIT
//     on one checked-out client, so the setting dies with the statement's own transaction;
//   - a transaction (`pool.connect` + BEGIN, which is how drizzle's `db.transaction` works) gets the role and
//     setting right after its BEGIN, LOCAL to it; a statement on that client outside a transaction is scoped as a
//     plain statement.
//
// Nothing is ever set at session level, so a client goes back to the pool exactly as it came out (the slice-1
// "clean pool" property holds per statement). Outside a scope the pool behaves exactly as before: scripts, the
// migrator and anything not yet adopted are untouched. A cursor or stream (a Submittable) inside a scope is
// refused rather than run unscoped.
// ---------------------------------------------------------------------------------------------------------------
/** the scope a statement runs under */
export type RlsScope =
  | { kind: "principal"; userId: string; reason?: RlsCallerSystemReason; path?: string }
  | { kind: "system"; reason: RlsCallerSystemReason; path: string };

const rlsScope = new AsyncLocalStorage<RlsScope>();

/** the RLS scope of the current async context, if any */
export function currentRlsScope(): RlsScope | undefined {
  return rlsScope.getStore();
}

/**
 * Run `fn` inside `store` and, when it returns a thenable, START it inside the scope too. A drizzle query builder is
 * lazy: `() => db.select()...` returns a builder that runs only when awaited, and awaiting it after `run` returned
 * would run it OUTSIDE the scope. Calling `.then` here, while the scope is current, runs it inside.
 */
function runInScope<T>(store: RlsScope | undefined, fn: () => T): T {
  const enter = (cb: () => T): T => (store === undefined ? rlsScope.exit(cb) : rlsScope.run(store, cb));
  return enter(() => {
    const out = fn();
    if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") {
      return new Promise((resolve, reject) => (out as unknown as PromiseLike<unknown>).then(resolve, reject)) as T;
    }
    return out;
  });
}

/** Run `fn` with every statement it issues (through a scoped pool) scoped to `principal`. */
export function runWithRlsPrincipal<T>(principal: RlsPrincipal, fn: () => T): T {
  const userId = principal?.userId;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new RlsContextError("runWithRlsPrincipal: the principal's userId must be a user id (uuid); nothing was run");
  }
  return runInScope({ kind: "principal", userId: userId.toLowerCase() }, fn);
}

/**
 * Run `fn` as `principal` AND under the registered `reason`: both settings are set, so the principal still sees what
 * it sees (users, its own rows) and the reason opens only the tables whose policies name it. For a step whose
 * authorization the gateway decides itself and whose rows the principal's own predicate cannot express (deciding an
 * ADR-0168 review-role approval, whose membership lives in configuration until batch 4). Validated, counted and
 * reported to the sink.
 */
export function runWithRlsPrincipalStep<T>(principal: RlsPrincipal, reason: RlsCallerSystemReason, path: string, fn: () => T): T {
  const userId = principal?.userId;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    throw new RlsContextError("runWithRlsPrincipalStep: the principal's userId must be a user id (uuid); nothing was run");
  }
  if (!CALLER_REASONS.has(reason)) {
    throw new RlsContextError(`runWithRlsPrincipalStep: '${String(reason)}' is not a registered system reason; nothing was run`);
  }
  if (typeof path !== "string" || !PATH_RE.test(path)) {
    throw new RlsContextError("runWithRlsPrincipalStep: path must be a short static label; nothing was run");
  }
  systemContextCounts.set(reason, (systemContextCounts.get(reason) ?? 0) + 1);
  systemContextSink?.({ reason, path, at: new Date() });
  return runInScope({ kind: "principal", userId: userId.toLowerCase(), reason, path }, fn);
}

/**
 * If the current scope is a principal, run `fn` as that principal plus `reason` (`runWithRlsPrincipalStep`);
 * otherwise (no scope, or already a system scope) run it unchanged. For a governance computation a request runs
 * that must read beyond the caller's own rows, such as the model-risk staleness gate reading the ledger.
 */
export function runAsPrincipalStepIfScoped<T>(reason: RlsCallerSystemReason, path: string, fn: () => T): T {
  const scope = rlsScope.getStore();
  if (scope?.kind === "principal" && scope.reason === undefined) {
    return runWithRlsPrincipalStep({ userId: scope.userId }, reason, path, fn);
  }
  return fn();
}

/** Run `fn` with every statement it issues (through a scoped pool) under the registered system `reason`. */
export function runWithRlsSystem<T>(reason: RlsCallerSystemReason, path: string, fn: () => T): T {
  if (!CALLER_REASONS.has(reason)) {
    throw new RlsContextError(`runWithRlsSystem: '${String(reason)}' is not a registered system reason; nothing was run`);
  }
  if (typeof path !== "string" || !PATH_RE.test(path)) {
    throw new RlsContextError("runWithRlsSystem: path must be a short static label; nothing was run");
  }
  systemContextCounts.set(reason, (systemContextCounts.get(reason) ?? 0) + 1);
  systemContextSink?.({ reason, path, at: new Date() });
  return runInScope({ kind: "system", reason, path }, fn);
}

/** Run `fn` with NO RLS scope (a request that resolved no principal leaves the `authenticate` scope this way). */
export function runWithoutRlsScope<T>(fn: () => T): T {
  return runInScope(undefined, fn);
}

/**
 * The one statement that applies a scope inside an open transaction. Values are inlined, never interpolated from
 * input: the user id has passed UUID_RE and the reason is a member of the closed registry (checked again here).
 */
function scopeStatement(scope: RlsScope): string {
  if (scope.kind === "principal") {
    if (!UUID_RE.test(scope.userId)) throw new RlsContextError("rls scope: invalid principal");
    const step =
      scope.reason === undefined
        ? ""
        : CALLER_REASONS.has(scope.reason)
          ? `, pg_catalog.set_config('${RLS_SYSTEM_SETTING}', '${scope.reason}', true)`
          : (() => {
              throw new RlsContextError("rls scope: invalid system reason");
            })();
    return `SELECT pg_catalog.set_config('role', '${RLS_APP_ROLE}', true), pg_catalog.set_config('${RLS_PRINCIPAL_SETTING}', '${scope.userId}', true)${step}`;
  }
  if (!CALLER_REASONS.has(scope.reason)) throw new RlsContextError("rls scope: invalid system reason");
  return `SELECT pg_catalog.set_config('role', '${RLS_APP_ROLE}', true), pg_catalog.set_config('${RLS_SYSTEM_SETTING}', '${scope.reason}', true)`;
}

type QueryArgs = unknown[];
interface ScopableClient {
  query: (...args: QueryArgs) => unknown;
  release: (err?: unknown) => void;
}
interface ScopablePool {
  query: (...args: QueryArgs) => unknown;
  connect: (...args: unknown[]) => unknown;
}

const BEGIN_RE = /^\s*(begin|start\s+transaction)\b/i;
const END_RE = /^\s*(commit|end|rollback)\b(?!\s+to\b)/i;
const SCOPED = Symbol.for("regulait.rls.scopedPool");

function queryText(args: QueryArgs): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
    return (first as { text: string }).text;
  }
  return "";
}
function isSubmittable(args: QueryArgs): boolean {
  const first = args[0];
  return !!first && typeof first === "object" && typeof (first as { submit?: unknown }).submit === "function";
}
function splitCallback(args: QueryArgs): { args: QueryArgs; cb?: (err: unknown, res?: unknown) => void } {
  const last = args[args.length - 1];
  if (typeof last === "function") return { args: args.slice(0, -1), cb: last as (err: unknown, res?: unknown) => void };
  return { args };
}
function settle<T>(p: Promise<T>, cb?: (err: unknown, res?: unknown) => void): Promise<T> | undefined {
  if (!cb) return p;
  p.then((r) => cb(null, r), (e) => cb(e));
  return undefined;
}

/** run one statement as its own scoped transaction on `client` (which the caller owns) */
async function scopedStatement(client: ScopableClient, scope: RlsScope, args: QueryArgs): Promise<unknown> {
  await client.query(`BEGIN; ${scopeStatement(scope)}`);
  let res: unknown;
  try {
    res = await client.query(...args);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the client's transaction state is unknown: the caller must destroy it, never pool it
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { [STATE_UNKNOWN]: true });
    }
    throw err;
  }
  await client.query("COMMIT");
  return res;
}
const STATE_UNKNOWN = Symbol.for("regulait.rls.clientStateUnknown");

function scopedClient(client: ScopableClient, scope: RlsScope): ScopableClient {
  let inTx = false;
  const query = (...raw: QueryArgs): unknown => {
    const { args, cb } = splitCallback(raw);
    if (isSubmittable(args)) {
      throw new RlsContextError("rls scope: a cursor or stream cannot run inside an RLS scope; nothing was run");
    }
    const text = queryText(args);
    const run = async (): Promise<unknown> => {
      if (BEGIN_RE.test(text)) {
        const res = await client.query(...args);
        await client.query(scopeStatement(scope));
        inTx = true;
        return res;
      }
      if (inTx) {
        const res = await client.query(...args);
        if (END_RE.test(text)) inTx = false;
        return res;
      }
      return scopedStatement(client, scope, args);
    };
    return settle(run(), cb);
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return query;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * Make `pool` apply the current RLS scope (if any) to every statement. Idempotent. Called by `createDb` before
 * drizzle wraps the pool; outside a scope it changes nothing.
 */
export function scopePoolForRls<P extends object>(pool: P): P {
  const p = pool as unknown as ScopablePool & { [SCOPED]?: true };
  if (p[SCOPED]) return pool;
  const origQuery = p.query.bind(p);
  const origConnect = p.connect.bind(p);
  p.query = (...raw: QueryArgs): unknown => {
    const scope = rlsScope.getStore();
    if (!scope) return origQuery(...raw);
    const { args, cb } = splitCallback(raw);
    if (isSubmittable(args)) {
      throw new RlsContextError("rls scope: a cursor or stream cannot run inside an RLS scope; nothing was run");
    }
    const run = async (): Promise<unknown> => {
      const client = (await origConnect()) as ScopableClient;
      try {
        const res = await scopedStatement(client, scope, args);
        client.release();
        return res;
      } catch (err) {
        // a client whose transaction state is unknown (ROLLBACK failed) is destroyed, never returned to the pool
        const unknownState = !!err && typeof err === "object" && (err as Record<symbol, unknown>)[STATE_UNKNOWN] === true;
        client.release(unknownState ? (err as Error) : undefined);
        throw err;
      }
    };
    return settle(run(), cb);
  };
  p.connect = (...raw: unknown[]): unknown => {
    const scope = rlsScope.getStore();
    if (!scope) return origConnect(...raw);
    const cb = typeof raw[raw.length - 1] === "function" ? (raw[raw.length - 1] as (e: unknown, c?: unknown, d?: unknown) => void) : undefined;
    const run = async () => scopedClient((await origConnect()) as ScopableClient, scope);
    if (!cb) return run();
    run().then((c) => cb(null, c, (err?: unknown) => (c as ScopableClient).release(err)), (e) => cb(e));
    return undefined;
  };
  p[SCOPED] = true;
  return pool;
}
