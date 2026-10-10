/**
 * ADR-0188 decision 19 (slice S4) — the audit v2 cutover, as the gateway runs it.
 *
 * ROLLOUT (the drained deploy): (1) every replica is upgraded to a build that reads the boundary (any build
 * since S1); replicas of an older build are drained, not left serving. (2) ONE boot runs with
 * `REGULAIT_AUDIT_V2_CUTOVER=run`, which records `audit_chain_versions (2, tip + 1)` under the append lock
 * (`runAuditV2Cutover`, `@regulait/db`). From that row on, every append is v2 and stamps the actor
 * columns. (3) The env var is removed; a later boot with it set finds the boundary and does nothing.
 *
 * BOOT REFUSAL: `assertAuditChainWritable` refuses to start a binary that cannot write the recorded
 * boundary's version. A binary from before S1 cannot run this check, so the database refuses for it:
 * `audit_log_v2_floor` (migration 0184) rejects any row at or past the boundary that is not v2.
 */
import { loadAuditChainBoundary, type Db } from "@regulait/db";

export const AUDIT_V2_CUTOVER_ENV = "REGULAIT_AUDIT_V2_CUTOVER";

export class AuditChainVersionBootError extends Error {
  constructor(detail: string) {
    super(`audit chain: this build cannot write the recorded serialisation boundary (${detail}); refusing to boot (ADR-0188 decision 19)`);
    this.name = "AuditChainVersionBootError";
  }
}

/** refuse when the recorded boundary is a version this build cannot write; returns the v2 boundary (null = none yet) */
export async function assertAuditChainWritable(db: Db): Promise<number | null> {
  const boundary = await loadAuditChainBoundary(db);
  if (!boundary.supported) throw new AuditChainVersionBootError(boundary.detail);
  return boundary.v2FromSeq;
}
