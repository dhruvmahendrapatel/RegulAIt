/**
 * ADR-0092 — ACCESS RECOMMENDATIONS, the deterministic half (gap L24,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * Saviynt's Intelligence Suite recommends who should lose or gain access via
 * peer analytics and trust scores. This module is the half of that story we
 * can ship HONESTLY: every recommendation is a STATED RULE over ledgers the
 * gateway already writes, computed at read time (no rollup, no stored
 * recommendation rows), with its concrete evidence attached — ids, counts,
 * dates, enough to verify by hand — and its ACTION routed through machinery
 * that already exists (an ADR-0090 certification campaign scoped to exactly
 * the flagged grants, or the ordinary revocation endpoints). The model-judged
 * half (peer analytics, anomaly judgment) stays credential-blocked (L6) and
 * is NOT approximated by a heuristic dressed up as intelligence.
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP HONEST
 * ------------------------------------------
 *  1. QUERIES WITH REASONS. Each result names its rule (id + version), quotes
 *     a rendered plain-language rationale, and carries evidence a human can
 *     re-derive by hand from the same tables. No scores, no ranking:
 *     `severity` is a CLASS from the frozen shared set, never an ordering.
 *  2. NOTHING EXECUTES. The endpoint is read-only. A recommendation becomes
 *     an act only when a human opens a campaign from it (the ADR-0090 loop:
 *     recommend → review → named-human decision → revoke-is-real) or calls a
 *     revocation endpoint themselves. There is no notification, no scheduler,
 *     no auto-revoke anywhere in this file.
 *  3. UNOBSERVABLE IS SAID, NEVER COUNTED AS UNUSED (the ADR-0082
 *     disclosure discipline). The `unused-grant` rule reads the pillar-5
 *     usage ledger (`usage_events`) — which every EXECUTED governed call
 *     writes unconditionally (model dispatch, connector invoke, MCP tool
 *     call), per user, and which is never pruned — NOT the ADR-0070 trace
 *     ledger. That was verified against the insert sites, not assumed: the
 *     brief for this slice anticipated "tracing off ⇒ not assessable", but
 *     tracing gates only the agent-attribution of tool calls; holder-level
 *     use is metered regardless, so switching tracing off does NOT blind
 *     this rule. Where assessment genuinely IS impossible — a role-bundled
 *     grant whose role has no current assignee, so no holder exists to
 *     attribute use to — the grant surfaces under `notAssessable` with its
 *     reason, never under the findings.
 *  4. THE WINDOW IS A PARAMETER, NOT A TRUTH. `windowDays` rides in from the
 *     request (default 90), is echoed into every finding's evidence, and a
 *     grant younger than the window is simply not judged.
 */
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agentRevocations,
  agents,
  and,
  apiKeys,
  authSessions,
  connectorGrants,
  connectorRevocations,
  connectors,
  count,
  eq,
  isNotNull,
  mcpServers,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  sodRules,
  sql,
  toolGrants,
  usageEvents,
  users,
  type Db,
  type GrantCertGrantKind,
  type SodRuleRow,
} from "@regulait/db";
import {
  ACCESS_RECOMMENDATION_RULES_V1,
  ACCESS_RECOMMENDATION_RULES_VERSION,
  RECOMMENDATION_JUDGE_OFF_NOTE,
  RECOMMENDATION_JUDGE_UNAVAILABLE_NOTE,
  UNUSED_GRANT_DEFAULT_WINDOW_DAYS,
  annotationsForFindings,
  buildRecommendationJudgePrompt,
  judgeAvailabilityFor,
  parseRecommendationJudgeReplies,
  renderRecommendationRationale,
  type AccessRecommendationRule,
  type AccessRecommendationRuleId,
  type RecommendationJudge,
  type RecommendationJudgeAnnotation,
  type RecommendationJudgeReply,
  type RecommendationJudgeRequest,
  type RecommendationJudgedState,
} from "@regulait/shared";
import { z } from "zod";
import {
  agentProviderToken,
  configuredProviders,
  executeGovernedDispatch,
  type AgentRow,
} from "./agents-connectors.js";
import { isModelProviderKind } from "@regulait/model-provider";
import { buildAgentHolderIndex, computeAlignmentIndex, ownershipFlagFor } from "./inventory.js";
import { loadOrgSettings } from "./org-settings.js";
import { computeRuleViolators, loadRuleSelectors, resolveSelectorObjects } from "./sod.js";

export const ACCESS_RECOMMENDATION_NOTES = {
  what:
    "queries with reasons (ADR-0092): every recommendation is a deterministic, versioned rule " +
    "over this deployment's own ledgers, computed at read time with its evidence attached. " +
    "There are no scores and no ranking — severity is a class, not an ordering claim — and the " +
    "model-judged half of access intelligence is credential-blocked, not approximated.",
  action:
    "read-only: nothing here executes, notifies, or auto-revokes. The action path is human: " +
    "open an ADR-0090 certification campaign scoped to exactly the flagged grants (scope kind " +
    "'from_recommendations'), or use the ordinary revocation endpoints each finding references.",
  observed:
    "the unused-grant rule reads the pillar-5 usage ledger: EXECUTED governed calls only, " +
    "metered per user for model dispatches, connector invokes and MCP tool calls alike, " +
    "regardless of the tracing switch, and never pruned. Denied attempts are not use; activity " +
    "that never crossed this gateway is invisible — though it also never exercised a gateway " +
    "grant. Where no holder exists to attribute use to, the grant is reported not assessable, " +
    "never unused.",
  window:
    "the unused window is a parameter (default " +
    `${UNUSED_GRANT_DEFAULT_WINDOW_DAYS} days), echoed into every finding — it bounds what the ` +
    "rule may claim, it is not a truth about need.",
} as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface GrantRef {
  grantKind: GrantCertGrantKind;
  grantId: string;
}

interface HolderView {
  userId: string | null;
  roleId: string | null;
  label: string;
}

interface ObjectView {
  kind: "agent" | "connector" | "mcp_server";
  id: string;
  label: string;
  toolName: string | null;
}

interface RevokeAction {
  method: "DELETE";
  path: string;
}

export interface RecommendationFinding {
  grantKind: GrantCertGrantKind | null;
  grantId: string | null;
  holder: HolderView;
  object: ObjectView | null;
  rationale: string;
  evidence: Record<string, unknown>;
  /** sod-violation only: the concrete grant rows conferring each side */
  /** B2c: sides beyond the pair are tagged "side 3", "side 4", … */
  grants?: Array<GrantRef & { side: string; object: ObjectView; holder: HolderView; revoke: RevokeAction }>;
  action: {
    campaignScope: { kind: "from_recommendations"; value: string };
    revoke: RevokeAction | null;
  };
  /**
   * L6c — the OPT-IN model-judged annotation. Absent unless the org knob is on
   * AND a judge was dispatchable AND the judge returned a verdict for THIS
   * finding's key. A SIBLING field: nothing in `evidence`, `rationale`,
   * `severity` or `action` is derived from it, and no finding exists because
   * of it (`annotationsForFindings` drops any verdict keyed to something the
   * deterministic rules did not produce).
   */
  judged?: RecommendationJudgeAnnotation;
  /** the stable key the judged layer addresses this finding by. Deterministic
   * (rule + grant/holder), so the same finding gets the same key across runs. */
  key: string;
}

export interface NotAssessableEntry {
  grantKind: GrantCertGrantKind;
  grantId: string;
  holder: HolderView;
  object: ObjectView;
  reason: string;
}

export interface RuleResult {
  id: AccessRecommendationRuleId;
  version: number;
  severity: AccessRecommendationRule["severity"];
  title: string;
  limits: string;
  findings: RecommendationFinding[];
  notAssessable: NotAssessableEntry[];
  counts: { findings: number; notAssessable: number };
}

export interface AccessRecommendationsReport {
  rulesVersion: number;
  window: { days: number; start: string; end: string };
  computedAt: string;
  notes: typeof ACCESS_RECOMMENDATION_NOTES;
  rules: RuleResult[];
  action: {
    openCampaign: {
      endpoint: "POST /v1/certification-campaigns";
      scope: { kind: "from_recommendations"; value: string };
      note: string;
    };
  };
  /**
   * L6c — the judged layer's own disclosure, ALWAYS present. Three states and
   * no fourth: off (the default), judged (with the instrument named and how
   * many findings it annotated), or unavailable (enabled, but no judge could
   * be dispatched — the deterministic report above is unchanged and says so).
   * An unannotated report from a reachable judge and an unannotated report
   * from a missing one are different facts, and this field is what keeps them
   * distinguishable.
   */
  judged: RecommendationJudgedState;
}

// ---------------------------------------------------------------------------
// The one computation (read time, no stored rows anywhere)
// ---------------------------------------------------------------------------

const dayMs = 24 * 60 * 60 * 1000;

function revokePathFor(kind: GrantCertGrantKind, grantId: string, roleId: string | null): RevokeAction {
  const direct: Record<string, string> = {
    agent: `/v1/grants/agents/${grantId}`,
    connector: `/v1/grants/connectors/${grantId}`,
    tool: `/v1/grants/tools/${grantId}`,
    server: `/v1/grants/servers/${grantId}`,
  };
  if (kind in direct) return { method: "DELETE", path: direct[kind]! };
  const seg = kind === "role_agent" ? "agents" : kind === "role_connector" ? "connectors" : kind === "role_tool" ? "tools" : "servers";
  return { method: "DELETE", path: `/v1/roles/${roleId}/grants/${seg}/${grantId}` };
}

interface UsePair {
  inWindow: number;
  lastAt: Date | null;
}

export async function computeAccessRecommendations(
  db: Db,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<AccessRecommendationsReport> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? UNUSED_GRANT_DEFAULT_WINDOW_DAYS;
  const windowStart = new Date(now.getTime() - windowDays * dayMs);

  const inWindowExpr = sql<number>`(count(*) filter (where ${usageEvents.at} >= ${windowStart}))::int`;
  const [
    agentRows,
    connectorRows,
    serverRows,
    roleRows,
    userRows,
    assignments,
    directAgent,
    roleAgent,
    directConnector,
    roleConnector,
    directTool,
    roleTool,
    directServer,
    roleServer,
    agentRevs,
    connectorRevs,
    mcpRevs,
    holderIndex,
    servedUsage,
    requestedUsage,
    connectorUsage,
    toolUsage,
    anyUsage,
    sessionCounts,
    usedKeyCounts,
    enabledSodRules,
  ] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        ownerUserId: agents.ownerUserId,
        lifecycleStatus: agents.lifecycleStatus,
        lifecycleReason: agents.lifecycleReason,
        lifecycleChangedAt: agents.lifecycleChangedAt,
      })
      .from(agents),
    db.select({ id: connectors.id, name: connectors.name }).from(connectors),
    db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers),
    db.select({ id: roles.id, name: roles.name }).from(roles),
    db
      .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
      .from(users),
    db.select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId }).from(roleAssignments),
    db.select({ id: agentGrants.id, userId: agentGrants.userId, agentId: agentGrants.agentId, createdAt: agentGrants.createdAt }).from(agentGrants),
    db.select({ id: roleAgentGrants.id, roleId: roleAgentGrants.roleId, agentId: roleAgentGrants.agentId, createdAt: roleAgentGrants.createdAt }).from(roleAgentGrants),
    db.select({ id: connectorGrants.id, userId: connectorGrants.userId, connectorId: connectorGrants.connectorId, mode: connectorGrants.mode, createdAt: connectorGrants.createdAt }).from(connectorGrants),
    db.select({ id: roleConnectorGrants.id, roleId: roleConnectorGrants.roleId, connectorId: roleConnectorGrants.connectorId, mode: roleConnectorGrants.mode, createdAt: roleConnectorGrants.createdAt }).from(roleConnectorGrants),
    db.select({ id: toolGrants.id, userId: toolGrants.userId, serverId: toolGrants.serverId, toolName: toolGrants.toolName, createdAt: toolGrants.createdAt }).from(toolGrants),
    db.select({ id: roleToolGrants.id, roleId: roleToolGrants.roleId, serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName, createdAt: roleToolGrants.createdAt }).from(roleToolGrants),
    db.select({ id: serverGrants.id, userId: serverGrants.userId, serverId: serverGrants.serverId, createdAt: serverGrants.createdAt }).from(serverGrants),
    db.select({ id: roleServerGrants.id, roleId: roleServerGrants.roleId, serverId: roleServerGrants.serverId, createdAt: roleServerGrants.createdAt }).from(roleServerGrants),
    db.select({ userId: agentRevocations.userId, agentId: agentRevocations.agentId }).from(agentRevocations),
    db.select({ userId: connectorRevocations.userId, connectorId: connectorRevocations.connectorId, scope: connectorRevocations.scope }).from(connectorRevocations),
    db.select({ userId: revocations.userId, serverId: revocations.serverId, toolName: revocations.toolName, scope: revocations.scope }).from(revocations),
    buildAgentHolderIndex(db),
    db
      .select({ userId: usageEvents.userId, agentId: usageEvents.agentId, inWindow: inWindowExpr, lastAt: sql<string | null>`max(${usageEvents.at})` })
      .from(usageEvents)
      .where(isNotNull(usageEvents.agentId))
      .groupBy(usageEvents.userId, usageEvents.agentId),
    db
      .select({ userId: usageEvents.userId, agentId: usageEvents.requestedAgentId, inWindow: inWindowExpr, lastAt: sql<string | null>`max(${usageEvents.at})` })
      .from(usageEvents)
      .where(isNotNull(usageEvents.requestedAgentId))
      .groupBy(usageEvents.userId, usageEvents.requestedAgentId),
    db
      .select({ userId: usageEvents.userId, connectorId: usageEvents.connectorId, inWindow: inWindowExpr, lastAt: sql<string | null>`max(${usageEvents.at})` })
      .from(usageEvents)
      .where(isNotNull(usageEvents.connectorId))
      .groupBy(usageEvents.userId, usageEvents.connectorId),
    db
      .select({
        userId: usageEvents.userId,
        serverId: sql<string | null>`${usageEvents.detail}->>'serverId'`,
        toolName: usageEvents.operation,
        inWindow: inWindowExpr,
        lastAt: sql<string | null>`max(${usageEvents.at})`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.objectType, "mcp_tool"))
      .groupBy(usageEvents.userId, sql`${usageEvents.detail}->>'serverId'`, usageEvents.operation),
    db.select({ userId: usageEvents.userId, n: count() }).from(usageEvents).groupBy(usageEvents.userId),
    db
      .select({ userId: authSessions.userId, n: count() })
      .from(authSessions)
      .where(isNotNull(authSessions.userId))
      .groupBy(authSessions.userId),
    db
      .select({ userId: apiKeys.userId, n: count() })
      .from(apiKeys)
      .where(isNotNull(apiKeys.lastUsedAt))
      .groupBy(apiKeys.userId),
    db.select().from(sodRules).where(eq(sodRules.enabled, true)),
  ]);

  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  const connectorName = new Map(connectorRows.map((c) => [c.id, c.name]));
  const serverName = new Map(serverRows.map((s) => [s.id, s.name]));
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const userLabel = (id: string) => {
    const u = userById.get(id);
    return u ? u.displayName || u.email : id;
  };
  const roleUsers = new Map<string, string[]>();
  for (const a of assignments) roleUsers.set(a.roleId, [...(roleUsers.get(a.roleId) ?? []), a.userId]);

  const objAgent = (id: string): ObjectView => ({ kind: "agent", id, label: `agent '${agentById.get(id)?.name ?? "(deleted)"}'`, toolName: null });
  const objConnector = (id: string): ObjectView => ({ kind: "connector", id, label: `connector '${connectorName.get(id) ?? "(deleted)"}'`, toolName: null });
  const objServer = (id: string, toolName: string | null): ObjectView => ({
    kind: "mcp_server",
    id,
    label: toolName ? `MCP tool '${serverName.get(id) ?? "(deleted)"} · ${toolName}'` : `MCP server '${serverName.get(id) ?? "(deleted)"}' (read-all)`,
    toolName,
  });
  const holderUser = (id: string): HolderView => ({ userId: id, roleId: null, label: userLabel(id) });
  const holderRole = (id: string): HolderView => ({ userId: null, roleId: id, label: `role: ${roleName.get(id) ?? id}` });

  // -- usage pair maps (executed governed calls; the metered ledger) --------
  const mergePair = (map: Map<string, UsePair>, key: string, inWindow: number, lastAt: string | null) => {
    const prev = map.get(key) ?? { inWindow: 0, lastAt: null };
    const last = lastAt ? new Date(lastAt) : null;
    map.set(key, {
      inWindow: prev.inWindow + inWindow,
      lastAt: !prev.lastAt || (last && last > prev.lastAt) ? last : prev.lastAt,
    });
  };
  const agentUse = new Map<string, UsePair>();
  for (const r of servedUsage) mergePair(agentUse, `${r.userId}:${r.agentId}`, r.inWindow, r.lastAt);
  for (const r of requestedUsage) mergePair(agentUse, `${r.userId}:${r.agentId}`, r.inWindow, r.lastAt);
  const connectorUse = new Map<string, UsePair>();
  for (const r of connectorUsage) mergePair(connectorUse, `${r.userId}:${r.connectorId}`, r.inWindow, r.lastAt);
  const toolUse = new Map<string, UsePair>();
  const serverUse = new Map<string, UsePair>();
  for (const r of toolUsage) {
    if (!r.serverId) continue;
    mergePair(toolUse, `${r.userId}:${r.serverId}:${r.toolName ?? ""}`, r.inWindow, r.lastAt);
    mergePair(serverUse, `${r.userId}:${r.serverId}`, r.inWindow, r.lastAt);
  }
  const usersWithUsage = new Set(anyUsage.map((r) => r.userId));
  const usersWithSessions = new Set(sessionCounts.map((r) => r.userId!));
  const usersWithUsedKeys = new Set(usedKeyCounts.map((r) => r.userId));

  const ruleResults = new Map<AccessRecommendationRuleId, RuleResult>();
  for (const rule of ACCESS_RECOMMENDATION_RULES_V1) {
    ruleResults.set(rule.id, {
      id: rule.id,
      version: ACCESS_RECOMMENDATION_RULES_VERSION,
      severity: rule.severity,
      title: rule.title,
      limits: rule.limits,
      findings: [],
      notAssessable: [],
      counts: { findings: 0, notAssessable: 0 },
    });
  }
  const ruleOf = (id: AccessRecommendationRuleId) => ACCESS_RECOMMENDATION_RULES_V1.find((r) => r.id === id)!;
  /**
   * L6c — every finding gets a STABLE KEY as it is created, derived only from
   * deterministic identity (rule + grant row, or rule + holder for the
   * identity-shaped sod findings). The key is the ONLY handle the judged layer
   * has: it is given the deterministic key set and can annotate nothing else,
   * which is what makes "the judged layer cannot create a recommendation" a
   * structural property rather than a promise. A collision (two findings of
   * one rule on one identity) is disambiguated with an index rather than
   * silently merged.
   */
  const usedKeys = new Set<string>();
  const findingKey = (id: AccessRecommendationRuleId, f: Omit<RecommendationFinding, "key">) => {
    const base = `${id}:${f.grantKind ?? "identity"}:${f.grantId ?? f.holder.userId ?? f.holder.roleId ?? "-"}`;
    if (!usedKeys.has(base)) {
      usedKeys.add(base);
      return base;
    }
    let n = 2;
    while (usedKeys.has(`${base}#${n}`)) n += 1;
    const key = `${base}#${n}`;
    usedKeys.add(key);
    return key;
  };
  const addFinding = (id: AccessRecommendationRuleId, f: Omit<RecommendationFinding, "key">) =>
    ruleResults.get(id)!.findings.push({ ...f, key: findingKey(id, f) });

  // -- every grant row, one uniform view ------------------------------------
  interface GrantRow {
    grantKind: GrantCertGrantKind;
    grantId: string;
    holder: HolderView;
    object: ObjectView;
    createdAt: Date;
    /** direct holder id, or null for role-held rows */
    userId: string | null;
    roleId: string | null;
    /** which use map answers "did this holder use this object"? */
    useKeyFor: (uid: string) => { map: Map<string, UsePair>; key: string };
  }
  const allGrants: GrantRow[] = [
    ...directAgent.map((g) => ({
      grantKind: "agent" as const, grantId: g.id, holder: holderUser(g.userId), object: objAgent(g.agentId),
      createdAt: g.createdAt, userId: g.userId, roleId: null,
      useKeyFor: (uid: string) => ({ map: agentUse, key: `${uid}:${g.agentId}` }),
    })),
    ...roleAgent.map((g) => ({
      grantKind: "role_agent" as const, grantId: g.id, holder: holderRole(g.roleId), object: objAgent(g.agentId),
      createdAt: g.createdAt, userId: null, roleId: g.roleId,
      useKeyFor: (uid: string) => ({ map: agentUse, key: `${uid}:${g.agentId}` }),
    })),
    ...directConnector.map((g) => ({
      grantKind: "connector" as const, grantId: g.id, holder: holderUser(g.userId), object: objConnector(g.connectorId),
      createdAt: g.createdAt, userId: g.userId, roleId: null,
      useKeyFor: (uid: string) => ({ map: connectorUse, key: `${uid}:${g.connectorId}` }),
    })),
    ...roleConnector.map((g) => ({
      grantKind: "role_connector" as const, grantId: g.id, holder: holderRole(g.roleId), object: objConnector(g.connectorId),
      createdAt: g.createdAt, userId: null, roleId: g.roleId,
      useKeyFor: (uid: string) => ({ map: connectorUse, key: `${uid}:${g.connectorId}` }),
    })),
    ...directTool.map((g) => ({
      grantKind: "tool" as const, grantId: g.id, holder: holderUser(g.userId), object: objServer(g.serverId, g.toolName),
      createdAt: g.createdAt, userId: g.userId, roleId: null,
      useKeyFor: (uid: string) => ({ map: toolUse, key: `${uid}:${g.serverId}:${g.toolName}` }),
    })),
    ...roleTool.map((g) => ({
      grantKind: "role_tool" as const, grantId: g.id, holder: holderRole(g.roleId), object: objServer(g.serverId, g.toolName),
      createdAt: g.createdAt, userId: null, roleId: g.roleId,
      useKeyFor: (uid: string) => ({ map: toolUse, key: `${uid}:${g.serverId}:${g.toolName}` }),
    })),
    ...directServer.map((g) => ({
      grantKind: "server" as const, grantId: g.id, holder: holderUser(g.userId), object: objServer(g.serverId, null),
      createdAt: g.createdAt, userId: g.userId, roleId: null,
      useKeyFor: (uid: string) => ({ map: serverUse, key: `${uid}:${g.serverId}` }),
    })),
    ...roleServer.map((g) => ({
      grantKind: "role_server" as const, grantId: g.id, holder: holderRole(g.roleId), object: objServer(g.serverId, null),
      createdAt: g.createdAt, userId: null, roleId: g.roleId,
      useKeyFor: (uid: string) => ({ map: serverUse, key: `${uid}:${g.serverId}` }),
    })),
  ];

  // ---- rule: unused-grant --------------------------------------------------
  {
    const rule = ruleOf("unused-grant");
    const result = ruleResults.get("unused-grant")!;
    for (const g of allGrants) {
      const ageDays = Math.floor((now.getTime() - g.createdAt.getTime()) / dayMs);
      if (ageDays < windowDays) continue; // too young to judge — not flagged, not a finding
      const holderIds = g.userId !== null ? [g.userId] : (roleUsers.get(g.roleId!) ?? []);
      if (g.userId === null && holderIds.length === 0) {
        result.notAssessable.push({
          grantKind: g.grantKind,
          grantId: g.grantId,
          holder: g.holder,
          object: g.object,
          reason:
            "the granting role has no current assignee — no holder exists to attribute use to, " +
            "so 'unused' cannot be honestly claimed (not assessable, never counted as unused)",
        });
        continue;
      }
      let inWindow = 0;
      let lastAt: Date | null = null;
      for (const uid of holderIds) {
        const { map, key } = g.useKeyFor(uid);
        const u = map.get(key);
        if (!u) continue;
        inWindow += u.inWindow;
        if (u.lastAt && (!lastAt || u.lastAt > lastAt)) lastAt = u.lastAt;
      }
      if (inWindow > 0) continue;
      const lastUse = lastAt ? `${lastAt.toISOString()} (before the window)` : "never";
      addFinding("unused-grant", {
        grantKind: g.grantKind,
        grantId: g.grantId,
        holder: g.holder,
        object: g.object,
        rationale: renderRecommendationRationale(rule, {
          ageDays,
          windowDays,
          holder: g.holder.label,
          object: g.object.label,
          lastUse,
        }),
        evidence: {
          grantCreatedAt: g.createdAt.toISOString(),
          ageDays,
          windowDays,
          governedCallsInWindow: 0,
          lastGovernedUseAt: lastAt ? lastAt.toISOString() : null,
          source: "usage_events (pillar-5 metering: executed governed calls per user; tracing-independent)",
          ...(g.roleId ? { assessedAssignees: holderIds.length } : {}),
        },
        action: {
          campaignScope: { kind: "from_recommendations", value: "unused-grant" },
          revoke: revokePathFor(g.grantKind, g.grantId, g.roleId),
        },
      });
    }
  }

  // ---- rules: orphaned-agent-grants / retired-agent-grants / overreach -----
  {
    const orphanRule = ruleOf("orphaned-agent-grants");
    const retiredRule = ruleOf("retired-agent-grants");
    const overreachRule = ruleOf("overreach");
    const alignment = await computeAlignmentIndex(
      db,
      agentRows.map((a) => a.id),
      holderIndex.holders,
    );
    const agentGrantRows = allGrants.filter((g) => g.grantKind === "agent" || g.grantKind === "role_agent");
    for (const a of agentRows) {
      const rowsOnAgent = agentGrantRows.filter((g) => g.object.id === a.id);
      if (rowsOnAgent.length === 0) continue;
      const owner = a.ownerUserId ? userById.get(a.ownerUserId) : undefined;
      const flag = ownershipFlagFor(a.ownerUserId, Boolean(owner?.disabledAt));
      if (flag !== "owned") {
        for (const g of rowsOnAgent) {
          addFinding("orphaned-agent-grants", {
            grantKind: g.grantKind,
            grantId: g.grantId,
            holder: g.holder,
            object: g.object,
            rationale: renderRecommendationRationale(orphanRule, {
              object: g.object.label,
              ownershipProblem:
                flag === "unowned" ? "no recorded owner" : "an owner whose account is deactivated",
              flag,
            }),
            evidence: {
              ownership: flag,
              owner: a.ownerUserId
                ? { userId: a.ownerUserId, label: owner ? owner.displayName || owner.email : null, deactivatedAt: owner?.disabledAt?.toISOString() ?? null }
                : null,
            },
            action: {
              campaignScope: { kind: "from_recommendations", value: "orphaned-agent-grants" },
              revoke: revokePathFor(g.grantKind, g.grantId, g.roleId),
            },
          });
        }
      }
      if (a.lifecycleStatus === "retired") {
        for (const g of rowsOnAgent) {
          addFinding("retired-agent-grants", {
            grantKind: g.grantKind,
            grantId: g.grantId,
            holder: g.holder,
            object: g.object,
            rationale: renderRecommendationRationale(retiredRule, {
              object: g.object.label,
              retiredAgo: a.lifecycleChangedAt ? `on ${a.lifecycleChangedAt.toISOString().slice(0, 10)}` : "at an unrecorded time",
              reason: a.lifecycleReason ?? "no reason recorded",
            }),
            evidence: {
              lifecycleStatus: "retired",
              lifecycleReason: a.lifecycleReason,
              lifecycleChangedAt: a.lifecycleChangedAt ? a.lifecycleChangedAt.toISOString() : null,
              dispatchAlreadyRefuses: "409 agent_retired (ADR-0089)",
            },
            action: {
              campaignScope: { kind: "from_recommendations", value: "retired-agent-grants" },
              revoke: revokePathFor(g.grantKind, g.grantId, g.roleId),
            },
          });
        }
      }
      const al = alignment.get(a.id);
      if (al?.overreach) {
        for (const g of rowsOnAgent) {
          addFinding("overreach", {
            grantKind: g.grantKind,
            grantId: g.grantId,
            holder: g.holder,
            object: g.object,
            rationale: renderRecommendationRationale(overreachRule, {
              object: g.object.label,
              holders: holderIndex.holders.get(a.id)?.size ?? 0,
            }),
            evidence: {
              approvedUseCasesNamingAgent: 0,
              effectiveHolders: holderIndex.holders.get(a.id)?.size ?? 0,
              alignmentFlag: "overreach (ADR-0089: grants vs approved intent, never traffic)",
            },
            action: {
              campaignScope: { kind: "from_recommendations", value: "overreach" },
              revoke: revokePathFor(g.grantKind, g.grantId, g.roleId),
            },
          });
        }
      }
    }
  }

  // ---- rule: sod-violation -------------------------------------------------
  {
    const rule = ruleOf("sod-violation");
    const violators = await computeRuleViolators(db, enabledSodRules as SodRuleRow[]);
    // conferring rows for one side, per user — mirrors the holder semantics
    // ADR-0091 computes (direct ∪ role-derived − revocations), listed as the
    // CONCRETE rows a reviewer could revoke
    const agentRevSet = new Set(agentRevs.map((r) => `${r.userId}:${r.agentId}`));
    const fullConnectorRev = new Set(connectorRevs.filter((r) => r.scope === "full").map((r) => `${r.userId}:${r.connectorId}`));
    const fullMcpRev = (userId: string, serverId: string, toolName: string | null) =>
      mcpRevs.some(
        (r) => r.userId === userId && r.serverId === serverId && r.scope === "full" && (r.toolName === null || r.toolName === toolName),
      );
    const rolesOf = (userId: string) => assignments.filter((a) => a.userId === userId).map((a) => a.roleId);
    const conferring = (
      sel: { kind: string; objectId: string; toolName: string | null; mode: string | null },
      userId: string,
    ): Array<GrantRef & { object: ObjectView; holder: HolderView; revoke: RevokeAction }> => {
      const out: Array<GrantRef & { object: ObjectView; holder: HolderView; revoke: RevokeAction }> = [];
      const userRoles = new Set(rolesOf(userId));
      const modeMatches = (mode: string) =>
        sel.mode === null || (sel.mode === "readwrite" ? mode === "readwrite" : mode === "read" || mode === "readwrite");
      if (sel.kind === "agent") {
        if (agentRevSet.has(`${userId}:${sel.objectId}`)) return out;
        for (const g of directAgent.filter((g) => g.userId === userId && g.agentId === sel.objectId)) {
          out.push({ grantKind: "agent", grantId: g.id, object: objAgent(sel.objectId), holder: holderUser(userId), revoke: revokePathFor("agent", g.id, null) });
        }
        for (const g of roleAgent.filter((g) => userRoles.has(g.roleId) && g.agentId === sel.objectId)) {
          out.push({ grantKind: "role_agent", grantId: g.id, object: objAgent(sel.objectId), holder: holderRole(g.roleId), revoke: revokePathFor("role_agent", g.id, g.roleId) });
        }
      } else if (sel.kind === "connector") {
        if (fullConnectorRev.has(`${userId}:${sel.objectId}`)) return out;
        for (const g of directConnector.filter((g) => g.userId === userId && g.connectorId === sel.objectId && modeMatches(g.mode))) {
          out.push({ grantKind: "connector", grantId: g.id, object: objConnector(sel.objectId), holder: holderUser(userId), revoke: revokePathFor("connector", g.id, null) });
        }
        for (const g of roleConnector.filter((g) => userRoles.has(g.roleId) && g.connectorId === sel.objectId && modeMatches(g.mode))) {
          out.push({ grantKind: "role_connector", grantId: g.id, object: objConnector(sel.objectId), holder: holderRole(g.roleId), revoke: revokePathFor("role_connector", g.id, g.roleId) });
        }
      } else if (sel.kind === "mcp_tool") {
        for (const g of directTool.filter((g) => g.userId === userId && g.serverId === sel.objectId && g.toolName === sel.toolName)) {
          out.push({ grantKind: "tool", grantId: g.id, object: objServer(sel.objectId, sel.toolName), holder: holderUser(userId), revoke: revokePathFor("tool", g.id, null) });
        }
        if (!fullMcpRev(userId, sel.objectId, sel.toolName)) {
          for (const g of roleTool.filter((g) => userRoles.has(g.roleId) && g.serverId === sel.objectId && g.toolName === sel.toolName)) {
            out.push({ grantKind: "role_tool", grantId: g.id, object: objServer(sel.objectId, sel.toolName), holder: holderRole(g.roleId), revoke: revokePathFor("role_tool", g.id, g.roleId) });
          }
        }
      } else {
        for (const g of directServer.filter((g) => g.userId === userId && g.serverId === sel.objectId)) {
          out.push({ grantKind: "server", grantId: g.id, object: objServer(sel.objectId, null), holder: holderUser(userId), revoke: revokePathFor("server", g.id, null) });
        }
        if (!fullMcpRev(userId, sel.objectId, null)) {
          for (const g of roleServer.filter((g) => userRoles.has(g.roleId) && g.serverId === sel.objectId)) {
            out.push({ grantKind: "role_server", grantId: g.id, object: objServer(sel.objectId, null), holder: holderRole(g.roleId), revoke: revokePathFor("role_server", g.id, g.roleId) });
          }
        }
      }
      return out;
    };
    // B2c: a rule's sides come from the ONE loader (legacy a/b columns or the
    // sod_rule_sides rows), and a pattern side resolves to its CURRENT
    // matching objects — the 'mode' pattern (any connector) enumerates every
    // known connector, since any of them may carry the conferring row.
    const sideSelectors = await loadRuleSelectors(db, enabledSodRules as SodRuleRow[]);
    for (const sodRule of enabledSodRules) {
      const ruleSides = sideSelectors.get(sodRule.id) ?? [];
      const resolvedSides = await Promise.all(
        ruleSides.map(async (side) => ({
          side,
          objectIds: (await resolveSelectorObjects(db, side)).objectIds ?? new Set(connectorRows.map((c) => c.id)),
        })),
      );
      for (const v of violators.get(sodRule.id) ?? []) {
        const sideTag = (i: number) => (i === 0 ? "A" : i === 1 ? "B" : `side ${i + 1}`);
        const grants = resolvedSides.flatMap(({ side, objectIds }, i) =>
          [...objectIds].flatMap((objectId) =>
            conferring({ kind: side.kind, objectId, toolName: side.toolName, mode: side.mode }, v.userId).map(
              (g) => ({ ...g, side: sideTag(i) }),
            ),
          ),
        );
        addFinding("sod-violation", {
          grantKind: null,
          grantId: null,
          holder: holderUser(v.userId),
          object: null,
          rationale: renderRecommendationRationale(rule, {
            violator: v.userLabel,
            ruleName: sodRule.name,
            ruleReason: sodRule.reason,
            holdsA: v.holdsA,
            holdsB: v.holdsB,
          }),
          evidence: {
            sodRule: { id: sodRule.id, name: sodRule.name, reason: sodRule.reason },
            holdsA: v.holdsA,
            holdsB: v.holdsB,
            conferringGrantRows: grants.length,
          },
          grants,
          action: {
            campaignScope: { kind: "from_recommendations", value: "sod-violation" },
            revoke: null, // per-row revoke references ride each entry in `grants`
          },
        });
      }
    }
  }

  // ---- rule: never-signed-in-holder ---------------------------------------
  {
    const rule = ruleOf("never-signed-in-holder");
    for (const g of allGrants) {
      if (g.userId === null) continue; // direct grants only: a role is not a person
      const u = userById.get(g.userId);
      if (!u) continue;
      const deactivated = u.disabledAt !== null;
      const neverAuthenticated =
        !usersWithSessions.has(g.userId) && !usersWithUsedKeys.has(g.userId) && !usersWithUsage.has(g.userId);
      if (!deactivated && !neverAuthenticated) continue;
      const facets = [
        ...(deactivated ? ["deactivated"] : []),
        ...(neverAuthenticated ? ["never_authenticated"] : []),
      ];
      const holderProblem = [
        ...(deactivated ? [`is deactivated (since ${u.disabledAt!.toISOString().slice(0, 10)})`] : []),
        ...(neverAuthenticated
          ? ["has never authenticated (no session ever minted, no API key ever used, no governed call recorded)"]
          : []),
      ].join(" and ");
      addFinding("never-signed-in-holder", {
        grantKind: g.grantKind,
        grantId: g.grantId,
        holder: g.holder,
        object: g.object,
        rationale: renderRecommendationRationale(rule, {
          holder: g.holder.label,
          holderProblem,
          object: g.object.label,
        }),
        evidence: {
          facets,
          deactivatedAt: u.disabledAt ? u.disabledAt.toISOString() : null,
          authSessionsEverMinted: usersWithSessions.has(g.userId),
          apiKeyEverUsed: usersWithUsedKeys.has(g.userId),
          governedCallsRecorded: usersWithUsage.has(g.userId),
        },
        action: {
          campaignScope: { kind: "from_recommendations", value: "never-signed-in-holder" },
          revoke: revokePathFor(g.grantKind, g.grantId, null),
        },
      });
    }
  }

  const rulesOut = ACCESS_RECOMMENDATION_RULES_V1.map((r) => {
    const res = ruleResults.get(r.id)!;
    res.counts = { findings: res.findings.length, notAssessable: res.notAssessable.length };
    return res;
  });

  return {
    rulesVersion: ACCESS_RECOMMENDATION_RULES_VERSION,
    window: { days: windowDays, start: windowStart.toISOString(), end: now.toISOString() },
    computedAt: now.toISOString(),
    notes: ACCESS_RECOMMENDATION_NOTES,
    rules: rulesOut,
    // the DEFAULT state of the world: the deterministic report and nothing
    // else. `annotateWithJudge` below replaces this, and only this, when the
    // org opts in — the computation above never consults a model.
    judged: { enabled: false, note: RECOMMENDATION_JUDGE_OFF_NOTE },
    action: {
      openCampaign: {
        endpoint: "POST /v1/certification-campaigns",
        scope: { kind: "from_recommendations", value: "<comma-separated rule ids>" },
        note:
          "the human action path: opening a campaign snapshots exactly the grants these rules " +
          "flag AT THAT MOMENT (computed then, not stored), routes each to its named reviewer, " +
          "and a revoke decision executes the real removal (ADR-0090). Nothing here executes " +
          "on its own.",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// L6c (ADR-0092 amendment) — THE MODEL-JUDGED HALF.
//
// ADR-0092 said this half "remains L6-blocked and unapproximated". It is now
// buildable, and the shape it takes is the one that keeps ADR-0092 honest:
//
//   * OPT-IN, DEFAULT OFF (the batch-B3 idiom). An untouched deployment's
//     report is byte-identical to what ADR-0092 shipped.
//   * A JUDGE IS AN INSTRUMENT, AND A MISSING ONE IS SAID. Availability rides
//     ADR-0067's own `judgeAvailabilityFor` — the same typed refusal the eval
//     runner uses — so "we had no instrument" can never be recorded as "we
//     looked and found nothing to flag".
//   * THE ANNOTATION CANNOT REACH THE DETERMINISTIC FIELDS. `annotateReport`
//     writes exactly one key (`judged`) on findings the rules already made,
//     addressed by the deterministic key set. The judge never sees the report
//     object and never returns one.
//   * IT RIDES THE GOVERNED DISPATCH. `ModelBackedRecommendationJudge` calls
//     `executeGovernedDispatch` — same entitlements, same PII cascade, same
//     guardrails, same metering as any tenant call. Its tokens bill a project
//     and appear in pillar 5, exactly like the copilot's narration.
// ---------------------------------------------------------------------------

export class ModelBackedRecommendationJudge implements RecommendationJudge {
  readonly id: string;
  constructor(
    private readonly db: Db,
    private readonly dataKey: string | undefined,
    private readonly ctx: { agent: AgentRow; userId: string; projectId: string | null },
  ) {
    this.id = `model:${ctx.agent.name}`;
  }

  async judge(reqs: RecommendationJudgeRequest[]): Promise<RecommendationJudgeReply[]> {
    const outcome = await executeGovernedDispatch(this.db, this.dataKey, {
      userId: this.ctx.userId,
      served: this.ctx.agent,
      requestedAgentId: this.ctx.agent.id,
      // no routing counterfactual: the judge is pinned by org configuration
      baseline: null,
      input: buildRecommendationJudgePrompt(reqs),
      maxTokens: 2048,
      projectId: this.ctx.projectId,
      detail: { purpose: "recommendation-judge", findings: reqs.length },
    });
    if (!outcome.ok) {
      throw new Error(
        `recommendation judge dispatch failed: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      );
    }
    const parsed = parseRecommendationJudgeReplies(outcome.result.outputText);
    if (!parsed.ok) throw new Error(`recommendation judge reply unusable: ${parsed.error}`);
    return parsed.replies;
  }
}

/** cap on how many findings ride one judge call — a bounded prompt, and a
 * bounded bill, on a report that can legitimately hold hundreds of rows */
export const RECOMMENDATION_JUDGE_MAX_FINDINGS = 40;

/**
 * ATTACH ANNOTATIONS TO A COMPUTED REPORT — the only function that may.
 *
 * The report goes in already finished. This writes `judged` on the report and
 * `judged` on individual findings, and touches nothing else: it cannot add a
 * finding (it iterates the ones present), cannot remove one, and cannot reach
 * `evidence`, `rationale`, `severity`, `counts` or `action`, none of which it
 * assigns to. A judge that throws leaves the report EXACTLY as it arrived,
 * with `judged: unavailable` stating why.
 */
export async function annotateReportWithJudge(
  report: AccessRecommendationsReport,
  judge: RecommendationJudge,
): Promise<AccessRecommendationsReport> {
  const findings = report.rules.flatMap((r) =>
    r.findings.map((f) => ({ ruleId: r.id, f })),
  );
  if (findings.length === 0) {
    report.judged = {
      enabled: true,
      status: "judged",
      judge: judge.id,
      annotated: 0,
      note:
        "model-judged annotations are enabled and the judge was reachable, but the deterministic " +
        "rules flagged nothing — there was nothing to annotate. The judged layer never creates a " +
        "finding of its own.",
    };
    return report;
  }
  const batch = findings.slice(0, RECOMMENDATION_JUDGE_MAX_FINDINGS);
  let replies: RecommendationJudgeReply[];
  try {
    replies = await judge.judge(
      batch.map(({ ruleId, f }) => ({
        key: f.key,
        ruleId,
        rationale: f.rationale,
        evidence: f.evidence,
      })),
    );
  } catch (err) {
    report.judged = {
      enabled: true,
      status: "unavailable",
      error: "judge_not_dispatchable",
      reason: err instanceof Error ? err.message : String(err),
      note: RECOMMENDATION_JUDGE_UNAVAILABLE_NOTE,
    };
    return report;
  }
  // THE CONTAINMENT STEP. Only the deterministic key set is annotatable.
  const annotations: Map<string, RecommendationJudgeAnnotation> = annotationsForFindings(
    batch.map(({ f }) => f.key),
    replies,
    judge.id,
  );
  let annotated = 0;
  for (const rule of report.rules) {
    for (const f of rule.findings) {
      const a = annotations.get(f.key);
      if (!a) continue;
      f.judged = a;
      annotated += 1;
    }
  }
  report.judged = {
    enabled: true,
    status: "judged",
    judge: judge.id,
    annotated,
    note:
      `${annotated} of ${findings.length} finding(s) carry a model-judged annotation` +
      (findings.length > batch.length
        ? ` (only the first ${batch.length} were sent to the judge — a bounded prompt and a bounded bill)`
        : "") +
      ". Every annotation is labelled `method: \"model-judged\"` and is advisory: it did not create " +
      "the finding, it cannot change the finding's evidence or severity, and it does not clear a grant.",
  };
  return report;
}

/**
 * The org-configured judge, or the typed reason there is none. Deliberately
 * mirrors the eval runner's pre-flight (`evals.ts`): named? dispatchable?
 * `judgeAvailabilityFor` makes the call, so the two surfaces cannot drift into
 * disagreeing about what "we have an instrument" means.
 */
export async function resolveRecommendationJudge(
  db: Db,
  dataKey: string | undefined,
  opts: { userId: string | null; projectId?: string | null; judge?: RecommendationJudge | null },
): Promise<
  { enabled: false } | { enabled: true; judge: RecommendationJudge } | { enabled: true; unavailable: RecommendationJudgedState }
> {
  const settings = await loadOrgSettings(db);
  if (!settings.recommendationJudgeEnabled) return { enabled: false };
  // an injected judge IS the judge (the test seam) — it needs no credential
  if (opts.judge) return { enabled: true, judge: opts.judge };

  const unavailable = (error: "judge_required" | "judge_not_dispatchable", reason: string) => ({
    enabled: true as const,
    unavailable: {
      enabled: true as const,
      status: "unavailable" as const,
      error,
      reason,
      note: RECOMMENDATION_JUDGE_UNAVAILABLE_NOTE,
    },
  });

  if (!opts.userId) {
    return unavailable(
      "judge_not_dispatchable",
      "the judged layer dispatches with the CALLING USER's entitlements, and this caller has no " +
        "user identity to inherit them from (a bootstrap/API token). The deterministic report is " +
        "returned unchanged.",
    );
  }
  const judgeAgentId = settings.recommendationJudgeAgentId;
  let detail: string | null = null;
  let agent: AgentRow | null = null;
  if (judgeAgentId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, judgeAgentId));
    if (!row) detail = "the configured judge agent no longer exists";
    else if (!row.model) detail = `judge agent '${row.name}' has no model id`;
    else if (!isModelProviderKind(row.provider)) {
      detail = `judge agent '${row.name}' has unknown provider '${row.provider}'`;
    } else {
      const configured = await configuredProviders(db, dataKey, opts.userId);
      if (configured.has(agentProviderToken(row))) agent = row as AgentRow;
      else detail = `no model credential (user or platform) is configured for provider '${row.provider}'`;
    }
  }
  // ADR-0067's OWN pre-flight, reused rather than reimplemented.
  const availability = judgeAvailabilityFor(["llm_as_judge"], {
    named: Boolean(judgeAgentId),
    dispatchable: Boolean(agent),
    detail,
  });
  if (!availability.available) return unavailable(availability.error, availability.reason);
  return {
    enabled: true,
    judge: new ModelBackedRecommendationJudge(db, dataKey, {
      agent: agent!,
      userId: opts.userId,
      projectId: opts.projectId ?? null,
    }),
  };
}

/**
 * The campaign feed (ADR-0090's scope filter, one more filter — not a
 * parallel path): the grant rows the named rules flag RIGHT NOW. sod
 * findings contribute their conferring rows; everything else contributes its
 * single flagged row. `notAssessable` rows are deliberately NOT included — a
 * campaign must review claims the rules actually made.
 */
export async function computeRecommendedGrantRefs(
  db: Db,
  ruleIds: AccessRecommendationRuleId[],
  opts: { windowDays?: number; now?: Date } = {},
): Promise<GrantRef[]> {
  const report = await computeAccessRecommendations(db, opts);
  const wanted = new Set<string>(ruleIds);
  const seen = new Set<string>();
  const out: GrantRef[] = [];
  for (const rule of report.rules) {
    if (!wanted.has(rule.id)) continue;
    for (const f of rule.findings) {
      const refs: GrantRef[] = f.grants
        ? f.grants.map((g) => ({ grantKind: g.grantKind, grantId: g.grantId }))
        : f.grantKind && f.grantId
          ? [{ grantKind: f.grantKind, grantId: f.grantId }]
          : [];
      for (const ref of refs) {
        const key = `${ref.grantKind}:${ref.grantId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Posture: the recommendations line (computed at read time, like everything
// there — "none" and "not assessable" are stated, never implied by absence)
// ---------------------------------------------------------------------------

export async function recommendationsPostureSection(db: Db, now: Date) {
  const report = await computeAccessRecommendations(db, { now });
  const totalFindings = report.rules.reduce((a, r) => a + r.counts.findings, 0);
  const totalNotAssessable = report.rules.reduce((a, r) => a + r.counts.notAssessable, 0);
  return {
    rulesVersion: report.rulesVersion,
    windowDays: report.window.days,
    byRule: report.rules.map((r) => ({
      id: r.id,
      severity: r.severity,
      findings: r.counts.findings,
      notAssessable: r.counts.notAssessable,
    })),
    totalFindings,
    totalNotAssessable,
    note:
      totalFindings === 0
        ? "none — no deterministic rule currently flags any grant (a computed fact over the " +
          "ledgers, not a clean bill of health; the rules see only what this gateway records)" +
          (totalNotAssessable > 0
            ? `; ${totalNotAssessable} grant(s) not assessable (no holder to attribute use to)`
            : "")
        : "queries with reasons (ADR-0092), computed at read time; nothing executes " +
          "automatically — the action path is an ADR-0090 campaign or an ordinary revocation" +
          (totalNotAssessable > 0
            ? `; ${totalNotAssessable} grant(s) not assessable (no holder to attribute use to)`
            : ""),
  };
}

// ---------------------------------------------------------------------------
// Route (admin-only via the default gate: recommendations name users, grants
// and org-wide usage — the same record class as the inventory)
// ---------------------------------------------------------------------------

const querySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(3650).optional(),
  /** L6c: which project the judged layer's tokens bill, when it runs at all.
   * Ignored entirely while the knob is off — the deterministic report costs
   * nothing and attributes nothing. */
  projectId: z.string().uuid().optional(),
});

export interface AccessRecommendationRouteOptions {
  dataKey?: string | undefined;
  /** TEST SEAM. Absent = the org-configured, credential-checked, governed
   * `ModelBackedRecommendationJudge` — i.e. the real path. */
  judge?: RecommendationJudge | null | undefined;
}

export function registerAccessRecommendationRoutes(
  app: FastifyInstance,
  db: Db,
  opts: AccessRecommendationRouteOptions = {},
): void {
  app.get("/v1/recommendations/access", async (req) => {
    const { windowDays, projectId } = querySchema.parse(req.query);
    // THE DETERMINISTIC REPORT, COMPUTED FIRST AND UNCONDITIONALLY. Whatever
    // the judged layer does or fails to do below, this is what it does it to.
    const report = await computeAccessRecommendations(
      db,
      windowDays !== undefined ? { windowDays } : {},
    );
    const resolved = await resolveRecommendationJudge(db, opts.dataKey, {
      userId: req.authCtx.userId ?? null,
      projectId: projectId ?? null,
      judge: opts.judge ?? null,
    });
    if (!resolved.enabled) return report;
    if ("unavailable" in resolved) {
      // ENABLED BUT NO INSTRUMENT. The report is returned UNCHANGED and says
      // so — never a silent downgrade to an unannotated "all clear".
      report.judged = resolved.unavailable;
      return report;
    }
    return annotateReportWithJudge(report, resolved.judge);
  });
}
