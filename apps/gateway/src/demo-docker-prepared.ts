/**
 * Docker demo mode (ADR-0174 amendment) — has THIS database already been
 * prepared? Asked by the image's start script (apps/gateway/docker-start.sh)
 * after the seed, only when REGULAIT_DEMO_LICENSE=1 is honoured.
 *
 *   exit 0  prepared      — the start script skips the prep steps
 *   exit 3  not prepared  — it runs demo:setup → demo:intake → demo:traffic → demo:check
 *   exit 2  cannot tell   — it skips them and says so loudly (the database is
 *                           unreadable, so every step would fail too)
 *
 * The marker lives WITH THE DATA, not in a volume: the API keys demo:traffic
 * mints before it sends any traffic (DEMO_TRAFFIC_KEY_NAME). demo:traffic is
 * the one step that is not idempotent (it adds traffic and alerts on every
 * run), and it runs only after demo:setup and demo:intake succeeded, so:
 *  - a restart, or `down` / `up` with volumes kept, finds the marker and does
 *    not re-run traffic or intake;
 *  - `down -v` drops the database and the marker with it, so the next boot
 *    prepares from scratch;
 *  - a prep that stopped at demo:setup or demo:intake left no marker, so the
 *    next boot retries (both are idempotent).
 * Read-only. Environment: DATABASE_URL (the seed has already migrated it).
 */
import { createDb, sql } from "@regulait/db";
import { DEMO_TRAFFIC_KEY_NAME } from "./demo-traffic-lib.js";

const connectionString = process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const db = createDb(connectionString);
(db.$client as { on: (ev: string, fn: (err: Error) => void) => void }).on("error", () => {});

let exitCode = 2;
try {
  const res = await db.execute(
    sql`select count(*)::int as n, min(created_at) as first from api_keys where name = ${DEMO_TRAFFIC_KEY_NAME}`,
  );
  const row = (res as unknown as { rows: Array<{ n: number; first: string | Date | null }> }).rows[0];
  if (row && row.n > 0) {
    const first = row.first ? new Date(row.first).toISOString() : "unknown";
    console.log(`demo prep: this database was already prepared (demo:traffic ran ${first}) — prep steps skipped`);
    exitCode = 0;
  } else {
    console.log("demo prep: this database has not been prepared yet — running the prep steps");
    exitCode = 3;
  }
} catch (err) {
  console.error(`demo prep: could not read whether this database is prepared: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await (db.$client as { end: () => Promise<void> }).end().catch(() => {});
}
process.exit(exitCode);
