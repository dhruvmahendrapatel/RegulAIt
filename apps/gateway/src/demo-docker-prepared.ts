/**
 * Docker demo mode (ADR-0174 amendment) — has THIS database already been
 * prepared? Asked by the image's start script (apps/gateway/docker-start.sh)
 * BEFORE the seed, only when REGULAIT_DEMO_LICENSE=1 is honoured.
 *
 *   exit 0  prepared      — the start script runs the ordinary seed and skips the prep
 *   exit 3  empty         — it runs the whole `demo:prepare` order (demo-prepare-steps.ts)
 *   exit 4  started, not prepared — the database holds users but no prep marker (an
 *                           earlier prep stopped part-way, or it was seeded without the
 *                           switch). The prep cannot finish in place: its first step,
 *                           demo:shadow --setup, needs the first-admin-setup window, which
 *                           the seed closed. The script says so and runs the ordinary seed
 *   exit 2  cannot tell   — it runs the ordinary seed and says so loudly (the database is
 *                           unreadable, so every step would fail too)
 *
 * The marker lives WITH THE DATA, not in a volume: the API keys demo:traffic
 * mints before it sends any traffic (DEMO_TRAFFIC_KEY_NAME). demo:traffic is
 * the one step that is not idempotent (it adds traffic and alerts on every
 * run), and it runs only after every earlier step succeeded, so:
 *  - a restart, or `down` / `up` with volumes kept, finds the marker and does
 *    not re-run any step;
 *  - `down -v` drops the database and the marker with it, so the next boot
 *    finds an empty database and prepares from scratch.
 * "Empty" is a database with no schema yet (a fresh volume: the seed has not
 * migrated it) or with no user. Read-only. Environment: DATABASE_URL.
 */
import { createDb, sql } from "@regulait/db";
import { DEMO_TRAFFIC_KEY_NAME } from "./demo-traffic-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const db = createDb(connectionString);
(db.$client as { on: (ev: string, fn: (err: Error) => void) => void }).on("error", () => {});

let exitCode = 2;
/** Postgres undefined_table: a fresh volume the seed has not migrated yet */
const isUndefinedTable = (err: unknown): boolean => {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "42P01") return true;
  }
  return false;
};
try {
  const res = await db.execute(
    sql`select (select count(*)::int from api_keys where name = ${DEMO_TRAFFIC_KEY_NAME}) as n,
               (select min(created_at) from api_keys where name = ${DEMO_TRAFFIC_KEY_NAME}) as first,
               (select count(*)::int from users) as users`,
  );
  const row = (res as unknown as { rows: Array<{ n: number; first: string | Date | null; users: number }> }).rows[0];
  if (row && row.n > 0) {
    const first = row.first ? new Date(row.first).toISOString() : "unknown";
    console.log(`demo prep: this database was already prepared (demo:traffic ran ${first}) — prep steps skipped`);
    exitCode = 0;
  } else if (row && row.users > 0) {
    console.error(
      "demo prep: this database holds users but was never fully prepared (an earlier prep stopped part-way, or it was " +
        "seeded without REGULAIT_DEMO_LICENSE=1); the prep needs an EMPTY database",
    );
    exitCode = 4;
  } else {
    console.log("demo prep: this database is empty — running the demo:prepare steps");
    exitCode = 3;
  }
} catch (err) {
  if (isUndefinedTable(err)) {
    console.log("demo prep: this database is empty (not migrated yet) — running the demo:prepare steps");
    exitCode = 3;
  } else {
    console.error(`demo prep: could not read whether this database is prepared: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  await (db.$client as { end: () => Promise<void> }).end().catch(() => {});
}
process.exit(exitCode);
