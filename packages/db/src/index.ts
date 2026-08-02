import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { withAuditChain } from "./audit-chain.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./migrate.js";
export { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
// Types consumers need to build reusable predicates without taking a direct
// dependency on drizzle-orm (PILLAR 1 rule-scoping SQL pre-filter, etc.).
export type { SQL } from "drizzle-orm";
export type { PgColumn } from "drizzle-orm/pg-core";

export { AUDIT_CHAIN_LOCK_KEY, appendChainedAuditRows, withAuditChain } from "./audit-chain.js";

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
 */
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return withAuditChain(drizzle(pool, { schema }));
}
