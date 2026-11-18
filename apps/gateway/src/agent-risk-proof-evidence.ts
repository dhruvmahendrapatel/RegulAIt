/**
 * ADR-0345 slice 2b (part 1): reading agent-risk proof results as EVIDENCE.
 *
 * A result row is evidence only when everything that ties it down still agrees (ADR-0345 decision 5):
 *   - its `content_hash` recomputes from the canonical bytes (`agentRiskProofEvidence`);
 *   - its audit row is still in the ADR-0060 chain (seq, content hash and row hash recompute) and that row's
 *     `detail.contentHash` is the same hash;
 *   - when it carries a signature, the signature verifies against the ADR-0116 export key it names.
 *
 * The label is one of:
 *   - `verified`:     all of the above hold, and the result is signed;
 *   - `unsigned`:     hash and chain hold, but no export key was configured when it ran (never shown as signed);
 *   - `unverifiable`: something does not hold. A pruned or altered audit row, a hash that no longer recomputes, a
 *                     signature that fails, or a key this deployment no longer holds. The reason says which.
 *
 * Only `verified` and `unsigned` results count anywhere as evidence (the pack collector, the posture input and, in
 * slice 3, the read API). Nothing here writes.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  agentRiskProofResults,
  auditLog,
  inArray,
  loadAuditChainBoundary,
  sql,
  type AgentRiskProofResultRow,
  type Db,
} from "@regulait/db";
import {
  agentRiskProofByKey,
  agentRiskProofEvidence,
  agentRiskProofs,
  auditChainVersionAt,
  auditContentHashFor,
  auditRowHash,
  auditRowVersionProblem,
  sha256Hex,
  type MeasurementState,
} from "@regulait/shared";
import { resolveExportSigningKey, type ExportSigningKey, type ExportSigningRefusal } from "./export-bundle.js";

export const AGENT_RISK_PROOF_EVIDENCE_LABELS = ["verified", "unsigned", "unverifiable"] as const;
export type AgentRiskProofEvidenceLabel = (typeof AGENT_RISK_PROOF_EVIDENCE_LABELS)[number];

export type AgentRiskProofUnverifiableReason =
  | "unknown_proof"
  | "hash_mismatch"
  | "audit_row_missing"
  | "audit_row_broken"
  | "audit_hash_mismatch"
  | "chain_boundary_unsupported"
  | "signing_key_unknown"
  | "bad_signature";

export interface AgentRiskProofEvidenceCheck {
  label: AgentRiskProofEvidenceLabel;
  reason: AgentRiskProofUnverifiableReason | null;
}

export interface AgentRiskProofEvidenceDeps {
  signingKey: () => ExportSigningKey | ExportSigningRefusal;
}

const DEFAULT_DEPS: AgentRiskProofEvidenceDeps = { signingKey: resolveExportSigningKey };

const unverifiable = (reason: AgentRiskProofUnverifiableReason): AgentRiskProofEvidenceCheck => ({ label: "unverifiable", reason });

/** label each result; one audit read and one boundary read for the whole batch */
export async function checkAgentRiskProofEvidence(
  db: Db,
  rows: readonly AgentRiskProofResultRow[],
  deps: AgentRiskProofEvidenceDeps = DEFAULT_DEPS,
): Promise<Map<string, AgentRiskProofEvidenceCheck>> {
  const out = new Map<string, AgentRiskProofEvidenceCheck>();
  if (rows.length === 0) return out;
  const audits = new Map(
    (await db.select().from(auditLog).where(inArray(auditLog.id, rows.map((r) => r.auditLogId)))).map((a) => [a.id, a]),
  );
  const boundary = await loadAuditChainBoundary(db);
  // the public key for a signature: only the export key this deployment holds now, and only for its own key id
  const key = deps.signingKey();
  const publicKey = key.ok ? createPublicKey(key.publicKeyPem) : null;

  for (const row of rows) {
    const entry = agentRiskProofByKey(row.proofKey);
    if (!entry) {
      out.set(row.id, unverifiable("unknown_proof"));
      continue;
    }
    const recomputed = sha256Hex(
      agentRiskProofEvidence({
        proofKey: row.proofKey,
        riskKey: entry.risk.key,
        catalogVersion: row.catalogVersion,
        trigger: row.trigger,
        outcome: row.outcome,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        detail: row.detail as Record<string, unknown>,
      }),
    );
    if (recomputed !== row.contentHash) {
      out.set(row.id, unverifiable("hash_mismatch"));
      continue;
    }
    const a = audits.get(row.auditLogId);
    if (!a) {
      // pruned (or never written): the chain no longer vouches for this result
      out.set(row.id, unverifiable("audit_row_missing"));
      continue;
    }
    if (!boundary.supported) {
      out.set(row.id, unverifiable("chain_boundary_unsupported"));
      continue;
    }
    const v2FromSeq = boundary.v2FromSeq;
    if (
      a.seq === null ||
      !a.contentHash ||
      !a.rowHash ||
      !a.prevHash ||
      auditRowVersionProblem({ ...a, seq: a.seq }, v2FromSeq) !== null ||
      a.contentHash !== auditContentHashFor(a, auditChainVersionAt(a.seq, v2FromSeq)) ||
      a.rowHash !== auditRowHash(a.prevHash, a.contentHash)
    ) {
      out.set(row.id, unverifiable("audit_row_broken"));
      continue;
    }
    if ((a.detail as { contentHash?: unknown } | null)?.contentHash !== row.contentHash) {
      out.set(row.id, unverifiable("audit_hash_mismatch"));
      continue;
    }
    if (row.signature === null) {
      out.set(row.id, { label: "unsigned", reason: null });
      continue;
    }
    if (!key.ok || !publicKey || key.keyId !== row.signingKeyId) {
      out.set(row.id, unverifiable("signing_key_unknown"));
      continue;
    }
    const good = edVerify(null, Buffer.from(row.contentHash, "utf8"), publicKey, Buffer.from(row.signature, "base64"));
    out.set(row.id, good ? { label: "verified", reason: null } : unverifiable("bad_signature"));
  }
  return out;
}

export interface LatestAgentRiskProof {
  riskKey: string;
  proofKey: string;
  latest:
    | {
        resultId: string;
        outcome: MeasurementState;
        finishedAt: Date;
        evidence: AgentRiskProofEvidenceCheck;
      }
    | null;
}

/** the latest result of every catalogue proof (null when it has never run), each with its evidence label */
export async function latestAgentRiskProofs(
  db: Db,
  deps: AgentRiskProofEvidenceDeps = DEFAULT_DEPS,
): Promise<LatestAgentRiskProof[]> {
  const latest = (await db.execute(sql`
    select distinct on (${agentRiskProofResults.proofKey}) *
    from ${agentRiskProofResults}
    order by ${agentRiskProofResults.proofKey}, ${agentRiskProofResults.finishedAt} desc, ${agentRiskProofResults.id} desc`))
    .rows as Array<Record<string, unknown>>;
  // the raw select returns column names; map them to the Drizzle row shape once
  const rows: AgentRiskProofResultRow[] = latest.map((r) => ({
    id: r.id as string,
    proofKey: r.proof_key as string,
    catalogVersion: Number(r.catalog_version),
    trigger: r.trigger as AgentRiskProofResultRow["trigger"],
    outcome: r.outcome as AgentRiskProofResultRow["outcome"],
    runAsUserId: (r.run_as_user_id as string | null) ?? null,
    redteamRunId: (r.redteam_run_id as string | null) ?? null,
    auditLogId: r.audit_log_id as string,
    contentHash: r.content_hash as string,
    signature: (r.signature as string | null) ?? null,
    signingKeyId: (r.signing_key_id as string | null) ?? null,
    detail: r.detail,
    startedAt: new Date(r.started_at as string),
    finishedAt: new Date(r.finished_at as string),
  }));
  const checks = await checkAgentRiskProofEvidence(db, rows, deps);
  const byKey = new Map(rows.map((r) => [r.proofKey, r]));
  return agentRiskProofs().map(({ risk, proof }) => {
    const r = byKey.get(proof.key);
    return {
      riskKey: risk.key,
      proofKey: proof.key,
      latest: r ? { resultId: r.id, outcome: r.outcome, finishedAt: r.finishedAt, evidence: checks.get(r.id)! } : null,
    };
  });
}

/** does a result count as evidence anywhere? Only a pass whose evidence still holds (signed or honestly unsigned) */
export const countsAsEvidence = (outcome: MeasurementState, check: AgentRiskProofEvidenceCheck): boolean =>
  outcome === "pass" && check.label !== "unverifiable";
