import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import { withAuditChain } from "./audit-chain.js";
import { withProseScrub } from "./prose-scrub.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./migrate.js";
export { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
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
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return withProseScrub(withAuditChain(drizzle(pool, { schema })));
}
