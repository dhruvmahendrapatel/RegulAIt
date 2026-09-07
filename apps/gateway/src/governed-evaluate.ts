import {
  and,
  approvalRules,
  asc,
  approvals,
  auditLog,
  count,
  dataScopeRules,
  deployTargets,
  eq,
  gte,
  inArray,
  mcpServers,
  or,
  rateLimits,
  users,
  workflowInstances,
  type Db,
  type PgColumn,
  type SQL,
} from "@regulait/db";
import { evaluate, matchingApprovalRules, type Decision, type ToolRef } from "@regulait/policy-kernel";
import {
  approvalArgumentsDigest,
  effectiveApprovalScope,
  type ApprovalScope,
} from "@regulait/shared";
import { loadEntitlements, loadScopeMemberships } from "./entitlements.js";
import { evaluateAbacForToolCall, loadActiveAbacPolicies, type AbacPrincipalContext } from "./abac.js";
import {
  applyRuleVersions,
  loadVersionsForArtifacts,
  recordCanaryFailure,
  recordCanaryObservations,
  type CandidateNote,
} from "./rule-versions.js";

/**
 * PILLAR 1 rule scoping: the SQL pre-filter that widens a rule load from the
 * old exact (userId, serverId) match to every scope this user matches, exactly
 * mirroring how roleToolGrants is already pre-filtered. The kernel then stays
 * subject-free — it re-checks only the user-scope id it must never widen.
 *
 * Subject: fleet always, user rules for THIS user, role rules for the user's
 * assigned roles, team rules for the user's teams. Server: all-servers rules
 * plus this-server rules. Empty roleIds/teamIds simply drop their OR arm, so
 * an `IN ()` is never emitted.
 */
function scopedRuleWhere(
  cols: {
    scope: PgColumn;
    serverScope: PgColumn;
    userId: PgColumn;
    roleId: PgColumn;
    teamId: PgColumn;
    serverId: PgColumn;
  },
  userId: string,
  serverId: string,
  roleIds: string[],
  teamIds: string[],
): SQL {
  const subject: SQL[] = [
    eq(cols.scope, "fleet"),
    and(eq(cols.scope, "user"), eq(cols.userId, userId))!,
  ];
  if (roleIds.length) subject.push(and(eq(cols.scope, "role"), inArray(cols.roleId, roleIds))!);
  if (teamIds.length) subject.push(and(eq(cols.scope, "team"), inArray(cols.teamId, teamIds))!);
  return and(or(...subject)!, or(eq(cols.serverScope, "all"), eq(cols.serverId, serverId))!)!;
}

export interface GovernedEvaluation {
  decision: Decision;
  /** the approved Approvals-Queue row this evaluation relied on, if any */
  approvedApprovalId: string | null;
  /**
   * ADR-0104: the consent fingerprint of THIS call — sha256 over the canonical
   * `{projectId, arguments}`. Computed here, once, so the queue writer, the
   * audit writer and this matcher can never hash different bytes. Returned
   * unconditionally (it is recorded on the audit row whatever the scope, which
   * is the forensic half of ADR-0104 and independent of the consent half).
   */
  argumentsDigest: string;
  /**
   * ADR-0104: the STRICTEST `approval_scope` across the approval rules that
   * actually matched this call — 'action' when any of them binds consent to the
   * payload, 'tool' only when every matching rule opts out. With no matching
   * approval rule it is the default, 'action'. The caller uses it to decide
   * whether the pending-entry dedup must also key on the digest.
   */
  approvalScope: ApprovalScope;
}

/** the workflow statuses under which attributed work is still "landing on" its
 * deploy targets — terminal instances no longer bind a mode context */
const TERMINAL_INSTANCE_STATUSES = ["completed", "denied", "aborted", "rolled_back"];

/**
 * A4 (ADR-0027): derive the SERVER-SIDE deploy context of an attributed call —
 * the set of deploy-target modes the project's in-flight workflow instances'
 * deployment/rollback stages name. This is "the deploy target the change lands
 * on" from ADR-0019's A4 assessment, made concrete: never client-asserted, a
 * SET because one project can be in flight toward targets of different modes
 * at once. An unattributed call, a project with no in-flight instances, or
 * instances whose stages name no (existing) deploy target all derive [] — and
 * a mode-scoped rule then simply does not match (the kernel's documented
 * fail-closed-for-restrictions-bound-to-a-known-context precedence).
 * Exported for tests.
 */
export async function deriveDeployContext(db: Db, projectId: string): Promise<string[]> {
  const instances = await db
    .select({ definition: workflowInstances.definition, status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.projectId, projectId));
  const connections = new Set<string>();
  for (const inst of instances) {
    if (TERMINAL_INSTANCE_STATUSES.includes(inst.status)) continue;
    const stages = (inst.definition as { stages?: Array<{ type?: string; connection?: string }> })
      ?.stages;
    for (const stage of stages ?? []) {
      if ((stage.type === "deployment" || stage.type === "rollback") && stage.connection) {
        connections.add(stage.connection);
      }
    }
  }
  if (connections.size === 0) return [];
  const targets = await db
    .select({ mode: deployTargets.mode })
    .from(deployTargets)
    .where(inArray(deployTargets.name, [...connections]));
  return [...new Set(targets.map((t) => t.mode))];
}

/**
 * Full §3 evaluation: grants + rate limits (usage counted from audit-log
 * allow rows inside each limit's window) + approval rules, including any
 * already-approved queue entry for exactly this user/server/tool. Pure
 * decision only — callers own auditing, queue writes, and consumption.
 */
export async function governedEvaluate(
  db: Db,
  userId: string,
  serverId: string,
  tool: ToolRef,
  args?: Record<string, unknown>,
  /** §5.1 Team-Lead ceiling: the tool NAMES this worker's lead chain permits.
   * null/undefined = no lead constraint. Only ever narrows a granted call. */
  ceilingTools?: readonly string[] | null,
  /** A4: pillar-5 attribution of this call, used ONLY to derive the deploy
   * context for mode-scoped rules — and only lazily, when a loaded rule
   * actually carries a deployMode, so the default path costs nothing. */
  projectId?: string | null,
  /** ADR-0040: the session facts the ABAC principal bag needs (origin,
   * authentication strength). Supplied by the route, because a session is a
   * property of the REQUEST, not of the user. Absent = the honest 'unknown'
   * defaults, never a silently-strong claim. */
  principal?: AbacPrincipalContext,
): Promise<GovernedEvaluation> {
  // PILLAR 1 rule scoping: resolve the user's role/team memberships first, then
  // widen every rule load from the exact (userId, serverId) match to every
  // scope this user matches. The kernel receives a pre-filtered set and stays
  // subject-free — it re-checks only the user-scope id it must never widen.
  const { roleIds, teamIds } = await loadScopeMemberships(db, userId);
  const [entitlements, aRules, limits, scopeRules, approvedRows, serverRows] = await Promise.all([
    loadEntitlements(db, userId, serverId),
    db
      .select()
      .from(approvalRules)
      .where(
        scopedRuleWhere(
          {
            scope: approvalRules.scope,
            serverScope: approvalRules.serverScope,
            userId: approvalRules.userId,
            roleId: approvalRules.roleId,
            teamId: approvalRules.teamId,
            serverId: approvalRules.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    db
      .select()
      .from(rateLimits)
      .where(
        scopedRuleWhere(
          {
            scope: rateLimits.scope,
            serverScope: rateLimits.serverScope,
            userId: rateLimits.userId,
            roleId: rateLimits.roleId,
            teamId: rateLimits.teamId,
            serverId: rateLimits.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    db
      .select()
      .from(dataScopeRules)
      .where(
        scopedRuleWhere(
          {
            scope: dataScopeRules.scope,
            serverScope: dataScopeRules.serverScope,
            userId: dataScopeRules.userId,
            roleId: dataScopeRules.roleId,
            teamId: dataScopeRules.teamId,
            serverId: dataScopeRules.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    // ADR-0104 — the CANDIDATE approved rows, not "the" approved row.
    //
    // This used to be a `.limit(1)` with no ORDER BY, which under Postgres is
    // an arbitrary row. It now loads the candidates and lets the payload-
    // binding rules below pick, because which row satisfies depends on the
    // governing rules' `approval_scope` — and those are loaded in this same
    // batch, so the choice cannot be made in SQL here without a second round
    // trip. `requestedAt` ASC makes the pick deterministic (oldest consent
    // first, FIFO) instead of storage-order-dependent. The cap is a safety
    // bound on a queue that in practice holds a handful of approved,
    // unconsumed rows per user/server/tool — consumption is single-use, so
    // they do not accumulate.
    db
      .select({ id: approvals.id, argumentsDigest: approvals.argumentsDigest })
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.serverId, serverId),
          eq(approvals.toolName, tool.name),
          eq(approvals.status, "approved"),
        ),
      )
      .orderBy(asc(approvals.requestedAt))
      .limit(50),
    db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, serverId)),
  ]);

  // Display names for the decision's reason prose — the ids in ruleId /
  // ruleChain / stored audit fields stay authoritative, but the sentence a
  // human reads (simulation verdicts, proxy denials) names things by name.
  // ---------------------------------------------------------------------
  // ADR-0073 — RESOLVE EACH RULE THROUGH `config_versions`.
  //
  // ONE query for all three rule types (not one per rule, and not one per
  // type). A rule with no version rows resolves to its own table row, which is
  // byte-identical pre-ADR-0073 behaviour; a rule with an ACTIVE version is
  // governed by that version's body, which is what makes activating and rolling
  // back genuinely change evaluation; a rule with version rows but NO active
  // version is UNRESOLVABLE and denies below, because skipping a restriction is
  // a widening.
  //
  // `stableKey` = the calling user: a tool-call evaluation has no run or
  // conversation, and per-user stickiness is what makes a shadow sample a
  // coherent picture of one person's day rather than a scatter.
  // ---------------------------------------------------------------------
  const ruleIds = [...aRules.map((r) => r.id), ...limits.map((l) => l.id), ...scopeRules.map((r) => r.id)];
  const versionMap = await loadVersionsForArtifacts(
    db,
    ["approval_rule", "rate_limit", "data_scope_rule"],
    ruleIds,
  );
  const aResolved = applyRuleVersions("approval_rule", aRules, versionMap, userId);
  const limitsResolved = applyRuleVersions("rate_limit", limits, versionMap, userId);
  const scopeResolved = applyRuleVersions("data_scope_rule", scopeRules, versionMap, userId);
  const unresolvable = [
    ...aResolved.unresolvable.map((u) => ({ ...u, artifactType: "approval_rule" as const })),
    ...limitsResolved.unresolvable.map((u) => ({ ...u, artifactType: "rate_limit" as const })),
    ...scopeResolved.unresolvable.map((u) => ({ ...u, artifactType: "data_scope_rule" as const })),
  ];

  // DEFAULT-DENY SURVIVES VERSION RESOLUTION. There is no branch anywhere above
  // or below on which "I could not find the active version" ends in an allow.
  if (unresolvable.length > 0) {
    const first = unresolvable[0]!;
    return {
      decision: {
        effect: "deny",
        ruleId: "config-version-unresolvable",
        ruleChain: [{ rule: "default-deny", outcome: "deny", grantId: first.artifactId }],
        reason:
          `governance configuration is in an indeterminate state and the call is refused rather than ` +
          `evaluated without it: ${first.reason}` +
          (unresolvable.length > 1 ? ` (and ${unresolvable.length - 1} more)` : ""),
      },
      approvedApprovalId: null,
      // ADR-0104: the fingerprint is a fact about the CALL, not about the
      // decision, so it is still reported on a refusal — the audit row for an
      // indeterminate-config deny records which payload was attempted.
      argumentsDigest: approvalArgumentsDigest({
        projectId: projectId ?? null,
        arguments: args,
      }),
      approvalScope: "action",
    };
  }

  const servedARules = aResolved.served;
  const servedLimits = limitsResolved.served;
  const servedScopeRules = scopeResolved.served;

  // Display names for the decision's reason prose — the ids in ruleId /
  // ruleChain / stored audit fields stay authoritative, but the sentence a
  // human reads (simulation verdicts, proxy denials) names things by name.
  // The CANDIDATE's approvers are looked up too, so a shadow observation's
  // stored reason reads the same way the served one would.
  const nameIds = [
    ...new Set([
      userId,
      ...servedARules.map((r) => r.approverUserId),
      ...(aResolved.candidate ?? []).map((r) => r.approverUserId),
    ]),
  ];
  const nameRows = nameIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, nameIds))
    : [];
  const nameOf = new Map(nameRows.map((u) => [u.id, u.displayName || u.email]));

  // Each widened limit keeps its OWN per-subject count/window (no summing).
  // The count is always this user's allowed calls in the window; an
  // all-servers limit counts across every server, a server-scoped one stays
  // pinned to this server (identical to the legacy behaviour).
  const countFor = async (l: { serverScope: string; toolName: string | null; windowSeconds: number }) => {
    const windowStart = new Date(Date.now() - l.windowSeconds * 1000);
    const conditions = [
      eq(auditLog.userId, userId),
      eq(auditLog.effect, "allow"),
      gte(auditLog.at, windowStart),
    ];
    if (l.serverScope !== "all") conditions.push(eq(auditLog.serverId, serverId));
    if (l.toolName) conditions.push(eq(auditLog.toolName, l.toolName));
    const [row] = await db
      .select({ value: count() })
      .from(auditLog)
      .where(and(...conditions));
    return Number(row?.value ?? 0);
  };

  const limitsWithCounts = await Promise.all(
    servedLimits.map(async (l) => ({ ...l, currentCount: await countFor(l) })),
  );

  // ---------------------------------------------------------------------
  // ADR-0104 — APPROVAL PAYLOAD BINDING.
  //
  // The fingerprint of the call being evaluated, computed ONCE here from the
  // RAW arguments (pre-scrub) and the pillar-5 attribution. Everything
  // downstream — the queue row, the audit row, this match — uses this exact
  // string, so the writer and the matcher cannot hash different bytes.
  const argumentsDigest = approvalArgumentsDigest({
    projectId: projectId ?? null,
    arguments: args,
  });

  // A4: derive the deploy context ONLY when some loaded rule is mode-scoped —
  // zero extra queries on the default path (no mode-scoped rules = today).
  // The CANDIDATE rows are consulted too: a candidate that ADDS a deploy-mode
  // scope must be shadowed against a real deploy context, not against null.
  const modeScopedIn = (rows: Array<{ deployMode: string | null }>) =>
    rows.some((r) => r.deployMode != null);
  const anyModeScoped =
    modeScopedIn(servedARules) ||
    modeScopedIn(servedLimits) ||
    modeScopedIn(servedScopeRules) ||
    modeScopedIn(aResolved.candidate ?? []) ||
    modeScopedIn(limitsResolved.candidate ?? []) ||
    modeScopedIn(scopeResolved.candidate ?? []);
  const deployContext =
    anyModeScoped && projectId ? await deriveDeployContext(db, projectId) : null;

  // ADR-0104 — STRICTEST-WINS over the rules that actually MATCHED this call,
  // using the kernel's own match predicate (not a second copy of it). Any
  // matching action-scoped rule makes the whole consent action-scoped; no
  // matching approval rule at all -> the default, 'action'. This is sited AFTER
  // `deployContext` deliberately: a mode-scoped approval rule must be judged
  // against the real derived context, exactly as the kernel judges it, or a
  // rule that does bind this call could be skipped when reading its scope.
  const approvalScope = effectiveApprovalScope(
    matchingApprovalRules(servedARules, { userId, serverId, tool, deployContext }),
  );

  // WHICH approved row satisfies this call.
  //
  //   * an exact fingerprint match always satisfies, under either scope;
  //   * under 'tool' scope any approved row satisfies, including one carrying a
  //     different payload's digest (that IS the escape hatch) and including a
  //     legacy row with no digest at all;
  //   * under 'action' scope nothing else satisfies. A row for different
  //     arguments is a different consent, and a legacy row (NULL digest,
  //     queued before migration 0106) is a consent that was never bound to a
  //     payload — neither can stand in. The call re-queues instead, and the
  //     re-queued row is born with a digest, so the gap closes itself. This is
  //     fail-closed, and it is a real upgrade-day behaviour change; ADR-0104
  //     states it rather than hiding it.
  const exactMatch = approvedRows.find((r) => r.argumentsDigest === argumentsDigest);
  const approvedApprovalId =
    exactMatch?.id ?? (approvalScope === "tool" ? (approvedRows[0]?.id ?? null) : null);

  // ADR-0040 ABAC. The policy-set load is ONE indexed query, and an install
  // with no active policies stops there: `abacDecision` stays null, the kernel
  // receives an ABSENT input, and the decision is byte-identical to the
  // pre-ADR-0040 behaviour. Only when a policy is actually active do we pay for
  // assembling the attribute bags — the same lazy discipline A4's deploy
  // context already follows above.
  //
  // The attributes are assembled HERE, never inside the kernel: the kernel
  // stays a pure function of its inputs, which is what lets the simulation
  // surface reproduce a decision exactly.
  const abacPolicies = await loadActiveAbacPolicies(db);
  const abacDecision = abacPolicies.length
    ? await evaluateAbacForToolCall(
        db,
        {
          userId,
          serverId,
          toolName: tool.name,
          toolKind: tool.kind,
          projectId: projectId ?? null,
          // the rate signal already computed at this call site — highest
          // consumption across the limits that bind this call
          rateLimitUsagePct: limitsWithCounts.reduce((max, l) => {
            const pct = l.maxCalls > 0 ? Math.floor((l.currentCount * 100) / l.maxCalls) : 0;
            return Math.max(max, Math.min(100, pct));
          }, 0),
          ...(principal ? { principal } : {}),
        },
        abacPolicies,
      )
    : null;

  /** the kernel call, parameterised ONLY by the three rule sets — so the served
   * pass and the shadow pass differ in the rule bodies and in NOTHING ELSE.
   * Anything else varying between them would make a divergence unattributable
   * to the version change it is supposed to measure. */
  const evaluateWith = (
    rules: typeof servedARules,
    limitRows: typeof limitsWithCounts,
    scopes: typeof servedScopeRules,
  ) =>
    evaluate({
      userId,
      serverId,
      userName: nameOf.get(userId) ?? null,
      serverName: serverRows[0]?.name ?? null,
      tool,
      ...entitlements,
      approvalRules: rules.map((r) => ({
        ...r,
        approverName: nameOf.get(r.approverUserId) ?? null,
      })),
      rateLimits: limitRows,
      dataScopeRules: scopes,
      args,
      approvedApprovalId,
      ceilingTools: ceilingTools ?? null,
      deployContext,
      abacDecision,
    });

  // THE SERVED DECISION. Computed to completion, from the ACTIVE bodies alone,
  // BEFORE any shadow work starts. Everything after this point is measurement.
  const decision = evaluateWith(servedARules, limitsWithCounts, servedScopeRules);

  // ---------------------------------------------------------------------
  // ADR-0073 §2 — THE SHADOW PASS.
  //
  // The candidate is evaluated in parallel and recorded. It cannot reach the
  // return value: `decision` is already bound, and the whole block is wrapped
  // so that a candidate which THROWS produces a recorded failure and a
  // completely unchanged answer. A canary that can break production is worse
  // than no canary.
  // ---------------------------------------------------------------------
  const notes: CandidateNote[] = [
    ...aResolved.notes,
    ...limitsResolved.notes,
    ...scopeResolved.notes,
  ];
  if (notes.length > 0) {
    const ctx = {
      userId,
      serverId,
      toolName: tool.name,
      projectId: projectId ?? null,
      detail: { toolKind: tool.kind },
    };
    try {
      // a candidate limit may move the WINDOW or the TOOL it counts, so its
      // count is recomputed rather than inherited — inheriting it would make a
      // window change look like no change at all.
      const candidateLimits = await Promise.all(
        (limitsResolved.candidate ?? servedLimits).map(async (l) => {
          const twin = limitsWithCounts.find((s) => s.id === l.id);
          const same =
            twin != null && twin.windowSeconds === l.windowSeconds && twin.toolName === l.toolName;
          return { ...l, currentCount: same ? twin.currentCount : await countFor(l) };
        }),
      );
      const shadow = evaluateWith(
        aResolved.candidate ?? servedARules,
        candidateLimits,
        scopeResolved.candidate ?? servedScopeRules,
      );
      await recordCanaryObservations(
        db,
        notes,
        {
          servedEffect: decision.effect,
          servedRuleId: decision.ruleId,
          servedReason: decision.reason,
          candidateEffect: shadow.effect,
          candidateRuleId: shadow.ruleId,
          candidateReason: shadow.reason,
        },
        ctx,
      );
    } catch (err) {
      // deliberately broad: ANY failure of the measurement must leave the
      // served decision alone. Recording the failure is best-effort too — if
      // even that write fails there is nothing safe left to do, and the served
      // decision is still correct.
      try {
        await recordCanaryFailure(
          db,
          notes,
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          ctx,
          { effect: decision.effect, ruleId: decision.ruleId, reason: decision.reason },
        );
      } catch {
        /* the served decision is unaffected either way */
      }
    }
  }

  return { decision, approvedApprovalId, argumentsDigest, approvalScope };
}
