/**
 * ADR-0251 — the gateway half of the one governed decision core, for model, connector and A2A calls (the MCP tool
 * path's implementation of the same contract is `governedEvaluate`).
 *
 * It LOADS what the kernel's `composeResourceDecision` needs (the caller's subject scopes, the approval rules and
 * rate limits that bind this resource, the window counts, the attribution mandate, the ABAC verdict) and returns the
 * composed decision. It writes nothing: the call path writes its one decision row, as it already did.
 *
 * Error is deny: any failure while loading or composing returns `governed-core-error`, never an allow.
 */
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  auditLog,
  orgSettings,
  resourceApprovalRules,
  resourceRateLimits,
  resourceRateReservations,
  roleAssignments,
  teamMembers,
  users,
  ORG_SETTINGS_ID,
  type Db,
} from "@regulait/db";
import {
  composeResourceDecision,
  governedCoreErrorDecision,
  RESOURCE_RULE_IDS,
  type AbacDecision,
  type EntitlementDecision,
  type GovernedResource,
  type GovernedResourceDecision,
  type ResourceApprovalRule,
  type ResourceRateLimit,
} from "@regulait/policy-kernel";
import { NOT_ADVISORY_SQL } from "@regulait/shared";
import { checkModelRateLimit } from "./model-rate-limits.js";

export interface ResourceRestrictions {
  approvalRules: ResourceApprovalRule[];
  rateLimits: LoadedRateLimit[];
  attributionRequired: boolean;
  /** ADR-0251 slice 4: the Cedar verdict for the call's v5 action (`ModelInvoke`, `ConnectorCall`, `A2aMessage`);
   * null = no active v5 policy, so nothing can apply */
  abacDecision: AbacDecision | null;
}


/** the caller's subject scopes as SUBQUERIES (role assignments, incl. IdP-group-derived ones, and team memberships),
 * so the rule loads need no prior round trip for the membership ids (the ADR-0251 latency budget) */
function subjectWhere(t: typeof resourceApprovalRules | typeof resourceRateLimits, userId: string): SQL {
  return or(
    eq(t.scope, "fleet"),
    and(eq(t.scope, "user"), eq(t.userId, userId)),
    and(eq(t.scope, "role"), inArray(t.roleId, roleIdsOf(userId))),
    and(eq(t.scope, "team"), inArray(t.teamId, teamIdsOf(userId))),
  )!;
}
const roleIdsOf = (userId: string) => sql`(select ${roleAssignments.roleId} from ${roleAssignments} where ${roleAssignments.userId} = ${userId})`;
const teamIdsOf = (userId: string) => sql`(select ${teamMembers.teamId} from ${teamMembers} where ${teamMembers.userId} = ${userId})`;

/** the `audit_log.object_type` a decision row of this call type is written under (what the window counts) */
const AUDIT_OBJECT_TYPE = { connector: "connector", a2a: "a2a_agent", model: "agent" } as const;

/** a loaded rate limit, with the moment it began binding (hard windows count reservations from then on) */
export type LoadedRateLimit = ResourceRateLimit & { createdAt: Date };

/**
 * ADR-0251 HARD WINDOWS (P-01 remainder): the calls this subject made inside the window, on the database clock
 * (M-075), counted from two sources that never overlap:
 *  - before the limit existed: the allowed decision rows in `audit_log` (only the call's own row, never a PII-warning
 *    or guardrail side row, review #715 finding 3; never an advisory), so a new limit still counts the calls already
 *    in its window;
 *  - since the limit exists: the `resource_rate_reservations` slots, taken in the same transaction as the recount
 *    under a lock (`decideUnderRateLock`), so calls still in flight are counted and concurrent calls cannot overshoot.
 * A call decided before the limit was created whose audit row lands after it is the one case neither source sees; it
 * is bounded by the calls in flight at the moment an admin adds the limit. Each source is read up to `maxCalls` rows
 * only, so a count costs at most O(maxCalls) whatever the traffic.
 */
async function countWindows(
  q: Pick<Db, "execute">,
  userId: string,
  resource: GovernedResource,
  limits: ReadonlyArray<{ resourceId: string | null; windowSeconds: number; maxCalls: number; createdAt: Date }>,
): Promise<number[]> {
  if (resource.type === "model" || limits.length === 0) return limits.map(() => 0);
  const objectType = AUDIT_OBJECT_TYPE[resource.type];
  const idCol = resource.type === "connector" ? sql`connector_id` : sql`a2a_agent_id`;
  // only the call's OWN decision row (review #715 finding 3). A connector's decision row carries no phase; its
  // `phase: "call"` row is the egress record of the same call (`connector-egress-call`), and its PII and guardrail
  // rows carry their own phase. An A2A call's rows carry `phase: "call"`.
  const ownCallRow = resource.type === "connector" ? sql`a.detail ->> 'phase' is null` : sql`coalesce(a.detail ->> 'phase', 'call') = 'call'`;
  // ONE statement for every limit (one round trip, the ADR-0251 latency budget): two scalar subqueries per limit
  const parts = limits.map((l, i) => {
    const since = sql`now() - make_interval(secs => ${l.windowSeconds})`;
    const at = l.createdAt.toISOString();
    return sql`(
      (select count(*) from (select 1 from ${auditLog} a
        where a.user_id = ${userId} and a.object_type = ${objectType}
          ${l.resourceId !== null ? sql`and a.object_id = ${resource.id}` : sql``}
          and a.effect = 'allow' and a.at >= ${since} and a.at < ${at}::timestamptz
          and a.detail ->> 'receiptClass' = 'decision'
          and ${ownCallRow}
          and ${sql.raw(NOT_ADVISORY_SQL)}
        limit ${l.maxCalls}) x)
      + (select count(*) from (select 1 from ${resourceRateReservations} r
        where r.user_id = ${userId} and r.resource_type = ${resource.type}
          ${l.resourceId !== null ? sql`and r.${idCol} = ${resource.id}` : sql``}
          and r.at >= ${since} and r.at >= ${at}::timestamptz
        limit ${l.maxCalls}) y)
    )::int as ${sql.raw(`n${i}`)}`;
  });
  const res = await q.execute(sql`select ${sql.join(parts, sql`, `)}`);
  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  // each source is read only up to the limit (all that exhaustion needs), so the cost is bounded by maxCalls, not by
  // traffic; a count reported in a refusal is therefore at most maxCalls
  return limits.map((l, i) => Math.min(l.maxCalls, Number(row[`n${i}`] ?? 0)));
}

/** the longest window a `resource_rate_limits` row can have (its CHECK); older slots are pruned */
const RESERVATION_RETENTION_SECONDS = 30 * 24 * 3600;

/**
 * ADR-0251 hard windows: decide a call that a rate limit binds, and take its slot if it is allowed, in ONE transaction
 * holding a per-(user, resource type) advisory lock from the count to the slot insert. Two calls of one subject decided
 * at the same moment are therefore counted one after the other (a type-wide limit counts across that type's
 * resources, hence the type-wide key). The window is counted once, under the lock, and before the approval step, so a
 * call over its limit is still refused before anyone is asked to sign it off. A call held or refused takes no slot.
 */
async function decideUnderRateLock(
  db: Db,
  args: { userId: string; resource: GovernedResource; limits: LoadedRateLimit[]; compose: (limits: LoadedRateLimit[]) => GovernedResourceDecision },
): Promise<GovernedResourceDecision> {
  const { userId, resource } = args;
  return db.transaction(async (tx) => {
    // a statement of its own, so the count below takes its snapshot after the lock is held (READ COMMITTED)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`regulait.resource-rate:${userId}:${resource.type}`}, 0))`);
    const counts = await countWindows(tx, userId, resource, args.limits);
    const decision = args.compose(args.limits.map((l, i) => ({ ...l, currentCount: counts[i]! })));
    if (decision.effect !== "allow" || resource.type === "model") return decision;
    // take the slot, and prune this subject's slots older than the longest window, in one statement
    await tx.execute(sql`
      with pruned as (
        delete from ${resourceRateReservations}
        where user_id = ${userId} and resource_type = ${resource.type}
          and at < now() - make_interval(secs => ${RESERVATION_RETENTION_SECONDS})
      )
      insert into ${resourceRateReservations} (user_id, resource_type, connector_id, a2a_agent_id)
      values (${userId}, ${resource.type}, ${resource.type === "connector" ? resource.id : null}, ${resource.type === "a2a" ? resource.id : null})`);
    return decision;
  });
}

export async function loadResourceRestrictions(
  db: Db,
  args: {
    userId: string;
    resource: GovernedResource;
    /** the call's attribution; the ABAC v5 resource bag carries it (ADR-0251 slice 4). Absent = unattributed. */
    projectId?: string | null;
    /** false: leave every limit's `currentCount` at 0, because the caller decides through `governedEvaluateResource`,
     * which counts the window once, under the rate lock (hard windows). Default true (a read of the current counts). */
    counts?: boolean;
  },
): Promise<ResourceRestrictions> {
  const { userId, resource } = args;
  // ADR-0251 slice 4: the Cedar verdict for the call's v5 action, null when no active v5 policy exists. Loaded lazily
  // (abac.js pulls in the simulation surface; a static edge would close an import cycle through the dispatch core).
  const abacVerdict = import("./abac.js").then(({ evaluateAbacForGovernedCall }) =>
    evaluateAbacForGovernedCall(db, {
      userId,
      projectId: args.projectId ?? null,
      target:
        resource.type === "model"
          ? { type: "model", id: resource.id, mode: resource.mode }
          : resource.type === "connector"
            ? { type: "connector", id: resource.id, operation: resource.operation }
            : { type: "a2a", id: resource.id, skillId: resource.skillId },
    }),
  );
  // The verdict runs beside the reads below. When one of those reads rejects first, nothing awaits the verdict, so
  // its own failure would surface as an unhandled rejection. Mark it handled here; the `await` at the end still
  // throws it, and either failure reaches the caller and denies the call.
  void abacVerdict.catch(() => undefined);
  const idCol =
    resource.type === "connector" ? resourceApprovalRules.connectorId : resource.type === "a2a" ? resourceApprovalRules.a2aAgentId : resourceApprovalRules.agentId;
  const [ruleRows, limitRows, [org]] = await Promise.all([
    db
      .select({ rule: resourceApprovalRules, approverName: users.displayName })
      .from(resourceApprovalRules)
      .innerJoin(users, eq(users.id, resourceApprovalRules.approverUserId))
      .where(
        and(
          eq(resourceApprovalRules.resourceType, resource.type),
          or(isNull(idCol), eq(idCol, resource.id)),
          subjectWhere(resourceApprovalRules, userId),
        ),
      ),
    resource.type === "model"
      ? Promise.resolve([] as (typeof resourceRateLimits.$inferSelect)[])
      : db
          .select()
          .from(resourceRateLimits)
          .where(
            and(
              eq(resourceRateLimits.resourceType, resource.type),
              or(
                isNull(resource.type === "connector" ? resourceRateLimits.connectorId : resourceRateLimits.a2aAgentId),
                eq(resource.type === "connector" ? resourceRateLimits.connectorId : resourceRateLimits.a2aAgentId, resource.id),
              ),
              subjectWhere(resourceRateLimits, userId),
            ),
          ),
    db
      .select({ connector: orgSettings.connectorAttributionRequired, a2a: orgSettings.a2aAttributionRequired })
      .from(orgSettings)
      .where(eq(orgSettings.id, ORG_SETTINGS_ID)),
  ]);
  const approvalRules: ResourceApprovalRule[] = ruleRows.map(({ rule, approverName }) => ({
    id: rule.id,
    resourceType: rule.resourceType,
    resourceId: rule.connectorId ?? rule.a2aAgentId ?? rule.agentId ?? null,
    scope: rule.scope,
    writeOnly: rule.writeOnly,
    approverUserId: rule.approverUserId,
    approverName,
  }));
  const bound = limitRows.map((l) => ({ ...l, resourceId: l.connectorId ?? l.a2aAgentId ?? null }));
  const counts = args.counts === false ? bound.map(() => 0) : await countWindows(db, userId, resource, bound);
  const rateLimits: LoadedRateLimit[] = bound.map((l, i) => ({
    id: l.id,
    resourceType: l.resourceType,
    resourceId: l.resourceId,
    scope: l.scope,
    maxCalls: l.maxCalls,
    windowSeconds: l.windowSeconds,
    createdAt: l.createdAt,
    currentCount: counts[i]!,
  }));
  // no org row reads as the strict default (ADR-0180), never as a relaxation
  const attributionRequired = resource.type === "connector" ? org?.connector !== false : resource.type === "a2a" ? org?.a2a !== false : false;
  return { approvalRules, rateLimits, attributionRequired, abacDecision: await abacVerdict };
}

export interface GovernedResourceInput {
  userId: string;
  resource: GovernedResource;
  projectId: string | null;
  /** the resource type's own entitlement decision (evaluateConnector / evaluateAgent / evaluateA2a) */
  base: EntitlementDecision;
  approvedApprovalId?: string | null;
  canQueue: boolean;
  /** already loaded by the caller (to build a consent binding first); loaded here when absent */
  restrictions?: ResourceRestrictions;
}

/** ADR-0251 — the core's decision for a model, connector or A2A call. Never throws; an error is a deny. */
export async function governedEvaluateResource(db: Db, input: GovernedResourceInput): Promise<GovernedResourceDecision> {
  try {
    const r = input.restrictions ?? (await loadResourceRestrictions(db, { userId: input.userId, resource: input.resource, projectId: input.projectId, counts: false }));
    const compose = (rateLimits: LoadedRateLimit[]) =>
      composeResourceDecision({
        resource: input.resource,
        base: input.base,
        projectId: input.projectId,
        attributionRequired: r.attributionRequired,
        rateLimits,
        approvalRules: r.approvalRules,
        abacDecision: r.abacDecision,
        approvedApprovalId: input.approvedApprovalId ?? null,
        canQueue: input.canQueue,
      });
    const counted = async () => {
      const counts = await countWindows(db, input.userId, input.resource, r.rateLimits);
      return compose(r.rateLimits.map((l, i) => ({ ...l, currentCount: counts[i]! })));
    };
    // ADR-0251 slice 4: an ABAC `require_approval` verdict on a model, connector or A2A call REFUSES (fail closed).
    // These paths bind consent to approval rules and the execution dial only, so an ABAC hold could otherwise be
    // released by a rule's approver or queued with no consent bound to the policy. Until a consent binds the policy
    // version (as the MCP path's does), the hold refuses; a forbid or another deny (an exhausted window included) stays
    // what it is. A refused call takes no rate slot, so its window is counted without the lock.
    const abac = r.abacDecision;
    if (abac?.effect === "require_approval") {
      const decision = r.rateLimits.length === 0 || input.resource.type === "model" ? compose(r.rateLimits) : await counted();
      if (decision.effect === "deny") return decision;
      return {
        effect: "deny",
        ruleId: abac.policyId ?? RESOURCE_RULE_IDS.abacApproval,
        reason:
          `policy ${abac.policyName ? `'${abac.policyName}'` : (abac.policyId ?? "")} requires approval for this ${input.resource.type} call, ` +
          "and an ABAC approval hold cannot be queued on this call type yet; nothing was sent",
        ruleChain: decision.ruleChain,
        matchedApprovalRuleIds: decision.matchedApprovalRuleIds,
      };
    }
    // HARD WINDOWS. No limit binds: composed as before, no lock, no write. A limit binds and the call would otherwise
    // be allowed: the window is counted under the rate lock and the call takes its slot in the same transaction. A call
    // that would be held or refused anyway takes no slot, so its window is counted without the lock (the count still
    // runs first, so a call over its limit is refused before anyone is asked to sign it off).
    if (r.rateLimits.length === 0 || input.resource.type === "model") return compose(r.rateLimits);
    const unlimited = compose(r.rateLimits.map((l) => ({ ...l, currentCount: 0 })));
    if (unlimited.effect !== "allow") return await counted();
    return await decideUnderRateLock(db, { userId: input.userId, resource: input.resource, limits: r.rateLimits, compose });
  } catch (err) {
    return governedCoreErrorDecision(input.resource, err);
  }
}

export interface ModelGateRefusal {
  ok: false;
  status: number;
  error: string;
  detail: string;
  ruleId: string;
  retryAfterSeconds?: number;
  auditLogId?: string | null;
}

/**
 * ADR-0251 slice 2 — the core's restriction layer on a MODEL dispatch, run once in the shared dispatch core after
 * the caller's own `evaluateAgent` allowed (so `base` is that allow; a deny never reaches here). Steps: the model
 * rate limit (ADR-0212's `checkModelRateLimit`, its 429 and audit row unchanged; enforced by default since migration governed_core_resource_rules),
 * then approval rules. A model call has no per-call approval queue yet, so a matching rule REFUSES (403
 * `approval_required`) rather than sending. The attribution mandate on this path stays where it was (compat
 * `requireProjectAttribution`, native `dispatchAttributionRequired`). Error is deny.
 */
export async function governedModelGate(
  db: Db,
  args: { userId: string; agentId: string; agentName: string; mode: string; projectId: string | null },
): Promise<ModelGateRefusal | null> {
  const resource: GovernedResource = { type: "model", id: args.agentId, name: args.agentName, mode: args.mode };
  let decision: GovernedResourceDecision;
  try {
    const limited = await checkModelRateLimit(db, { userId: args.userId, agentId: args.agentId, agentName: args.agentName, projectId: args.projectId });
    if (limited) return limited;
    decision = await governedEvaluateResource(db, {
      userId: args.userId,
      resource,
      projectId: args.projectId,
      base: { effect: "allow", ruleId: "agent-entitlement", reason: `model '${args.agentName}' allowed by its entitlement decision`, ruleChain: [] },
      canQueue: false,
    });
  } catch (err) {
    decision = governedCoreErrorDecision(resource, err);
  }
  if (decision.effect === "allow") return null;
  const coreError = decision.ruleId === RESOURCE_RULE_IDS.coreError;
  const [row] = await db
    .insert(auditLog)
    .values({
      userId: args.userId,
      objectType: "agent",
      objectId: args.agentId,
      detail: {
        phase: "governed-core",
        mode: args.mode,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(decision.matchedApprovalRuleIds.length ? { matchedApprovalRuleIds: decision.matchedApprovalRuleIds } : {}),
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    })
    .returning({ id: auditLog.id });
  return {
    ok: false,
    status: coreError ? 503 : 403,
    error: coreError ? "governed_core_error" : "approval_required",
    detail: decision.reason,
    ruleId: decision.ruleId,
    auditLogId: row?.id ?? null,
  };
}
