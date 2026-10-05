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
  /** REGULAIT_DATABASE_SSL (ADR-0181): require (DEFAULT — TLS, server cert
   * verified) | no-verify (TLS without verification — a self-signed RDS/BYOC
   * box) | disable (plaintext — a local Postgres without TLS, e.g. the demo
   * and docker-compose, which set it explicitly). `off` is the resolved name
   * of `disable`. */
  ssl: "off" | "require" | "no-verify";
}

export const DB_POOL_DEFAULTS: Readonly<DbPoolConfig> = Object.freeze({
  max: 20,
  connectionTimeoutMillis: 5_000,
  // pg's own default, restated rather than raised: the test harness drops its
  // scratch databases after waiting for idle clients to reap, and a longer
  // reap would turn every teardown into a timeout
  idleTimeoutMillis: 10_000,
  // ADR-0181: TLS is required unless the environment explicitly says disable
  ssl: "require",
});

/** the explicit opt-outs. Anything else that is set but unrecognised resolves
 * to `require`: a typo must fail toward TLS, never toward plaintext. */
const DB_SSL_DISABLE_VALUES = ["disable", "disabled", "off", "false", "0", "no"] as const;

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
  const ssl: DbPoolConfig["ssl"] = (DB_SSL_DISABLE_VALUES as readonly string[]).includes(rawSsl)
    ? "off"
    : rawSsl === "no-verify"
      ? "no-verify"
      : "require";
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
        : "TLS OFF — RELAXED (REGULAIT_DATABASE_SSL=disable): the database hop is plaintext; acceptable only for a local Postgres on this host";
  return `pool max ${cfg.max}, connect/wait deadline ${cfg.connectionTimeoutMillis}ms, idle reap ${cfg.idleTimeoutMillis}ms, ${tls}`;
}

/** ADR-0181: the database hop's TLS posture in one word, for the posture read.
 * `required` is the default; `unverified` is TLS without certificate checks;
 * `relaxed` is plaintext (an explicit REGULAIT_DATABASE_SSL=disable). */
export type DatabaseTlsPosture = "required" | "unverified" | "relaxed";

export function databaseTlsPosture(cfg: Pick<DbPoolConfig, "ssl">): DatabaseTlsPosture {
  return cfg.ssl === "require" ? "required" : cfg.ssl === "no-verify" ? "unverified" : "relaxed";
}

/** ADR-0181: the LOUD boot warning when TLS to Postgres is off. Empty when it
 * is on. Lines, so the caller's logger prints each one. */
export function databaseTlsBootWarning(cfg: Pick<DbPoolConfig, "ssl">): string[] {
  if (cfg.ssl !== "off") return [];
  const bar = "!".repeat(78);
  return [
    bar,
    "!! WARNING: DATABASE TLS IS OFF (REGULAIT_DATABASE_SSL=disable) — RELAXED POSTURE",
    "!! Every query, credential envelope and audit row crosses the database hop in",
    "!! plaintext. This is acceptable ONLY for a Postgres on this host (the local",
    "!! demo, docker-compose). Unset the variable, or set `require`, for any other.",
    "!! GET /v1/org/posture reports `databaseTls: relaxed` while this is set.",
    bar,
  ];
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
  // REL-01 — an IDLE client's backend error is an EVENT, not a rejection.
  //
  // node-postgres emits `'error'` on the Pool when a client that is sitting
  // idle in it loses its backend (`pg_terminate_backend`, a Postgres restart
  // or failover, an LB/NAT idle reset, a laptop resuming from sleep). With no
  // listener Node's EventEmitter THROWS that event, and the whole gateway —
  // every governed call, the SPA, /health — died with "Unhandled 'error'
  // event" over one connection the pool was about to discard anyway. Every
  // CLI script in this repo had bolted its own `.on("error", () => {})` onto
  // `$client`; the one process that serves traffic was the one without it.
  //
  // The pool removes the errored client itself and dials a fresh one on the
  // next checkout, so the only correct reaction here is to SAY it happened.
  // Queries in flight on that client still fail through their own awaited
  // promise, exactly as before — nothing is swallowed, only the crash.
  pool.on("error", (err: Error & { code?: string }) => {
    console.error(
      `[regulait] postgres: an idle pooled connection was dropped (${err.code ?? "no code"}: ${err.message}) — ` +
        "the pool discards it and reconnects on next use; nothing in flight was affected",
    );
  });
  // REL-01, the same crash on a CHECKED-OUT client.
  //
  // The `pool.on("error")` above only guards clients sitting IDLE in the pool.
  // For the whole span a client is checked out — a query, or a transaction —
  // pg-pool REMOVES its error listener and restores it only on release, so a
  // backend that dies mid-statement (`pg_terminate_backend`, a failover, an LB
  // or NAT reset under a live request) emits `'error'` on a listener-less
  // client and Node THROWS it, killing the serving process — even though the
  // in-flight query already rejected through its own awaited promise. The idle
  // handler cannot catch this one: by the time the client is back in the pool
  // it is already gone.
  //
  // So every physical connection gets a durable listener the moment it is
  // created — `'connect'` fires once per new client, before any query runs on
  // it, and the listener is never removed — which survives the checkout window
  // the pool's own listener does not cover. Nothing is swallowed: the query
  // still fails through its promise exactly as before (the route logs its 500),
  // and the pool discards the dead client and dials a fresh one on next use.
  // This only stops the crash, and says it happened.
  //
  // IT SPEAKS ONLY WHILE THE CLIENT IS CHECKED OUT. Being durable, the listener
  // is also attached while the client sits idle — and an idle drop is already
  // reported, once and accurately, by the pool's own `'error'` handler above.
  // Speaking there too printed "lost mid-use … the in-flight query fails"
  // beside "nothing in flight was affected" for every idle LB reset or
  // failover: two contradictory lines about one event, the wrong one telling
  // the operator a request failed when none did. So checkout is tracked with
  // the pool's own `'acquire'` / `'release'` events (both emitted
  // synchronously, around exactly the window in which pg-pool strips its idle
  // listener), and the mid-use line is printed only inside that window.
  // Outside it the listener still exists — it is what stops the throw — but it
  // stays silent and leaves the reporting to the idle handler.
  type PooledClient = { on(ev: "error", cb: (e: Error & { code?: string }) => void): void };
  const checkedOut = new WeakSet<PooledClient>();
  pool.on("acquire", (client: PooledClient) => {
    checkedOut.add(client);
  });
  pool.on("release", (_err: Error | undefined, client: PooledClient) => {
    checkedOut.delete(client);
  });
  pool.on("connect", (client: PooledClient) => {
    client.on("error", (err) => {
      if (!checkedOut.has(client)) return; // idle: the pool's handler above reports it
      console.error(
        `[regulait] postgres: a pooled connection was lost mid-use (${err.code ?? "no code"}: ${err.message}) — ` +
          "the in-flight query fails and the pool reconnects on next use; the serving process survives",
      );
    });
  });
  return withProseScrub(withAuditChain(drizzle(pool, { schema })));
}
