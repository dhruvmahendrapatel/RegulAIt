/**
 * ADR-0173 §3 — the model allow-list matrix, as the console reads it.
 *
 * Mirrors `packages/shared/src/model-policy.ts` (the SPA does not import the
 * shared package): the feature list, the labels and the VERDICT are the same
 * rules the gateway enforces in its shared model-access decision, so a model
 * the picker marks "Not allowed here" is exactly one the call would refuse
 * `model_not_allowed_for_feature`. The server is the enforcement; this is the
 * explanation shown before anyone clicks.
 *
 * GET /v1/model-policy returns the policy as it applies to the reader: for a
 * non-admin, binding ids are kept only for bindings they hold a grant on, which
 * leaves every verdict about a model they could pick unchanged.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";

export const MODEL_POLICY_FEATURES = [
  "chat",
  "builder",
  "copilot",
  "intake_assist",
  "evals",
  "orchestration",
  "compat",
  "playground",
] as const;
export type ModelPolicyFeature = (typeof MODEL_POLICY_FEATURES)[number];

export const MODEL_POLICY_FEATURE_LABELS: Record<ModelPolicyFeature, string> = {
  chat: "Chat",
  builder: "Agent builder",
  copilot: "Governance copilot",
  intake_assist: "Intake assistant",
  evals: "Evaluations",
  orchestration: "Orchestration",
  compat: "Compatible APIs",
  playground: "Prompt playground",
};

/** one line per feature: where in the product it applies */
export const MODEL_POLICY_FEATURE_HINTS: Record<ModelPolicyFeature, string> = {
  chat: "The Chat page, the Models page's Run, and direct invoke calls.",
  builder: "Agents built in the Agent Builder, their chats and schedules.",
  copilot: "The governance copilot's narration.",
  intake_assist: "Drafting a use-case intake with a model.",
  evals: "Evaluation and red-team runs — the agent under test and the judge.",
  orchestration: "Runs: plan envelopes, workers and goal decomposition.",
  compat: "The OpenAI- and Anthropic-compatible endpoints and their model list.",
  playground: "The Agent Builder's prompt playground: single runs and evaluate-mode rows.",
};

export const MODEL_POLICY_DATA_CLASSES = ["public", "internal", "confidential", "regulated"] as const;
export type ModelPolicyDataClass = (typeof MODEL_POLICY_DATA_CLASSES)[number];

export const MODEL_NOT_ALLOWED_FOR_FEATURE = "model_not_allowed_for_feature";

export interface ModelPolicyRule {
  feature: ModelPolicyFeature;
  dataClass: ModelPolicyDataClass | null;
  restricted: boolean;
  allowedAgentIds: string[];
  allowedProviders: string[];
  defaultAgentId: string | null;
}

export interface ModelPolicyView {
  rules: ModelPolicyRule[];
  /** "organisation" for admins, "you" for everyone else */
  scope?: "organisation" | "you";
  updatedAt?: string | null;
}

export type ModelPolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export function ruleFor(
  policy: ModelPolicyView,
  feature: ModelPolicyFeature,
  dataClass: ModelPolicyDataClass | null,
): ModelPolicyRule | undefined {
  return (policy.rules ?? []).find((r) => r.feature === feature && (r.dataClass ?? null) === dataClass);
}

function admits(rule: ModelPolicyRule | undefined, binding: { id: string; provider: string }): boolean {
  if (!rule || !rule.restricted) return true;
  return rule.allowedAgentIds.includes(binding.id) || rule.allowedProviders.includes(binding.provider);
}

/** the gateway's verdict, mirrored: the base rule, then the data-class rule (which only narrows) */
export function modelPolicyVerdict(
  policy: ModelPolicyView | null | undefined,
  feature: ModelPolicyFeature,
  binding: { id: string; provider: string },
  dataClass?: ModelPolicyDataClass | null,
): ModelPolicyVerdict {
  if (!policy) return { allowed: true };
  const label = MODEL_POLICY_FEATURE_LABELS[feature];
  if (!admits(ruleFor(policy, feature, null), binding)) {
    return { allowed: false, reason: `Your organisation's model policy does not allow this model for ${label}.` };
  }
  if (dataClass && !admits(ruleFor(policy, feature, dataClass), binding)) {
    return {
      allowed: false,
      reason: `Your organisation's model policy does not allow this model for ${label} with ${dataClass} data.`,
    };
  }
  return { allowed: true };
}

/** the feature's default binding id (the data-class rule's when it names one) */
export function modelPolicyDefault(
  policy: ModelPolicyView | null | undefined,
  feature: ModelPolicyFeature,
  dataClass?: ModelPolicyDataClass | null,
): string | null {
  if (!policy) return null;
  const cls = dataClass ? ruleFor(policy, feature, dataClass) : undefined;
  return cls?.defaultAgentId ?? ruleFor(policy, feature, null)?.defaultAgentId ?? null;
}

/** features this binding may be used in (for the portal's "Allowed in" line) */
export function allowedFeatures(
  policy: ModelPolicyView | null | undefined,
  binding: { id: string; provider: string },
): Array<{ feature: ModelPolicyFeature; label: string; allowed: boolean }> {
  return MODEL_POLICY_FEATURES.map((f) => ({
    feature: f,
    label: MODEL_POLICY_FEATURE_LABELS[f],
    allowed: modelPolicyVerdict(policy, f, binding).allowed,
  }));
}

export const MODEL_POLICY_KEY = ["model-policy"] as const;

/** the policy as it applies to the signed-in person; a failed read leaves pickers unconstrained (the server still enforces) */
export function useModelPolicy(enabled = true) {
  return useQuery({
    queryKey: MODEL_POLICY_KEY,
    enabled,
    // a body without a rules array reads as the empty policy, never a crash
    queryFn: async (): Promise<ModelPolicyView> => {
      const r = await api.get<Partial<ModelPolicyView>>("/v1/model-policy");
      return { ...r, rules: Array.isArray(r?.rules) ? r.rules : [] };
    },
    staleTime: 30_000,
  });
}
