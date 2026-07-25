export type ToolKind = "read" | "write";
export type DecisionEffect = "allow" | "deny" | "require_approval";

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

/**
 * §5 role-derived entitlements. The gateway pre-filters these to the roles
 * actually assigned to the evaluated user; the kernel only needs the grants
 * themselves.
 */
export interface RoleToolGrant {
  id: string;
  roleId: string;
  serverId: string;
  toolName: string;
}

export interface RoleServerGrant {
  id: string;
  roleId: string;
  serverId: string;
  readOnlyAll: boolean;
}

/**
 * §5 subtractive per-user override: suppresses ROLE-DERIVED entitlements
 * only — a direct user grant always survives a revocation (a direct grant is
 * itself an explicit per-user override, and the two shouldn't fight).
 * toolName set = suppress role-derived access to that one tool (via role
 * tool grants or role read-only-all); toolName null = suppress all
 * role-derived access on the server.
 */
export interface Revocation {
  id: string;
  userId: string;
  serverId: string;
  toolName: string | null;
}

/**
 * §3 approval requirement: a matching, granted call pauses for a named
 * approver's sign-off instead of executing. toolName null = any tool on the
 * server; writeOnly narrows the rule to write-kind tools.
 */
export interface ApprovalRule {
  id: string;
  userId: string;
  serverId: string;
  toolName: string | null;
  writeOnly: boolean;
  approverUserId: string;
}

/**
 * §3 data-scope restriction: constrains a granted tool's effective reach by
 * allow-listing the values a call-argument field may take (e.g. only certain
 * schemas for a generic query tool). argPath is a dot-path into the call
 * arguments. Every matching rule must be satisfied; a missing or non-scalar
 * value at the path fails closed.
 */
export interface DataScopeRule {
  id: string;
  userId: string;
  serverId: string;
  toolName: string | null;
  argPath: string;
  allowedValues: string[];
}

/**
 * §3 rate/volume limit. The kernel is zero-I/O, so the caller supplies
 * currentCount — the number of already-executed (allowed) calls inside the
 * limit's window. toolName null = counts all calls on the server.
 */
export interface RateLimit {
  id: string;
  userId: string;
  serverId: string;
  toolName: string | null;
  maxCalls: number;
  windowSeconds: number;
  currentCount: number;
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
  /** role-derived grants, pre-filtered by the gateway to the user's assigned roles */
  roleToolGrants?: readonly RoleToolGrant[];
  roleServerGrants?: readonly RoleServerGrant[];
  revocations?: readonly Revocation[];
  approvalRules?: readonly ApprovalRule[];
  rateLimits?: readonly RateLimit[];
  dataScopeRules?: readonly DataScopeRule[];
  /** the call's arguments — required for data-scope rules to be checkable */
  args?: Record<string, unknown>;
  /**
   * An approved, unconsumed Approvals-Queue entry for exactly this
   * user/server/tool call, if the gateway found one. Satisfies a matching
   * approval rule for this single evaluation.
   */
  approvedApprovalId?: string | null;
}

export interface Decision {
  effect: DecisionEffect;
  /**
   * id of the grant that produced the allow, the built-in rule name for a
   * default deny, the rate limit id for a rate-limit deny, or the approval
   * rule id for a require_approval.
   */
  ruleId: string;
  /** every rule evaluated, in order, with its outcome */
  ruleChain: RuleTrace[];
  reason: string;
  /** set when effect is require_approval: who must sign off */
  approverUserId?: string;
}

export interface RuleTrace {
  rule: RuleName;
  outcome: "allow" | "deny" | "no-match" | "revoked" | "require-approval" | "satisfied-by-approval";
  /** the matched grant/limit/rule id — or, for a "revoked" outcome, the revocation id */
  grantId?: string;
}

export type RuleName =
  | "tool-allow-list"
  | "role-tool-allow-list"
  | "server-read-only-all"
  | "role-server-read-only-all"
  | "data-scope"
  | "rate-limit"
  | "approval-required"
  | "default-deny";

export const DEFAULT_DENY_RULE_ID = "default-deny";

function matchesScope(ruleToolName: string | null, toolName: string): boolean {
  return ruleToolName === null || ruleToolName === toolName;
}

function argAtPath(args: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = args;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Pure, zero-I/O policy evaluation. Rules run in fixed order; the first
 * terminal match wins and everything evaluated is recorded in ruleChain for
 * the audit log.
 *
 * Order: grant check (allow-list, then read-only-all) — an ungranted call is
 * default-denied and nothing can rescue it. A granted call then passes
 * through rate limits (an exhausted limit denies even if an approval was
 * signed off) and approval rules before the final allow.
 */
export function evaluate(input: EvaluationInput): Decision {
  const { userId, serverId, tool } = input;
  const chain: RuleTrace[] = [];

  let grantId: string | undefined;
  let grantReason = "";

  // A revocation only ever suppresses ROLE-DERIVED entitlements (§5): direct
  // user grants are themselves per-user overrides and always survive.
  const revocationFor = (toolName: string | null): Revocation | undefined =>
    (input.revocations ?? []).find(
      (r) =>
        r.userId === userId &&
        r.serverId === serverId &&
        (r.toolName === null || r.toolName === toolName),
    );

  // Grant precedence: direct tool grant → role tool grant (minus revocations)
  // → direct read-only-all → role read-only-all (minus revocations) → deny.
  const toolGrant = input.toolGrants.find(
    (g) =>
      g.userId === userId &&
      g.serverId === serverId &&
      g.toolName === tool.name,
  );
  if (toolGrant) {
    chain.push({ rule: "tool-allow-list", outcome: "allow", grantId: toolGrant.id });
    grantId = toolGrant.id;
    grantReason = `tool '${tool.name}' on server '${serverId}' is on user's allow-list`;
  } else {
    chain.push({ rule: "tool-allow-list", outcome: "no-match" });

    const roleToolGrant = (input.roleToolGrants ?? []).find(
      (g) => g.serverId === serverId && g.toolName === tool.name,
    );
    if (roleToolGrant) {
      const revocation = revocationFor(tool.name);
      if (revocation) {
        chain.push({ rule: "role-tool-allow-list", outcome: "revoked", grantId: revocation.id });
      } else {
        chain.push({ rule: "role-tool-allow-list", outcome: "allow", grantId: roleToolGrant.id });
        grantId = roleToolGrant.id;
        grantReason =
          `tool '${tool.name}' on server '${serverId}' is on the allow-list of ` +
          `assigned role '${roleToolGrant.roleId}'`;
      }
    } else {
      chain.push({ rule: "role-tool-allow-list", outcome: "no-match" });
    }
  }

  if (!grantId) {
    const serverGrant = input.serverGrants.find(
      (g) => g.userId === userId && g.serverId === serverId && g.readOnlyAll,
    );
    if (serverGrant && tool.kind === "read") {
      chain.push({ rule: "server-read-only-all", outcome: "allow", grantId: serverGrant.id });
      grantId = serverGrant.id;
      grantReason = `read-only tool '${tool.name}' allowed by user's read-all grant on server '${serverId}'`;
    } else {
      chain.push({ rule: "server-read-only-all", outcome: "no-match" });

      const roleServerGrant = (input.roleServerGrants ?? []).find(
        (g) => g.serverId === serverId && g.readOnlyAll,
      );
      if (roleServerGrant && tool.kind === "read") {
        const revocation = revocationFor(tool.name);
        if (revocation) {
          chain.push({
            rule: "role-server-read-only-all",
            outcome: "revoked",
            grantId: revocation.id,
          });
        } else {
          chain.push({
            rule: "role-server-read-only-all",
            outcome: "allow",
            grantId: roleServerGrant.id,
          });
          grantId = roleServerGrant.id;
          grantReason =
            `read-only tool '${tool.name}' allowed by read-all grant of assigned role ` +
            `'${roleServerGrant.roleId}' on server '${serverId}'`;
        }
      } else {
        chain.push({ rule: "role-server-read-only-all", outcome: "no-match" });
      }
    }
  }

  if (!grantId) {
    chain.push({ rule: "default-deny", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: chain,
      reason: `no grant matches user '${userId}', server '${serverId}', tool '${tool.name}' — default-deny`,
    };
  }

  const scopeRules = (input.dataScopeRules ?? []).filter(
    (r) =>
      r.userId === userId && r.serverId === serverId && matchesScope(r.toolName, tool.name),
  );
  if (scopeRules.length > 0) {
    for (const rule of scopeRules) {
      const value = argAtPath(input.args, rule.argPath);
      const scalar =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      if (!scalar || !rule.allowedValues.includes(String(value))) {
        chain.push({ rule: "data-scope", outcome: "deny", grantId: rule.id });
        return {
          effect: "deny",
          ruleId: rule.id,
          ruleChain: chain,
          reason: scalar
            ? `argument '${rule.argPath}' value '${String(value)}' is outside the allowed data scope`
            : `argument '${rule.argPath}' is missing or not a scalar — data-scope rule fails closed`,
        };
      }
    }
    chain.push({ rule: "data-scope", outcome: "allow" });
  } else {
    chain.push({ rule: "data-scope", outcome: "no-match" });
  }

  const exhaustedLimit = (input.rateLimits ?? []).find(
    (l) =>
      l.userId === userId &&
      l.serverId === serverId &&
      matchesScope(l.toolName, tool.name) &&
      l.currentCount >= l.maxCalls,
  );
  if (exhaustedLimit) {
    chain.push({ rule: "rate-limit", outcome: "deny", grantId: exhaustedLimit.id });
    return {
      effect: "deny",
      ruleId: exhaustedLimit.id,
      ruleChain: chain,
      reason:
        `rate limit exhausted: ${exhaustedLimit.currentCount}/${exhaustedLimit.maxCalls} calls ` +
        `in ${exhaustedLimit.windowSeconds}s window` +
        (exhaustedLimit.toolName ? ` for tool '${exhaustedLimit.toolName}'` : " (server-wide)"),
    };
  }
  chain.push({ rule: "rate-limit", outcome: "no-match" });

  const approvalRule = (input.approvalRules ?? []).find(
    (r) =>
      r.userId === userId &&
      r.serverId === serverId &&
      matchesScope(r.toolName, tool.name) &&
      (!r.writeOnly || tool.kind === "write"),
  );
  if (approvalRule) {
    if (input.approvedApprovalId) {
      chain.push({
        rule: "approval-required",
        outcome: "satisfied-by-approval",
        grantId: input.approvedApprovalId,
      });
    } else {
      chain.push({ rule: "approval-required", outcome: "require-approval", grantId: approvalRule.id });
      return {
        effect: "require_approval",
        ruleId: approvalRule.id,
        ruleChain: chain,
        reason:
          `call to '${tool.name}' on server '${serverId}' requires sign-off by ` +
          `approver '${approvalRule.approverUserId}'`,
        approverUserId: approvalRule.approverUserId,
      };
    }
  } else {
    chain.push({ rule: "approval-required", outcome: "no-match" });
  }

  return {
    effect: "allow",
    ruleId: grantId,
    ruleChain: chain,
    reason: grantReason,
  };
}

/** everything that determines what a user is entitled to on a server */
export interface Entitlements {
  toolGrants: readonly ToolGrant[];
  serverGrants: readonly ServerGrant[];
  roleToolGrants?: readonly RoleToolGrant[];
  roleServerGrants?: readonly RoleServerGrant[];
  revocations?: readonly Revocation[];
}

/**
 * Visibility filter (§3): tools not on the user's allow-list are not even
 * visible to the user's agent, not just blocked at execution time.
 * Approval-required tools stay visible — they are usable, they just pause
 * for sign-off — so only hard denies are filtered out.
 */
export function visibleTools(
  userId: string,
  serverId: string,
  tools: readonly ToolRef[],
  entitlements: Entitlements,
): ToolRef[] {
  return tools.filter(
    (tool) =>
      tool.serverId === serverId &&
      evaluate({ userId, serverId, tool, ...entitlements }).effect !== "deny",
  );
}

// ---------------------------------------------------------------------------
// §2/§4 — Agents/Models object type
// ---------------------------------------------------------------------------

/** a registry entry: platform-wide catalog, decoupled from per-user entitlement (§4) */
export interface AgentRef {
  id: string;
  /** capability/cost rank; higher = more capable/expensive. Basis of the §4 ceiling. */
  tier: number;
  enabled: boolean;
  /** the registry's declared modes; null = registry does not constrain modes */
  modes: string[] | null;
}

/** per-user agent entitlement; allowedModes null = every mode the agent has */
export interface AgentGrant {
  id: string;
  userId: string;
  agentId: string;
  allowedModes: string[] | null;
}

export interface EvaluateAgentInput {
  userId: string;
  agent: AgentRef;
  /** the mode being invoked (e.g. "plan", "execute") */
  mode: string;
  agentGrants: readonly AgentGrant[];
  /** tier of the user's ceiling agent (§4); null/undefined = no ceiling set */
  ceilingTier?: number | null;
}

export type AgentRuleName =
  | "agent-registry-enabled"
  | "agent-allow-list"
  | "agent-mode"
  | "agent-ceiling"
  | "default-deny";

export interface AgentRuleTrace {
  rule: AgentRuleName;
  outcome: "allow" | "deny" | "no-match";
  grantId?: string;
}

export interface AgentDecision {
  effect: "allow" | "deny";
  ruleId: string;
  ruleChain: AgentRuleTrace[];
  reason: string;
}

/**
 * §4: registry-enabled → per-user allow-list → mode restriction → ceiling →
 * allow. Deny-by-default: no grant, no access, regardless of the registry.
 */
export function evaluateAgent(input: EvaluateAgentInput): AgentDecision {
  const { userId, agent, mode } = input;
  const chain: AgentRuleTrace[] = [];

  if (!agent.enabled) {
    chain.push({ rule: "agent-registry-enabled", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: "agent-registry-enabled",
      ruleChain: chain,
      reason: `agent '${agent.id}' is disabled platform-wide in the registry`,
    };
  }
  chain.push({ rule: "agent-registry-enabled", outcome: "allow" });

  // The registry's declared modes bound every grant: an undeclared mode is
  // invalid for everyone, even a grant with allowedModes null.
  if (agent.modes !== null && !agent.modes.includes(mode)) {
    chain.push({ rule: "agent-mode", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: "agent-mode",
      ruleChain: chain,
      reason: `mode '${mode}' is not a declared mode of agent '${agent.id}'`,
    };
  }

  const grant = input.agentGrants.find((g) => g.userId === userId && g.agentId === agent.id);
  if (!grant) {
    chain.push({ rule: "agent-allow-list", outcome: "no-match" });
    chain.push({ rule: "default-deny", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: chain,
      reason: `agent '${agent.id}' is not on user '${userId}'s allow-list — default-deny`,
    };
  }
  chain.push({ rule: "agent-allow-list", outcome: "allow", grantId: grant.id });

  if (grant.allowedModes !== null && !grant.allowedModes.includes(mode)) {
    chain.push({ rule: "agent-mode", outcome: "deny", grantId: grant.id });
    return {
      effect: "deny",
      ruleId: grant.id,
      ruleChain: chain,
      reason: `mode '${mode}' of agent '${agent.id}' is not in the grant's allowed modes`,
    };
  }
  chain.push({ rule: "agent-mode", outcome: grant.allowedModes === null ? "no-match" : "allow" });

  if (input.ceilingTier != null && agent.tier > input.ceilingTier) {
    chain.push({ rule: "agent-ceiling", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: "agent-ceiling",
      ruleChain: chain,
      reason:
        `agent '${agent.id}' (tier ${agent.tier}) exceeds user's ceiling ` +
        `(tier ${input.ceilingTier})`,
    };
  }
  chain.push({ rule: "agent-ceiling", outcome: "no-match" });

  return {
    effect: "allow",
    ruleId: grant.id,
    ruleChain: chain,
    reason: `agent '${agent.id}' mode '${mode}' allowed by user's agent grant`,
  };
}

// ---------------------------------------------------------------------------
// §2 — Connectors object type
// ---------------------------------------------------------------------------

/** per-user connector entitlement: mode + optional object-level data scope */
export interface ConnectorGrant {
  id: string;
  userId: string;
  connectorId: string;
  /** "read" = read-only; "readwrite" = writes permitted */
  mode: "read" | "readwrite";
  /** null = all objects; otherwise the connector's reach is limited to these */
  allowedObjects: string[] | null;
}

export interface EvaluateConnectorInput {
  userId: string;
  connectorId: string;
  operation: "read" | "write";
  /** the object/table/folder the call targets, when the caller specifies one */
  object?: string | null;
  connectorGrants: readonly ConnectorGrant[];
}

export type ConnectorRuleName =
  | "connector-allow-list"
  | "connector-mode"
  | "connector-object-scope"
  | "default-deny";

export interface ConnectorRuleTrace {
  rule: ConnectorRuleName;
  outcome: "allow" | "deny" | "no-match";
  grantId?: string;
}

export interface ConnectorDecision {
  effect: "allow" | "deny";
  ruleId: string;
  ruleChain: ConnectorRuleTrace[];
  reason: string;
}

/**
 * §2: per-user connector grant → read/write mode → object-level data scope
 * (fail closed when scoped and no object is named) → allow.
 */
export function evaluateConnector(input: EvaluateConnectorInput): ConnectorDecision {
  const { userId, connectorId, operation } = input;
  const chain: ConnectorRuleTrace[] = [];

  const grant = input.connectorGrants.find(
    (g) => g.userId === userId && g.connectorId === connectorId,
  );
  if (!grant) {
    chain.push({ rule: "connector-allow-list", outcome: "no-match" });
    chain.push({ rule: "default-deny", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: chain,
      reason: `connector '${connectorId}' is not on user '${userId}'s allow-list — default-deny`,
    };
  }
  chain.push({ rule: "connector-allow-list", outcome: "allow", grantId: grant.id });

  if (operation === "write" && grant.mode === "read") {
    chain.push({ rule: "connector-mode", outcome: "deny", grantId: grant.id });
    return {
      effect: "deny",
      ruleId: grant.id,
      ruleChain: chain,
      reason: `write to connector '${connectorId}' denied: grant is read-only`,
    };
  }
  chain.push({ rule: "connector-mode", outcome: operation === "write" ? "allow" : "no-match" });

  if (grant.allowedObjects !== null) {
    const object = input.object ?? null;
    if (object === null || !grant.allowedObjects.includes(object)) {
      chain.push({ rule: "connector-object-scope", outcome: "deny", grantId: grant.id });
      return {
        effect: "deny",
        ruleId: grant.id,
        ruleChain: chain,
        reason:
          object === null
            ? `connector '${connectorId}' grant is object-scoped and no object was named — fails closed`
            : `object '${object}' is outside the grant's allowed objects for connector '${connectorId}'`,
      };
    }
    chain.push({ rule: "connector-object-scope", outcome: "allow", grantId: grant.id });
  } else {
    chain.push({ rule: "connector-object-scope", outcome: "no-match" });
  }

  return {
    effect: "allow",
    ruleId: grant.id,
    ruleChain: chain,
    reason: `${operation} on connector '${connectorId}' allowed by user's connector grant`,
  };
}
