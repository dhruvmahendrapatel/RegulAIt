/**
 * ADR-0082 — THE STANDING AGENT DEPENDENCY INVENTORY (gap L7,
 * docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md).
 *
 * Credo AI renders a static "agent X uses tools Y,Z and feeds agent W" map as
 * a registry view. RegulAIt's DAGs are per-run and its lineage is per-trace —
 * this module is the AGGREGATION that turns those per-run records into a
 * standing view, and nothing more: NO new table, NO migration, NO collection.
 * Every number here is a SELECT over ledgers the gateway already writes
 * (grants, usage_events, trace_spans, orchestration_runs, redteam_runs,
 * eval_runs, model cards, use cases, risks).
 *
 * THE ONE DISTINCTION THIS FILE EXISTS TO KEEP HONEST
 * ---------------------------------------------------
 * GRANTED and OBSERVED never blend. `granted` is what the entitlement rows
 * say MAY happen (grant tables, roles, revocations); `observed` is what the
 * run history says DID happen (usage rows, tool spans, run graphs). A static
 * map that mixes the two — Credo's shape — cannot tell an unused permission
 * from a used one, which is exactly the over-permissioning question a
 * governance buyer is asking. The two blocks are labelled, separately
 * sourced, and never summed.
 *
 * WHAT "OBSERVED" CAN AND CANNOT SEE — stated on the payload, not buried:
 *  - agent→agent feeds come from ORCHESTRATION RUN HISTORY: an edge exists
 *    where a run's dependent node actually started (the kernel only starts a
 *    node once its dependencies are done, and the dependency outputs are
 *    injected into the dependent's context), owner resolved through the run
 *    STATE so reassignment is honoured. Planned-but-never-started runs and
 *    anything outside the gateway are invisible.
 *  - agent→tool/connector observations come from the ADR-0070 TRACE ledger
 *    (a tool span whose parent span carries the agent). A deployment with
 *    tracing off, or calls that predate ADR-0070, are UNOBSERVED here — the
 *    payload says so rather than showing a reassuring zero.
 *  - a human calling an MCP tool directly is deliberately NOT attributed to
 *    any agent: no agent touched it.
 *
 * The `granted` tool/connector view is an INVENTORY OF GRANT ROWS, not a
 * policy simulation: tool and connector entitlements attach to USERS, so what
 * a run of agent X could touch is the union across X's grant-holders. ABAC
 * policies, rate limits, budget caps and the rest of the decision chain are
 * NOT replayed here — the per-call kernel remains the only authority on any
 * individual call, and the payload's note says so (the Simulation page exists
 * for what-if questions).
 *
 * ADR-0089 ADDS TWO MORE READ-TIME BLOCKS, same discipline (gaps L20/L21,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md):
 *  - OWNERSHIP: `owned` / `unowned` (no owner recorded — a flag, never a
 *    default) / `orphaned` (the recorded owner's account is deactivated, the
 *    ADR-0022 state SCIM deprovisioning writes). Computed at read time from
 *    the agent row joined to the users table — no stored denormalization.
 *  - ALIGNMENT: grants vs APPROVED use-case intent. `aligned` = every
 *    approved use case naming this agent has a participant (its owner or a
 *    linked-project member) with a live grant path; `undershoot` = some
 *    approved intent has no granted path (a provisioning gap); `overreach` =
 *    granted yet named by NO approved use case (the over-privilege question
 *    told with our own objects). These are claims about GRANT ROWS and the
 *    use-case register ONLY — never about observed traffic, which stays in
 *    the observed block. Three blocks, never blended.
 */
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agentRevocations,
  agents,
  aiRisks,
  aiUseCases,
  and,
  connectorGrants,
  connectorRevocations,
  connectors,
  count,
  customModelProviders,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gte,
  inArray,
  isNotNull,
  mcpServers,
  modelCardApprovals,
  modelCards,
  modelCredentials,
  orchestrationRuns,
  projectMembers,
  redteamRuns,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleToolGrants,
  roles,
  revocations,
  serverGrants,
  sql,
  toolGrants,
  traceSpans,
  usageEvents,
  userModelCredentials,
  users,
  type Db,
} from "@regulait/db";
import { z } from "zod";
import { GROUNDEDNESS_SCORER_KINDS } from "./risks.js";
// ADR-0091 (gap L23): the SoD violations block on the standing inventory —
// computed live from the same holder sets this file's holder index feeds
// (sod.ts imports buildAgentHolderIndex from HERE; the cycle is
// function-level only and both sides resolve at call time).
import { sodInventorySection } from "./sod.js";

const agentIdParam = z.object({ agentId: z.string().uuid() });

/** how far back the windowed observations look — the ADR-0081 evidence window,
 * reused so "recent" means the same thing across the governance surfaces */
export const INVENTORY_WINDOW_DAYS = 90;

export const INVENTORY_NOTES = {
  granted:
    "what the entitlement rows say MAY happen: grant tables, role bundles, and per-user " +
    "revocations. Tool/connector entitlements attach to USERS, not agents — the sets below are " +
    "the union across this agent's current grant-holders, an inventory of grant rows and not a " +
    "policy simulation (ABAC, rate limits and budgets are not replayed here; the per-call kernel " +
    "stays the only authority on any individual call).",
  observed:
    "what the run history says DID happen: metered dispatches (usage_events), governed tool/" +
    "connector calls attributed to an agent through the ADR-0070 trace ledger, and agent→agent " +
    "feeds aggregated from orchestration run history. Only governed activity is visible — a call " +
    "that never crossed the gateway, predates tracing, or ran with tracing off is UNOBSERVED " +
    "here, never counted as absent.",
  ownership:
    "a governance record, not authentication: 'unowned' means no owner is recorded (a flag, " +
    "never a default), 'orphaned' means the recorded owner's account is deactivated (the state " +
    "SCIM deprovisioning writes). Computed at read time; orphan detection sees only this " +
    "deployment's own user rows.",
  alignment:
    "grants vs APPROVED intent: 'aligned' = every approved use case naming this agent has a " +
    "participant (the use case's owner or a linked-project member) holding a live grant path " +
    "(direct or role-derived, minus revocations); 'undershoot' = some approved intent has no " +
    "granted path among its participants (a provisioning gap); 'overreach' = the agent is " +
    "granted yet named by NO approved use case. Claims about GRANT ROWS and the use-case " +
    "register only — never about observed traffic (run history lives only in the observed " +
    "block). Grant rows count regardless of a holder's active state; a deactivated owner " +
    "surfaces through the ownership flag, not here.",
} as const;

// ---------------------------------------------------------------------------
// ADR-0089 — ownership flag (L20) and intended-vs-granted alignment (L21)
// ---------------------------------------------------------------------------

export type OwnershipFlag = "owned" | "unowned" | "orphaned";

export function ownershipFlagFor(
  ownerUserId: string | null,
  ownerDisabled: boolean,
): OwnershipFlag {
  if (!ownerUserId) return "unowned";
  return ownerDisabled ? "orphaned" : "owned";
}

export interface AgentAlignment {
  /** approved use cases naming this agent among their intended agents */
  approvedUseCases: number;
  /** every naming approved use case has ≥1 participant with a grant path */
  aligned: boolean;
  /** granted (≥1 effective holder) yet named by NO approved use case */
  overreach: boolean;
  /** some naming approved use case's participants hold no grant path */
  undershoot: boolean;
  /** the undershooting use cases, named — the provisioning worklist */
  gaps: Array<{ useCaseId: string; name: string; detail: string }>;
}

/**
 * The L21 comparison, computed at read time (no new table, no rollup): for
 * every APPROVED use case, its participants are the proposing owner plus the
 * linked project's members; an intended agent is "provisioned" when at least
 * one participant is among the agent's effective grant-holders (the SAME
 * holder sets `buildAgentHolderIndex` computes — imported, never
 * reimplemented). Proposed/under-review/rejected/retired use cases
 * deliberately contribute NOTHING: the flags compare grants against APPROVED
 * intent, and an unapproved proposal is not yet intent the register stands
 * behind.
 */
export async function computeAlignmentIndex(
  db: Db,
  agentIds: string[],
  holders: Map<string, Set<string>>,
): Promise<Map<string, AgentAlignment>> {
  const approved = await db
    .select({
      id: aiUseCases.id,
      name: aiUseCases.name,
      ownerUserId: aiUseCases.ownerUserId,
      projectId: aiUseCases.projectId,
      intendedAgentIds: aiUseCases.intendedAgentIds,
    })
    .from(aiUseCases)
    .where(eq(aiUseCases.status, "approved"));
  const projectIds = [...new Set(approved.map((u) => u.projectId).filter((p): p is string => p !== null))];
  const memberRows = projectIds.length
    ? await db
        .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
        .from(projectMembers)
        .where(inArray(projectMembers.projectId, projectIds))
    : [];
  const membersByProject = new Map<string, string[]>();
  for (const m of memberRows) {
    if (!membersByProject.has(m.projectId)) membersByProject.set(m.projectId, []);
    membersByProject.get(m.projectId)!.push(m.userId);
  }
  const participantsOf = (u: (typeof approved)[number]): Set<string> => {
    const set = new Set<string>([u.ownerUserId]);
    if (u.projectId) for (const uid of membersByProject.get(u.projectId) ?? []) set.add(uid);
    return set;
  };

  const index = new Map<string, AgentAlignment>();
  for (const agentId of agentIds) {
    const naming = approved.filter((u) => (u.intendedAgentIds ?? []).includes(agentId));
    const holderSet = holders.get(agentId) ?? new Set<string>();
    const gaps: AgentAlignment["gaps"] = [];
    for (const u of naming) {
      const participants = participantsOf(u);
      const provisioned = [...participants].some((p) => holderSet.has(p));
      if (!provisioned) {
        gaps.push({
          useCaseId: u.id,
          name: u.name,
          detail: `approved intent, but none of its ${participants.size} participant(s) holds a grant path to this agent`,
        });
      }
    }
    index.set(agentId, {
      approvedUseCases: naming.length,
      aligned: naming.length > 0 && gaps.length === 0,
      overreach: naming.length === 0 && holderSet.size > 0,
      undershoot: gaps.length > 0,
      gaps,
    });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Observed agent→agent feeds — an aggregation over orchestration run history
// ---------------------------------------------------------------------------

export interface FeedEdge {
  fromAgentId: string;
  toAgentId: string;
  /** distinct runs in which this edge was observed */
  observedRuns: number;
  lastSeenAt: string | null;
}

interface RunGraphNode {
  id: string;
  ownerAgentId: string;
  dependsOn?: string[];
}

/**
 * "Agent X feeds agent W", observed: across every orchestration run that
 * actually started, an edge (dep-owner → node-owner) exists where the
 * DEPENDENT node left `not_started` — the kernel dispatches a node only once
 * every dependency is `done`, and the dependency outputs are injected into
 * the dependent node's context, so a started dependent really did consume its
 * dependencies' work. Owners resolve through the run STATE (`state.owners`)
 * so a reassigned node's edge points at the agent that actually ran it.
 * Self-edges (both nodes owned by one agent) are skipped: a cross-NODE
 * hand-off inside one agent is not a cross-AGENT dependency.
 */
export async function computeFeedEdges(db: Db): Promise<FeedEdge[]> {
  const runs = await db
    .select({
      id: orchestrationRuns.id,
      graph: orchestrationRuns.graph,
      state: orchestrationRuns.state,
      createdAt: orchestrationRuns.createdAt,
    })
    .from(orchestrationRuns)
    .where(inArray(orchestrationRuns.status, ["running", "completed", "aborted"]));

  const edges = new Map<string, { fromAgentId: string; toAgentId: string; runs: Set<string>; lastSeenAt: Date | null }>();
  for (const run of runs) {
    const graph = run.graph as { nodes?: RunGraphNode[] } | null;
    const state = run.state as {
      nodeStatuses?: Record<string, string>;
      owners?: Record<string, string>;
    } | null;
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ownerOf = (nodeId: string): string | null =>
      state?.owners?.[nodeId] ?? byId.get(nodeId)?.ownerAgentId ?? null;
    for (const node of nodes) {
      const status = state?.nodeStatuses?.[node.id];
      if (!status || status === "not_started") continue; // never dispatched — nothing was fed
      const toAgent = ownerOf(node.id);
      if (!toAgent) continue;
      for (const dep of node.dependsOn ?? []) {
        const fromAgent = ownerOf(dep);
        if (!fromAgent || fromAgent === toAgent) continue;
        const key = `${fromAgent}->${toAgent}`;
        const existing = edges.get(key) ?? {
          fromAgentId: fromAgent,
          toAgentId: toAgent,
          runs: new Set<string>(),
          lastSeenAt: null,
        };
        existing.runs.add(run.id);
        if (!existing.lastSeenAt || run.createdAt > existing.lastSeenAt) {
          existing.lastSeenAt = run.createdAt;
        }
        edges.set(key, existing);
      }
    }
  }
  return [...edges.values()]
    .map((e) => ({
      fromAgentId: e.fromAgentId,
      toAgentId: e.toAgentId,
      observedRuns: e.runs.size,
      lastSeenAt: e.lastSeenAt ? e.lastSeenAt.toISOString() : null,
    }))
    .sort((a, b) => b.observedRuns - a.observedRuns);
}

// ---------------------------------------------------------------------------
// Grant-holder resolution — direct ∪ role-derived, minus per-user revocations
// ---------------------------------------------------------------------------

export interface AgentHolderIndex {
  /** per agent id: the users who may currently invoke it */
  holders: Map<string, Set<string>>;
  directUsers: Map<string, Set<string>>;
  grantingRoles: Map<string, Set<string>>; // agentId -> roleIds
  revokedUsers: Map<string, Set<string>>;
  roleName: Map<string, string>;
  /** roleId -> userIds assigned */
  roleUsers: Map<string, Set<string>>;
}

/** Exported for ADR-0089's L21 comparison in use-cases.ts — the ONE granted
 * computation (direct ∪ role-derived − revocations), imported there rather
 * than reimplemented. */
export async function buildAgentHolderIndex(db: Db): Promise<AgentHolderIndex> {
  const [direct, roleGrants, assignments, revoked, roleRows] = await Promise.all([
    db.select({ userId: agentGrants.userId, agentId: agentGrants.agentId }).from(agentGrants),
    db.select({ roleId: roleAgentGrants.roleId, agentId: roleAgentGrants.agentId }).from(roleAgentGrants),
    db.select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId }).from(roleAssignments),
    db.select({ userId: agentRevocations.userId, agentId: agentRevocations.agentId }).from(agentRevocations),
    db.select({ id: roles.id, name: roles.name }).from(roles),
  ]);
  const roleUsers = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!roleUsers.has(a.roleId)) roleUsers.set(a.roleId, new Set());
    roleUsers.get(a.roleId)!.add(a.userId);
  }
  const directUsers = new Map<string, Set<string>>();
  for (const g of direct) {
    if (!directUsers.has(g.agentId)) directUsers.set(g.agentId, new Set());
    directUsers.get(g.agentId)!.add(g.userId);
  }
  const grantingRoles = new Map<string, Set<string>>();
  for (const g of roleGrants) {
    if (!grantingRoles.has(g.agentId)) grantingRoles.set(g.agentId, new Set());
    grantingRoles.get(g.agentId)!.add(g.roleId);
  }
  const revokedUsers = new Map<string, Set<string>>();
  for (const r of revoked) {
    if (!revokedUsers.has(r.agentId)) revokedUsers.set(r.agentId, new Set());
    revokedUsers.get(r.agentId)!.add(r.userId);
  }
  const holders = new Map<string, Set<string>>();
  const agentIds = new Set([...directUsers.keys(), ...grantingRoles.keys()]);
  for (const agentId of agentIds) {
    const set = new Set<string>(directUsers.get(agentId) ?? []);
    for (const roleId of grantingRoles.get(agentId) ?? []) {
      for (const u of roleUsers.get(roleId) ?? []) set.add(u);
    }
    for (const u of revokedUsers.get(agentId) ?? []) set.delete(u);
    holders.set(agentId, set);
  }
  return {
    holders,
    directUsers,
    grantingRoles,
    revokedUsers,
    roleName: new Map(roleRows.map((r) => [r.id, r.name])),
    roleUsers,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerInventoryRoutes(app: FastifyInstance, db: Db): void {
  /**
   * THE STANDING INVENTORY — one row per registered agent, every column an
   * aggregation over an existing ledger. Admin-only via the default gate: the
   * inventory names users, grants and org-wide run history, the same class of
   * record as the audit log.
   */
  app.get("/v1/inventory/agents", async () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - INVENTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [
      agentRows,
      customProviders,
      platformCreds,
      byoCreds,
      cards,
      cardApprovals,
      holderIndex,
      usageWindow,
      usageAllTime,
      redteamWindow,
      redteamEver,
      evalWindow,
      groundedWindow,
      useCaseRows,
      riskRows,
      feedEdges,
    ] = await Promise.all([
      db.select().from(agents).orderBy(agents.name),
      db.select({ id: customModelProviders.id, name: customModelProviders.name }).from(customModelProviders),
      db.select({ provider: modelCredentials.provider }).from(modelCredentials),
      db
        .select({ provider: userModelCredentials.provider, n: count() })
        .from(userModelCredentials)
        .groupBy(userModelCredentials.provider),
      db.select({ id: modelCards.id, agentId: modelCards.agentId }).from(modelCards).where(isNotNull(modelCards.agentId)),
      db
        .select({ cardId: modelCardApprovals.cardId, status: modelCardApprovals.status, validUntil: modelCardApprovals.validUntil })
        .from(modelCardApprovals),
      buildAgentHolderIndex(db),
      db
        .select({
          agentId: usageEvents.agentId,
          n: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(and(isNotNull(usageEvents.agentId), gte(usageEvents.at, windowStart)))
        .groupBy(usageEvents.agentId),
      db
        .select({ agentId: usageEvents.agentId, lastAt: sql<string>`max(${usageEvents.at})` })
        .from(usageEvents)
        .where(isNotNull(usageEvents.agentId))
        .groupBy(usageEvents.agentId),
      db
        .select({
          agentId: redteamRuns.agentId,
          asr: redteamRuns.asr,
          asrTrials: redteamRuns.asrTrials,
          measurementQuality: redteamRuns.measurementQuality,
          startedAt: redteamRuns.startedAt,
        })
        .from(redteamRuns)
        .where(and(isNotNull(redteamRuns.agentId), gte(redteamRuns.startedAt, windowStart)))
        .orderBy(desc(redteamRuns.startedAt)),
      db
        .select({ agentId: redteamRuns.agentId, n: count() })
        .from(redteamRuns)
        .where(isNotNull(redteamRuns.agentId))
        .groupBy(redteamRuns.agentId),
      db
        .select({ agentId: evalRuns.agentId, n: count() })
        .from(evalRuns)
        .where(and(isNotNull(evalRuns.agentId), gte(evalRuns.startedAt, windowStart)))
        .groupBy(evalRuns.agentId),
      db
        .select({ agentId: evalRuns.agentId, n: count() })
        .from(evalRuns)
        .innerJoin(
          evalDatasets,
          and(eq(evalRuns.datasetId, evalDatasets.id), eq(evalRuns.datasetVersion, evalDatasets.version)),
        )
        .where(
          and(
            isNotNull(evalRuns.agentId),
            gte(evalRuns.startedAt, windowStart),
            inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS]),
          ),
        )
        .groupBy(evalRuns.agentId),
      db
        .select({ id: aiUseCases.id, status: aiUseCases.status, intendedAgentIds: aiUseCases.intendedAgentIds })
        .from(aiUseCases),
      db
        .select({ id: aiRisks.id, status: aiRisks.status, agentId: aiRisks.agentId })
        .from(aiRisks)
        .where(isNotNull(aiRisks.agentId)),
      computeFeedEdges(db),
    ]);

    // ADR-0089 — ownership (L20) and alignment (L21), both computed at read
    // time over rows already loaded plus one users read and one approved-use-
    // case pass. No stored flag anywhere.
    const ownerIds = [...new Set(agentRows.map((a) => a.ownerUserId).filter((o): o is string => o !== null))];
    const [ownerRows, alignmentIndex] = await Promise.all([
      ownerIds.length
        ? db
            .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
            .from(users)
            .where(inArray(users.id, ownerIds))
        : Promise.resolve([]),
      computeAlignmentIndex(
        db,
        agentRows.map((a) => a.id),
        holderIndex.holders,
      ),
    ]);
    const ownerById = new Map(ownerRows.map((u) => [u.id, u]));

    const customName = new Map(customProviders.map((p) => [p.id, p.name]));
    const platformProviders = new Set(platformCreds.map((c) => c.provider));
    const byoByProvider = new Map(byoCreds.map((c) => [c.provider, c.n]));
    const cardsByAgent = new Map<string, string[]>();
    for (const c of cards) {
      if (!c.agentId) continue;
      if (!cardsByAgent.has(c.agentId)) cardsByAgent.set(c.agentId, []);
      cardsByAgent.get(c.agentId)!.push(c.id);
    }
    const liveApprovedCards = new Set(
      cardApprovals
        .filter((a) => a.status === "approved" && (!a.validUntil || a.validUntil > now))
        .map((a) => a.cardId),
    );
    const usageByAgent = new Map(usageWindow.map((u) => [u.agentId!, u]));
    const lastSeenByAgent = new Map(usageAllTime.map((u) => [u.agentId!, u.lastAt]));
    const redteamCountByAgent = new Map<string, number>();
    const latestRedteamByAgent = new Map<string, (typeof redteamWindow)[number]>();
    for (const r of redteamWindow) {
      redteamCountByAgent.set(r.agentId!, (redteamCountByAgent.get(r.agentId!) ?? 0) + 1);
      if (!latestRedteamByAgent.has(r.agentId!)) latestRedteamByAgent.set(r.agentId!, r); // ordered desc
    }
    const redteamEverByAgent = new Map(redteamEver.map((r) => [r.agentId!, r.n]));
    const evalsByAgent = new Map(evalWindow.map((e) => [e.agentId!, e.n]));
    const groundedByAgent = new Map(groundedWindow.map((e) => [e.agentId!, e.n]));
    const risksByAgent = new Map<string, { total: number; open: number }>();
    for (const r of riskRows) {
      const entry = risksByAgent.get(r.agentId!) ?? { total: 0, open: 0 };
      entry.total += 1;
      if (r.status === "open" || r.status === "mitigating") entry.open += 1;
      risksByAgent.set(r.agentId!, entry);
    }
    const feedsOut = new Map<string, number>();
    const feedsIn = new Map<string, number>();
    for (const e of feedEdges) {
      feedsOut.set(e.fromAgentId, (feedsOut.get(e.fromAgentId) ?? 0) + 1);
      feedsIn.set(e.toAgentId, (feedsIn.get(e.toAgentId) ?? 0) + 1);
    }

    // ADR-0091: SoD rules + current violators, computed live at read time —
    // a rule created after the fact REPORTS here (and in posture); it never
    // auto-revokes anybody.
    const sod = await sodInventorySection(db);

    return {
      window: { start: windowStart.toISOString(), end: now.toISOString(), days: INVENTORY_WINDOW_DAYS },
      computedAt: now.toISOString(),
      notes: INVENTORY_NOTES,
      sod,
      agents: agentRows.map((a) => {
        const latestRt = latestRedteamByAgent.get(a.id) ?? null;
        const agentCards = cardsByAgent.get(a.id) ?? [];
        return {
          id: a.id,
          name: a.name,
          provider: a.provider,
          model: a.model,
          tier: a.tier,
          enabled: a.enabled,
          // -- ADR-0089 L20: ownership + lifecycle, read-time ---------------
          owner: a.ownerUserId
            ? {
                userId: a.ownerUserId,
                name: ownerById.get(a.ownerUserId)
                  ? ownerById.get(a.ownerUserId)!.displayName || ownerById.get(a.ownerUserId)!.email
                  : null,
                deactivated: Boolean(ownerById.get(a.ownerUserId)?.disabledAt),
              }
            : null,
          ownership: ownershipFlagFor(a.ownerUserId, Boolean(ownerById.get(a.ownerUserId ?? "")?.disabledAt)),
          lifecycle: {
            status: a.lifecycleStatus,
            reason: a.lifecycleReason,
            changedAt: a.lifecycleChangedAt ? a.lifecycleChangedAt.toISOString() : null,
            ...(a.lifecycleStatus === "deprecated"
              ? { warning: "deprecated — dispatch still allowed; a migration signal, not a control" }
              : {}),
            ...(a.lifecycleStatus === "retired"
              ? { note: "retired — dispatch refuses with 409 agent_retired; grants and history remain readable" }
              : {}),
            ...(a.lifecycleStatus === "suspended"
              ? { note: "suspended — dispatch refuses with 409 agent_suspended until an admin returns it to service" }
              : {}),
            ...(a.lifecycleStatus === "proposed" || a.lifecycleStatus === "under_review"
              ? { warning: `${a.lifecycleStatus.replace("_", " ")} — dispatch still allowed; a stewardship state, not a control` }
              : {}),
          },
          // -- ADR-0089 L21: grants vs approved intent, never traffic -------
          alignment: alignmentIndex.get(a.id) ?? null,
          credential: {
            source:
              a.provider === "custom"
                ? `custom endpoint '${customName.get(a.customProviderId ?? "") ?? "(unknown)"}'`
                : platformProviders.has(a.provider)
                  ? "platform credential"
                  : a.provider === "mock"
                    ? "none required (mock)"
                    : "none stored (env fallback or user BYO key at dispatch)",
            platformCredential: platformProviders.has(a.provider),
            byoUserCredentials: byoByProvider.get(a.provider) ?? 0,
          },
          modelCard: {
            cards: agentCards.length,
            liveApproved: agentCards.some((id) => liveApprovedCards.has(id)),
          },
          granted: {
            directUsers: holderIndex.directUsers.get(a.id)?.size ?? 0,
            grantingRoles: [...(holderIndex.grantingRoles.get(a.id) ?? [])].map(
              (rid) => holderIndex.roleName.get(rid) ?? rid,
            ),
            revokedUsers: holderIndex.revokedUsers.get(a.id)?.size ?? 0,
            effectiveHolders: holderIndex.holders.get(a.id)?.size ?? 0,
          },
          observed: {
            dispatchesInWindow: usageByAgent.get(a.id)?.n ?? 0,
            costUsdInWindow: usageByAgent.get(a.id)?.costUsd ?? 0,
            lastDispatchAt: lastSeenByAgent.get(a.id) ?? null,
            feedsOut: feedsOut.get(a.id) ?? 0,
            feedsIn: feedsIn.get(a.id) ?? 0,
          },
          coverage: {
            redteamRunsInWindow: redteamCountByAgent.get(a.id) ?? 0,
            everProbed: (redteamEverByAgent.get(a.id) ?? 0) > 0,
            latestAsr: latestRt
              ? {
                  asr: latestRt.asr,
                  asrTrials: latestRt.asrTrials,
                  measurementQuality: latestRt.measurementQuality,
                  startedAt: latestRt.startedAt,
                }
              : null,
            evalRunsInWindow: evalsByAgent.get(a.id) ?? 0,
            groundednessRunsInWindow: groundedByAgent.get(a.id) ?? 0,
          },
          links: {
            useCases: useCaseRows.filter((u) => (u.intendedAgentIds ?? []).includes(a.id)).length,
            risks: risksByAgent.get(a.id)?.total ?? 0,
            openRisks: risksByAgent.get(a.id)?.open ?? 0,
          },
        };
      }),
    };
  });

  /**
   * PER-AGENT DEPENDENCY DETAIL — the full granted-vs-observed picture for
   * one agent: named grant-holders, the tool/connector sets some holder's
   * grants would allow, what the trace ledger observed its dispatches touch,
   * and the observed agent→agent feed edges with run counts and last-seen.
   */
  app.get("/v1/inventory/agents/:agentId", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    const windowStart = new Date(now.getTime() - INVENTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const holderIndex = await buildAgentHolderIndex(db);

    // ADR-0089 — ownership (L20) + intended-vs-granted alignment (L21) for
    // this agent, computed here like everything else on this surface.
    const [ownerRow] = agent.ownerUserId
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, agent.ownerUserId))
      : [];
    const alignment = (await computeAlignmentIndex(db, [agentId], holderIndex.holders)).get(agentId)!;

    const holderIds = [...(holderIndex.holders.get(agentId) ?? [])];
    const directIds = holderIndex.directUsers.get(agentId) ?? new Set<string>();
    const grantingRoleIds = [...(holderIndex.grantingRoles.get(agentId) ?? [])];
    const revokedIds = [...(holderIndex.revokedUsers.get(agentId) ?? [])];

    // -- granted: the tool/connector rows this agent's holders carry ---------
    const holderAssignments = holderIds.length
      ? await db
          .select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId })
          .from(roleAssignments)
          .where(inArray(roleAssignments.userId, holderIds))
      : [];
    const holderRoleIds = [...new Set(holderAssignments.map((a) => a.roleId))];
    const [
      directTools,
      holderRoleTools,
      holderServerGrants,
      holderToolRevocations,
      directConnectors,
      holderRoleConnectors,
      holderConnectorRevocations,
    ] = await Promise.all([
      holderIds.length
        ? db
            .select({ userId: toolGrants.userId, serverId: toolGrants.serverId, toolName: toolGrants.toolName })
            .from(toolGrants)
            .where(inArray(toolGrants.userId, holderIds))
        : Promise.resolve([]),
      holderRoleIds.length
        ? db
            .select({ roleId: roleToolGrants.roleId, serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName })
            .from(roleToolGrants)
            .where(inArray(roleToolGrants.roleId, holderRoleIds))
        : Promise.resolve([]),
      holderIds.length
        ? db
            .select({ userId: serverGrants.userId, serverId: serverGrants.serverId, readOnlyAll: serverGrants.readOnlyAll })
            .from(serverGrants)
            .where(inArray(serverGrants.userId, holderIds))
        : Promise.resolve([]),
      holderIds.length
        ? db
            .select({ userId: revocations.userId, serverId: revocations.serverId, toolName: revocations.toolName, scope: revocations.scope })
            .from(revocations)
            .where(inArray(revocations.userId, holderIds))
        : Promise.resolve([]),
      holderIds.length
        ? db
            .select({ userId: connectorGrants.userId, connectorId: connectorGrants.connectorId, mode: connectorGrants.mode })
            .from(connectorGrants)
            .where(inArray(connectorGrants.userId, holderIds))
        : Promise.resolve([]),
      holderRoleIds.length
        ? db
            .select({ roleId: roleConnectorGrants.roleId, connectorId: roleConnectorGrants.connectorId, mode: roleConnectorGrants.mode })
            .from(roleConnectorGrants)
            .where(inArray(roleConnectorGrants.roleId, holderRoleIds))
        : Promise.resolve([]),
      holderIds.length
        ? db
            .select({ userId: connectorRevocations.userId, connectorId: connectorRevocations.connectorId, scope: connectorRevocations.scope })
            .from(connectorRevocations)
            .where(inArray(connectorRevocations.userId, holderIds))
        : Promise.resolve([]),
    ]);

    const usersByRole = new Map<string, string[]>();
    for (const a of holderAssignments) {
      if (!usersByRole.has(a.roleId)) usersByRole.set(a.roleId, []);
      usersByRole.get(a.roleId)!.push(a.userId);
    }
    /** a holder's explicit tool grants = direct rows + rows from their roles,
     * minus a matching FULL revocation (tool-named, or the whole server) */
    const fullRevocation = (userId: string, serverId: string, toolName: string): boolean =>
      holderToolRevocations.some(
        (r) =>
          r.userId === userId &&
          r.serverId === serverId &&
          r.scope === "full" &&
          (r.toolName === null || r.toolName === toolName),
      );
    const grantedTools = new Map<string, { serverId: string; toolName: string; holders: Set<string> }>();
    const addTool = (userId: string, serverId: string, toolName: string) => {
      if (fullRevocation(userId, serverId, toolName)) return;
      const key = `${serverId}:${toolName}`;
      if (!grantedTools.has(key)) grantedTools.set(key, { serverId, toolName, holders: new Set() });
      grantedTools.get(key)!.holders.add(userId);
    };
    for (const g of directTools) addTool(g.userId, g.serverId, g.toolName);
    for (const g of holderRoleTools) {
      for (const userId of usersByRole.get(g.roleId) ?? []) addTool(userId, g.serverId, g.toolName);
    }
    const grantedConnectors = new Map<string, { connectorId: string; modes: Set<string>; holders: Set<string> }>();
    const fullConnectorRevocation = (userId: string, connectorId: string): boolean =>
      holderConnectorRevocations.some(
        (r) => r.userId === userId && r.connectorId === connectorId && r.scope === "full",
      );
    const addConnector = (userId: string, connectorId: string, mode: string) => {
      if (fullConnectorRevocation(userId, connectorId)) return;
      if (!grantedConnectors.has(connectorId)) {
        grantedConnectors.set(connectorId, { connectorId, modes: new Set(), holders: new Set() });
      }
      grantedConnectors.get(connectorId)!.modes.add(mode);
      grantedConnectors.get(connectorId)!.holders.add(userId);
    };
    for (const g of directConnectors) addConnector(g.userId, g.connectorId, g.mode);
    for (const g of holderRoleConnectors) {
      for (const userId of usersByRole.get(g.roleId) ?? []) addConnector(userId, g.connectorId, g.mode);
    }

    // -- observed: tool/connector spans whose PARENT span carries this agent -
    const childSpans = await db
      .select({
        id: traceSpans.id,
        parentSpanId: traceSpans.parentSpanId,
        kind: traceSpans.kind,
        name: traceSpans.name,
        mcpServerId: traceSpans.mcpServerId,
        connectorId: traceSpans.connectorId,
        startedAt: traceSpans.startedAt,
      })
      .from(traceSpans)
      .where(
        and(
          inArray(traceSpans.kind, ["tool", "connector"]),
          isNotNull(traceSpans.parentSpanId),
          gte(traceSpans.startedAt, windowStart),
        ),
      );
    const parentIds = [...new Set(childSpans.map((s) => s.parentSpanId!).filter(Boolean))];
    const parents = parentIds.length
      ? await db
          .select({ id: traceSpans.id, agentId: traceSpans.agentId })
          .from(traceSpans)
          .where(and(inArray(traceSpans.id, parentIds), eq(traceSpans.agentId, agentId)))
      : [];
    const myParentIds = new Set(parents.map((p) => p.id));
    const observedTools = new Map<string, { serverId: string | null; toolName: string; calls: number; lastSeenAt: Date }>();
    const observedConnectors = new Map<string, { connectorId: string; calls: number; lastSeenAt: Date }>();
    for (const s of childSpans) {
      if (!s.parentSpanId || !myParentIds.has(s.parentSpanId)) continue;
      if (s.kind === "tool") {
        const key = `${s.mcpServerId ?? "?"}:${s.name}`;
        const e = observedTools.get(key) ?? { serverId: s.mcpServerId, toolName: s.name, calls: 0, lastSeenAt: s.startedAt };
        e.calls += 1;
        if (s.startedAt > e.lastSeenAt) e.lastSeenAt = s.startedAt;
        observedTools.set(key, e);
      } else if (s.kind === "connector" && s.connectorId) {
        const e = observedConnectors.get(s.connectorId) ?? { connectorId: s.connectorId, calls: 0, lastSeenAt: s.startedAt };
        e.calls += 1;
        if (s.startedAt > e.lastSeenAt) e.lastSeenAt = s.startedAt;
        observedConnectors.set(s.connectorId, e);
      }
    }

    // -- observed feeds, narrowed to this agent ------------------------------
    const allEdges = await computeFeedEdges(db);
    const out = allEdges.filter((e) => e.fromAgentId === agentId);
    const inbound = allEdges.filter((e) => e.toAgentId === agentId);

    // -- names for everything referenced ------------------------------------
    const referencedUserIds = [...new Set([...holderIds, ...revokedIds])];
    const referencedAgentIds = [
      ...new Set([...out.map((e) => e.toAgentId), ...inbound.map((e) => e.fromAgentId)]),
    ];
    const [userRows, agentNameRows, serverRows, connectorRows, dispatchAgg, useCaseRows, riskRows] =
      await Promise.all([
        referencedUserIds.length
          ? db
              .select({ id: users.id, displayName: users.displayName, email: users.email })
              .from(users)
              .where(inArray(users.id, referencedUserIds))
          : Promise.resolve([]),
        referencedAgentIds.length
          ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, referencedAgentIds))
          : Promise.resolve([]),
        db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers),
        db.select({ id: connectors.id, name: connectors.name }).from(connectors),
        db
          .select({
            n: count(),
            costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
            lastAt: sql<string>`max(${usageEvents.at})`,
          })
          .from(usageEvents)
          .where(and(eq(usageEvents.agentId, agentId), gte(usageEvents.at, windowStart))),
        db
          .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status, intendedAgentIds: aiUseCases.intendedAgentIds })
          .from(aiUseCases),
        db
          .select({ id: aiRisks.id, title: aiRisks.title, status: aiRisks.status, category: aiRisks.category })
          .from(aiRisks)
          .where(eq(aiRisks.agentId, agentId)),
      ]);
    const userName = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
    const agentName = new Map(agentNameRows.map((a) => [a.id, a.name]));
    const serverName = new Map(serverRows.map((s) => [s.id, s.name]));
    const connectorName = new Map(connectorRows.map((c) => [c.id, c.name]));

    return {
      agent: { id: agent.id, name: agent.name, provider: agent.provider, model: agent.model, tier: agent.tier, enabled: agent.enabled },
      window: { start: windowStart.toISOString(), end: now.toISOString(), days: INVENTORY_WINDOW_DAYS },
      computedAt: now.toISOString(),
      // -- ADR-0089 L20 — ownership + lifecycle, read-time ------------------
      ownership: {
        note: INVENTORY_NOTES.ownership,
        flag: ownershipFlagFor(agent.ownerUserId, Boolean(ownerRow?.disabledAt)),
        owner: agent.ownerUserId
          ? {
              userId: agent.ownerUserId,
              name: ownerRow ? ownerRow.displayName || ownerRow.email : null,
              deactivated: Boolean(ownerRow?.disabledAt),
            }
          : null,
        lifecycle: {
          status: agent.lifecycleStatus,
          reason: agent.lifecycleReason,
          changedAt: agent.lifecycleChangedAt ? agent.lifecycleChangedAt.toISOString() : null,
          ...(agent.lifecycleStatus === "deprecated"
            ? { warning: "deprecated — dispatch still allowed; a migration signal, not a control" }
            : {}),
          ...(agent.lifecycleStatus === "retired"
            ? { note: "retired — dispatch refuses with 409 agent_retired; grants and history remain readable" }
            : {}),
          ...(agent.lifecycleStatus === "suspended"
            ? { note: "suspended — dispatch refuses with 409 agent_suspended until an admin returns it to service" }
            : {}),
          ...(agent.lifecycleStatus === "proposed" || agent.lifecycleStatus === "under_review"
            ? { warning: `${agent.lifecycleStatus.replace("_", " ")} — dispatch still allowed; a stewardship state, not a control` }
            : {}),
        },
      },
      // -- ADR-0089 L21 — grants vs approved intent, never traffic ----------
      alignment: { note: INVENTORY_NOTES.alignment, ...alignment },
      granted: {
        note: INVENTORY_NOTES.granted,
        users: holderIds.map((id) => ({
          id,
          name: userName.get(id) ?? null,
          via: [
            ...(directIds.has(id) ? ["direct"] : []),
            ...grantingRoleIds
              .filter((rid) => holderIndex.roleUsers.get(rid)?.has(id))
              .map((rid) => `role: ${holderIndex.roleName.get(rid) ?? rid}`),
          ],
        })),
        revokedUsers: revokedIds.map((id) => ({ id, name: userName.get(id) ?? null })),
        grantingRoles: grantingRoleIds.map((rid) => holderIndex.roleName.get(rid) ?? rid),
        tools: [...grantedTools.values()]
          .map((t) => ({
            serverId: t.serverId,
            serverName: serverName.get(t.serverId) ?? null,
            toolName: t.toolName,
            holders: t.holders.size,
          }))
          .sort((a, b) => b.holders - a.holders),
        serverWideReadGrants: holderServerGrants
          .filter((g) => g.readOnlyAll)
          .map((g) => ({ serverId: g.serverId, serverName: serverName.get(g.serverId) ?? null })),
        connectors: [...grantedConnectors.values()]
          .map((c) => ({
            connectorId: c.connectorId,
            connectorName: connectorName.get(c.connectorId) ?? null,
            modes: [...c.modes].sort(),
            holders: c.holders.size,
          }))
          .sort((a, b) => b.holders - a.holders),
      },
      observed: {
        note: INVENTORY_NOTES.observed,
        dispatchesInWindow: dispatchAgg[0]?.n ?? 0,
        costUsdInWindow: dispatchAgg[0]?.costUsd ?? 0,
        lastDispatchAt: dispatchAgg[0]?.lastAt ?? null,
        mcpTools: [...observedTools.values()]
          .map((t) => ({
            serverId: t.serverId,
            serverName: t.serverId ? (serverName.get(t.serverId) ?? null) : null,
            toolName: t.toolName,
            calls: t.calls,
            lastSeenAt: t.lastSeenAt.toISOString(),
          }))
          .sort((a, b) => b.calls - a.calls),
        connectors: [...observedConnectors.values()]
          .map((c) => ({
            connectorId: c.connectorId,
            connectorName: connectorName.get(c.connectorId) ?? null,
            calls: c.calls,
            lastSeenAt: c.lastSeenAt.toISOString(),
          }))
          .sort((a, b) => b.calls - a.calls),
        feeds: {
          out: out.map((e) => ({ agentId: e.toAgentId, agentName: agentName.get(e.toAgentId) ?? null, observedRuns: e.observedRuns, lastSeenAt: e.lastSeenAt })),
          in: inbound.map((e) => ({ agentId: e.fromAgentId, agentName: agentName.get(e.fromAgentId) ?? null, observedRuns: e.observedRuns, lastSeenAt: e.lastSeenAt })),
          note:
            "aggregated from orchestration run history: an edge exists where a dependent node " +
            "actually started, so it consumed its dependencies' outputs; owners resolve through " +
            "the run state, so reassignment is honoured. Only governed runs are visible.",
        },
      },
      links: {
        useCases: useCaseRows
          .filter((u) => (u.intendedAgentIds ?? []).includes(agentId))
          .map((u) => ({ id: u.id, name: u.name, status: u.status })),
        risks: riskRows.map((r) => ({ id: r.id, title: r.title, status: r.status, category: r.category })),
      },
    };
  });
}
