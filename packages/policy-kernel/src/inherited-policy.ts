/**
 * ADR-0357 §4 enforcement (owner decision D-2026-11-23-02, lane L1): THE INHERITED POLICY AT CALL TIME.
 *
 * The gateway resolves the effective policy for the call's place in the hierarchy (org → business unit → project →
 * use case; tighten-only, so every level only narrows its parent) and hands it here. This module is pure: it decides
 * whether one governed call is inside that policy, and names the level whose layer supplied each rule it applied.
 *
 * Applied at call time (the rest of ADR-0357's rules govern writes, workflows or data handling elsewhere):
 *  - `allowedAgents`     → a model dispatch, by the agent's name;
 *  - `allowedConnectors` → a connector call, by the connector's name;
 *  - `allowedMcpServers` → an MCP tool call, by the server's name;
 *  - `deniedTools`       → an MCP tool call, as `server/tool`.
 * An A2A call has no inherited rule yet (none of the allow-lists names remote agents); it is resolved and traced like
 * every other call, so a policy that cannot be resolved still refuses it.
 *
 * DENY WINS, AND NOTHING WIDENS. An inherited rule never grants: a call outside an allow-list, or on the deny-list, is
 * refused whatever grant, rule or consent covers it; a call inside the policy is then decided as before. An unknown
 * name (the resource row has no name) is outside every allow-list that is set (fail closed).
 */

/** a level of the hierarchy, as ADR-0357 names it */
export type InheritedPolicyLevel = "org" | "business_unit" | "project" | "use_case";

/** one effective rule, as the gateway's resolver folds it (`effectivePolicy` in @regulait/shared) */
export interface InheritedPolicyRule {
  rule: string;
  /** null = no level sets it */
  value: unknown;
  /** the level whose layer last made the value stricter; null when unset */
  setBy: { level: InheritedPolicyLevel; subjectId: string | null } | null;
}

/** the effective policy for one call: the chain it was resolved along, and its rules */
export interface InheritedPolicy {
  chain: readonly { level: InheritedPolicyLevel; subjectId: string | null; name: string | null }[];
  rules: readonly InheritedPolicyRule[];
}

/** the governed call, as the inherited policy sees it */
export type InheritedPolicyCall =
  | { type: "model"; name: string | null }
  | { type: "connector"; name: string | null }
  | { type: "a2a"; name: string | null }
  | { type: "mcp_tool"; serverName: string | null; toolName: string };

/** the rule-chain entry's rule name, shared by the MCP kernel and the governed core */
export const INHERITED_POLICY_RULE_ID = "inherited-policy" as const;

export interface InheritedPolicyTrace {
  rule: typeof INHERITED_POLICY_RULE_ID;
  outcome: "allow" | "deny";
  /** `<rule>@<level>[:<subjectId>]`: which rule, and which level supplied it */
  grantId: string;
}

export type InheritedPolicyVerdict =
  | { effect: "allow"; trace: InheritedPolicyTrace[] }
  | { effect: "deny"; ruleId: typeof INHERITED_POLICY_RULE_ID; reason: string; trace: InheritedPolicyTrace[] };

const RULE_FOR: Record<Exclude<InheritedPolicyCall["type"], "a2a">, string> = {
  model: "allowedAgents",
  connector: "allowedConnectors",
  mcp_tool: "allowedMcpServers",
};
const LEVEL_LABEL: Record<InheritedPolicyLevel, string> = { org: "the organisation", business_unit: "business unit", project: "project", use_case: "use case" };

/** `<rule>@<level>[:<subjectId>]` */
export function inheritedRuleRef(r: InheritedPolicyRule): string {
  if (!r.setBy) return `${r.rule}@unset`;
  return `${r.rule}@${r.setBy.level}${r.setBy.subjectId ? `:${r.setBy.subjectId}` : ""}`;
}

function levelProse(policy: InheritedPolicy, r: InheritedPolicyRule): string {
  if (!r.setBy) return "no level";
  const link = policy.chain.find((c) => c.level === r.setBy!.level && c.subjectId === r.setBy!.subjectId);
  const label = LEVEL_LABEL[r.setBy.level];
  return r.setBy.level === "org" ? label : `${label} ${link?.name ? `'${link.name}'` : (r.setBy.subjectId ?? "")}`.trim();
}

const asList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/**
 * Is this call inside the effective inherited policy? Every applied rule is traced (allow or deny) with the level that
 * supplied it, so the decision's audit row says which level governed the call either way.
 */
export function inheritedPolicyVerdict(policy: InheritedPolicy, call: InheritedPolicyCall): InheritedPolicyVerdict {
  const trace: InheritedPolicyTrace[] = [];
  const ruleNamed = (name: string) => policy.rules.find((r) => r.rule === name && r.value !== null && r.value !== undefined);
  const deny = (r: InheritedPolicyRule, reason: string): InheritedPolicyVerdict => {
    trace.push({ rule: INHERITED_POLICY_RULE_ID, outcome: "deny", grantId: inheritedRuleRef(r) });
    return { effect: "deny", ruleId: INHERITED_POLICY_RULE_ID, reason, trace };
  };

  if (call.type !== "a2a") {
    const allow = ruleNamed(RULE_FOR[call.type]);
    const allowed = allow ? asList(allow.value) : null;
    if (allow && allowed) {
      const name = call.type === "mcp_tool" ? call.serverName : call.name;
      const what = call.type === "model" ? "agent" : call.type === "connector" ? "connector" : "MCP server";
      if (!name || !allowed.includes(name)) {
        return deny(
          allow,
          `the ${what} ${name ? `'${name}'` : "(unnamed)"} is not in ${allow.rule}, the allow-list ${levelProse(policy, allow)} sets for this call ` +
            "(ADR-0357 inherited policy: a child level can only narrow it). Nothing was sent.",
        );
      }
      trace.push({ rule: INHERITED_POLICY_RULE_ID, outcome: "allow", grantId: inheritedRuleRef(allow) });
    }
  }

  if (call.type === "mcp_tool") {
    const denied = ruleNamed("deniedTools");
    const list = denied ? asList(denied.value) : null;
    if (denied && list) {
      const key = `${call.serverName ?? "(unnamed)"}/${call.toolName}`;
      // an unnamed server cannot be shown to be off the deny-list, so any entry for this tool name refuses it (fail closed)
      const hit = call.serverName ? list.includes(key) : list.some((x) => x.endsWith(`/${call.toolName}`));
      if (hit) {
        return deny(denied, `the tool '${key}' is on deniedTools, which ${levelProse(policy, denied)} sets for this call (ADR-0357 inherited policy). Nothing was sent.`);
      }
      trace.push({ rule: INHERITED_POLICY_RULE_ID, outcome: "allow", grantId: inheritedRuleRef(denied) });
    }
  }

  return { effect: "allow", trace };
}
