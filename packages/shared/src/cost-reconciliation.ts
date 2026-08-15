/**
 * ADR-0076 — COST RECONCILIATION, the pure half.
 *
 * ADR-0069's disclosed gap: a large CUR must be chunked by the operator, and
 * two OVERLAPPING chunks are two batches with different byte fingerprints, so
 * the duplicate-payload 409 never fires and every line the chunks share is
 * counted twice. This module decides — purely, over rows the gateway hands it —
 * which lines are cross-batch restatements of the same vendor fact.
 *
 * THE RULE, AND ITS TWO REFUSALS
 * ------------------------------
 * Two lines are THE SAME VENDOR FACT when every identifying field agrees:
 * vendor, account, billing kind, service, currency, the exact period window
 * and the exact amount. For a group of identical lines spread across batches:
 *
 *   - if every batch carries the SAME number of copies, the NEWEST batch's
 *     copies are kept and every older copy is marked superseded — the newest
 *     restatement of a fact stands, the older ones are marked (never deleted);
 *   - if the batches DISAGREE about multiplicity (batch C says this charge
 *     happened twice, batch D says once), NOTHING is marked. The conflict is
 *     reported as an `ambiguous_multiplicity` warning, because a guessed dedup
 *     is a guessed invoice.
 *
 * Lines that merely OVERLAP — same vendor/account/service/kind/currency from
 * different batches with intersecting but non-identical windows, or identical
 * windows with different amounts — are REPORTED as `overlapping_window`
 * warnings and never auto-superseded: a partial-period restatement is an
 * operator decision (revoke and re-import the correction), not a mechanical
 * one. Copies WITHIN one batch are never touched at all: one file saying a
 * charge occurred twice is the vendor's assertion, not our duplication.
 */

export const RECONCILIATION_MAX_WARNINGS = 200;

/** what the planner needs to know about one LIVE imported line */
export interface ReconciliationLineInput {
  id: string;
  batchId: string;
  /** when the batch was applied — the recency order. ISO string or epoch ms. */
  batchAppliedAt: string | number;
  vendor: string;
  accountKey: string;
  billingKind: string;
  service: string | null;
  currency: string;
  periodStart: string | number;
  periodEnd: string | number;
  amount: number;
}

export interface SupersessionPlanItem {
  lineId: string;
  batchId: string;
  /** the kept line in the newest batch this one is a restatement of */
  supersededByLineId: string;
  supersededByBatchId: string;
  reason: string;
}

export interface DuplicateGroupPlan {
  vendor: string;
  accountKey: string;
  billingKind: string;
  service: string | null;
  currency: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  keptBatchId: string;
  keptLineIds: string[];
  supersede: SupersessionPlanItem[];
}

export interface ReconciliationWarning {
  kind: "ambiguous_multiplicity" | "overlapping_window";
  vendor: string;
  accountKey: string;
  detail: string;
  lineIds: string[];
  batchIds: string[];
}

export interface ReconciliationPlan {
  scannedLines: number;
  duplicateGroups: DuplicateGroupPlan[];
  /** total lines the plan marks superseded */
  supersededLineCount: number;
  ambiguousGroups: number;
  /** total overlap warnings found (the stored list is bounded) */
  overlapWarningCount: number;
  /** bounded at RECONCILIATION_MAX_WARNINGS — ambiguity first, overlaps after */
  warnings: ReconciliationWarning[];
}

const NUL = "\u0000"; // see cost-import.ts: never a literal NUL byte in source

const toMs = (v: string | number): number => (typeof v === "number" ? v : new Date(v).getTime());
const toIso = (v: string | number): string => new Date(toMs(v)).toISOString();

/** the identity of a vendor fact — every field that makes two lines "the same
 * assertion". Amount included: same window with a different amount is a
 * CORRECTION candidate, which is an operator decision, not a duplicate. */
function factKey(l: ReconciliationLineInput): string {
  return [
    l.vendor,
    l.accountKey,
    l.billingKind,
    l.service ?? "",
    l.currency,
    String(toMs(l.periodStart)),
    String(toMs(l.periodEnd)),
    // exact equality on the stored double — a cent of drift is a difference
    String(l.amount),
  ].join(NUL);
}

/** the coarser overlap axis: same account + service + kind + currency */
function overlapKey(l: ReconciliationLineInput): string {
  return [l.vendor, l.accountKey, l.billingKind, l.service ?? "", l.currency].join(NUL);
}

export function planCostReconciliation(lines: readonly ReconciliationLineInput[]): ReconciliationPlan {
  const byFact = new Map<string, ReconciliationLineInput[]>();
  for (const l of lines) {
    const k = factKey(l);
    const arr = byFact.get(k) ?? [];
    arr.push(l);
    byFact.set(k, arr);
  }

  const duplicateGroups: DuplicateGroupPlan[] = [];
  const warnings: ReconciliationWarning[] = [];
  let ambiguousGroups = 0;
  const supersededIds = new Set<string>();

  for (const group of byFact.values()) {
    const byBatch = new Map<string, ReconciliationLineInput[]>();
    for (const l of group) {
      const arr = byBatch.get(l.batchId) ?? [];
      arr.push(l);
      byBatch.set(l.batchId, arr);
    }
    if (byBatch.size < 2) continue; // copies within one batch are the file's own assertion

    const counts = [...byBatch.values()].map((b) => b.length);
    const sample = group[0]!;
    if (new Set(counts).size > 1) {
      // multiplicity conflict — refuse to guess, report instead
      ambiguousGroups += 1;
      warnings.push({
        kind: "ambiguous_multiplicity",
        vendor: sample.vendor,
        accountKey: sample.accountKey,
        detail:
          `${byBatch.size} applied batches restate the same vendor fact ` +
          `(${sample.vendor}/${sample.accountKey}, ${toIso(sample.periodStart).slice(0, 10)}..` +
          `${toIso(sample.periodEnd).slice(0, 10)}, ${sample.amount} ${sample.currency}) at DIFFERENT ` +
          `multiplicities (${[...byBatch.entries()].map(([b, ls]) => `batch ${b}: ${ls.length}`).join("; ")}). ` +
          `Nothing was marked — a guessed dedup is a guessed invoice. Revoke the wrong batch and re-import.`,
        lineIds: group.map((l) => l.id),
        batchIds: [...byBatch.keys()],
      });
      continue;
    }

    // every batch agrees on the count: keep the NEWEST batch's copies
    const ordered = [...byBatch.entries()].sort((a, b) => {
      const ta = toMs(a[1][0]!.batchAppliedAt);
      const tb = toMs(b[1][0]!.batchAppliedAt);
      return tb - ta || (a[0] < b[0] ? 1 : -1); // newest first; batch id as a stable tiebreak
    });
    const [keptBatchId, keptLines] = ordered[0]!;
    const supersede: SupersessionPlanItem[] = [];
    for (const [batchId, batchLines] of ordered.slice(1)) {
      batchLines.forEach((l, i) => {
        const kept = keptLines[i % keptLines.length]!;
        supersede.push({
          lineId: l.id,
          batchId,
          supersededByLineId: kept.id,
          supersededByBatchId: keptBatchId,
          reason:
            `duplicate of line ${kept.id} in batch ${keptBatchId}: both batches restate the same vendor fact ` +
            `(${sample.vendor}/${sample.accountKey}, ${toIso(sample.periodStart).slice(0, 10)}..` +
            `${toIso(sample.periodEnd).slice(0, 10)}, ${sample.amount} ${sample.currency}). The newer batch's ` +
            `copy stands; this one is marked, never deleted, and is excluded from consolidated reads with the ` +
            `exclusion disclosed.`,
        });
        supersededIds.add(l.id);
      });
    }
    duplicateGroups.push({
      vendor: sample.vendor,
      accountKey: sample.accountKey,
      billingKind: sample.billingKind,
      service: sample.service,
      currency: sample.currency,
      periodStart: toIso(sample.periodStart),
      periodEnd: toIso(sample.periodEnd),
      amount: sample.amount,
      keptBatchId,
      keptLineIds: keptLines.map((l) => l.id),
      supersede,
    });
  }

  // -------------------------------------------------------------------------
  // Overlap detection, over the lines that remain LIVE after the plan above.
  // Reported, never acted on.
  // -------------------------------------------------------------------------
  let overlapWarningCount = 0;
  const byAxis = new Map<string, ReconciliationLineInput[]>();
  for (const l of lines) {
    if (supersededIds.has(l.id)) continue;
    const k = overlapKey(l);
    const arr = byAxis.get(k) ?? [];
    arr.push(l);
    byAxis.set(k, arr);
  }
  const overlapWarnings: ReconciliationWarning[] = [];
  for (const group of byAxis.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.batchId === b.batchId) continue; // one file's internal structure is the vendor's business
        if (factKey(a) === factKey(b)) continue; // an exact duplicate was handled (or is same-batch)
        const aS = toMs(a.periodStart);
        const aE = toMs(a.periodEnd);
        const bS = toMs(b.periodStart);
        const bE = toMs(b.periodEnd);
        if (aS < bE && bS < aE) {
          overlapWarningCount += 1;
          if (overlapWarnings.length < RECONCILIATION_MAX_WARNINGS) {
            overlapWarnings.push({
              kind: "overlapping_window",
              vendor: a.vendor,
              accountKey: a.accountKey,
              detail:
                `lines from batches ${a.batchId} and ${b.batchId} overlap for ${a.vendor}/${a.accountKey}` +
                `${a.service ? ` (${a.service})` : ""}: ${toIso(a.periodStart).slice(0, 10)}..` +
                `${toIso(a.periodEnd).slice(0, 10)} at ${a.amount} ${a.currency} vs ` +
                `${toIso(b.periodStart).slice(0, 10)}..${toIso(b.periodEnd).slice(0, 10)} at ` +
                `${b.amount} ${b.currency}. NOT superseded: the windows or amounts differ, so this may be a ` +
                `partial-period restatement or a correction — revoke the wrong batch if one is wrong.`,
              lineIds: [a.id, b.id],
              batchIds: [a.batchId, b.batchId],
            });
          }
        }
      }
    }
  }

  const boundedWarnings = [...warnings, ...overlapWarnings].slice(0, RECONCILIATION_MAX_WARNINGS);

  return {
    scannedLines: lines.length,
    duplicateGroups,
    supersededLineCount: supersededIds.size,
    ambiguousGroups,
    overlapWarningCount,
    warnings: boundedWarnings,
  };
}
