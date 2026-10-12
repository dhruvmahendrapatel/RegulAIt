/**
 * ADR-0190 decision 6 with amendments N and T — THE ONE PREDICATE for "this
 * executor holds a fresh attestation for this profile". Moved out of
 * `executor-channel.ts` (I3, which re-exports it) so the live delegation chain
 * (`delegation.ts`, decision 8 third bullet, slice I2) applies the very same
 * predicate the broker does, without an import cycle.
 */
import { and, desc, eq, executorAttestations, executors, sql, type Db } from "@regulait/db";
import type { AppliedIsolationKind } from "@regulait/shared";

type Reader = Pick<Db, "select">;

export interface FreshAttestationRow {
  class: AppliedIsolationKind;
  expiresAt: Date;
  reportSha256: string;
}

/**
 * Amendment T: THE ONE PREDICATE for "this attestation row still counts". A row
 * counts only if it was observed after the executor's last re-enable (both
 * stamped by the database): a quarantine voids every earlier verdict, even one
 * whose `expires_at` has not passed, so a re-enabled executor takes no work
 * before a new `pass`. Every reader of attestations for placement uses this.
 */
export function attestationCounts(executorId: string) {
  return and(
    eq(executorAttestations.executorId, executorId),
    sql`${executorAttestations.observedAt} > coalesce((SELECT ${executors.reenabledAt} FROM ${executors} WHERE ${executors.id} = ${executorId}), '-infinity'::timestamptz)`,
  );
}

/** the executor's latest counting attestation for a profile, if it is a fresh `pass` on the database clock */
export async function freshAttestation(db: Reader, executorId: string, profileDigest: string, now: Date): Promise<FreshAttestationRow | null> {
  const [row] = await db
    .select({ class: executorAttestations.class, expiresAt: executorAttestations.expiresAt, verdict: executorAttestations.verdict, reportSha256: executorAttestations.reportSha256 })
    .from(executorAttestations)
    .where(and(attestationCounts(executorId), eq(executorAttestations.profileDigest, profileDigest)))
    .orderBy(desc(executorAttestations.observedAt), desc(executorAttestations.createdAt))
    .limit(1);
  // the LATEST report decides: a fail after a pass withdraws the class until the next pass
  if (!row || row.verdict !== "pass" || row.expiresAt.getTime() <= now.getTime()) return null;
  return { class: row.class, expiresAt: row.expiresAt, reportSha256: row.reportSha256 };
}
