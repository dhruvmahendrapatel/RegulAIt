/**
 * ADR-0091 — TOXIC-COMBINATION SEGREGATION OF DUTIES (gap L23,
 * docs/product/GAP_ANALYSIS_SAVIYNT_2026-08.md).
 *
 * Saviynt's SoD franchise is cross-application ERP rulesets. Ours is
 * deliberately narrower and OURS: an admin declares that two GATEWAY
 * capabilities — an agent, a connector (optionally at a mode), an MCP tool,
 * an MCP server — are toxic together, and from then on no single identity
 * can come to hold both, enforced where gateway grants are MINTED. The
 * ERP/cross-app half stays refused on the comparison page.
 *
 * THE FIVE RULES THIS FILE EXISTS TO KEEP HONEST
 * ----------------------------------------------
 *  1. THE CHOKE POINT IS THE MINT, AND EVERY MINT PATH IS GATED. Direct
 *     grants (agent/connector/MCP tool/MCP server), grants to a ROLE that
 *     has assignees (checked against EVERY current assignee — an SoD check
 *     that ignored role-derived holdings would be vacuous), and role
 *     ASSIGNMENT (the role's whole bundle against the assignee's effective
 *     holdings, including bundle-internal pairs). A refusal is a named 409
 *     (`sod_conflict`) carrying the rule, its reason, and the existing
 *     holding that conflicts — audited, with NO grant row written.
 *  2. HOLDINGS ARE WHAT ENFORCEMENT SEES. "Does this identity hold X" is
 *     answered as direct ∪ role-derived − revocations, computed against the
 *     same tables the kernel's own entitlement loaders read — for agents by
 *     IMPORTING ADR-0082/0090's `buildAgentHolderIndex` (the ONE granted
 *     computation), never a parallel notion of "has access".
 *  3. A RULE NEVER REVOKES. Creating or enabling a rule with existing
 *     violators strips nobody — silent revocation by side effect is the
 *     kind of magic this product refuses. Violators are COMPUTED AT READ
 *     TIME (rule-creation response, the rules list, inventory, posture) and
 *     resolved by a human through ADR-0090 campaigns or ordinary
 *     revocation. Enforcement is preventive from the moment the rule
 *     exists; it is never retroactive.
 *  4. THE OVERRIDE RIDES THE ONE QUEUE. A refused mint may be escalated:
 *     the escalation re-checks the conflict SERVER-SIDE (a client cannot
 *     assert which rule it is overriding), stores the exact refused
 *     payload, and creates one ordinary approvals row. The bar is
 *     DECIDER-keyed (the ADR-0022 lesson): the requester can never sign
 *     their own override, not via delegation, not via admin override.
 *     Approval executes the stored mint inside the decision's own
 *     transaction with `sodOverride: {ruleId, approvalId}` in the audit
 *     detail; denial mints nothing.
 *  5. SIDES ARE DATA, NEVER CODE (the ADR-0091 amendment, batch B2c). A rule
 *     names 2..N capability sides; the conflict is strict — an identity's
 *     effective holdings must contain ALL sides (any N-1 subset is fine).
 *     A side is CONCRETE (one id) or a PATTERN over an ENUMERABLE dimension
 *     the schema actually has: agent lifecycle status, agent provider kind,
 *     or connector holding mode. NO free-form regex or name-matching
 *     anywhere (the ADR-0085 data-only-rules discipline), and patterns
 *     resolve at CHECK time against current objects — a new agent matching
 *     the pattern is covered the moment it exists. Pre-amendment two-sided
 *     rows are read byte-identically through the same loader.
 */
import type { FastifyInstance } from "fastify";
import {
  AGENT_LIFECYCLE_STATUSES,
  SOD_MINT_KINDS,
  SOD_PATTERN_DIMENSIONS,
  agentGrants,
  agents,
  and,
  approvals,
  auditLog,
  connectorGrants,
  connectorRevocations,
  connectors,
  eq,
  inArray,
  mcpServers,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  sodOverrideRequests,
  sodRuleSides,
  sodRules,
  toolGrants,
  users,
  type Db,
  type SodCapabilityKind,
  type SodMintKind,
  type SodPatternDimension,
  type SodRuleRow,
} from "@regulait/db";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
// the CLOSED provider vocabulary agents.provider speaks — the pattern
// dimension 'provider' validates against it, never against free text
import { MODEL_PROVIDER_KINDS } from "@regulait/model-provider";
import { z } from "zod";
import { buildAgentHolderIndex } from "./inventory.js";

/** the `approvals.stageId` sentinel carrying the override-request id — the
 * same slot the model-card / infra / grant-cert rows use, because riding the
 * ONE queue with no new approvals column is the whole point */
export const SOD_OVERRIDE_PREFIX = "__sod_override__:";

export const SOD_NOTES = {
  scope:
    "rules over GATEWAY capabilities only — the agent/connector/MCP tool/server grants this " +
    "gateway mints and enforces. SoD over another system's entitlements (ERP transactions, " +
    "cross-application rulesets) is IGA's fight, refused on the comparison page.",
  enforcement:
    "preventive at MINT time: a direct grant, a grant to a role with assignees, or a role " +
    "assignment that would leave any identity holding both sides is refused by name " +
    "(sod_conflict). A rule created AFTER the fact only reports — existing violators are " +
    "surfaced here, in the inventory and in posture, and are NEVER auto-revoked; resolve them " +
    "through a certification campaign (ADR-0090) or ordinary revocation.",
  override:
    "a refused mint can be escalated into the one approvals queue; an arm's-length approver " +
    "(never the requester — the bar is keyed on who actually signs) approving it executes the " +
    "refused mint with the overridden rule recorded in the audit detail. Denied = nothing minted.",
} as const;

// ---------------------------------------------------------------------------
// Selectors and capabilities
// ---------------------------------------------------------------------------

export interface SodSelector {
  kind: SodCapabilityKind;
  /** null iff this is a PATTERN side (the pattern below says which objects) */
  objectId: string | null;
  /** mcp_tool only: the tool's name on that server */
  toolName: string | null;
  /** connector only: null = any mode; 'readwrite' matches only readwrite
   * grants; 'read' matches read AND readwrite (capability containment — a
   * readwrite holder can read). The 'mode' PATTERN sets this to its value,
   * so the one containment rule serves both shapes. */
  mode: "read" | "readwrite" | null;
  /** ADR-0091 amendment (B2c): an enumerable (dimension, value) pair over
   * the CLOSED SOD_PATTERN_DIMENSIONS vocabulary — never free text. null =
   * concrete side. Patterns resolve at CHECK time against current objects. */
  pattern: { dimension: SodPatternDimension; value: string } | null;
}

/** a capability a mint would confer (same vocabulary as a selector side) */
interface Capability {
  kind: SodCapabilityKind;
  objectId: string;
  toolName: string | null;
  mode: "read" | "readwrite" | null;
}

/** a selector with its pattern resolved to the CURRENT matching object ids
 * (null = any object of the kind — the connector 'mode' pattern). Resolution
 * happens at check/read time, never at rule-creation time, which is what
 * makes a later-created agent covered the moment it exists. */
interface ResolvedSelector {
  sel: SodSelector;
  objectIds: Set<string> | null;
}

/** resolve one side against the database's CURRENT objects */
export async function resolveSelectorObjects(db: Db, sel: SodSelector): Promise<ResolvedSelector> {
  if (!sel.pattern) return { sel, objectIds: new Set([sel.objectId!]) };
  if (sel.pattern.dimension === "lifecycle_status") {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.lifecycleStatus, sel.pattern.value as (typeof AGENT_LIFECYCLE_STATUSES)[number]));
    return { sel, objectIds: new Set(rows.map((r) => r.id)) };
  }
  if (sel.pattern.dimension === "provider") {
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.provider, sel.pattern.value));
    return { sel, objectIds: new Set(rows.map((r) => r.id)) };
  }
  // 'mode': any connector held at the pattern's mode — the mode qualifier on
  // the selector (set at load time) does the containment work; no narrowing
  return { sel, objectIds: null };
}

function capabilityMatchesSelector(cap: Capability, resolved: ResolvedSelector): boolean {
  const sel = resolved.sel;
  if (cap.kind !== sel.kind) return false;
  if (resolved.objectIds !== null && !resolved.objectIds.has(cap.objectId)) return false;
  if (sel.kind === "mcp_tool" && cap.toolName !== sel.toolName) return false;
  if (sel.kind === "connector" && sel.mode !== null) {
    // containment: a readwrite grant satisfies a 'read' selector
    if (sel.mode === "readwrite" && cap.mode !== "readwrite") return false;
    if (sel.mode === "read" && cap.mode !== "read" && cap.mode !== "readwrite") return false;
  }
  return true;
}

const sideA = (r: SodRuleRow): SodSelector => ({
  kind: r.aKind!,
  objectId: r.aObjectId,
  toolName: r.aToolName,
  mode: r.aMode,
  pattern: null,
});
const sideB = (r: SodRuleRow): SodSelector => ({
  kind: r.bKind!,
  objectId: r.bObjectId,
  toolName: r.bToolName,
  mode: r.bMode,
  pattern: null,
});

/**
 * THE ONE SIDE LOADER — both storage shapes come out as the same selector
 * list. A pre-0097 rule keeps its two legacy columns (read byte-identically);
 * an amendment-shape rule stores every side (2..N, concrete or pattern) in
 * `sod_rule_sides`. Nothing downstream knows which shape a rule uses.
 */
export async function loadRuleSelectors(db: Db, rules: SodRuleRow[]): Promise<Map<string, SodSelector[]>> {
  const out = new Map<string, SodSelector[]>();
  if (rules.length === 0) return out;
  const childSided = rules.filter((r) => r.aKind === null);
  const childRows = childSided.length
    ? await db
        .select()
        .from(sodRuleSides)
        .where(
          inArray(
            sodRuleSides.ruleId,
            childSided.map((r) => r.id),
          ),
        )
        .orderBy(sodRuleSides.ruleId, sodRuleSides.position)
    : [];
  for (const rule of rules) {
    if (rule.aKind !== null) {
      out.set(rule.id, [sideA(rule), sideB(rule)]);
      continue;
    }
    out.set(
      rule.id,
      childRows
        .filter((s) => s.ruleId === rule.id)
        .map((s) => ({
          kind: s.kind,
          objectId: s.objectId,
          toolName: s.toolName,
          // the 'mode' pattern rides the mode qualifier so containment stays one rule
          mode:
            s.selector === "pattern" && s.patternDimension === "mode"
              ? (s.patternValue as "read" | "readwrite")
              : s.mode,
          pattern: s.selector === "pattern" ? { dimension: s.patternDimension!, value: s.patternValue! } : null,
        })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effective holders of one capability — direct ∪ role-derived − revocations
// ---------------------------------------------------------------------------

/**
 * Who effectively holds the capability a selector names, with a one-line
 * description of the holding path (the refusal's "existing holding").
 *
 * The semantics mirror the kernel's own entitlement composition per kind:
 *  - agent: IMPORTED from `buildAgentHolderIndex` (ADR-0082/0090's one
 *    granted computation) — direct ∪ role-derived, minus ADR-0019 agent
 *    revocations (which beat BOTH direct and role grants).
 *  - connector: direct ∪ role-derived grant modes; a 'full' connector
 *    revocation removes everything, a 'read_only' one downgrades readwrite
 *    to read (O9 semantics), then the selector's mode qualifier is applied
 *    with containment (readwrite satisfies 'read').
 *  - mcp_tool / mcp_server: direct grants survive MCP revocations (a direct
 *    MCP grant is itself the per-user override — the `revocations` table is
 *    role-only by design); a 'full' revocation naming the tool (or the whole
 *    server) suppresses the role-derived path. A 'read_only' MCP revocation
 *    narrows call kinds, not the holding, so it does not remove a holding
 *    here (stated in ADR-0091's limits).
 */
async function holdersOfSelector(db: Db, sel: SodSelector): Promise<Map<string, string>> {
  const holders = new Map<string, string>();
  const describe = (via: string) => via;

  if (sel.kind === "agent") {
    // concrete: exactly the one id. Pattern: the CURRENT matching agents,
    // resolved live — a later-created agent joins the moment it exists.
    const resolved = await resolveSelectorObjects(db, sel);
    const agentIds = [...(resolved.objectIds ?? [])];
    if (agentIds.length === 0) return holders;
    const index = await buildAgentHolderIndex(db);
    const patternNames = sel.pattern
      ? new Map(
          (
            await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
          ).map((a) => [a.id, a.name]),
        )
      : null;
    for (const agentId of agentIds) {
      const suffix = patternNames ? ` on agent '${patternNames.get(agentId) ?? agentId}'` : "";
      const set = index.holders.get(agentId) ?? new Set<string>();
      const direct = index.directUsers.get(agentId) ?? new Set<string>();
      const grantingRoles = index.grantingRoles.get(agentId) ?? new Set<string>();
      for (const uid of set) {
        if (holders.has(uid)) continue; // first matching agent's path wins
        if (direct.has(uid)) {
          holders.set(uid, describe(`a direct agent grant${suffix}`));
          continue;
        }
        const via = [...grantingRoles].find((rid) => index.roleUsers.get(rid)?.has(uid));
        holders.set(uid, describe(`role '${via ? (index.roleName.get(via) ?? via) : "?"}' (agent grant)${suffix}`));
      }
    }
    return holders;
  }

  if (sel.kind === "connector") {
    // concrete: the one connector. 'mode' pattern: ANY connector held at the
    // qualifying mode — the same per-connector revocation semantics, applied
    // connector by connector, first qualifying holding wins.
    const concreteId = sel.objectId;
    const [direct, roleGrants, assignments, revs, roleRows, connectorRows] = await Promise.all([
      concreteId
        ? db
            .select({ userId: connectorGrants.userId, mode: connectorGrants.mode, connectorId: connectorGrants.connectorId })
            .from(connectorGrants)
            .where(eq(connectorGrants.connectorId, concreteId))
        : db
            .select({ userId: connectorGrants.userId, mode: connectorGrants.mode, connectorId: connectorGrants.connectorId })
            .from(connectorGrants),
      concreteId
        ? db
            .select({ roleId: roleConnectorGrants.roleId, mode: roleConnectorGrants.mode, connectorId: roleConnectorGrants.connectorId })
            .from(roleConnectorGrants)
            .where(eq(roleConnectorGrants.connectorId, concreteId))
        : db
            .select({ roleId: roleConnectorGrants.roleId, mode: roleConnectorGrants.mode, connectorId: roleConnectorGrants.connectorId })
            .from(roleConnectorGrants),
      db.select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId }).from(roleAssignments),
      concreteId
        ? db
            .select({ userId: connectorRevocations.userId, scope: connectorRevocations.scope, connectorId: connectorRevocations.connectorId })
            .from(connectorRevocations)
            .where(eq(connectorRevocations.connectorId, concreteId))
        : db
            .select({ userId: connectorRevocations.userId, scope: connectorRevocations.scope, connectorId: connectorRevocations.connectorId })
            .from(connectorRevocations),
      db.select({ id: roles.id, name: roles.name }).from(roles),
      sel.pattern ? db.select({ id: connectors.id, name: connectors.name }).from(connectors) : Promise.resolve([]),
    ]);
    const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
    const connectorName = new Map(connectorRows.map((c) => [c.id, c.name]));
    const roleUsers = new Map<string, string[]>();
    for (const a of assignments) roleUsers.set(a.roleId, [...(roleUsers.get(a.roleId) ?? []), a.userId]);
    // revocations are per (user, connector) — keyed that way so the 'mode'
    // pattern applies each connector's revocation to that connector only
    const revBy = new Map(revs.map((r) => [`${r.userId}:${r.connectorId}`, r.scope]));
    // per user: every (mode, via, connector) triple, revocation-adjusted
    const candidates = new Map<string, Array<{ mode: "read" | "readwrite"; via: string; connectorId: string }>>();
    const push = (uid: string, mode: "read" | "readwrite", via: string, connectorId: string) =>
      candidates.set(uid, [...(candidates.get(uid) ?? []), { mode, via, connectorId }]);
    const suffix = (connectorId: string) =>
      sel.pattern ? ` on connector '${connectorName.get(connectorId) ?? connectorId}'` : "";
    for (const g of direct) push(g.userId, g.mode, `a direct connector grant (${g.mode})${suffix(g.connectorId)}`, g.connectorId);
    for (const g of roleGrants) {
      for (const uid of roleUsers.get(g.roleId) ?? []) {
        push(uid, g.mode, `role '${roleName.get(g.roleId) ?? g.roleId}' (connector grant, ${g.mode})${suffix(g.connectorId)}`, g.connectorId);
      }
    }
    for (const [uid, entries] of candidates) {
      for (const e of entries) {
        const rev = revBy.get(`${uid}:${e.connectorId}`);
        if (rev === "full") continue; // this connector's holding is gone
        const effective = rev === "read_only" && e.mode === "readwrite" ? "read" : e.mode;
        const matches =
          sel.mode === null ||
          (sel.mode === "readwrite" ? effective === "readwrite" : effective === "read" || effective === "readwrite");
        if (matches) {
          holders.set(uid, describe(e.via + (rev === "read_only" ? ", narrowed to read by a revocation" : "")));
          break;
        }
      }
    }
    return holders;
  }

  // mcp_tool / mcp_server — direct grants survive MCP revocations (role-only
  // by design); a 'full' revocation suppresses the role-derived path. No
  // pattern dimensions exist for MCP kinds, so the side is always concrete.
  const isTool = sel.kind === "mcp_tool";
  const serverId = sel.objectId!;
  const [direct, roleGrants, assignments, revs, roleRows] = await Promise.all([
    isTool
      ? db
          .select({ userId: toolGrants.userId })
          .from(toolGrants)
          .where(and(eq(toolGrants.serverId, serverId), eq(toolGrants.toolName, sel.toolName ?? "")))
      : db
          .select({ userId: serverGrants.userId })
          .from(serverGrants)
          .where(eq(serverGrants.serverId, serverId)),
    isTool
      ? db
          .select({ roleId: roleToolGrants.roleId })
          .from(roleToolGrants)
          .where(and(eq(roleToolGrants.serverId, serverId), eq(roleToolGrants.toolName, sel.toolName ?? "")))
      : db
          .select({ roleId: roleServerGrants.roleId })
          .from(roleServerGrants)
          .where(eq(roleServerGrants.serverId, serverId)),
    db.select({ roleId: roleAssignments.roleId, userId: roleAssignments.userId }).from(roleAssignments),
    db
      .select({ userId: revocations.userId, toolName: revocations.toolName, scope: revocations.scope })
      .from(revocations)
      .where(eq(revocations.serverId, serverId)),
    db.select({ id: roles.id, name: roles.name }).from(roles),
  ]);
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const roleUsers = new Map<string, string[]>();
  for (const a of assignments) roleUsers.set(a.roleId, [...(roleUsers.get(a.roleId) ?? []), a.userId]);
  const suppressed = new Set(
    revs
      .filter((r) => r.scope === "full" && (r.toolName === null || (isTool && r.toolName === sel.toolName)))
      .map((r) => r.userId),
  );
  for (const g of roleGrants) {
    for (const uid of roleUsers.get(g.roleId) ?? []) {
      if (suppressed.has(uid)) continue;
      holders.set(
        uid,
        describe(`role '${roleName.get(g.roleId) ?? g.roleId}' (${isTool ? "tool" : "server read-all"} grant)`),
      );
    }
  }
  for (const g of direct) {
    holders.set(g.userId, describe(isTool ? "a direct tool grant" : "a direct server read-all grant"));
  }
  return holders;
}

// ---------------------------------------------------------------------------
// The mint-time check
// ---------------------------------------------------------------------------

/** one mint, as the enforcement sees it */
export type SodMint =
  | { kind: "agent"; userId: string; agentId: string }
  | { kind: "connector"; userId: string; connectorId: string; mode: "read" | "readwrite" }
  | { kind: "tool"; userId: string; serverId: string; toolName: string }
  | { kind: "server"; userId: string; serverId: string }
  | { kind: "role_agent"; roleId: string; agentId: string }
  | { kind: "role_connector"; roleId: string; connectorId: string; mode: "read" | "readwrite" }
  | { kind: "role_tool"; roleId: string; serverId: string; toolName: string }
  | { kind: "role_server"; roleId: string; serverId: string }
  | { kind: "role_assignment"; userId: string; roleId: string };

export interface SodConflict {
  rule: SodRuleRow;
  /** the identity that would come to hold every side */
  userId: string;
  /** how they hold (or would co-acquire) the first OTHER side (prose lead) */
  via: string;
  /** that side, as a selector (for the refusal's prose) */
  otherSide: SodSelector;
  /** ADR-0091 amendment (B2c): EVERY side already held via an existing
   * holding (the minted side(s) excluded). For a two-sided rule this is one
   * entry and the refusal reads as before; an N-way refusal names them all. */
  heldSides: Array<{ side: SodSelector; via: string }>;
  /** how many sides the rule has (2 for every pre-amendment rule) */
  sideCount: number;
}

/** the capability set a mint confers + the identities it confers it on */
async function mintFootprint(
  db: Db,
  mint: SodMint,
): Promise<{ capabilities: Capability[]; userIds: string[] }> {
  const cap = (kind: SodCapabilityKind, objectId: string, toolName: string | null = null, mode: "read" | "readwrite" | null = null): Capability => ({ kind, objectId, toolName, mode });
  switch (mint.kind) {
    case "agent":
      return { capabilities: [cap("agent", mint.agentId)], userIds: [mint.userId] };
    case "connector":
      return { capabilities: [cap("connector", mint.connectorId, null, mint.mode)], userIds: [mint.userId] };
    case "tool":
      return { capabilities: [cap("mcp_tool", mint.serverId, mint.toolName)], userIds: [mint.userId] };
    case "server":
      return { capabilities: [cap("mcp_server", mint.serverId)], userIds: [mint.userId] };
    case "role_agent":
    case "role_connector":
    case "role_tool":
    case "role_server": {
      // granting to a role confers on EVERY current assignee — a role with
      // no assignees confers nothing yet (the assignment gate catches it)
      const assignees = await db
        .select({ userId: roleAssignments.userId })
        .from(roleAssignments)
        .where(eq(roleAssignments.roleId, mint.roleId));
      const userIds = [...new Set(assignees.map((a) => a.userId))];
      const capability =
        mint.kind === "role_agent"
          ? cap("agent", mint.agentId)
          : mint.kind === "role_connector"
            ? cap("connector", mint.connectorId, null, mint.mode)
            : mint.kind === "role_tool"
              ? cap("mcp_tool", mint.serverId, mint.toolName)
              : cap("mcp_server", mint.serverId);
      return { capabilities: [capability], userIds };
    }
    case "role_assignment": {
      // assigning a role confers its WHOLE bundle on the assignee
      const [agentsB, connectorsB, toolsB, serversB] = await Promise.all([
        db.select({ agentId: roleAgentGrants.agentId }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, mint.roleId)),
        db
          .select({ connectorId: roleConnectorGrants.connectorId, mode: roleConnectorGrants.mode })
          .from(roleConnectorGrants)
          .where(eq(roleConnectorGrants.roleId, mint.roleId)),
        db
          .select({ serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName })
          .from(roleToolGrants)
          .where(eq(roleToolGrants.roleId, mint.roleId)),
        db.select({ serverId: roleServerGrants.serverId }).from(roleServerGrants).where(eq(roleServerGrants.roleId, mint.roleId)),
      ]);
      return {
        capabilities: [
          ...agentsB.map((g) => cap("agent", g.agentId)),
          ...connectorsB.map((g) => cap("connector", g.connectorId, null, g.mode)),
          ...toolsB.map((g) => cap("mcp_tool", g.serverId, g.toolName)),
          ...serversB.map((g) => cap("mcp_server", g.serverId)),
        ],
        userIds: [mint.userId],
      };
    }
  }
}

/**
 * THE CHECK. Null = no enabled rule objects to this mint. A conflict names
 * the first rule (creation order — deterministic) ALL of whose sides some
 * affected identity would hold after the mint.
 *
 * N-WAY SEMANTICS (ADR-0091 amendment, B2c), stated so the boundary is a
 * sentence and not an accident: a side counts as held when the MINT confers
 * it or an EXISTING effective holding covers it, and the rule refuses only
 * when EVERY side is held — an identity holding any N-1 subset mints freely.
 * For a two-sided rule this is byte-identical to the original check. Pattern
 * sides resolve against CURRENT objects here, at check time.
 */
export async function checkSodMint(
  db: Db,
  mint: SodMint,
  opts: { excludeRuleId?: string } = {},
): Promise<SodConflict | null> {
  const allRules = await db.select().from(sodRules).where(eq(sodRules.enabled, true)).orderBy(sodRules.createdAt);
  // an approved override lifts exactly ONE named rule — the re-check at
  // decision time excludes it and nothing else
  const rules = opts.excludeRuleId ? allRules.filter((r) => r.id !== opts.excludeRuleId) : allRules;
  if (rules.length === 0) return null;
  const { capabilities, userIds } = await mintFootprint(db, mint);
  if (capabilities.length === 0 || userIds.length === 0) return null;
  const selectorsByRule = await loadRuleSelectors(db, rules);

  for (const rule of rules) {
    const sides = selectorsByRule.get(rule.id) ?? [];
    if (sides.length < 2) continue; // defensive: a rule without sides enforces nothing
    const resolved = await Promise.all(sides.map((s) => resolveSelectorObjects(db, s)));
    const mintedSide = resolved.map((r) => capabilities.some((c) => capabilityMatchesSelector(c, r)));
    if (!mintedSide.some(Boolean)) continue; // the mint touches no side of this rule
    // holder maps are computed lazily, once per side, only when needed
    const holderMaps: Array<Map<string, string> | null> = sides.map(() => null);
    const holdersOf = async (i: number): Promise<Map<string, string>> =>
      (holderMaps[i] ??= await holdersOfSelector(db, sides[i]!));
    for (const uid of userIds) {
      const heldSides: Array<{ side: SodSelector; via: string }> = [];
      let allHeld = true;
      for (let i = 0; i < sides.length; i++) {
        if (mintedSide[i]) continue; // conferred by this very mint
        const via = (await holdersOf(i)).get(uid);
        if (!via) {
          // an N-1 subset is fine — this identity is missing a side
          allHeld = false;
          break;
        }
        heldSides.push({ side: sides[i]!, via });
      }
      if (!allHeld) continue;
      if (heldSides.length === 0) {
        // bundle-internal: the SAME mint would confer every side
        return {
          rule,
          userId: uid,
          via: "the same mint (the role's bundle contains both sides)",
          otherSide: sides[1]!,
          heldSides,
          sideCount: sides.length,
        };
      }
      return {
        rule,
        userId: uid,
        via: heldSides[0]!.via,
        otherSide: heldSides[0]!.side,
        heldSides,
        sideCount: sides.length,
      };
    }
  }
  return null;
}

/** human-readable name for a selector's object (refusal prose only) */
async function describeSelector(db: Db, sel: SodSelector): Promise<string> {
  if (sel.pattern) {
    // patterns are (dimension, value) pairs over closed vocabularies — the
    // prose states the dimension so a refusal never reads like a named object
    if (sel.pattern.dimension === "lifecycle_status") return `agents with lifecycle status '${sel.pattern.value}'`;
    if (sel.pattern.dimension === "provider") return `agents from provider '${sel.pattern.value}'`;
    return `any connector (${sel.pattern.value})`;
  }
  if (sel.kind === "agent") {
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, sel.objectId!));
    return `agent '${a?.name ?? sel.objectId}'`;
  }
  if (sel.kind === "connector") {
    const [c] = await db.select({ name: connectors.name }).from(connectors).where(eq(connectors.id, sel.objectId!));
    return `connector '${c?.name ?? sel.objectId}'${sel.mode ? ` (${sel.mode})` : ""}`;
  }
  const [s] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, sel.objectId!));
  return sel.kind === "mcp_tool"
    ? `MCP tool '${s?.name ?? sel.objectId} · ${sel.toolName}'`
    : `MCP server '${s?.name ?? sel.objectId}'`;
}

export interface SodRefusalBody extends Record<string, unknown> {
  error: "sod_conflict";
  ruleId: string;
  ruleName: string;
  ruleReason: string;
  detail: string;
  conflict: {
    userId: string;
    userLabel: string;
    existingHolding: string;
    existingSide: string;
    /** B2c: every already-held side (one entry for a two-sided rule; an
     * N-way refusal names them all) */
    existingSides: Array<{ side: string; via: string }>;
  };
  escalate: string;
}

async function buildRefusalBody(db: Db, conflict: SodConflict): Promise<SodRefusalBody> {
  const [[u], existingSide, existingSides] = await Promise.all([
    db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, conflict.userId)),
    describeSelector(db, conflict.otherSide),
    Promise.all(
      conflict.heldSides.map(async (h) => ({ side: await describeSelector(db, h.side), via: h.via })),
    ),
  ]);
  const userLabel = u ? u.displayName || u.email : conflict.userId;
  const holdsProse =
    existingSides.length > 1
      ? existingSides.map((h) => `${h.side} via ${h.via}`).join("; and ")
      : `${existingSide} via ${conflict.via}`;
  const togetherProse =
    conflict.sideCount === 2
      ? "the two capabilities toxic together"
      : `all ${conflict.sideCount} capabilities toxic together (any ${conflict.sideCount - 1} of them may be co-held; this mint would complete the full set)`;
  return {
    error: "sod_conflict",
    ruleId: conflict.rule.id,
    ruleName: conflict.rule.name,
    ruleReason: conflict.rule.reason,
    detail:
      `SoD rule '${conflict.rule.name}' refuses this: ${userLabel} already holds ${holdsProse}` +
      `, and the rule declares ${togetherProse} ` +
      `(${conflict.rule.reason}). Nothing was granted. Escalate through the approvals queue ` +
      `to mint it anyway with the rule recorded as overridden.`,
    conflict: {
      userId: conflict.userId,
      userLabel,
      existingHolding: conflict.via,
      existingSide,
      existingSides,
    },
    escalate: "POST /v1/sod/overrides",
  };
}

/**
 * The one call every mint endpoint makes: check, and on conflict AUDIT the
 * refusal (`sod-conflict-refused`) and hand back the 409 body. Null = mint
 * may proceed. With no enabled rules this is one indexed query.
 */
export async function refuseSodMint(
  db: Db,
  mint: SodMint,
  actorUserId: string | null,
): Promise<SodRefusalBody | null> {
  const conflict = await checkSodMint(db, mint);
  if (!conflict) return null;
  const body = await buildRefusalBody(db, conflict);
  await db.insert(auditLog).values({
    userId: actorUserId ?? conflict.userId,
    objectType: "sod_rule",
    objectId: conflict.rule.id,
    detail: {
      mintKind: mint.kind,
      mint: mint as unknown as Record<string, unknown>,
      conflict: body.conflict,
      ruleName: conflict.rule.name,
    },
    effect: "deny",
    ruleId: "sod-conflict-refused",
    ruleChain: [],
    reason: body.detail,
  });
  return body;
}

// ---------------------------------------------------------------------------
// Read-time violators — visible, never auto-revoked
// ---------------------------------------------------------------------------

export interface SodViolator {
  userId: string;
  userLabel: string;
  holdsA: string;
  holdsB: string;
  /** B2c: how the identity holds EVERY side, in side order (two entries for
   * a pre-amendment rule — the same values as holdsA/holdsB) */
  holds: string[];
}

/** current violators per rule: the identities holding EVERY side (the
 * intersection of all sides' holder sets — any N-1 subset is not a
 * violation), computed live; pattern sides resolve against current objects */
export async function computeRuleViolators(db: Db, rules: SodRuleRow[]): Promise<Map<string, SodViolator[]>> {
  const out = new Map<string, SodViolator[]>();
  if (rules.length === 0) return out;
  const userIds = new Set<string>();
  const raw = new Map<string, Array<{ userId: string; holdsA: string; holdsB: string; holds: string[] }>>();
  const selectorsByRule = await loadRuleSelectors(db, rules);
  for (const rule of rules) {
    const sides = selectorsByRule.get(rule.id) ?? [];
    if (sides.length < 2) {
      raw.set(rule.id, []);
      continue;
    }
    const maps = await Promise.all(sides.map((s) => holdersOfSelector(db, s)));
    const all: Array<{ userId: string; holdsA: string; holdsB: string; holds: string[] }> = [];
    for (const [uid, viaFirst] of maps[0]!) {
      const holds = [viaFirst];
      let every = true;
      for (let i = 1; i < maps.length; i++) {
        const via = maps[i]!.get(uid);
        if (!via) {
          every = false;
          break;
        }
        holds.push(via);
      }
      if (!every) continue;
      all.push({ userId: uid, holdsA: holds[0]!, holdsB: holds[1]!, holds });
      userIds.add(uid);
    }
    raw.set(rule.id, all);
  }
  const userRows = userIds.size
    ? await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, [...userIds]))
    : [];
  const label = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
  for (const [ruleId, list] of raw) {
    out.set(
      ruleId,
      list.map((v) => ({ ...v, userLabel: label.get(v.userId) ?? v.userId })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Posture + inventory sections (computed at read time, like everything there)
// ---------------------------------------------------------------------------

export async function sodPostureSection(db: Db) {
  const rules = await db.select().from(sodRules);
  const enabled = rules.filter((r) => r.enabled);
  const violators = await computeRuleViolators(db, enabled);
  let currentViolations = 0;
  for (const list of violators.values()) currentViolations += list.length;
  return {
    rules: rules.length,
    enabled: enabled.length,
    currentViolations,
    note:
      rules.length === 0
        ? "no SoD rule is defined — no capability combination is declared toxic (a stated fact, " +
          "not a default posture)"
        : "toxic-combination rules over gateway grants (ADR-0091): enforced preventively at mint " +
          "time; existing violators are surfaced, never auto-revoked — resolve them through a " +
          "certification campaign or ordinary revocation",
  };
}

export async function sodInventorySection(db: Db) {
  const rules = await db.select().from(sodRules).orderBy(sodRules.createdAt);
  const enabled = rules.filter((r) => r.enabled);
  const violators = await computeRuleViolators(db, enabled);
  return {
    rules: rules.length,
    enabled: enabled.length,
    violations: enabled
      .map((r) => ({
        ruleId: r.id,
        name: r.name,
        violators: (violators.get(r.id) ?? []).map((v) => v.userLabel),
      }))
      .filter((v) => v.violators.length > 0),
    note:
      rules.length === 0
        ? "no SoD rule is defined"
        : "violators computed live against effective holdings (direct ∪ role-derived − " +
          "revocations); never auto-revoked",
  };
}

// ---------------------------------------------------------------------------
// The decide-path hooks (called from app.ts `decideOneApproval` — the ONE
// decide path; there is no override-owned decision endpoint anywhere)
// ---------------------------------------------------------------------------

export interface SodDecideRefusal {
  status: number;
  body: Record<string, unknown>;
}

const mintPayloadSchemas: Record<SodMintKind, z.ZodTypeAny> = {
  agent: z.object({ userId: z.string().uuid(), agentId: z.string().uuid() }),
  connector: z.object({
    userId: z.string().uuid(),
    connectorId: z.string().uuid(),
    mode: z.enum(["read", "readwrite"]),
    allowedObjects: z.array(z.string()).optional().nullable(),
  }),
  tool: z.object({ userId: z.string().uuid(), serverId: z.string().uuid(), toolName: z.string().min(1) }),
  server: z.object({ userId: z.string().uuid(), serverId: z.string().uuid() }),
  role_agent: z.object({ roleId: z.string().uuid(), agentId: z.string().uuid() }),
  role_connector: z.object({
    roleId: z.string().uuid(),
    connectorId: z.string().uuid(),
    mode: z.enum(["read", "readwrite"]),
    allowedObjects: z.array(z.string()).optional().nullable(),
  }),
  role_tool: z.object({ roleId: z.string().uuid(), serverId: z.string().uuid(), toolName: z.string().min(1) }),
  role_server: z.object({ roleId: z.string().uuid(), serverId: z.string().uuid() }),
  role_assignment: z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }),
};

function mintFromPayload(kind: SodMintKind, payload: unknown): SodMint {
  const body = mintPayloadSchemas[kind].parse(payload) as Record<string, string>;
  switch (kind) {
    case "agent":
      return { kind, userId: body.userId!, agentId: body.agentId! };
    case "connector":
      return { kind, userId: body.userId!, connectorId: body.connectorId!, mode: body.mode as "read" | "readwrite" };
    case "tool":
      return { kind, userId: body.userId!, serverId: body.serverId!, toolName: body.toolName! };
    case "server":
      return { kind, userId: body.userId!, serverId: body.serverId! };
    case "role_agent":
      return { kind, roleId: body.roleId!, agentId: body.agentId! };
    case "role_connector":
      return { kind, roleId: body.roleId!, connectorId: body.connectorId!, mode: body.mode as "read" | "readwrite" };
    case "role_tool":
      return { kind, roleId: body.roleId!, serverId: body.serverId!, toolName: body.toolName! };
    case "role_server":
      return { kind, roleId: body.roleId!, serverId: body.serverId! };
    case "role_assignment":
      return { kind, userId: body.userId!, roleId: body.roleId! };
  }
}

/**
 * Pre-transaction guards for a sod_override approval, refusing BY NAME:
 *  - `cannot_approve_own_sod_override`: the DECIDER is the requester —
 *    keyed on who actually signs (the ADR-0022 lesson), so the requester
 *    cannot reach their own escalation through delegation or the admin
 *    override either. An override signed by the person it unblocks is not
 *    an arm's-length review at all.
 *  - `sod_conflict` (on approve only): between escalation and decision,
 *    ANOTHER enabled rule came to conflict with the stored mint. The
 *    override names ONE rule; it never silently overrides a second one —
 *    that conflict needs its own escalation.
 */
export async function precheckSodOverrideDecision(
  db: Db,
  approval: { id: string },
  deciderUserId: string,
  decision: "approved" | "denied",
): Promise<SodDecideRefusal | null> {
  // ADR-0109 (migration 0108): `sod_override_approval_uq` UNIQUE (approval_id)
  // WHERE approval_id IS NOT NULL makes this single-row. It matters more here
  // than anywhere else in the deferred set: approving one of these MINTS a
  // grant the SoD engine refused, so a second match would mint against a
  // payload the approver never saw.
  const [request] = await db
    .select()
    .from(sodOverrideRequests)
    .where(eq(sodOverrideRequests.approvalId, approval.id));
  if (!request) return null; // defensive: an orphaned queue row falls through to the generic path
  if (request.requestedByUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_approve_own_sod_override",
        detail:
          "the decider requested this override — signing one's own SoD escalation is not an " +
          "arm's-length review; another approver (or an admin who is not the requester) must decide it",
      },
    };
  }
  if (decision === "approved") {
    const mint = mintFromPayload(request.mintKind, request.mintPayload);
    const conflict = await checkSodMint(db, mint, { excludeRuleId: request.ruleId });
    if (conflict) {
      const body = await buildRefusalBody(db, conflict);
      return {
        status: 409,
        body: {
          ...body,
          detail:
            `approving this override would still violate a DIFFERENT rule: ${body.detail} ` +
            `(this override covers rule '${request.ruleId}' only — the other conflict needs its own escalation)`,
        },
      };
    }
  }
  return null;
}

/** the per-kind execution of an approved override — the same INSERT the
 * refused endpoint would have run, now with the override recorded */
async function executeOverriddenMint(
  tx: Db,
  kind: SodMintKind,
  payload: unknown,
): Promise<{ table: string; grantId: string | null; alreadyExisted: boolean }> {
  const body = mintPayloadSchemas[kind].parse(payload) as Record<string, unknown>;
  const insert = async (
    table: string,
    run: () => Promise<Array<{ id: string }>>,
  ): Promise<{ table: string; grantId: string | null; alreadyExisted: boolean }> => {
    const rows = await run();
    return { table, grantId: rows[0]?.id ?? null, alreadyExisted: rows.length === 0 };
  };
  switch (kind) {
    case "agent":
      return insert("agent_grants", () =>
        tx
          .insert(agentGrants)
          .values({ userId: body.userId as string, agentId: body.agentId as string })
          .onConflictDoNothing()
          .returning({ id: agentGrants.id }),
      );
    case "connector":
      return insert("connector_grants", () =>
        tx
          .insert(connectorGrants)
          .values({
            userId: body.userId as string,
            connectorId: body.connectorId as string,
            mode: body.mode as "read" | "readwrite",
            allowedObjects: (body.allowedObjects as string[] | null | undefined) ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: connectorGrants.id }),
      );
    case "tool":
      return insert("tool_grants", () =>
        tx
          .insert(toolGrants)
          .values({ userId: body.userId as string, serverId: body.serverId as string, toolName: body.toolName as string })
          .onConflictDoNothing()
          .returning({ id: toolGrants.id }),
      );
    case "server":
      return insert("server_grants", () =>
        tx
          .insert(serverGrants)
          .values({ userId: body.userId as string, serverId: body.serverId as string, readOnlyAll: true })
          .onConflictDoNothing()
          .returning({ id: serverGrants.id }),
      );
    case "role_agent":
      return insert("role_agent_grants", () =>
        tx
          .insert(roleAgentGrants)
          .values({ roleId: body.roleId as string, agentId: body.agentId as string })
          .onConflictDoNothing()
          .returning({ id: roleAgentGrants.id }),
      );
    case "role_connector":
      return insert("role_connector_grants", () =>
        tx
          .insert(roleConnectorGrants)
          .values({
            roleId: body.roleId as string,
            connectorId: body.connectorId as string,
            mode: body.mode as "read" | "readwrite",
            allowedObjects: (body.allowedObjects as string[] | null | undefined) ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: roleConnectorGrants.id }),
      );
    case "role_tool":
      return insert("role_tool_grants", () =>
        tx
          .insert(roleToolGrants)
          .values({ roleId: body.roleId as string, serverId: body.serverId as string, toolName: body.toolName as string })
          .onConflictDoNothing()
          .returning({ id: roleToolGrants.id }),
      );
    case "role_server":
      return insert("role_server_grants", () =>
        tx
          .insert(roleServerGrants)
          .values({ roleId: body.roleId as string, serverId: body.serverId as string, readOnlyAll: true })
          .onConflictDoNothing()
          .returning({ id: roleServerGrants.id }),
      );
    case "role_assignment":
      return insert("role_assignments", () =>
        tx
          .insert(roleAssignments)
          .values({ userId: body.userId as string, roleId: body.roleId as string, origin: "direct" })
          .onConflictDoNothing()
          .returning({ id: roleAssignments.id }),
      );
  }
}

/**
 * The in-transaction half, called from `decideOneApproval` exactly like the
 * grant-certification hook: records the request's decision, EXECUTES the
 * stored mint on approve (with `sodOverride: {ruleId, approvalId}` in the
 * audit detail — the grant's paper trail says it exists despite a named
 * rule), and audits a denial that minted nothing.
 */
export async function applySodOverrideDecision(
  tx: Db,
  approval: { id: string },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  // single-row by `sod_override_approval_uq` (ADR-0109 / migration 0108) — see
  // `precheckSodOverrideDecision`.
  const [request] = await tx
    .select()
    .from(sodOverrideRequests)
    .where(eq(sodOverrideRequests.approvalId, approval.id));
  if (!request || request.status !== "pending") return;
  const approved = decision === "approved";
  const mintDetail = approved ? await executeOverriddenMint(tx, request.mintKind, request.mintPayload) : null;
  await tx
    .update(sodOverrideRequests)
    .set({
      status: approved ? "approved" : "denied",
      decidedByUserId: deciderUserId,
      decidedAt: new Date(),
      mintDetail,
    })
    .where(eq(sodOverrideRequests.id, request.id));
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "sod_rule",
    objectId: request.ruleId,
    detail: {
      overrideRequestId: request.id,
      approvalId: approval.id,
      mintKind: request.mintKind,
      mint: request.mintPayload as Record<string, unknown>,
      ...(approved
        ? { sodOverride: { ruleId: request.ruleId, approvalId: approval.id }, minted: mintDetail }
        : {}),
    },
    effect: approved ? "allow" : "deny",
    ruleId: approved ? "sod-override-minted" : "sod-override-denied",
    ruleChain: [],
    reason: approved
      ? `SoD override approved: ${request.label} — the grant was minted with rule ${request.ruleId} recorded as overridden` +
        (mintDetail?.alreadyExisted ? " (the grant row already existed)" : "")
      : `SoD override denied: ${request.label} — nothing was minted`,
  });
}

// ---------------------------------------------------------------------------
// Routes (admin-only via the default gate — SoD rules are org-wide policy,
// the same class of record as approval rules). Override DECISIONS
// deliberately have no route here: they ride POST /v1/approvals/:id/decide.
// ---------------------------------------------------------------------------

const selectorSchema = z.object({
  kind: z.enum(["agent", "connector", "mcp_tool", "mcp_server"]),
  // optional since B2c: a PATTERN side names no object. resolveSelector
  // refuses by name when neither (or both) of objectId/pattern is given.
  objectId: z.string().uuid().optional().nullable(),
  toolName: z.string().min(1).optional().nullable(),
  mode: z.enum(["read", "readwrite"]).optional().nullable(),
  /** B2c pattern selector: an enumerable (dimension, value) pair — the
   * dimension enum IS the whole vocabulary (no free-regex anywhere), and
   * resolveSelector pins each dimension's closed value set */
  pattern: z
    .object({ dimension: z.enum(SOD_PATTERN_DIMENSIONS), value: z.string().min(1) })
    .optional()
    .nullable(),
});
/** B2c: an N-way rule names 2..8 sides. 8 is a sanity cap, not a semantic —
 * a toxic set larger than that is a policy document, not a rule. */
const MAX_RULE_SIDES = 8;
const createRuleSchema = z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
  // either the original two-sided shape (a + b) …
  a: selectorSchema.optional(),
  b: selectorSchema.optional(),
  // … or the B2c N-way shape (2..N sides, concrete and/or pattern)
  sides: z.array(selectorSchema).min(2).max(MAX_RULE_SIDES).optional(),
  enabled: z.boolean().optional(),
});
const ruleIdParam = z.object({ ruleId: z.string().uuid() });
const escalateSchema = z.object({
  mintKind: z.enum(SOD_MINT_KINDS),
  payload: z.record(z.string(), z.unknown()),
  approverUserId: z.string().uuid(),
  justification: z.string().optional(),
});

type SelectorInput = z.infer<typeof selectorSchema>;

/**
 * normalize + validate one side. A CONCRETE side: tool name iff mcp_tool,
 * mode only on connector, and the referenced object must exist. A PATTERN
 * side (B2c): a (dimension, value) pair whose value must sit in that
 * dimension's CLOSED vocabulary — agent lifecycle statuses, the model
 * provider kinds, or read|readwrite — never free text, never a regex; a
 * pattern matching zero objects TODAY is fine (it covers later-created
 * objects the moment they exist), so no existence check applies.
 */
async function resolveSelector(
  db: Db,
  side: string,
  input: SelectorInput,
): Promise<{ sel: SodSelector } | { refusal: { status: number; body: Record<string, unknown> } }> {
  const refuse = (status: number, body: Record<string, unknown>) => ({ refusal: { status, body } });
  if (input.pattern) {
    if (input.objectId) {
      return refuse(422, {
        error: "pattern_and_object_exclusive",
        field: side,
        detail: "a side is either a concrete object or a pattern, never both",
      });
    }
    if (input.toolName || input.mode) {
      return refuse(422, {
        error: "pattern_carries_no_qualifiers",
        field: side,
        detail: "a pattern side is the (dimension, value) pair alone — the 'mode' dimension's value IS the mode",
      });
    }
    const { dimension, value } = input.pattern;
    if (dimension === "lifecycle_status" || dimension === "provider") {
      if (input.kind !== "agent") {
        return refuse(422, {
          error: "invalid_pattern_dimension",
          field: side,
          detail: `dimension '${dimension}' applies to agent sides only`,
        });
      }
      const vocabulary: readonly string[] = dimension === "lifecycle_status" ? AGENT_LIFECYCLE_STATUSES : MODEL_PROVIDER_KINDS;
      if (!vocabulary.includes(value)) {
        return refuse(422, {
          error: "invalid_pattern_value",
          field: side,
          detail: `'${value}' is not in the '${dimension}' vocabulary (${vocabulary.join(", ")}) — pattern values are enumerable, never free text`,
        });
      }
      return { sel: { kind: "agent", objectId: null, toolName: null, mode: null, pattern: { dimension, value } } };
    }
    // dimension === "mode"
    if (input.kind !== "connector") {
      return refuse(422, {
        error: "invalid_pattern_dimension",
        field: side,
        detail: "dimension 'mode' applies to connector sides only",
      });
    }
    if (value !== "read" && value !== "readwrite") {
      return refuse(422, {
        error: "invalid_pattern_value",
        field: side,
        detail: `'${value}' is not in the 'mode' vocabulary (read, readwrite)`,
      });
    }
    // the pattern's mode rides the mode qualifier so containment stays one rule
    return { sel: { kind: "connector", objectId: null, toolName: null, mode: value, pattern: { dimension, value } } };
  }
  if (!input.objectId) {
    return refuse(422, {
      error: "object_or_pattern_required",
      field: side,
      detail: "a side names a concrete object id or a pattern",
    });
  }
  if (input.kind === "mcp_tool" && !input.toolName) {
    return refuse(422, { error: "tool_name_required", field: side, detail: "an mcp_tool side names its tool" });
  }
  if (input.kind !== "mcp_tool" && input.toolName) {
    return refuse(422, { error: "tool_name_not_allowed", field: side, detail: "only an mcp_tool side carries a tool name" });
  }
  if (input.kind !== "connector" && input.mode) {
    return refuse(422, { error: "mode_not_allowed", field: side, detail: "only a connector side carries a mode qualifier" });
  }
  const exists =
    input.kind === "agent"
      ? (await db.select({ id: agents.id }).from(agents).where(eq(agents.id, input.objectId))).length > 0
      : input.kind === "connector"
        ? (await db.select({ id: connectors.id }).from(connectors).where(eq(connectors.id, input.objectId))).length > 0
        : (await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, input.objectId))).length > 0;
  if (!exists) return refuse(400, { error: "invalid_reference", field: `${side}.objectId` });
  return {
    sel: {
      kind: input.kind,
      objectId: input.objectId,
      toolName: input.toolName ?? null,
      mode: input.mode ?? null,
      pattern: null,
    },
  };
}

function selectorView(sel: SodSelector) {
  return { kind: sel.kind, objectId: sel.objectId, toolName: sel.toolName, mode: sel.mode, pattern: sel.pattern };
}

const sameSelector = (x: SodSelector, y: SodSelector): boolean =>
  x.kind === y.kind &&
  x.objectId === y.objectId &&
  x.toolName === y.toolName &&
  x.mode === y.mode &&
  x.pattern?.dimension === y.pattern?.dimension &&
  x.pattern?.value === y.pattern?.value;

async function ruleView(db: Db, rule: SodRuleRow, sides: SodSelector[], violators: SodViolator[]) {
  const labeled = await Promise.all(
    sides.map(async (s) => ({ ...selectorView(s), label: await describeSelector(db, s) })),
  );
  return {
    id: rule.id,
    name: rule.name,
    reason: rule.reason,
    enabled: rule.enabled,
    /** every side, in order (2 for a pre-amendment rule) — the ONE render
     * path; a/b below are the legacy aliases for the first two sides */
    sides: labeled,
    a: labeled[0] ?? null,
    b: labeled[1] ?? null,
    createdByUserId: rule.createdByUserId,
    createdAt: rule.createdAt.toISOString(),
    currentViolators: violators,
  };
}

export function registerSodRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/sod/rules", async (req, reply) => {
    const body = createRuleSchema.parse(req.body);
    // one input shape after normalization: the original a+b pair, or the B2c
    // sides array (2..N). Never both, never neither.
    if (body.sides && (body.a || body.b)) {
      return reply.status(422).send({
        error: "sides_or_pair",
        detail: "name the rule's sides either as a+b or as the sides array, not both",
      });
    }
    if (!body.sides && (!body.a || !body.b)) {
      return reply.status(422).send({
        error: "sides_or_pair",
        detail: "a rule names its sides as a+b or as a sides array of 2..8",
      });
    }
    const inputs: Array<{ label: string; input: SelectorInput }> = body.sides
      ? body.sides.map((input, i) => ({ label: `sides[${i}]`, input }))
      : [
          { label: "a", input: body.a! },
          { label: "b", input: body.b! },
        ];
    const sides: SodSelector[] = [];
    for (const { label, input } of inputs) {
      const resolved = await resolveSelector(db, label, input);
      if ("refusal" in resolved) return reply.status(resolved.refusal.status).send(resolved.refusal.body);
      sides.push(resolved.sel);
    }
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        if (sameSelector(sides[i]!, sides[j]!)) {
          return reply.status(422).send({
            error: "sod_rule_sides_identical",
            detail: "a capability cannot be declared toxic with itself — every side must differ",
          });
        }
      }
    }
    const duplicate = await db.select({ id: sodRules.id }).from(sodRules).where(eq(sodRules.name, body.name));
    if (duplicate.length > 0) return reply.status(409).send({ error: "duplicate_rule_name" });
    // storage: the original shape (exactly two concrete sides given as a+b)
    // keeps the legacy columns byte-identically; anything wider — N-way
    // and/or pattern — stores every side in sod_rule_sides. One loader
    // (loadRuleSelectors) reads both, so nothing downstream can tell.
    const legacyShaped = !body.sides && sides.length === 2 && sides.every((s) => s.pattern === null);
    const rule = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sodRules)
        .values({
          name: body.name,
          reason: body.reason,
          ...(legacyShaped
            ? {
                aKind: sides[0]!.kind,
                aObjectId: sides[0]!.objectId,
                aToolName: sides[0]!.toolName,
                aMode: sides[0]!.mode,
                bKind: sides[1]!.kind,
                bObjectId: sides[1]!.objectId,
                bToolName: sides[1]!.toolName,
                bMode: sides[1]!.mode,
              }
            : {}),
          enabled: body.enabled ?? true,
          createdByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      if (!legacyShaped) {
        await tx.insert(sodRuleSides).values(
          sides.map((s, i) => ({
            ruleId: row!.id,
            position: i + 1,
            selector: (s.pattern ? "pattern" : "concrete") as "pattern" | "concrete",
            kind: s.kind,
            objectId: s.pattern ? null : s.objectId,
            toolName: s.pattern ? null : s.toolName,
            mode: s.pattern ? null : s.mode,
            patternDimension: s.pattern?.dimension ?? null,
            patternValue: s.pattern?.value ?? null,
          })),
        );
      }
      return row!;
    });
    // creation NEVER strips existing holders — it REPORTS them, right here
    // in the creation response, so the admin who declared the toxicity sees
    // the existing exposure the moment they create the rule
    const violators = rule.enabled ? ((await computeRuleViolators(db, [rule])).get(rule.id) ?? []) : [];
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? rule.id,
      objectType: "sod_rule",
      objectId: rule.id,
      detail: {
        name: rule.name,
        reason: rule.reason,
        sides: sides.map((s) => selectorView(s)),
        a: selectorView(sides[0]!),
        b: selectorView(sides[1]!),
        enabled: rule.enabled,
        currentViolators: violators.length,
      },
      effect: "allow",
      ruleId: "sod-rule-created",
      ruleChain: [],
      reason:
        `SoD rule '${rule.name}' created: ${rule.reason} — enforced at mint time from now on; ` +
        `${violators.length} existing violator(s) surfaced, none auto-revoked`,
    });
    return reply.status(201).send({
      ...(await ruleView(db, rule, sides, violators)),
      notes: SOD_NOTES,
    });
  });

  app.get("/v1/sod/rules", async () => {
    const rules = await db.select().from(sodRules).orderBy(sodRules.createdAt);
    const violators = await computeRuleViolators(
      db,
      rules.filter((r) => r.enabled),
    );
    const selectorsByRule = await loadRuleSelectors(db, rules);
    return {
      notes: SOD_NOTES,
      rules: await Promise.all(
        rules.map((r) => ruleView(db, r, selectorsByRule.get(r.id) ?? [], violators.get(r.id) ?? [])),
      ),
    };
  });

  app.patch("/v1/sod/rules/:ruleId", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const [current] = await db.select({ enabled: sodRules.enabled }).from(sodRules).where(eq(sodRules.id, ruleId));
    if (!current) return reply.status(404).send({ error: "not_found" });
    // ADR-0186 A (Class C): disabling a SoD rule lifts a restriction — a settings_relax step-up
    if (current.enabled && !body.enabled) {
      if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { sodRuleId: ruleId, values: { enabled: false } } })).ok) return reply;
    }
    const [rule] = await db
      .update(sodRules)
      .set({ enabled: body.enabled })
      // Class A: compare-and-set on the state the step-up was decided on
      .where(and(eq(sodRules.id, ruleId), eq(sodRules.enabled, current.enabled)))
      .returning();
    if (!rule) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? rule.id,
      objectType: "sod_rule",
      objectId: rule.id,
      detail: { name: rule.name, enabled: rule.enabled },
      effect: "allow",
      ruleId: rule.enabled ? "sod-rule-enabled" : "sod-rule-disabled",
      ruleChain: [],
      reason: rule.enabled
        ? `SoD rule '${rule.name}' enabled — mint-time enforcement resumes; existing violators are surfaced, never auto-revoked`
        : `SoD rule '${rule.name}' disabled — the combination is no longer refused at mint time`,
    });
    const violators = rule.enabled ? ((await computeRuleViolators(db, [rule])).get(rule.id) ?? []) : [];
    const sides = (await loadRuleSelectors(db, [rule])).get(rule.id) ?? [];
    return await ruleView(db, rule, sides, violators);
  });

  app.delete("/v1/sod/rules/:ruleId", async (req, reply) => {
    const { ruleId } = ruleIdParam.parse(req.params);
    // ADR-0186 A (Class C): removing a SoD rule lifts its restriction — a settings_relax step-up
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { sodRuleId: ruleId, values: { deleted: true } } })).ok) return reply;
    const [rule] = await db.delete(sodRules).where(eq(sodRules.id, ruleId)).returning();
    if (!rule) return reply.status(404).send({ error: "not_found" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? rule.id,
      objectType: "sod_rule",
      objectId: rule.id,
      detail: { name: rule.name, reason: rule.reason },
      effect: "allow",
      ruleId: "sod-rule-deleted",
      ruleChain: [],
      reason: `SoD rule '${rule.name}' deleted — the combination is no longer declared toxic (pending escalations about it are moot)`,
    });
    return { removed: true };
  });

  /**
   * ESCALATE a refused mint into the one approvals queue. The conflict is
   * re-computed SERVER-SIDE from the mint payload — the client never asserts
   * which rule it is overriding — and a mint that no enabled rule refuses is
   * turned away by name (there is nothing to override; use the ordinary
   * endpoint).
   */
  app.post("/v1/sod/overrides", async (req, reply) => {
    const body = escalateSchema.parse(req.body);
    const requesterUserId = req.authCtx.userId;
    if (!requesterUserId) return reply.status(403).send({ error: "bootstrap_cannot_escalate" });
    let mint: SodMint;
    try {
      mint = mintFromPayload(body.mintKind, body.payload);
    } catch {
      return reply.status(422).send({
        error: "invalid_mint_payload",
        detail: `the payload does not match the '${body.mintKind}' mint shape`,
      });
    }
    if (body.approverUserId === requesterUserId) {
      return reply.status(422).send({
        error: "approver_is_requester",
        detail: "an SoD override needs an arm's-length approver — the requester cannot name themselves",
      });
    }
    const [approver] = await db
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.approverUserId));
    if (!approver || approver.disabledAt) {
      return reply.status(400).send({ error: "invalid_reference", field: "approverUserId" });
    }
    const conflict = await checkSodMint(db, mint);
    if (!conflict) {
      return reply.status(422).send({
        error: "no_sod_conflict",
        detail: "no enabled SoD rule refuses this mint — there is nothing to override; use the ordinary grant endpoint",
      });
    }
    const refusal = await buildRefusalBody(db, conflict);
    const label = `SoD override · ${refusal.conflict.userLabel} · despite rule '${conflict.rule.name}'`;
    const request = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(sodOverrideRequests)
        .values({
          ruleId: conflict.rule.id,
          mintKind: body.mintKind,
          mintPayload: body.payload,
          conflictDetail: refusal.conflict,
          label,
          requestedByUserId: requesterUserId,
        })
        .returning();
      const [approval] = await tx
        .insert(approvals)
        .values({
          userId: requesterUserId,
          objectType: "sod_override",
          approverUserId: body.approverUserId,
          stageId: `${SOD_OVERRIDE_PREFIX}${row!.id}`,
        })
        .returning({ id: approvals.id });
      const [updated] = await tx
        .update(sodOverrideRequests)
        .set({ approvalId: approval!.id })
        .where(eq(sodOverrideRequests.id, row!.id))
        .returning();
      await tx.insert(auditLog).values({
        userId: requesterUserId,
        objectType: "sod_rule",
        objectId: conflict.rule.id,
        detail: {
          overrideRequestId: row!.id,
          approvalId: approval!.id,
          mintKind: body.mintKind,
          mint: body.payload,
          conflict: refusal.conflict,
          approverUserId: body.approverUserId,
          ...(body.justification ? { justification: body.justification } : {}),
        },
        effect: "require_approval",
        ruleId: "sod-override-requested",
        ruleChain: [],
        reason: `${label} — escalated to the approvals queue; nothing is minted unless an arm's-length approver approves`,
      });
      return updated!;
    });
    return reply.status(201).send({
      id: request.id,
      ruleId: request.ruleId,
      ruleName: conflict.rule.name,
      mintKind: request.mintKind,
      label: request.label,
      approvalId: request.approvalId,
      status: request.status,
      notes: SOD_NOTES,
    });
  });

  app.get("/v1/sod/overrides", async () => {
    const requests = await db.select().from(sodOverrideRequests).orderBy(sodOverrideRequests.createdAt);
    const ruleIds = [...new Set(requests.map((r) => r.ruleId))];
    const ruleRows = ruleIds.length
      ? await db.select({ id: sodRules.id, name: sodRules.name }).from(sodRules).where(inArray(sodRules.id, ruleIds))
      : [];
    const ruleName = new Map(ruleRows.map((r) => [r.id, r.name]));
    const userIds = [
      ...new Set([
        ...requests.map((r) => r.requestedByUserId),
        ...requests.map((r) => r.decidedByUserId).filter((u): u is string => u !== null),
      ]),
    ];
    const userRows = userIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const nameOf = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
    return {
      notes: SOD_NOTES,
      overrides: requests.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleName: ruleName.get(r.ruleId) ?? null,
        mintKind: r.mintKind,
        label: r.label,
        conflict: r.conflictDetail,
        requestedBy: { userId: r.requestedByUserId, name: nameOf.get(r.requestedByUserId) ?? null },
        approvalId: r.approvalId,
        status: r.status,
        decidedBy: r.decidedByUserId
          ? { userId: r.decidedByUserId, name: nameOf.get(r.decidedByUserId) ?? null }
          : null,
        decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        minted: r.mintDetail ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
