/**
 * ADR-0343 — one helper for "only one process in the cluster runs this at a time".
 *
 * A SESSION-level `pg_advisory_lock` held on one dedicated pool connection for the whole of `fn`. Every replica of the
 * gateway, the migration Job and any worker share the database, so the lock is cluster-wide without any extra service
 * (advisory locks are per database). `fn` may use other pool connections: the lock is about mutual exclusion, not about
 * which connection does the work.
 *
 * If the unlock cannot run (the connection died, the primary failed over), the connection is destroyed rather than
 * returned to the pool, and the server releases the lock with the session. After a failover the new primary never saw
 * the lock, so the next caller acquires it at once: the work this protects must be idempotent or transactional, which
 * migrations and runtime-login provisioning are.
 *
 * OPEN SOURCE FIRST (ADR-0176): Postgres's own advisory locks; nothing to adopt. It replaces the hand-written copy that
 * `withRuntimeLoginLock` carried.
 */

/** a minimal raw query surface (a `pg` Pool or PoolClient) */
export interface RawQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}
interface RawPool {
  connect: () => Promise<RawQueryable & { release: (err?: Error | boolean) => void }>;
}

/**
 * The bigint keys every caller of `withSessionAdvisoryLock` uses. They live in one table so a new key cannot collide
 * with an old one; the transaction-scoped keys listed in audit-chain.ts are a separate, smaller range.
 */
export const SESSION_LOCK_KEYS = {
  /** runtime-login provisioning (ADR-0234 batch 7b): "REGALRLS" */
  runtimeLogin: 0x5245_4741_4c52_4c53n,
  /** the migration run at boot and in the migration Job (ADR-0343): "REGAMIGR" */
  migrations: 0x5245_4741_4d49_4752n,
} as const;

/** how often a waiting process retries the lock */
export const SESSION_LOCK_POLL_MS = 250;

export async function withSessionAdvisoryLock<T>(
  owner: { $client: unknown },
  key: bigint,
  fn: (client: RawQueryable) => Promise<T>,
  opts: { onWait?: () => void; pollMs?: number } = {},
): Promise<T> {
  const pollMs = opts.pollMs ?? SESSION_LOCK_POLL_MS;
  const client = await (owner.$client as RawPool).connect();
  let broken: Error | undefined;
  try {
    try {
      // POLL, never block: a backend blocked in `pg_advisory_lock` is a running statement with a snapshot, and the
      // holder's `CREATE INDEX CONCURRENTLY` (buildConcurrentIndexes) waits for every such snapshot to end, so a
      // blocking waiter would deadlock the run it waits for. Each try is a short statement that ends at once.
      for (let said = false; ; ) {
        const got = await client.query("select pg_catalog.pg_try_advisory_lock($1::bigint) as ok", [key.toString()]);
        if ((got.rows[0] as { ok?: boolean } | undefined)?.ok) break;
        if (!said) {
          opts.onWait?.();
          said = true;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch (e) {
      // a connection that failed mid-acquire may still hold the lock: destroy it rather than pool it
      broken = e instanceof Error ? e : new Error(String(e));
      throw e;
    }
    try {
      return await fn(client);
    } finally {
      await client.query("select pg_catalog.pg_advisory_unlock($1::bigint)", [key.toString()]).catch((e: Error) => {
        broken = e;
      });
    }
  } finally {
    client.release(broken ?? false);
  }
}
