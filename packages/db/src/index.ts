import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { withAuditChain } from "./audit-chain.js";
import { withProseScrub } from "./prose-scrub.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./migrate.js";
export { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
// Types consumers need to build reusable predicates without taking a direct
// dependency on drizzle-orm (PILLAR 1 rule-scoping SQL pre-filter, etc.).
export type { SQL } from "drizzle-orm";
export type { PgColumn } from "drizzle-orm/pg-core";

export { AUDIT_CHAIN_LOCK_KEY, appendChainedAuditRows, withAuditChain } from "./audit-chain.js";

// ADR-0102 — the operator-prose credential scrub for reason/note columns
// OUTSIDE `audit_log`. Exported so the covered/not-covered inventory can be
// asserted by test rather than only claimed in the ADR.
export {
  PROSE_SCRUB,
  PROSE_SCRUB_EXCLUSIONS,
  proseScrubInventory,
  withProseScrub,
} from "./prose-scrub.js";

// ADR-0109 — the PRE-FLIGHT duplicate report for migration 0108's unique
// constraints. 0108 ADDS and REFUSES; it never repairs. This is how an
// operator finds out what would block the upgrade BEFORE running it.
export {
  DEFERRED_UNIQUE_CHECKS,
  deferredUniqueInventory,
  formatDeferredUniquePreflight,
  runDeferredUniquePreflight,
} from "./deferred-unique-preflight.js";
export type {
  DeferredUniqueCheck,
  DeferredUniqueFinding,
  DeferredUniquePreflightReport,
} from "./deferred-unique-preflight.js";

export type Db = ReturnType<typeof createDb>;

/**
 * The ONE place a database handle is constructed in this repo — server, seeder
 * and every test alike.
 *
 * ADR-0060 makes that fact load-bearing: `withAuditChain` wraps the handle so
 * `insert(auditLog)` computes and stores the hash chain in the same transaction
 * as the row, and `transaction()` propagates the wrapper. The wrapper is
 * runtime-only and type-transparent, so `Db` is unchanged and no caller — not
 * one of the 158 existing `insert(auditLog)` sites, nor the next one written —
 * has to know it exists. See `audit-chain.ts` for why interception here beat
 * both "rewrite every call site" and "do it in a trigger".
 *
 * ADR-0102 leans on the SAME fact for a second control. `withProseScrub` wraps
 * the already-chained handle so that `insert`/`update` of a registered
 * reason/note column scrubs credential material out of it with ADR-0099's own
 * scrubber — closing PENDING S5, where an AWS key typed into an admission-clear
 * reason was redacted in `audit_log` and stored verbatim in
 * `mcp_servers.admission_clear_reason` in the same request.
 *
 * ORDER: prose scrub OUTSIDE, audit chain INSIDE. `insert(auditLog)` must reach
 * the chained builder, and it does — `audit_log` is deliberately not in the
 * prose registry (ADR-0099 already owns that column, before the row is hashed),
 * so the outer wrapper passes it straight through. Wrapping the other way round
 * would work too; this way the two wrappers stay independent and each keeps its
 * own correctness argument.
 */
/**
 * ADR-0167 (CFG-08) — the pool is BOUNDED and its bounds are named.
 *
 * `new pg.Pool({ connectionString })` ran on every default: 10 clients, no
 * connection timeout (a caller waiting for a free client waits FOREVER), no
 * idle timeout, no TLS option. Ten slow operations — a `/v1/audit.csv` walk,
 * waiters on the audit-chain advisory lock, a long report — took every slot
 * and every later request queued indefinitely, including the liveness probe.
 *
 * `connectionTimeoutMillis` is the load-bearing one: in node-postgres it
 * bounds BOTH the TCP connect and the wait for a free client, so an exhausted
 * pool now fails a request with an error after the deadline instead of
 * holding it. No statement timeout is set here on purpose — migrations, the
 * data-key re-encryption walk and backup verification share this pool and run
 * long DDL/scans by design; a per-request statement bound belongs in the
 * request path (`SET LOCAL`), not on the pool.
 */
export interface DbPoolConfig {
  /** clients per process (REGULAIT_DB_POOL_MAX, default 20) */
  max: number;
  /** connect + wait-for-a-client deadline (REGULAIT_DB_CONNECT_TIMEOUT_MS, default 5000) */
  connectionTimeoutMillis: number;
  /** idle client reaped after (REGULAIT_DB_IDLE_TIMEOUT_MS, default 30000) */
  idleTimeoutMillis: number;
  /** REGULAIT_DATABASE_SSL: off (default) | require (verify the server cert) |
   * no-verify (TLS without verification — a self-signed RDS/BYOC box) */
  ssl: "off" | "require" | "no-verify";
}

export const DB_POOL_DEFAULTS: Readonly<DbPoolConfig> = Object.freeze({
  max: 20,
  connectionTimeoutMillis: 5_000,
  // pg's own default, restated rather than raised: the test harness drops its
  // scratch databases after waiting for idle clients to reap, and a longer
  // reap would turn every teardown into a timeout
  idleTimeoutMillis: 10_000,
  ssl: "off",
});

function envPositiveInt(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  // a malformed knob falls back rather than throwing: this package is loaded
  // by every script and test, and a typo must not take the pool down
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt;
}

export function resolveDbPoolConfig(env: NodeJS.ProcessEnv = process.env): DbPoolConfig {
  const rawSsl = (env.REGULAIT_DATABASE_SSL ?? "").trim().toLowerCase();
  const ssl: DbPoolConfig["ssl"] =
    rawSsl === "require" || rawSsl === "verify" || rawSsl === "on" || rawSsl === "true"
      ? "require"
      : rawSsl === "no-verify"
        ? "no-verify"
        : "off";
  return {
    max: envPositiveInt(env, "REGULAIT_DB_POOL_MAX", DB_POOL_DEFAULTS.max),
    connectionTimeoutMillis: envPositiveInt(env, "REGULAIT_DB_CONNECT_TIMEOUT_MS", DB_POOL_DEFAULTS.connectionTimeoutMillis),
    idleTimeoutMillis: envPositiveInt(env, "REGULAIT_DB_IDLE_TIMEOUT_MS", DB_POOL_DEFAULTS.idleTimeoutMillis),
    ssl,
  };
}

/** one line for the gateway's boot posture block */
export function describeDbPool(cfg: DbPoolConfig): string {
  const tls =
    cfg.ssl === "require"
      ? "tls required, server certificate verified"
      : cfg.ssl === "no-verify"
        ? "tls on, server certificate NOT verified (REGULAIT_DATABASE_SSL=no-verify)"
        : "tls off (REGULAIT_DATABASE_SSL unset — set `require` when Postgres is across a network)";
  return `pool max ${cfg.max}, connect/wait deadline ${cfg.connectionTimeoutMillis}ms, idle reap ${cfg.idleTimeoutMillis}ms, ${tls}`;
}

export function createDb(connectionString: string, override: Partial<DbPoolConfig> = {}) {
  const cfg = { ...resolveDbPoolConfig(), ...override };
  const pool = new pg.Pool({
    connectionString,
    max: cfg.max,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    idleTimeoutMillis: cfg.idleTimeoutMillis,
    ...(cfg.ssl === "require"
      ? { ssl: { rejectUnauthorized: true } }
      : cfg.ssl === "no-verify"
        ? { ssl: { rejectUnauthorized: false } }
        : {}),
  });
  return withProseScrub(withAuditChain(drizzle(pool, { schema })));
}
