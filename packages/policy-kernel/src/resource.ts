/**
 * ADR-0251 — the restriction layer of the one governed decision core, for the call types that are not MCP tool
 * calls (model, connector, A2A). Pure and zero-I/O, like the rest of the kernel: the gateway loads the rule sets,
 * counts the windows and computes the Cedar verdict, and this file decides.
 *
 * It composes onto an ENTITLEMENT decision the resource type's own kernel function already made
 * (`evaluateAgent`, `evaluateConnector`, `evaluateA2a`). The fixed order, the same for every type:
 *
 *   entitlement deny → stays a deny (a restriction never rescues a call, and never manufactures a grant)
 *   attribution mandate → rate limits → ABAC forbid → approval (ABAC require_approval, then approval rules)
 *
 * A call over its limit is refused before it is queued for anyone's sign-off, and an approval only ever turns an
 * allow into a hold: it is consulted strictly after an entitlement allow (AER-017's order on the MCP path).
 */
import type { AbacDecision, RuleScope } from "./index.js";

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
 * the same predicate to decide whether a consent binding is needed, so the two can never disagree. */
export function matchingResourceApprovalRules<R extends ResourceApprovalRule>(resource: GovernedResource, rules: readonly R[]): R[] {
  const write = resourceIsWrite(resource);
  return rules.filter((r) => binds(r, resource) && (!r.writeOnly || write)).sort(bySpecificity);
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

  // 3. ABAC never grants: forbid refuses, require_approval joins the approval step
  const abac = input.abacDecision ?? null;
  if (abac?.effect === "forbid") {
    chain.push({ rule: RESOURCE_RULE_IDS.abacForbid, outcome: "deny", ...(abac.policyId ? { grantId: abac.policyId } : {}) });
    return out({
      effect: "deny",
      ruleId: abac.policyId ?? RESOURCE_RULE_IDS.abacForbid,
      reason: `${subject} is forbidden by policy ${abac.policyName ? `'${abac.policyName}'` : (abac.policyId ?? "")}${abac.reason ? `: ${abac.reason}` : ""}`,
    });
  }

  // 4. approval: the entitlement's own hold (the execution dial), ABAC's, and every matching approval rule
  const matched = matchingResourceApprovalRules(resource, input.approvalRules ?? []);
  const matchedIds = matched.map((r) => r.id);
  const abacApprover = abac?.effect === "require_approval" ? (abac.approverUserId ?? null) : null;
  const needsApproval = base.effect === "require_approval" || matched.length > 0 || abac?.effect === "require_approval";
  if (!needsApproval) {
    return out({ effect: "allow", ruleId: base.ruleId, reason: base.reason });
  }
  for (const r of matched) chain.push({ rule: RESOURCE_RULE_IDS.approvalRule, outcome: "require-approval", grantId: r.id });
  if (abac?.effect === "require_approval") {
    chain.push({ rule: RESOURCE_RULE_IDS.abacApproval, outcome: "require-approval", ...(abac.policyId ? { grantId: abac.policyId } : {}) });
  }
  if (input.approvedApprovalId && base.effect !== "require_approval") {
    chain.push({ rule: "approval", outcome: "satisfied-by-approval", grantId: input.approvedApprovalId });
    return out({ effect: "allow", ruleId: base.ruleId, reason: `${base.reason}; released by approval ${input.approvedApprovalId}` }, matchedIds);
  }
  const first = matched[0];
  const approverUserId = base.effect === "require_approval" ? base.approverUserId : (first?.approverUserId ?? abacApprover ?? undefined);
  const approverName = base.effect === "require_approval" ? null : (first?.approverName ?? abac?.approverName ?? null);
  const ruleId = base.effect === "require_approval" ? base.ruleId : (first?.id ?? abac?.policyId ?? RESOURCE_RULE_IDS.abacApproval);
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

