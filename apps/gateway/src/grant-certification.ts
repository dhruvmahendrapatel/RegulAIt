/**
 * ADR-0090 — GRANT CERTIFICATION CAMPAIGNS (gap L22,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * Saviynt's core loop is the access-certification campaign: a periodic,
 * owner-driven review of entitlements where a named reviewer attests KEEP or
 * REVOKE per grant. This module is that loop scoped to the ONE thing this
 * gateway actually enforces: its own grant rows (agent/connector/MCP
 * tool/server, direct and role-bundled). A fabric-wide campaign over other
 * systems' entitlements is IGA's job — we integrate with IGA, we do not
 * compete with it — and no scope in this file can reach outside the
 * gateway's own grant tables.
 *
 * THE FOUR RULES THIS FILE EXISTS TO KEEP HONEST
 * ----------------------------------------------
 *  1. DECISIONS RIDE THE ONE APPROVALS QUEUE. Opening a campaign creates one
 *     `approvals` row per item (`objectType='grant_certification'`, the
 *     item's reviewer as the named approver); keep/revoke are ordinary
 *     approve/deny decisions through `decideOneApproval` — inheriting the
 *     named-reviewer refusal, delegation, admin-override-with-reason and
 *     per-item audit machinery rather than growing a second decide path.
 *     ADR-0080's rails question was answered the other way here on purpose:
 *     a campaign has no stages, no artifact and no build step — it is N
 *     independent single decisions, which is exactly what the queue IS.
 *     Putting a workflow instance around each item would be ceremony.
 *  2. A REVIEWER NEVER CERTIFIES THEIR OWN GRANT. The bar is keyed on the
 *     DECIDER (the ADR-0022 lesson: separation of duties is a property of
 *     who actually signed) — so a holder cannot reach their own item through
 *     delegation or admin override either. Refused by name
 *     (`cannot_certify_own_grant`), per item, while sibling items proceed.
 *  3. REVOKE IS REAL. A revoke decision executes the SAME per-kind removal
 *     the admin delete endpoints use (`grant-revocation.ts` — one
 *     implementation, imported by both), inside the decision's own
 *     transaction, audited with the campaign as context. The kernel reads
 *     grant rows live, so the removal IS the enforcement.
 *  4. EXPIRY IS VISIBLE, NEVER SILENT — AND NEVER A DECISION. A past-due
 *     campaign with undecided items reads `expired-incomplete`, computed on
 *     read (the ADR-0046 breach-on-read idiom; no scheduler). Undecided
 *     items stay undecided forever: deciding an item of a past-due campaign
 *     is refused by name (`campaign_expired`), and nothing ever auto-keeps
 *     or auto-revokes. The expired-incomplete count is a posture fact.
 *
 * SNAPSHOT SEMANTICS: items are taken at open — a campaign reviews the
 * grants that existed when it opened. A grant created after open is out of
 * scope (recorded, not implied); a grant that disappears between open and
 * decide leaves the item decidable, with the execution reporting the row was
 * already gone.
 */
import type { FastifyInstance } from "fastify";
import {
  AGENT_LIFECYCLE_STATUSES,
  GRANT_CERT_SCOPE_KINDS,
  agentGrants,
  agents,
  and,
  approvals,
  auditLog,
  connectorGrants,
  connectors,
  count,
  desc,
  eq,
  grantCertificationCampaigns,
  grantCertificationItems,
  inArray,
  isNull,
  mcpServers,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  toolGrants,
  users,
  type Db,
  type GrantCertGrantKind,
  type GrantCertificationCampaignRow,
} from "@regulait/db";
import { parseRecommendationRuleIds } from "@regulait/shared";
import { z } from "zod";
// ADR-0092 (gap L24): the recommendation-scoped campaign snapshot — the one
// action path a recommendation has (recommend → review → human decides →
// revoke-is-real). Imported here as one more scope filter, never a parallel
// snapshot mechanism.
import { computeRecommendedGrantRefs } from "./access-recommendations.js";
import {
  deleteAgentGrantById,
  deleteConnectorGrantById,
  deleteRoleAgentGrantById,
  deleteRoleConnectorGrantById,
  deleteRoleServerGrantById,
  deleteRoleToolGrantById,
  deleteServerGrantById,
  deleteToolGrantById,
} from "./grant-revocation.js";
// ADR-0046's ONE approver-moving write — the same mechanism the SLA
// `reassign` escalation uses. Item reassignment below calls it rather than
// writing `approvals.approverUserId` a second way.
import { reassignApprovalApprover } from "./workbench.js";

/** the `approvals.stageId` sentinel carrying the ITEM id — the same slot the
 * model-card / infra / conflict rows use, because riding the ONE queue with
 * no new approvals column is the whole point */
export const GRANT_CERT_PREFIX = "__grant_cert__:";

export const CERTIFICATION_NOTES = {
  scope:
    "gateway grants only: the agent/connector/MCP tool/server grant rows THIS gateway enforces, " +
    "direct and role-bundled. A campaign over other systems' entitlements is IGA's job — no " +
    "scope here reaches outside the gateway's own grant tables.",
  snapshot:
    "items are a snapshot taken at open: the campaign reviews the grants that existed when it " +
    "opened. A grant created after open is out of its scope, and campaign coverage is never " +
    "continuous.",
  expiry:
    "computed on read. A past-due campaign with undecided items reads 'expired-incomplete'; its " +
    "undecided items stay undecided forever (deciding them is refused by name), and nothing ever " +
    "auto-keeps or auto-revokes. The ADR-0064 expiry sweep only RECORDS the fact into the audit " +
    "log (once per campaign) so it is visible even if nobody opens this page — it decides nothing.",
} as const;

const scopeSchema = z.object({
  kind: z.enum(GRANT_CERT_SCOPE_KINDS),
  value: z.string().optional().nullable(),
});
const openCampaignSchema = z.object({
  name: z.string().min(1),
  scope: scopeSchema,
  dueAt: z.string().datetime(),
});
const campaignIdParam = z.object({ campaignId: z.string().uuid() });

interface SnapshotItem {
  grantKind: GrantCertGrantKind;
  grantId: string;
  holderUserId: string | null;
  holderRoleId: string | null;
  holderLabel: string;
  objectId: string | null;
  objectLabel: string;
  toolName: string | null;
  reviewerUserId: string;
}

/** ONE shared past-due predicate — the read-time projection and the
 * decide-time refusal must agree, so they ask the same function */
export function campaignPastDue(campaign: { dueAt: Date }, now: Date): boolean {
  return campaign.dueAt.getTime() < now.getTime();
}

export type EffectiveCampaignStatus = "open" | "completed" | "expired-incomplete";

/**
 * The read-time status projection (rule 4 above). Stored status is only ever
 * open|completed; 'expired-incomplete' is open + past due + something still
 * undecided — a fact derivable from stored state at any time, so it can
 * never be stale and no scheduler has to fire for it to be true.
 */
export function campaignEffectiveStatus(
  campaign: Pick<GrantCertificationCampaignRow, "status" | "dueAt">,
  undecidedItems: number,
  now: Date,
): EffectiveCampaignStatus {
  if (campaign.status === "completed") return "completed";
  if (campaignPastDue(campaign, now) && undecidedItems > 0) return "expired-incomplete";
  return "open";
}

class ScopeError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

/**
 * Enumerate the grant rows a scope covers, with display labels and reviewer
 * routing resolved — the snapshot taken at campaign open (and the preview).
 *
 * Reviewer routing (ADR-0089's ownership spine put to work): an item on an
 * AGENT grant routes to the agent's recorded owner where one exists, is
 * active, and is not the grant's own holder; every other item — unowned
 * agents, orphaned owners, connectors/tools/servers (which have no owner
 * concept) — routes to the campaign opener. Routing never widens who may
 * decide: the reviewer becomes the approval's named approver and the one
 * decide path enforces it.
 */
async function snapshotGrantsForScope(
  db: Db,
  scope: { kind: (typeof GRANT_CERT_SCOPE_KINDS)[number]; value: string | null },
  openerUserId: string,
): Promise<SnapshotItem[]> {
  if (scope.kind === "all" && scope.value) {
    throw new ScopeError(422, { error: "scope_value_not_allowed", detail: "scope 'all' carries no value" });
  }
  if (scope.kind !== "all" && !scope.value) {
    throw new ScopeError(422, { error: "scope_value_required", detail: `scope '${scope.kind}' requires a value` });
  }
  if (scope.kind === "agent_lifecycle" && !(AGENT_LIFECYCLE_STATUSES as readonly string[]).includes(scope.value!)) {
    throw new ScopeError(422, {
      error: "invalid_lifecycle_status",
      detail: `scope 'agent_lifecycle' takes one of: ${AGENT_LIFECYCLE_STATUSES.join(", ")}`,
    });
  }
  if ((scope.kind === "agent_owner" || scope.kind === "user") && !z.string().uuid().safeParse(scope.value).success) {
    throw new ScopeError(400, { error: "invalid_reference", field: "scope.value" });
  }

  // ADR-0092 (gap L24) — the recommendation feed: the scope value names
  // recommendation rule ids, and the snapshot is EXACTLY the grant rows those
  // rules flag at this moment (computed now, never stored). One more filter
  // over the same enumeration below — not a parallel snapshot path.
  let recommendedRefs: Set<string> | null = null;
  if (scope.kind === "from_recommendations") {
    const parsed = parseRecommendationRuleIds(scope.value!);
    if (!parsed.ok) {
      throw new ScopeError(422, {
        error: "invalid_recommendation_rules",
        detail:
          parsed.invalid.length > 0
            ? `unknown recommendation rule id(s): ${parsed.invalid.join(", ")}`
            : "scope 'from_recommendations' requires at least one recommendation rule id",
        ...(parsed.invalid.length > 0 ? { invalid: parsed.invalid } : {}),
      });
    }
    recommendedRefs = new Set(
      (await computeRecommendedGrantRefs(db, parsed.ids)).map((r) => `${r.grantKind}:${r.grantId}`),
    );
  }

  const [
    agentRows,
    connectorRows,
    serverRows,
    roleRows,
    directAgent,
    roleAgent,
    directConnector,
    roleConnector,
    directTool,
    roleTool,
    directServer,
    roleServer,
  ] = await Promise.all([
    db.select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId, lifecycleStatus: agents.lifecycleStatus }).from(agents),
    db.select({ id: connectors.id, name: connectors.name }).from(connectors),
    db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers),
    db.select({ id: roles.id, name: roles.name }).from(roles),
    db.select({ id: agentGrants.id, userId: agentGrants.userId, agentId: agentGrants.agentId }).from(agentGrants),
    db.select({ id: roleAgentGrants.id, roleId: roleAgentGrants.roleId, agentId: roleAgentGrants.agentId }).from(roleAgentGrants),
    db.select({ id: connectorGrants.id, userId: connectorGrants.userId, connectorId: connectorGrants.connectorId }).from(connectorGrants),
    db.select({ id: roleConnectorGrants.id, roleId: roleConnectorGrants.roleId, connectorId: roleConnectorGrants.connectorId }).from(roleConnectorGrants),
    db.select({ id: toolGrants.id, userId: toolGrants.userId, serverId: toolGrants.serverId, toolName: toolGrants.toolName }).from(toolGrants),
    db.select({ id: roleToolGrants.id, roleId: roleToolGrants.roleId, serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName }).from(roleToolGrants),
    db.select({ id: serverGrants.id, userId: serverGrants.userId, serverId: serverGrants.serverId }).from(serverGrants),
    db.select({ id: roleServerGrants.id, roleId: roleServerGrants.roleId, serverId: roleServerGrants.serverId }).from(roleServerGrants),
  ]);

  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  const connectorName = new Map(connectorRows.map((c) => [c.id, c.name]));
  const serverName = new Map(serverRows.map((s) => [s.id, s.name]));
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));

  // which agents the scope covers (agent-scoped kinds); null = not agent-scoped
  const agentInScope = (agentId: string): boolean => {
    const a = agentById.get(agentId);
    if (!a) return false;
    if (scope.kind === "agent_lifecycle") return a.lifecycleStatus === scope.value;
    if (scope.kind === "agent_owner") return a.ownerUserId === scope.value;
    return true; // 'all' and 'user' don't narrow by agent
  };

  type Raw = Omit<SnapshotItem, "holderLabel" | "objectLabel" | "reviewerUserId">;
  const raw: Raw[] = [];
  // from_recommendations admits exactly the rows the named rules flag; every
  // other scope admits everything its own filters pass
  const push = (r: Raw) => {
    if (recommendedRefs && !recommendedRefs.has(`${r.grantKind}:${r.grantId}`)) return;
    raw.push(r);
  };

  const userScoped = scope.kind === "user";
  const agentScoped = scope.kind === "agent_lifecycle" || scope.kind === "agent_owner";

  for (const g of directAgent) {
    if (userScoped && g.userId !== scope.value) continue;
    if (!agentInScope(g.agentId)) continue;
    push({ grantKind: "agent", grantId: g.id, holderUserId: g.userId, holderRoleId: null, objectId: g.agentId, toolName: null });
  }
  for (const g of roleAgent) {
    // a role holds the grant, no single user does — 'user' scope covers
    // direct grants only (expanding a role per-holder would fabricate grant
    // rows that do not exist; stated in the ADR)
    if (userScoped) continue;
    if (!agentInScope(g.agentId)) continue;
    push({ grantKind: "role_agent", grantId: g.id, holderUserId: null, holderRoleId: g.roleId, objectId: g.agentId, toolName: null });
  }
  if (!agentScoped) {
    for (const g of directConnector) {
      if (userScoped && g.userId !== scope.value) continue;
      push({ grantKind: "connector", grantId: g.id, holderUserId: g.userId, holderRoleId: null, objectId: g.connectorId, toolName: null });
    }
    for (const g of directTool) {
      if (userScoped && g.userId !== scope.value) continue;
      push({ grantKind: "tool", grantId: g.id, holderUserId: g.userId, holderRoleId: null, objectId: g.serverId, toolName: g.toolName });
    }
    for (const g of directServer) {
      if (userScoped && g.userId !== scope.value) continue;
      push({ grantKind: "server", grantId: g.id, holderUserId: g.userId, holderRoleId: null, objectId: g.serverId, toolName: null });
    }
    if (!userScoped) {
      for (const g of roleConnector) {
        push({ grantKind: "role_connector", grantId: g.id, holderUserId: null, holderRoleId: g.roleId, objectId: g.connectorId, toolName: null });
      }
      for (const g of roleTool) {
        push({ grantKind: "role_tool", grantId: g.id, holderUserId: null, holderRoleId: g.roleId, objectId: g.serverId, toolName: g.toolName });
      }
      for (const g of roleServer) {
        push({ grantKind: "role_server", grantId: g.id, holderUserId: null, holderRoleId: g.roleId, objectId: g.serverId, toolName: null });
      }
    }
  }

  // names for holders + owners (one read, covers labels and routing)
  const holderUserIds = raw.map((r) => r.holderUserId).filter((u): u is string => u !== null);
  const ownerIds = agentRows.map((a) => a.ownerUserId).filter((o): o is string => o !== null);
  const userIds = [...new Set([...holderUserIds, ...ownerIds])];
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const userLabel = (id: string) => {
    const u = userById.get(id);
    return u ? u.displayName || u.email : id;
  };

  return raw.map((r) => {
    const isAgentKind = r.grantKind === "agent" || r.grantKind === "role_agent";
    const agent = isAgentKind && r.objectId ? agentById.get(r.objectId) : undefined;
    const owner = agent?.ownerUserId ? userById.get(agent.ownerUserId) : undefined;
    // default reviewer: the granted agent's owner (ADR-0089) where one
    // exists, is active, and is not the grant's own holder; else the opener
    const reviewerUserId =
      owner && !owner.disabledAt && owner.id !== r.holderUserId ? owner.id : openerUserId;
    const objectLabel = isAgentKind
      ? (agent?.name ?? "(deleted agent)")
      : r.grantKind === "connector" || r.grantKind === "role_connector"
        ? (connectorName.get(r.objectId ?? "") ?? "(deleted connector)")
        : r.toolName
          ? `${serverName.get(r.objectId ?? "") ?? "(deleted server)"} · ${r.toolName}`
          : (serverName.get(r.objectId ?? "") ?? "(deleted server)");
    return {
      ...r,
      holderLabel: r.holderUserId ? userLabel(r.holderUserId) : `role: ${roleName.get(r.holderRoleId ?? "") ?? r.holderRoleId}`,
      objectLabel,
      reviewerUserId,
    };
  });
}

// ---------------------------------------------------------------------------
// The decide-path hooks (called from app.ts `decideOneApproval` — the ONE
// decide path; there is no campaign-owned decision endpoint anywhere)
// ---------------------------------------------------------------------------

export interface CertRefusal {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Pre-transaction guards for a grant_certification approval, refusing BY NAME
 * before any decision is written:
 *
 *  - `campaign_expired`: the campaign is past due — its undecided items stay
 *    undecided forever (rule 4), so no decision may land late;
 *  - `cannot_certify_own_grant`: the DECIDER holds the grant under review —
 *    keyed on who actually signs, so the bar also stops a holder reaching
 *    their own item through delegation or an admin override (the ADR-0022
 *    self-review lesson, hardened from reason-required to refusal: attesting
 *    one's own access is not a review at all). For a role-bundled grant the
 *    same question is asked of the decider's current role assignment.
 */
export async function precheckGrantCertificationDecision(
  db: Db,
  approval: { id: string },
  deciderUserId: string,
): Promise<CertRefusal | null> {
  // ADR-0107 deferred this read: an `ORDER BY` would have said "several items
  // per approval are expected, here is the tiebreak", when the truth is that a
  // second one is a bug. ADR-0109 (migration 0108) says so instead —
  // `grant_cert_items_approval_uq` UNIQUE (approval_id) WHERE approval_id IS
  // NOT NULL makes this predicate match at most one row, so it is deliberately
  // left unordered.
  const [item] = await db
    .select()
    .from(grantCertificationItems)
    .where(eq(grantCertificationItems.approvalId, approval.id));
  if (!item) return null; // defensive: an orphaned queue row falls through to the generic path
  const [campaign] = await db
    .select()
    .from(grantCertificationCampaigns)
    .where(eq(grantCertificationCampaigns.id, item.campaignId));
  if (campaign && campaign.status === "open" && campaignPastDue(campaign, new Date())) {
    return {
      status: 409,
      body: {
        error: "campaign_expired",
        detail:
          "this campaign is past its due date — its undecided items stay undecided (the campaign " +
          "reads 'expired-incomplete'; open a new campaign to review these grants)",
      },
    };
  }
  if (item.holderUserId && item.holderUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_certify_own_grant",
        detail: "the decider holds this grant — attesting one's own access is not a review; the campaign opener or an admin must reroute it",
      },
    };
  }
  if (item.holderRoleId) {
    const held = await db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.roleId, item.holderRoleId), eq(roleAssignments.userId, deciderUserId)));
    if (held.length > 0) {
      return {
        status: 403,
        body: {
          error: "cannot_certify_own_grant",
          detail: "the decider holds the role this grant is bundled into — attesting access one enjoys is not a review",
        },
      };
    }
  }
  return null;
}

/** the per-kind execution of a revoke decision — the SAME removal the admin
 * delete endpoints run (grant-revocation.ts), no parallel delete */
async function executeGrantRevocation(
  db: Db,
  item: { grantKind: GrantCertGrantKind; grantId: string },
): Promise<{ mechanism: string; removed: boolean }> {
  switch (item.grantKind) {
    case "agent":
      return { mechanism: "agent_grant_deleted", removed: await deleteAgentGrantById(db, item.grantId) };
    case "connector":
      return { mechanism: "connector_grant_deleted", removed: await deleteConnectorGrantById(db, item.grantId) };
    case "tool":
      return { mechanism: "tool_grant_deleted", removed: await deleteToolGrantById(db, item.grantId) };
    case "server":
      return { mechanism: "server_grant_deleted", removed: await deleteServerGrantById(db, item.grantId) };
    case "role_agent":
      return { mechanism: "role_agent_grant_deleted", removed: await deleteRoleAgentGrantById(db, item.grantId) };
    case "role_connector":
      return { mechanism: "role_connector_grant_deleted", removed: await deleteRoleConnectorGrantById(db, item.grantId) };
    case "role_tool":
      return { mechanism: "role_tool_grant_deleted", removed: await deleteRoleToolGrantById(db, item.grantId) };
    case "role_server":
      return { mechanism: "role_server_grant_deleted", removed: await deleteRoleServerGrantById(db, item.grantId) };
  }
}

/**
 * The in-transaction half, called from `decideOneApproval` exactly like the
 * model_card / infra / project hooks: records the item's decision, EXECUTES a
 * revoke against the real grant row, audits with the campaign as context, and
 * flips the campaign to completed when the last item is decided — all inside
 * the decision's own transaction, so a failed revocation rolls the decision
 * back rather than leaving an attested-but-unenforced record.
 */
export async function applyGrantCertificationDecision(
  tx: Db,
  approval: { id: string },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  // single-row by `grant_cert_items_approval_uq` (ADR-0109 / migration 0108),
  // not by order — see `precheckGrantCertificationDecision`.
  const [item] = await tx
    .select()
    .from(grantCertificationItems)
    .where(eq(grantCertificationItems.approvalId, approval.id));
  if (!item || item.decision !== null) return;
  const keep = decision === "approved";
  const revocation = keep ? null : await executeGrantRevocation(tx, item);
  await tx
    .update(grantCertificationItems)
    .set({
      decision: keep ? "keep" : "revoke",
      decidedByUserId: deciderUserId,
      decidedAt: new Date(),
      revocationDetail: revocation,
    })
    .where(eq(grantCertificationItems.id, item.id));
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "certification_campaign",
    objectId: item.campaignId,
    detail: {
      itemId: item.id,
      approvalId: approval.id,
      grantKind: item.grantKind,
      grantId: item.grantId,
      holder: item.holderLabel,
      object: item.objectLabel,
      ...(item.toolName ? { toolName: item.toolName } : {}),
      ...(revocation ? { revocation } : {}),
    },
    effect: keep ? "allow" : "deny",
    ruleId: keep ? "grant-cert-keep" : "grant-cert-revoke",
    ruleChain: [],
    reason: keep
      ? `certification: '${item.holderLabel}' keeps '${item.objectLabel}' — attested`
      : `certification: '${item.holderLabel}' loses '${item.objectLabel}' — revocation executed (${revocation!.mechanism}${revocation!.removed ? "" : "; grant row was already gone"})`,
  });
  // completion: the last decided item closes the campaign, in this same tx
  const [undecided] = await tx
    .select({ n: count() })
    .from(grantCertificationItems)
    .where(and(eq(grantCertificationItems.campaignId, item.campaignId), isNull(grantCertificationItems.decision)));
  if ((undecided?.n ?? 0) === 0) {
    const completed = await tx
      .update(grantCertificationCampaigns)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(grantCertificationCampaigns.id, item.campaignId), eq(grantCertificationCampaigns.status, "open")))
      .returning({ id: grantCertificationCampaigns.id, name: grantCertificationCampaigns.name });
    if (completed.length > 0) {
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "certification_campaign",
        objectId: item.campaignId,
        detail: { name: completed[0]!.name },
        effect: "allow",
        ruleId: "certification-campaign-completed",
        ruleChain: [],
        reason: `certification campaign '${completed[0]!.name}' completed — every item decided`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Posture: the campaigns line (computed at read time, like everything there)
// ---------------------------------------------------------------------------

export async function certificationPostureSection(db: Db, now: Date) {
  const campaigns = await db
    .select()
    .from(grantCertificationCampaigns);
  const undecidedRows = campaigns.length
    ? await db
        .select({ campaignId: grantCertificationItems.campaignId, n: count() })
        .from(grantCertificationItems)
        .where(isNull(grantCertificationItems.decision))
        .groupBy(grantCertificationItems.campaignId)
    : [];
  const undecidedByCampaign = new Map(undecidedRows.map((r) => [r.campaignId, r.n]));
  const counts = { open: 0, completed: 0, expiredIncomplete: 0 };
  for (const c of campaigns) {
    const s = campaignEffectiveStatus(c, undecidedByCampaign.get(c.id) ?? 0, now);
    if (s === "open") counts.open += 1;
    else if (s === "completed") counts.completed += 1;
    else counts.expiredIncomplete += 1;
  }
  return {
    total: campaigns.length,
    ...counts,
    note:
      campaigns.length === 0
        ? "no certification campaign has ever been run — gateway grants have never been " +
          "re-attested (a stated fact, not a default)"
        : "gateway-grants-only campaigns (ADR-0090): 'expired-incomplete' is computed at read " +
          "time — a past-due campaign whose undecided items stay undecided forever; nothing " +
          "auto-decides on expiry",
  };
}

// ---------------------------------------------------------------------------
// ADR-0090 amendment (batch B2a) — the campaign expiry sweep. VISIBILITY
// ONLY, and that boundary is the whole design: rule 4 above stands untouched.
// ---------------------------------------------------------------------------

/**
 * Record — never decide — that open campaigns have passed their due date with
 * items undecided.
 *
 * READ THIS BEFORE TRUSTING IT: THIS FUNCTION CHANGES NO DECISION AND NO
 * STATUS. `expired-incomplete` stays a read-time projection of stored state
 * (`campaignEffectiveStatus`), the late-decide refusal stays `campaignPastDue`
 * — the SAME predicate this sweep asks, so the sweep and the read can never
 * disagree — and undecided items stay undecided forever. What read-time
 * computation cannot do is put the fact somewhere nobody has to open a page
 * to see: this sweep writes ONE audited `campaign-expired-incomplete` row per
 * campaign the FIRST time it is observed past due (idempotent — a re-run adds
 * nothing), so the audit trail carries the expiry even if no one ever reads
 * the campaign again.
 *
 * Two things call this, and they call THIS, not a copy: the ADR-0064
 * `certification-expiry-sweep` job (when REGULAIT_SCHEDULER=on, which is OFF
 * by default) and `POST /v1/certification-campaigns/expiry-sweep`, the
 * manual/cron door.
 */
export async function runCampaignExpirySweep(
  db: Db,
  opts: { actorUserId: string | null; now?: Date } = { actorUserId: null },
): Promise<{ observed: number; campaignIds: string[] }> {
  const now = opts.now ?? new Date();
  const open = await db
    .select()
    .from(grantCertificationCampaigns)
    .where(eq(grantCertificationCampaigns.status, "open"));
  const campaignIds: string[] = [];
  for (const campaign of open) {
    if (!campaignPastDue(campaign, now)) continue; // within due date: untouched
    const [undecided] = await db
      .select({ n: count() })
      .from(grantCertificationItems)
      .where(and(eq(grantCertificationItems.campaignId, campaign.id), isNull(grantCertificationItems.decision)));
    const undecidedCount = undecided?.n ?? 0;
    if (undecidedCount === 0) continue; // not expired-incomplete (defensive; the last decide completes)
    // idempotence: the fact is recorded ONCE per campaign, ever — the audit
    // log itself is the marker, so no schema state and no second row
    const [already] = await db
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "campaign-expired-incomplete"), eq(auditLog.objectId, campaign.id)));
    if ((already?.n ?? 0) > 0) continue;
    await db.insert(auditLog).values({
      userId: opts.actorUserId ?? campaign.openedByUserId,
      objectType: "certification_campaign",
      objectId: campaign.id,
      detail: {
        phase: "expiry_sweep",
        name: campaign.name,
        dueAt: campaign.dueAt.toISOString(),
        undecidedItems: undecidedCount,
        sweptBy: opts.actorUserId,
      },
      effect: "deny",
      ruleId: "campaign-expired-incomplete",
      ruleChain: [],
      reason:
        `certification campaign '${campaign.name}' passed its due date with ${undecidedCount} item(s) ` +
        "undecided — they stay undecided forever and nothing auto-keeps or auto-revokes; recorded once " +
        "by the expiry sweep so the fact is visible without anyone reading the campaign",
    });
    campaignIds.push(campaign.id);
  }
  return { observed: campaignIds.length, campaignIds };
}

// ---------------------------------------------------------------------------
// Routes (admin-only via the default gate — opening a review of the org's
// grant rows and reading who holds what is the same class of record as the
// inventory). Reviewer DECISIONS deliberately have no route here: they ride
// POST /v1/approvals/:approvalId/decide like every other decision.
// ---------------------------------------------------------------------------

export function registerGrantCertificationRoutes(app: FastifyInstance, db: Db): void {
  /** preview a scope before opening: how many items would the campaign hold */
  app.post("/v1/certification-campaigns/preview", async (req, reply) => {
    const { scope } = z.object({ scope: scopeSchema }).parse(req.body);
    try {
      const items = await snapshotGrantsForScope(
        db,
        { kind: scope.kind, value: scope.value ?? null },
        req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      );
      const byKind: Record<string, number> = {};
      for (const i of items) byKind[i.grantKind] = (byKind[i.grantKind] ?? 0) + 1;
      return { count: items.length, byKind, notes: CERTIFICATION_NOTES };
    } catch (err) {
      if (err instanceof ScopeError) return reply.status(err.status).send(err.body);
      throw err;
    }
  });

  app.post("/v1/certification-campaigns", async (req, reply) => {
    const body = openCampaignSchema.parse(req.body);
    const openerUserId = req.authCtx.userId;
    if (!openerUserId) {
      // the opener is the default reviewer and an accountability record — an
      // identityless bootstrap token cannot hold either role
      return reply.status(403).send({ error: "bootstrap_cannot_open_campaign" });
    }
    const dueAt = new Date(body.dueAt);
    if (dueAt.getTime() <= Date.now()) {
      return reply.status(422).send({
        error: "due_date_past",
        detail: "a campaign's due date must be in the future — opening it already expired would mint an 'expired-incomplete' posture fact nobody could have acted on",
      });
    }
    let items: SnapshotItem[];
    try {
      items = await snapshotGrantsForScope(db, { kind: body.scope.kind, value: body.scope.value ?? null }, openerUserId);
    } catch (err) {
      if (err instanceof ScopeError) return reply.status(err.status).send(err.body);
      throw err;
    }
    if (items.length === 0) {
      return reply.status(422).send({
        error: "no_grants_in_scope",
        detail: "this scope matches no grant rows — a campaign with nothing to review would be attestation theatre",
      });
    }
    const campaign = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(grantCertificationCampaigns)
        .values({
          name: body.name,
          scopeKind: body.scope.kind,
          scopeValue: body.scope.value ?? null,
          openedByUserId: openerUserId,
          dueAt,
        })
        .returning();
      const itemRows = await tx
        .insert(grantCertificationItems)
        .values(items.map((i) => ({ ...i, campaignId: row!.id })))
        .returning({
          id: grantCertificationItems.id,
          holderUserId: grantCertificationItems.holderUserId,
          reviewerUserId: grantCertificationItems.reviewerUserId,
        });
      // one approvals row per item — the decision lands in the ONE queue.
      // userId = the holder where a single human holds the grant (so the
      // queue's own self-review surface stays truthful), else the opener.
      const approvalRows = await tx
        .insert(approvals)
        .values(
          itemRows.map((i) => ({
            userId: i.holderUserId ?? openerUserId,
            objectType: "grant_certification" as const,
            approverUserId: i.reviewerUserId,
            stageId: `${GRANT_CERT_PREFIX}${i.id}`,
          })),
        )
        .returning({ id: approvals.id, stageId: approvals.stageId });
      for (const a of approvalRows) {
        const itemId = a.stageId!.slice(GRANT_CERT_PREFIX.length);
        await tx
          .update(grantCertificationItems)
          .set({ approvalId: a.id })
          .where(eq(grantCertificationItems.id, itemId));
      }
      await tx.insert(auditLog).values({
        userId: openerUserId,
        objectType: "certification_campaign",
        objectId: row!.id,
        detail: {
          name: body.name,
          scope: { kind: body.scope.kind, value: body.scope.value ?? null },
          dueAt: dueAt.toISOString(),
          items: itemRows.length,
        },
        effect: "allow",
        ruleId: "certification-campaign-opened",
        ruleChain: [],
        reason: `certification campaign '${body.name}' opened over ${itemRows.length} grant(s) (scope: ${body.scope.kind}) — snapshot at open; grants created later are out of scope`,
      });
      return row!;
    });
    return reply.status(201).send({ ...campaign, items: items.length, notes: CERTIFICATION_NOTES });
  });

  app.get("/v1/certification-campaigns", async () => {
    const now = new Date();
    const campaigns = await db
      .select()
      .from(grantCertificationCampaigns)
      .orderBy(desc(grantCertificationCampaigns.createdAt));
    const itemAgg = campaigns.length
      ? await db
          .select({
            campaignId: grantCertificationItems.campaignId,
            decision: grantCertificationItems.decision,
            n: count(),
          })
          .from(grantCertificationItems)
          .groupBy(grantCertificationItems.campaignId, grantCertificationItems.decision)
      : [];
    const openerIds = [...new Set(campaigns.map((c) => c.openedByUserId))];
    const openerRows = openerIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, openerIds))
      : [];
    const openerName = new Map(openerRows.map((u) => [u.id, u.displayName || u.email]));
    return {
      notes: CERTIFICATION_NOTES,
      campaigns: campaigns.map((c) => {
        const rows = itemAgg.filter((r) => r.campaignId === c.id);
        const of = (d: "keep" | "revoke" | null) => rows.find((r) => r.decision === d)?.n ?? 0;
        const undecided = of(null);
        return {
          id: c.id,
          name: c.name,
          scope: { kind: c.scopeKind, value: c.scopeValue },
          openedBy: { userId: c.openedByUserId, name: openerName.get(c.openedByUserId) ?? null },
          dueAt: c.dueAt.toISOString(),
          status: campaignEffectiveStatus(c, undecided, now),
          storedStatus: c.status,
          completedAt: c.completedAt ? c.completedAt.toISOString() : null,
          createdAt: c.createdAt.toISOString(),
          items: { total: rows.reduce((a, r) => a + r.n, 0), keep: of("keep"), revoke: of("revoke"), undecided },
        };
      }),
    };
  });

  app.get("/v1/certification-campaigns/:campaignId", async (req, reply) => {
    const { campaignId } = campaignIdParam.parse(req.params);
    const [campaign] = await db
      .select()
      .from(grantCertificationCampaigns)
      .where(eq(grantCertificationCampaigns.id, campaignId));
    if (!campaign) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    const items = await db
      .select()
      .from(grantCertificationItems)
      .where(eq(grantCertificationItems.campaignId, campaignId));
    const nameIds = [
      ...new Set([
        campaign.openedByUserId,
        ...items.map((i) => i.reviewerUserId),
        ...items.map((i) => i.decidedByUserId).filter((u): u is string => u !== null),
      ]),
    ];
    const nameRows = nameIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, nameIds))
      : [];
    const nameOf = new Map(nameRows.map((u) => [u.id, u.displayName || u.email]));
    const undecided = items.filter((i) => i.decision === null).length;
    return {
      id: campaign.id,
      name: campaign.name,
      scope: { kind: campaign.scopeKind, value: campaign.scopeValue },
      openedBy: { userId: campaign.openedByUserId, name: nameOf.get(campaign.openedByUserId) ?? null },
      dueAt: campaign.dueAt.toISOString(),
      status: campaignEffectiveStatus(campaign, undecided, now),
      storedStatus: campaign.status,
      completedAt: campaign.completedAt ? campaign.completedAt.toISOString() : null,
      createdAt: campaign.createdAt.toISOString(),
      notes: CERTIFICATION_NOTES,
      items: items.map((i) => ({
        id: i.id,
        grantKind: i.grantKind,
        grantId: i.grantId,
        holder: { userId: i.holderUserId, roleId: i.holderRoleId, label: i.holderLabel },
        object: { id: i.objectId, label: i.objectLabel, toolName: i.toolName },
        reviewer: { userId: i.reviewerUserId, name: nameOf.get(i.reviewerUserId) ?? null },
        approvalId: i.approvalId,
        decision: i.decision,
        decidedBy: i.decidedByUserId ? { userId: i.decidedByUserId, name: nameOf.get(i.decidedByUserId) ?? null } : null,
        decidedAt: i.decidedAt ? i.decidedAt.toISOString() : null,
        revocation: i.revocationDetail ?? null,
      })),
    };
  });

  /** the B2a sweep's manual/cron door — the ADR-0064 pattern: this calls
   * EXACTLY the function the `certification-expiry-sweep` scheduler job
   * calls, so a manual run and a scheduled run are one code path. It records
   * visibility facts only; it decides nothing (see runCampaignExpirySweep). */
  app.post("/v1/certification-campaigns/expiry-sweep", async (req) => {
    const result = await runCampaignExpirySweep(db, { actorUserId: req.authCtx.userId ?? null });
    return {
      ...result,
      note:
        "visibility only: one audited campaign-expired-incomplete fact per past-due campaign, the " +
        "first time it is observed — no status written, no item decided, nothing auto-keeps or " +
        "auto-revokes. 'expired-incomplete' remains computed on read from the same predicate.",
    };
  });

  /**
   * ADR-0090 amendment (batch B2b) — reassign an ITEM's reviewer. The ADR
   * shipped with "no reassignment": an item routed to a reviewer who then
   * becomes unavailable was decidable only via the generic admin override.
   * This gives the operation a first-class, audited, reason-required act —
   * admin-only via the default gate — with two hard bars:
   *
   *  - NEVER to the grant's holder. The ADR-0022 decider-keyed self-review
   *    bar extends to routing: handing the holder their own item would set up
   *    the exact self-certification the decide path refuses, so the routing
   *    act refuses first, by name (`cannot_reassign_to_holder`) — and a
   *    recorded reason does NOT help, because the bar is about who would
   *    sign, not about how well the move is documented.
   *  - NEVER on a decided item (`item_already_decided`) and never on a
   *    past-due campaign (`campaign_expired`, the same shared predicate the
   *    decide path refuses with — an undecided-forever item has no reviewer
   *    to move).
   *
   * The approvals-row move rides `reassignApprovalApprover` — ADR-0046's one
   * approver-moving write (the SLA `reassign` escalation) — never a parallel
   * UPDATE, so the queue and the item can never learn different reviewers.
   */
  app.post("/v1/certification-campaigns/:campaignId/items/:itemId/reassign", async (req, reply) => {
    const params = z.object({ campaignId: z.string().uuid(), itemId: z.string().uuid() }).parse(req.params);
    const body = z.object({ reviewerUserId: z.string().uuid(), reason: z.string().min(1) }).parse(req.body);
    const actorUserId = req.authCtx.userId;
    if (!actorUserId) {
      // moving a named review is an accountability record — an identityless
      // bootstrap token cannot author one (the campaign-open rule)
      return reply.status(403).send({ error: "bootstrap_cannot_reassign" });
    }
    const [campaign] = await db
      .select()
      .from(grantCertificationCampaigns)
      .where(eq(grantCertificationCampaigns.id, params.campaignId));
    if (!campaign) return reply.status(404).send({ error: "not_found" });
    const [item] = await db
      .select()
      .from(grantCertificationItems)
      .where(and(eq(grantCertificationItems.id, params.itemId), eq(grantCertificationItems.campaignId, params.campaignId)));
    if (!item) return reply.status(404).send({ error: "not_found" });
    if (item.decision !== null) {
      return reply.status(409).send({
        error: "item_already_decided",
        detail: "this item is decided — a recorded attestation keeps its reviewer; reassignment moves pending reviews only",
      });
    }
    if (campaign.status === "open" && campaignPastDue(campaign, new Date())) {
      return reply.status(409).send({
        error: "campaign_expired",
        detail:
          "this campaign is past its due date — its undecided items stay undecided forever, so there " +
          "is no pending review to move; open a new campaign to review these grants",
      });
    }
    const [reviewer] = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.reviewerUserId));
    if (!reviewer || reviewer.disabledAt) {
      return reply.status(400).send({ error: "invalid_reference", field: "reviewerUserId" });
    }
    // THE BAR: the holder never reviews their own grant — refused at routing
    // time for the same reason the decide path refuses it at signing time.
    // Keyed on the would-be reviewer's actual holding (direct, or a current
    // assignment of the bundling role), and no reason unlocks it.
    let reviewerHolds = item.holderUserId !== null && item.holderUserId === body.reviewerUserId;
    if (!reviewerHolds && item.holderRoleId) {
      const held = await db
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(and(eq(roleAssignments.roleId, item.holderRoleId), eq(roleAssignments.userId, body.reviewerUserId)));
      reviewerHolds = held.length > 0;
    }
    if (reviewerHolds) {
      return reply.status(403).send({
        error: "cannot_reassign_to_holder",
        detail:
          "the proposed reviewer holds this grant — routing them their own item would set up a " +
          "self-certification the decide path refuses (cannot_certify_own_grant); no reason unlocks " +
          "this, because the bar is about who would sign",
      });
    }
    if (!item.approvalId) return reply.status(409).send({ error: "item_has_no_approval" });
    const previousReviewerUserId = item.reviewerUserId;
    const outcome = await db.transaction(async (tx) => {
      // ADR-0046's one approver-moving write — pending-guarded, never decides
      const moved = await reassignApprovalApprover(tx as unknown as Db, item.approvalId!, body.reviewerUserId);
      if (!moved) return { moved: false as const };
      await tx
        .update(grantCertificationItems)
        .set({ reviewerUserId: body.reviewerUserId })
        .where(eq(grantCertificationItems.id, item.id));
      await tx.insert(auditLog).values({
        userId: actorUserId,
        objectType: "certification_campaign",
        objectId: campaign.id,
        detail: {
          phase: "reassign",
          itemId: item.id,
          approvalId: item.approvalId,
          grantKind: item.grantKind,
          grantId: item.grantId,
          holder: item.holderLabel,
          object: item.objectLabel,
          previousReviewerUserId,
          reviewerUserId: body.reviewerUserId,
          reason: body.reason,
        },
        effect: "allow",
        ruleId: "grant-cert-item-reassigned",
        ruleChain: [],
        reason:
          `certification item '${item.holderLabel} · ${item.objectLabel}' reassigned to ` +
          `'${reviewer.displayName || reviewer.email}': ${body.reason} — routing moves whose queue ` +
          "the item shows in, never who is allowed to decide (the one decide path enforces that)",
      });
      return { moved: true as const };
    });
    if (!outcome.moved) {
      return reply.status(409).send({
        error: "approval_not_pending",
        detail: "the item's queue row is no longer pending — nothing was moved",
      });
    }
    return {
      reassigned: true,
      itemId: item.id,
      previousReviewerUserId,
      reviewerUserId: body.reviewerUserId,
    };
  });
}
