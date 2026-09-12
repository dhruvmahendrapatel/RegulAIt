/**
 * ADR-0109 — the PRE-FLIGHT DUPLICATE REPORT for migration 0108's unique
 * constraints, extended by ADR-0110 (migration 0109) with the TENTH — the
 * `backup_runs` check that shipped ADVISORY because ADR-0109 had refused its
 * constraint, and which is now enforced like the rest.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Migration 0108 turns nine beliefs about this schema into constraints the
 * database enforces. A unique constraint is a CLAIM ABOUT DATA THAT ALREADY
 * EXISTS: on a deployment that already holds a pair of rows the claim forbids,
 * `CREATE UNIQUE INDEX` fails and the upgrade stops.
 *
 * **That is the correct behaviour and 0108 does not soften it.** The migration
 * ADDS and REFUSES; it never repairs, merges or deletes. Silently collapsing
 * two `grant_certification_items` rows — two recorded human access-review
 * decisions — so that an upgrade could report success would be far worse than
 * refusing to upgrade, and it is the same argument ADR-0104 used when it
 * refused to backfill a consent digest: an invented value is a manufactured
 * record.
 *
 * The cost of that posture is that an operator learns about the problem from a
 * failed migration, mid-upgrade, with no idea how big it is. This file is the
 * fix for that and only that: run it BEFORE the upgrade and it says, per
 * constraint, how many offending groups exist, how many rows they cover, and a
 * handful of example keys to go and look at.
 *
 * It is deliberately NOT a new subsystem. It is a plain exported function over
 * plain SQL — the same shape `proseScrubInventory()` uses to make ADR-0102's
 * coverage claim checkable — that a route, a test, or
 * `scripts/preflight-unique-constraints.mjs` can call.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * - It does not fix anything. It reports. Deciding which of two conflicting
 *   governance rows is the real one is a product question with a human in it.
 * - It does not run itself ON BOOT. A read-only scan of ten tables is cheap but
 *   not free, and an upgrade check that runs on every start is a check nobody
 *   reads. ADR-0110 does wire it into CI (`.github/workflows/ci.yml`) and into
 *   README's "Verifying a clean checkout" sequence, because ADR-0109's own
 *   honest-limits section said a check nobody runs is worth nothing.
 * - It does not replace the constraint. A green pre-flight is a statement about
 *   one instant; the constraint is what holds afterwards.
 */
import { sql, type SQL } from "drizzle-orm";

/** One thing 0108 claims, expressed so it can be checked before it is enforced. */
export type DeferredUniqueCheck = {
  /** the index the migration creates (0108 for nine of these, 0109 for
   * `backup_runs`), or `null` for an advisory-only check. No check is advisory
   * today — the field is kept because the NEXT deferred constraint will be. */
  readonly index: string | null;
  readonly table: string;
  /** the key, in the words the ADR uses */
  readonly key: string;
  /** the index's WHERE clause, or null for a total index */
  readonly predicate: string | null;
  /**
   * false = no migration creates this index; the check is reported anyway so an
   * operator can see the number that kept it out. ADR-0109 used this for
   * `backup_runs`; ADR-0110 flipped it to true once the writing code made the
   * claim true.
   */
  readonly enforced: boolean;
  /** SQL fragment naming the grouping columns */
  readonly groupBy: string;
  /** SQL fragment rendering one group's key as human-readable text */
  readonly keyExpr: string;
};

/**
 * The checks, in the order ADR-0109 argues them.
 *
 * `keyExpr`/`groupBy`/`predicate` are literal SQL written HERE, never
 * assembled from caller input — nothing in this module takes a parameter that
 * reaches a query.
 */
export const DEFERRED_UNIQUE_CHECKS: readonly DeferredUniqueCheck[] = [
  {
    index: "grant_cert_items_approval_uq",
    table: "grant_certification_items",
    key: "approval_id",
    predicate: "approval_id IS NOT NULL",
    enforced: true,
    groupBy: "approval_id",
    keyExpr: "approval_id::text",
  },
  {
    index: "model_card_approvals_approval_uq",
    table: "model_card_approvals",
    key: "approval_id",
    predicate: "approval_id IS NOT NULL",
    enforced: true,
    groupBy: "approval_id",
    keyExpr: "approval_id::text",
  },
  {
    index: "training_jobs_approval_uq",
    table: "training_jobs",
    key: "approval_id",
    predicate: "approval_id IS NOT NULL",
    enforced: true,
    groupBy: "approval_id",
    keyExpr: "approval_id::text",
  },
  {
    index: "sod_override_approval_uq",
    table: "sod_override_requests",
    key: "approval_id",
    predicate: "approval_id IS NOT NULL",
    enforced: true,
    groupBy: "approval_id",
    keyExpr: "approval_id::text",
  },
  {
    index: "ai_use_cases_instance_uq",
    table: "ai_use_cases",
    key: "workflow_instance_id",
    predicate: "workflow_instance_id IS NOT NULL",
    enforced: true,
    groupBy: "workflow_instance_id",
    keyExpr: "workflow_instance_id::text",
  },
  {
    index: "ai_vendors_instance_uq",
    table: "ai_vendors",
    key: "workflow_instance_id",
    predicate: "workflow_instance_id IS NOT NULL",
    enforced: true,
    groupBy: "workflow_instance_id",
    keyExpr: "workflow_instance_id::text",
  },
  {
    index: "cert_inventory_resource_cn_uq",
    table: "cert_inventory",
    key: "(resource_id, common_name)",
    predicate: null,
    enforced: true,
    groupBy: "resource_id, common_name",
    keyExpr: "resource_id::text || ' / ' || common_name",
  },
  {
    index: "trace_spans_run_uq",
    table: "trace_spans",
    key: "(trace_id, run_id)",
    predicate: "kind = 'run' AND run_id IS NOT NULL",
    enforced: true,
    groupBy: "trace_id, run_id",
    keyExpr: "trace_id::text || ' / ' || run_id::text",
  },
  {
    index: "users_email_lower_uq",
    table: "users",
    key: "lower(email)",
    predicate: null,
    enforced: true,
    groupBy: "lower(email)",
    keyExpr: "lower(email)",
  },
  {
    // ADR-0110 (migration 0109) — NO LONGER ADVISORY. ADR-0109 shipped this
    // check with `enforced: false` because it had REFUSED the constraint: the
    // restore-proposal lifecycle could legitimately produce a second `missed`
    // row for one finding, and the index would then have made a governed DENY
    // fail with 23505. ADR-0110 fixed the writing code — a re-scan RE-OPENS the
    // finding's existing row instead of inserting a second one — so the second
    // row is never written, the deny still works, and the claim is now
    // enforceable. Migration 0109 creates it and this check BLOCKS on it.
    //
    // The predicate lost its `status = 'missed'` clause with the same change:
    // ONE row now carries the finding through its whole lifecycle
    // ('missed' -> 'restore_proposed' -> back to 'missed', or -> 'restored'),
    // so scoping the check to one status would miss exactly the duplicates it
    // exists to find. `kind = 'backup'` stays and is load-bearing: an executed
    // restore appends a `kind='restore'` row carrying the same finding_id.
    index: "backup_runs_finding_uq",
    table: "backup_runs",
    key: "finding_id (kind='backup')",
    predicate: "kind = 'backup' AND finding_id IS NOT NULL",
    enforced: true,
    groupBy: "finding_id",
    keyExpr: "finding_id::text",
  },
];

/** What one check found. */
export type DeferredUniqueFinding = {
  readonly index: string | null;
  readonly table: string;
  readonly key: string;
  readonly predicate: string | null;
  readonly enforced: boolean;
  /** how many distinct keys hold more than one row */
  readonly duplicateGroups: number;
  /** how many rows those groups cover in total */
  readonly duplicateRows: number;
  /** up to `exampleLimit` of the worst offenders */
  readonly examples: ReadonlyArray<{ key: string; count: number }>;
};

export type DeferredUniquePreflightReport = {
  /** true when every ENFORCED check is clean — i.e. 0108 and 0109 will apply */
  readonly clean: boolean;
  /** enforced checks that are NOT clean; empty when `clean` */
  readonly blocking: readonly DeferredUniqueFinding[];
  readonly findings: readonly DeferredUniqueFinding[];
};

/** `table:key` for every check, DERIVED from the list rather than restated. */
export function deferredUniqueInventory(): string[] {
  return DEFERRED_UNIQUE_CHECKS.map((c) => `${c.table}:${c.key}`).sort();
}

/** Anything with drizzle's `execute` — a `Db`, or a transaction handle. */
type Executor = { execute: (query: SQL) => Promise<unknown> };

function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const r = (res as { rows?: unknown }).rows;
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : [];
}

/**
 * Run every check and report what would block migration 0108 or 0109.
 *
 * One round trip per check. Read-only: nothing here writes, locks or takes a
 * transaction, so it is safe against a live deployment.
 */
export async function runDeferredUniquePreflight(
  db: Executor,
  opts: { exampleLimit?: number } = {},
): Promise<DeferredUniquePreflightReport> {
  const limit = Math.max(1, Math.min(50, opts.exampleLimit ?? 5));
  const findings: DeferredUniqueFinding[] = [];

  for (const c of DEFERRED_UNIQUE_CHECKS) {
    const where = c.predicate ? `WHERE ${c.predicate}` : "";
    // Every fragment below is a literal from DEFERRED_UNIQUE_CHECKS; `limit` is
    // the only caller-influenced value and it is clamped to an integer range
    // above before it is interpolated.
    const query = sql.raw(
      `WITH d AS (
         SELECT ${c.keyExpr} AS k, count(*)::int AS n
         FROM ${c.table} ${where}
         GROUP BY ${c.groupBy}
         HAVING count(*) > 1
       )
       SELECT
         (SELECT count(*) FROM d)::int AS groups,
         (SELECT coalesce(sum(n), 0) FROM d)::int AS rows,
         (SELECT coalesce(json_agg(json_build_object('key', k, 'count', n)), '[]'::json)
            FROM (SELECT k, n FROM d ORDER BY n DESC, k LIMIT ${limit}) x) AS examples`,
    );
    const row = rowsOf(await db.execute(query))[0] ?? {};
    findings.push({
      index: c.index,
      table: c.table,
      key: c.key,
      predicate: c.predicate,
      enforced: c.enforced,
      duplicateGroups: Number(row.groups ?? 0),
      duplicateRows: Number(row.rows ?? 0),
      examples: (row.examples as Array<{ key: string; count: number }> | null) ?? [],
    });
  }

  const blocking = findings.filter((f) => f.enforced && f.duplicateGroups > 0);
  return { clean: blocking.length === 0, blocking, findings };
}

/** A plain-text rendering an operator can paste into a ticket. */
export function formatDeferredUniquePreflight(report: DeferredUniquePreflightReport): string {
  const lines: string[] = [];
  lines.push("ADR-0109/0110 pre-flight — duplicates that would block migration 0108 or 0109");
  lines.push("");
  for (const f of report.findings) {
    const tag = f.enforced ? (f.duplicateGroups > 0 ? "BLOCKS" : "ok") : "advisory";
    const pred = f.predicate ? ` WHERE ${f.predicate}` : "";
    lines.push(
      `[${tag}] ${f.table} (${f.key})${pred} — ${f.duplicateGroups} duplicate group(s), ${f.duplicateRows} row(s)`,
    );
    for (const e of f.examples) lines.push(`          ${e.key} ×${e.count}`);
  }
  lines.push("");
  lines.push(
    report.clean
      ? "CLEAN — migrations 0108 and 0109 will apply."
      : `BLOCKED — ${report.blocking.length} constraint(s) cannot be created. ` +
          "These migrations refuse rather than repair: resolve each pair by hand (decide which " +
          "row is the real one and remove or re-key the other) before upgrading. See ADR-0109 " +
          "and ADR-0110.",
  );
  return lines.join("\n");
}
