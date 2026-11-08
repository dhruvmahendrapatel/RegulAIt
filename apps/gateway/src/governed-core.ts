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
  or,
  sql,
  type SQL,
  auditLog,
  orgSettings,
  resourceApprovalRules,
  resourceRateLimits,
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
  rateLimits: ResourceRateLimit[];
  attributionRequired: boolean;
  /** ADR-0251 slice 4: the v5 Cedar actions land after #707; until then no policy can target these actions */
  abacDecision: AbacDecision | null;
}

/** the `audit_log.object_type` a decision row of this call type is written under (what the window counts) */
const AUDIT_OBJECT_TYPE = { connector: "connector", a2a: "a2a_agent", model: "agent" } as const;

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

/** allowed decisions of this subject inside the window, on the database clock (M-075), never counting advisories */
async function countAllowed(db: Db, userId: string, resource: GovernedResource, resourceScoped: boolean, windowSeconds: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, userId),
        eq(auditLog.objectType, AUDIT_OBJECT_TYPE[resource.type]),
        ...(resourceScoped ? [eq(auditLog.objectId, resource.id)] : []),
        eq(auditLog.effect, "allow"),
        gte(auditLog.at, sql`now() - make_interval(secs => ${windowSeconds})`),
        sql`${auditLog.detail} ->> 'receiptClass' = 'decision'`,
        // review #715 finding 3: only the call's OWN decision counts. Side rows of the same call (a PII warning
        // `phase: "pii"`, a guardrail `phase: "guardrail"`) are also allowed decisions and would spend a second slot.
        // The connector decision row carries no phase; the A2A call rows carry `phase: "call"`.
        sql`coalesce(${auditLog.detail} ->> 'phase', 'call') = 'call'`,
        sql.raw(NOT_ADVISORY_SQL),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function loadResourceRestrictions(db: Db, args: { userId: string; resource: GovernedResource }): Promise<ResourceRestrictions> {
  const { userId, resource } = args;
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
  const rateLimits: ResourceRateLimit[] = await Promise.all(
    limitRows.map(async (l) => {
      const resourceId = l.connectorId ?? l.a2aAgentId ?? null;
      return {
        id: l.id,
        resourceType: l.resourceType,
        resourceId,
        scope: l.scope,
        maxCalls: l.maxCalls,
        windowSeconds: l.windowSeconds,
        currentCount: await countAllowed(db, userId, resource, resourceId !== null, l.windowSeconds),
      };
    }),
  );
  // no org row reads as the strict default (ADR-0180), never as a relaxation
  const attributionRequired = resource.type === "connector" ? org?.connector !== false : resource.type === "a2a" ? org?.a2a !== false : false;
  return { approvalRules, rateLimits, attributionRequired, abacDecision: null };
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
    const r = input.restrictions ?? (await loadResourceRestrictions(db, { userId: input.userId, resource: input.resource }));
    return composeResourceDecision({
      resource: input.resource,
      base: input.base,
      projectId: input.projectId,
      attributionRequired: r.attributionRequired,
      rateLimits: r.rateLimits,
      approvalRules: r.approvalRules,
      abacDecision: r.abacDecision,
      approvedApprovalId: input.approvedApprovalId ?? null,
      canQueue: input.canQueue,
    });
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
