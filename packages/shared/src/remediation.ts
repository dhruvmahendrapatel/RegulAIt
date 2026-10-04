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
  "tighten_output_guardrail",
  "contain_routing",
  // ADR-0175 A4 / A9
  "review_served_model",
  "register_use_case",
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
  /** guidance kinds that start in an existing screen: the in-app path that
   * opens it, prefilled where the alert allows (ADR-0175 A9) */
  href?: string;
}

/** ADR-0175 A9 — the existing register flow, prefilled from an alert */
export const USE_CASE_REGISTER_PATH = "/admin/governance/intake";

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
          "Declare the residual likelihood and impact on the risk (use case → Risks tab).",
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
    case "agent_output_leakage": {
      const detectors = Object.keys((alert.detail.byDetector as Record<string, number>) ?? {}).sort();
      return [
        {
          kind: "tighten_output_guardrail",
          executable: false,
          title: `Set ${detectors.join(", ") || "the flagged detectors"} to block on output for ${label(s.tail)}`,
          rationale:
            "The inline guardrails let this content through — usually because the detector is set to log or warn. " +
            "Blocking is a guardrail policy change (ADR-0042), made deliberately by a person.",
          params: { agentId: s.id },
          steps: [
            "Open the agent's guardrail policy and set the flagged detectors to block for the output phase.",
            "Review the flagged traces (counts on the alert; open them in Traces) and decide whether disclosure occurred.",
            "Re-run trace evaluation; the alert resolves when a window passes with no flagged output.",
          ],
        },
      ];
    }
    case "use_case_served_outside_stack":
      return [
        {
          kind: "contain_routing",
          executable: false,
          title: `Keep ${label(s.context ?? "")} on its approved stack, or approve ${label(s.tail)} for it`,
          rationale:
            "The use case was approved for a named set of agents; routing served its traffic from another. Either " +
            "the routing policy changes or the approval does — both are deliberate decisions, not a monitor's.",
          params: { agentId: s.id },
          steps: [
            "Open the routing decisions for the requested agent(s) named on the alert and confirm which rule moved the calls.",
            "Either pin the use case's traffic (callers send costSensitivity: quality-sensitive, or the routing rule excludes it), " +
              "or amend the use case to include the serving agent and send it back through review.",
            "The alert resolves once a window passes with no off-stack dispatches.",
          ],
        },
      ];
    case "served_model_drift": {
      const pins = Array.isArray(alert.detail.pinnedModelVersions) ? (alert.detail.pinnedModelVersions as unknown[]).map(String) : [];
      const obs = Array.isArray(alert.detail.observations)
        ? (alert.detail.observations as Array<{ servedModel?: unknown }>).map((o) => String(o.servedModel ?? ""))
        : [];
      const served = [...new Set(obs.filter(Boolean))].join(", ") || "another model";
      return [
        {
          kind: "review_served_model",
          executable: false,
          title: `Confirm why ${label(s.tail)} was served ${served}`,
          rationale:
            (pins.length
              ? `The approved model card pins ${pins.join(", ")}; the provider reported serving something else. `
              : "The provider reported serving a different model than the agent is configured for. ") +
            "The model-card review covered the model the reviewers saw; a change underneath it is a decision for a person.",
          params: { agentId: s.id },
          steps: [
            "Compare the served and configured ids on the alert, and check the provider's notice of the alias or deployment change.",
            "If the change is unwanted, configure the agent with an exact dated id so the provider cannot move it.",
            "If it is acceptable, re-review the model card (and update its pinned version) so the approval covers what serves.",
            "The alert resolves once a window passes with every served model matching.",
          ],
        },
      ];
    }
    case "unregistered_ai_traffic": {
      const d = alert.detail;
      const kind = String(d.subjectType ?? s.type);
      const name = String(d.subjectLabel ?? label(s.tail));
      const window = Number(d.windowDays ?? 0);
      const volume = [
        Number(d.modelCalls ?? 0) ? `${Number(d.modelCalls)} model calls` : null,
        Number(d.mcpCalls ?? 0) ? `${Number(d.mcpCalls)} MCP tool calls` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      const where =
        kind === "project"
          ? `project ${name}, which no approved use case links`
          : kind === "virtual_key"
            ? `virtual key ${name}, with no project`
            : `${name}, with no project and no virtual key`;
      const title = kind === "project" ? `AI use in project ${name}` : kind === "virtual_key" ? `AI use through virtual key ${name}` : `AI use by ${name}`;
      const description =
        `Observed by the governance monitor: ${volume || "AI traffic"}${window ? ` in ${window} days` : ""} attributed to ${where}. ` +
        (kind === "project"
          ? `Once approved, link this use case to project ${name} so its traffic is covered.`
          : "Once approved, link this use case to the project the traffic belongs to, and send the traffic with that project.");
      const q = new URLSearchParams({ source: "monitor", title, description });
      const pending = Array.isArray(d.linkedUseCasesNotApproved) ? (d.linkedUseCasesNotApproved as Array<{ name?: unknown; status?: unknown }>) : [];
      return [
        {
          kind: "register_use_case",
          executable: false,
          title: `Register ${kind === "project" ? `project ${name}'s` : `${name}'s`} AI use as a use case`,
          rationale:
            `${volume || "AI traffic"} ran outside every approved use case. ` +
            (pending.length
              ? `${pending.map((u) => `${String(u.name)} (${String(u.status).replace(/_/g, " ")})`).join(", ")} already links this project but is not approved. `
              : "") +
            "Registering it puts the traffic in the register and through review; nothing is blocked meanwhile.",
          params: kind === "project" ? { projectId: s.id } : kind === "virtual_key" ? { virtualKeyId: s.id } : { userId: s.id },
          steps: [
            "Open the register flow (prefilled from this alert) and describe what the traffic is for.",
            kind === "project"
              ? `After it is created, set its project to ${name}, then send it for review.`
              : "After it is created, link it to the project the traffic belongs to, and have callers send that project with their calls.",
            "The alert resolves once a window passes with the traffic under an approved use case.",
          ],
          href: `${USE_CASE_REGISTER_PATH}?${q.toString()}`,
        },
      ];
    }
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
