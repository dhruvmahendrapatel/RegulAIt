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
  /** optional display name for the role — reason prose only */
  roleName?: string | null;
  serverId: string;
  toolName: string;
}

export interface RoleServerGrant {
  id: string;
  roleId: string;
  /** optional display name for the role — reason prose only */
  roleName?: string | null;
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
  /** O9 (ADR-0027): 'full' (default, incl. absent = every pre-O9 rule) =
   * suppress entirely; 'read_only' = suppress WRITE-classified tools only —
   * reads stay allowed. A full revocation still beats everything. */
  scope?: "full" | "read_only" | null;
}

/**
 * PILLAR 1 rule scoping: the subject a restriction rule binds to. The gateway
 * pre-filters rules to those the evaluated user actually matches (by direct
 * user id, by an assigned role, by a team membership, or fleet-wide), exactly
 * as it already pre-filters role-derived grants — so the kernel stays
 * subject-free. 'user' (or an absent field, for a legacy rule) is the only
 * scope whose user-id the kernel still checks; the rest arrive pre-matched.
 */
export type RuleScope = "user" | "role" | "team" | "fleet";
/** whether a rule binds to one server (serverId set) or every server (all). */
export type RuleServerScope = "server" | "all";

/**
 * A4 (ADR-0027, decomposing ADR-0019's deferred A4): the DEPLOY-MODE dimension
 * a restriction rule may additionally bind to. A rule with deployMode set
 * matches ONLY a call whose evaluation context carries that mode (see
 * EvaluationInput.deployContext); null/absent = mode-unscoped = matches every
 * call — byte-identical to the pre-A4 behaviour.
 */
export type RuleDeployMode = "hosted" | "byoc" | "air_gapped";

/**
 * §3 approval requirement: a matching, granted call pauses for a named
 * approver's sign-off instead of executing. toolName null = any tool on the
 * server; writeOnly narrows the rule to write-kind tools.
 *
 * PILLAR 1: userId/serverId are nullable — a role/team/fleet rule has no user,
 * an all-servers rule has no server. scope/serverScope carry the discriminant;
 * absent = the legacy per-user, per-server rule (back-compat).
 */
export interface ApprovalRule {
  id: string;
  userId: string | null;
  serverId: string | null;
  roleId?: string | null;
  teamId?: string | null;
  scope?: RuleScope;
  serverScope?: RuleServerScope;
  /** A4: bind this rule to one deploy mode; null/absent = every call (today) */
  deployMode?: RuleDeployMode | null;
  toolName: string | null;
  writeOnly: boolean;
  /**
   * ADR-0104: what a consent granted under this rule is BOUND TO. 'action'
   * binds it to the exact call arguments the approver signed for; 'tool' is the
   * escape hatch that makes it reusable across differing arguments. Absent
   * reads as 'action' — the strict default — so an older rule body that carries
   * no scope can never be the loose one. The kernel itself does not branch on
   * this: the gateway resolves the strictest scope across the MATCHED rules
   * (see `matchingApprovalRules` below) and uses it to decide whether an
   * already-approved queue entry has to fingerprint-match this call.
   */
  approvalScope?: "action" | "tool" | null;
  approverUserId: string;
  /** optional display name for the approver — used in reason prose only */
  approverName?: string | null;
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
  userId: string | null;
  serverId: string | null;
  roleId?: string | null;
  teamId?: string | null;
  scope?: RuleScope;
  serverScope?: RuleServerScope;
  /** A4: bind this rule to one deploy mode; null/absent = every call (today) */
  deployMode?: RuleDeployMode | null;
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
  userId: string | null;
  serverId: string | null;
  roleId?: string | null;
  teamId?: string | null;
  scope?: RuleScope;
  serverScope?: RuleServerScope;
  /** A4: bind this rule to one deploy mode; null/absent = every call (today) */
  deployMode?: RuleDeployMode | null;
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

/**
 * ADR-0040 — the ABAC / policy-as-code verdict, supplied BY THE GATEWAY.
 *
 * The kernel stays pure: it never parses a Cedar policy, never looks an
 * attribute up, never touches I/O. It receives an already-computed verdict and
 * composes it into the fixed rule order like any other check.
 *
 * THE INVARIANT — **ABAC NEVER GRANTS.** This input is consulted strictly on
 * the ALLOW path (after a grant has been found), exactly like ADR-0019's
 * revocations and §5.1's lead ceiling, so it can only ever turn an allow into a
 * deny or a require_approval. An ungranted call is default-denied before this
 * is even looked at, and no Cedar `permit` can rescue it: a Cedar `permit` here
 * means nothing more than "does not forbid".
 *
 * ABSENT INPUT = TODAY. undefined/null (which is what the gateway passes when
 * the deployment has NO active ABAC policies) adds no rule-chain entry and
 * changes no decision — byte-identical to the pre-ADR-0040 kernel, the same
 * discipline every prior kernel extension follows.
 */
export type AbacEffect = "permit" | "forbid" | "require_approval";

export interface AbacDecision {
  /** 'permit' = no forbid matched (Cedar's permit is NOT a grant here) */
  effect: AbacEffect;
  /** the matched policy's stable id — becomes `ruleId` on a forbid/approval */
  policyId?: string | null;
  /** display name of the matched policy — reason prose only */
  policyName?: string | null;
  /** the activated version number of the matched policy — reason prose only */
  policyVersion?: number | null;
  /** every policy that matched, for the audit prose (the first one governs) */
  matchedPolicyIds?: readonly string[];
  /** required when effect is require_approval: who must sign off */
  approverUserId?: string | null;
  approverName?: string | null;
  /** the policy author's justification/annotation — reason prose only */
  reason?: string | null;
}

export interface EvaluationInput {
  userId: string;
  serverId: string;
  /** optional display names for reason prose; ids stay authoritative */
  userName?: string | null;
  serverName?: string | null;
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
  /**
   * §5.1 Team-Lead delegation ceiling: when a worker node runs under a lead,
   * the gateway passes the intersected allow-list of tool NAMES its lead chain
   * permits. A non-null value only ever NARROWS — a granted tool whose name is
   * not in the set is denied; it can never rescue an ungranted call (that is
   * default-denied before this is even consulted). Null/undefined = no lead
   * ceiling (a flat run), and behaviour is unchanged.
   */
  ceilingTools?: readonly string[] | null;
  /**
   * A4 (ADR-0027): the deploy modes/contexts this call executes UNDER — always
   * SERVER-DERIVED (the gateway resolves it from the deploy targets the
   * attributed work lands on), never client-asserted. A set (not a single
   * value) because attributed work can be in flight toward targets of more
   * than one mode at once. A mode-scoped restriction rule matches when its
   * deployMode is IN this set. Null/empty = no derivable deploy context — a
   * mode-scoped rule then does NOT match (a restriction binds to a KNOWN
   * context), and every mode-unscoped rule behaves exactly as before, so the
   * default is byte-identical to pre-A4. PRECEDENCE: mode scoping is a further
   * AND-condition on the rule MATCH — it composes with subject/server/tool
   * scoping, is additive-only (it can narrow which restrictions apply, never
   * mint an allow), and matched rules keep their existing fixed evaluation
   * order (data-scope → rate-limit → approval) unchanged.
   */
  deployContext?: readonly string[] | null;
  /**
   * ADR-0040: the ABAC verdict the gateway computed for this call from the
   * active Cedar policy set. See AbacDecision — allow-path only, never grants,
   * absent = byte-identical to the pre-ADR-0040 kernel.
   */
  // `| undefined` is explicit (not merely `?:`) because the gateway builds this
  // input with spreads and conditional fields under exactOptionalPropertyTypes:
  // "the deployment has no ABAC policies" must be expressible as a plain
  // undefined, not only as an omitted key.
  abacDecision?: AbacDecision | null | undefined;
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
  /** the approver's display name, when the rule carried one */
  approverName?: string | null;
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
  | "lead-ceiling"
  /** ADR-0040: an attribute-conditional Cedar policy forbade (or paused) the call */
  | "abac-forbid"
  | "default-deny";

export const DEFAULT_DENY_RULE_ID = "default-deny";

/**
 * Reference label for reason strings: "'name' (id8…)" when the caller passed
 * a display name in, otherwise the bare quoted id (exactly the old format).
 * Display names are INPUTS — the kernel stays pure and does no lookups — and
 * they only touch prose: ruleId, ruleChain, and every stored id field keep
 * full ids for auditability.
 */
function refLabel(id: string, name?: string | null): string {
  return name ? `'${name}' (${id.slice(0, 8)}…)` : `'${id}'`;
}

function matchesScope(ruleToolName: string | null, toolName: string): boolean {
  return ruleToolName === null || ruleToolName === toolName;
}

/**
 * PILLAR 1 rule scoping — the SUBJECT half of a restriction rule's match. The
 * gateway already pre-filtered role/team/fleet rules to those this user
 * matches (by assigned role, team membership, or fleet-wide), so the kernel
 * only re-checks the one scope it must never widen: a 'user'-scoped rule (or a
 * legacy rule with no scope) still binds to exactly its own user id, so one
 * user's user-specific restriction can never bleed onto another. This is
 * additive-only: it can never turn a default-deny into an allow.
 */
function ruleAppliesToSubject(r: { userId?: string | null; scope?: RuleScope }, userId: string): boolean {
  return (r.scope ?? "user") === "user" ? r.userId === userId : true;
}

/**
 * The SERVER half: an all-servers rule (serverScope 'all', serverId null)
 * matches every server; otherwise the rule's server must be this server. A
 * legacy rule (no serverScope, serverId set) keeps the exact old behaviour.
 */
function ruleAppliesToServer(
  r: { serverId?: string | null; serverScope?: RuleServerScope },
  serverId: string,
): boolean {
  return (r.serverScope ?? "server") === "all" ? true : r.serverId === serverId;
}

/**
 * A4: the DEPLOY-MODE half of a restriction rule's match. A mode-unscoped rule
 * (deployMode null/absent — every pre-A4 rule) matches every call, exactly as
 * before. A mode-scoped rule matches only when the call's server-derived
 * context set contains that mode; with no derivable context (null/empty) it
 * does not match — a restriction binds to a KNOWN context, and the context is
 * server-derived so "unknown" means "not deploy-scoped work", never a client
 * dodging the rule. Additive-only by construction: consulted only while
 * matching RESTRICTIONS, so it can never turn a deny into an allow.
 */
function ruleAppliesToDeployMode(
  r: { deployMode?: RuleDeployMode | null },
  deployContext: readonly string[] | null | undefined,
): boolean {
  if (r.deployMode == null) return true;
  return (deployContext ?? []).includes(r.deployMode);
}

/**
 * Additive audit prose naming the scope a restriction matched by — empty for a
 * plain per-user, per-server rule so every legacy reason string is byte-
 * identical, non-empty for a role/team/fleet or all-servers rule.
 */
function scopeReason(r: {
  scope?: RuleScope;
  serverScope?: RuleServerScope;
  roleId?: string | null;
  teamId?: string | null;
  deployMode?: RuleDeployMode | null;
}): string {
  const parts: string[] = [];
  const scope = r.scope ?? "user";
  if (scope === "fleet") parts.push("fleet-wide rule");
  else if (scope === "role") parts.push(`role-scoped rule (role ${refLabel(r.roleId ?? "?")})`);
  else if (scope === "team") parts.push(`team-scoped rule (team ${refLabel(r.teamId ?? "?")})`);
  if ((r.serverScope ?? "server") === "all") parts.push("all servers");
  // A4: name the deploy mode a mode-scoped restriction bound to. Mode-unscoped
  // rules add nothing, so every legacy reason string stays byte-identical.
  if (r.deployMode != null) parts.push(`deploy-mode ${r.deployMode}`);
  return parts.length ? ` [${parts.join(", ")}]` : "";
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
 * The approval-rule MATCH predicate, extracted so there is exactly one.
 *
 * `evaluate` uses it to find the rule that pauses a call; ADR-0104's gateway
 * matcher uses it to read the strictest `approvalScope` across the rules that
 * bound THIS call, so "which rules govern this approval" is one answer computed
 * once, not two answers that can disagree. Order is preserved: the first
 * element is the rule `evaluate` reports as the pausing rule, exactly as the
 * previous `.find` did.
 */
export function matchingApprovalRules(
  rules: readonly ApprovalRule[],
  ctx: {
    userId: string;
    serverId: string;
    tool: ToolRef;
    deployContext?: readonly string[] | null | undefined;
  },
): ApprovalRule[] {
  return rules.filter(
    (r) =>
      ruleAppliesToSubject(r, ctx.userId) &&
      ruleAppliesToServer(r, ctx.serverId) &&
      ruleAppliesToDeployMode(r, ctx.deployContext ?? null) &&
      matchesScope(r.toolName, ctx.tool.name) &&
      (!r.writeOnly || ctx.tool.kind === "write"),
  );
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
  // prose labels only — every id field below still carries the full id
  const serverRef = refLabel(serverId, input.serverName);
  const userRef = refLabel(userId, input.userName);
  const chain: RuleTrace[] = [];

  let grantId: string | undefined;
  let grantReason = "";

  // A revocation only ever suppresses ROLE-DERIVED entitlements (§5): direct
  // user grants are themselves per-user overrides and always survive.
  // O9 (ADR-0027): a 'read_only'-scoped revocation suppresses WRITE-classified
  // tools only — a read stays allowed. A FULL revocation (the default, and
  // every pre-O9 row) beats everything, so precedence is otherwise unchanged:
  // when both match, full governs.
  const revocationFor = (toolName: string | null): Revocation | undefined => {
    const matching = (input.revocations ?? []).filter(
      (r) =>
        r.userId === userId &&
        r.serverId === serverId &&
        (r.toolName === null || r.toolName === toolName),
    );
    const full = matching.find((r) => (r.scope ?? "full") === "full");
    if (full) return full;
    return tool.kind === "write"
      ? matching.find((r) => r.scope === "read_only")
      : undefined;
  };

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
    grantReason = `tool '${tool.name}' on server ${serverRef} is on user's allow-list`;
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
          `tool '${tool.name}' on server ${serverRef} is on the allow-list of ` +
          `assigned role ${refLabel(roleToolGrant.roleId, roleToolGrant.roleName)}`;
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
      grantReason = `read-only tool '${tool.name}' allowed by user's read-all grant on server ${serverRef}`;
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
            `${refLabel(roleServerGrant.roleId, roleServerGrant.roleName)} on server ${serverRef}`;
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
      reason: `no grant matches user ${userRef}, server ${serverRef}, tool '${tool.name}' — default-deny`,
    };
  }

  // §5.1 Team-Lead ceiling: the call is GRANTED, but a lead chain further up
  // may forbid this tool. A ceiling only NARROWS — it is consulted only after a
  // grant was found (so it can never rescue an ungranted call), and it takes
  // precedence over data-scope/rate-limit/approval since a tool the lead
  // forbids is forbidden regardless of those. Absent = no lead constraint.
  if (input.ceilingTools != null) {
    if (!input.ceilingTools.includes(tool.name)) {
      chain.push({ rule: "lead-ceiling", outcome: "deny" });
      return {
        effect: "deny",
        ruleId: "lead-ceiling",
        ruleChain: chain,
        reason:
          `tool '${tool.name}' on server ${serverRef} is granted to user ${userRef} but excluded ` +
          `by the Team-Lead delegation ceiling for this worker`,
      };
    }
    chain.push({ rule: "lead-ceiling", outcome: "allow" });
  }

  // ADR-0040 ABAC. Reached ONLY on the allow path — an ungranted call already
  // returned default-deny above, so a Cedar policy can never rescue it; ABAC
  // can only subtract. Positioned exactly like the lead ceiling (and, on the
  // agent/connector paths, the ADR-0019 revocations): a call an
  // attribute-conditional policy forbids is forbidden regardless of data
  // scope, rate limits or approvals, so the forbid is terminal here. The
  // "require approval" mode is NOT terminal here — it is folded into the ONE
  // approval step below, so an ABAC-paused call rides the SAME §3 Approvals
  // Queue as a rule-paused one rather than a parallel mechanism.
  // Absent input (no active policies) pushes NOTHING: byte-identical to today.
  const abac = input.abacDecision ?? null;
  if (abac && abac.effect === "forbid") {
    const policyId = abac.policyId ?? "abac-forbid";
    chain.push({ rule: "abac-forbid", outcome: "deny", grantId: policyId });
    return {
      effect: "deny",
      ruleId: policyId,
      ruleChain: chain,
      reason:
        `tool '${tool.name}' on server ${serverRef} is granted to user ${userRef} but forbidden ` +
        `by ABAC policy ${refLabel(policyId, abac.policyName)}` +
        (abac.policyVersion != null ? ` (v${abac.policyVersion})` : "") +
        (abac.reason ? ` — ${abac.reason}` : ""),
    };
  }

  // PILLAR 1: the rule set arrives already scope-filtered by the gateway, so
  // the kernel match collapses the subject/server dimensions through the two
  // helpers (which keep legacy per-user, per-server rules identical) and adds
  // the tool dimension. Every matching rule across every scope must be
  // satisfied — the widened set composes to the INTERSECTION of allow-lists.
  const scopeRules = (input.dataScopeRules ?? []).filter(
    (r) =>
      ruleAppliesToSubject(r, userId) &&
      ruleAppliesToServer(r, serverId) &&
      ruleAppliesToDeployMode(r, input.deployContext) &&
      matchesScope(r.toolName, tool.name),
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

  // PILLAR 1: widened rate limits each keep their own per-subject count/window
  // (the gateway counts each independently). The first exhausted one denies —
  // tightest-wins with no summing and no cross-scope relaxation.
  const exhaustedLimit = (input.rateLimits ?? []).find(
    (l) =>
      ruleAppliesToSubject(l, userId) &&
      ruleAppliesToServer(l, serverId) &&
      ruleAppliesToDeployMode(l, input.deployContext) &&
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

  // ADR-0040: an ABAC policy in "require approval" mode pauses the call —
  // through the SAME §3 Approvals Queue, satisfied by the SAME already-approved
  // entry, producing the same require_approval effect. It is checked here (one
  // step ahead of the rule-driven approvals below) because it is the more
  // specific, attribute-conditional statement; when no ABAC policy applies this
  // block is skipped entirely and the approval path is byte-identical to today.
  // FAIL CLOSED: a require_approval verdict with no approver is unusable (there
  // is nobody to route the queue entry to), so it degrades to a DENY rather
  // than quietly letting the call through.
  if (abac && abac.effect === "require_approval") {
    const policyId = abac.policyId ?? "abac-forbid";
    if (!abac.approverUserId) {
      chain.push({ rule: "abac-forbid", outcome: "deny", grantId: policyId });
      return {
        effect: "deny",
        ruleId: policyId,
        ruleChain: chain,
        reason:
          `ABAC policy ${refLabel(policyId, abac.policyName)} requires approval for this call but ` +
          `names no approver — failing closed`,
      };
    }
    if (input.approvedApprovalId) {
      chain.push({
        rule: "abac-forbid",
        outcome: "satisfied-by-approval",
        grantId: input.approvedApprovalId,
      });
    } else {
      chain.push({ rule: "abac-forbid", outcome: "require-approval", grantId: policyId });
      return {
        effect: "require_approval",
        ruleId: policyId,
        ruleChain: chain,
        reason:
          `call to '${tool.name}' on server ${serverRef} requires sign-off by approver ` +
          `${refLabel(abac.approverUserId, abac.approverName)} under ABAC policy ` +
          `${refLabel(policyId, abac.policyName)}` +
          (abac.policyVersion != null ? ` (v${abac.policyVersion})` : "") +
          (abac.reason ? ` — ${abac.reason}` : ""),
        approverUserId: abac.approverUserId,
        ...(abac.approverName ? { approverName: abac.approverName } : {}),
      };
    }
  }

  // PILLAR 1: first matching approval rule across any scope pauses the call —
  // a broader fleet/role/team rule requires sign-off just as a user rule does.
  // The MATCH itself lives in `matchingApprovalRules` (above) because ADR-0104
  // needs the same predicate outside the kernel, to read the strictest
  // `approvalScope` off exactly the rules that bound this call. Two copies of
  // that predicate could drift into governing different rule sets.
  const approvalRule = matchingApprovalRules(input.approvalRules ?? [], {
    userId,
    serverId,
    tool,
    deployContext: input.deployContext,
  })[0];
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
          `call to '${tool.name}' on server ${serverRef} requires sign-off by ` +
          `approver ${refLabel(approvalRule.approverUserId, approvalRule.approverName)}` +
          // additive: name WHICH scope paused the call so the audit distinguishes
          // a fleet approval from a user one. Legacy/user rules read exactly as before.
          scopeReason(approvalRule),
        approverUserId: approvalRule.approverUserId,
        ...(approvalRule.approverName ? { approverName: approvalRule.approverName } : {}),
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
  /** optional display name — used in reason prose only, the id stays authoritative */
  name?: string | null;
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

/**
 * §5 role-derived agent entitlement — the AGENT twin of RoleAgentGrant's MCP
 * cousin (RoleToolGrant). Shape-identical to AgentGrant minus userId (the
 * gateway pre-filters these to the user's assigned roles), plus roleId and an
 * optional roleName for reason prose only. A role grant confers no more than a
 * direct grant would: the same allowedModes narrowing and the per-user tier
 * ceiling still apply on top.
 */
export interface RoleAgentGrant {
  id: string;
  roleId: string;
  /** optional display name for the role — reason prose only */
  roleName?: string | null;
  agentId: string;
  allowedModes: string[] | null;
}

/**
 * ADR-0019 §5 subtractive per-user override for AGENTS — the agent twin of the
 * MCP `Revocation`. A revocation is TOTAL for its (user, agent): it beats a
 * direct grant AND every role-derived grant, because agent entitlement composes
 * as UNION-MAX (ADR-0014) and there would otherwise be no way to subtract one
 * agent from one user short of unassigning the whole role.
 *
 * THE INVARIANT: a revocation can ONLY turn an allow into a deny. It is
 * consulted strictly on the allow path (after a grant has been found), so it
 * can never rescue an ungranted call — that is default-denied first and the
 * revocation is never even looked at.
 */
export interface AgentRevocation {
  id: string;
  userId: string;
  agentId: string;
  /** admin's justification — reason prose only, never a policy input */
  reason?: string | null;
}

/** ADR-0019: the CONNECTOR twin of AgentRevocation. Same allow-path-only
 * invariant. O9 (ADR-0027) partial scope: 'full' (default, incl. absent =
 * every pre-O9 row) denies every operation; 'read_only' denies WRITES only —
 * reads stay allowed. A full revocation still beats everything. Agent
 * revocations stay total: agents carry no read/write op classification to
 * scope by. */
export interface ConnectorRevocation {
  id: string;
  userId: string;
  connectorId: string;
  reason?: string | null;
  scope?: "full" | "read_only" | null;
}

export interface EvaluateAgentInput {
  userId: string;
  /** optional display name for the user — reason prose only */
  userName?: string | null;
  agent: AgentRef;
  /** the mode being invoked (e.g. "plan", "execute") */
  mode: string;
  agentGrants: readonly AgentGrant[];
  /** role-derived agent grants, pre-filtered by the gateway to the user's assigned roles */
  roleAgentGrants?: readonly RoleAgentGrant[];
  /** ADR-0019 per-user revocations, pre-filtered by the gateway to this user.
   * Consulted ONLY after a grant was found, so it can only ever deny. */
  agentRevocations?: readonly AgentRevocation[];
  /** tier of the user's ceiling agent (§4); null/undefined = no ceiling set */
  ceilingTier?: number | null;
  /**
   * §5.1 Team-Lead delegation ceiling: when a worker node runs under a lead,
   * the gateway passes the intersected allow-list of agent ids its lead chain
   * permits. A non-null value only ever NARROWS — an agent the user is granted
   * whose id is not in the set is denied; it can never rescue an ungranted
   * agent (that is default-denied first). Null/undefined = no lead ceiling.
   */
  ceilingAgentIds?: readonly string[] | null;
}

export type AgentRuleName =
  | "agent-registry-enabled"
  | "agent-allow-list"
  | "role-agent-allow-list"
  | "agent-revoked"
  | "agent-mode"
  | "agent-ceiling"
  | "agent-lead-ceiling"
  | "default-deny";

export interface AgentRuleTrace {
  rule: AgentRuleName;
  outcome: "allow" | "deny" | "no-match";
  /** the matched grant id — or, for an "agent-revoked" deny, the revocation id */
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
  const agentRef = refLabel(agent.id, agent.name);
  const chain: AgentRuleTrace[] = [];

  if (!agent.enabled) {
    chain.push({ rule: "agent-registry-enabled", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: "agent-registry-enabled",
      ruleChain: chain,
      reason: `agent ${agentRef} is disabled platform-wide in the registry`,
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
      reason: `mode '${mode}' is not a declared mode of agent ${agentRef}`,
    };
  }

  // §5 grant precedence: a direct user grant wins; only if none exists is a
  // role-derived grant consulted (pre-filtered by the gateway to the user's
  // assigned roles). A role grant is purely ADDITIVE — the mode check and the
  // per-user tier ceiling below still run against it unchanged, so it can never
  // confer more than a direct grant would. ADR-0019: a per-user AGENT
  // revocation then bounds the result — see the revocation check below the
  // default-deny return, where it can only ever subtract.
  const direct = input.agentGrants.find((g) => g.userId === userId && g.agentId === agent.id);
  const roleGrant = direct
    ? undefined
    : (input.roleAgentGrants ?? []).find((g) => g.agentId === agent.id);
  const grant = direct ?? roleGrant;
  if (!grant) {
    chain.push({ rule: "agent-allow-list", outcome: "no-match" });
    chain.push({ rule: "default-deny", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: chain,
      reason: `agent ${agentRef} is not on user ${refLabel(userId, input.userName)}'s allow-list — default-deny`,
    };
  }
  chain.push(
    roleGrant
      ? { rule: "role-agent-allow-list", outcome: "allow", grantId: grant.id }
      : { rule: "agent-allow-list", outcome: "allow", grantId: grant.id },
  );

  // ADR-0019 PER-USER REVOCATION. Reached ONLY on the allow path — an agent
  // with no grant at all already returned default-deny above, so this can
  // never rescue an ungranted call; it can only subtract. It beats BOTH the
  // direct and the role grant (unlike the MCP `revocations` table, which is
  // role-only): agent entitlement composes as UNION-MAX (ADR-0014), so a
  // revocation that spared direct grants would leave an admin unable to take
  // one agent away from one user. Precedence mirrors the lead ceiling: checked
  // before mode/tier/lead, because a revoked agent is revoked regardless.
  // Absent input = no revocations = byte-identical to the pre-ADR-0019 path.
  const agentRevocation = (input.agentRevocations ?? []).find(
    (r) => r.userId === userId && r.agentId === agent.id,
  );
  if (agentRevocation) {
    chain.push({ rule: "agent-revoked", outcome: "deny", grantId: agentRevocation.id });
    return {
      effect: "deny",
      ruleId: "agent-revoked",
      ruleChain: chain,
      reason:
        `agent ${agentRef} is granted to user ${refLabel(userId, input.userName)} ` +
        `but revoked for them by per-user revocation ${refLabel(agentRevocation.id)}` +
        (agentRevocation.reason ? ` — ${agentRevocation.reason}` : ""),
    };
  }

  if (grant.allowedModes !== null && !grant.allowedModes.includes(mode)) {
    chain.push({ rule: "agent-mode", outcome: "deny", grantId: grant.id });
    return {
      effect: "deny",
      ruleId: grant.id,
      ruleChain: chain,
      reason: `mode '${mode}' of agent ${agentRef} is not in the grant's allowed modes`,
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
        `agent ${agentRef} (tier ${agent.tier}) exceeds user's ceiling ` +
        `(tier ${input.ceilingTier})`,
    };
  }
  chain.push({ rule: "agent-ceiling", outcome: "no-match" });

  // §5.1 Team-Lead ceiling: the agent is granted and within the user's tier
  // ceiling, but a lead chain may exclude it. Only NARROWS — reached only on
  // the allow path (an ungranted agent was default-denied above), so it can
  // never widen. Absent = no lead constraint (a flat run).
  if (input.ceilingAgentIds != null) {
    if (!input.ceilingAgentIds.includes(agent.id)) {
      chain.push({ rule: "agent-lead-ceiling", outcome: "deny" });
      return {
        effect: "deny",
        ruleId: "agent-lead-ceiling",
        ruleChain: chain,
        reason:
          `agent ${agentRef} is granted to the user but excluded by the Team-Lead ` +
          `delegation ceiling for this worker`,
      };
    }
    chain.push({ rule: "agent-lead-ceiling", outcome: "allow" });
  }

  return {
    effect: "allow",
    ruleId: grant.id,
    ruleChain: chain,
    reason: roleGrant
      ? `agent ${agentRef} mode '${mode}' allowed by the grant of assigned role ` +
        `${refLabel(roleGrant.roleId, roleGrant.roleName)}`
      : `agent ${agentRef} mode '${mode}' allowed by user's agent grant`,
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

/**
 * §5 role-derived connector entitlement — the CONNECTOR twin of RoleAgentGrant.
 * Shape-identical to ConnectorGrant minus userId (pre-filtered to the user's
 * assigned roles by the gateway), plus roleId and an optional roleName for
 * reason prose only.
 */
export interface RoleConnectorGrant {
  id: string;
  roleId: string;
  /** optional display name for the role — reason prose only */
  roleName?: string | null;
  connectorId: string;
  mode: "read" | "readwrite";
  allowedObjects: string[] | null;
}

export interface EvaluateConnectorInput {
  userId: string;
  /** optional display names — reason prose only */
  userName?: string | null;
  connectorName?: string | null;
  connectorId: string;
  operation: "read" | "write";
  /** the object/table/folder the call targets, when the caller specifies one */
  object?: string | null;
  connectorGrants: readonly ConnectorGrant[];
  /** role-derived connector grants, pre-filtered by the gateway to the user's assigned roles */
  roleConnectorGrants?: readonly RoleConnectorGrant[];
  /** ADR-0019 per-user revocations, pre-filtered by the gateway to this user.
   * Consulted ONLY after a candidate grant was found, so it can only deny. */
  connectorRevocations?: readonly ConnectorRevocation[];
}

export type ConnectorRuleName =
  | "connector-allow-list"
  | "role-connector-allow-list"
  | "connector-revoked"
  | "connector-mode"
  | "connector-object-scope"
  | "default-deny";

export interface ConnectorRuleTrace {
  rule: ConnectorRuleName;
  outcome: "allow" | "deny" | "no-match";
  /** the matched grant id — or, for a "connector-revoked" deny, the revocation id */
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
  const connectorRef = refLabel(connectorId, input.connectorName);
  const chain: ConnectorRuleTrace[] = [];

  // §5 UNION-OF-GRANTS (ADR-0014). Unlike the boolean MCP kernel, connector
  // entitlement is the UNION of the user's direct grants and their role-derived
  // grants for this connector — NOT direct-first short-circuit. A narrow direct
  // grant must never MASK a broader role grant (that would reduce a user's
  // entitlement below what assigning the role confers). So: gather every
  // candidate, ALLOW if ANY single candidate satisfies BOTH the mode
  // requirement and the object scope, and deny only when NONE does. Candidates
  // are ordered direct-first purely for stable deny prose. When no role grants
  // are passed there is exactly one candidate and every trace/return below is
  // byte-identical to the pre-§5 direct-only path.
  //
  // ADR-0019: a per-user CONNECTOR revocation then bounds the union — checked
  // below, strictly after a candidate was found, so it can only subtract.
  type ConnectorCandidate = { grant: ConnectorGrant; role?: RoleConnectorGrant };
  const candidates: ConnectorCandidate[] = [
    ...input.connectorGrants
      .filter((g) => g.userId === userId && g.connectorId === connectorId)
      .map((g) => ({ grant: g })),
    ...(input.roleConnectorGrants ?? [])
      .filter((g) => g.connectorId === connectorId)
      .map((role) => ({
        grant: {
          id: role.id,
          userId,
          connectorId: role.connectorId,
          mode: role.mode,
          allowedObjects: role.allowedObjects,
        } as ConnectorGrant,
        role,
      })),
  ];

  if (candidates.length === 0) {
    chain.push({ rule: "connector-allow-list", outcome: "no-match" });
    chain.push({ rule: "default-deny", outcome: "deny" });
    return {
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: chain,
      reason: `connector ${connectorRef} is not on user ${refLabel(userId, input.userName)}'s allow-list — default-deny`,
    };
  }

  // ADR-0019 PER-USER REVOCATION. Reached ONLY after at least one candidate
  // grant exists (the candidate-free case default-denied above), so it can
  // never rescue an ungranted connector — only subtract. It beats BOTH direct
  // and role grants, for the same UNION-MAX reason as the agent path. A
  // revocation is TOTAL: there is no partial (read-only) revocation, because
  // narrowing a grant is what editing the grant is for — a revocation must be
  // an unambiguous, auditable "this user may not use this connector at all".
  // Absent input = byte-identical to the pre-ADR-0019 path.
  // O9 (ADR-0027): a FULL revocation (default, incl. every pre-O9 row) denies
  // every operation exactly as before; a 'read_only'-scoped revocation denies
  // WRITES only — a read proceeds to the ordinary grant checks. When both
  // exist, full governs (a full revocation still beats everything).
  const matchingRevocations = (input.connectorRevocations ?? []).filter(
    (r) => r.userId === userId && r.connectorId === connectorId,
  );
  const fullRevocation = matchingRevocations.find((r) => (r.scope ?? "full") === "full");
  const partialRevocation = matchingRevocations.find((r) => r.scope === "read_only");
  const connectorRevocation =
    fullRevocation ?? (operation === "write" ? partialRevocation : undefined);
  if (connectorRevocation) {
    chain.push({ rule: "connector-revoked", outcome: "deny", grantId: connectorRevocation.id });
    return {
      effect: "deny",
      ruleId: "connector-revoked",
      ruleChain: chain,
      reason:
        connectorRevocation.scope === "read_only"
          ? `write to connector ${connectorRef} denied: per-user revocation ` +
            `${refLabel(connectorRevocation.id)} is scoped read_only — reads stay allowed` +
            (connectorRevocation.reason ? ` — ${connectorRevocation.reason}` : "")
          : `connector ${connectorRef} is granted to user ${refLabel(userId, input.userName)} ` +
            `but revoked for them by per-user revocation ${refLabel(connectorRevocation.id)}` +
            (connectorRevocation.reason ? ` — ${connectorRevocation.reason}` : ""),
    };
  }

  const modeSatisfied = (g: ConnectorGrant) => !(operation === "write" && g.mode === "read");
  const objectSatisfied = (g: ConnectorGrant) => {
    if (g.allowedObjects === null) return true;
    const object = input.object ?? null;
    return object !== null && g.allowedObjects.includes(object);
  };
  // The first candidate satisfying BOTH dimensions wins (direct-first). When
  // none does, fall back to the first (direct) candidate so the deny reason is
  // stable and direct-first — running the exact original single-grant checks
  // below against it reproduces the pre-§5 deny trace byte-for-byte.
  // candidates is non-empty here (the length-0 case returned above), so the
  // fallback index is always defined.
  const winner: ConnectorCandidate =
    candidates.find((c) => modeSatisfied(c.grant) && objectSatisfied(c.grant)) ?? candidates[0]!;
  const grant = winner.grant;
  chain.push({
    rule: winner.role ? "role-connector-allow-list" : "connector-allow-list",
    outcome: "allow",
    grantId: grant.id,
  });

  if (operation === "write" && grant.mode === "read") {
    chain.push({ rule: "connector-mode", outcome: "deny", grantId: grant.id });
    return {
      effect: "deny",
      ruleId: grant.id,
      ruleChain: chain,
      reason: `write to connector ${connectorRef} denied: grant is read-only`,
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
            ? `connector ${connectorRef} grant is object-scoped and no object was named — fails closed`
            : `object '${object}' is outside the grant's allowed objects for connector ${connectorRef}`,
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
    reason: winner.role
      ? `${operation} on connector ${connectorRef} allowed by the grant of assigned role ` +
        `${refLabel(winner.role.roleId, winner.role.roleName)}`
      : `${operation} on connector ${connectorRef} allowed by user's connector grant`,
  };
}
