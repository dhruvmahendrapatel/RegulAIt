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

export {
  AUDIT_CHAIN_LOCK_KEY,
  AuditChainSchemaBehindError,
  appendChainedAuditRows,
  loadAuditChainBoundary,
  readAuditV2Boundary,
  runWithAuditActor,
  runAuditV2Cutover,
  currentAuditActor,
  withAuditChain,
  type AuditActorStamp,
} from "./audit-chain.js";

// ADR-0189 — the per-decision and per-subject lock targets of the BOM writers
export { BOM_DECISION_LOCK_NAMESPACE, BOM_SUBJECT_LOCK_NAMESPACE, lockAiBomSubject, lockDecisionForBom } from "./bom-locks.js";
// ADR-0189 B3 — the session-level per-subject lock taken before a REPEATABLE READ capture
export { BOM_SUBJECT_LOCK_TIMEOUT_MS, BomSubjectBusyError, withAiBomSubjectSessionLock, type BoundBomDb } from "./bom-session-lock.js";

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
  /** ADR-0181 FX3: what the CONNECTION STRING itself says about TLS. pg merges
   * the URL's `sslmode` / `ssl` parameters OVER the pool config, so a
   * `DATABASE_URL` ending `?sslmode=disable` turned TLS off whatever
   * `REGULAIT_DATABASE_SSL` said. `off` = the URL asks for plaintext or
   * opportunistic TLS (`sslmode=disable|allow|prefer`, `ssl=0|false`);
   * `no-verify` = TLS without certificate checks (`sslmode=no-verify`, or the
   * libpq-compatible `require` / `verify-ca`). Absent = the URL says nothing
   * weaker than the pool config. */
  urlSsl?: { effect: "off" | "no-verify"; param: string };
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

/** ADR-0181 FX3: the URL parameter values that make the hop plaintext, or
 * plaintext on the server's say-so (`allow` and `prefer` are opportunistic in
 * libpq: an attacker on the path simply declines TLS). */
const URL_SSLMODE_PLAINTEXT = ["disable", "allow", "prefer"] as const;
const URL_SSL_PLAINTEXT = ["0", "false"] as const;

/**
 * ADR-0181 FX3: read what a connection string says about TLS. Only its query
 * string matters (pg-connection-string reads `sslmode`, `ssl` and
 * `uselibpqcompat` from there), so it is read with the standard
 * `URLSearchParams`: that works for every form pg accepts (URL or socket
 * path), and it never throws or touches the disk, which pg-connection-string's
 * own `parse` does (it reads `sslrootcert` files and throws on some modes).
 */
export function connectionStringTls(connectionString: string | undefined): DbPoolConfig["urlSsl"] {
  if (!connectionString) return undefined;
  const q = connectionString.indexOf("?");
  if (q < 0) return undefined;
  const params = new URLSearchParams(connectionString.slice(q + 1));
  const sslmode = params.get("sslmode")?.trim().toLowerCase();
  const ssl = params.get("ssl")?.trim().toLowerCase();
  if (sslmode !== undefined && (URL_SSLMODE_PLAINTEXT as readonly string[]).includes(sslmode)) {
    return { effect: "off", param: `sslmode=${sslmode}` };
  }
  if (sslmode === undefined && ssl !== undefined && (URL_SSL_PLAINTEXT as readonly string[]).includes(ssl)) {
    return { effect: "off", param: `ssl=${ssl}` };
  }
  if (sslmode === "no-verify") return { effect: "no-verify", param: "sslmode=no-verify" };
  const libpq = params.get("uselibpqcompat")?.trim().toLowerCase() === "true";
  if (libpq && (sslmode === "require" || sslmode === "verify-ca")) {
    // libpq semantics: `require` checks no certificate, `verify-ca` no host name
    return { effect: "no-verify", param: `uselibpqcompat=true&sslmode=${sslmode}` };
  }
  return undefined;
}

export function resolveDbPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
  connectionString: string | undefined = env.DATABASE_URL,
): DbPoolConfig {
  const rawSsl = (env.REGULAIT_DATABASE_SSL ?? "").trim().toLowerCase();
  const ssl: DbPoolConfig["ssl"] = (DB_SSL_DISABLE_VALUES as readonly string[]).includes(rawSsl)
    ? "off"
    : rawSsl === "no-verify"
      ? "no-verify"
      : "require";
  const urlSsl = connectionStringTls(connectionString);
  return {
    max: envPositiveInt(env, "REGULAIT_DB_POOL_MAX", DB_POOL_DEFAULTS.max),
    connectionTimeoutMillis: envPositiveInt(env, "REGULAIT_DB_CONNECT_TIMEOUT_MS", DB_POOL_DEFAULTS.connectionTimeoutMillis),
    idleTimeoutMillis: envPositiveInt(env, "REGULAIT_DB_IDLE_TIMEOUT_MS", DB_POOL_DEFAULTS.idleTimeoutMillis),
    ssl,
    ...(urlSsl ? { urlSsl } : {}),
  };
}

/**
 * ADR-0181 FX3: the boot refusal. A connection string may not weaken TLS
 * below what the environment declares: pg would silently obey the URL, and the
 * boot log and posture read would report `required` over a plaintext hop.
 * Plaintext in the URL needs `REGULAIT_DATABASE_SSL=disable` too; an
 * unverified URL needs `no-verify` (or `disable`). `null` = consistent.
 */
export function databaseTlsRefusal(cfg: Pick<DbPoolConfig, "ssl" | "urlSsl">): string | null {
  const url = cfg.urlSsl;
  if (!url) return null;
  if (url.effect === "off" && cfg.ssl !== "off") {
    return (
      `DATABASE_URL carries '${url.param}', which turns database TLS off (or lets the server decline it), but ` +
      `REGULAIT_DATABASE_SSL is not 'disable'. Refusing to start rather than run a plaintext database hop that would ` +
      `be reported as TLS. Remove '${url.param}' from the URL, or, only for a Postgres on this host, also set ` +
      `REGULAIT_DATABASE_SSL=disable (reported as a relaxed posture, with a boot warning).`
    );
  }
  if (url.effect === "no-verify" && cfg.ssl === "require") {
    return (
      `DATABASE_URL carries '${url.param}', which skips server certificate verification, but ` +
      `REGULAIT_DATABASE_SSL requires a verified certificate. Refusing to start. Remove '${url.param}' from the URL, ` +
      `or also set REGULAIT_DATABASE_SSL=no-verify (reported as unverified).`
    );
  }
  return null;
}

/** one line for the gateway's boot posture block */
export function describeDbPool(cfg: DbPoolConfig): string {
  const posture = databaseTlsPosture(cfg);
  const via = cfg.urlSsl ? ` (DATABASE_URL ${cfg.urlSsl.param})` : "";
  const tls =
    posture === "required"
      ? "tls required, server certificate verified"
      : posture === "unverified"
        ? `tls on, server certificate NOT verified (REGULAIT_DATABASE_SSL=no-verify)${via}`
        : `TLS OFF — RELAXED (REGULAIT_DATABASE_SSL=disable)${via}: the database hop is plaintext; acceptable only for a local Postgres on this host`;
  return `pool max ${cfg.max}, connect/wait deadline ${cfg.connectionTimeoutMillis}ms, idle reap ${cfg.idleTimeoutMillis}ms, ${tls}`;
}

/** ADR-0181: the database hop's TLS posture in one word, for the posture read.
 * `required` is the default; `unverified` is TLS without certificate checks;
 * `relaxed` is plaintext (an explicit REGULAIT_DATABASE_SSL=disable). */
export type DatabaseTlsPosture = "required" | "unverified" | "relaxed";

export function databaseTlsPosture(cfg: Pick<DbPoolConfig, "ssl" | "urlSsl">): DatabaseTlsPosture {
  // ADR-0181 FX3: the WEAKER of the environment and the connection string,
  // because pg obeys the URL's parameters over the pool config
  if (cfg.ssl === "off" || cfg.urlSsl?.effect === "off") return "relaxed";
  if (cfg.ssl === "no-verify" || cfg.urlSsl?.effect === "no-verify") return "unverified";
  return "required";
}

/** ADR-0181: the LOUD boot warning when TLS to Postgres is off. Empty when it
 * is on. Lines, so the caller's logger prints each one. */
export function databaseTlsBootWarning(cfg: Pick<DbPoolConfig, "ssl" | "urlSsl">): string[] {
  if (databaseTlsPosture(cfg) !== "relaxed") return [];
  const bar = "!".repeat(78);
  return [
    bar,
    "!! WARNING: DATABASE TLS IS OFF (REGULAIT_DATABASE_SSL=disable) — RELAXED POSTURE",
    ...(cfg.urlSsl?.effect === "off" ? [`!! DATABASE_URL also carries '${cfg.urlSsl.param}'.`] : []),
    "!! Every query, credential envelope and audit row crosses the database hop in",
    "!! plaintext. This is acceptable ONLY for a Postgres on this host (the local",
    "!! demo, docker-compose). Unset the variable, or set `require`, for any other.",
    "!! GET /v1/org/posture reports `databaseTls: relaxed` while this is set.",
    bar,
  ];
}

/** ADR-0181 FX3: thrown by `createDb` when the connection string weakens TLS
 * below what REGULAIT_DATABASE_SSL declares. */
export class DatabaseTlsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTlsRefusedError";
  }
}

export function createDb(connectionString: string, override: Partial<DbPoolConfig> = {}) {
  const cfg = { ...resolveDbPoolConfig(process.env, connectionString), ...override };
  // ADR-0181 FX3: a connection string that weakens TLS below the declared
  // posture is refused before a pool exists. Every process that talks to the
  // database (the gateway, the seed, every script) comes through here.
  const refusal = databaseTlsRefusal(cfg);
  if (refusal) throw new DatabaseTlsRefusedError(refusal);
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
