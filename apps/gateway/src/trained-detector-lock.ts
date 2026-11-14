/**
 * ADR-0220 (P7R-01 fix): the advisory lock that serialises trained-detector
 * writes against writes to the external scorers those detectors call.
 *
 * Its own module so that both `trained-detectors.ts` and `external-scorers.ts`
 * can take it without a static import between them (an import cycle).
 */
import { and, eq, guardrailTrainedDetectors, sql, type Db } from "@regulait/db";

/** the transaction-scoped advisory lock key for trained-detector bindings */
export const TRAINED_DETECTOR_LOCK_KEY = 6_000_000_220;

/** take the lock inside the caller's transaction (released at commit or rollback) */
export async function lockTrainedDetectorBindings(tx: Db): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TRAINED_DETECTOR_LOCK_KEY}::bigint)`);
}

/** the enabled trained detectors that call this scorer, in a stable order */
export async function enabledDetectorsUsingScorer(
  db: Db,
  scorerId: string,
): Promise<Array<{ kind: string; onFailure: string }>> {
  const rows = await db
    .select({ kind: guardrailTrainedDetectors.kind, onFailure: guardrailTrainedDetectors.onFailure })
    .from(guardrailTrainedDetectors)
    .where(and(eq(guardrailTrainedDetectors.scorerId, scorerId), eq(guardrailTrainedDetectors.enabled, true)));
  return rows.map((r) => ({ kind: String(r.kind), onFailure: String(r.onFailure) })).sort((a, b) => a.kind.localeCompare(b.kind));
}
