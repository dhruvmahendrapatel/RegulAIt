/**
 * ADR-0060 §3 — chaining at write.
 *
 * WHERE THE "SINGLE AUDIT-INSERT PATH" ACTUALLY IS
 * ------------------------------------------------
 * ADR-0060 §3 says "the single audit-insert path computes prev_hash … in the
 * same transaction as the row". When this was implemented there were **158
 * `insert(auditLog)` call sites across 31 gateway modules** — the ADR's "single
 * path" was an aspiration, not a fact on the ground. Three options existed:
 *
 *   1. Mechanically rewrite 158 call sites to go through a helper. Large,
 *      merge-hostile, and — the fatal objection — it makes chaining a CONVENTION.
 *      The 159th call site, written next month by someone who has not read this
 *      ADR, silently writes an un-chained row and verification reports it as
 *      tampering.
 *   2. A PL/pgSQL BEFORE INSERT trigger. Genuinely unbypassable, but it would
 *      have to reimplement the canonical jsonb serialization in SQL, and the two
 *      implementations would then have to agree byte-for-byte forever. That is
 *      precisely the divergence ADR-0060 names as the thing most likely to bite
 *      the implementation, deliberately doubled.
 *   3. Intercept at `createDb`, the ONE place a database handle is ever
 *      constructed in this repo.
 *
 * (3) is what this file does. Every handle — the server's, the seeder's, every
 * test's — comes from `createDb`, so `insert(auditLog)` is genuinely a single
 * chokepoint, `transaction()` is wrapped so a row inserted inside a caller's
 * transaction chains inside that same transaction, and one canonicalizer serves
 * both the writer and the verifier. The 159th call site is chained without its
 * author knowing this file exists.
 *
 * HONEST LIMIT of (3) versus (2): this is application-layer, so it binds code
 * that goes through `createDb` and nothing else. A `psql` session, a raw `pg`
 * client, or a future module that builds its own pool writes un-chained rows.
 * Verification reports those as `missing_hash` at the exact seq rather than
 * ignoring them, so the failure is loud — but it is detection, not prevention.
 * A trigger remains the strictly stronger option and is recorded as a follow-up.
 *
 * WHY APPENDS SERIALIZE, AND WHY IT IS AN ADVISORY LOCK
 * ----------------------------------------------------
 * Two concurrent appends must not both read the same chain tip and both claim
 * it as their predecessor — that produces two rows with the same `prev_hash`,
 * i.e. a fork, which verification cannot distinguish from tampering. The tip
 * read and the append must therefore be atomic with respect to each other.
 *
 * `pg_advisory_xact_lock` is the natural fit: it needs no row to lock (the tip
 * row is a moving target and there is nothing to lock BEFORE the first append),
 * it is automatically released at commit OR rollback (no lock leak on a failed
 * transaction), and it costs one round trip. The `seq` unique index is the
 * belt-and-braces: even if the lock were somehow bypassed, two rows could not
 * occupy the same position — one transaction would fail rather than fork.
 *
 * THIS IS A THROUGHPUT CEILING AND IT WAS MEASURED, NOT ASSUMED. See ADR-0060's
 * accepted-amendment for the numbers.
 *
 * WHY `max(seq)+1` AND NOT A SEQUENCE
 * -----------------------------------
 * `nextval` is not transactional: a rolled-back transaction burns its number
 * permanently, leaving a hole in `seq`. Verification cannot tell that hole from
 * a deleted row, so every rollback would raise a false "someone deleted an audit
 * record" alarm — the single fastest way to make an integrity control ignored.
 * Under the advisory lock, `max(seq)+1` is exactly as safe and produces a
 * genuinely gapless sequence, so a gap MEANS something.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { desc, isNotNull } from "drizzle-orm";
import { sql, type SQL } from "drizzle-orm";
import {
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_SEQ,
  auditChainVersionAt,
  auditContentHashFor,
  auditRowHash,
  resolveAuditChainBoundary,
  scrubAuditRow,
  type AuditChainBoundary,
  type AuditChainFields,
} from "@regulait/shared";
import { auditLog } from "./schema.js";

/**
 * The advisory-lock key every append serializes on. A single global key,
 * because there is a single global chain: `seq` is a total order over the whole
 * table, so there is nothing to shard on. Arbitrary but fixed — `0x60` is the
 * ADR number. The other advisory locks in production code are the gateway's
 * health-probe claim (`HEALTH_PROBE_CLAIM_LOCK_KEY`, 6_000_000_037) and its
 * sign-in invariant (`SIGN_IN_INVARIANT_LOCK_KEY`, 6_000_000_174, AER-056 —
 * always taken BEFORE this one, never after); a new key must differ from all
 * three.
 */
export const AUDIT_CHAIN_LOCK_KEY = 6_000_000_060;

/**
 * ADR-0188 slice S4 — WHO IS ACTING, for every audit row written while an agent acts.
 *
 * Decision 9 puts the actor (identity, leaf grant, chain) on every agent-made audit row. There are hundreds of
 * `insert(auditLog)` sites; threading the actor through each would make stamping a convention, which is exactly
 * what this file exists to avoid (see the header). So the in-process agent paths (S4: orchestration workers,
 * builder turns and schedules, engine runs) run their governed work inside `runWithAuditActor`, and the ONE
 * writer below stamps every row appended in that async context that does not name an actor itself.
 *
 * Before the decision 19 boundary a v1 hash cannot cover the actor COLUMNS, so the writer puts the same facts in
 * `detail.delegation` instead (covered by the v1 hash as part of `detail`); from the boundary on it fills the
 * columns. The choice is made under the append lock, from the boundary read there, so it cannot race the cutover.
 */
export interface AuditActorStamp {
  actorIdentityId: string;
  delegationGrantId: string;
  /** identity ids, root first (decision 25) */
  actorChain: string[];
}
const auditActorContext = new AsyncLocalStorage<AuditActorStamp>();
/** run `fn` with every audit row it appends stamped with `stamp` (unless a row names its own actor) */
export function runWithAuditActor<T>(stamp: AuditActorStamp, fn: () => Promise<T>): Promise<T> {
  return auditActorContext.run(stamp, fn);
}
/** the actor stamp of the current async context, if any (tracing and usage read it too) */
export function currentAuditActor(): AuditActorStamp | undefined {
  return auditActorContext.getStore();
}

/** Marker property: `true` on a handle that already chains, so wrapping is
 * idempotent and a doubly-wrapped handle cannot chain a row twice. */
const CHAINED = Symbol.for("regulait.audit-chain.wrapped");

/** The shape `appendChainedAuditRows` needs from a drizzle handle. Structural
 * rather than nominal so it accepts both the top-level db and a transaction. */
type AuditExec = {
  execute: (query: unknown) => Promise<unknown>;
  select: (fields: unknown) => {
    from: (t: unknown) => {
      where: (w: unknown) => { orderBy: (o: unknown) => { limit: (n: number) => Promise<unknown[]> } };
    };
  };
  insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

/** What a caller hands to `insert(auditLog).values(...)`. Every column is
 * optional here because the caller may rely on a DB default; the ones the DB
 * would fill in are resolved in TypeScript below, because a hash cannot be taken
 * over a value the writer never saw. */
type AuditInsertValues = Partial<AuditChainFields> & Record<string, unknown>;

/**
 * Resolve the columns Postgres would otherwise default, so the value that is
 * HASHED and the value that is STORED are provably the same.
 *
 * This is not defensive coding, it is the whole correctness argument. `id`
 * defaults to `gen_random_uuid()`, `at` to `now()`, `object_type` to
 * `'mcp_tool'`. If any of those were left to the server, the writer would hash
 * one row and the database would store a different one, and every such row
 * would report as tampered on the first verification.
 *
 * `at` in particular: `now()` has MICROSECOND resolution and JavaScript's
 * `Date` has milliseconds. Letting the column default would store a timestamp
 * the hash could never reproduce.
 */
function resolveDefaults(v: AuditInsertValues): AuditChainFields & Record<string, unknown> {
  const at = v.at instanceof Date ? v.at : v.at != null ? new Date(v.at as string) : new Date();
  return {
    ...v,
    id: (v.id as string | undefined) ?? randomUUID(),
    // millisecond truncation is explicit rather than incidental
    at: new Date(at.getTime()),
    userId: v.userId as string,
    objectType: (v.objectType as string | undefined) ?? "mcp_tool",
    effect: v.effect as string,
    ruleId: v.ruleId as string,
    ruleChain: v.ruleChain,
    reason: v.reason as string,
  };
}

/**
 * Append one or more audit rows to the chain, inside `tx`.
 *
 * `tx` MUST be a real transaction: `pg_advisory_xact_lock` is released at the
 * end of the enclosing transaction, and outside one every statement is its own
 * transaction, so the lock would be dropped before the tip could be used.
 */
export async function appendChainedAuditRows(
  tx: AuditExec,
  values: AuditInsertValues[],
  returning?: unknown,
): Promise<unknown> {
  if (values.length === 0) return returning === undefined ? undefined : [];

  // Serialize at the tip. Everything from here to COMMIT is the critical
  // section; it is deliberately as short as possible.
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);

  // The tip. `where seq is not null` skips every un-chained legacy row (their
  // seq is NULL, and a plain `order by seq desc` would sort NULLs FIRST and
  // hand us a legacy row as the "tip").
  const tip = (await tx
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash })
    .from(auditLog)
    .where(isNotNull(auditLog.seq))
    .orderBy(desc(auditLog.seq))
    .limit(1)) as Array<{ seq: number | null; rowHash: string | null }>;

  // No chained row at all means the genesis row is absent — either migration
  // 0067 has not run (impossible here, it created the row) or someone deleted
  // it. Starting a fresh chain from the genesis constant is the only sane
  // behaviour: verification will separately report the missing genesis.
  let prevHash = tip[0]?.rowHash ?? AUDIT_GENESIS_PREV_HASH;
  let nextSeq = (tip[0]?.seq ?? AUDIT_GENESIS_SEQ - 1) + 1;

  // ADR-0188 decision 19: the canonical-serialisation boundary, read UNDER THE
  // SAME LOCK, so no append can race the cutover and land a v1 row past it.
  const v2FromSeq = await readAuditV2Boundary(tx);

  const rows = values.map((raw) => {
    // ADR-0099 — SCRUB, THEN HASH. The order is the whole correctness argument
    // and it is not stylistic: `content_hash` is taken over the row's immutable
    // facts, so if the scrub ran AFTER the hash the stored row would no longer
    // hash to its own `content_hash` and ADR-0060's verification would report
    // every redacted row as `content_mismatch` — tampering, on the one control
    // that was supposed to make tampering visible. Scrubbing here also means
    // the row that is hashed and the row that is inserted below are the SAME
    // object, so they cannot drift.
    //
    // And it is sited here, not at the ~30 call sites and ~10 local `audit()`
    // helpers, for the same reason chaining is (see this file's header): a
    // raw `db.insert(auditLog)` written next month is scrubbed without its
    // author knowing this line exists. Convention could not promise that.
    const resolved = resolveDefaults(raw);
    // ADR-0188 decision 19: the boundary decides the version, never the caller
    const version = auditChainVersionAt(nextSeq, v2FromSeq);
    // ADR-0188 S4: stamp the acting agent from the async context (a row that names its own actor keeps it)
    const stamp = auditActorContext.getStore();
    if (stamp && resolved.actorIdentityId == null && resolved.delegationGrantId == null && resolved.actorChain == null) {
      if (version === 2) {
        resolved.actorIdentityId = stamp.actorIdentityId;
        resolved.delegationGrantId = stamp.delegationGrantId;
        resolved.actorChain = [...stamp.actorChain];
      } else {
        // a non-object detail (never written today) is left as it is rather than reshaped
        const detail = resolved.detail;
        const base = detail == null ? {} : typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;
        if (base && !("delegation" in base)) {
          resolved.detail = {
            ...base,
            delegation: { actorIdentityId: stamp.actorIdentityId, delegationGrantId: stamp.delegationGrantId, actorChain: [...stamp.actorChain] },
          };
        }
      }
    }
    if (version === 1 && (resolved.actorIdentityId != null || resolved.delegationGrantId != null || resolved.actorChain != null)) {
      // a v1 hash does not cover the actor fields: writing them unprotected would be worse than refusing
      throw new Error(
        "audit-chain: actor fields (ADR-0188) can be written only from the v2 boundary on; run the audit v2 cutover first",
      );
    }
    resolved.chainVersion = version === 2 ? 2 : null;
    const fields = scrubAuditRow(resolved);
    const contentHash = auditContentHashFor(fields, version);
    const rowHash = auditRowHash(prevHash, contentHash);
    const row = { ...fields, seq: nextSeq, contentHash, prevHash, rowHash };
    prevHash = rowHash;
    nextSeq += 1;
    return row;
  });

  // ONE multi-row INSERT: a batch of audit rows costs one round trip, not N.
  const insert = tx.insert(auditLog).values(rows) as Promise<unknown> & {
    returning: (sel?: unknown) => Promise<unknown>;
  };
  // `.returning()` with no argument means "every column", which is drizzle's
  // own signature; callers that ask for a projection get exactly that.
  if (returning !== undefined) return returning === ALL_COLUMNS ? insert.returning() : insert.returning(returning);
  await insert;
  return undefined;
}

/**
 * Thrown when the database has no `audit_chain_versions` table: its schema is
 * older than this build (migration 0180 not applied). The writer FAILS CLOSED
 * here rather than assuming "v1 only": it cannot know whether a boundary was
 * recorded, and this build's insert names columns such a database lacks.
 */
export class AuditChainSchemaBehindError extends Error {
  constructor() {
    super(
      "audit-chain: the database has no audit_chain_versions table (migration 0180 not applied); this build refuses to append to or verify a chain whose version boundary it cannot read",
    );
    this.name = "AuditChainSchemaBehindError";
  }
}

function isUndefinedTable(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i += 1) {
    if ((e as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

/**
 * ADR-0188 decision 19 (X35 I7S-02): the ONE loader of the canonical-
 * serialisation boundary, shared by the writer, the verifier and the receipt
 * sweep. Reads every row of the append-only `audit_chain_versions` table and
 * resolves it with `resolveAuditChainBoundary`: `{supported: true, v2FromSeq}`
 * (null = no boundary yet: every row is v1), or the first boundary of a version
 * this build does not know. A missing table throws `AuditChainSchemaBehindError`.
 */
export async function loadAuditChainBoundary(tx: { execute: (query: SQL) => PromiseLike<unknown> }): Promise<AuditChainBoundary> {
  let res: { rows?: Array<{ version: number | string; from_seq: number | string }> };
  try {
    res = (await tx.execute(
      sql`select "version", "from_seq" from "audit_chain_versions" order by "from_seq" asc`,
    )) as typeof res;
  } catch (err) {
    if (isUndefinedTable(err)) throw new AuditChainSchemaBehindError();
    throw err;
  }
  return resolveAuditChainBoundary((res.rows ?? []).map((r) => ({ version: Number(r.version), fromSeq: Number(r.from_seq) })));
}

/**
 * The writer's view of the boundary: the first `seq` written under v2 (null =
 * none yet). A boundary for a version this build does not know refuses the
 * append: a writer that cannot produce the current version must not extend the chain.
 */
export async function readAuditV2Boundary(tx: { execute: (query: SQL) => PromiseLike<unknown> }): Promise<number | null> {
  const boundary = await loadAuditChainBoundary(tx);
  if (!boundary.supported) {
    throw new Error(`audit-chain: the chain is at serialisation version ${boundary.version}, which this build cannot write`);
  }
  return boundary.v2FromSeq;
}

/**
 * ADR-0188 decision 19 — THE AUDIT v2 CUTOVER, run once, only after every replica runs v2-aware code (a drained
 * rolling deploy: see `docs/runbooks` and the gateway's `audit-v2-cutover` command).
 *
 * One transaction under the chain append lock: read the tip, record `audit_chain_versions (2, tip + 1)`, and
 * append the cutover's own audit row, which is therefore the first v2 row. Because writers read the boundary
 * under the same lock, no append can land a v1 row past it; the database trigger `audit_log_v2_floor`
 * (migration 0184) refuses one from a writer that does not read the boundary at all. Idempotent: a recorded
 * boundary is returned unchanged and nothing is appended.
 *
 * `tx` must be a real transaction on a chained handle (`db.transaction`); a caller passing the top-level db
 * gets one opened here.
 */
export async function runAuditV2Cutover(
  dbOrTx: { transaction: <T>(cb: (tx: never) => Promise<T>) => Promise<T> },
  opts: { setBy: string | null; inTransaction?: boolean },
): Promise<{ fromSeq: number; created: boolean }> {
  const body = async (tx: AuditExec & { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } }) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
    const boundary = await loadAuditChainBoundary(tx as unknown as { execute: (q: SQL) => PromiseLike<unknown> });
    if (!boundary.supported) throw new Error(`audit-chain: the chain is at serialisation version ${boundary.version}, which this build cannot write`);
    if (boundary.v2FromSeq !== null) return { fromSeq: boundary.v2FromSeq, created: false };
    const tip = (await tx
      .select({ seq: auditLog.seq })
      .from(auditLog)
      .where(isNotNull(auditLog.seq))
      .orderBy(desc(auditLog.seq))
      .limit(1)) as Array<{ seq: number | null }>;
    const fromSeq = (tip[0]?.seq ?? AUDIT_GENESIS_SEQ - 1) + 1;
    await tx.execute(sql`insert into "audit_chain_versions" ("version", "from_seq", "set_by") values (2, ${fromSeq}, ${opts.setBy})`);
    // the first v2 row: the cutover itself (still under the lock; this handle chains)
    await tx.insert(auditLog).values({
      userId: opts.setBy ?? "00000000-0000-0000-0000-000000000000",
      objectType: "audit_chain",
      objectId: null,
      detail: { phase: "cutover", version: 2, fromSeq },
      effect: "allow",
      ruleId: "audit-chain-v2-cutover",
      ruleChain: [],
      reason: `audit chain serialisation v2 from seq ${fromSeq} (ADR-0188 decision 19)`,
    });
    return { fromSeq, created: true };
  };
  if (opts.inTransaction) return body(dbOrTx as never);
  return dbOrTx.transaction((tx) => body(tx as never));
}

/** Sentinel for `.returning()` called with no projection. */
const ALL_COLUMNS = Symbol("regulait.audit-chain.returning-all");

/**
 * Stand-in for drizzle's `PgInsertBase`, restricted to what `insert(auditLog)`
 * is ever asked to do across the 158 existing call sites: await it, or ask for
 * `.returning(...)`.
 *
 * It is LAZY and MEMOISED, exactly like the builder it replaces. Lazy, because
 * drizzle's builder only runs when awaited, and a call site that builds one and
 * drops it on the floor must keep doing nothing rather than suddenly writing a
 * row. Memoised, because awaiting the same builder twice must not append twice.
 *
 * A method NOT modelled here (`onConflictDoNothing`, `onConflictDoUpdate`) will
 * throw `not a function` at the call site. That is deliberate: an audit row
 * that silently does not get written, or that overwrites another, is not a
 * behaviour this table should acquire quietly. Adding one means deciding what
 * it means for the chain first.
 */
function chainedInsertBuilder(exec: AuditExec, values: unknown, inTransaction: boolean) {
  const rows = (Array.isArray(values) ? values : [values]) as AuditInsertValues[];
  let started: Promise<unknown> | undefined;
  const run = (returning?: unknown): Promise<unknown> => {
    started ??= inTransaction
      ? appendChainedAuditRows(exec, rows, returning)
      : // Not already in a transaction: open one, because the advisory lock is
        // released at the end of the enclosing transaction and outside one every
        // statement is its own.
        exec.transaction((tx) => appendChainedAuditRows(tx as AuditExec, rows, returning));
    return started;
  };
  return {
    then: (onOk?: ((v: unknown) => unknown) | null, onErr?: ((e: unknown) => unknown) | null) =>
      run().then(onOk, onErr),
    catch: (onErr?: ((e: unknown) => unknown) | null) => run().catch(onErr),
    finally: (onDone?: (() => void) | null) => run().finally(onDone),
    returning: (selection?: unknown) => run(selection === undefined ? ALL_COLUMNS : selection),
  };
}

/**
 * Wrap a drizzle handle so that `insert(auditLog)` chains and `transaction()`
 * hands the callback a handle that chains too.
 *
 * Everything else passes straight through. The wrapper is runtime-only: the
 * returned value keeps the handle's exact type, so nothing downstream — and no
 * type-check — can tell the difference.
 */
export function withAuditChain<T extends object>(target: T, inTransaction = false): T {
  if ((target as Record<symbol, unknown>)[CHAINED]) return target;

  return new Proxy(target, {
    get(t, prop) {
      if (prop === CHAINED) return true;

      if (prop === "insert") {
        return (table: unknown) => {
          const raw = (t as unknown as AuditExec).insert(table);
          if (table !== auditLog) return raw;
          return { values: (v: unknown) => chainedInsertBuilder(t as unknown as AuditExec, v, inTransaction) };
        };
      }

      if (prop === "transaction") {
        return (cb: (tx: unknown) => unknown, config?: unknown) =>
          (t as unknown as { transaction: (c: (tx: unknown) => unknown, cfg?: unknown) => unknown }).transaction(
            (tx: unknown) => cb(withAuditChain(tx as object, true)),
            config,
          );
      }

      // Read with the TARGET as receiver so a getter that touches `this` does
      // not re-enter the proxy, and bind methods for the same reason.
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}
