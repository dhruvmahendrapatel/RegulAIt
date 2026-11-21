/**
 * ADR-0322: the one serialisation point for a vendor usage connector.
 *
 * A pull opens its run under this lock, and revoking a pulled import batch takes the same lock, so a revoke can never
 * interleave with a pull that would then overwrite the rewound `pulled_through` (#861 review). Kept apart from
 * vendor-usage-pull.ts so cost-import.ts can use it without an import cycle.
 */
import { and, eq, sql, vendorUsagePullRuns, type Db } from "@regulait/db";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** a run still `running` inside this lease blocks another pull and any revoke of the connector's batches */
export const PULL_LEASE_SECONDS = 30 * 60;

/** take the connector's transaction-scoped advisory lock and return the run that holds the lease, if any */
export async function lockConnectorAndFindRunningPull(tx: Tx, connectorId: string): Promise<{ id: string } | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`regulait.vendor-usage-pull:${connectorId}`}, 0))`);
  const [busy] = await tx
    .select({ id: vendorUsagePullRuns.id })
    .from(vendorUsagePullRuns)
    .where(
      and(
        eq(vendorUsagePullRuns.connectorId, connectorId),
        eq(vendorUsagePullRuns.status, "running"),
        sql`${vendorUsagePullRuns.startedAt} > now() - make_interval(secs => ${PULL_LEASE_SECONDS})`,
      ),
    )
    .limit(1);
  return busy ?? null;
}
