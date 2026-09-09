/**
 * Scheduler observability (ADR-0031 item 6).
 *
 * Both boot schedulers — the ADR-0021 audit auto-prune and the ADR-0027 backup
 * verification — swallowed every failure in a bare `catch { }`. No log, no
 * audit row, no health surface: a permanently failing backup verification or a
 * retention prune that has not run for months looked exactly like one that is
 * switched off, on a product whose entire pitch is that nothing happens
 * unobserved.
 *
 * Failures are now observable three ways, in decreasing order of how likely
 * they are to survive whatever broke:
 *
 *   1. a console log — always, first, before anything that could itself fail;
 *   2. an in-memory health record per scheduler, exposed at
 *      GET /v1/health/schedulers (admin-only) — survives a dead database,
 *      which is the most likely reason a tick failed in the first place;
 *   3. an audit row — the natural home given every other governed act is
 *      audited, written best-effort. It is deliberately LAST: if the database
 *      is the thing that broke, this write fails too, and it must not be able
 *      to mask the log and the health record.
 *
 * A tick still never crashes the gateway, and the next tick still retries —
 * the change is that a human can now find out.
 */
import { asc, auditLog, eq, users, type Db } from "@regulait/db";

export type SchedulerName = "audit-prune" | "backup-verify";

export interface SchedulerHealth {
  name: SchedulerName;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  runs: number;
  failures: number;
  /** failures since the last success — the number an alert should watch */
  consecutiveFailures: number;
  /** false as soon as a tick fails, true again on the next success */
  healthy: boolean;
}

const registry = new Map<SchedulerName, SchedulerHealth>();

function slot(name: SchedulerName): SchedulerHealth {
  let row = registry.get(name);
  if (!row) {
    row = {
      name,
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      healthy: true,
    };
    registry.set(name, row);
  }
  return row;
}

export function recordSchedulerSuccess(name: SchedulerName, now: Date = new Date()): void {
  const row = slot(name);
  row.runs++;
  row.lastRunAt = now.toISOString();
  row.lastSuccessAt = now.toISOString();
  row.consecutiveFailures = 0;
  row.healthy = true;
}

/** the audit shape each scheduler's failure row takes */
const FAILURE_AUDIT: Record<
  SchedulerName,
  { objectType: "project" | "infra_operation"; ruleId: string; phase: string }
> = {
  // the successful prune already audits as objectType 'project'; its failure
  // belongs beside it so one filter finds both
  "audit-prune": {
    objectType: "project",
    ruleId: "audit-prune-failed",
    phase: "audit-retention-prune",
  },
  "backup-verify": {
    objectType: "infra_operation",
    ruleId: "backup-verify-failed",
    phase: "backup-verify",
  },
};

/**
 * Record a failed scheduler tick. Never throws — a failure in the failure
 * path must not take the gateway (or the next tick) down with it.
 */
export async function recordSchedulerFailure(
  db: Db,
  name: SchedulerName,
  err: unknown,
  now: Date = new Date(),
): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  const row = slot(name);
  row.runs++;
  row.failures++;
  row.consecutiveFailures++;
  row.lastRunAt = now.toISOString();
  row.lastFailureAt = now.toISOString();
  row.lastError = message.slice(0, 500);
  row.healthy = false;

  // 1. the log always happens, and happens first
  console.error(
    `[regulait] scheduled ${name} pass FAILED (${row.consecutiveFailures} consecutive): ${message}`,
  );

  // 2. the audit row, best-effort — if the database is what broke, this throws
  try {
    const spec = FAILURE_AUDIT[name];
    await db.insert(auditLog).values({
      userId: await failureActor(db),
      objectType: spec.objectType,
      objectId: null,
      detail: {
        phase: spec.phase,
        outcome: "failed",
        error: row.lastError,
        consecutiveFailures: row.consecutiveFailures,
        auto: true,
      },
      // 'deny' rather than 'allow': the scheduled act did NOT happen. It puts
      // the row in the same filtered view an admin already uses to find things
      // that did not go through.
      effect: "deny",
      ruleId: spec.ruleId,
      ruleChain: [],
      reason: `scheduled ${name} pass failed (${row.consecutiveFailures} consecutive): ${row.lastError}`,
    });
  } catch (auditErr) {
    console.error(
      `[regulait] could not audit the ${name} failure (health surface still records it): ${
        auditErr instanceof Error ? auditErr.message : String(auditErr)
      }`,
    );
  }
}

/** the same attribution the prune's success row uses: an admin if one exists,
 * otherwise the all-zero id that marks a system act with no human behind it */
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

async function failureActor(db: Db): Promise<string> {
  try {
    // ADR-0107 (F01): `is_admin` is not unique, so the human this failure was
    // recorded against was arbitrary. Oldest admin wins — the deployment's
    // bootstrap operator — so the same failure names the same person twice.
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    return admin?.id ?? SYSTEM_ACTOR;
  } catch {
    return SYSTEM_ACTOR;
  }
}

/** snapshot for GET /v1/health/schedulers */
export function schedulerHealth(): SchedulerHealth[] {
  return [...registry.values()].map((r) => ({ ...r }));
}

/** test seam */
export function resetSchedulerHealth(): void {
  registry.clear();
}
