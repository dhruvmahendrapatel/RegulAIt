/**
 * ADR-0189 slice B2 — the shared, transaction-aware DECISION FACT WRITER.
 *
 * Called by `appendChainedAuditRows` (audit-chain.ts) for every batch of audit
 * rows it appends, inside the same transaction and under the same chain lock.
 * So every `receiptClass: "decision"` writer, whatever module it lives in, gets
 * its capture-status marker and its facts in the decision's own transaction
 * without knowing this file exists (round-10 entry condition 4237346656), and a
 * rollback of the decision rolls back its facts with it. Migration 0189's
 * commit-time guard refuses a receipt-eligible audit row that arrives without
 * its marker, so a writer that goes around `createDb` fails loudly.
 *
 *  - `decision_facts_capture = on` (the strict default): a `captured` marker and
 *    the `regulait.decision-facts.v2` row (ADR-0190 I8: with its execution facts), sharing one `facts_hash` and one
 *    `expires_at` (the decision's audit time plus the composed audit retention,
 *    null when unbounded; 4237322627).
 *  - `off` (an audited relaxation): a `capture_off` marker and no facts
 *    (4237322635), so the receipt never infers the status later.
 *
 * Decisions written before this slice have no marker; their Decision BOM says
 * `pre_facts`. Nothing is back-filled (ADR-0180, no grandfathering).
 *
 * COST (Consequences, "B2 measures the cost"): one settings read per batch with
 * a decision in it, plus one read per kind of referenced row (project,
 * approvals and their decisions, grant, identities) only when a row names one,
 * and two inserts per decision. `zz-adr0189-b2-facts.test.ts` measures it.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  bomExpiresAt,
  buildDecisionFacts,
  composeAuditRetentionDays,
  decisionFactRefs,
  decisionFactsHash,
  isReceiptEligibleAuditRow,
  type DecisionAuditRow,
  type DecisionFactReads,
  type DecisionPlacementRead,
} from "@regulait/shared";
import {
  approvalDecisions,
  approvals,
  decisionCaptureStatus,
  decisionFacts,
  delegationGrants,
  executionPlacements,
  executionProfiles,
  executorAttestations,
  executors,
  mcpServers,
  projects,
  workloadIdentities,
  ORG_SETTINGS_ID,
} from "./schema.js";
import { latestCountingAttestation } from "./executor-attestation.js";

type Tx = Pick<NodePgDatabase<Record<string, never>>, "select" | "insert" | "execute">;

const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? [];

/** the capture mode and the composed retention, read in the decision's transaction */
async function loadCaptureSettings(tx: Tx): Promise<{ capture: "on" | "off"; retainedDays: number | null }> {
  const [row] = rowsOf<{ capture: string | null; org_days: number | null; profile_days: number | null }>(
    await tx.execute(sql`select
        (select "decision_facts_capture" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "capture",
        (select "default_audit_retention_days" from "org_settings" where "id" = ${ORG_SETTINGS_ID}) as "org_days",
        (select max("audit_retention_days") from "compliance_profiles") as "profile_days"`),
  );
  // no settings row yet: the column default, which is the strict one (on)
  const capture = row?.capture === "off" ? "off" : "on";
  const days = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return { capture, retainedDays: composeAuditRetentionDays([days(row?.profile_days)], days(row?.org_days)) };
}

async function loadReads(tx: Tx, rows: DecisionAuditRow[]): Promise<DecisionFactReads> {
  const refs = rows.map(decisionFactRefs);
  const projectIds = [...new Set(refs.map((r) => r.projectId).filter((x): x is string => x !== null))];
  const approvalIds = [...new Set(refs.flatMap((r) => r.approvalIds))];
  const grantIds = [...new Set(refs.map((r) => r.grantId).filter((x): x is string => x !== null))];
  const identityIds = [...new Set(refs.flatMap((r) => r.identityIds))];
  // one after another: a transaction is one connection, and pg refuses overlapping queries on it (pg@9)
  const projectRows = projectIds.length ? await tx.select({ id: projects.id, classifications: projects.classifications }).from(projects).where(inArray(projects.id, projectIds)) : [];
  const approvalRows = approvalIds.length ? await tx.select().from(approvals).where(inArray(approvals.id, approvalIds)) : [];
  const decisionRows = approvalIds.length ? await tx.select().from(approvalDecisions).where(inArray(approvalDecisions.approvalId, approvalIds)) : [];
  const grantRows = grantIds.length ? await tx.select().from(delegationGrants).where(inArray(delegationGrants.id, grantIds)) : [];
  const identityRows = identityIds.length ? await tx.select().from(workloadIdentities).where(inArray(workloadIdentities.id, identityIds)) : [];
  const serverIds = [...new Set(refs.map((r) => r.mcpServerId).filter((x): x is string => x !== null))];
  const serverRows = serverIds.length ? await tx.select({ id: mcpServers.id, transport: mcpServers.transport }).from(mcpServers).where(inArray(mcpServers.id, serverIds)) : [];
  const placements = await loadPlacements(tx, rows.map((r) => r.id));
  const decisionsByApproval = new Map<string, Record<string, unknown>[]>();
  for (const d of decisionRows as Array<Record<string, unknown> & { approvalId: string }>) {
    const list = decisionsByApproval.get(d.approvalId) ?? [];
    list.push(d);
    decisionsByApproval.set(d.approvalId, list);
  }
  return {
    projectTags: new Map((projectRows as Array<{ id: string; classifications: string[] | null }>).map((p) => [p.id, p.classifications])),
    approvals: new Map((approvalRows as Array<Record<string, unknown> & { id: string }>).map((a) => [a.id, a])),
    approvalDecisions: decisionsByApproval,
    grants: new Map((grantRows as Array<Record<string, unknown> & { id: string }>).map((g) => [g.id, g])),
    identities: new Map((identityRows as Array<Record<string, unknown> & { id: string }>).map((i) => [i.id, i])),
    placements,
    mcpServerTransports: new Map(serverRows.map((s) => [s.id, s.transport])),
  };
}

/**
 * ADR-0190 I8: the placement rows of these decisions, read in the decision's transaction (the I4/I8 contract: the
 * row is written in that transaction before the facts). With each: its profile (by digest), its executor and the
 * executor's identity URI, and the executor self-test the placement relied on, by the broker's own predicate
 * (`latestCountingAttestation`, amendments T and 3) as of the placement: the LATEST counting row for that executor
 * and profile decides, and it is named only if it is a pass, unexpired at the placement, for the applied class. A
 * fail after a pass, or a pass voided by a later re-enable, names none (decision 6). Times compared are both
 * database-clock stamps (M-075).
 */
async function loadPlacements(tx: Tx, auditIds: string[]): Promise<Map<string, DecisionPlacementRead>> {
  const out = new Map<string, DecisionPlacementRead>();
  if (!auditIds.length) return out;
  const placementRows = await tx.select().from(executionPlacements).where(inArray(executionPlacements.auditId, auditIds));
  if (!placementRows.length) return out;
  // a `policy_unresolved` refusal (ADR-0190 I4 review M2) names no profile
  const digests = [...new Set(placementRows.map((p) => p.profileDigest).filter((d): d is string => d !== null))];
  const executorIds = [...new Set(placementRows.map((p) => p.executorId).filter((x): x is string => x !== null))];
  const profileRows = digests.length
    ? await tx
        .select({ id: executionProfiles.id, name: executionProfiles.name, version: executionProfiles.version, digest: executionProfiles.digest })
        .from(executionProfiles)
        .where(inArray(executionProfiles.digest, digests))
    : [];
  // ADR-0190 I4: the attestation the broker STAMPED on a placement (`attestation_id`) is the authority; it is read,
  // never re-derived. Only a row without one (an I3 unlinked placement) falls back to the as-of derivation below.
  const stampedIds = [...new Set(placementRows.map((p) => p.attestationId).filter((x): x is string => x !== null))];
  const stampedRows = stampedIds.length
    ? await tx.select({ id: executorAttestations.id, reportSha256: executorAttestations.reportSha256 }).from(executorAttestations).where(inArray(executorAttestations.id, stampedIds))
    : [];
  const stampedOf = new Map(stampedRows.map((a) => [a.id, a]));
  const executorRows = executorIds.length
    ? await tx
        .select({ id: executors.id, backend: executors.backend, runtimeVersion: executors.runtimeVersion, workloadIdentityId: executors.workloadIdentityId })
        .from(executors)
        .where(inArray(executors.id, executorIds))
    : [];
  const identityIds = [...new Set(executorRows.map((e) => e.workloadIdentityId))];
  const identityRows = identityIds.length
    ? await tx.select({ id: workloadIdentities.id, identifier: workloadIdentities.identifier }).from(workloadIdentities).where(inArray(workloadIdentities.id, identityIds))
    : [];
  const profileOf = new Map(profileRows.map((p) => [p.digest, p]));
  const executorOf = new Map(executorRows.map((e) => [e.id, e]));
  const identityOf = new Map(identityRows.map((i) => [i.id, i.identifier]));
  for (const p of placementRows) {
    const executor = p.executorId ? executorOf.get(p.executorId) ?? null : null;
    // the broker's own predicate, as of the placement (amendments T and 3): the LATEST counting self-test for this
    // executor and profile decides; it is named only if it is a pass, unexpired at the placement, for the class the
    // placement applied. A later fail, a void pass from before a quarantine, or another class names nothing.
    let attestation: Record<string, unknown> | null = null;
    const stamped = p.attestationId ? stampedOf.get(p.attestationId) : undefined;
    if (stamped) {
      attestation = { id: stamped.id, reportSha256: stamped.reportSha256 };
    } else if (executor && p.profileDigest) {
      const a = await latestCountingAttestation(tx, executor.id, p.profileDigest, p.createdAt);
      const counts = a !== null && a.verdict === "pass" && a.expiresAt.getTime() > p.createdAt.getTime() && a.class === p.appliedClass;
      attestation = counts ? { id: a.id, reportSha256: a.reportSha256 } : null;
    }
    out.set(p.auditId, {
      placement: p as unknown as Record<string, unknown>,
      profile: p.profileDigest ? profileOf.get(p.profileDigest) ?? null : null,
      executor,
      executorIdentity: executor ? identityOf.get(executor.workloadIdentityId) ?? null : null,
      executorAttestation: attestation,
    });
  }
  return out;
}

/** a column the writer was not given is stored as NULL; read it the same way */
const orNull = <T>(v: unknown): T | null => (v === undefined || v === null ? null : (v as T));
function asDecisionRow(r: Record<string, unknown>): DecisionAuditRow {
  return {
    id: r.id as string,
    seq: r.seq as number,
    at: r.at as Date,
    userId: r.userId as string,
    objectType: r.objectType as string,
    objectId: orNull<string>(r.objectId),
    serverId: orNull<string>(r.serverId),
    toolName: orNull<string>(r.toolName),
    effect: r.effect as string,
    detail: orNull<unknown>(r.detail),
    actorIdentityId: orNull<string>(r.actorIdentityId),
    delegationGrantId: orNull<string>(r.delegationGrantId),
    actorChain: orNull<string[]>(r.actorChain),
    chainVersion: orNull<number>(r.chainVersion),
  };
}

/**
 * Write the capture-status marker (and, when capture is on, the facts) of every
 * receipt-eligible row in `appended`, inside `tx`. `appended` are the rows
 * exactly as they were inserted (scrubbed, chained), so the facts describe the
 * stored decision. Returns how many decisions were captured.
 */
export async function captureDecisionFacts(tx: Tx, appended: ReadonlyArray<Record<string, unknown>>): Promise<number> {
  const decisions = appended.filter((r) => isReceiptEligibleAuditRow({ objectType: r.objectType as string, detail: r.detail })).map(asDecisionRow);
  if (decisions.length === 0) return 0;
  const { capture, retainedDays } = await loadCaptureSettings(tx);
  if (capture === "off") {
    await tx.insert(decisionCaptureStatus).values(
      decisions.map((r) => ({ auditId: r.id, auditSeq: r.seq, auditAt: r.at, status: "capture_off" as const, factsHash: null, expiresAt: bomExpiresAt(r.at, retainedDays) })),
    );
    return decisions.length;
  }
  const reads = await loadReads(tx, decisions);
  const built = decisions.map((r) => {
    const facts = buildDecisionFacts(r, reads);
    return { r, facts, hash: decisionFactsHash(facts), expiresAt: bomExpiresAt(r.at, retainedDays) };
  });
  await tx.insert(decisionCaptureStatus).values(
    built.map((b) => ({ auditId: b.r.id, auditSeq: b.r.seq, auditAt: b.r.at, status: "captured" as const, factsHash: b.hash, expiresAt: b.expiresAt })),
  );
  await tx.insert(decisionFacts).values(
    built.map((b) => ({ auditId: b.r.id, auditSeq: b.r.seq, factsVersion: b.facts.v, facts: b.facts, factsHash: b.hash, aiBomSnapshotId: null, expiresAt: b.expiresAt })),
  );
  return decisions.length;
}

/** the capture status of one decision (null = none: made before B2, `pre_facts`) */
export async function loadDecisionCaptureStatus(db: Pick<Tx, "select">, auditId: string) {
  const [row] = await db.select().from(decisionCaptureStatus).where(eq(decisionCaptureStatus.auditId, auditId));
  return row ?? null;
}
