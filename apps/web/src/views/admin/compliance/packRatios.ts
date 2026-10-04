/**
 * ADR-0175 (A1) — coverage BESIDE pass rate on a pack scorecard.
 *
 * A pass rate alone hides how much of the framework the platform can see:
 * "4 of 5 passing" reads the same whether the pack maps 5 controls or 31. So
 * the scorecard shows two ratios, computed here from the totals the evaluate
 * response already returns (no API change):
 *
 *   coverage = controls with evidence ÷ mapped controls
 *   passing  = passing ÷ controls with evidence
 *
 * "With evidence" means a ledger collector checked the control this period
 * (satisfied + unsatisfied). Attested and attestation-required controls are
 * the customer's statements, and unaddressed ones have no collector: they
 * count as mapped, never as evidenced. With nothing evidence-backed, passing
 * is UNKNOWN (null), never 0% and never 100%. Percentages round DOWN so a
 * near-miss never reads as complete.
 */
export interface PackTotalsForRatios {
  controls: number;
  satisfied: number;
  unsatisfied: number;
}

export interface PackRatios {
  mapped: number;
  withEvidence: number;
  passing: number;
  coveragePct: number | null;
  passingPct: number | null;
}

const pctDown = (n: number, d: number): number | null => (d > 0 ? Math.floor((n / d) * 100) : null);

export function packRatios(t: PackTotalsForRatios): PackRatios {
  const withEvidence = t.satisfied + t.unsatisfied;
  return {
    mapped: t.controls,
    withEvidence,
    passing: t.satisfied,
    coveragePct: pctDown(withEvidence, t.controls),
    passingPct: pctDown(t.satisfied, withEvidence),
  };
}

export const pctText = (p: number | null): string => (p === null ? "unknown" : `${p}%`);
