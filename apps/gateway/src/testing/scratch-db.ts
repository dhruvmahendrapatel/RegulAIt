/**
 * Deterministic teardown for suites that create — and then drop — their own
 * scratch database.
 *
 * WHY THIS EXISTS
 * ---------------
 * `pool.end()` does NOT wait for its connections to actually close. pg-pool's
 * shutdown path (`_pulseQueue`, `ending` branch) splices each client out of its
 * own `_clients` array, calls `client.end()` WITHOUT awaiting it, then — in the
 * same synchronous tick — sees an empty array and resolves the promise that
 * `await pool.end()` is sitting on. The Terminate message has at that point
 * only been queued on the socket; the server-side backend is still alive and
 * still counted in `pg_stat_activity`.
 *
 * `DROP DATABASE ... WITH (FORCE)` terminates every backend still attached to
 * the target. So the statement issued immediately after `await pool.end()` is
 * racing that backend's own exit — two independent connections, no ordering
 * guarantee between them. Lose the race and the dying backend sends
 * `FATAL 57P01 admin_shutdown` up a socket the pool is still reading. pg turns
 * that into an `'error'` event on the Pool; a Pool with no `'error'` listener
 * re-throws it as an uncaught exception, and vitest reports a run-level error
 * and exits non-zero — with every test green. The race is invisible on an idle
 * laptop and reliable on a loaded CI runner.
 *
 * The fix is to stop guessing: ask Postgres itself when the connections are
 * really gone, and only then drop. `WITH (FORCE)` is kept as a belt-and-braces
 * safety net for a database left behind by a previously crashed run — with
 * this wait in front of it, it has nothing left to force.
 */
import { sql, type Db } from "@regulait/db";

/**
 * Block until Postgres reports no backend attached to `dbName` (excluding the
 * connection asking the question). Throws — rather than hanging or silently
 * continuing — if something is still attached after `timeoutMs`, because at
 * that point a suite really has leaked a connection and should say so.
 */
export async function waitForNoBackends(admin: Db, dbName: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await admin.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = ${dbName} and pid <> pg_backend_pid()`,
    );
    const remaining = Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
    if (remaining === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${remaining} connection(s) still attached to "${dbName}" after ${timeoutMs}ms — ` +
          `teardown cannot drop it safely. Something opened a connection it never closed.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Drop a scratch database once nothing is connected to it. Use this instead of
 * a bare `DROP DATABASE ... WITH (FORCE)` in `afterAll`.
 *
 * `admin` must be connected to a DIFFERENT database than `dbName`.
 */
export async function dropScratchDatabase(admin: Db, dbName: string): Promise<void> {
  await waitForNoBackends(admin, dbName);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
}

/**
 * Run every step even if an earlier one throws, then rethrow the first failure.
 * Teardown must never abandon a resource because an earlier close failed.
 */
export async function closeAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  let first: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      first ??= err;
    }
  }
  if (first !== undefined) throw first;
}
