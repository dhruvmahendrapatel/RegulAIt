/**
 * ADR-0173 §3 — the model allow-list matrix: storage, the read/replace routes,
 * and the ONE helper the shared model-access decision applies.
 *
 *   GET /v1/model-policy   any signed-in person: the policy as it applies to
 *                          them (non-admins see binding ids only for bindings
 *                          they hold a grant on — enough for every verdict
 *                          about a model they could pick, nothing more)
 *   PUT /v1/model-policy   admin: replace the whole policy, audited
 *
 * WHERE IT IS ENFORCED. Not in each surface. `withModelPolicy` below runs after
 * the policy kernel's `evaluateAgent` has ALLOWED, inside the shared decision
 * (copilot.ts `agentDecision`, which takes a `feature`), and inside the
 * per-surface deciders that pre-load the same kernel inputs (the invoke path,
 * the compat shims, evals, orchestration) — each of those passes its feature to
 * this one function rather than re-implementing it. The dispatch core applies
 * it once more to the SERVED binding when a caller names its feature
 * (`GovernedDispatchArgs.modelFeature`), which is what stops a routing choice
 * or a fallback hop from reaching a model the matrix forbids — the same shape
 * as the virtual-key allow-list.
 *
 * It can only SUBTRACT: there is no branch that turns a deny into an allow.
 */
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  eq,
  inArray,
  modelPolicyRules,
  type Db,
} from "@regulait/db";
import {
  MODEL_NOT_ALLOWED_FOR_FEATURE,
  MODEL_POLICY_DATA_CLASSES,
  MODEL_POLICY_FEATURE_LABELS,
  MODEL_POLICY_FEATURES,
  modelPolicyPutSchema,
  modelPolicyRuleFor,
  modelPolicyVerdict,
  type ModelPolicy,
  type ModelPolicyDataClass,
  type ModelPolicyFeature,
  type ModelPolicyRule,
} from "@regulait/shared";
import type { AgentDecision } from "@regulait/policy-kernel";
import { loadRoleAgentGrants } from "./entitlements.js";

export { MODEL_NOT_ALLOWED_FOR_FEATURE };

/** which feature (and, where the surface knows it, which data class) a decision is for */
export interface ModelPolicyGate {
  feature: ModelPolicyFeature;
  dataClass?: ModelPolicyDataClass | null | undefined;
}

export const MODEL_POLICY_RULE_IDS = {
  set: "model-policy-set",
  refused: MODEL_NOT_ALLOWED_FOR_FEATURE,
} as const;

/** the stored policy (an empty one when no admin has written any) */
export async function loadModelPolicy(db: Pick<Db, "select">): Promise<ModelPolicy> {
  const rows = await db.select().from(modelPolicyRules);
  return {
    rules: rows
      .map((r) => ({
        feature: r.feature,
        dataClass: r.dataClass ?? null,
        restricted: r.restricted,
        allowedAgentIds: [...(r.allowedAgentIds ?? [])],
        allowedProviders: [...(r.allowedProviders ?? [])],
        defaultAgentId: r.defaultAgentId ?? null,
      }))
      .sort(ruleOrder),
  };
}

function ruleOrder(a: ModelPolicyRule, b: ModelPolicyRule): number {
  const f = MODEL_POLICY_FEATURES.indexOf(a.feature) - MODEL_POLICY_FEATURES.indexOf(b.feature);
  if (f !== 0) return f;
  const ci = (c: ModelPolicyDataClass | null) => (c === null ? -1 : MODEL_POLICY_DATA_CLASSES.indexOf(c));
  return ci(a.dataClass) - ci(b.dataClass);
}

/**
 * THE helper. A kernel decision in, the same decision out unless it was an
 * allow the matrix forbids — then a deny named `model_not_allowed_for_feature`
 * with the kernel's rule chain kept and the policy step appended. `gate`
 * absent = a caller that does not represent a feature (a visibility lookup),
 * which the matrix does not touch.
 */
export function withModelPolicy(
  decision: AgentDecision,
  policy: ModelPolicy,
  gate: ModelPolicyGate | undefined,
  agent: { id: string; provider: string; name?: string | null },
): AgentDecision {
  if (!gate || decision.effect !== "allow") return decision;
  const verdict = modelPolicyVerdict(policy, gate.feature, agent, gate.dataClass ?? null);
  if (verdict.allowed) return decision;
  return {
    effect: "deny",
    ruleId: MODEL_NOT_ALLOWED_FOR_FEATURE,
    ruleChain: [...decision.ruleChain, { rule: "model-feature-policy", outcome: "deny" }],
    reason: `${agent.name ? `model '${agent.name}': ` : ""}${verdict.reason}`,
  };
}

/** the refusal the dispatch core returns for a served binding the matrix forbids; null = allowed */
export function modelPolicyDispatchRefusal(
  policy: ModelPolicy,
  gate: ModelPolicyGate,
  agent: { id: string; provider: string; name: string },
): { status: 403; error: typeof MODEL_NOT_ALLOWED_FOR_FEATURE; ruleId: typeof MODEL_NOT_ALLOWED_FOR_FEATURE; detail: string } | null {
  const verdict = modelPolicyVerdict(policy, gate.feature, agent, gate.dataClass ?? null);
  if (verdict.allowed) return null;
  return {
    status: 403,
    error: MODEL_NOT_ALLOWED_FOR_FEATURE,
    ruleId: MODEL_NOT_ALLOWED_FOR_FEATURE,
    detail: `model '${agent.name}': ${verdict.reason}`,
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function canonical(policy: ModelPolicy): string {
  return JSON.stringify(
    [...policy.rules].sort(ruleOrder).map((r) => ({
      ...r,
      allowedAgentIds: [...new Set(r.allowedAgentIds)].sort(),
      allowedProviders: [...new Set(r.allowedProviders)].sort(),
    })),
  );
}

export function registerModelPolicyRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/model-policy", async (req) => {
    const policy = await loadModelPolicy(db);
    const [latest] = await db
      .select({ updatedAt: modelPolicyRules.updatedAt, updatedBy: modelPolicyRules.updatedBy })
      .from(modelPolicyRules)
      .limit(1);
    const base = {
      features: MODEL_POLICY_FEATURES.map((f) => ({ id: f, label: MODEL_POLICY_FEATURE_LABELS[f] })),
      dataClasses: MODEL_POLICY_DATA_CLASSES,
      updatedAt: latest?.updatedAt ?? null,
    };
    if (req.authCtx.isAdmin) return { ...base, scope: "organisation", updatedBy: latest?.updatedBy ?? null, ...policy };
    // A person reads the policy AS IT APPLIES TO THEM: the verdict for any
    // binding they hold a grant on is unchanged, and the ids of bindings they
    // cannot use are not handed out.
    const userId = req.authCtx.userId;
    const held = new Set<string>();
    if (userId) {
      const [direct, role] = await Promise.all([
        db.select({ agentId: agentGrants.agentId }).from(agentGrants).where(eq(agentGrants.userId, userId)),
        loadRoleAgentGrants(db, userId),
      ]);
      for (const g of direct) held.add(g.agentId);
      for (const g of role) held.add(g.agentId);
    }
    return {
      ...base,
      scope: "you",
      rules: policy.rules.map((r) => ({
        ...r,
        allowedAgentIds: r.allowedAgentIds.filter((id) => held.has(id)),
        defaultAgentId: r.defaultAgentId && held.has(r.defaultAgentId) ? r.defaultAgentId : null,
      })),
    };
  });

  app.put("/v1/model-policy", async (req, reply) => {
    const parsed = modelPolicyPutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({ error: "invalid_model_policy", issues: parsed.error.issues });
    }
    const next: ModelPolicy = {
      rules: parsed.data.rules.map((r) => ({
        ...r,
        allowedAgentIds: [...new Set(r.allowedAgentIds)],
        allowedProviders: [...new Set(r.allowedProviders)],
      })),
    };

    // every named binding must exist — a typo must not silently allow nothing
    const named = [
      ...new Set(next.rules.flatMap((r) => [...r.allowedAgentIds, ...(r.defaultAgentId ? [r.defaultAgentId] : [])])),
    ];
    const found = named.length
      ? await db.select({ id: agents.id, provider: agents.provider }).from(agents).where(inArray(agents.id, named))
      : [];
    const providerOf = new Map(found.map((a) => [a.id, a.provider]));
    const missing = named.filter((id) => !providerOf.has(id));
    if (missing.length) {
      return reply.status(422).send({ error: "unknown_model_binding", detail: `no model binding with id ${missing.join(", ")}`, ids: missing });
    }
    // a default must be usable under the rules it is the default of
    for (const r of next.rules) {
      if (!r.defaultAgentId) continue;
      const binding = { id: r.defaultAgentId, provider: providerOf.get(r.defaultAgentId)! };
      const verdict = modelPolicyVerdict(next, r.feature, binding, r.dataClass);
      if (!verdict.allowed) {
        return reply.status(422).send({
          error: "default_not_allowed",
          detail: `the default for ${MODEL_POLICY_FEATURE_LABELS[r.feature]}${r.dataClass ? ` (${r.dataClass} data)` : ""} is not allowed by the policy itself: ${verdict.reason}`,
          feature: r.feature,
          dataClass: r.dataClass,
        });
      }
    }

    const before = await loadModelPolicy(db);
    if (canonical(before) === canonical(next)) {
      // an idempotent write changes nothing and records nothing
      return { changed: false, ...before };
    }
    const actor = req.authCtx.userId;
    await db.transaction(async (tx) => {
      await tx.delete(modelPolicyRules);
      if (next.rules.length) {
        await tx.insert(modelPolicyRules).values(
          next.rules.map((r) => ({
            feature: r.feature,
            dataClass: r.dataClass,
            restricted: r.restricted,
            allowedAgentIds: r.allowedAgentIds,
            allowedProviders: r.allowedProviders,
            defaultAgentId: r.defaultAgentId,
            updatedBy: actor ?? null,
          })),
        );
      }
      const restrictedFeatures = MODEL_POLICY_FEATURES.filter((f) => modelPolicyRuleFor(next, f, null)?.restricted);
      await tx.insert(auditLog).values({
        userId: actor ?? ZERO_UUID,
        objectType: "model_policy",
        objectId: null,
        effect: "allow",
        ruleId: MODEL_POLICY_RULE_IDS.set,
        ruleChain: [],
        reason:
          `replaced the model allow-list matrix (${next.rules.length} rule${next.rules.length === 1 ? "" : "s"}; ` +
          `restricted features: ${restrictedFeatures.length ? restrictedFeatures.join(", ") : "none"})`,
        detail: { before: before.rules, after: next.rules },
      });
    });
    return { changed: true, ...(await loadModelPolicy(db)) };
  });
}
