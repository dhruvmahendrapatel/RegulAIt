/**
 * Batch U4 — the red-team posture, standing findings and per-trial record
 * (ADR-0057, ADR-0068), as the Red-teaming page reads them.
 *
 * `probeTrialSummary` answers the question the per-trial record exists for:
 * "was that 2 of 3 or 40 of 60, and did it flap between trials?" — from the
 * stored rows, never from a mean somebody else computed.
 */

export const RED_TEAM_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface ProbeTrial {
  probeKey: string;
  attackClass: string;
  severity: string;
  trial: number;
  defeated: boolean;
  error: string | null;
}

export interface ProbeTrialSummary {
  probeKey: string;
  attackClass: string;
  severity: string;
  /** usable trials (an errored trial is not a resist) */
  trials: number;
  defeated: number;
  errored: number;
  /** defeated in some usable trials and resisted in others */
  flapped: boolean;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** per probe: defeats over usable trials, errors apart, and whether it flapped; worst first */
export function probeTrialSummary(rows: readonly ProbeTrial[]): ProbeTrialSummary[] {
  const by = new Map<string, ProbeTrialSummary>();
  for (const r of rows) {
    const s = by.get(r.probeKey) ?? { probeKey: r.probeKey, attackClass: r.attackClass, severity: r.severity, trials: 0, defeated: 0, errored: 0, flapped: false };
    if (r.error) s.errored += 1;
    else {
      s.trials += 1;
      if (r.defeated) s.defeated += 1;
    }
    by.set(r.probeKey, s);
  }
  const out = [...by.values()].map((s) => ({ ...s, flapped: s.defeated > 0 && s.defeated < s.trials }));
  return out.sort(
    (a, b) =>
      b.defeated / Math.max(1, b.trials) - a.defeated / Math.max(1, a.trials) ||
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      a.probeKey.localeCompare(b.probeKey),
  );
}

/** an attack-success rate with its Wilson interval, or what is missing */
export function asrText(run: { asr: number | null; asrLower: number | null; asrUpper: number | null; asrTrials: number }): string {
  if (run.asr === null || run.asrTrials === 0) return "not measured (no usable trials)";
  const p = (n: number) => `${(n * 100).toFixed(1)}%`;
  const ci = run.asrLower !== null && run.asrUpper !== null ? ` (95% CI ${p(run.asrLower)}–${p(run.asrUpper)})` : "";
  return `${p(run.asr)}${ci} over ${run.asrTrials} trial${run.asrTrials === 1 ? "" : "s"}`;
}

/** the evidence-attach refusals, as sentences */
export const REDTEAM_EVIDENCE_REFUSALS: Readonly<Record<string, string>> = {
  evidence_already_attached: "This run's evaluation is already cited on that model card. Nothing was changed.",
  unknown_model_card: "That model card no longer exists. Reload the page and choose another.",
  unknown_redteam_run: "This red-team run no longer exists. Reload the page.",
  bom_signing_unavailable:
    "No receipt signing key is available, so the card's signed AI BOM snapshot cannot be taken and the attach was refused. Nothing was changed. Configure a receipt signing key (see Posture) and try again.",
  receipt_signing_key_invalid: "The receipt signing key is configured but unusable, so the attach was refused. Nothing was changed.",
};
