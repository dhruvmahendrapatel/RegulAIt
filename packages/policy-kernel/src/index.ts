export type ToolKind = "read" | "write";
export type DecisionEffect = "allow" | "deny" | "require_approval";

// ---------------------------------------------------------------------------
// ADR-0124 — THE KILL SWITCH AND SAFE MODES
// ---------------------------------------------------------------------------
//
// WHY THIS LIVES IN THE KERNEL, FIRST, AND AS A REQUIRED INPUT.
//
// An emergency stop is only worth having if it cannot be bypassed. There are
// three governed entry points — `evaluate` (MCP tools), `evaluateAgent` (model
// dispatch) and `evaluateConnector` — and every effectful path in the product
// reaches one of them. Putting the check inside those three, ahead of every
// other rule, means a new caller inherits it without knowing it exists.
//
// `execution` is a REQUIRED field on all three inputs, deliberately. It could
// have been optional with a safe default, and that is exactly the shape that
// rots: a future call site omits it, the deployment believes it is halted, and
// one path keeps running. Required means the COMPILER enumerates the call
// sites, now and for every call site added later. That is the whole design.
//
// The kernel stays pure: it is handed the resolved posture and decides. It
// never reads a database, so "is this deployment halted?" is resolved once, by
// the gateway, in one helper.

/**
 * What the deployment is permitted to execute, as ONE dial with four
 * positions. Ordered from permissive to restrictive.
 *
 *  - `normal`            what every deployment ships as. Nothing is added to
 *                        any decision — an upgrade changes no behaviour.
 *  - `read_only`         reads pass, writes are refused. The "safe degradation"
 *                        an operator wants when something is wrong but the
 *                        business still needs answers.
 *  - `require_approval`  nothing executes unattended: anything that would have
 *                        been allowed becomes an approval request instead. The
 *                        work is not lost, it is queued behind a human.
 *  - `halted`            the kill switch. Every governed call is refused.
 */
export const EXECUTION_MODES = ["normal", "read_only", "require_approval", "halted"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * Agent modes that do not mutate anything, so `read_only` lets them through.
 * This is the vocabulary ADR-0059's plan-only stages already used; it lives
 * here now because it is a POLICY judgement about what counts as a write, and
 * two copies of that judgement would eventually disagree.
 */
export const PLAN_SAFE_MODES = ["plan", "review", "chat", "ask", "read"] as const;
const PLAN_SAFE = new Set<string>(PLAN_SAFE_MODES);
/** the ONE definition of "this agent mode does not mutate anything" */
export function isPlanSafeMode(mode: string): boolean {
  return PLAN_SAFE.has(mode.trim().toLowerCase());
}

/**
 * An individual subject stopped on its own, without stopping the deployment.
 * ISACA asks for "global AND per-capability kill switches" for a good reason:
 * an incident confined to one tool should not cost you the business.
 */
export interface SubjectHalt {
  readonly scope: "agent" | "tool";
  /** what the subject is, for the refusal prose */
  readonly label: string;
  /** REQUIRED — an emergency stop with no stated reason is an outage of
   * unknown cause, and the person who lifts it is usually not the person who
   * threw it. */
  readonly reason: string;
  readonly haltedAt: string;
}

/**
 * The resolved posture for ONE evaluation. Built by the gateway from
 * `org_settings` plus the subject's own row; handed to the kernel whole.
 */
export interface ExecutionPosture {
  readonly mode: ExecutionMode;
  /**
   * Who signs off while `require_approval` is set. REQUIRED for that mode and
   * meaningless for the others.
   *
   * "Nothing runs unattended" has to say who is attending: `approvals` has a
   * NOT NULL approver, and an approval nobody is named on is one nobody is
   * accountable for deciding. The route refuses to set the mode without one.
   */
  readonly approverUserId?: string | null;
  /** set when THIS agent or tool is individually halted. Independent of
   * `mode`: a halted tool is refused even while the deployment is `normal`. */
  readonly subjectHalt?: SubjectHalt | null;
  /**
   * ADR-0182 (D4) A14 — THE AI LITERACY SLOT. Whether the human behind this
   * call must be current on an applicable published AI policy or training,
   * and whether they are. Absent means `LITERACY_NOT_REQUIRED`, so every call
   * site that builds a posture without it keeps today's decision exactly.
   *
   * P0 adds the slot only; nothing in the kernel reads it yet. A14 fills it in
   * `governed-evaluate.ts` and adds the refusal (`ai-literacy-not-current`).
   */
  readonly literacy?: LiteracyPosture;
}

/** ADR-0182 A14 — a person's literacy standing for one governed call */
export interface LiteracyPosture {
  /** true when at least one published, applicable document exists for them
   * AND the org's literacy gate is not off */
  readonly required: boolean;
  /** every applicable document acknowledged at its current version, unexpired */
  readonly current: boolean;
  /** what is missing, for the refusal prose (document titles or keys) */
  readonly missing?: readonly string[];
  /** `warn` records and allows; `enforce` refuses (A14) */
  readonly mode?: "warn" | "enforce";
  /** ADR-0182 A14 — set when the person WOULD be refused but the request came through a break-glass session
   * (`required` is then false). Recorded on the decision's trace so the exemption is audited, never silent. */
  readonly exemption?: "break_glass";
}

/** the default literacy posture: nothing is required, so nothing changes */
export const LITERACY_NOT_REQUIRED: LiteracyPosture = Object.freeze({ required: false, current: true });

/** the literacy posture of an execution posture, defaulted (ADR-0182 P0) */
export function literacyOf(execution: ExecutionPosture): LiteracyPosture {
  return execution.literacy ?? LITERACY_NOT_REQUIRED;
}

/** ADR-0182 A14 — the refusal's stable rule id (shared `AI_LITERACY_NOT_CURRENT` is the same string) */
export const LITERACY_RULE_ID = "ai-literacy-not-current";

/**
 * ADR-0182 A14 — THE LITERACY GATE. Pure.
 *
 * Refuses when the person behind the call must be current on an applicable published AI policy or training
 * (`required`), is not (`current` false), and the org's gate is `enforce` (an absent mode reads as `enforce`: the
 * strict default). `warn` never refuses here; `evaluate` records the gap on the decision's trace instead. The
 * reason names the documents, so the person knows exactly what to acknowledge.
 *
 * Who is exempt (platform sweeps, evaluation dispatches, the bootstrap identity, break-glass) is decided by the
 * gateway, which then hands the kernel `LITERACY_NOT_REQUIRED`; the kernel never looks anything up.
 */
export function literacyGate(
  execution: ExecutionPosture,
  subjectLabel: string,
): { effect: "deny"; ruleId: string; reason: string } | null {
  const l = literacyOf(execution);
  if (!l.required || l.current || (l.mode ?? "enforce") !== "enforce") return null;
  const missing = l.missing?.length ? l.missing.join("; ") : "an applicable AI policy or training";
  return {
    effect: "deny",
    ruleId: LITERACY_RULE_ID,
    reason:
      `${subjectLabel} was refused because the person it runs for has not acknowledged the current version of: ` +
      `${missing}. The organisation requires this before governed calls, as one of its measures to support the ` +
      "development of AI literacy (Regulation (EU) 2024/1689, Article 4, as amended). Acknowledge it under " +
      "Account > AI policies; nothing was executed or billed.",
  };
}

/** ADR-0182 A14 — the rule a break-glass exemption is traced under */
export const LITERACY_BREAK_GLASS_RULE_ID = "ai-literacy-break-glass-exempt";

/**
 * ADR-0182 A14 — what the literacy slot adds to a decision's TRACE (never to its effect): under `warn`, the gap
 * (`ai-literacy-not-current`, outcome `no-match`: the rule looked and did not refuse); under a break-glass
 * exemption, the exemption (`ai-literacy-break-glass-exempt`, outcome `allow`). Prepended, because the literacy
 * check runs first. The caller's audit row stores the trace, so both are audited.
 */
function literacyTrace(execution: ExecutionPosture):
  | { rule: "ai-literacy-not-current"; outcome: "no-match" }
  | { rule: "ai-literacy-break-glass-exempt"; outcome: "allow" }
  | null {
  const l = literacyOf(execution);
  if (l.exemption === "break_glass") return { rule: LITERACY_BREAK_GLASS_RULE_ID, outcome: "allow" };
  if (l.required && !l.current && l.mode === "warn") return { rule: LITERACY_RULE_ID, outcome: "no-match" };
  return null;
}

/** the stable rule ids an operator alerts on — one per reason, never shared */
export const EXECUTION_RULE_IDS = {
  halted: "execution-halted",
  subjectHalted: "execution-subject-halted",
  readOnly: "execution-read-only",
  requireApproval: "execution-require-approval",
} as const;

/**
 * THE GATE. Pure, and the same three lines of reasoning on every path.
 *
 * Returns the effect this posture forces, or `null` to mean "this posture has
 * nothing to say — carry on with the ordinary rules". It never turns a deny
 * into an allow: it is consulted first and can only ever restrict, so no
 * posture can widen what a grant permits.
 *
 * `isWrite` is the caller's read/write classification for the specific action:
 * a tool's `kind`, a connector's `operation`, or whether an agent's mode is
 * plan-safe. That judgement belongs to the path; the arithmetic belongs here.
 */
/**
 * A rule trace records `allow` / `deny` / `no-match`, and a `require_approval`
 * gate is none of those — it is a deny of UNATTENDED execution. It traces as
 * `deny` so the chain stays readable, while the DECISION carries
 * `require_approval`; the effect and the trace answer different questions and
 * the queue reads the effect.
 */
function traceOutcome(effect: DecisionEffect): "allow" | "deny" {
  return effect === "allow" ? "allow" : "deny";
}

export function executionGate(
  execution: ExecutionPosture,
  isWrite: boolean,
  subjectLabel: string,
  /**
   * Can THIS path queue a per-call approval?
   *
   * Only the MCP tool path can: `evaluate` returns `require_approval` and the
   * proxy queues it. `AgentDecision` and `ConnectorDecision` cannot even
   * EXPRESS the effect — their unions are `allow | deny` — and their routes
   * have no per-call approval queue to hand the work to.
   *
   * So `require_approval` mode REFUSES on those two paths, and says why. That
   * asymmetry is real and is surfaced on the dial itself rather than left to
   * be discovered during an incident: a mode that silently denied where it
   * claimed to queue would be worse than not offering the mode.
   */
  canQueue: boolean,
  /**
   * AER-017: true when the CALLER goes on to resolve entitlement itself, and so
   * will consult `executionApprovalHold` after its own denials. Only the
   * conditional `require_approval` hold is withheld; every STOP is returned
   * either way, because a stop is free to run first and must.
   *
   * Defaults to false so the two paths that cannot queue — model dispatch and
   * connector calls — are untouched: for them `require_approval` mode is a
   * refusal, which is a stop, and belongs here.
   */
  stopsOnly = false,
): { effect: DecisionEffect; ruleId: string; reason: string; approverUserId?: string } | null {
  // A SUBJECT HALT OUTRANKS THE DIAL. It is narrower and more specific, and an
  // operator who stopped one tool during an incident means it regardless of
  // what the deployment as a whole is doing.
  const halt = execution.subjectHalt;
  if (halt) {
    return {
      effect: "deny",
      ruleId: EXECUTION_RULE_IDS.subjectHalted,
      reason:
        `${halt.scope} ${halt.label} is HALTED (since ${halt.haltedAt}): ${halt.reason}. ` +
        "This is an emergency stop on this one subject, not a missing grant — the rest of the " +
        "deployment is unaffected, and lifting it is an audited admin action.",
    };
  }

  // ADR-0182 A14 — after the hard stops (a halt names the bigger problem), before the conditional
  // `require_approval` hold: a person who must first acknowledge an AI policy is refused, not queued.
  const literacyStop = () => literacyGate(execution, subjectLabel);

  switch (execution.mode) {
    case "halted":
      return {
        effect: "deny",
        ruleId: EXECUTION_RULE_IDS.halted,
        reason:
          `this deployment is HALTED — every governed call is refused, including ${subjectLabel}. ` +
          "Nothing was executed and nothing was billed. Reading the audit trail, the approvals " +
          "queue and the posture page is unaffected, so the halt can be investigated and lifted.",
      };
    case "read_only":
      // reads pass untouched — that is the entire point of a safe mode
      if (!isWrite) return literacyStop();
      return {
        effect: "deny",
        ruleId: EXECUTION_RULE_IDS.readOnly,
        reason:
          `this deployment is in READ-ONLY mode and ${subjectLabel} is a write. Reads continue to ` +
          "be served; nothing that changes state is executed.",
      };
    case "require_approval": {
      const refusedForLiteracy = literacyStop();
      if (refusedForLiteracy) return refusedForLiteracy;
      if (canQueue) {
        // AER-017 — THE HOLD IS NOT A STOP, AND MUST NOT BE RETURNED FROM HERE
        // WHEN THE CALLER WILL EVALUATE ENTITLEMENT.
        //
        // `halted`, a subject halt and `read_only` can only ever DENY, which is
        // why ADR-0124 was right to run them ahead of every grant, rule, limit
        // and scope. `require_approval` is different in kind: it is a
        // CONDITIONAL ALLOW, the one effect this function can return that leads
        // to execution. Returned before entitlement is resolved it produced two
        // defects at once — an ungranted caller was invited into the approvals
        // queue (approval manufacturing entitlement, which `evaluate`'s own
        // docstring forbids), and the approval could never be consumed, because
        // this early return sits in front of the consume logic. Operators
        // approved work that could not run, forever.
        //
        // So a caller that resolves entitlement (`stopsOnly`) gets NOTHING here
        // and consults `executionApprovalHold` after its denials. A caller that
        // cannot queue still gets the refusal below, because that IS a stop.
        if (stopsOnly) return null;
        return {
          effect: "require_approval",
          ruleId: EXECUTION_RULE_IDS.requireApproval,
          ...(execution.approverUserId ? { approverUserId: execution.approverUserId } : {}),
          reason:
            "this deployment requires human approval for every governed call, including " +
            `${subjectLabel}. Nothing runs unattended while this mode is set; the call is queued, ` +
            "not refused.",
        };
      }
      return {
        effect: "deny",
        ruleId: EXECUTION_RULE_IDS.requireApproval,
        reason:
          `this deployment requires human approval for every governed call, and ${subjectLabel} ` +
          "is on a path with NO per-call approval queue — model dispatch and connector reads " +
          "cannot be queued for sign-off the way an MCP tool call or a connector write can. It is therefore REFUSED " +
          "rather than queued. Use read-only mode instead if reads should keep flowing.",
      };
    }
    case "normal":
      return literacyStop();
  }
}

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
  /**
   * ADR-0124 — REQUIRED. The resolved kill-switch / safe-mode posture for this
   * evaluation. Required rather than optional so the compiler, not a reviewer,
   * guarantees every call site supplies it.
   */
  execution: ExecutionPosture;
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
  /** ADR-0124 — the kill switch and safe modes, consulted before every other
   * rule. Four distinct names so an operator can alert on each reason
   * separately: a deployment-wide stop is a different event from one tool
   * being pulled. */
  | "execution-halted"
  | "execution-subject-halted"
  | "execution-read-only"
  | "execution-require-approval"
  /** ADR-0182 A14 — the person behind the call is not current on an applicable AI policy or training */
  | "ai-literacy-not-current"
  /** ADR-0182 A14 — not current, but the request came through a break-glass session (traced, never refused) */
  | "ai-literacy-break-glass-exempt"
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
 * AER-017 — the deployment-wide approval HOLD, evaluated after entitlement.
 *
 * Returns the descriptor when the dial is set to `require_approval`, or null.
 * It is deliberately a separate function from `executionGate` rather than a
 * mode of it: the gate answers "must this stop before we even look?", and this
 * answers "does an otherwise-ALLOWED call still need a human?". Collapsing the
 * two is what produced AER-017.
 *
 * FAIL CLOSED on a missing approver, exactly as ADR-0040's ABAC hold does: a
 * hold with nobody to route the queue entry to is unusable, and degrading it to
 * a DENY is the only reading that does not let the call through.
 */
export function executionApprovalHold(
  execution: ExecutionPosture,
): { approverUserId: string } | { unusable: true } | null {
  if (execution.mode !== "require_approval") return null;
  if (!execution.approverUserId) return { unusable: true };
  return { approverUserId: execution.approverUserId };
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
  const decision = evaluateTool(input);
  // ADR-0182 A14 — `warn` or a break-glass exemption: decided exactly as without the gate, traced first
  const t = literacyTrace(input.execution);
  return t ? { ...decision, ruleChain: [t, ...decision.ruleChain] } : decision;
}

function evaluateTool(input: EvaluationInput): Decision {
  // ADR-0124 — FIRST, ahead of every grant, rule, limit and scope. A stop that
  // ran after entitlement resolution would still be a stop, but it would also
  // be one more thing to get right in the wrong order later.
  const toolLabel = `tool '${input.tool.name}'`;
  // AER-017: `stopsOnly` — the STOPS keep ADR-0124's ordering and run ahead of
  // everything, because they can only deny. The conditional `require_approval`
  // hold is evaluated further down, after this function has resolved the
  // entitlement it is a restriction ON.
  const gated = executionGate(input.execution, input.tool.kind === "write", toolLabel, true, true);
  if (gated) {
    return {
      effect: gated.effect,
      ruleId: gated.ruleId,
      ruleChain: [{ rule: gated.ruleId as RuleName, outcome: traceOutcome(gated.effect) }],
      reason: gated.reason,
      // carried through so the queued approval names a real human — see
      // ExecutionPosture.approverUserId
      ...(gated.approverUserId ? { approverUserId: gated.approverUserId } : {}),
    };
  }

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

  // AER-017 — THE DEPLOYMENT-WIDE HOLD, and note where it sits.
  //
  // AFTER every denial (grants, data scope, rate limits, an ABAC forbid) so the
  // dial can only ever restrict a call the rest of the policy would have
  // allowed: an ungranted, over-limit, out-of-scope or forbidden call is denied
  // and never offered a queue. BEFORE the other holds so that during an incident
  // the reason an operator reads is the dial they just turned, which is the most
  // actionable thing on the screen.
  //
  // One human sign-off per call satisfies whichever hold is checked first, which
  // is the pre-existing contract for the ABAC hold and the approval rules and is
  // unchanged here — "nothing runs unattended while this mode is set" is
  // satisfied by one attendant, not by one per rule that happens to match.
  const executionHold = executionApprovalHold(input.execution);
  if (executionHold) {
    if ("unusable" in executionHold) {
      chain.push({ rule: "execution-require-approval", outcome: "deny" });
      return {
        effect: "deny",
        ruleId: EXECUTION_RULE_IDS.requireApproval,
        ruleChain: chain,
        reason:
          "this deployment requires human approval for every governed call but names no " +
          "approver, so there is nobody to route the queue entry to — failing closed. Set an " +
          "approver on the execution dial, or use read-only mode.",
      };
    }
    if (input.approvedApprovalId) {
      chain.push({
        rule: "execution-require-approval",
        outcome: "satisfied-by-approval",
        grantId: input.approvedApprovalId,
      });
    } else {
      chain.push({ rule: "execution-require-approval", outcome: "require-approval" });
      return {
        effect: "require_approval",
        ruleId: EXECUTION_RULE_IDS.requireApproval,
        ruleChain: chain,
        reason:
          "this deployment requires human approval for every governed call, including " +
          `${toolLabel}. Nothing runs unattended while this mode is set; the call is queued, ` +
          "not refused.",
        approverUserId: executionHold.approverUserId,
      };
    }
  }

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
      evaluate({
        userId,
        serverId,
        tool,
        ...entitlements,
        /**
         * ADR-0124 — VISIBILITY IS NOT EXECUTION, and this one deliberately
         * ignores the dial.
         *
         * Visibility answers "what is this user entitled to?". The dial
         * answers "may it run right now?". Evaluating discovery under a halt
         * would empty every tool list, which looks exactly like entitlements
         * having been revoked — the worst possible thing to show an operator
         * mid-incident. A halted deployment still shows you what you hold and
         * refuses to run it, naming the halt in the refusal.
         */
        execution: { mode: "normal" },
      }).effect !== "deny",
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
  /**
   * ADR-0124 — REQUIRED. The resolved kill-switch / safe-mode posture for this
   * evaluation. Required rather than optional so the compiler, not a reviewer,
   * guarantees every call site supplies it.
   */
  execution: ExecutionPosture;
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
  /** ADR-0124 — the kill switch and safe modes, consulted before every other
   * rule. Four distinct names so an operator can alert on each reason
   * separately: a deployment-wide stop is a different event from one tool
   * being pulled. */
  | "execution-halted"
  | "execution-subject-halted"
  | "execution-read-only"
  | "execution-require-approval"
  /** ADR-0182 A14 — the person behind the call is not current on an applicable AI policy or training */
  | "ai-literacy-not-current"
  /** ADR-0182 A14 — not current, but the request came through a break-glass session (traced, never refused) */
  | "ai-literacy-break-glass-exempt"
  | "agent-registry-enabled"
  | "agent-allow-list"
  | "role-agent-allow-list"
  | "agent-revoked"
  | "agent-mode"
  | "agent-ceiling"
  | "agent-lead-ceiling"
  /** ADR-0173 §3 — the org's model allow-list matrix, applied AFTER this
   * kernel allowed (by the gateway's shared model-access decision); it can
   * only turn an allow into a deny */
  | "model-feature-policy"
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
  const decision = evaluateAgentInner(input);
  // ADR-0182 A14 — the same literacy trace as the tool path
  const t = literacyTrace(input.execution);
  return t ? { ...decision, ruleChain: [t, ...decision.ruleChain] } : decision;
}

function evaluateAgentInner(input: EvaluateAgentInput): AgentDecision {
  const { userId, agent, mode } = input;
  const agentRef = refLabel(agent.id, agent.name);
  const chain: AgentRuleTrace[] = [];

  // ADR-0124 — ahead of the registry-enabled check and everything after it.
  // A dispatch is a write when its MODE mutates: `plan`/`review`/`chat` reason
  // about the world, `execute` acts on it. Read-only mode therefore still
  // answers questions, which is the point of a safe mode rather than a stop.
  const gatedAgent = executionGate(input.execution, !isPlanSafeMode(mode), `agent ${agentRef}`, false);
  if (gatedAgent) {
    chain.push({ rule: gatedAgent.ruleId as AgentRuleName, outcome: traceOutcome(gatedAgent.effect) });
    return {
      // never `require_approval` here — `canQueue: false` above rules it out
      effect: gatedAgent.effect === "require_approval" ? "deny" : gatedAgent.effect,
      ruleId: gatedAgent.ruleId,
      ruleChain: chain,
      reason: gatedAgent.reason,
    };
  }

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
  /**
   * ADR-0124 — REQUIRED. The resolved kill-switch / safe-mode posture for this
   * evaluation. Required rather than optional so the compiler, not a reviewer,
   * guarantees every call site supplies it.
   */
  execution: ExecutionPosture;
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
  /**
   * ADR-0173 batch 2b — the caller CAN queue a connector WRITE for sign-off.
   * Absent (every evaluation-only caller): the pre-2b contract, under which
   * the execution dial's `require_approval` mode REFUSES every connector call.
   * Present: a WRITE is resolved for entitlement first and only then held for
   * approval (AER-017's order, the same as the MCP path), and
   * `approvedApprovalId` names a bound, fresh consent the caller already found
   * for this exact call. A READ keeps the refusal either way.
   */
  writeApprovalQueue?: { approvedApprovalId: string | null };
}

export type ConnectorRuleName =
  /** ADR-0124 — the kill switch and safe modes, consulted before every other
   * rule. Four distinct names so an operator can alert on each reason
   * separately: a deployment-wide stop is a different event from one tool
   * being pulled. */
  | "execution-halted"
  | "execution-subject-halted"
  | "execution-read-only"
  | "execution-require-approval"
  /** ADR-0182 A14 — the person behind the call is not current on an applicable AI policy or training */
  | "ai-literacy-not-current"
  /** ADR-0182 A14 — not current, but the request came through a break-glass session (traced, never refused) */
  | "ai-literacy-break-glass-exempt"
  | "connector-allow-list"
  | "role-connector-allow-list"
  | "connector-revoked"
  | "connector-mode"
  | "connector-object-scope"
  | "default-deny";

export interface ConnectorRuleTrace {
  rule: ConnectorRuleName;
  outcome: "allow" | "deny" | "no-match" | "require-approval" | "satisfied-by-approval";
  /** the matched grant id — or, for a "connector-revoked" deny, the revocation id
   * — or, for a write released by a consent, the approval id */
  grantId?: string;
}

export interface ConnectorDecision {
  /** `require_approval` only when the caller passed `writeApprovalQueue` */
  effect: "allow" | "deny" | "require_approval";
  ruleId: string;
  ruleChain: ConnectorRuleTrace[];
  reason: string;
  /** set when effect is require_approval: who must sign off */
  approverUserId?: string;
}

/**
 * §2: per-user connector grant → read/write mode → object-level data scope
 * (fail closed when scoped and no object is named) → allow.
 */
export function evaluateConnector(input: EvaluateConnectorInput): ConnectorDecision {
  const decision = evaluateConnectorInner(input);
  // ADR-0182 A14 — the same literacy trace as the tool path
  const t = literacyTrace(input.execution);
  return t ? { ...decision, ruleChain: [t, ...decision.ruleChain] } : decision;
}

function evaluateConnectorInner(input: EvaluateConnectorInput): ConnectorDecision {
  // ADR-0124 — the connector path's own copy of the same first question. The
  // read/write classification is already on the wire here (`operation`), so a
  // read-only deployment keeps serving reads through connectors too.
  // ADR-0173 batch 2b: a caller that can queue a WRITE resolves entitlement
  // first and consults the hold afterwards (`stopsOnly`), exactly as the MCP
  // path does since AER-017 — so an approval can never manufacture a grant.
  const queueable = !!input.writeApprovalQueue && input.operation === "write";
  const gatedConnector = executionGate(
    input.execution,
    input.operation === "write",
    `connector ${refLabel(input.connectorId, input.connectorName)} (${input.operation})`,
    queueable,
    queueable,
  );
  if (gatedConnector) {
    return {
      effect: gatedConnector.effect === "require_approval" ? "deny" : gatedConnector.effect,
      ruleId: gatedConnector.ruleId,
      ruleChain: [{ rule: gatedConnector.ruleId as ConnectorRuleName, outcome: traceOutcome(gatedConnector.effect) }],
      reason: gatedConnector.reason,
    };
  }

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

  // ADR-0173 batch 2b — THE DEPLOYMENT-WIDE HOLD on a queueable WRITE, after
  // every denial above (an ungranted, read-only, revoked or out-of-scope write
  // is denied and never offered a queue). Fails closed with no approver.
  if (queueable) {
    const hold = executionApprovalHold(input.execution);
    if (hold) {
      if ("unusable" in hold) {
        chain.push({ rule: "execution-require-approval", outcome: "deny" });
        return {
          effect: "deny",
          ruleId: EXECUTION_RULE_IDS.requireApproval,
          ruleChain: chain,
          reason:
            "this deployment requires human approval for every governed call but names no " +
            "approver, so there is nobody to route the queue entry to — failing closed. Set an " +
            "approver on the execution dial, or use read-only mode.",
        };
      }
      const approvedId = input.writeApprovalQueue!.approvedApprovalId;
      if (approvedId) {
        chain.push({ rule: "execution-require-approval", outcome: "satisfied-by-approval", grantId: approvedId });
      } else {
        chain.push({ rule: "execution-require-approval", outcome: "require-approval" });
        return {
          effect: "require_approval",
          ruleId: EXECUTION_RULE_IDS.requireApproval,
          ruleChain: chain,
          approverUserId: hold.approverUserId,
          reason:
            `this deployment requires human approval for every governed call; the write to connector ` +
            `${connectorRef} is QUEUED for sign-off, bound to its exact arguments — nothing ran.`,
        };
      }
    }
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
