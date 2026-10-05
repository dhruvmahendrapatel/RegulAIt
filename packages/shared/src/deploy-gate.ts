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
 * The gate decides nothing a dispatch reads; dispatch enforcement (MRM,
 * halts, entitlements) is unchanged. It moves the same answer EARLIER, to the
 * pipeline, so a release that would be refused at runtime is refused at
 * build time with reasons a developer can act on.
 */
import type { DeployGateAssuranceInput } from "./assurance.js";

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
] as const;
export type DeployGateReasonCode = (typeof DEPLOY_GATE_REASON_CODES)[number];

export interface DeployGateReason {
  code: DeployGateReasonCode;
  severity: "block" | "warn";
  message: string;
  /** the record to open to fix it */
  ref?: { type: "use_case" | "agent" | "alert"; id: string };
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
}

export interface DeployGateDecision {
  decision: "allow" | "deny";
  reasons: DeployGateReason[];
  agentsChecked: string[];
}

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
  const order = (r: DeployGateReason) => (r.severity === "block" ? 0 : 1);
  reasons.sort((a, b) => order(a) - order(b) || a.code.localeCompare(b.code));
  return {
    decision: reasons.some((r) => r.severity === "block") ? "deny" : "allow",
    reasons,
    agentsChecked: [...checked],
  };
}
