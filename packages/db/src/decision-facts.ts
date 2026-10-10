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
 *    the `regulait.decision-facts.v1` row, sharing one `facts_hash` and one
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
} from "@regulait/shared";
import {
  approvalDecisions,
  approvals,
  decisionCaptureStatus,
  decisionFacts,
  delegationGrants,
  projects,
  workloadIdentities,
  ORG_SETTINGS_ID,
} from "./schema.js";

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
  const [projectRows, approvalRows, decisionRows, grantRows, identityRows] = await Promise.all([
    projectIds.length ? tx.select({ id: projects.id, classifications: projects.classifications }).from(projects).where(inArray(projects.id, projectIds)) : [],
    approvalIds.length ? tx.select().from(approvals).where(inArray(approvals.id, approvalIds)) : [],
    approvalIds.length ? tx.select().from(approvalDecisions).where(inArray(approvalDecisions.approvalId, approvalIds)) : [],
    grantIds.length ? tx.select().from(delegationGrants).where(inArray(delegationGrants.id, grantIds)) : [],
    identityIds.length ? tx.select().from(workloadIdentities).where(inArray(workloadIdentities.id, identityIds)) : [],
  ]);
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
  };
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
    built.map((b) => ({ auditId: b.r.id, auditSeq: b.r.seq, facts: b.facts, factsHash: b.hash, aiBomSnapshotId: null, expiresAt: b.expiresAt })),
  );
  return decisions.length;
}

/** the capture status of one decision (null = none: made before B2, `pre_facts`) */
export async function loadDecisionCaptureStatus(db: Pick<Tx, "select">, auditId: string) {
  const [row] = await db.select().from(decisionCaptureStatus).where(eq(decisionCaptureStatus.auditId, auditId));
  return row ?? null;
}
