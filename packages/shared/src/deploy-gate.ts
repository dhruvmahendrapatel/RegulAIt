/**
 * ADR-0161 — THE DEPLOY GATE: one question a CI/CD pipeline asks before it
 * ships an AI system — "is this use case, with these agents, cleared to go
 * out right now?" — answered from governance state the platform already
 * keeps, never from a second policy store.
 *
 *   BLOCK  use case not approved · agent outside the approved stack · agent
 *          halted / disabled / not active · the MRM gate refuses the agent ·
 *          an OPEN high-severity monitor alert on the use case or its agents ·
 *          an OPEN before-go-live approval condition (ADR-0168) · an approval
 *          past its "valid until" (ADR-0168)
 *   WARN   no approved model card while MRM is not enforced · an
 *          ACKNOWLEDGED high alert (a person has it in hand) · an open
 *          medium alert
 *
 *   ADR-0182 A12, as `incident_gate_mode` says (enforce = BLOCK, warn = WARN,
 *   off = skipped and labelled so): a serious incident, or a high or critical
 *   incident, on the use case that is not closed. Only closing it releases the
 *   gate (`resolved` does not: D4 review D4A-01 / D4G-01).
 *
 *   ADR-0180 continuous assurance, as `assurance_gate_mode` says (enforce =
 *   BLOCK, warn = WARN, off = skipped and labelled so): a measured condition
 *   failing or without passing evidence · a required AI test class missing,
 *   stale or failing · an unmet autonomy floor · residual risk above tolerance
 *   with no valid acceptance · any of those checks not evaluated. A WAIVED
 *   condition is always a WARN, never a pass.
 *
 * The gate decides nothing a dispatch reads; dispatch enforcement (MRM,
 * halts, entitlements) is unchanged. It moves the same answer EARLIER, to the
 * pipeline, so a release that would be refused at runtime is refused at
 * build time with reasons a developer can act on.
 */
import type { AssuranceGateMode, ConditionVerdict, DeployGateAssuranceInput, RequiredTestStatus } from "./assurance.js";
import type { AccountabilityGateMode, IncidentSeverity, IncidentStatus } from "./accountability.js";
import { incidentHoldsGate } from "./incidents.js";

export const DEPLOY_GATE_REASON_CODES = [
  "use_case_not_approved",
  "approval_expired",
  "open_blocking_condition",
  "agent_not_in_approved_stack",
  "agent_unavailable",
  "mrm_refused",
  "model_card_unapproved",
  "open_high_alert",
  "acknowledged_high_alert",
  "open_medium_alert",
  // ADR-0180 — continuous assurance (governed by `assurance_gate_mode`)
  "condition_failing",
  "condition_not_measured",
  "condition_waived",
  "required_test_missing",
  "required_test_stale",
  "required_test_failing",
  "autonomy_floor_unmet",
  "residual_above_tolerance",
  "assurance_check_unavailable",
  // ADR-0182 A12 — the AI incident register (governed by `incident_gate_mode`)
  "open_serious_incident",
  "open_high_incident",
] as const;
export type DeployGateReasonCode = (typeof DEPLOY_GATE_REASON_CODES)[number];

/** The plain-language meaning of every reason code: what it means and what a
 * person does about it. The gate puts `explanation` on each reason; the web
 * and the CLI show it. */
export const DEPLOY_GATE_REASON_INFO: Readonly<Record<DeployGateReasonCode, { title: string; explanation: string }>> = {
  use_case_not_approved: {
    title: "Use case not approved",
    explanation: "Only an approved use case may ship. Take it through review and sign-off first.",
  },
  approval_expired: {
    title: "Approval expired",
    explanation: "Every approval has a lifetime. This one has run out, so the use case needs re-review before it ships.",
  },
  open_blocking_condition: {
    title: "Before-go-live condition open",
    explanation: "The approval was given on a condition that must be met before go-live. Its owner marks it met when it is done.",
  },
  agent_not_in_approved_stack: {
    title: "Agent outside the approved stack",
    explanation: "The release ships an agent the approval did not cover. Amend the use case and have it re-approved.",
  },
  agent_unavailable: {
    title: "Agent unavailable",
    explanation: "An agent of the stack is halted, disabled, retired or deleted, so it would be refused at runtime.",
  },
  mrm_refused: {
    title: "Model-risk gate refuses the agent",
    explanation: "Model-risk management is enforced and this agent has no valid model-card approval, so dispatch would refuse it.",
  },
  model_card_unapproved: {
    title: "Model card not approved",
    explanation: "The agent has no unexpired model-card approval. Model-risk management is not enforced, so this is a warning.",
  },
  open_high_alert: {
    title: "Open high-severity alert",
    explanation: "A high-severity monitor alert on the use case or its agents is open. Acknowledge it (a person takes it in hand) or resolve it.",
  },
  acknowledged_high_alert: {
    title: "Acknowledged high-severity alert",
    explanation: "A person has this high-severity alert in hand. It no longer holds the release.",
  },
  open_medium_alert: {
    title: "Open medium-severity alert",
    explanation: "A medium-severity monitor alert is open. It does not hold the release.",
  },
  condition_failing: {
    title: "Measured condition failing",
    explanation: "A condition of approval is measured from the platform's own records, and the latest measurement does not meet its threshold.",
  },
  condition_not_measured: {
    title: "Measured condition has no passing evidence",
    explanation: "A measured condition has no passing evidence yet (too few samples, or nothing measured). Only passing evidence closes it.",
  },
  condition_waived: {
    title: "Condition waived",
    explanation: "An admin waived this measured condition, with a recorded reason. A waiver is a warning, never a pass.",
  },
  required_test_missing: {
    title: "Required AI test missing",
    explanation: "The use case's risk tier requires this OWASP test class, and no completed red-team or eval run measured it for this agent on its current configuration.",
  },
  required_test_stale: {
    title: "Required AI test stale",
    explanation: "The last run that measured this required class is older than the freshness limit, or the agent's configuration changed since. Run it again.",
  },
  required_test_failing: {
    title: "Required AI test failing",
    explanation: "The newest run of this required class, on the current configuration, is past its threshold (attack success rate too high, or score too low).",
  },
  autonomy_floor_unmet: {
    title: "Autonomy floor unmet",
    explanation: "The agent's autonomy class requires controls that are not in place.",
  },
  residual_above_tolerance: {
    title: "Residual risk above tolerance",
    explanation: "A risk's residual band is above the organisation's tolerance and has no valid, unexpired acceptance.",
  },
  assurance_check_unavailable: {
    title: "Assurance check could not run",
    explanation: "One of the continuous-assurance checks was not evaluated. A check that did not run is never a pass.",
  },
  open_serious_incident: {
    title: "Open serious incident",
    explanation:
      "A serious AI incident on this use case is not closed. It holds the release until it is closed (the incident deploy gate); marking it resolved does not release it.",
  },
  open_high_incident: {
    title: "Open high-severity incident",
    explanation:
      "A high or critical AI incident on this use case is not closed. It holds the release until it is closed (the incident deploy gate); marking it resolved does not release it.",
  },
};

export interface DeployGateReason {
  code: DeployGateReasonCode;
  severity: "block" | "warn";
  message: string;
  /** the plain-language meaning of `code` (DEPLOY_GATE_REASON_INFO) */
  explanation?: string;
  /** the record to open to fix it */
  ref?: { type: "use_case" | "agent" | "alert" | "risk" | "condition" | "incident"; id: string };
}

/** How the ADR-0180 checks were applied. `label` is the one-line answer the
 * CLI prints after "assurance: ". */
export interface DeployGateAssuranceSummary {
  mode: AssuranceGateMode;
  status: "enforced" | "warn_only" | "skipped";
  label: string;
}

/** the D3 reason codes, the ones `assurance_gate_mode` governs */
export const ASSURANCE_GATE_REASON_CODES: readonly DeployGateReasonCode[] = [
  "condition_failing",
  "condition_not_measured",
  "condition_waived",
  "required_test_missing",
  "required_test_stale",
  "required_test_failing",
  "autonomy_floor_unmet",
  "residual_above_tolerance",
  "assurance_check_unavailable",
];

/** ADR-0182 A12: the reason codes `incident_gate_mode` governs */
export const INCIDENT_GATE_REASON_CODES: readonly DeployGateReasonCode[] = ["open_serious_incident", "open_high_incident"];

/** ADR-0182 A12: one AI incident on the use case, as the gate reads it */
export interface DeployGateIncidentInput {
  id: string;
  ref: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  serious: boolean;
}

/** How `incident_gate_mode` was applied; `label` is the one-line answer. */
export interface DeployGateIncidentSummary {
  mode: AccountabilityGateMode;
  status: "enforced" | "warn_only" | "skipped";
  label: string;
}

export interface DeployGateAgentInput {
  id: string;
  name: string;
  halted: boolean;
  enabled: boolean;
  lifecycleStatus: string;
  /** the MRM dispatch gate's refusal detail when enforced and refusing, else null */
  mrmRefusal: string | null;
  modelCardApproved: boolean;
}

/** ADR-0180: the continuous-assurance inputs (`assuranceMode`,
 * `conditionVerdicts`, `requiredTests`, `autonomy`, `residualRisks`), all
 * optional; A3 composes them into the decision. */
export interface DeployGateInput extends DeployGateAssuranceInput {
  useCase: {
    id: string;
    name: string;
    status: string;
    intendedAgentIds: string[];
    /** ADR-0168: the approval's "valid until"; absent/null = no recorded lifetime */
    approvedUntil?: Date | string | null;
  };
  /** ADR-0168: the use case's OPEN before-go-live (blocking) conditions */
  openBlockingConditions?: ReadonlyArray<{ id: string; text: string }>;
  /** evaluation instant for the expiry test; defaults to now */
  now?: Date;
  /**
   * Agents the release declares it ships (AER-044). A selection can only ADD to
   * what is checked, never narrow it: the evaluator always checks the use
   * case's whole approved stack (`intendedAgentIds`), so null, `[]` and a
   * subset all evaluate every intended agent — a halted, disabled or
   * MRM-refused intended agent blocks however the request is phrased. Any
   * requested agent outside the stack blocks as `agent_not_in_approved_stack`.
   */
  requestedAgentIds: readonly string[] | null;
  agents: ReadonlyMap<string, DeployGateAgentInput>;
  /** active monitor alerts whose subject is this use case or one of its agents */
  alerts: ReadonlyArray<{ id: string; ruleId: string; severity: string; status: string; title: string }>;
  /** ADR-0182 A12: `incident_gate_mode`; absent = the incident check is not part of this evaluation */
  incidentMode?: AccountabilityGateMode;
  /** ADR-0182 A12: the use case's AI incidents that are not closed */
  incidents?: ReadonlyArray<DeployGateIncidentInput>;
}

export interface DeployGateDecision {
  decision: "allow" | "deny";
  reasons: DeployGateReason[];
  agentsChecked: string[];
  /** present when `assuranceMode` was given (the route always gives it) */
  assurance?: DeployGateAssuranceSummary;
  /** ADR-0182 A12: present when `incidentMode` was given (the route always gives it) */
  incidentGate?: DeployGateIncidentSummary;
}

const INCIDENT_LABEL: Record<AccountabilityGateMode, DeployGateIncidentSummary> = {
  enforce: { mode: "enforce", status: "enforced", label: "enforced (mode enforce)" },
  warn: { mode: "warn", status: "warn_only", label: "reported as warnings (mode warn)" },
  off: { mode: "off", status: "skipped", label: "skipped (mode off)" },
};

/** ADR-0182 A12: an open or contained serious, high or critical incident holds the gate (enforce) or warns (warn) */
function incidentReasons(input: DeployGateInput, mode: Exclude<AccountabilityGateMode, "off">): DeployGateReason[] {
  const sev: "block" | "warn" = mode === "enforce" ? "block" : "warn";
  const out: DeployGateReason[] = [];
  for (const i of input.incidents ?? []) {
    const code = incidentHoldsGate(i);
    if (!code) continue;
    out.push({
      code,
      severity: sev,
      message: `incident ${i.ref} (${i.serious ? "serious, " : ""}${i.severity}) is ${i.status} on "${input.useCase.name}"`,
      ref: { type: "incident", id: i.id },
    });
  }
  return out;
}

/** a measured (non-manual) condition */
const isMeasured = (v: ConditionVerdict) => v.kind !== "manual";

function assuranceReasons(input: DeployGateInput, mode: Exclude<AssuranceGateMode, "off">): DeployGateReason[] {
  const out: DeployGateReason[] = [];
  const sev: "block" | "warn" = mode === "enforce" ? "block" : "warn";
  const uc = input.useCase;
  const notGathered = (what: string) =>
    out.push({
      code: "assurance_check_unavailable",
      severity: sev,
      message: `${what} were not evaluated for "${uc.name}"`,
      ref: { type: "use_case", id: uc.id },
    });

  // 1. measured conditions (A2). Waived: always a warning, never a pass.
  if (!input.conditionVerdicts) notGathered("measured conditions");
  for (const v of (input.conditionVerdicts ?? []).filter(isMeasured)) {
    const ref = { type: "condition" as const, id: v.conditionId };
    if (v.status === "waived" || v.state === "waived") {
      out.push({ code: "condition_waived", severity: "warn", message: `waived: ${v.text}`, ref });
      continue;
    }
    if (v.state === "pass") continue;
    if (v.state === "fail") {
      const m = v.measurement;
      out.push({
        code: "condition_failing",
        severity: sev,
        message: `${v.text}${m && m.value !== null ? ` (measured ${m.value} over ${m.samples} sample(s))` : ""}`,
        ref,
      });
      continue;
    }
    // insufficient / not_run: no passing evidence. A before-go-live condition
    // holds; an ongoing one is reported.
    out.push({
      code: "condition_not_measured",
      severity: v.blocking ? sev : "warn",
      message: `${v.text} (${v.state === "insufficient" ? "too few samples" : "not measured yet"})`,
      ref,
    });
  }

  // 2. required AI test classes (A3)
  if (!input.requiredTests) notGathered("required AI tests");
  const testCode: Partial<Record<RequiredTestStatus["state"], DeployGateReasonCode>> = {
    missing: "required_test_missing",
    not_run: "required_test_missing",
    stale: "required_test_stale",
    failing: "required_test_failing",
  };
  for (const t of input.requiredTests ?? []) {
    // allow-list: only `satisfied` passes. Any other state, including one this
    // build does not know, holds as missing evidence (fail closed).
    if (t.state === "satisfied") continue;
    const code = testCode[t.state] ?? "required_test_missing";
    const who = t.agentId ? `agent ${input.agents.get(t.agentId)?.name ?? t.agentId}` : `"${uc.name}"`;
    out.push({
      code,
      severity: sev,
      message: `${t.testClass} on ${who}: ${t.detail ?? String(t.state ?? "unknown state").replace(/_/g, " ")}`,
      ref: t.agentId ? { type: "agent", id: t.agentId } : { type: "use_case", id: uc.id },
    });
  }

  // 3. autonomy floor (A8). `undefined` = not gathered; `null` = no builder agent.
  if (input.autonomy === undefined) notGathered("autonomy floors");
  for (const c of input.autonomy?.unmet ?? []) {
    out.push({
      code: "autonomy_floor_unmet",
      severity: sev,
      message: `${input.autonomy?.derived ? `${input.autonomy.derived} autonomy: ` : ""}${c.text}`,
      ref: { type: "use_case", id: uc.id },
    });
  }

  // 4. residual risk above tolerance with no valid acceptance (A10)
  if (!input.residualRisks) notGathered("residual risk positions");
  for (const r of input.residualRisks ?? []) {
    if (!r.aboveTolerance || r.acceptance) continue;
    out.push({
      code: "residual_above_tolerance",
      severity: sev,
      message: `risk ${r.riskId}: residual ${r.band ?? "unrated"} is above the ${r.tolerance.band} tolerance (${r.tolerance.source}) and has no valid acceptance`,
      ref: { type: "risk", id: r.riskId },
    });
  }
  return out;
}

const ASSURANCE_LABEL: Record<AssuranceGateMode, DeployGateAssuranceSummary> = {
  enforce: { mode: "enforce", status: "enforced", label: "enforced (mode enforce)" },
  warn: { mode: "warn", status: "warn_only", label: "reported as warnings (mode warn)" },
  off: { mode: "off", status: "skipped", label: "skipped (mode off)" },
};

export function evaluateDeployGate(input: DeployGateInput): DeployGateDecision {
  const reasons: DeployGateReason[] = [];
  const uc = input.useCase;
  if (uc.status !== "approved") {
    reasons.push({
      code: "use_case_not_approved",
      severity: "block",
      message: `use case "${uc.name}" is ${uc.status.replace(/_/g, " ")}, not approved`,
      ref: { type: "use_case", id: uc.id },
    });
  }
  // ADR-0168 — an approval has a lifetime. Only an APPROVED use case can be
  // expired; any other status is already refused above, by its own name.
  if (uc.status === "approved" && uc.approvedUntil) {
    const until = new Date(uc.approvedUntil);
    if (until.getTime() <= (input.now ?? new Date()).getTime()) {
      reasons.push({
        code: "approval_expired",
        severity: "block",
        message: `"${uc.name}" approval expired on ${until.toISOString().slice(0, 10)}; re-review required`,
        ref: { type: "use_case", id: uc.id },
      });
    }
  }
  // ADR-0168 — a before-go-live condition blocks while it is open.
  const blockingOpen = input.openBlockingConditions ?? [];
  if (blockingOpen.length > 0) {
    reasons.push({
      code: "open_blocking_condition",
      severity: "block",
      message:
        `"${uc.name}" has ${blockingOpen.length} open before-go-live condition(s): ` +
        blockingOpen.map((c) => c.text).join("; "),
      ref: { type: "use_case", id: uc.id },
    });
  }
  const approvedStack = new Set(uc.intendedAgentIds);
  // AER-044: the whole approved stack, then any requested extras — never only
  // the request. An empty or partial selection cannot skip an intended agent,
  // so it cannot launder a halt or an MRM refusal the use case's stack carries.
  const checked = [...new Set([...uc.intendedAgentIds, ...(input.requestedAgentIds ?? [])])];
  for (const id of checked) {
    if (!approvedStack.has(id)) {
      reasons.push({
        code: "agent_not_in_approved_stack",
        severity: "block",
        message: `agent ${input.agents.get(id)?.name ?? id} is not in the approved stack of "${uc.name}" — amend and re-approve the use case`,
        ref: { type: "agent", id },
      });
      continue;
    }
    const a = input.agents.get(id);
    if (!a) {
      reasons.push({ code: "agent_unavailable", severity: "block", message: `agent ${id} no longer exists`, ref: { type: "agent", id } });
      continue;
    }
    if (a.halted || !a.enabled || a.lifecycleStatus !== "active") {
      reasons.push({
        code: "agent_unavailable",
        severity: "block",
        message: `agent ${a.name} is ${a.halted ? "halted" : !a.enabled ? "disabled" : a.lifecycleStatus}`,
        ref: { type: "agent", id },
      });
    }
    if (a.mrmRefusal) {
      reasons.push({ code: "mrm_refused", severity: "block", message: `agent ${a.name}: ${a.mrmRefusal}`, ref: { type: "agent", id } });
    } else if (!a.modelCardApproved) {
      reasons.push({
        code: "model_card_unapproved",
        severity: "warn",
        message: `agent ${a.name} has no unexpired model-card approval (MRM is not enforced, so dispatch would allow it)`,
        ref: { type: "agent", id },
      });
    }
  }
  for (const al of input.alerts) {
    if (al.severity === "high" && al.status === "open") {
      reasons.push({ code: "open_high_alert", severity: "block", message: al.title, ref: { type: "alert", id: al.id } });
    } else if (al.severity === "high" && al.status === "acknowledged") {
      reasons.push({ code: "acknowledged_high_alert", severity: "warn", message: `acknowledged: ${al.title}`, ref: { type: "alert", id: al.id } });
    } else if (al.status === "open" && al.severity === "medium") {
      reasons.push({ code: "open_medium_alert", severity: "warn", message: al.title, ref: { type: "alert", id: al.id } });
    }
  }
  // ADR-0180 — the continuous-assurance checks, as the org's mode says:
  // enforce holds, warn reports, off skips (and the summary says so).
  const mode = input.assuranceMode;
  if (mode && mode !== "off") reasons.push(...assuranceReasons(input, mode));
  // ADR-0182 A12 — the incident register, as `incident_gate_mode` says
  const incidentMode = input.incidentMode;
  if (incidentMode && incidentMode !== "off") reasons.push(...incidentReasons(input, incidentMode));
  for (const r of reasons) r.explanation = DEPLOY_GATE_REASON_INFO[r.code].explanation;
  const order = (r: DeployGateReason) => (r.severity === "block" ? 0 : 1);
  reasons.sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code));
  return {
    decision: reasons.some((r) => r.severity === "block") ? "deny" : "allow",
    reasons,
    agentsChecked: [...checked],
    ...(mode ? { assurance: { ...ASSURANCE_LABEL[mode] } } : {}),
    ...(incidentMode ? { incidentGate: { ...INCIDENT_LABEL[incidentMode] } } : {}),
  };
}
