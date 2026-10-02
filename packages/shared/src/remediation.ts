/**
 * ADR-0159 — REMEDIATION PROPOSALS for governance-monitor alerts ("Respond").
 *
 * For each alert the planner proposes what would clear it. Two kinds are
 * EXECUTABLE — they change governed state, so they run only after a human
 * other than the proposer approves them on the one approvals queue:
 *
 *   link_control         link a pack control to a risk (ADR-0147)
 *   assign_agent_owner   make an accountable human the owner of an agent (ADR-0089)
 *
 * Every other kind is GUIDANCE: the steps a person takes (assess a vendor,
 * obtain a model-card sign-off, review a halt). The platform does not pretend
 * it can do those for you — a vendor assessment executed by a timer is not an
 * assessment.
 *
 * Pure and deterministic: the same alert and context always produce the same
 * candidates in the same order. No model is called; nothing is "agentic"
 * except that the plan is computed rather than typed.
 */
import { CATEGORY_SUGGESTED_CONTROLS } from "./intake-assist.js";
import type { AiRiskCategory } from "./risks.js";

export const EXECUTABLE_REMEDIATION_KINDS = ["link_control", "assign_agent_owner"] as const;
export const GUIDANCE_REMEDIATION_KINDS = [
  "mitigate_source_risk",
  "review_halted_agent",
  "assess_vendor",
  "obtain_model_card_approval",
  "close_coverage_gap",
  "author_control",
] as const;
export const REMEDIATION_KINDS = [...EXECUTABLE_REMEDIATION_KINDS, ...GUIDANCE_REMEDIATION_KINDS] as const;
export type RemediationKind = (typeof REMEDIATION_KINDS)[number];
export type ExecutableRemediationKind = (typeof EXECUTABLE_REMEDIATION_KINDS)[number];

export const REMEDIATION_STATUSES = ["pending_approval", "applied", "denied", "failed"] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export function isExecutableRemediation(kind: string): kind is ExecutableRemediationKind {
  return (EXECUTABLE_REMEDIATION_KINDS as readonly string[]).includes(kind);
}

export interface RemediationCandidate {
  kind: RemediationKind;
  executable: boolean;
  title: string;
  rationale: string;
  /** executable kinds: exactly the parameters the applier needs */
  params: Record<string, string>;
  /** guidance kinds: what a person does, in order */
  steps: string[];
}

export interface RemediationRiskInput {
  id: string;
  title: string;
  category: AiRiskCategory;
  linkedControls: string[];
}

export interface RemediationContext {
  alert: { ruleId: string; subjectKey: string; detail: Record<string, unknown> };
  /** risks the alert can refer to (its subject risk, its source risk) */
  risks: ReadonlyMap<string, RemediationRiskInput>;
  /** controlRef → title, for controls in an ACTIVE pack */
  activeControls: ReadonlyMap<string, string>;
  /** for pair-keyed alerts: the use case's owner, when active */
  useCaseOwner?: { id: string; name: string } | null;
  /** labels for subjects (agent / vendor / use case names) */
  labels?: ReadonlyMap<string, string>;
  maxControlCandidates?: number;
}

const split = (subjectKey: string) => {
  const parts = subjectKey.split(">");
  const tail = parts[parts.length - 1]!;
  const idx = tail.indexOf(":");
  return { context: parts.length > 1 ? parts[0]! : null, type: tail.slice(0, idx), id: tail.slice(idx + 1), tail };
};

function controlCandidates(risk: RemediationRiskInput, ctx: RemediationContext, why: string): RemediationCandidate[] {
  const linked = new Set(risk.linkedControls);
  const refs = (CATEGORY_SUGGESTED_CONTROLS[risk.category] ?? [])
    .filter((ref) => ctx.activeControls.has(ref) && !linked.has(ref))
    .slice(0, ctx.maxControlCandidates ?? 3);
  if (refs.length === 0) {
    return [
      {
        kind: "author_control",
        executable: false,
        title: `Activate or author a control for "${risk.title}"`,
        rationale:
          `${why} None of the controls suggested for ${risk.category.replace(/_/g, " ")} is in an active pack ` +
          "(or all are already linked).",
        params: { riskId: risk.id },
        steps: [
          "Activate a pack that covers this category, or author a custom control (ADR-0058).",
          "Link it to the risk, then declare the residual position.",
        ],
      },
    ];
  }
  return refs.map((ref) => ({
    kind: "link_control" as const,
    executable: true,
    title: `Link ${ref} to "${risk.title}"`,
    rationale: `${why} ${ctx.activeControls.get(ref)} is suggested for ${risk.category.replace(/_/g, " ")} risks and is in an active pack.`,
    params: { riskId: risk.id, controlRef: ref },
    steps: [],
  }));
}

export function proposeRemediations(ctx: RemediationContext): RemediationCandidate[] {
  const { alert } = ctx;
  const s = split(alert.subjectKey);
  const label = (k: string) => ctx.labels?.get(k) ?? k;

  switch (alert.ruleId) {
    case "high_risk_without_control": {
      const risk = ctx.risks.get(s.id);
      return risk ? controlCandidates(risk, ctx, "A live high risk with no mitigating control.") : [];
    }
    case "use_case_inherited_high_risk": {
      const sourceRiskId = alert.detail.sourceRiskId as string | undefined;
      const risk = sourceRiskId ? ctx.risks.get(sourceRiskId) : undefined;
      if (!risk) return [];
      const out = risk.linkedControls.length === 0 ? controlCandidates(risk, ctx, "The source risk has no control.") : [];
      out.push({
        kind: "mitigate_source_risk",
        executable: false,
        title: `Re-assess "${risk.title}" at its source`,
        rationale:
          `The rating comes from ${label(String(alert.detail.sourceNodeKey ?? ""))}. Mitigating it there lowers every ` +
          "use case that depends on it.",
        params: { riskId: risk.id },
        steps: [
          "Confirm the linked controls are operating.",
          "Declare the residual likelihood and impact (PUT /v1/risks/:id/residual).",
          "If the risk is carried knowingly, accept it with a note; if it no longer applies, close it with a reason.",
        ],
      });
      return out;
    }
    case "use_case_agent_unowned": {
      if (!ctx.useCaseOwner) {
        return [
          {
            kind: "assign_agent_owner",
            executable: false,
            title: `Name an accountable owner for ${label(s.tail)}`,
            rationale: "No active owner of the use case is available to propose.",
            params: { agentId: s.id },
            steps: ["Choose an accountable human and set them as the agent's owner."],
          },
        ];
      }
      return [
        {
          kind: "assign_agent_owner",
          executable: true,
          title: `Make ${ctx.useCaseOwner.name} the owner of ${label(s.tail)}`,
          rationale: `${ctx.useCaseOwner.name} owns ${label(s.context ?? "")}, which runs this agent in production.`,
          params: { agentId: s.id, ownerUserId: ctx.useCaseOwner.id },
          steps: [],
        },
      ];
    }
    case "use_case_agent_halted":
      return [
        {
          kind: "review_halted_agent",
          executable: false,
          title: `Decide on ${label(s.tail)}: lift the halt or replace the agent`,
          rationale: `${label(s.context ?? "")} is approved but cannot run as approved while this agent is out of service.`,
          params: { agentId: s.id },
          steps: [
            "Read the halt reason and the incident record.",
            "Either lift the halt once resolved, or amend the use case to a replacement agent and re-approve.",
          ],
        },
      ];
    case "use_case_vendor_unapproved":
      return [
        {
          kind: "assess_vendor",
          executable: false,
          title: `Complete the assessment of ${label(s.tail)}`,
          rationale: `${label(s.context ?? "")} depends on this vendor, which is not approved.`,
          params: { vendorId: s.id },
          steps: [
            "Advance the vendor's assessment workflow and collect its pack attestations.",
            "If it cannot be approved, move the use case to an approved vendor's model.",
          ],
        },
      ];
    case "use_case_agent_no_approved_model_card":
      return [
        {
          kind: "obtain_model_card_approval",
          executable: false,
          title: `Obtain a model-card sign-off for ${label(s.tail)}`,
          rationale: "The MRM gate refuses this agent when enforced (ADR-0045).",
          params: { agentId: s.id },
          steps: [
            "Create or update the agent's model card (intended use, limitations, bias assessment).",
            "Request sign-off from a model-risk approver; it lands on the approvals queue.",
          ],
        },
      ];
    case "dimension_coverage_below_floor":
      return [
        {
          kind: "close_coverage_gap",
          executable: false,
          title: `Raise ${String(alert.detail.dimension)} evidence coverage`,
          rationale: `${String(alert.detail.controlsEvidenced)}/${String(alert.detail.controlsApplicable)} controls evidenced.`,
          params: { dimension: String(alert.detail.dimension) },
          steps: [
            "Open the trust dashboard drill-down for this dimension to see unevidenced controls.",
            "Turn on the collectors' sources, or record attestations where a control is organisational.",
          ],
        },
      ];
    default:
      return [];
  }
}
