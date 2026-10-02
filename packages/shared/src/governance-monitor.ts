/**
 * ADR-0157 — THE GOVERNANCE MONITOR: rules that turn the standing picture
 * (dependency graph, trust coverage, risk register) into alerts.
 *
 * Pure half: the rule catalogue, the evaluator and the reconciliation of
 * findings against stored alerts. The gateway gathers the inputs from the
 * registers and writes the rows.
 *
 * SCOPE, ON PURPOSE. Use-case rules fire only for APPROVED use cases — the
 * ones in production. A proposal that depends on a halted agent is a review
 * comment; an approved system that does is an incident. Firing on every
 * proposal would bury the second under the first.
 *
 * Every finding names the record it is about and carries the data a reviewer
 * needs to check it (the propagation path, the coverage figures). An alert is
 * a pointer at evidence, never a verdict.
 */
import type { PropagatedRating, RiskBand } from "./dependency-graph.js";
import type { TrustDimension } from "./risks.js";

export const MONITOR_SEVERITIES = ["low", "medium", "high"] as const;
export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number];

export const MONITOR_RULES = {
  use_case_inherited_high_risk: {
    label: "Approved use case carries a high rating",
    severity: "high",
    description:
      "An approved use case's propagated rating (ADR-0156) is high — from its own risks or from an agent, " +
      "model or vendor it depends on.",
  },
  use_case_agent_halted: {
    label: "Approved use case depends on a halted or retired agent",
    severity: "high",
    description:
      "An agent the approved use case depends on is halted, disabled, or not in active lifecycle; the " +
      "use case cannot run as approved.",
  },
  use_case_vendor_unapproved: {
    label: "Approved use case depends on an unapproved vendor",
    severity: "medium",
    description:
      "A vendor in the approved use case's dependency chain is not approved (proposed, under assessment, " +
      "rejected or retired).",
  },
  use_case_agent_unowned: {
    label: "Approved use case depends on an unowned agent",
    severity: "medium",
    description: "An agent the approved use case depends on has no accountable owner, or its owner is deactivated.",
  },
  use_case_agent_no_approved_model_card: {
    label: "Agent in production has no approved model card",
    severity: "medium",
    description:
      "An agent the approved use case depends on has no unexpired model-card approval (ADR-0045), so the " +
      "MRM gate would refuse it when enforced.",
  },
  high_risk_without_control: {
    label: "High risk with no mitigating control",
    severity: "high",
    description:
      "A live (open or mitigating) risk rated high has no linked pack control (ADR-0147). Accepted and " +
      "closed risks are excluded: they are decided.",
  },
  dimension_coverage_below_floor: {
    label: "Trust dimension evidence coverage below floor",
    severity: "medium",
    description:
      "A measured trust dimension's evidence coverage (ADR-0148) is below the floor. Unmeasured dimensions " +
      "do not fire — a gap is reported on the dashboard, not as an alert on every install.",
  },
} as const satisfies Record<string, { label: string; severity: MonitorSeverity; description: string }>;
export type MonitorRuleId = keyof typeof MONITOR_RULES;
export const MONITOR_RULE_IDS = Object.keys(MONITOR_RULES) as MonitorRuleId[];

/** default evidence-coverage floor for `dimension_coverage_below_floor` */
export const DEFAULT_COVERAGE_FLOOR_PCT = 50;

export interface MonitorFinding {
  ruleId: MonitorRuleId;
  subjectKey: string;
  severity: MonitorSeverity;
  title: string;
  detail: Record<string, unknown>;
}

export interface MonitorUseCaseInput {
  id: string;
  name: string;
  status: string;
  propagated: PropagatedRating;
  /** transitive dependencies from the graph */
  agentIds: string[];
  vendorIds: string[];
}

export interface MonitorAgentInput {
  id: string;
  name: string;
  halted: boolean;
  enabled: boolean;
  lifecycleStatus: string;
  /** "owned" | "unowned" | "orphaned" (ADR-0089) */
  ownership: "owned" | "unowned" | "orphaned";
  modelCardApproved: boolean;
}

export interface MonitorVendorInput {
  id: string;
  name: string;
  status: string;
}

export interface MonitorRiskInput {
  id: string;
  title: string;
  status: string;
  band: RiskBand;
  controls: number;
}

export interface MonitorDimensionInput {
  key: TrustDimension;
  label: string;
  measured: boolean;
  evidenceCoveragePct: number | null;
  controlsEvidenced: number;
  controlsApplicable: number;
}

export interface MonitorInput {
  useCases: MonitorUseCaseInput[];
  agents: ReadonlyMap<string, MonitorAgentInput>;
  vendors: ReadonlyMap<string, MonitorVendorInput>;
  risks: MonitorRiskInput[];
  dimensions: MonitorDimensionInput[];
  /** node key → label, for readable propagation paths */
  labels?: ReadonlyMap<string, string>;
  coverageFloorPct?: number;
}

const sev = (id: MonitorRuleId): MonitorSeverity => MONITOR_RULES[id].severity;

export function evaluateMonitorRules(input: MonitorInput): MonitorFinding[] {
  const out: MonitorFinding[] = [];
  const floor = input.coverageFloorPct ?? DEFAULT_COVERAGE_FLOOR_PCT;
  const label = (k: string) => input.labels?.get(k) ?? k;

  for (const uc of input.useCases) {
    if (uc.status !== "approved") continue;
    const subjectKey = `use_case:${uc.id}`;

    if (uc.propagated.band === "high") {
      const inherited = uc.propagated.sourceNodeKey !== null && uc.propagated.sourceNodeKey !== subjectKey;
      out.push({
        ruleId: "use_case_inherited_high_risk",
        subjectKey,
        severity: sev("use_case_inherited_high_risk"),
        title: inherited
          ? `${uc.name} inherits a HIGH rating from ${label(uc.propagated.sourceNodeKey!)}`
          : `${uc.name} carries a HIGH-rated risk of its own`,
        detail: {
          score: uc.propagated.score,
          sourceNodeKey: uc.propagated.sourceNodeKey,
          sourceRiskId: uc.propagated.sourceRiskId,
          path: uc.propagated.path,
          pathLabels: uc.propagated.path.map(label),
        },
      });
    }

    for (const agentId of uc.agentIds) {
      const a = input.agents.get(agentId);
      if (!a) continue;
      const agentKey = `agent:${a.id}`;
      // keyed by the PAIR: the same agent in two use cases is two conditions
      const pairKey = `${subjectKey}>${agentKey}`;
      if (a.halted || !a.enabled || a.lifecycleStatus !== "active") {
        out.push({
          ruleId: "use_case_agent_halted",
          subjectKey: pairKey,
          severity: sev("use_case_agent_halted"),
          title: `${uc.name} depends on ${a.name}, which is ${a.halted ? "halted" : !a.enabled ? "disabled" : a.lifecycleStatus}`,
          detail: { useCaseId: uc.id, agentId: a.id, halted: a.halted, enabled: a.enabled, lifecycleStatus: a.lifecycleStatus },
        });
      }
      if (a.ownership !== "owned") {
        out.push({
          ruleId: "use_case_agent_unowned",
          subjectKey: pairKey,
          severity: sev("use_case_agent_unowned"),
          title: `${uc.name} depends on ${a.name}, which is ${a.ownership}`,
          detail: { useCaseId: uc.id, agentId: a.id, ownership: a.ownership },
        });
      }
      if (!a.modelCardApproved) {
        out.push({
          ruleId: "use_case_agent_no_approved_model_card",
          subjectKey: pairKey,
          severity: sev("use_case_agent_no_approved_model_card"),
          title: `${a.name} is in production via ${uc.name} without an approved model card`,
          detail: { useCaseId: uc.id, agentId: a.id },
        });
      }
    }

    for (const vendorId of uc.vendorIds) {
      const v = input.vendors.get(vendorId);
      if (!v || v.status === "approved") continue;
      out.push({
        ruleId: "use_case_vendor_unapproved",
        subjectKey: `${subjectKey}>vendor:${v.id}`,
        severity: sev("use_case_vendor_unapproved"),
        title: `${uc.name} depends on vendor ${v.name}, which is ${v.status.replace(/_/g, " ")}`,
        detail: { useCaseId: uc.id, vendorId: v.id, vendorStatus: v.status },
      });
    }
  }

  for (const r of input.risks) {
    if (r.status !== "open" && r.status !== "mitigating") continue;
    if (r.band !== "high" || r.controls > 0) continue;
    out.push({
      ruleId: "high_risk_without_control",
      subjectKey: `risk:${r.id}`,
      severity: sev("high_risk_without_control"),
      title: `"${r.title}" is rated high and has no mitigating control`,
      detail: { riskId: r.id, status: r.status },
    });
  }

  for (const d of input.dimensions) {
    if (!d.measured || d.evidenceCoveragePct === null || d.evidenceCoveragePct >= floor) continue;
    out.push({
      ruleId: "dimension_coverage_below_floor",
      subjectKey: `dimension:${d.key}`,
      severity: sev("dimension_coverage_below_floor"),
      title: `${d.label} evidence coverage is ${d.evidenceCoveragePct}% (floor ${floor}%)`,
      detail: {
        dimension: d.key,
        evidenceCoveragePct: d.evidenceCoveragePct,
        controlsEvidenced: d.controlsEvidenced,
        controlsApplicable: d.controlsApplicable,
        floorPct: floor,
      },
    });
  }

  // deterministic: one finding per (rule, subject)
  const seen = new Map<string, MonitorFinding>();
  for (const f of out) seen.set(`${f.ruleId}|${f.subjectKey}`, f);
  return [...seen.values()].sort((a, b) =>
    a.ruleId === b.ruleId ? a.subjectKey.localeCompare(b.subjectKey) : a.ruleId.localeCompare(b.ruleId),
  );
}

export interface ActiveAlertRef {
  id: string;
  ruleId: string;
  subjectKey: string;
}

/**
 * Match findings against the ACTIVE (open/acknowledged) alerts:
 * new condition → raise; persisting → refresh (status untouched, so an
 * acknowledgement survives); cleared → resolve. Only rules in `evaluatedRules`
 * can resolve — an alert from a rule this pass did not run is left alone.
 */
export function reconcileAlerts(
  active: readonly ActiveAlertRef[],
  findings: readonly MonitorFinding[],
  evaluatedRules: ReadonlySet<string> = new Set(MONITOR_RULE_IDS),
): { raise: MonitorFinding[]; refresh: Array<{ id: string; finding: MonitorFinding }>; resolve: string[] } {
  const byKey = new Map(active.map((a) => [`${a.ruleId}|${a.subjectKey}`, a]));
  const raise: MonitorFinding[] = [];
  const refresh: Array<{ id: string; finding: MonitorFinding }> = [];
  const still = new Set<string>();
  for (const f of findings) {
    const k = `${f.ruleId}|${f.subjectKey}`;
    const existing = byKey.get(k);
    if (existing) {
      refresh.push({ id: existing.id, finding: f });
      still.add(existing.id);
    } else {
      raise.push(f);
    }
  }
  const resolve = active.filter((a) => !still.has(a.id) && evaluatedRules.has(a.ruleId)).map((a) => a.id);
  return { raise, refresh, resolve };
}
