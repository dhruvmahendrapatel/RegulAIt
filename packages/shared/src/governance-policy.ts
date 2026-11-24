/**
 * ADR-0357 §4: tighten-only policy inheritance, org → business unit → project → use case.
 *
 * The one declared merge table (`POLICY_RULES`): every rule names its kind, and every kind has one merge, one
 * "would this widen?" test and one "is this stricter?" order, here and nowhere else. The gateway stores a layer per
 * level, refuses a child that widens its parent (`policyWidenings`), and serves the effective policy with the level
 * that set each rule (`effectivePolicy`). Pure: no database, no I/O.
 */
import { z } from "zod";

export const POLICY_LEVELS = ["org", "business_unit", "project", "use_case"] as const;
export type PolicyLevel = (typeof POLICY_LEVELS)[number];

/** sensitivity, least to most sensitive (the use-case vocabulary, AI_USE_CASE_DATA_SENSITIVITIES): a LOWER ceiling
 * is stricter */
export const POLICY_SENSITIVITY_ORDER = ["public", "internal", "confidential", "regulated"] as const;
/** PII handling, least to most protective (the compliance-profile vocabulary, §8.3 `piiMode`): a HIGHER mode is
 * stricter */
export const POLICY_PII_ORDER = ["log", "warn", "block"] as const;

export type PolicyRuleKind = "allow_list" | "deny_list" | "ceiling" | "floor" | "required_flag" | "ordered_max_strict" | "ordered_min_strict";

/** THE merge table (ADR-0357 §4). Adding a rule is one line here plus its schema field below. */
export const POLICY_RULES = {
  allowedAgents: { kind: "allow_list", describe: "the agents (models) callers may use, by name" },
  allowedConnectors: { kind: "allow_list", describe: "the connectors callers may use, by name" },
  allowedMcpServers: { kind: "allow_list", describe: "the MCP servers callers may use, by name" },
  deniedTools: { kind: "deny_list", describe: "MCP tools nobody under this level may call, as server/tool" },
  maxBudgetUsd: { kind: "ceiling", describe: "the most a project's budget may be, in USD" },
  maxCallsPerHour: { kind: "ceiling", describe: "the most governed calls one user may make in an hour" },
  auditRetentionDays: { kind: "floor", describe: "the fewest days audit evidence is kept" },
  minApprovers: { kind: "floor", describe: "the fewest approvers a sign-off needs" },
  requireHumanSignoff: { kind: "required_flag", describe: "every change needs a human sign-off" },
  requirePlanGate: { kind: "required_flag", describe: "every build starts in plan-only mode" },
  maxDataSensitivity: { kind: "ordered_min_strict", describe: "the most sensitive data callers may send (public < internal < confidential < regulated)" },
  piiMode: { kind: "ordered_max_strict", describe: "how PII is handled (log < warn < block)" },
} as const satisfies Record<string, { kind: PolicyRuleKind; describe: string }>;

export type PolicyRuleName = keyof typeof POLICY_RULES;
export const POLICY_RULE_NAMES = Object.keys(POLICY_RULES) as PolicyRuleName[];

const listItem = z.string().min(1).max(200);
const list = z.array(listItem).max(500);

/** one layer's policy: every rule optional (unset = inherit); unknown rules refused */
export const governancePolicySchema = z
  .object({
    allowedAgents: list.optional(),
    allowedConnectors: list.optional(),
    allowedMcpServers: list.optional(),
    deniedTools: z.array(z.string().regex(/^[^/\s]{1,200}\/[^/\s]{1,200}$/, "server/tool")).max(2000).optional(),
    maxBudgetUsd: z.number().nonnegative().max(1e12).optional(),
    maxCallsPerHour: z.number().int().nonnegative().max(1e9).optional(),
    auditRetentionDays: z.number().int().min(1).max(36500).optional(),
    minApprovers: z.number().int().min(1).max(20).optional(),
    requireHumanSignoff: z.boolean().optional(),
    requirePlanGate: z.boolean().optional(),
    maxDataSensitivity: z.enum(POLICY_SENSITIVITY_ORDER).optional(),
    piiMode: z.enum(POLICY_PII_ORDER).optional(),
  })
  .strict();
export type GovernancePolicy = z.infer<typeof governancePolicySchema>;

type Value = GovernancePolicy[PolicyRuleName];
const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
const rank = (rule: PolicyRuleName, v: string) =>
  POLICY_RULES[rule].kind === "ordered_min_strict" ? (POLICY_SENSITIVITY_ORDER as readonly string[]).indexOf(v) : (POLICY_PII_ORDER as readonly string[]).indexOf(v);

/**
 * parent ∘ child for one rule (both set). The result is never looser than either side:
 *  allow-list ∩, deny-list ∪, ceiling min, floor max, required flag OR, ordered the stricter end.
 */
export function mergeRule(rule: PolicyRuleName, parent: Value, child: Value): Value {
  const kind = POLICY_RULES[rule].kind;
  switch (kind) {
    case "allow_list": {
      const p = new Set(parent as string[]);
      return sorted((child as string[]).filter((x) => p.has(x)));
    }
    case "deny_list":
      return sorted([...(parent as string[]), ...(child as string[])]);
    case "ceiling":
      return Math.min(parent as number, child as number);
    case "floor":
      return Math.max(parent as number, child as number);
    case "required_flag":
      return (parent as boolean) || (child as boolean);
    case "ordered_min_strict":
      return rank(rule, parent as string) <= rank(rule, child as string) ? parent : child;
    case "ordered_max_strict":
      return rank(rule, parent as string) >= rank(rule, child as string) ? parent : child;
  }
}

/** is `next` looser than `current` for this rule (both set)? The same order the merge uses. */
export function ruleLoosens(rule: PolicyRuleName, current: Value, next: Value): boolean {
  const kind = POLICY_RULES[rule].kind;
  switch (kind) {
    case "allow_list": {
      const c = new Set(current as string[]);
      return (next as string[]).some((x) => !c.has(x));
    }
    case "deny_list": {
      const n = new Set(next as string[]);
      return (current as string[]).some((x) => !n.has(x));
    }
    case "ceiling":
      return (next as number) > (current as number);
    case "floor":
      return (next as number) < (current as number);
    case "required_flag":
      return (current as boolean) && !(next as boolean);
    case "ordered_min_strict":
      return rank(rule, next as string) > rank(rule, current as string);
    case "ordered_max_strict":
      return rank(rule, next as string) < rank(rule, current as string);
  }
}

export interface PolicyLayerInput {
  level: PolicyLevel;
  /** the level's subject (null for org) */
  subjectId: string | null;
  policy: GovernancePolicy;
}

export interface EffectiveRule {
  rule: PolicyRuleName;
  kind: PolicyRuleKind;
  /** null = no level sets it (the product's own default applies) */
  value: Value | null;
  /** the level whose layer last made the value stricter (null when unset) */
  setBy: { level: PolicyLevel; subjectId: string | null } | null;
  /** every level that sets this rule, root first */
  setAt: { level: PolicyLevel; subjectId: string | null; value: Value }[];
}

/**
 * Folds the layers root first (org, business unit, project, use case) into the effective policy, one entry per rule
 * in the table's order, each naming the level that set it. A level that sets a rule no stricter than what it
 * inherits leaves `setBy` where it was.
 */
export function effectivePolicy(layers: readonly PolicyLayerInput[]): EffectiveRule[] {
  const ordered = [...layers].sort((a, b) => POLICY_LEVELS.indexOf(a.level) - POLICY_LEVELS.indexOf(b.level));
  return POLICY_RULE_NAMES.map((rule) => {
    let value: Value | null = null;
    let setBy: EffectiveRule["setBy"] = null;
    const setAt: EffectiveRule["setAt"] = [];
    for (const l of ordered) {
      const v = l.policy[rule];
      if (v === undefined) continue;
      setAt.push({ level: l.level, subjectId: l.subjectId, value: v });
      if (value === null) {
        value = Array.isArray(v) ? sorted(v) : v;
        setBy = { level: l.level, subjectId: l.subjectId };
        continue;
      }
      const merged = mergeRule(rule, value, v);
      if (JSON.stringify(merged) !== JSON.stringify(value)) {
        value = merged;
        setBy = { level: l.level, subjectId: l.subjectId };
      }
    }
    return { rule, kind: POLICY_RULES[rule].kind, value, setBy, setAt };
  });
}

export interface PolicyWidening {
  rule: PolicyRuleName;
  inherited: Value;
  attempted: Value;
}

/** Tighten-only: each rule `child` sets that is looser than what it inherits from `parent` (the effective policy). */
export function policyWidenings(parent: readonly EffectiveRule[], child: GovernancePolicy): PolicyWidening[] {
  const out: PolicyWidening[] = [];
  for (const e of parent) {
    const v = child[e.rule];
    if (v === undefined || e.value === null) continue;
    if (ruleLoosens(e.rule, e.value, v)) out.push({ rule: e.rule, inherited: e.value, attempted: v });
  }
  return out;
}

/**
 * What an edit of one layer loosens against that layer's previous self (ADR-0180: a relaxation is a `settings_relax`
 * step-up). A rule removed loosens unless it was already ineffective; here, conservatively, removing any rule counts.
 */
export function layerRelaxations(before: GovernancePolicy | null, after: GovernancePolicy | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rule of POLICY_RULE_NAMES) {
    const b = before?.[rule];
    const a = after?.[rule];
    if (b === undefined) continue;
    if (a === undefined || ruleLoosens(rule, b, a)) out[rule] = a ?? null;
  }
  return out;
}
