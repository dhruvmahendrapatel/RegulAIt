export type ToolKind = "read" | "write";
export type DecisionEffect = "allow" | "deny";

export interface ToolGrant {
  id: string;
  userId: string;
  serverId: string;
  toolName: string;
}

export interface ServerGrant {
  id: string;
  userId: string;
  serverId: string;
  readOnlyAll: boolean;
}

export interface ToolRef {
  serverId: string;
  name: string;
  kind: ToolKind;
}

export interface EvaluationInput {
  userId: string;
  serverId: string;
  tool: ToolRef;
  toolGrants: readonly ToolGrant[];
  serverGrants: readonly ServerGrant[];
}

export interface Decision {
  effect: DecisionEffect;
  /** id of the grant that produced the allow, or the built-in rule name for a deny */
  ruleId: string;
  /** every rule evaluated, in order, with its outcome */
  ruleChain: RuleTrace[];
  reason: string;
}

export interface RuleTrace {
  rule: RuleName;
  outcome: "allow" | "deny" | "no-match";
  grantId?: string;
}

export type RuleName = "tool-allow-list" | "server-read-only-all" | "default-deny";

export const DEFAULT_DENY_RULE_ID = "default-deny";

/**
 * Pure, zero-I/O policy evaluation. Rules run in fixed order; the first match
 * wins and everything evaluated is recorded in ruleChain for the audit log.
 */
export function evaluate(input: EvaluationInput): Decision {
  const { userId, serverId, tool } = input;
  const chain: RuleTrace[] = [];

  const toolGrant = input.toolGrants.find(
    (g) =>
      g.userId === userId &&
      g.serverId === serverId &&
      g.toolName === tool.name,
  );
  if (toolGrant) {
    chain.push({ rule: "tool-allow-list", outcome: "allow", grantId: toolGrant.id });
    return {
      effect: "allow",
      ruleId: toolGrant.id,
      ruleChain: chain,
      reason: `tool '${tool.name}' on server '${serverId}' is on user's allow-list`,
    };
  }
  chain.push({ rule: "tool-allow-list", outcome: "no-match" });

  const serverGrant = input.serverGrants.find(
    (g) => g.userId === userId && g.serverId === serverId && g.readOnlyAll,
  );
  if (serverGrant && tool.kind === "read") {
    chain.push({ rule: "server-read-only-all", outcome: "allow", grantId: serverGrant.id });
    return {
      effect: "allow",
      ruleId: serverGrant.id,
      ruleChain: chain,
      reason: `read-only tool '${tool.name}' allowed by user's read-all grant on server '${serverId}'`,
    };
  }
  chain.push({ rule: "server-read-only-all", outcome: "no-match" });

  chain.push({ rule: "default-deny", outcome: "deny" });
  return {
    effect: "deny",
    ruleId: DEFAULT_DENY_RULE_ID,
    ruleChain: chain,
    reason: `no grant matches user '${userId}', server '${serverId}', tool '${tool.name}' — default-deny`,
  };
}

/**
 * Visibility filter (§3): tools not on the user's allow-list are not even
 * visible to the user's agent, not just blocked at execution time.
 */
export function visibleTools(
  userId: string,
  serverId: string,
  tools: readonly ToolRef[],
  toolGrants: readonly ToolGrant[],
  serverGrants: readonly ServerGrant[],
): ToolRef[] {
  return tools.filter(
    (tool) =>
      tool.serverId === serverId &&
      evaluate({ userId, serverId, tool, toolGrants, serverGrants }).effect === "allow",
  );
}
