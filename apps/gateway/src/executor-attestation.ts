/**
 * ADR-0190 decision 6 with amendments N and T — THE ONE PREDICATE for "this
 * executor holds a fresh attestation for this profile". Moved out of
 * `executor-channel.ts` (I3, which re-exports it) so the live delegation chain
 * (`delegation.ts`, decision 8 third bullet, slice I2) applies the very same
 * predicate the broker does, without an import cycle.
 */
import { attestationCounts, eq, executorAttestations, latestCountingAttestation, type Db } from "@regulait/db";
import type { AppliedIsolationKind } from "@regulait/shared";

type Reader = Pick<Db, "select">;

export interface FreshAttestationRow {
  id: string;
  observedAt: Date;
  class: AppliedIsolationKind;
  expiresAt: Date;
  reportSha256: string;
  /** I4: the stored report of this attestation row (the broker hashes its runtime flags onto the placement) */
  report: Record<string, unknown>;
}

/**
 * Amendment T: THE ONE PREDICATE for "this attestation row still counts". A row
 * counts only if it was observed after the executor's last re-enable (both
 * stamped by the database): a quarantine voids every earlier verdict, even one
 * whose `expires_at` has not passed, so a re-enabled executor takes no work
 * before a new `pass`. Every reader of attestations for placement uses this.
 */
// ADR-0190 I8: defined once in `packages/db` (`executor-attestation.ts`), so the decision fact capture applies it too
export { attestationCounts };

/** the executor's latest counting attestation for a profile, if it is a fresh `pass` on the database clock */
export async function freshAttestation(db: Reader, executorId: string, profileDigest: string, now: Date): Promise<FreshAttestationRow | null> {
  const row = await latestCountingAttestation(db, executorId, profileDigest);
  // the LATEST report decides: a fail after a pass withdraws the class until the next pass
  if (!row || row.verdict !== "pass" || row.expiresAt.getTime() <= now.getTime()) return null;
  // I4: the stored report of that same row (the broker hashes its runtime flags onto the placement)
  const [stored] = await db.select({ report: executorAttestations.report }).from(executorAttestations).where(eq(executorAttestations.id, row.id));
  return { id: row.id, class: row.class, observedAt: row.observedAt, expiresAt: row.expiresAt, reportSha256: row.reportSha256, report: (stored?.report ?? {}) as Record<string, unknown> };
}
