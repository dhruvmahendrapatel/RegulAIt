/**
 * ADR-0251 — the restriction layer of the one governed decision core, for the call types that are not MCP tool
 * calls (model, connector, A2A). Pure and zero-I/O, like the rest of the kernel: the gateway loads the rule sets,
 * counts the windows and computes the Cedar verdict, and this file decides.
 *
 * It composes onto an ENTITLEMENT decision the resource type's own kernel function already made
 * (`evaluateAgent`, `evaluateConnector`, `evaluateA2a`). The fixed order, the same for every type:
 *
 *   entitlement deny → stays a deny (a restriction never rescues a call, and never manufactures a grant)
 *   attribution mandate → rate limits → ABAC forbid → ABAC require_approval (refuses: no consent binds the policy yet,
 *   ADR-0251 slice 4) → approval rules
 *
 * A call over its limit is refused before it is queued for anyone's sign-off, and an approval only ever turns an
 * allow into a hold: it is consulted strictly after an entitlement allow (AER-017's order on the MCP path).
 */
import type { AbacDecision, ExecutionPosture, RuleScope } from "./index.js";
import { executionGate } from "./index.js";

export type GovernedResourceType = "model" | "connector" | "a2a";

export type GovernedResource =
  | { type: "model"; id: string; name?: string | null; mode: string }
  | { type: "connector"; id: string; name?: string | null; operation: "read" | "write" }
  | { type: "a2a"; id: string; name?: string | null; skillId: string | null };

/** Is this call a write for the kill switch's read-only mode and for `writeOnly` approval rules? A message to a
 * remote agent can make it act, so it counts as a write (the stricter reading); a model call never writes. */
export function resourceIsWrite(r: GovernedResource): boolean {
  if (r.type === "connector") return r.operation === "write";
  return r.type === "a2a";
}

function label(r: GovernedResource): string {
  const name = r.name ? `'${r.name}'` : r.id;
  if (r.type === "connector") return `connector ${name} (${r.operation})`;
  if (r.type === "a2a") return `remote agent ${name}${r.skillId ? ` skill '${r.skillId}'` : ""}`;
  return `model ${name}`;
}

/** A rule's resource binding: `resourceId` null = every resource of the type. */
interface ResourceBound {
  id: string;
  resourceType: GovernedResourceType;
  resourceId: string | null;
}

function binds(rule: ResourceBound, r: GovernedResource): boolean {
  return rule.resourceType === r.type && (rule.resourceId === null || rule.resourceId === r.id);
}

/** Specific before type-wide, then by id: a stable choice of the rule that names the approver. */
function bySpecificity(a: ResourceBound, b: ResourceBound): number {
  const sa = a.resourceId === null ? 1 : 0;
  const sb = b.resourceId === null ? 1 : 0;
  return sa - sb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Pre-filtered by the gateway to the caller's subject scopes (user, role, team, fleet); the kernel re-checks only
 * the resource binding, which is the one dimension it can see. */
export interface ResourceApprovalRule extends ResourceBound {
  scope: RuleScope;
  writeOnly: boolean;
  approverUserId: string;
  approverName?: string | null;
}

/** The approval rules that bind this call, most specific first (the first one names the approver). The gateway uses
 * the same predicate to decide whether a consent binding is needed, so the two can never disagree.
 *
 * ADR-0239 slice 2b: the hand-written predicate. The gateway matches on Cedar (`matchingResourceApprovalRulesWith` with
 * `@regulait/policy-kernel/resource-approval-rule-cedar`); this stays the kernel's default for one release, and the
 * differential test holds Cedar to it. */
export function matchingResourceApprovalRules<R extends ResourceApprovalRule>(resource: GovernedResource, rules: readonly R[]): R[] {
  const write = resourceIsWrite(resource);
  return rules.filter((r) => binds(r, resource) && (!r.writeOnly || write)).sort(bySpecificity);
}

/** ADR-0239 slice 2b — a resource approval-rule engine's answer: the binding rules (any order), or an error (a DENY). */
export type ResourceApprovalRuleVerdict<R extends ResourceApprovalRule = ResourceApprovalRule> =
  | { kind: "matched"; rules: R[] }
  | { kind: "error"; message: string };

/**
 * ADR-0239 slice 2b — the approval-rule MATCH engine for model, connector and A2A calls (Cedar in the gateway). It
 * answers only WHICH rules bind the call, as elements of the array it was given; the specificity order that names the
 * approver stays here, in TypeScript, because Cedar returns an unordered set.
 */
export interface ResourceApprovalRuleEvaluator {
  readonly engine: string;
  matching(rules: readonly ResourceApprovalRule[], resource: GovernedResource): ResourceApprovalRuleVerdict;
}

/**
 * ADR-0239 slice 2b — the match on an injected engine, most specific first. No engine = the hand-written predicate.
 * An engine error, a throw, or an answer that is not a subset of the input is an error verdict, never "nothing
 * matched": the kernel turns it into a deny, and a gateway caller must not read it as "no rule binds this call".
 */
export function matchingResourceApprovalRulesWith<R extends ResourceApprovalRule>(
  evaluator: ResourceApprovalRuleEvaluator | null | undefined,
  resource: GovernedResource,
  rules: readonly R[],
): ResourceApprovalRuleVerdict<R> {
  if (!evaluator || rules.length === 0) return { kind: "matched", rules: matchingResourceApprovalRules(resource, rules) };
  try {
    const v = evaluator.matching(rules, resource);
    if (v.kind === "error") return v;
    const given = new Set<ResourceApprovalRule>(rules);
    if (v.rules.some((r) => !given.has(r))) return { kind: "error", message: "the approval-rule engine answered with a rule it was not given" };
    return { kind: "matched", rules: [...new Set(v.rules as R[])].sort(bySpecificity) };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** `currentCount` = allowed calls already inside the window, counted by the gateway on the database clock. */
export interface ResourceRateLimit extends ResourceBound {
  scope: RuleScope;
  maxCalls: number;
  windowSeconds: number;
  currentCount: number;
}

export interface ResourceRuleTrace {
  rule: string;
  outcome: string;
  grantId?: string;
}

/** The entitlement decision being restricted: any of the three kernel decisions fits this shape. */
export interface EntitlementDecision {
  effect: "allow" | "deny" | "require_approval";
  ruleId: string;
  reason: string;
  ruleChain: readonly ResourceRuleTrace[];
  approverUserId?: string;
}

export interface GovernedResourceDecision {
  effect: "allow" | "deny" | "require_approval";
  ruleId: string;
  reason: string;
  ruleChain: ResourceRuleTrace[];
  approverUserId?: string;
  approverName?: string | null;
  /** the approval rules that matched (for the consent's context digest and the queue's quorum) */
  matchedApprovalRuleIds: string[];
}

export const RESOURCE_RULE_IDS = {
  attribution: "attribution-required",
  rateLimit: "resource-rate-limit",
  abacForbid: "abac-forbid",
  abacApproval: "abac-require-approval",
  approvalRule: "resource-approval-rule",
  /** ADR-0239 slice 2b: the approval-rule engine failed (the same id as the MCP path's) */
  approvalEngineError: "approval-rule-engine-error",
  approvalUnqueueable: "approval-not-queueable",
  coreError: "governed-core-error",
} as const;

export interface ComposeResourceInput {
  resource: GovernedResource;
  base: EntitlementDecision;
  /** pillar 5: the project the call is attributed to; null = unattributed */
  projectId: string | null;
  /** the surface's attribution mandate (on by default; an audited admin relaxation turns it off) */
  attributionRequired: boolean;
  rateLimits?: readonly ResourceRateLimit[];
  approvalRules?: readonly ResourceApprovalRule[];
  /** ADR-0239 slice 2b: the approval-rule match engine; absent = the hand-written predicate (for one release). An
   * engine error or throw DENIES the call (`approval-rule-engine-error`). */
  approvalRuleEvaluator?: ResourceApprovalRuleEvaluator | null;
  /** ADR-0040 verdict for this call; null/undefined = no active policy applies (no rule-chain entry) */
  abacDecision?: AbacDecision | null;
  /** a bound, fresh consent the gateway found for exactly this call */
  approvedApprovalId?: string | null;
  /** can this path queue a per-call approval? false = a required approval refuses (fail closed) */
  canQueue: boolean;
}

/**
 * ADR-0251 — compose the restriction layer onto an entitlement decision. See the file header for the order.
 */
export function composeResourceDecision(input: ComposeResourceInput): GovernedResourceDecision {
  const { resource, base } = input;
  const chain: ResourceRuleTrace[] = [...base.ruleChain];
  const subject = label(resource);
  const out = (d: Omit<GovernedResourceDecision, "ruleChain" | "matchedApprovalRuleIds">, matched: string[] = []): GovernedResourceDecision => ({
    ...d,
    ruleChain: chain,
    matchedApprovalRuleIds: matched,
  });

  if (base.effect === "deny") {
    return out({ effect: "deny", ruleId: base.ruleId, reason: base.reason });
  }

  // 1. attribution mandate (pillar 5)
  if (input.attributionRequired && !input.projectId) {
    chain.push({ rule: "attribution-mandate", outcome: "deny" });
    return out({
      effect: "deny",
      ruleId: RESOURCE_RULE_IDS.attribution,
      reason:
        `${subject} names no project, and this deployment requires every governed call of this type to be ` +
        "attributed to one. Nothing was sent and nothing was billed. Re-send with a projectId you are a member of.",
    });
  }
  chain.push({ rule: "attribution-mandate", outcome: input.projectId ? "allow" : "no-match" });

  // 2. rate limits, tightest window first; the first exhausted one refuses (no summing)
  const limits = (input.rateLimits ?? [])
    .filter((l) => binds(l, resource))
    .sort((a, b) => a.windowSeconds - b.windowSeconds || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const l of limits) {
    if (l.currentCount >= l.maxCalls) {
      chain.push({ rule: RESOURCE_RULE_IDS.rateLimit, outcome: "deny", grantId: l.id });
      return out({
        effect: "deny",
        ruleId: l.id,
        reason: `rate limit reached for ${subject}: ${l.currentCount}/${l.maxCalls} calls in ${l.windowSeconds}s (${l.scope} limit)`,
      });
    }
  }
  if (limits.length) chain.push({ rule: RESOURCE_RULE_IDS.rateLimit, outcome: "allow" });

  // 3. ABAC never grants: forbid refuses, and so does require_approval (below)
  const abac = input.abacDecision ?? null;
  if (abac?.effect === "forbid") {
    chain.push({ rule: RESOURCE_RULE_IDS.abacForbid, outcome: "deny", ...(abac.policyId ? { grantId: abac.policyId } : {}) });
    return out({
      effect: "deny",
      ruleId: abac.policyId ?? RESOURCE_RULE_IDS.abacForbid,
      reason: `${subject} is forbidden by policy ${abac.policyName ? `'${abac.policyName}'` : (abac.policyId ?? "")}${abac.reason ? `: ${abac.reason}` : ""}`,
    });
  }

  //    ADR-0251 slice 4 (review #836): an ABAC `require_approval` REFUSES a model, connector or A2A call (fail
  //    closed). These paths bind consent to approval rules and the execution dial only, so the hold could otherwise be
  //    released by another rule's consent, or queued with no consent bound to the policy version. Here, in the kernel,
  //    so no caller can skip it; the audit chain then says `deny`, never `satisfied-by-approval`.
  const verdict = matchingResourceApprovalRulesWith(input.approvalRuleEvaluator, resource, input.approvalRules ?? []);
  if (verdict.kind === "error") {
    // ADR-0239 slice 2b: an engine failure is a deny, never "no rule binds" (ADR-0180)
    chain.push({ rule: RESOURCE_RULE_IDS.approvalRule, outcome: "deny", grantId: RESOURCE_RULE_IDS.approvalEngineError });
    return out({
      effect: "deny",
      ruleId: RESOURCE_RULE_IDS.approvalEngineError,
      reason: `approval-rule evaluation failed for ${subject}, so the call is refused; nothing was sent: ${verdict.message}`,
    });
  }
  const matched = verdict.rules;
  const matchedIds = matched.map((r) => r.id);
  if (abac?.effect === "require_approval") {
    chain.push({ rule: RESOURCE_RULE_IDS.abacApproval, outcome: "deny", ...(abac.policyId ? { grantId: abac.policyId } : {}) });
    return out(
      {
        effect: "deny",
        ruleId: abac.policyId ?? RESOURCE_RULE_IDS.abacApproval,
        reason:
          `${subject} requires approval under policy ${abac.policyName ? `'${abac.policyName}'` : (abac.policyId ?? "")}, and an ` +
          "ABAC approval hold cannot be queued or released on this call type yet, so it is refused; nothing was sent",
      },
      matchedIds,
    );
  }

  // 4. approval: the entitlement's own hold (the execution dial) and every matching approval rule
  const needsApproval = base.effect === "require_approval" || matched.length > 0;
  if (!needsApproval) {
    return out({ effect: "allow", ruleId: base.ruleId, reason: base.reason });
  }
  for (const r of matched) chain.push({ rule: RESOURCE_RULE_IDS.approvalRule, outcome: "require-approval", grantId: r.id });
  if (input.approvedApprovalId && base.effect !== "require_approval") {
    chain.push({ rule: "approval", outcome: "satisfied-by-approval", grantId: input.approvedApprovalId });
    return out({ effect: "allow", ruleId: base.ruleId, reason: `${base.reason}; released by approval ${input.approvedApprovalId}` }, matchedIds);
  }
  const first = matched[0];
  const approverUserId = base.effect === "require_approval" ? base.approverUserId : first?.approverUserId;
  const approverName = base.effect === "require_approval" ? null : (first?.approverName ?? null);
  const ruleId = base.effect === "require_approval" ? base.ruleId : (first?.id ?? RESOURCE_RULE_IDS.approvalRule);
  const who = approverName ?? approverUserId ?? "a named approver";
  if (!approverUserId) {
    // a hold with no one to sign it can never be released: refuse rather than queue an orphan
    return out({ effect: "deny", ruleId, reason: `${subject} requires approval but no approver is configured; nothing was sent` }, matchedIds);
  }
  if (!input.canQueue) {
    return out(
      {
        effect: "deny",
        ruleId,
        reason:
          `${subject} requires approval from ${who}, and this call type has no per-call approval queue yet, so it is ` +
          "refused rather than sent (ADR-0251). Nothing was sent and nothing was billed.",
      },
      matchedIds,
    );
  }
  return out(
    {
      effect: "require_approval",
      ruleId,
      approverUserId,
      approverName,
      reason: base.effect === "require_approval" ? base.reason : `${subject} requires approval from ${who}; the call is queued, not refused`,
    },
    matchedIds,
  );
}

/** ADR-0251 — the decision a failure inside the core returns: an error is a deny, never an allow. */
export function governedCoreErrorDecision(resource: GovernedResource, err: unknown): GovernedResourceDecision {
  const what = err instanceof Error ? err.name : "error";
  return {
    effect: "deny",
    ruleId: RESOURCE_RULE_IDS.coreError,
    reason: `${label(resource)} was refused because the governance decision could not be completed (${what}); nothing was sent`,
    ruleChain: [{ rule: RESOURCE_RULE_IDS.coreError, outcome: "deny" }],
    matchedApprovalRuleIds: [],
  };
}


/** ADR-0251 slice 3 — a person's grant on a remote agent (`a2a_agent_grants`); `skillId` null = the whole agent. */
export interface A2aGrant {
  id: string;
  userId: string;
  agentId: string;
  skillId: string | null;
}

export interface EvaluateA2aInput {
  userId: string;
  /** ADR-0124 — REQUIRED, as on every other kernel path, so the compiler finds every caller */
  execution: ExecutionPosture;
  agent: { id: string; name?: string | null };
  skillId: string | null;
  grants: readonly A2aGrant[];
  /** §5.1 lead ceiling: the agent ids a worker's lead chain permits; null/undefined = none. Only ever narrows. */
  ceilingAgentIds?: readonly string[] | null;
}

/** the rule ids the A2A route already used, kept so a refusal reads the same before and after ADR-0251 */
export const A2A_KERNEL_RULE_IDS = { leadCeiling: "lead-ceiling", noGrant: "a2a-default-deny" } as const;

/**
 * ADR-0251 slice 3 (review S-05) — the A2A entitlement decision, moved into the kernel so a remote agent call meets
 * the kill switch, the safe modes and the AI literacy gate like every other call type. Order: posture → lead ceiling
 * → the person's grant (default deny). A message to a remote agent is treated as a write (it can make the agent
 * act), and it has no approval queue, so the dial's `require_approval` mode refuses it.
 */
export function evaluateA2a(input: EvaluateA2aInput): EntitlementDecision {
  const subject = label({ type: "a2a", id: input.agent.id, name: input.agent.name ?? null, skillId: input.skillId });
  const gated = executionGate(input.execution, true, subject, false);
  if (gated) {
    return { effect: "deny", ruleId: gated.ruleId, reason: gated.reason, ruleChain: [{ rule: gated.ruleId, outcome: "deny" }] };
  }
  if (input.ceilingAgentIds && !input.ceilingAgentIds.includes(input.agent.id)) {
    return {
      effect: "deny",
      ruleId: A2A_KERNEL_RULE_IDS.leadCeiling,
      reason: "this worker's lead does not allow it to call this agent",
      ruleChain: [{ rule: "a2a-lead-ceiling", outcome: "deny" }],
    };
  }
  const skillId = input.skillId;
  const grant = input.grants.find(
    (g) => g.userId === input.userId && g.agentId === input.agent.id && (skillId === null ? g.skillId === null : g.skillId === null || g.skillId === skillId),
  );
  if (!grant) {
    return {
      effect: "deny",
      ruleId: A2A_KERNEL_RULE_IDS.noGrant,
      reason: skillId === null ? "you have no access to this agent" : `you have no access to this agent's skill '${skillId}'`,
      ruleChain: [{ rule: "a2a-allow-list", outcome: "no-match" }, { rule: "default-deny", outcome: "deny" }],
    };
  }
  return { effect: "allow", ruleId: grant.id, reason: `${subject} allowed by the person's grant`, ruleChain: [{ rule: "a2a-allow-list", outcome: "allow", grantId: grant.id }] };
}
