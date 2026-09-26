/**
 * ADR-0125 / ROADMAP G1 — a Postgres-backed store for the HTTP edge rate
 * limiter, so its counters survive more than one gateway process.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Every other enforcement counter in this product is already shared, because
 * it is already SQL: the kernel's `rate_limits` rule counts over `audit_log`,
 * project budgets sum `usage_events`, a virtual key's spend is an atomic
 * `spent_usd = spent_usd + x`. The HTTP edge limiter was the exception —
 * `@fastify/rate-limit`'s default store is a `Map` in one process.
 *
 * With one process that is correct. With two it is not approximately wrong, it
 * is wrong by a factor: each process admits the full ceiling independently, so
 * N replicas enforce N × the configured limit *while the posture page still
 * reports the configured number*. Enforcing a number you cannot name is worse
 * than enforcing nothing, because nobody goes looking.
 *
 * ── THE DESIGN, AND THE TRAP IT AVOIDS ─────────────────────────────────────
 * The obvious implementation — one INSERT … ON CONFLICT per request — is
 * correct and would be a mistake. A rate limiter is the cheapest thing in the
 * request path precisely because it is what stands in front of a flood; giving
 * every unauthenticated request a database WRITE hands an attacker a way to
 * turn a request flood into a Postgres flood. The limiter would become the
 * amplifier it exists to prevent.
 *
 * So this store is LOCAL-FIRST and SHARED-AUTHORITATIVE:
 *
 *   1. An in-process counter is bumped first, exactly as before.
 *   2. If the LOCAL count alone is already at the ceiling, refuse immediately
 *      and touch nothing. This is sound rather than a heuristic: local ≤ global
 *      always, so a process that has by itself exceeded the limit has exceeded
 *      it. This is also the property that BOUNDS the write rate — once a
 *      bucket is saturated, further requests cost no database work at all, so
 *      writes per window are capped by (ceiling × processes), never by traffic.
 *   3. Otherwise ask Postgres, atomically, and let its answer win. That is the
 *      number that accounts for the other replicas.
 *
 * ── FIXED WINDOW, DELIBERATELY ─────────────────────────────────────────────
 * The upsert reproduces the default store's FIXED window rather than upgrading
 * to a sliding one. A sliding window would be better behaved, and changing the
 * store is the wrong moment to change what every configured number means. That
 * is a separate decision with its own test expectations.
 *
 * ── WHAT HAPPENS WHEN THE DATABASE IS UNREACHABLE ──────────────────────────
 * It falls back to the local count and serves. This is the one place in this
 * product that deliberately fails OPEN, so it is worth stating why rather than
 * leaving it to be discovered: this gateway cannot answer a single governed
 * request without Postgres — every decision reads it — so a database outage is
 * already a total outage. Failing closed here would convert "Postgres blipped"
 * into "every caller sees 429", which is not more secure, only louder. And the
 * fallback is not unbounded: the local ceiling from step 2 still applies, so a
 * process serving through an outage still enforces the full configured limit
 * on its own traffic. The degradation is exactly the pre-G1 behaviour.
 */
import { sql, type Db } from "@regulait/db";

/** what `@fastify/rate-limit` asks a store for */
export interface RateLimitVerdict {
  current: number;
  ttl: number;
}

interface LocalBucket {
  hits: number;
  windowStartedAt: number;
}

/**
 * How long a counter row is kept. An hour is far longer than any configured
 * window — the widest default is the 5-minute auth bucket — and the margin is
 * the point: deleting a row whose window is still live would reset that
 * caller's count to zero mid-window and hand them a fresh allowance, turning
 * a cleanup job into a documented way around the limit.
 */
export const RATE_LIMIT_COUNTER_RETENTION_MS = 60 * 60 * 1000;

/**
 * Deletes counters whose window can no longer be current under ANY configured
 * ceiling. Hygiene, not enforcement: a stale row is already harmless, because
 * every read compares the window before trusting the count. ADR-0064's rule —
 * enforcement never depends on a sweep — holds, and this is why it can.
 */
export async function pruneRateLimitCounters(db: Db, olderThanMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await db.execute(
    sql`delete from rate_limit_counters where window_started_at < ${cutoff.toISOString()}`,
  );
  return (res as unknown as { rowCount?: number }).rowCount ?? 0;
}

export class SharedRateLimitStore {
  /** the per-process pre-filter from step 1/2 above — NOT the authority */
  private readonly local = new Map<string, LocalBucket>();

  constructor(
    private readonly db: Db,
    /** surfaced so a test can assert the fail-open path was taken rather than
     * inferring it from a number that happens to match */
    private readonly onDbError?: (err: unknown) => void,
  ) {}

  /**
   * ONE statement, so it is atomic without a transaction or a lock. The two
   * CASE arms are the window roll: if the stored window has expired this is
   * the first hit of a NEW window and the count restarts at 1, otherwise it is
   * the next hit of the current one. Both arms must agree about which window
   * they are in, which is why the predicate is written out twice rather than
   * computed once in JavaScript — the comparison has to happen at the same
   * instant, inside the row lock the upsert already takes.
   */
  private async bumpShared(key: string, timeWindowMs: number): Promise<{ hits: number; startedAtMs: number }> {
    const rows = (await this.db.execute(sql`
      insert into rate_limit_counters (bucket, window_started_at, hits)
      values (${key}, now(), 1)
      on conflict (bucket) do update set
        hits = case
          when rate_limit_counters.window_started_at
               <= now() - make_interval(secs => ${timeWindowMs} / 1000.0)
          then 1
          else rate_limit_counters.hits + 1
        end,
        window_started_at = case
          when rate_limit_counters.window_started_at
               <= now() - make_interval(secs => ${timeWindowMs} / 1000.0)
          then now()
          else rate_limit_counters.window_started_at
        end
      returning hits, window_started_at
    `)) as unknown as Array<{ hits: number; window_started_at: string | Date }>;

    const row = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
    const r = row as { hits: number; window_started_at: string | Date } | undefined;
    if (!r) throw new Error("rate-limit upsert returned no row");
    return { hits: Number(r.hits), startedAtMs: new Date(r.window_started_at).getTime() };
  }

  /** bump the local pre-filter and report where this process alone stands */
  private bumpLocal(key: string, timeWindowMs: number): LocalBucket {
    const now = Date.now();
    const existing = this.local.get(key);
    if (!existing || now - existing.windowStartedAt >= timeWindowMs) {
      const fresh = { hits: 1, windowStartedAt: now };
      this.local.set(key, fresh);
      return fresh;
    }
    existing.hits += 1;
    return existing;
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: RateLimitVerdict) => void,
    timeWindowMs: number,
    max: number,
  ): void {
    const localBucket = this.bumpLocal(key, timeWindowMs);
    const ttlOf = (startedAtMs: number) => Math.max(0, timeWindowMs - (Date.now() - startedAtMs));

    // Step 2: this process alone has already gone PAST the ceiling, so this
    // request is refused whatever the other replicas have done — global can
    // only be higher than local. Skipping the write here is what keeps a flood
    // from becoming a write storm.
    //
    // STRICTLY GREATER, not >=, and the difference is load-bearing. At
    // `hits === max` the request is still ALLOWED (the plugin refuses on
    // `current > max`), so short-circuiting there would let each process serve
    // the last request of every window without ever telling the database about
    // it — the shared count would under-report by one per process per window,
    // which is exactly the kind of quiet drift this change exists to remove. A
    // test asserts the counter reaches `max` before it stops advancing.
    //
    // Writes stay bounded regardless: they only happen while local <= max, so
    // at most `max` per process per window however long the flood lasts.
    if (localBucket.hits > max) {
      callback(null, { current: localBucket.hits, ttl: ttlOf(localBucket.windowStartedAt) });
      return;
    }

    void this.bumpShared(key, timeWindowMs).then(
      ({ hits, startedAtMs }) => {
        // Keep the local pre-filter from lagging the shared truth: without
        // this, a bucket saturated by OTHER replicas would still cost this one
        // a database round trip on every subsequent request.
        if (hits > localBucket.hits) localBucket.hits = hits;
        callback(null, { current: hits, ttl: ttlOf(startedAtMs) });
      },
      (err: unknown) => {
        this.onDbError?.(err);
        callback(null, { current: localBucket.hits, ttl: ttlOf(localBucket.windowStartedAt) });
      },
    );
  }

  /** The plugin asks for a per-route child. Ours is route-agnostic: the bucket
   * is derived from the CALLER, not the path, so every route shares one
   * counter per caller and a child is just this store. */
  child(): SharedRateLimitStore {
    return this;
  }
}
