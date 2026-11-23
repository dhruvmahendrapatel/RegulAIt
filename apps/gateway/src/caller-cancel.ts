/**
 * ADR-0364 S3 (owner, D-2026-11-22-07) — A CALLER'S CANCEL, ON EVERY REPLICA.
 *
 * The proxy is stateless (one `Server` per HTTP request), so a client's `notifications/cancelled` (sent when it cancels,
 * or when its own request timeout fires) arrives on ANOTHER request, often at another gateway replica than the one
 * serving the call. Two parts:
 *
 *  - LOCAL: the requests this process serves, by the caller's scope (its user, server and credential) and JSON-RPC id
 *    (`trackCallerRequest`). A cancel the receiving process serves is aborted at once (`cancelCallerRequest`). A scope
 *    is never shared between credentials, so one caller can cancel only its own calls.
 *  - SHARED: a cancel the receiving process does not serve is written to `mcp_caller_cancellations`
 *    (`broadcastCallerCancel`, keyed by a scrypt hash of scope and id). Every process with calls in flight watches that
 *    table (one indexed read per second, only while it serves calls) and aborts a call whose key appears after the call
 *    started. The abort reaches the upstream and, for a robot tool, the run (`startRobotRun` cancels on it).
 *
 * FAIL CLOSED: a robot run's heartbeat asks `confirmCallerCancels()`. It answers true only when the watch read the
 * table within the last few seconds (or reads it now, within a bound); a run whose cancel state cannot be confirmed is
 * stopped, because an uncertain state means stop.
 */
import { scryptSync } from "node:crypto";
import { inArray, lt, mcpCallerCancellations, runWithRlsSystem, sql, type Db } from "@regulait/db";

/** how often the watch reads the shared table while calls are in flight */
export const CALLER_CANCEL_POLL_MS = 1000;
/** a read older than this does not confirm the state; the heartbeat reads again */
const FRESH_MS = 3000;
/** the bound on that read; past it the state is unconfirmed */
const CONFIRM_TIMEOUT_MS = 2000;
/** a shared cancel counts for a call that started at most this long after it (clock skew between replicas and DB) */
const SKEW_MS = 2000;
/** rows older than this are deleted by the watch */
const ROW_TTL_MS = 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 1000;

interface Tracked {
  readonly ctrl: AbortController;
  readonly startedAt: number;
  readonly requestKey: string;
}

const inFlightCalls = new Map<string, Set<Tracked>>();
const localKey = (scope: string, requestId: string | number) => `${scope}\u0000${typeof requestId}:${String(requestId)}`;

/** the fixed, versioned domain of the shared key (never the token-hash salt: a key is never a token's lookup hash) */
const REQUEST_KEY_SALT = "regulait.mcp-caller-cancel.v1";
const REQUEST_KEY_PARAMS = { N: 1024, r: 8, p: 1 } as const;

/**
 * The shared key of one caller request: no raw scope (it holds credential ids) is stored. Deterministic, so every
 * replica derives the same key. scrypt rather than a bare digest, as for every value derived from a credential
 * (token-hash.ts; CodeQL js/insufficient-password-hash is fixed in code, never dismissed). About a millisecond.
 */
export function callerRequestKey(scope: string, requestId: string | number): string {
  return scryptSync(localKey(scope, requestId), REQUEST_KEY_SALT, 32, REQUEST_KEY_PARAMS).toString("hex");
}

let store: Db | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastOkAt = 0;
let lastPruneAt = 0;
let polling: Promise<boolean> | null = null;
/** bumped by the test seam, so a read begun before it cannot count as a good read after it */
let generation = 0;
/** tests only: replaces the shared read (to simulate a database that does not answer) */
let readOverride: ((keys: string[]) => Promise<Array<{ requestKey: string; createdAt: Date }>>) | null = null;

function startWatch(): void {
  if (timer || !store) return;
  // the tick runs in system_task, like every scheduled interval (the RLS census, zz-adr0234-rls-batch7a)
  timer = setInterval(() => void runWithRlsSystem("system_task", "mcp.caller-cancel.tick", () => pollOnce()), CALLER_CANCEL_POLL_MS);
  timer.unref?.();
  void pollOnce();
}

function stopWatchIfIdle(): void {
  if (inFlightCalls.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
}

async function readShared(db: Db, keys: string[]): Promise<Array<{ requestKey: string; createdAt: Date }>> {
  if (readOverride) return readOverride(keys);
  return runWithRlsSystem("system_task", "mcp.caller-cancel.watch", () =>
    db
      .select({ requestKey: mcpCallerCancellations.requestKey, createdAt: mcpCallerCancellations.createdAt })
      .from(mcpCallerCancellations)
      .where(inArray(mcpCallerCancellations.requestKey, keys)),
  );
}

/** one read of the shared table: aborts each matching call; true when the read answered */
function pollOnce(): Promise<boolean> {
  if (polling) return polling;
  const db = store;
  const gen = generation;
  polling = (async () => {
    const byKey = new Map<string, Tracked[]>();
    for (const set of inFlightCalls.values()) for (const t of set) byKey.set(t.requestKey, [...(byKey.get(t.requestKey) ?? []), t]);
    if (byKey.size === 0) {
      lastOkAt = Date.now();
      return true;
    }
    if (!db) return false;
    try {
      const rows = await readShared(db, [...byKey.keys()]);
      for (const row of rows) {
        for (const t of byKey.get(row.requestKey) ?? []) {
          if (row.createdAt.getTime() >= t.startedAt - SKEW_MS) t.ctrl.abort("cancelled by the caller (received by another gateway replica)");
        }
      }
      if (gen !== generation) return false;
      lastOkAt = Date.now();
      if (lastOkAt - lastPruneAt > PRUNE_EVERY_MS) {
        lastPruneAt = lastOkAt;
        await runWithRlsSystem("system_task", "mcp.caller-cancel.prune", () =>
          db.delete(mcpCallerCancellations).where(lt(mcpCallerCancellations.createdAt, new Date(lastOkAt - ROW_TTL_MS))),
        ).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    polling = null;
  });
  return polling;
}

/**
 * Track one request a caller sent: the returned signal aborts when the request's own signal does (its connection
 * closed), when the same caller cancels it by id on this process, or (with `db`) when a cancel for it is written by
 * any replica. `done` must be called when the request ends.
 */
export function trackCallerRequest(scope: string, requestId: string | number, parent: AbortSignal, db?: Db): { signal: AbortSignal; done: () => void } {
  if (db) store ??= db;
  const ctrl = new AbortController();
  const key = localKey(scope, requestId);
  const onParent = () => ctrl.abort(parent.reason);
  if (parent.aborted) ctrl.abort(parent.reason);
  else parent.addEventListener("abort", onParent, { once: true });
  const tracked: Tracked = { ctrl, startedAt: Date.now(), requestKey: callerRequestKey(scope, requestId) };
  let set = inFlightCalls.get(key);
  if (!set) inFlightCalls.set(key, (set = new Set()));
  set.add(tracked);
  startWatch();
  return {
    signal: ctrl.signal,
    done: () => {
      parent.removeEventListener("abort", onParent);
      const s = inFlightCalls.get(key);
      if (!s) return;
      s.delete(tracked);
      if (s.size === 0) inFlightCalls.delete(key);
      stopWatchIfIdle();
    },
  };
}

/** the caller cancelled request `requestId`: abort it, if this process serves it for the same scope */
export function cancelCallerRequest(scope: string, requestId: string | number | undefined, reason?: string): boolean {
  if (requestId === undefined) return false;
  const set = inFlightCalls.get(localKey(scope, requestId));
  if (!set || set.size === 0) return false;
  for (const t of set) t.ctrl.abort(reason ?? "cancelled by the caller");
  return true;
}

/**
 * A cancel this process does not serve: written for every replica to see. A repeated cancel refreshes the row's time,
 * so it applies to the call in flight now. Returns false when the write failed (the caller is not told: a notification
 * has no answer; the call still ends at its deadline).
 */
export async function broadcastCallerCancel(db: Db, scope: string, userId: string, requestId: string | number): Promise<boolean> {
  try {
    await runWithRlsSystem("system_task", "mcp.caller-cancel.broadcast", () =>
      db
        .insert(mcpCallerCancellations)
        .values({ requestKey: callerRequestKey(scope, requestId), userId })
        .onConflictDoUpdate({ target: mcpCallerCancellations.requestKey, set: { createdAt: sql`now()` } }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this process's view of shared cancels is current: true when the watch read the table within FRESH_MS, or
 * reads it now within CONFIRM_TIMEOUT_MS. False means the state is unconfirmed (a robot run is then stopped).
 */
export async function confirmCallerCancels(): Promise<boolean> {
  if (Date.now() - lastOkAt <= FRESH_MS) return true;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    t = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS);
    t.unref?.();
  });
  try {
    return await Promise.race([pollOnce(), timeout]);
  } finally {
    clearTimeout(t);
  }
}

/** tests only: how many caller requests this process tracks */
export function trackedCallerRequestsForTest(): number {
  let n = 0;
  for (const s of inFlightCalls.values()) n += s.size;
  return n;
}

/** tests only: read the shared table now (as the watch does each second) */
export async function pollCallerCancelsForTest(): Promise<boolean> {
  if (polling) await polling; // a read already under way may predate what the test just wrote
  return pollOnce();
}

/** tests only: replace the shared read (null restores it), and forget the last good read */
export function setCallerCancelReadForTest(fn: ((keys: string[]) => Promise<Array<{ requestKey: string; createdAt: Date }>>) | null): void {
  readOverride = fn;
  lastOkAt = 0;
  generation += 1;
  polling = null;
}
