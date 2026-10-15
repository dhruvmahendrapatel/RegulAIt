/**
 * ADR-0190 decision 6 with amendments N, T and 3 — THE ONE QUERY behind "this executor holds a fresh attestation
 * for this profile". It lives here, in `packages/db`, so the decision fact capture (`decision-facts.ts`, slice I8)
 * applies the very predicate the broker does; the gateway's `executor-attestation.ts` builds `freshAttestation` on
 * it, and the AI BOM loader and the live delegation chain go through that.
 *
 * Two rules, both here once:
 *  - Amendment T (`attestationCounts`): a row counts only if it was observed after the executor's last re-enable
 *    (both stamped by the database). A quarantine voids every earlier verdict, even one not yet expired.
 *  - Amendment 3 (`latestCountingAttestation`): the LATEST counting row for (executor, profile) decides. A fail
 *    after a pass withdraws the class (`attestation_stale`) until the next pass. The caller then requires `pass`
 *    and an `expires_at` after its own instant (the database clock).
 */
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { executorAttestations, executors } from "./schema.js";

type Reader = Pick<NodePgDatabase<Record<string, never>>, "select">;

/** Amendment T: the rows of this executor that still count (observed after its last re-enable) */
export function attestationCounts(executorId: string) {
  return and(
    eq(executorAttestations.executorId, executorId),
    sql`${executorAttestations.observedAt} > coalesce((SELECT ${executors.reenabledAt} FROM ${executors} WHERE ${executors.id} = ${executorId}), '-infinity'::timestamptz)`,
  );
}

export interface LatestCountingAttestation {
  id: string;
  class: (typeof executorAttestations.$inferSelect)["class"];
  verdict: "pass" | "fail";
  observedAt: Date;
  expiresAt: Date;
  reportSha256: string;
}

/**
 * Amendment 3: the executor's LATEST counting attestation for a profile, whatever its verdict, or null. With
 * `asOf`, only rows observed at or before that instant are considered (the state at a placement).
 */
export async function latestCountingAttestation(db: Reader, executorId: string, profileDigest: string, asOf?: Date): Promise<LatestCountingAttestation | null> {
  const [row] = await db
    .select({
      id: executorAttestations.id,
      class: executorAttestations.class,
      verdict: executorAttestations.verdict,
      observedAt: executorAttestations.observedAt,
      expiresAt: executorAttestations.expiresAt,
      reportSha256: executorAttestations.reportSha256,
    })
    .from(executorAttestations)
    .where(
      and(
        attestationCounts(executorId),
        eq(executorAttestations.profileDigest, profileDigest),
        asOf ? lte(executorAttestations.observedAt, asOf) : undefined,
      ),
    )
    .orderBy(desc(executorAttestations.observedAt), desc(executorAttestations.createdAt))
    .limit(1);
  return row ? (row as LatestCountingAttestation) : null;
}
