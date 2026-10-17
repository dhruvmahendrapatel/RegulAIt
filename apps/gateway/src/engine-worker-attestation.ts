/**
 * ADR-0190 slice I5 — THE FIRST-ENABLE BASIS for an engine's worker switches.
 *
 * Before I5 a runner reported its worker's isolation from the worker container's own self-test file. Under I5 the
 * worker runs only in an executor's sandbox, which runs only for an ENABLED engine: a runner can no longer report
 * those switches before the first enable (a deadlock). The gateway instead accepts, for the manifest's
 * `workerAttestedSwitches` only, a fresh, passing attestation by an ACTIVE executor of the `engine-worker` profile's
 * latest live version (versioned since the I5 follow-up; version 1 is the shipped body) at or above the engine_worker
 * floor (the org's `isolationFloorEngineWorker`, raised to that version's own `minClass`). An L1 (runc) attestation
 * meets it only when both are L1: with the shipped L2 version it never does. The attestation is the executor's signed self-test of that very profile, so it proves what the
 * worker's self-test proved (no egress, no runner credential in reach) for every sandbox placed under it.
 *
 * Fail closed: a missing profile, a floor that does not resolve, or no fresh pass (stale, failed, quarantined,
 * below the floor) gives `attested: false`. The basis is returned whole so each caller records it in its verdict and
 * audit row.
 */
import { and, eq, executionProfiles, executors, isNull, type Db } from "@regulait/db";
import { defaultProfileFor, isolationClassRank, REQUIRABLE_ISOLATION_CLASSES, type RequirableIsolationClass } from "@regulait/shared";
import { databaseNow } from "./delegation.js";
import { freshAttestation } from "./executor-attestation.js";
import { loadOrgSettings } from "./org-settings.js";

export interface EngineWorkerAttestationBasis {
  attested: boolean;
  reason: "attested" | "profile_missing" | "floor_unresolved" | "no_fresh_attestation";
  profileDigest: string | null;
  requiredClass: RequirableIsolationClass | null;
  executorId: string | null;
  attestationId: string | null;
  attestationClass: string | null;
  expiresAt: string | null;
}

const isRequirable = (c: unknown): c is RequirableIsolationClass => typeof c === "string" && (REQUIRABLE_ISOLATION_CLASSES as readonly string[]).includes(c);

/**
 * `scope` is for tests only (the shared test database holds other suites' executors): restrict to these executors,
 * and read freshness at `now` instead of the database clock. The product passes nothing.
 */
export async function engineWorkerAttestationBasis(db: Db, scope: { onlyExecutorIds?: readonly string[]; now?: Date } = {}): Promise<EngineWorkerAttestationBasis> {
  const none = { profileDigest: null, requiredClass: null, executorId: null, attestationId: null, attestationClass: null, expiresAt: null };
  const name = defaultProfileFor("engine_worker", "known");
  const [profile] = (await db.select().from(executionProfiles).where(and(eq(executionProfiles.name, name), isNull(executionProfiles.retiredAt)))).sort((a, b) => b.version - a.version);
  if (!profile) return { attested: false, reason: "profile_missing", ...none };
  const org = await loadOrgSettings(db);
  const floor = org.isolationFloorEngineWorker as unknown;
  if (!isRequirable(floor) || !isRequirable(profile.minClass)) return { attested: false, reason: "floor_unresolved", ...none, profileDigest: profile.digest };
  const requiredClass = isolationClassRank(profile.minClass) > isolationClassRank(floor) ? profile.minClass : floor;
  const now = scope.now ?? (await databaseNow(db));
  const active = (await db.select().from(executors).where(eq(executors.status, "active"))).filter((e) => !scope.onlyExecutorIds || scope.onlyExecutorIds.includes(e.id));
  for (const ex of active) {
    const fresh = await freshAttestation(db, ex.id, profile.digest, now);
    if (!fresh) continue;
    // OWNER DECISION 6 (as the broker): a customer plane satisfies a class only through the admin's mapping
    const effective = fresh.class === "customer_declared" ? ex.declaredClass : fresh.class;
    if (!effective || isolationClassRank(effective) < isolationClassRank(requiredClass)) continue;
    return {
      attested: true,
      reason: "attested",
      profileDigest: profile.digest,
      requiredClass,
      executorId: ex.id,
      attestationId: fresh.id,
      attestationClass: fresh.class,
      expiresAt: fresh.expiresAt.toISOString(),
    };
  }
  return { attested: false, reason: "no_fresh_attestation", ...none, profileDigest: profile.digest, requiredClass };
}
