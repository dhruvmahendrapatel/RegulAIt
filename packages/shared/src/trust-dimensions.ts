/**
 * ADR-0148 — WHICH TRUST DIMENSION A COMPLIANCE CONTROL SPEAKS TO.
 *
 * The trust dashboard's radar plots, per dimension, the share of applicable
 * pack controls that currently have evidence or a live attestation — the same
 * "coverage, not compliance" number the posture report calls `evidencedPct`
 * (ADR-0082), sliced by dimension. That needs every control to land on exactly
 * one dimension, decided HERE, in code, so the classification is reviewable
 * and testable rather than inferred in a SQL query or a React component.
 *
 * The rule, in order:
 *  1. an explicit per-control entry (`CONTROL_DIMENSION_OVERRIDES`) — needed
 *     for attestation-only controls, whose collector (`none`) says nothing
 *     about their subject, and for any control whose evidence source would
 *     misfile it;
 *  2. otherwise the evidence COLLECTOR and its params — what the control is
 *     actually evidenced by is the most honest statement of what it covers;
 *  3. otherwise `compliance`, the governance catch-all.
 *
 * A dimension with no applicable control is reported as UNMEASURED by the
 * gateway — never as 0% and never as 100%.
 */
import type { TrustDimension } from "./risks.js";

export const CONTROL_DIMENSION_OVERRIDES: Readonly<Record<string, TrustDimension>> = {
  // EU AI Act — attestation-only
  "eu-ai-act:art-72-post-market-monitoring": "reliability",
  "eu-ai-act:art-4-ai-literacy": "compliance",
  // NIST AI RMF — GOVERN 4.1 is the "safety-first mindset" practice
  "nist-ai-rmf:GOVERN-4.1": "safety",
  // ISO/IEC 27001
  "iso-27001:6.1.3": "security",
  "iso-27001:9.2": "compliance",
  // ISO/IEC 42001
  "iso-42001:5.3-roles-responsibilities": "compliance",
  // HIPAA
  "hipaa:164.308(a)(1)-security-management": "security",
  "hipaa:baa": "privacy",
  // PCI DSS
  "pci-dss:12.1-security-policy": "security",
  // FINRA
  "finra:3110-written-supervisory-procedures": "compliance",
  // SOC 2
  "soc-2:CC7.4-incident-response": "security",
  "soc-2:CC9.2-vendor-risk": "compliance",
  "soc-2:CC1.4-competence": "compliance",
};

export interface ControlForDimension {
  controlRef: string;
  collector: string;
  collectorParams?: Record<string, unknown> | null;
}

export function dimensionForControl(c: ControlForDimension): TrustDimension {
  const override = CONTROL_DIMENSION_OVERRIDES[c.controlRef];
  if (override) return override;
  const p = (c.collectorParams ?? {}) as Record<string, unknown>;
  switch (c.collector) {
    case "guardrail_configs": {
      const detector = typeof p.detector === "string" ? p.detector : "prompt_injection";
      if (detector === "semantic_dlp" || detector === "pii") return "privacy";
      if (detector === "toxicity" || detector === "jailbreak") return "safety";
      return "security";
    }
    case "compliance_profile_cascade":
      return p.cascadeAspect === "pii_block" ? "privacy" : "compliance";
    case "abac_policies_active":
      return "security";
    case "audit_decisions":
      // a DENIAL trail, a user-lifecycle trail or an egress trail evidences
      // access control; a plain decision log evidences record-keeping
      if (p.effect === "deny" || p.objectType === "user") return "security";
      if (typeof p.ruleIdPrefix === "string" && p.ruleIdPrefix.startsWith("egress")) return "security";
      return "compliance";
    case "eval_runs":
      return "reliability";
    case "model_card_fairness":
      return "bias";
    case "approvals":
    case "model_cards_approved":
    case "lineage_edges":
    case "attributed_usage":
    case "none":
    default:
      return "compliance";
  }
}
