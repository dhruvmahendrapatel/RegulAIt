import {
  configVersions,
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
  governancePolicyEpoch,
  inArray,
  mcpServers,
  or,
  rateLimits,
  users,
  workflowInstances,
  type Db,
  type PgColumn,
  type SQL,
  sql,
} from "@regulait/db";
import { evaluate, matchingApprovalRules, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { EVALUATION_ONLY_EXECUTION, resolveExecutionPosture } from "./execution-posture.js";
import {
  NOT_ADVISORY_SQL,
  approvalArgumentsDigest,
  approvalContextDigest,
  effectiveApprovalScope,
  type ApprovalScope,
  type ApprovalTargetRef,
  type ConsentRetirementReason,
  type PreparedPiiApproval,
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
  /**
   * ADR-0105: the CONSENT-CONTEXT fingerprint of this call — sha256 over the
   * matched approval rules paired with their active `config_versions` ids, the
   * required approver, and the approval scope. Computed here, once, for the
   * same reason `argumentsDigest` is: the queue writer, the audit writer and
   * the consumption predicate must all be looking at the same bytes. Returned
   * unconditionally, including on a refusal — it is a fact about the policy
   * that governed the call, and the audit row is owed it either way.
   */
  contextDigest: string;
  /** DB policy generation read before the evaluation's policy snapshot. */
  policyEpoch: number;
  /**
   * ADR-0105: approved rows that WOULD have satisfied this call on ADR-0104's
   * payload test but were refused on the new ones — an expired consent, or one
   * granted under a policy context that has since moved. Returned as DATA, not
   * acted on: `governedEvaluate` is also the engine behind `/v1/evaluate`,
   * which must never create, consume or retire a queue entry. The ACTING path
   * (`mcp-proxy.ts`) is what supersedes them and re-queues, so a preview stays
   * a preview.
   */
  retiredApprovals: RetiredApproval[];
  /**
   * ADR-0120 — the CANDIDATE's decision for this same call, present only when
   * the caller passed `simulate`. It is what a named rule version WOULD have
   * decided, computed by the same `evaluateWith` the served decision came from,
   * so a preview can never drift from the gate. Absent on the enforcement path,
   * where a shadow is recorded rather than returned.
   */
  candidateDecision?: Decision;
  /**
   * AER-014 — present only on a REPLAY (`simulate.replay`), when a rate limit
   * that binds this call needs history the audit trail no longer holds. The
   * candidate decision is then withheld (absent), never guessed: an undercount
   * would read as "allowed" and an assumed-full window as "denied", and both
   * would be invented. The string says which limit and why.
   */
  replayIndeterminate?: string;
}

/**
 * AER-014 — THE REPLAY CLOCK. A dry run re-decides a RECORDED call, so a rate
 * limit must count what had happened BEFORE that call, not what has happened
 * before now. Absent, nothing changes: the enforcement path and `/v1/evaluate`
 * keep counting from `Date.now()` exactly as they always have.
 */
export interface ReplayClock {
  /** the recorded call's instant. A limit counts allowed calls in
   * `[asOf - window, asOf)` — strictly before, so the call never counts itself. */
  asOf: Date;
  /** the newest audit-retention prune cutoff, or null when the trail has never
   * been pruned. Rows older than it may be gone, so a window that reaches back
   * past it is TRUNCATED and the replay is indeterminate. */
  lookbackHorizon: Date | null;
  /**
   * THE ONE COUNTER A REPLAY USES. Required: a replay never falls back to the
   * live path's query. That fallback used to compare against `asOf`, a JS Date
   * truncated to the millisecond, while the batched counter compares the
   * stored microsecond timestamps, so two calls in the same millisecond
   * counted differently depending on which path ran (ADR-0179 review, finding
   * 8). `policy-simulation.ts` supplies it (`replayCounterFor` for one row,
   * `batchedAllowCounts` for a group); both run the same SQL.
   */
  countAllowed: (q: ReplayCountQuery) => Promise<number>;
}

/** the question a rate limit asks of the audit trail, in replay */
export interface ReplayCountQuery {
  /** the rate-limit row asking: the served row, or a simulated version of it */
  limitId: string;
  userId: string;
  /** null = an all-servers limit, counted across every server */
  serverId: string | null;
  toolName: string | null;
  windowSeconds: number;
  /** the asking row's ceiling. The kernel only ever compares a count against
   * the ceiling of the limit it belongs to, and ABAC's usage percentage caps
   * at 100, so a batch caller may treat every count at or above the highest
   * ceiling that reads it as one value when deduplicating evaluations. */
  maxCalls: number;
  from: Date;
  to: Date;
}

/** one stored consent this call refused to spend, and why */
export interface RetiredApproval {
  id: string;
  reason: ConsentRetirementReason;
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
  /**
   * ADR-0120 — DRY-RUN MODE. Names ONE `config_versions` row to force as the
   * candidate, regardless of its status or canary bucket, and returns its
   * decision as `candidateDecision`.
   *
   * It also SUPPRESSES the canary write. That suppression is the point: this
   * function is not otherwise side-effect free — `recordCanaryObservations`
   * inserts a row whenever a candidate exists — so a replay that called it once
   * per recorded decision would write one observation per transcript row and
   * corrupt the very canary measurements an operator is relying on. A preview
   * must execute nothing.
   */
  simulate?: { versionId: string; replay?: ReplayClock },
  preparedPii?: PreparedPiiApproval,
  /**
   * AER-039 — the upstream this call will execute against, from the SAME
   * server row the caller connects with (the proxy passes it, so the consent
   * is bound to exactly the destination that receives the bytes). Omitted =
   * derived from the current server row, for callers that never execute.
   */
  target?: ApprovalTargetRef | null,
): Promise<GovernedEvaluation> {
  if (preparedPii && preparedPii.originalArgumentsDigest !== approvalArgumentsDigest({ projectId, arguments: args })) {
    throw new Error("Prepared PII action does not match the original arguments");
  }
  const [policyGeneration] = await db.select({ epoch: governancePolicyEpoch.epoch }).from(governancePolicyEpoch);
  if (!policyGeneration) throw new Error("governance policy epoch is unavailable");
  const policyEpoch = policyGeneration.epoch;
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
      .select({
        id: approvals.id,
        argumentsDigest: approvals.argumentsDigest,
        // ADR-0105 — the two new consent facts, loaded with the candidates so
        // the freshness test happens in the same pass as the payload test and
        // cannot be forgotten by one of them.
        contextDigest: approvals.contextDigest,
        expiresAt: approvals.expiresAt,
      })
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
    db
      .select({
        name: mcpServers.name,
        url: mcpServers.url,
        allowPrivateRanges: mcpServers.allowPrivateRanges,
        admissionManifestDigest: mcpServers.admissionManifestDigest,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId)),
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
      // ADR-0105: governance is indeterminate, so there IS no governing policy
      // identity to report. The empty context is the honest answer and is
      // never stored — this branch denies before anything is queued.
      contextDigest: approvalContextDigest({
        ruleVersions: [],
        requiredApproverUserId: null,
        approvalScope: "action",
      }),
      policyEpoch,
      retiredApprovals: [],
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
  //
  // AER-014: on a REPLAY the window ends at the recorded call's instant and
  // counts only what came STRICTLY BEFORE it, answered by the replay's own
  // counter against the stored timestamps (never by the query below, whose
  // clock is a JS Date). Without a replay clock this is byte-identical to
  // before: the window starts at `Date.now() - window` and has no upper bound.
  const replay = simulate?.replay;
  const countFor = async (l: {
    id: string;
    serverScope: string;
    toolName: string | null;
    windowSeconds: number;
    maxCalls: number;
  }) => {
    const clockMs = replay ? replay.asOf.getTime() : Date.now();
    const windowStart = new Date(clockMs - l.windowSeconds * 1000);
    if (replay) {
      if (typeof replay.countAllowed !== "function") {
        throw new Error("a replay clock must carry its countAllowed counter; there is no direct replay count");
      }
      return replay.countAllowed({
        limitId: l.id,
        userId,
        serverId: l.serverScope === "all" ? null : serverId,
        toolName: l.toolName,
        windowSeconds: l.windowSeconds,
        maxCalls: l.maxCalls,
        from: windowStart,
        to: replay.asOf,
      });
    }
    const conditions = [
      eq(auditLog.userId, userId),
      eq(auditLog.effect, "allow"),
      gte(auditLog.at, windowStart),
      // ADR-0127 — count EXECUTIONS, not questions. `/v1/evaluate` and the G9
      // authorization callout answer "what would you decide" and run nothing,
      // but they wrote an `allow` row like any other, so a preview spent the
      // subject's budget on traffic that never happened and a preview followed
      // by the real call counted twice. See audit-advisory.ts for why the
      // marker lives in `detail` (it is inside the content hash) and why the
      // predicate is `IS DISTINCT FROM` (NULL detail must still count).
      sql.raw(NOT_ADVISORY_SQL),
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
  const argumentsDigest = preparedPii?.argumentsDigest ?? approvalArgumentsDigest({
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
  const matchedARules = matchingApprovalRules(servedARules, {
    userId,
    serverId,
    tool,
    deployContext,
  });
  const approvalScope = preparedPii ? "action" : effectiveApprovalScope(matchedARules);

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
  // Resolved once per governed call: org dial + this tool's own halt.
  const executionPosture = await resolveExecutionPosture(db, {
    serverId,
    toolName: tool.name,
  });

  const evaluateWith = (
    rules: typeof servedARules,
    limitRows: typeof limitsWithCounts,
    scopes: typeof servedScopeRules,
    /** ADR-0105: the consent this pass is holding. Explicit, because the
     * evaluation is run TWICE on the consent path — once holding nothing, to
     * learn who policy CURRENTLY requires as approver, and once holding the
     * row that satisfied. Defaulted so the shadow pass below is unchanged. */
    heldApprovalId: string | null = null,
  ) => {
    const evaluateArguments = (evaluatedArgs: Record<string, unknown> | undefined) => evaluate({
      userId,
      serverId,
      /**
       * ADR-0124 — the kill switch, resolved ONCE above for this call and
       * reused by both passes.
       *
       * A SIMULATION IS NOT AN EXECUTION. ADR-0120's dry run replays recorded
       * traffic through this same function to answer "what would this rule
       * do?"; reporting "denied — the deployment is halted" would answer a
       * question nobody asked and make every preview useless during the one
       * period an operator most needs to reason about policy.
       */
      execution: simulate ? EVALUATION_ONLY_EXECUTION : executionPosture,
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
      args: evaluatedArgs,
      approvedApprovalId: heldApprovalId,
      ceilingTools: ceilingTools ?? null,
      deployContext,
      abacDecision,
    });
    const original = evaluateArguments(args);
    if (!preparedPii) return original;
    const effective = evaluateArguments(preparedPii.effectiveArguments);
    const decision = original.effect === "deny" ? original : effective.effect === "deny" ? effective : original;
    // The kernel's data-scope explanation quotes the rejected raw value.
    return decision.ruleChain.some((entry) => entry.rule === "data-scope" && entry.outcome === "deny")
      ? { ...decision, reason: "Original or effective arguments are outside the allowed data scope" }
      : decision;
  };

  // ---------------------------------------------------------------------
  // ADR-0105 — WHO POLICY CURRENTLY REQUIRES, and the consent-context digest.
  //
  // The evaluation is run FIRST holding NO consent. That pass answers exactly
  // the question ADR-0105's finding says nobody was asking: "if this call
  // arrived right now with nothing signed, who would have to sign it?" Asking
  // the kernel is the only honest way to get that answer — an approval rule is
  // not the only thing that can demand an approver (ADR-0040's ABAC layer can
  // too), and re-deriving the kernel's own selection order here would be the
  // second implementation this codebase keeps refusing to write.
  //
  // It is also what breaks the circularity: the digest depends on the required
  // approver, the row selection depends on the digest, and the final decision
  // depends on the selected row. Evaluating with no consent first orders those
  // three without any of them guessing at the others.
  const pendingDecision = evaluateWith(
    servedARules,
    limitsWithCounts,
    servedScopeRules,
    null,
  );

  // The POLICY fingerprint of this call, computed ONCE. Only the rules that
  // actually MATCHED are in it, each paired with the `config_versions` row that
  // resolved it (ADR-0073) — that pairing IS the compatibility rule ADR-0105
  // states: activate a new version of a rule that binds this call and the
  // consent granted under the old one stops satisfying it; edit a rule that
  // does not bind this call and nothing moves.
  const contextDigest = approvalContextDigest({
    ruleVersions: matchedARules.map((r) => ({
      ruleId: r.id,
      activeVersionId: aResolved.activeVersionByArtifact.get(r.id) ?? null,
    })),
    abacPolicies: abacPolicies.map((p) => ({
      policyId: p.id,
      version: p.version ?? null,
      source: p.source,
    })),
    requiredApproverUserId: pendingDecision.approverUserId ?? null,
    approvalScope,
    // AER-039: the consent names WHERE the bytes go, not only what they are
    target: target ?? approvalTargetForServer(serverId, serverRows[0]),
  });

  // WHICH approved row satisfies this call.
  //
  // ADR-0104 — THE PAYLOAD TEST:
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
  //
  // ADR-0105 — THE FRESHNESS TEST, applied on top of it:
  //   * a stored `context_digest` that differs from the one just computed means
  //     the governing policy moved after the signature — the consent does not
  //     satisfy;
  //   * a NULL stored context is a legacy row and cannot authorize execution;
  //   * a stored `expires_at` in the past does not satisfy. NULL never expires
  //     — a legacy row, or an org that set the dial to NULL on purpose.
  //
  // The rows that pass the payload test and FAIL the freshness test are
  // reported as `retiredApprovals` rather than silently skipped, because
  // leaving a dead consent sitting in the queue marked `approved` is how it
  // gets found again.
  const now = Date.now();
  const satisfiesPayload = (r: (typeof approvedRows)[number]) =>
    r.argumentsDigest === argumentsDigest || approvalScope === "tool";
  const expired = (r: (typeof approvedRows)[number]) =>
    r.expiresAt != null && r.expiresAt.getTime() <= now;
  const contextStale = (r: (typeof approvedRows)[number]) =>
    r.contextDigest !== contextDigest;
  const fresh = (r: (typeof approvedRows)[number]) => !expired(r) && !contextStale(r);

  const usable = approvedRows.filter((r) => satisfiesPayload(r) && fresh(r));
  // an exact payload match still wins over a tool-scoped stand-in, exactly as
  // it did before — the freshness test narrows the candidate set, it does not
  // reorder it.
  const approvedApprovalId =
    usable.find((r) => r.argumentsDigest === argumentsDigest)?.id ?? usable[0]?.id ?? null;
  const retiredApprovals: RetiredApproval[] = approvedRows
    .filter((r) => satisfiesPayload(r) && !fresh(r))
    .map((r) => ({ id: r.id, reason: expired(r) ? "expired" : "context_changed" }));

  // THE SERVED DECISION. Computed to completion, from the ACTIVE bodies alone,
  // BEFORE any shadow work starts. Everything after this point is measurement.
  // With no consent held it IS `pendingDecision` — the same pure function of
  // the same inputs — so the second call is made only when a row satisfied.
  const decision = approvedApprovalId
    ? evaluateWith(servedARules, limitsWithCounts, servedScopeRules, approvedApprovalId)
    : pendingDecision;

  // ---------------------------------------------------------------------
  // ADR-0073 §2 — THE SHADOW PASS.
  //
  // The candidate is evaluated in parallel and recorded. It cannot reach the
  // return value: `decision` is already bound, and the whole block is wrapped
  // so that a candidate which THROWS produces a recorded failure and a
  // completely unchanged answer. A canary that can break production is worse
  // than no canary.
  // ---------------------------------------------------------------------
  // ADR-0120 — DRY RUN. A named version is forced as the candidate for its own
  // artifact type; the other two sets stay as served, so a flip is attributable
  // to the rule under test and to nothing else. The shadow is RETURNED and the
  // canary write below is skipped entirely.
  let candidateDecision: Decision | undefined;
  /** the limit rows the candidate pass was decided against (AER-014) */
  let candidateLimitRows: readonly { id: string; toolName: string | null; windowSeconds: number }[] =
    limitsWithCounts;
  if (simulate) {
    const [ver] = await db
      .select()
      .from(configVersions)
      .where(eq(configVersions.id, simulate.versionId));
    if (ver) {
      const swap = <T extends { id: string }>(rows: readonly T[]): T[] =>
        rows.map((r) => (r.id === ver.artifactId ? ({ ...r, ...(ver.body as object) } as T) : r));
      if (ver.artifactType === "approval_rule") {
        candidateDecision = evaluateWith(
          swap(servedARules),
          limitsWithCounts,
          servedScopeRules,
          approvedApprovalId,
        );
      } else if (ver.artifactType === "rate_limit") {
        // a candidate limit may move the WINDOW or the TOOL it counts, so its
        // count is recomputed rather than inherited — the same reasoning the
        // canary path uses, for the same reason: inheriting it would make a
        // window change look like no change at all.
        const swapped = swap(servedLimits);
        const candidateLimits = await Promise.all(
          swapped.map(async (l) => {
            const twin = limitsWithCounts.find((t) => t.id === l.id);
            const same =
              twin != null && twin.windowSeconds === l.windowSeconds && twin.toolName === l.toolName;
            return { ...l, currentCount: same ? twin.currentCount : await countFor(l) };
          }),
        );
        candidateDecision = evaluateWith(
          servedARules,
          candidateLimits,
          servedScopeRules,
          approvedApprovalId,
        );
        candidateLimitRows = candidateLimits;
      }
      // `data_scope_rule` is deliberately absent — see ADR-0120. Evaluating one
      // needs the call's ARGUMENTS, and the recorded transcript stores counts
      // only (§8.4), so a replayed answer would be a guess wearing a number.
    }
  }

  // AER-014 — A TRUNCATED LOOKBACK IS INDETERMINATE, NEVER ALLOW OR DENY. A
  // limit that binds this call (its tool, or every tool) and whose window
  // reaches back past the newest audit-retention prune may be missing calls
  // that really happened, so its count is a floor, not a count. The candidate
  // decision is withheld rather than reported on a number we know may be low.
  let replayIndeterminate: string | undefined;
  if (replay && candidateDecision && replay.lookbackHorizon) {
    const horizonMs = replay.lookbackHorizon.getTime();
    const truncated = candidateLimitRows.find(
      (l) =>
        (l.toolName == null || l.toolName === tool.name) &&
        replay.asOf.getTime() - l.windowSeconds * 1000 < horizonMs,
    );
    if (truncated) {
      candidateDecision = undefined;
      replayIndeterminate =
        `rate limit ${truncated.id} counts the ${truncated.windowSeconds}s before ` +
        `${replay.asOf.toISOString()}, but audit history older than ` +
        `${replay.lookbackHorizon.toISOString()} has been pruned, so the count cannot be reconstructed`;
    }
  }

  const notes: CandidateNote[] = [
    ...aResolved.notes,
    ...limitsResolved.notes,
    ...scopeResolved.notes,
  ];
  if (!simulate && notes.length > 0) {
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
        approvedApprovalId,
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

  return {
    decision,
    approvedApprovalId,
    argumentsDigest,
    approvalScope,
    contextDigest,
    policyEpoch,
    retiredApprovals,
    ...(candidateDecision ? { candidateDecision } : {}),
    ...(replayIndeterminate ? { replayIndeterminate } : {}),
  };
}

/** AER-039 — the execution-relevant identity of an MCP upstream, from its row */
export function approvalTargetForServer(
  serverId: string,
  row: { url: string; allowPrivateRanges: boolean | null; admissionManifestDigest: string | null } | undefined,
): ApprovalTargetRef | null {
  if (!row) return null;
  return {
    kind: "mcp_server",
    serverId,
    url: row.url,
    allowPrivateRanges: row.allowPrivateRanges ?? null,
    admissionManifestDigest: row.admissionManifestDigest ?? null,
  };
}
