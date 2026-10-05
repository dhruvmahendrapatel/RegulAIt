/**
 * ADR-0173 §3 — the model allow-list matrix: which governed model bindings each
 * FEATURE may use, with a default per feature and optional per-data-class rules.
 *
 * One rule per (feature, data class). A rule with `dataClass: null` is the
 * feature's base rule; a rule with a data class applies only when the calling
 * surface knows the data class of what it sends. Both rules must admit a
 * binding: a data-class rule can only NARROW its feature, never widen it,
 * because the data class is sometimes derived from what the person declared
 * (the intake answers) and a declaration must not unlock a model.
 *
 * Empty policy = today's behaviour: a feature with no rule (or a rule with
 * `restricted: false`) allows every binding the person is entitled to. The
 * policy only ever SUBTRACTS from entitlement; it never grants anything.
 *
 * The verdict is a pure function so the gateway (enforcement, inside the shared
 * model-access decision) and the console (the picker's "Not allowed here")
 * compute the same answer. The SPA mirrors it in
 * apps/web/src/views/models/modelPolicy.ts.
 */
import { z } from "zod";

export const MODEL_POLICY_FEATURES = [
  "chat",
  "builder",
  "copilot",
  "intake_assist",
  "evals",
  "orchestration",
  "compat",
  // ADR-0173 batch 2b: the prompt playground ("policy sandbox")
  "playground",
] as const;
export type ModelPolicyFeature = (typeof MODEL_POLICY_FEATURES)[number];

/** what people read; the console mirrors these labels */
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

/** the use-case data classes (AI_USE_CASE_DATA_SENSITIVITIES), restated to keep this module dependency-free */
export const MODEL_POLICY_DATA_CLASSES = ["public", "internal", "confidential", "regulated"] as const;
export type ModelPolicyDataClass = (typeof MODEL_POLICY_DATA_CLASSES)[number];

/** the named refusal, used as the decision's ruleId, the HTTP error code and the audit rule */
export const MODEL_NOT_ALLOWED_FOR_FEATURE = "model_not_allowed_for_feature" as const;

/** caps: a matrix, not a data store */
export const MODEL_POLICY_LIMITS = { bindingsPerRule: 500, providersPerRule: 50 } as const;

export const modelPolicyRuleSchema = z
  .object({
    feature: z.enum(MODEL_POLICY_FEATURES),
    dataClass: z.enum(MODEL_POLICY_DATA_CLASSES).nullable().default(null),
    /** false = this rule only carries a default; every entitled binding is allowed */
    restricted: z.boolean().default(true),
    allowedAgentIds: z.array(z.string().uuid()).max(MODEL_POLICY_LIMITS.bindingsPerRule).default([]),
    /** every binding of these provider kinds ("anthropic", "mock", …) */
    allowedProviders: z
      .array(z.string().trim().min(1).max(64))
      .max(MODEL_POLICY_LIMITS.providersPerRule)
      .default([]),
    defaultAgentId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type ModelPolicyRule = z.infer<typeof modelPolicyRuleSchema>;

/** PUT /v1/model-policy — the WHOLE policy, replacing what is stored */
export const modelPolicyPutSchema = z
  .object({
    rules: z.array(modelPolicyRuleSchema).max(MODEL_POLICY_FEATURES.length * (MODEL_POLICY_DATA_CLASSES.length + 1)),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.rules.forEach((r, i) => {
      const key = `${r.feature}:${r.dataClass ?? "*"}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", i],
          message: `duplicate rule for ${r.feature}${r.dataClass ? ` / ${r.dataClass}` : ""}`,
        });
      }
      seen.add(key);
    });
  });
export type ModelPolicyPut = z.infer<typeof modelPolicyPutSchema>;

/** the stored policy, as both sides read it */
export interface ModelPolicy {
  rules: ModelPolicyRule[];
}

/** the binding facts the verdict reads */
export interface ModelPolicyBinding {
  id: string;
  provider: string;
}

export type ModelPolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; dataClass: ModelPolicyDataClass | null };

export function modelPolicyRuleFor(
  policy: ModelPolicy,
  feature: ModelPolicyFeature,
  dataClass: ModelPolicyDataClass | null,
): ModelPolicyRule | undefined {
  return policy.rules.find((r) => r.feature === feature && (r.dataClass ?? null) === dataClass);
}

function admits(rule: ModelPolicyRule | undefined, binding: ModelPolicyBinding): boolean {
  if (!rule || !rule.restricted) return true;
  return rule.allowedAgentIds.includes(binding.id) || rule.allowedProviders.includes(binding.provider);
}

/**
 * May this binding be used by this feature (for data of this class)? Pure.
 * `dataClass` absent/null = the surface does not know it, so only the
 * feature's base rule applies.
 */
export function modelPolicyVerdict(
  policy: ModelPolicy,
  feature: ModelPolicyFeature,
  binding: ModelPolicyBinding,
  dataClass?: ModelPolicyDataClass | null,
): ModelPolicyVerdict {
  const label = MODEL_POLICY_FEATURE_LABELS[feature];
  if (!admits(modelPolicyRuleFor(policy, feature, null), binding)) {
    return {
      allowed: false,
      dataClass: null,
      reason: `the organisation's model policy does not allow this model for ${label}`,
    };
  }
  if (dataClass && !admits(modelPolicyRuleFor(policy, feature, dataClass), binding)) {
    return {
      allowed: false,
      dataClass,
      reason: `the organisation's model policy does not allow this model for ${label} with ${dataClass} data`,
    };
  }
  return { allowed: true };
}

/**
 * The feature's default binding id: the data-class rule's default when the
 * class is known and it names one, else the base rule's. The caller must still
 * check the default is allowed AND entitled for the person — a default is a
 * preference, never a grant.
 */
export function modelPolicyDefault(
  policy: ModelPolicy,
  feature: ModelPolicyFeature,
  dataClass?: ModelPolicyDataClass | null,
): string | null {
  const cls = dataClass ? modelPolicyRuleFor(policy, feature, dataClass) : undefined;
  return cls?.defaultAgentId ?? modelPolicyRuleFor(policy, feature, null)?.defaultAgentId ?? null;
}
