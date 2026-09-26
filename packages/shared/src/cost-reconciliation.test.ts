/**
 * ADR-0076 — the reconciliation planner, unit-tested.
 *
 * The adversarial end-to-end suite is the gateway's cost-reconcile.test.ts
 * (which proves the double count EXISTS before the pass and is gone after);
 * this file covers the planner's mechanics: what counts as the same vendor
 * fact, who wins, the two refusals, and the bounds.
 */
import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_MAX_WARNINGS,
  planCostReconciliation,
  type ReconciliationLineInput,
} from "./index.js";

const T0 = Date.UTC(2026, 6, 1); // 2026-07-01
const T1 = Date.UTC(2026, 7, 1); // 2026-08-01

let seq = 0;
function line(over: Partial<ReconciliationLineInput> = {}): ReconciliationLineInput {
  seq += 1;
  return {
    id: `line-${seq}`,
    batchId: "batch-a",
    batchAppliedAt: 1000,
    vendor: "openai",
    accountKey: "jane@acme.example",
    billingKind: "usage",
    service: null,
    currency: "USD",
    periodStart: T0,
    periodEnd: T1,
    amount: 10,
    ...over,
  };
}

describe("what counts as the same vendor fact", () => {
  it("marks the OLDER batch's copy when two batches restate an identical line, keeping the newer", () => {
    const older = line({ batchId: "batch-a", batchAppliedAt: 1000 });
    const newer = line({ batchId: "batch-b", batchAppliedAt: 2000 });
    const plan = planCostReconciliation([older, newer]);
    expect(plan.supersededLineCount).toBe(1);
    expect(plan.duplicateGroups).toHaveLength(1);
    const g = plan.duplicateGroups[0]!;
    expect(g.keptBatchId).toBe("batch-b");
    expect(g.keptLineIds).toEqual([newer.id]);
    expect(g.supersede[0]!.lineId).toBe(older.id);
    expect(g.supersede[0]!.supersededByLineId).toBe(newer.id);
    expect(g.supersede[0]!.reason).toMatch(/marked, never deleted/);
    expect(plan.ambiguousGroups).toBe(0);
    expect(plan.overlapWarningCount).toBe(0);
  });

  it("does NOT touch two identical lines within ONE batch — the file's own assertion stands", () => {
    const a = line({ batchId: "batch-a" });
    const b = line({ batchId: "batch-a" });
    const plan = planCostReconciliation([a, b]);
    expect(plan.supersededLineCount).toBe(0);
    expect(plan.duplicateGroups).toHaveLength(0);
    expect(plan.warnings).toHaveLength(0);
  });

  it("a single differing field — amount, window, service, account or currency — makes lines DIFFERENT facts", () => {
    const base = line({ batchId: "batch-a", batchAppliedAt: 1000 });
    for (const variant of [
      line({ batchId: "batch-b", batchAppliedAt: 2000, amount: 10.01 }),
      line({ batchId: "batch-b", batchAppliedAt: 2000, periodEnd: T1 + 1000 }),
      line({ batchId: "batch-b", batchAppliedAt: 2000, accountKey: "bob@acme.example" }),
      line({ batchId: "batch-b", batchAppliedAt: 2000, currency: "EUR" }),
    ]) {
      const plan = planCostReconciliation([base, variant]);
      expect(plan.supersededLineCount).toBe(0);
    }
    // service difference too — EC2 and S3 in the same window are two facts
    const s1 = line({ batchId: "batch-a", service: "ec2" });
    const s2 = line({ batchId: "batch-b", batchAppliedAt: 2000, service: "s3" });
    expect(planCostReconciliation([s1, s2]).supersededLineCount).toBe(0);
  });

  it("matched multiplicity supersedes ALL older copies (2 in each batch -> 2 marked)", () => {
    const olds = [line({ batchId: "batch-a", batchAppliedAt: 1000 }), line({ batchId: "batch-a", batchAppliedAt: 1000 })];
    const news = [line({ batchId: "batch-b", batchAppliedAt: 2000 }), line({ batchId: "batch-b", batchAppliedAt: 2000 })];
    const plan = planCostReconciliation([...olds, ...news]);
    expect(plan.supersededLineCount).toBe(2);
    expect(plan.duplicateGroups[0]!.supersede.map((s) => s.lineId).sort()).toEqual(olds.map((l) => l.id).sort());
  });
});

describe("the two refusals", () => {
  it("REFUSES a multiplicity conflict — 2 copies in one batch vs 1 in another marks NOTHING and reports", () => {
    const twice = [line({ batchId: "batch-c", batchAppliedAt: 1000 }), line({ batchId: "batch-c", batchAppliedAt: 1000 })];
    const once = [line({ batchId: "batch-d", batchAppliedAt: 2000 })];
    const plan = planCostReconciliation([...twice, ...once]);
    expect(plan.supersededLineCount).toBe(0);
    expect(plan.duplicateGroups).toHaveLength(0);
    expect(plan.ambiguousGroups).toBe(1);
    const w = plan.warnings.find((x) => x.kind === "ambiguous_multiplicity")!;
    expect(w.detail).toMatch(/DIFFERENT\s+multiplicities/);
    expect(w.detail).toMatch(/guessed dedup is a guessed invoice/);
    expect(w.lineIds).toHaveLength(3);
  });

  it("REPORTS an overlapping-but-not-identical window across batches, and marks nothing", () => {
    // July 1–31 in batch a; July 15 – Aug 15 in batch b, different amount
    const a = line({ batchId: "batch-a", batchAppliedAt: 1000, amount: 30 });
    const b = line({
      batchId: "batch-b",
      batchAppliedAt: 2000,
      amount: 17,
      periodStart: Date.UTC(2026, 6, 15),
      periodEnd: Date.UTC(2026, 7, 15),
    });
    const plan = planCostReconciliation([a, b]);
    expect(plan.supersededLineCount).toBe(0);
    expect(plan.overlapWarningCount).toBe(1);
    const w = plan.warnings.find((x) => x.kind === "overlapping_window")!;
    expect(w.detail).toMatch(/NOT superseded/);
    expect(w.lineIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("does NOT report overlap for adjacent (non-intersecting) windows or for lines in the same batch", () => {
    const july = line({ batchId: "batch-a", periodStart: T0, periodEnd: T1 });
    const august = line({ batchId: "batch-b", batchAppliedAt: 2000, amount: 99, periodStart: T1, periodEnd: Date.UTC(2026, 8, 1) });
    expect(planCostReconciliation([july, august]).overlapWarningCount).toBe(0);

    const sameBatch1 = line({ batchId: "batch-a", amount: 5 });
    const sameBatch2 = line({ batchId: "batch-a", amount: 7 });
    expect(planCostReconciliation([sameBatch1, sameBatch2]).overlapWarningCount).toBe(0);
  });

  it("a superseded exact duplicate does not ALSO produce an overlap warning against its keeper", () => {
    const older = line({ batchId: "batch-a", batchAppliedAt: 1000 });
    const newer = line({ batchId: "batch-b", batchAppliedAt: 2000 });
    const plan = planCostReconciliation([older, newer]);
    expect(plan.supersededLineCount).toBe(1);
    expect(plan.overlapWarningCount).toBe(0);
  });
});

describe("bounds and bookkeeping", () => {
  it("the stored warning list is bounded while the COUNT stays honest", () => {
    const lines: ReconciliationLineInput[] = [];
    for (let i = 0; i < RECONCILIATION_MAX_WARNINGS + 30; i += 1) {
      // each pair overlaps within its own account, across two batches
      lines.push(
        line({ batchId: "batch-a", accountKey: `u${i}@acme.example`, amount: 1 }),
        line({
          batchId: "batch-b",
          batchAppliedAt: 2000,
          accountKey: `u${i}@acme.example`,
          amount: 2,
          periodStart: T0 + 1000,
          periodEnd: T1 + 1000,
        }),
      );
    }
    const plan = planCostReconciliation(lines);
    expect(plan.overlapWarningCount).toBe(RECONCILIATION_MAX_WARNINGS + 30);
    expect(plan.warnings.length).toBe(RECONCILIATION_MAX_WARNINGS);
  });

  it("scannedLines reports what it was handed", () => {
    expect(planCostReconciliation([line(), line({ accountKey: "x@y.example" })]).scannedLines).toBe(2);
  });
});
