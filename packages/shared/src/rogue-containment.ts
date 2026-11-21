/**
 * ADR-0366 (lane E52): rogue-agent containment (OWASP Agentic ASI10), the pure half.
 *
 * When an agent acts outside its declared role, a CONTAINMENT SIGNAL names the agent, a severity and the evidence. The
 * signal is turned into one of two actions by the org's threshold:
 *
 *   - `propose` (the default for every signal): the governance alert notifies as it always did, and a containment
 *     proposal is filed in the one Approvals Queue for an administrator to decide;
 *   - `auto_contain` (signals at or above the admin-set threshold; `critical` by default, ADR-0180): the agent is
 *     halted at once through ADR-0124's halt, and the containment is audited and released only by an administrator.
 *
 * The signal is a narrow interface on purpose. Slice 1 maps the governance-monitor findings that exist on main
 * (`containmentSignalFromAlert`); behaviour-baseline findings (lane E40, open PR #966) plug in later by producing the
 * same `ContainmentSignal` with `source.kind = "behaviour_baseline"`. Nothing here reads a database.
 */
import { AUTONOMY_CLASSES } from "./assurance.js";
import { defineMachine } from "./state-machine.js";

/** The containment scale. `critical` exists here although the monitor's own scale stops at `high`: a signal adapter
 * may escalate a finding (an agent declared human-in-the-loop seen acting fully autonomously). */
export const CONTAINMENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type ContainmentSeverity = (typeof CONTAINMENT_SEVERITIES)[number];

/** The admin-set threshold for automatic containment: a severity, or `off` (never automatic; a relaxation). */
export const CONTAINMENT_AUTO_THRESHOLDS = ["off", ...CONTAINMENT_SEVERITIES] as const;
export type ContainmentAutoThreshold = (typeof CONTAINMENT_AUTO_THRESHOLDS)[number];
/** ADR-0180: secure by default, automatic containment is on for critical signals. */
export const CONTAINMENT_AUTO_THRESHOLD_DEFAULT: ContainmentAutoThreshold = "critical";

const SEVERITY_RANK: Record<ContainmentSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export const containmentSeverityRank = (s: ContainmentSeverity): number => SEVERITY_RANK[s];

/**
 * How strict a threshold is: `off` is the loosest, and a lower severity threshold contains more (stricter).
 * Used by the org-settings strictness registry: a change is a relaxation when the new value is less strict.
 */
export function containmentThresholdStrictness(t: ContainmentAutoThreshold): number {
  return t === "off" ? 0 : 5 - SEVERITY_RANK[t];
}
export function containmentThresholdLooser(value: ContainmentAutoThreshold, base: ContainmentAutoThreshold): boolean {
  return containmentThresholdStrictness(value) < containmentThresholdStrictness(base);
}

/** What a containment acts on. Slice 1 contains registry agents and builder agents, both through a halt. */
export const CONTAINMENT_SUBJECT_KINDS = ["agent", "builder_agent"] as const;
export type ContainmentSubjectKind = (typeof CONTAINMENT_SUBJECT_KINDS)[number];

/** Where a signal came from. `monitor` = a governance-monitor episode (slice 1); `behaviour_baseline` is reserved for
 * lane E40's explainable findings (open PR #966) and has no producer on main yet. */
export const CONTAINMENT_SIGNAL_SOURCES = ["monitor", "behaviour_baseline"] as const;
export type ContainmentSignalSourceKind = (typeof CONTAINMENT_SIGNAL_SOURCES)[number];

export interface ContainmentSignal {
  readonly source: {
    readonly kind: ContainmentSignalSourceKind;
    /** the producing rule or detector, e.g. `autonomy_declared_below_observed` */
    readonly ruleId: string;
    /** the producing record (a governance alert id for the monitor) */
    readonly refId: string;
  };
  readonly subject: { readonly kind: ContainmentSubjectKind; readonly id: string };
  readonly severity: ContainmentSeverity;
  /** one plain sentence a person reads in the queue: what the agent did outside its role. Ids and names only. */
  readonly explanation: string;
  /** a bounded evidence snapshot (ids, classes, counts); stored as the point-in-time copy */
  readonly evidence: Readonly<Record<string, unknown>>;
}

export type ContainmentAction = "auto_contain" | "propose";

/** THE DECISION: automatic only at or above the threshold; everything else is a proposal for a person. */
export function decideContainmentAction(severity: ContainmentSeverity, threshold: ContainmentAutoThreshold): ContainmentAction {
  if (threshold === "off") return "propose";
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold] ? "auto_contain" : "propose";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTONOMY_LEVEL: Record<string, number> = Object.fromEntries(AUTONOMY_CLASSES.map((c, i) => [c, i]));

/**
 * The severity of an autonomy gap: one class above the declaration is `medium` (the monitor's own severity), two is
 * `high`, and an agent declared `assist` (a person in the loop on every step) observed `autonomous` is `critical`.
 */
export function autonomyGapSeverity(declared: string, observed: string): ContainmentSeverity | null {
  const d = AUTONOMY_LEVEL[declared];
  const o = AUTONOMY_LEVEL[observed];
  if (d === undefined || o === undefined || o <= d) return null;
  const gap = o - d;
  return gap >= 3 ? "critical" : gap === 2 ? "high" : "medium";
}

/** The governance-alert fields an adapter reads. */
export interface ContainmentAlertInput {
  readonly id: string;
  readonly ruleId: string;
  readonly subjectKey: string;
  readonly severity: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

/**
 * The monitor findings that mean "acting outside its declared role", mapped to a containment signal. Returns null for
 * every other rule and for a finding whose subject is not an agent this slice can contain.
 *
 * - `autonomy_declared_below_observed`: a builder agent seen acting at a higher autonomy class than its steward
 *   declared. Severity from the gap (`autonomyGapSeverity`).
 * - `classical_model_drift`: a model card bound to a registry agent drifted past its alert threshold; the agent is
 *   serving outside the behaviour it was approved for. The monitor's own severity (`high`).
 * - `unregistered_ai_traffic` is NOT mapped: its subject is a project, a virtual key or a user, never an agent, so
 *   there is no agent to contain (ADR-0366 §3; a key or project containment is a later slice).
 */
export function containmentSignalFromAlert(alert: ContainmentAlertInput): ContainmentSignal | null {
  const detail = alert.detail ?? {};
  const source = { kind: "monitor" as const, ruleId: alert.ruleId, refId: alert.id };
  if (alert.ruleId === "autonomy_declared_below_observed") {
    const agentId = detail.agentId;
    const declared = String(detail.declared ?? "");
    const observed = String(detail.observed ?? "");
    if (typeof agentId !== "string" || !UUID_RE.test(agentId)) return null;
    const severity = autonomyGapSeverity(declared, observed);
    if (!severity) return null;
    return {
      source,
      subject: { kind: "builder_agent", id: agentId },
      severity,
      explanation: `builder agent ${typeof detail.agentName === "string" ? `'${detail.agentName.slice(0, 120)}'` : agentId} is declared ${declared} but was observed acting ${observed}`,
      evidence: { declared, observed, reasons: Array.isArray(detail.reasons) ? detail.reasons.slice(0, 20) : [] },
    };
  }
  if (alert.ruleId === "classical_model_drift") {
    const agentId = detail.agentId;
    if (typeof agentId !== "string" || !UUID_RE.test(agentId)) return null;
    return {
      source,
      subject: { kind: "agent", id: agentId },
      severity: (CONTAINMENT_SEVERITIES as readonly string[]).includes(alert.severity) ? (alert.severity as ContainmentSeverity) : "high",
      explanation: `the model card bound to agent ${agentId} drifted past an alert threshold on monitor ${String(detail.monitorId ?? "?")}`,
      evidence: {
        cardId: detail.cardId ?? null,
        monitorId: detail.monitorId ?? null,
        reportId: detail.reportId ?? null,
        features: Array.isArray(detail.features) ? detail.features.slice(0, 20) : [],
      },
    };
  }
  return null;
}

/** The rules that can produce a containment signal (for the policy read and for tests). */
export const CONTAINMENT_SIGNAL_RULES = ["autonomy_declared_below_observed", "classical_model_drift"] as const;

// ---------------------------------------------------------------------------
// The containment lifecycle (ADR-0348's defineMachine)
// ---------------------------------------------------------------------------

export const CONTAINMENT_STATES = ["proposed", "contained", "declined", "release_pending", "released"] as const;
export type ContainmentState = (typeof CONTAINMENT_STATES)[number];

/**
 * `agent_containments.status`. One row per signal; a later signal for the same agent is a new row.
 *
 * Owner decision 2026-11-21 (ADR-0366 addendum): containing narrows access, so an automatic containment is created
 * `contained` with no approval; LIFTING one widens access, so a release is a request (`release_pending`) that a
 * different administrator approves in the Approvals Queue with an MFA step-up.
 */
export const CONTAINMENT_MACHINE = defineMachine({
  id: "agent_containment",
  stored: "agent_containments.status",
  states: CONTAINMENT_STATES,
  initial: ["proposed", "contained"],
  terminal: ["declined", "released"],
  transitions: {
    approve: {
      from: ["proposed"],
      to: "contained",
      by: ["approver"],
      summary: "An administrator approved the proposal with an MFA step-up; the agent is halted through the one kill-switch halt (ADR-0124).",
    },
    decline: {
      from: ["proposed"],
      to: "declined",
      by: ["approver"],
      summary: "An administrator declined the proposal with an MFA step-up; the agent keeps running and the alert stays open.",
    },
    request_release: {
      from: ["contained"],
      to: "release_pending",
      by: ["admin"],
      summary:
        "An administrator asked to release the containment, with a reason and a step-up; a different administrator decides it in the Approvals Queue. The agent stays halted meanwhile.",
    },
    approve_release: {
      from: ["release_pending"],
      to: "released",
      by: ["approver"],
      summary:
        "A different administrator approved the release with an MFA step-up while the execution dial is normal; the halt is lifted unless a person set it or another open containment still holds the agent.",
    },
    deny_release: {
      from: ["release_pending"],
      to: "contained",
      by: ["approver"],
      summary: "The approver refused the release with an MFA step-up; the agent stays halted.",
    },
  },
});

/** Every halt a containment sets starts with this, so a release lifts only a halt a containment set (never one a
 * person threw by hand for another reason). */
export const CONTAINMENT_HALT_PREFIX = "contained (ADR-0366): ";
