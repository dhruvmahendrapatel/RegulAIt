/**
 * ADR-0056 — THE AI GOVERNANCE COPILOT, the gateway half.
 *
 *   `packages/shared/src/copilot.ts`   the tool vocabulary, the NL -> structured
 *                                      query step, the grounded renderer, the
 *                                      narrator INTERFACE. Pure.
 *   THIS FILE                          the ENTITLEMENT-SCOPED retrieval, the
 *                                      governed dispatch, the guardrail pass
 *                                      over untrusted ledger text, the
 *                                      proposal -> Approvals-Queue writer, the
 *                                      audit rows.
 *
 * THE FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ------------------------------------------------
 *  1. THE COPILOT CANNOT READ WHAT ITS INVOKING USER CANNOT. Not by prompting —
 *     at the QUERY BOUNDARY. `resolveCopilotScope` turns the caller into a
 *     concrete project-id list using ADR-0047's own `callerProjectIds`, and
 *     every SELECT below is built with that list in its WHERE clause at
 *     construction time. A post-hoc filter over an aggregate cannot un-aggregate
 *     it, so anything computed org-wide and filtered afterwards has already
 *     leaked. There is no "copilot super-reader" grant and no code path that
 *     could produce one: an identity-less caller (the bootstrap token) is
 *     refused outright, because there would be no entitlement set to inherit.
 *
 *  2. IT IS A TENANT, NOT A SYSTEM COMPONENT. The narration call goes through
 *     `executeGovernedDispatch` — the same function an ordinary user invoke
 *     takes — AFTER the same `evaluateAgent` entitlement check. A user who may
 *     not invoke the narrator agent may not narrate with it either, and the
 *     refusal is the ordinary AgentDecision shape. Its tokens land in
 *     `usage_events` and bill a project; its call is audited. If our own
 *     flagship agent needed an exemption, the kernel would not be fit to sell.
 *
 *  3. IT HAS NO MUTATING TOOLS. Four read tools, enumerated in
 *     `COPILOT_TOOL_SPECS`, all `SELECT`. A proposal is a row in
 *     `copilot_proposals` plus an ordinary `approvals` row; nothing in this
 *     module writes a grant, a role, a rule, a policy or an entitlement. The
 *     approval is decided through the EXISTING decide path, so the change (if
 *     any) is attributed to the approving human.
 *
 *  4. THE AUDIT LOG IS AN INJECTION SURFACE, AND IS TREATED AS ONE. Retrieved
 *     `reason` strings are attacker-influenceable text. They pass through
 *     ADR-0042's guardrails as PHASE INPUT before they reach any model or any
 *     answer, and a `block` withholds the samples rather than forwarding them.
 *     The grounded answer is composed from COUNTS, so a blocked sample costs
 *     the answer nothing but the sample.
 *
 *  5. `modelNarrationVerified` MEANS ONE NARROW THING, AND SAYS SO. It is TRUE
 *     when THIS narration's cited count keys and cited governance-object ids
 *     were all cross-checked against THIS retrieval and passed
 *     (`narrationIsGrounded`). It is NOT a claim that the model is generally
 *     reliable, and — the L6d lesson — NOT a claim that the answer is ABOUT
 *     what the question asked: real figures over an unfiltered query can still
 *     be narrated as belonging to a subject nobody ever filtered on. That
 *     separate fact rides its own field, `subjectFiltered`, and its own
 *     deterministic caveat in the grounded text.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  approvals,
  auditLog,
  compliancePacks,
  connectorGrants,
  connectors,
  copilotProposals,
  copilotQueries,
  count,
  desc,
  eq,
  gte,
  inArray,
  initiatives,
  lt,
  mcpServers,
  mcpTools,
  or,
  projectMembers,
  projects,
  roles,
  sql,
  teamMembers,
  teams,
  usageEvents,
  userAgentPolicies,
  users,
  virtualKeys,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import {
  COPILOT_APPLICABLE_PROPOSAL_KINDS,
  COPILOT_DECISION_SUPPORT_NOTICE,
  COPILOT_ENTITY_KIND_LABELS,
  COPILOT_SCOPE_CAVEAT,
  COPILOT_TOOL_SPECS,
  COPILOT_UNAPPLICABLE_PROPOSAL_KINDS,
  buildNarrationPrompt,
  buildProposalRecord,
  copilotAskSchema,
  copilotEntityAmbiguousRefusal,
  copilotEntityNotFilterableRefusal,
  copilotEntityUnresolvedRefusal,
  copilotGrantRevocationDiffSchema,
  copilotPolicyTighteningDiffSchema,
  copilotProposalKindIsApplicable,
  copilotProposalSchema,
  copilotToolSupportsEntityKind,
  copilotToolsFilteringEntityKind,
  describeCopilotFilters,
  narrationIsGrounded,
  parseNarration,
  planCopilotQuery,
  renderGroundedAnswer,
  type CopilotEntityKind,
  type CopilotEntityMatch,
  type CopilotEntityRef,
  type CopilotEvidence,
  type CopilotNarration,
  type CopilotNarrationRequest,
  type CopilotNarrator,
  type CopilotProposalKind,
  type CopilotQueryPlan,
  type CopilotTimeframe,
  type CopilotTool,
} from "@regulait/shared";
import {
  evaluateAgent,
  evaluateConnector,
  visibleTools,
  type AgentDecision,
  type ToolRef,
} from "@regulait/policy-kernel";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import {
  loadAgentRevocations,
  loadConnectorRevocations,
  loadEntitlements,
  loadRoleAgentGrants,
  loadRoleConnectorGrants,
} from "./entitlements.js";
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
import { resolveGuardrailPolicy, runGuardrails } from "./guardrails.js";
import { callerProjectIds } from "./reporting.js";
import { applyRuleEdit, isRuleEditRefusal } from "./rule-writes.js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** L6b — the rule kind a proposal names, mapped to the `config_versions`
 * ARTIFACT TYPE `applyRuleEdit` speaks. Same map the admin deploy-mode route
 * uses; a rule kind outside it cannot be named, because the diff schema's enum
 * and this map are the same three strings. */
const APPLY_RULE_ARTIFACT_TYPES = {
  approvals: "approval_rule",
  "rate-limits": "rate_limit",
  "data-scopes": "data_scope_rule",
} as const;

/** stable rule ids — the strings an operator greps the audit log for */
export const COPILOT_RULE_IDS = {
  asked: "copilot-question-answered",
  refusedNoIdentity: "copilot-refused-no-identity",
  narratorNotEntitled: "copilot-narrator-not-entitled",
  narrationFailed: "copilot-narration-unusable",
  guardrailActed: "copilot-guardrail-acted",
  proposalOpened: "copilot-proposal-opened",
  proposalRefused: "copilot-proposal-refused",
  /** L6b — the consent-gated applier */
  proposalApplied: "copilot-proposal-applied",
  proposalApplyRefused: "copilot-proposal-apply-refused",
  /** ADR-0096 — entity-aware planning's three refusals, each its own row so an
   * operator can tell "you named something I cannot see" from "your query
   * matched nothing" from "this tool has no such filter" by grepping alone */
  entityUnresolved: "copilot-refused-unresolved-entity",
  entityAmbiguous: "copilot-refused-ambiguous-entity",
  entityNotFilterable: "copilot-refused-entity-not-filterable",
} as const;

// ---------------------------------------------------------------------------
// Scope — the whole security model, resolved once, per request
// ---------------------------------------------------------------------------

export interface CopilotScope {
  /** the EXACT ids every retrieval may touch. `null` = org-wide, and is only
   * ever produced for an admin. */
  projectIds: string[] | null;
  /** the users who are members of those projects, for ledgers with no project
   * column of their own. Null exactly when projectIds is null. */
  memberIds: string[] | null;
  statement: string;
}

export async function resolveCopilotScope(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
): Promise<CopilotScope> {
  if (actor.isAdmin) {
    return {
      projectIds: null,
      memberIds: null,
      statement: "admin caller: organization-wide read, including records attributed to no project",
    };
  }
  const ids = await callerProjectIds(db, actor.userId);
  const memberIds = ids.length
    ? (
        await db
          .selectDistinct({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, ids))
      ).map((r) => r.userId)
    : [];
  return {
    projectIds: ids,
    memberIds,
    statement: `non-admin caller: narrowed to the ${ids.length} project(s) they are a member of`,
  };
}

/** the scoped id list, or the impossible uuid so an empty allow-list selects
 * NOTHING rather than everything — fail CLOSED */
const safeIds = (ids: string[]) => (ids.length ? ids : [ZERO_UUID]);

function assertUuid(v: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    throw new Error("non-uuid project id in copilot scope");
  }
  return v;
}

/** `audit_log` carries no project column; attribution rides `detail.projectId`,
 * the key every governed path writes. Built by interpolation, so every id is
 * re-validated as a uuid — a non-uuid here would be an injection primitive. */
function auditScopePredicate(projectIds: string[]) {
  const ids = safeIds(projectIds).map((p) => `'${assertUuid(p)}'`).join(",");
  return sql`${auditLog.detail} ->> 'projectId' = ANY(${sql.raw(`ARRAY[${ids}]::text[]`)})`;
}

// ---------------------------------------------------------------------------
// ADR-0096 — ENTITY RESOLUTION: the database decides, never the extractor
// ---------------------------------------------------------------------------

/**
 * WHAT "IN YOUR SCOPE" MEANS PER KIND, and why each rule is a RE-USE.
 *
 * Entity resolution is a new read surface, and a new read surface is a new
 * place for existence to leak. So no kind here gets a visibility rule invented
 * for this feature; each one re-uses a predicate the product already enforces
 * somewhere an auditor could check:
 *
 *   project    `scope.projectIds` — the very list every copilot retrieval is
 *              already narrowed to (ADR-0047 `callerProjectIds`).
 *   user       `scope.memberIds` — the members of those projects, the same list
 *              the approvals retrieval already scopes on.
 *   team       the teams the caller is a member of (`team_members`), the
 *              tightest reading of "your team" and the one the SPA uses.
 *   agent      the KERNEL's own answer: `evaluateAgent(...).effect === "allow"`,
 *              the exact call an ordinary invoke makes. Not a hand-rolled join
 *              over grant tables, which could drift from the enforcing path.
 *   connector  the kernel's `evaluateConnector` at mode `read`, same reasoning.
 *   mcp_server the kernel's `visibleTools(...)` over the server's inventory
 *              (B6c). "Visible" means the caller can see AT LEAST ONE tool on
 *              it — the exact rule `decompose.ts`'s `callerToolServers` already
 *              applies when building a planning roster, which is itself the
 *              rule the MCP proxy enforces on every call.
 *   mcp_tool   the SAME `visibleTools(...)` call, asked about one tool: the
 *              tool must survive the filter for its own server (B6c).
 *   vendor     `ai_vendors.owner_user_id = caller` — byte-identical to the
 *              existing `GET /v1/vendors` rule for a non-admin.
 *
 * B7a — the seven registry kinds, same discipline (re-used, never invented):
 *
 *   initiative        ADMIN-ONLY. `GET /v1/initiatives` is not in
 *   compliance_pack   `NON_ADMIN_ROUTES`, so the gateway's default admin gate
 *   workflow_template refuses every non-admin read of it — likewise
 *   role              `GET /v1/compliance/packs`, `GET /v1/workflows/templates`
 *                     and `GET /v1/roles`. The resolver mirrors that reality
 *                     exactly: for a non-admin these four kinds are NEVER
 *                     LOOKED UP, so a real one refuses byte-identically to a
 *                     nonexistent one. (A non-admin CAN evaluate a pack by id
 *                     via POST /v1/compliance/packs/:id/evaluate, but the READ
 *                     surface this resolver is a read against is the list, and
 *                     the list is admin-only.)
 *   ai_use_case       `owner_user_id = caller` — the exact non-admin predicate
 *   ai_risk           `GET /v1/use-cases` and `GET /v1/risks` apply ("fleet
 *                     for admins, own rows for everyone else").
 *   virtual_key       `user_id = caller` — the exact non-admin predicate
 *                     `GET /v1/virtual-keys` applies (ADR-0022 visibility: a
 *                     non-admin sees their OWN keys and no one else's).
 *
 * An admin is org-wide for all fifteen, exactly as `resolveCopilotScope`
 * already makes them org-wide for every ledger.
 *
 * B6c — THE TWO BLOCKERS ADR-0096 NAMED, AND HOW EACH IS SOLVED.
 *
 *  1. "MCP visibility is a per-(user, server) TOOL-LEVEL computation
 *     (`loadEntitlements` + `visibleTools`)." Solved by CALLING that pair,
 *     unchanged, in exactly the shape the MCP proxy calls it — one
 *     `loadEntitlements(db, userId, serverId)` and one `visibleTools(userId,
 *     serverId, refs, entitlements)` per candidate server. No new predicate was
 *     written and none was approximated: the copilot resolves an MCP tool if
 *     and only if the proxy would let that same user list it.
 *  2. "`mcp_tools.name` is unique only per server, so a bare tool name cannot
 *     be resolved without a server qualifier the extractor cannot reliably
 *     supply." Solved by NOT resolving it. A bare name matching tools on two
 *     servers produces two matches, which is already this feature's AMBIGUOUS
 *     outcome: the refusal lists both, each qualified by its server, and never
 *     tie-breaks. A caller who means one writes `server/tool`, which resolves
 *     uniquely because `mcp_servers.name` IS globally unique. Ambiguity here is
 *     not a gap in the design; it is the design.
 *
 * AND THE RULE THAT MATTERS MOST: a candidate the caller may not see comes back
 * as NOT FOUND. Not "found but hidden", not a different error — the same empty
 * result a nonexistent name produces, so the refusal wording is byte-identical
 * either way and the copilot cannot be used as an existence oracle.
 */
export type CopilotEntityResolution =
  | { status: "none" }
  | { status: "resolved"; entity: CopilotEntityRef }
  | { status: "ambiguous"; matches: CopilotEntityMatch[] }
  | { status: "unresolved"; candidates: string[] };

const isUuid = (v: string) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v);

/** case-insensitive exact match on a name column. `lower(col) = lower($1)` —
 * never a LIKE: a prefix match would silently resolve "Payments" to "Payments
 * Platform", which is the guessing this feature refuses to do. */
const nameEq = (col: unknown, candidate: string) =>
  sql`lower(${col}) = lower(${candidate})`;

/**
 * Resolve ONE candidate string against the governed object graph, entitlement
 * -scoped. Returns every match across every kind — the caller decides what to
 * do with zero, one, or many.
 */
async function lookupEntityCandidate(
  db: Db,
  candidate: string,
  scope: CopilotScope,
  actor: { userId: string; isAdmin: boolean },
): Promise<CopilotEntityMatch[]> {
  const byId = isUuid(candidate);
  const out: CopilotEntityMatch[] = [];

  // --- project: the caller's own project list, already resolved -------------
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      and(
        byId ? eq(projects.id, candidate) : nameEq(projects.name, candidate),
        ...(scope.projectIds === null ? [] : [inArray(projects.id, safeIds(scope.projectIds))]),
      ),
    )
    .limit(5);
  for (const r of projectRows) out.push({ kind: "project", id: r.id, name: r.name });

  // --- team: the teams this caller belongs to -------------------------------
  const teamRows = actor.isAdmin
    ? await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(byId ? eq(teams.id, candidate) : nameEq(teams.name, candidate))
        .limit(5)
    : await db
        .selectDistinct({ id: teams.id, name: teams.name })
        .from(teams)
        .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
        .where(
          and(
            byId ? eq(teams.id, candidate) : nameEq(teams.name, candidate),
            eq(teamMembers.userId, actor.userId),
          ),
        )
        .limit(5);
  for (const r of teamRows) out.push({ kind: "team", id: r.id, name: r.name });

  // --- user: email, username or display name, within the shared-project set -
  const userRows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(
      and(
        byId
          ? eq(users.id, candidate)
          : or(
              nameEq(users.email, candidate),
              nameEq(users.username, candidate),
              nameEq(users.displayName, candidate),
            ),
        ...(scope.memberIds === null ? [] : [inArray(users.id, safeIds(scope.memberIds))]),
      ),
    )
    .limit(5);
  for (const r of userRows) out.push({ kind: "user", id: r.id, name: r.displayName || r.email });

  // --- agent: the KERNEL's own allow, one call per candidate row ------------
  const agentRows = await db
    .select()
    .from(agents)
    .where(byId ? eq(agents.id, candidate) : nameEq(agents.name, candidate))
    .limit(5);
  for (const a of agentRows) {
    if (!actor.isAdmin) {
      const decision = await agentDecision(db, actor.userId, a as AgentRow);
      if (decision.effect !== "allow") continue;
    }
    out.push({ kind: "agent", id: a.id, name: a.name });
  }

  // --- connector: the kernel's own allow at mode `read` ---------------------
  const connectorRows = await db
    .select({ id: connectors.id, name: connectors.name })
    .from(connectors)
    .where(byId ? eq(connectors.id, candidate) : nameEq(connectors.name, candidate))
    .limit(5);
  if (connectorRows.length) {
    const [grants, roleGrants, revocations] = actor.isAdmin
      ? [[], [], []]
      : await Promise.all([
          db.select().from(connectorGrants).where(eq(connectorGrants.userId, actor.userId)),
          loadRoleConnectorGrants(db, actor.userId),
          loadConnectorRevocations(db, actor.userId),
        ]);
    for (const c of connectorRows) {
      if (!actor.isAdmin) {
        const decision = evaluateConnector({
          userId: actor.userId,
          connectorId: c.id,
          connectorName: c.name,
          operation: "read",
          connectorGrants: grants,
          roleConnectorGrants: roleGrants,
          connectorRevocations: revocations,
        });
        if (decision.effect !== "allow") continue;
      }
      out.push({ kind: "connector", id: c.id, name: c.name });
    }
  }

  // --- MCP server / MCP tool (B6c): the kernel's own per-(user, server)
  //     TOOL-LEVEL predicate, called exactly as the MCP proxy calls it -------
  {
    // A `server/tool` qualifier is the only way a NON-GLOBALLY-UNIQUE tool name
    // can be asked about unambiguously. `mcp_servers.name` IS globally unique,
    // so the qualified form is exact; the bare form deliberately stays capable
    // of matching several tools, which is the ambiguity outcome, not a bug.
    const slash = candidate.indexOf("/");
    const qualifierName = slash > 0 ? candidate.slice(0, slash).trim() : null;
    const qualifiedToolName = slash > 0 ? candidate.slice(slash + 1).trim() : null;

    const serverRows = await db
      .select({ id: mcpServers.id, name: mcpServers.name })
      .from(mcpServers)
      .where(byId ? eq(mcpServers.id, candidate) : nameEq(mcpServers.name, candidate))
      .limit(5);

    const toolNameToMatch = qualifiedToolName || candidate;
    const toolRows = byId
      ? await db
          .select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name })
          .from(mcpTools)
          .where(eq(mcpTools.id, candidate))
          .limit(10)
      : toolNameToMatch.length >= 2
        ? await db
            .select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name })
            .from(mcpTools)
            .where(nameEq(mcpTools.name, toolNameToMatch))
            .limit(10)
        : [];

    if (serverRows.length || toolRows.length) {
      const needed = [...new Set([...serverRows.map((r) => r.id), ...toolRows.map((t) => t.serverId)])];
      const nameRows = await db
        .select({ id: mcpServers.id, name: mcpServers.name })
        .from(mcpServers)
        .where(inArray(mcpServers.id, safeIds(needed)));
      const serverName = new Map(nameRows.map((r) => [r.id, r.name]));

      // THE RE-USED PREDICATE, memoised per server for this candidate only.
      // `loadEntitlements` + `visibleTools` is the pair `mcp-proxy.ts` runs on
      // tools/list and on every call, and `decompose.ts` runs to build a
      // planning roster. Nothing here re-derives it.
      const visibleCache = new Map<string, Set<string>>();
      const visibleOn = async (serverId: string): Promise<Set<string>> => {
        const hit = visibleCache.get(serverId);
        if (hit) return hit;
        const [tools, entitlements] = await Promise.all([
          db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
          loadEntitlements(db, actor.userId, serverId),
        ]);
        const refs: ToolRef[] = tools.map((t) => ({
          serverId: t.serverId,
          name: t.name,
          kind: t.kind,
        }));
        const set = new Set(
          visibleTools(actor.userId, serverId, refs, entitlements).map((t) => t.name),
        );
        visibleCache.set(serverId, set);
        return set;
      };

      for (const srv of serverRows) {
        // a server is "in your scope" when you can see at least one tool on it
        // — `callerToolServers`' own rule, which drops a server whose tools are
        // all denied because the caller could not use it for anything
        if (!actor.isAdmin && (await visibleOn(srv.id)).size === 0) continue;
        out.push({ kind: "mcp_server", id: srv.id, name: srv.name });
      }

      for (const t of toolRows) {
        const owner = serverName.get(t.serverId);
        if (!owner) continue;
        // a qualified candidate binds to ONE server; an unqualified one is
        // allowed to match several, and that is the ambiguity outcome
        if (qualifierName && owner.toLowerCase() !== qualifierName.toLowerCase()) continue;
        if (!actor.isAdmin && !(await visibleOn(t.serverId)).has(t.name)) continue;
        // the NAME is rendered server-qualified, so the ambiguity refusal lists
        // candidates a caller can actually tell apart and re-ask with
        out.push({ kind: "mcp_tool", id: t.id, name: `${owner}/${t.name}` });
      }
    }
  }

  // --- B7a: the four ADMIN-ONLY registries. Their list endpoints sit behind
  //     the gateway's default admin gate (absent from NON_ADMIN_ROUTES), so
  //     for a non-admin they are NOT QUERIED AT ALL — a real initiative and a
  //     nonexistent one are the same absence, which is the scope-honesty rule
  //     with nothing left to get wrong -------------------------------------
  if (actor.isAdmin) {
    const initiativeRows = await db
      .select({ id: initiatives.id, name: initiatives.name })
      .from(initiatives)
      .where(byId ? eq(initiatives.id, candidate) : nameEq(initiatives.name, candidate))
      .limit(5);
    for (const r of initiativeRows) out.push({ kind: "initiative", id: r.id, name: r.name });

    // matched on TITLE (the display name an operator knows a pack by), never
    // on the bare framework slug: (framework, version) is the unique pair, so
    // two versions sharing a title are the ordinary ambiguity outcome
    const packRows = await db
      .select({ id: compliancePacks.id, title: compliancePacks.title })
      .from(compliancePacks)
      .where(byId ? eq(compliancePacks.id, candidate) : nameEq(compliancePacks.title, candidate))
      .limit(5);
    for (const r of packRows) out.push({ kind: "compliance_pack", id: r.id, name: r.title });

    const templateRows = await db
      .select({ id: workflowTemplates.id, name: workflowTemplates.name })
      .from(workflowTemplates)
      .where(byId ? eq(workflowTemplates.id, candidate) : nameEq(workflowTemplates.name, candidate))
      .limit(5);
    for (const r of templateRows) out.push({ kind: "workflow_template", id: r.id, name: r.name });

    const roleRows = await db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(byId ? eq(roles.id, candidate) : nameEq(roles.name, candidate))
      .limit(5);
    for (const r of roleRows) out.push({ kind: "role", id: r.id, name: r.name });
  }

  // --- B7a: AI use case / AI risk — the exact owner-or-admin predicate their
  //     own list endpoints apply ("fleet for admins, own rows for everyone
  //     else"). A retired/closed row still resolves, because the list still
  //     returns it ---------------------------------------------------------
  const useCaseRows = await db
    .select({ id: aiUseCases.id, name: aiUseCases.name })
    .from(aiUseCases)
    .where(
      and(
        byId ? eq(aiUseCases.id, candidate) : nameEq(aiUseCases.name, candidate),
        ...(actor.isAdmin ? [] : [eq(aiUseCases.ownerUserId, actor.userId)]),
      ),
    )
    .limit(5);
  for (const r of useCaseRows) out.push({ kind: "ai_use_case", id: r.id, name: r.name });

  const riskRows = await db
    .select({ id: aiRisks.id, title: aiRisks.title })
    .from(aiRisks)
    .where(
      and(
        byId ? eq(aiRisks.id, candidate) : nameEq(aiRisks.title, candidate),
        ...(actor.isAdmin ? [] : [eq(aiRisks.ownerUserId, actor.userId)]),
      ),
    )
    .limit(5);
  for (const r of riskRows) out.push({ kind: "ai_risk", id: r.id, name: r.title });

  // --- B7a: virtual key — ADR-0022's own visibility rule, byte-identical to
  //     GET /v1/virtual-keys: a non-admin sees their OWN keys only. `name` is
  //     not unique even per user, so two keys sharing one label are the
  //     ambiguity outcome, listed by id ------------------------------------
  const keyRows = await db
    .select({ id: virtualKeys.id, name: virtualKeys.name })
    .from(virtualKeys)
    .where(
      and(
        byId ? eq(virtualKeys.id, candidate) : nameEq(virtualKeys.name, candidate),
        ...(actor.isAdmin ? [] : [eq(virtualKeys.userId, actor.userId)]),
      ),
    )
    .limit(5);
  for (const r of keyRows) out.push({ kind: "virtual_key", id: r.id, name: r.name });

  // --- vendor: the SAME rule GET /v1/vendors already enforces ---------------
  const vendorRows = await db
    .select({ id: aiVendors.id, name: aiVendors.name })
    .from(aiVendors)
    .where(
      and(
        byId ? eq(aiVendors.id, candidate) : nameEq(aiVendors.name, candidate),
        ...(actor.isAdmin ? [] : [eq(aiVendors.ownerUserId, actor.userId)]),
      ),
    )
    .limit(5);
  for (const r of vendorRows) out.push({ kind: "vendor", id: r.id, name: r.name });

  return out;
}

/**
 * Resolve every candidate a question produced.
 *
 * MULTIPLE RESOLVED ENTITIES IS AMBIGUITY, not an opportunity to pick one. A
 * question naming two real objects cannot be answered by filtering on one of
 * them and quietly dropping the other — that is the same lie as filtering on
 * none and labelling the result with both.
 */
export async function resolveCopilotEntities(
  db: Db,
  candidates: readonly string[],
  scope: CopilotScope,
  actor: { userId: string; isAdmin: boolean },
): Promise<CopilotEntityResolution> {
  if (candidates.length === 0) return { status: "none" };

  const resolved: CopilotEntityRef[] = [];
  for (const candidate of candidates) {
    const matches = await lookupEntityCandidate(db, candidate, scope, actor);
    for (const m of matches) resolved.push({ ...m, matchedOn: candidate });
  }
  const distinct = resolved.filter(
    (r, i) => resolved.findIndex((o) => o.kind === r.kind && o.id === r.id) === i,
  );
  if (distinct.length === 0) return { status: "unresolved", candidates: [...candidates] };
  if (distinct.length > 1) return { status: "ambiguous", matches: distinct };
  return { status: "resolved", entity: distinct[0]! };
}

/** the ledger each read tool reads, for the mismatch refusal's own words */
const TOOL_LEDGER: Record<CopilotTool, string> = Object.fromEntries(
  COPILOT_TOOL_SPECS.map((s) => [s.id, s.ledger]),
) as Record<CopilotTool, string>;

/** the members of a team or a project — the expansion a `team`/`project` filter
 * uses on ledgers that carry a `user_id` and no object column of their own */
async function memberIdsOf(db: Db, kind: CopilotEntityKind, id: string): Promise<string[]> {
  if (kind === "team") {
    const rows = await db
      .selectDistinct({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, id));
    return rows.map((r) => r.userId);
  }
  const rows = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, id));
  return rows.map((r) => r.userId);
}

/** B6c — the (server_id, tool_name) pair an `mcp_tool` entity filters on.
 * `mcp_tools.id` is the resolved identity, but no ledger stores it: all three
 * store the SERVER ID and the TOOL NAME (`audit_log`/`approvals` as first-class
 * columns; `usage_events` as `operation` + `detail->>'serverId'`). So the pair
 * is looked up once per retrieval, exactly as `memberIdsOf` expands a team. */
async function mcpToolRefOf(
  db: Db,
  id: string,
): Promise<{ serverId: string; toolName: string } | null> {
  const [row] = await db
    .select({ serverId: mcpTools.serverId, name: mcpTools.name })
    .from(mcpTools)
    .where(eq(mcpTools.id, id));
  return row ? { serverId: row.serverId, toolName: row.name } : null;
}

/** B7a — an `initiative` entity's expansion: the projects grouped under it
 * (`projects.initiative_id`, the EXACT join GET /v1/initiatives runs to roll
 * up initiative spend) and the members of those projects (so the `approvals`
 * filter can apply the same project-OR-member rule a `project` filter does).
 * An initiative with no projects expands to nothing and the filters below
 * fail CLOSED via `safeIds` — zero rows, never all rows. */
async function initiativeExpansionOf(
  db: Db,
  id: string,
): Promise<{ projectIds: string[]; memberIds: string[] }> {
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.initiativeId, id));
  const projectIds = projectRows.map((r) => r.id);
  const memberRows = projectIds.length
    ? await db
        .selectDistinct({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(inArray(projectMembers.projectId, projectIds))
    : [];
  return { projectIds, memberIds: memberRows.map((r) => r.userId) };
}

/** B8a — an `ai_use_case` entity's approvals join: the use case's OWN intake
 * instance (`ai_use_cases.workflow_instance_id`, the pointer ADR-0080 writes
 * at proposal), so "approvals about this use case" means the sign-offs of the
 * instance that governs it — the single-hop, product-read join B7a recorded
 * as deferred. A use case that predates any instance has a NULL pointer and
 * the filter fails CLOSED below (zero rows, never a silent broad run). */
async function useCaseInstanceOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db
    .select({ workflowInstanceId: aiUseCases.workflowInstanceId })
    .from(aiUseCases)
    .where(eq(aiUseCases.id, id));
  return row?.workflowInstanceId ?? null;
}

/** B8a — a `workflow_template` entity's approvals join: the instances whose
 * `workflow_instances.template_ids` jsonb array CONTAINS the template (`@>`).
 * An instance may be COMPOSED from several templates and every composition
 * counts — that is exactly what the snapshot array records. Pre-fetched into
 * an id list, the same expansion idiom `memberIdsOf` and
 * `initiativeExpansionOf` use; a template no instance was ever composed from
 * expands to nothing and fails CLOSED via `safeIds`. */
async function templateInstancesOf(db: Db, id: string): Promise<string[]> {
  const rows = await db
    .select({ id: workflowInstances.id })
    .from(workflowInstances)
    .where(sql`${workflowInstances.templateIds} @> ${JSON.stringify([assertUuid(id)])}::jsonb`);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Timeframes
// ---------------------------------------------------------------------------

export function resolveCopilotTimeframe(
  tf: CopilotTimeframe,
  now: Date,
): { start: Date; end: Date; label: string } {
  const end = new Date(now.getTime());
  const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const startOfQuarter = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  switch (tf) {
    case "last_7_days":
      return { start: new Date(end.getTime() - 7 * 86_400_000), end, label: "the last 7 days" };
    case "current_month":
      return { start: startOfMonth(now), end, label: "the current month" };
    case "last_month": {
      const s = startOfMonth(now);
      return {
        start: new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 1, 1)),
        end: s,
        label: "last month",
      };
    }
    case "current_quarter":
      return { start: startOfQuarter(now), end, label: "the current quarter" };
    case "last_quarter": {
      const s = startOfQuarter(now);
      return {
        start: new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 3, 1)),
        end: s,
        label: "last quarter",
      };
    }
    default:
      return { start: new Date(end.getTime() - 30 * 86_400_000), end, label: "the last 30 days" };
  }
}

// ---------------------------------------------------------------------------
// RETRIEVAL — four read tools, every WHERE built from the scope
// ---------------------------------------------------------------------------

/** how many raw ledger strings ever leave the database for this feature. Small
 * on purpose: samples are the injection surface, and a bounded sample is a
 * bounded surface. */
const SAMPLE_LIMIT = 5;

/**
 * ADR-0096 — the subject filter for the `approvals` ledger, in ONE place
 * because TWO tools read it (`listApprovals`, and `listAnomalies`' instant
 * decision half). Two copies could disagree, and a disagreement here would
 * mean an anomaly report narrowed differently from the approvals report over
 * the same subject.
 *
 * A `project` filter is the OR of the two ways an approval belongs to one:
 * `project_id` (set on pillar-5 budget escalations) and "raised by a member of
 * that project", which is how the tool's own entitlement scope already reads
 * this ledger. Narrower than either alone would drop real rows.
 */
function approvalEntityPredicates(
  entity: CopilotEntityRef | null,
  members: readonly string[],
  mcpTool: { serverId: string; toolName: string } | null,
  initiative: { projectIds: string[]; memberIds: string[] } | null,
  useCaseInstanceId: string | null,
  templateInstanceIds: string[] | null,
): ReturnType<typeof eq>[] {
  if (!entity) return [];
  if (entity.kind === "user") return [eq(approvals.userId, entity.id)];
  if (entity.kind === "team") return [inArray(approvals.userId, safeIds([...members]))];
  if (entity.kind === "project") {
    return [
      or(eq(approvals.projectId, entity.id), inArray(approvals.userId, safeIds([...members])))!,
    ];
  }
  // B7a: an initiative is its project set, so its approvals filter is the
  // project rule applied ACROSS that set — `project_id` in the set (pillar-5
  // budget escalations) OR raised by a member of one of its projects. Either
  // alone would drop real rows, exactly as for a single project above.
  if (entity.kind === "initiative") {
    const projectIds = safeIds(initiative?.projectIds ?? []);
    const memberIds = safeIds(initiative?.memberIds ?? []);
    return [
      or(inArray(approvals.projectId, projectIds), inArray(approvals.userId, memberIds))!,
    ];
  }
  // B6c: `approvals` carries FIRST-CLASS server_id + tool_name columns (the
  // queue's own identity for a tool-call approval), which is why MCP is the
  // only kind `listApprovals` and `listAnomalies` gained — the intersection
  // rule is satisfied by both halves rather than waived.
  if (entity.kind === "mcp_server") return [eq(approvals.serverId, entity.id)];
  if (entity.kind === "mcp_tool") {
    if (!mcpTool) return [eq(approvals.serverId, ZERO_UUID)];
    return [eq(approvals.serverId, mcpTool.serverId), eq(approvals.toolName, mcpTool.toolName)];
  }
  // B8a: the two deferred instance joins, wired exactly as B7a named them —
  // never a new attribution column. "Approvals about this use case" means the
  // sign-offs of ITS OWN intake instance; a use case with no instance matches
  // NOTHING (fail closed), never everything.
  if (entity.kind === "ai_use_case") {
    return [eq(approvals.instanceId, useCaseInstanceId ?? ZERO_UUID)];
  }
  // "Approvals about this template" means the sign-offs of every instance
  // COMPOSED from it (`template_ids @>`, pre-fetched); a template no instance
  // ever used fails CLOSED via `safeIds`.
  if (entity.kind === "workflow_template") {
    return [inArray(approvals.instanceId, safeIds(templateInstanceIds ?? []))];
  }
  // agent / connector / vendor / the remaining registry kinds never reach
  // here: `COPILOT_ENTITY_FILTER_MATRIX` excludes them for every tool that
  // reads this ledger, and the route refuses the pair before retrieval runs.
  return [];
}

export async function retrieveEvidence(
  db: Db,
  plan: CopilotQueryPlan,
  scope: CopilotScope,
  now: Date,
): Promise<CopilotEvidence> {
  const { start, end, label } = resolveCopilotTimeframe(plan.timeframe, now);
  const base: CopilotEvidence = {
    tool: plan.tool,
    timeframe: { label, start: start.toISOString(), end: end.toISOString() },
    scopeProjectIds: scope.projectIds,
    rowsExamined: 0,
    counts: [],
    samples: [],
    leads: [],
    // L6a: filled from the SAME scoped selects below. A citable object is a
    // primary key the caller's own retrieval actually returned — never an id
    // assembled from a count, and never one from an unscoped query.
    citableObjects: [],
  };

  // THE SCOPE PREDICATES. Built once, applied to every query below. Note they
  // are constructed here — not applied to a result set afterwards.
  const auditScope = scope.projectIds === null ? [] : [auditScopePredicate(scope.projectIds)];
  const memberScope =
    scope.memberIds === null ? [] : [inArray(approvals.userId, safeIds(scope.memberIds))];
  const usageScope =
    scope.projectIds === null ? [] : [inArray(usageEvents.projectId, safeIds(scope.projectIds))];

  // ADR-0096 — THE ENTITY FILTER, built into the SAME `where` as the scope, at
  // construction time. A subject filter applied to a result set afterwards
  // would have already read every row it then discards, which is the exact
  // mistake `resolveCopilotScope`'s own comment warns about for entitlement.
  //
  // The route guarantees this branch is only reached for a (tool, kind) pair
  // `COPILOT_ENTITY_FILTER_MATRIX` admits, so there is no silent fall-through:
  // an unsupported pair was refused before retrieval ran.
  const entity = plan.entity;
  const entityMembers =
    entity && (entity.kind === "team" || entity.kind === "project")
      ? await memberIdsOf(db, entity.kind, entity.id)
      : [];
  // B6c: the (server_id, tool_name) pair every ledger actually stores
  const entityMcpTool = entity?.kind === "mcp_tool" ? await mcpToolRefOf(db, entity.id) : null;
  // B7a: an initiative's project set + those projects' members, the expansion
  // every ledger's initiative filter is built from
  const entityInitiative =
    entity?.kind === "initiative" ? await initiativeExpansionOf(db, entity.id) : null;
  // B8a: the two instance joins the approvals filter rides — the use case's
  // own intake instance, and the instances composed from a template
  const entityUseCaseInstance =
    entity?.kind === "ai_use_case" ? await useCaseInstanceOf(db, entity.id) : null;
  const entityTemplateInstances =
    entity?.kind === "workflow_template" ? await templateInstancesOf(db, entity.id) : null;

  if (plan.tool === "queryAuditDecisions" || plan.tool === "listAnomalies") {
    // `audit_log` carries no project column; attribution rides
    // `detail->>'projectId'`, the same key the scope predicate reads.
    const entityAudit = !entity
      ? []
      : entity.kind === "project"
        ? [sql`${auditLog.detail} ->> 'projectId' = ${assertUuid(entity.id)}`]
        : entity.kind === "team"
          ? [inArray(auditLog.userId, safeIds(entityMembers))]
          : entity.kind === "user"
            ? [eq(auditLog.userId, entity.id)]
            : // B6c: an MCP row identifies itself with the DEDICATED
              // `server_id` / `tool_name` columns the proxy writes — it leaves
              // `object_type` NULL — so these two kinds filter on those
              // columns, not on the object_type/object_id pair.
              entity.kind === "mcp_server"
              ? [eq(auditLog.serverId, entity.id)]
              : entity.kind === "mcp_tool"
                ? entityMcpTool
                  ? [
                      eq(auditLog.serverId, entityMcpTool.serverId),
                      eq(auditLog.toolName, entityMcpTool.toolName),
                    ]
                  : [eq(auditLog.serverId, ZERO_UUID)]
                : // B7a: an initiative filters the way a project does —
                  // through `detail->>'projectId'`, the attribution key every
                  // governed path writes — over its whole project set. The
                  // same predicate builder the SCOPE uses, so the two cannot
                  // diverge; an initiative with no projects matches nothing
                  // (fail closed), never everything.
                  entity.kind === "initiative"
                  ? [auditScopePredicate(entityInitiative?.projectIds ?? [])]
                  : // B8a: the ONE kind whose label and enum value differ —
                    // the resolver's kind is 'vendor' but ADR-0084's vendor
                    // surface writes `object_type='ai_vendor'` on every
                    // propose/update/attestation/lifecycle row, so the map is
                    // explicit rather than riding the kind string.
                    entity.kind === "vendor"
                    ? [eq(auditLog.objectType, "ai_vendor"), eq(auditLog.objectId, entity.id)]
                    : [
                      // agent / connector — and B7a's compliance_pack,
                      // ai_use_case, ai_risk, workflow_template, role and
                      // virtual_key: the object THIS row was about, via the
                      // `object_type` enum value the gateway already writes
                      // for each of them. The entity's own class REPLACES any
                      // keyword-derived `objectType` — a question naming an
                      // agent is about that agent whatever other class word it
                      // happens to contain, and ANDing the two would silently
                      // return zero rows instead of an answer.
                      eq(
                        auditLog.objectType,
                        entity.kind as (typeof auditLog.objectType)["_"]["data"],
                      ),
                      eq(auditLog.objectId, entity.id),
                    ];
    // B6c extends the same replacement rule to the MCP kinds, and for a
    // sharper reason than convenience: the planner maps the words "mcp" and
    // "tool call" to `objectType: 'mcp_tool'`, while the proxy's own audit rows
    // carry `object_type NULL`. ANDing the keyword would return ZERO rows for
    // every MCP question — the resolved subject wins, as it does for agents.
    const entityOwnsObjectType =
      entity?.kind === "agent" ||
      entity?.kind === "connector" ||
      entity?.kind === "mcp_server" ||
      entity?.kind === "mcp_tool" ||
      // B7a: the six object_type-filtered registry kinds own the column for
      // the same reason — their filter IS `object_type = <kind>`, and ANDing a
      // keyword-derived class (e.g. "tool call" → 'mcp_tool' in a question
      // about a virtual key's denials) would return zero rows, not an answer.
      entity?.kind === "compliance_pack" ||
      entity?.kind === "ai_use_case" ||
      entity?.kind === "ai_risk" ||
      entity?.kind === "workflow_template" ||
      entity?.kind === "role" ||
      entity?.kind === "virtual_key" ||
      // B8a: vendor's filter IS `object_type = 'ai_vendor'` — same reason
      entity?.kind === "vendor";
    const where = and(
      gte(auditLog.at, start),
      lt(auditLog.at, end),
      ...(plan.params.effect ? [eq(auditLog.effect, plan.params.effect)] : []),
      ...(plan.params.objectType && !entityOwnsObjectType
        ? [eq(auditLog.objectType, plan.params.objectType as (typeof auditLog.objectType)["_"]["data"])]
        : []),
      ...auditScope,
      ...entityAudit,
    );
    const [total, byEffect, topRules, samples] = await Promise.all([
      db.select({ n: count() }).from(auditLog).where(where),
      db.select({ effect: auditLog.effect, n: count() }).from(auditLog).where(where).groupBy(auditLog.effect),
      db
        .select({ ruleId: auditLog.ruleId, n: count() })
        .from(auditLog)
        .where(and(where, eq(auditLog.effect, "deny")))
        .groupBy(auditLog.ruleId)
        .orderBy(desc(count()))
        .limit(5),
      db
        .select({ id: auditLog.id, ruleId: auditLog.ruleId, reason: auditLog.reason, effect: auditLog.effect })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.at))
        .limit(SAMPLE_LIMIT),
    ]);
    base.rowsExamined = total[0]?.n ?? 0;
    // L6a — THE CITABLE SET. Ids from the SAME `where` the counts came from,
    // so an answer can be walked back to concrete rows. The LABEL is the
    // effect + rule id (facts this gateway wrote), never the `reason` string,
    // which is the attacker-influenceable half and is handled as a sample.
    base.citableObjects = samples.map((s) => ({
      kind: "audit_log" as const,
      id: s.id,
      label: `${s.effect} · ${s.ruleId}`,
    }));
    base.counts.push({ key: "decisions", label: "governance decisions", value: base.rowsExamined });
    for (const e of byEffect) {
      base.counts.push({ key: `effect.${e.effect}`, label: `decisions with effect '${e.effect}'`, value: e.n });
    }
    for (const r of topRules) {
      base.counts.push({ key: `deny_rule.${r.ruleId}`, label: `denials from rule '${r.ruleId}'`, value: r.n });
    }
    base.samples = samples.map((s) => ({ key: s.ruleId, text: s.reason }));

    if (plan.tool === "listAnomalies") {
      for (const r of topRules) {
        if (r.n >= 3) {
          base.leads.push({
            kind: "deny_burst",
            subject: r.ruleId,
            detail: `rule denied ${r.n} time(s) in ${label} — a misconfigured agent or an entitlement gap`,
            evidenceCount: r.n,
          });
        }
      }
      const fast = await db
        .select({ id: approvals.id, requestedAt: approvals.requestedAt, decidedAt: approvals.decidedAt })
        .from(approvals)
        .where(
          and(
            gte(approvals.requestedAt, start),
            lt(approvals.requestedAt, end),
            inArray(approvals.status, ["approved", "denied"]),
            ...memberScope,
            // ADR-0096: the SECOND ledger this tool reads gets the same subject
            // filter as the first. `listAnomalies` supports only the kinds BOTH
            // halves can narrow (the matrix says so), so a half-narrowed
            // anomaly report — one lead about your subject, one about
            // everything — is unreachable rather than merely discouraged.
            ...approvalEntityPredicates(
        entity,
        entityMembers,
        entityMcpTool,
        entityInitiative,
        entityUseCaseInstance,
        entityTemplateInstances,
      ),
          ),
        );
      const rubber = fast.filter(
        (a) => a.decidedAt && a.decidedAt.getTime() - a.requestedAt.getTime() < 2000,
      );
      if (rubber.length) {
        base.leads.push({
          kind: "instant_decision",
          subject: "approvals decided in under 2 seconds",
          detail: "a decision that fast is unlikely to be a review — a lead for a human, not a finding",
          evidenceCount: rubber.length,
        });
      }
      base.counts.push({ key: "instant_decisions", label: "approvals decided in <2s", value: rubber.length });
    }
    return base;
  }

  if (plan.tool === "listApprovals") {
    const where = and(
      gte(approvals.requestedAt, start),
      lt(approvals.requestedAt, end),
      ...(plan.params.status ? [eq(approvals.status, plan.params.status)] : []),
      ...memberScope,
      ...approvalEntityPredicates(
        entity,
        entityMembers,
        entityMcpTool,
        entityInitiative,
        entityUseCaseInstance,
        entityTemplateInstances,
      ),
    );
    const [total, byStatus, rows] = await Promise.all([
      db.select({ n: count() }).from(approvals).where(where),
      db.select({ status: approvals.status, n: count() }).from(approvals).where(where).groupBy(approvals.status),
      db
        .select({ id: approvals.id, status: approvals.status, objectType: approvals.objectType })
        .from(approvals)
        .where(where)
        .orderBy(desc(approvals.requestedAt))
        .limit(SAMPLE_LIMIT),
    ]);
    base.rowsExamined = total[0]?.n ?? 0;
    base.counts.push({ key: "approvals", label: "approvals requested", value: base.rowsExamined });
    for (const s of byStatus) {
      base.counts.push({ key: `status.${s.status}`, label: `approvals in state '${s.status}'`, value: s.n });
    }
    base.citableObjects = rows.map((r) => ({
      kind: "approval" as const,
      id: r.id,
      label: `${r.objectType} · ${r.status}`,
    }));
    return base;
  }

  // summarizeUsage
  const entityUsage = !entity
    ? []
    : entity.kind === "project"
      ? [eq(usageEvents.projectId, entity.id)]
      : entity.kind === "team"
        ? [inArray(usageEvents.userId, safeIds(entityMembers))]
        : entity.kind === "user"
          ? [eq(usageEvents.userId, entity.id)]
          : entity.kind === "agent"
            ? // BOTH agent columns: a right-sized routing decision (ADR-0095)
              // makes `agent_id` the SERVED agent and `requested_agent_id` the
              // one the caller asked for. "Spend on agent X" honestly covers
              // both, and covering only one would under-report the answer.
              [
                or(
                  eq(usageEvents.agentId, entity.id),
                  eq(usageEvents.requestedAgentId, entity.id),
                )!,
              ]
            : entity.kind === "connector"
              ? [eq(usageEvents.connectorId, entity.id)]
              : // B7a — an initiative is its project set: `project_id IN`, the
                // EXACT join GET /v1/initiatives itself runs to roll up
                // initiative spend. No projects = no rows (fail closed).
                entity.kind === "initiative"
                ? [inArray(usageEvents.projectId, safeIds(entityInitiative?.projectIds ?? []))]
                : // B7a — a virtual key has a FIRST-CLASS ledger column:
                  // `virtual_key_id`, "which key paid for this row" (ADR-0066)
                  entity.kind === "virtual_key"
                  ? [eq(usageEvents.virtualKeyId, entity.id)]
                  : // B6c — `usage_events` has NO server column: the MCP proxy
                // documents its own convention ("`operation` carries the tool
                // name and the server id rides the detail jsonb"), and this
                // filter reads exactly that pair. `object_type` is pinned to
                // 'mcp_tool' here because on THIS ledger the proxy does set it,
                // and it keeps a tool name that collides with a connector
                // operation from matching.
                entity.kind === "mcp_server"
                ? [sql`${usageEvents.detail} ->> 'serverId' = ${assertUuid(entity.id)}`]
                : entityMcpTool
                  ? [
                      eq(usageEvents.objectType, "mcp_tool"),
                      eq(usageEvents.operation, entityMcpTool.toolName),
                      sql`${usageEvents.detail} ->> 'serverId' = ${assertUuid(entityMcpTool.serverId)}`,
                    ]
                  : [eq(usageEvents.id, ZERO_UUID)];
  const where = and(
    gte(usageEvents.at, start),
    lt(usageEvents.at, end),
    ...usageScope,
    ...entityUsage,
  );
  const [total, grouped, rows] = await Promise.all([
    db.select({ n: count() }).from(usageEvents).where(where),
    db
      .select({
        projectId: usageEvents.projectId,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        n: count(),
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.projectId)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({ id: usageEvents.id, provider: usageEvents.provider, model: usageEvents.model })
      .from(usageEvents)
      .where(where)
      .orderBy(desc(usageEvents.at))
      .limit(SAMPLE_LIMIT),
  ]);
  base.rowsExamined = total[0]?.n ?? 0;
  base.citableObjects = rows.map((r) => ({
    kind: "usage_event" as const,
    id: r.id,
    label: `${r.provider} · ${r.model}`,
  }));
  base.counts.push({ key: "calls", label: "measured model/tool calls", value: base.rowsExamined });
  for (const g of grouped) {
    base.counts.push({
      key: `project.${g.projectId ?? "unattributed"}`,
      label: `calls attributed to project ${g.projectId ?? "(none)"}`,
      value: g.n,
    });
  }
  return base;
}

// ---------------------------------------------------------------------------
// The narrator — a governed dispatch, behind ADR-0044's judge pattern
// ---------------------------------------------------------------------------

/**
 * THE MODEL-BACKED NARRATOR. An ordinary governed dispatch of a registry agent,
 * which is what makes it provider-agnostic and what makes its cost visible in
 * pillar 5 rather than hidden in a system component's budget.
 *
 * UNVERIFIED IN THIS BUILD: no provider is connected here, so this class has
 * never narrated real evidence. `buildNarrationPrompt`, `parseNarration` and
 * `narrationIsGrounded` are unit-tested; the model's prose is not.
 */
export class ModelBackedNarrator implements CopilotNarrator {
  readonly id: string;
  constructor(
    private readonly db: Db,
    private readonly dataKey: string | undefined,
    private readonly ctx: {
      agent: AgentRow;
      userId: string;
      projectId: string | null;
    },
  ) {
    this.id = `model:${ctx.agent.name}`;
  }

  async narrate(req: CopilotNarrationRequest): Promise<CopilotNarration> {
    const outcome = await executeGovernedDispatch(this.db, this.dataKey, {
      userId: this.ctx.userId,
      served: this.ctx.agent,
      requestedAgentId: this.ctx.agent.id,
      // no routing counterfactual: the narrator is pinned by the caller
      baseline: null,
      input: buildNarrationPrompt(req),
      // L6a — 1024 WAS TOO SMALL, and the failure was measured, not guessed.
      // Against a live reasoning model the narration came back truncated
      // (`finishReason: MAX_TOKENS`, 981 thought tokens against a 1024 ceiling,
      // 39 tokens of actual JSON) and was correctly discarded as unparseable —
      // so the copilot could never narrate at all on such a model. Re-running
      // the IDENTICAL prompt with a 4096 ceiling finished cleanly (`STOP`,
      // 1688 thought tokens, complete JSON citing the real object ids), which
      // is what proves the ceiling was the cause rather than the prompt. This
      // is an output CEILING, not a spend: a non-reasoning model still emits
      // its ~200-token reply and bills for that.
      maxTokens: 4096,
      projectId: this.ctx.projectId,
      detail: { purpose: "copilot-narration", tool: req.plan.tool },
    });
    if (!outcome.ok) {
      throw new Error(
        `copilot narration dispatch failed: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      );
    }
    const parsed = parseNarration(outcome.result.outputText);
    if (!parsed.ok) throw new Error(`copilot narration unusable: ${parsed.error}`);
    return parsed.narration;
  }
}

/** the entitlement inputs, the SAME `evaluateAgent` path an ordinary invoke
 * takes — the copilot's narrator is not exempt from anything */
async function agentDecision(db: Db, userId: string, agent: AgentRow): Promise<AgentDecision> {
  const [grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return evaluateAgent({
    userId,
    agent: {
      id: agent.id,
      name: agent.name,
      tier: agent.tier,
      enabled: agent.enabled,
      modes: agent.modes ?? null,
    },
    mode: "chat",
    agentGrants: grants,
    roleAgentGrants: roleGrants,
    agentRevocations: revocations,
    ceilingTier,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface CopilotRouteOptions {
  dataKey?: string | undefined;
  /** TEST SEAM, and the future extension point. Absent = a `ModelBackedNarrator`
   * built from the caller's `narratorAgentId`, i.e. the real, governed path. */
  narrator?: CopilotNarrator | null | undefined;
}

export function registerCopilotRoutes(app: FastifyInstance, db: Db, opts: CopilotRouteOptions = {}): void {
  async function audit(
    actor: string | null,
    objectType: "copilot_query" | "copilot_proposal",
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? ZERO_UUID,
      objectType,
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /** the honest inventory of everything this agent can reach */
  app.get("/v1/copilot/tools", async () => ({
    tools: COPILOT_TOOL_SPECS,
    mutatingTools: [],
    note:
      "The copilot has NO MUTATING TOOLS (ADR-0056 §4). Everything it can do is listed above and " +
      "every one of them is a read. Its only route to a change is a PROPOSAL that opens an " +
      "Approvals-Queue item; a named human applies it, under their own identity.",
    scopeCaveat: COPILOT_SCOPE_CAVEAT,
    decisionSupport: COPILOT_DECISION_SUPPORT_NOTICE,
  }));

  /**
   * ASK. Plan -> retrieve (scoped) -> guardrail the untrusted ledger text ->
   * ground -> optionally narrate through the governed dispatch.
   */
  app.post("/v1/copilot/ask", async (req, reply) => {
    const body = copilotAskSchema.parse(req.body ?? {});
    const userId = req.authCtx.userId ?? null;

    // AN IDENTITY-LESS CALLER IS REFUSED. There would be no entitlement set to
    // inherit, and "inherits the caller's entitlements, never exceeds them" is
    // the entire security model. The bootstrap token cannot ask the copilot.
    if (!userId) {
      await audit(
        null,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.refusedNoIdentity,
        "refused a copilot question from an identity-less caller: the copilot answers with the " +
          "INVOKING USER's entitlements, and there is no entitlement set to inherit here",
        { isAdmin: req.authCtx.isAdmin },
        "deny",
      );
      return reply.status(403).send({
        error: "copilot_requires_identity",
        detail:
          "The copilot reads only what its invoking user may read. A token with no user identity has " +
          "no entitlement set to inherit, so it cannot ask.",
      });
    }

    const now = new Date();
    const plan = planCopilotQuery(body.question);
    const scope = await resolveCopilotScope(db, { userId, isAdmin: req.authCtx.isAdmin });

    // -----------------------------------------------------------------------
    // ADR-0096 — ENTITY-AWARE PLANNING, BEFORE ANY RETRIEVAL RUNS.
    //
    // The question's proposed subjects are resolved against the real object
    // graph under this caller's own entitlements. Three of the four outcomes
    // end the request here, with nothing retrieved and nothing narrated:
    // running a broad query and labelling its findings with the caller's words
    // is the fabrication ADR-0056's L6d amendment could only caveat, and this
    // is where it stops being possible.
    // -----------------------------------------------------------------------
    const resolution = await resolveCopilotEntities(db, plan.entityCandidates, scope, {
      userId,
      isAdmin: req.authCtx.isAdmin,
    });

    if (resolution.status === "unresolved") {
      // WORDED IDENTICALLY whether the object does not exist or exists
      // somewhere this caller may not read — the copilot is not an existence
      // oracle. The candidates are echoed because they are the caller's OWN
      // words; nothing about any object is disclosed.
      const detail = copilotEntityUnresolvedRefusal(resolution.candidates);
      await audit(
        userId,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.entityUnresolved,
        `refused a copilot question naming a subject that resolved to no governed object in this ` +
          `caller's scope (${resolution.candidates.join(", ")}). Answering it would have meant ` +
          `running '${plan.tool}' unfiltered and presenting org-wide findings as that subject's — ` +
          `real numbers under a name nobody searched for`,
        { candidates: resolution.candidates, tool: plan.tool },
        "deny",
      );
      return reply.status(422).send({
        error: "copilot_entity_unresolved",
        detail,
        candidates: resolution.candidates,
        plan,
        scopeCaveat: COPILOT_SCOPE_CAVEAT,
      });
    }

    if (resolution.status === "ambiguous") {
      const detail = copilotEntityAmbiguousRefusal(resolution.matches);
      await audit(
        userId,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.entityAmbiguous,
        `refused a copilot question whose subject matched ${resolution.matches.length} governed ` +
          `objects in this caller's scope — narrowing to one of them by a tiebreak would attach ` +
          `real records to a subject the caller never chose`,
        { matches: resolution.matches, tool: plan.tool },
        "deny",
      );
      return reply.status(422).send({
        error: "copilot_entity_ambiguous",
        detail,
        candidates: resolution.matches,
        plan,
        scopeCaveat: COPILOT_SCOPE_CAVEAT,
      });
    }

    if (resolution.status === "resolved") {
      const { entity } = resolution;
      if (!copilotToolSupportsEntityKind(plan.tool, entity.kind)) {
        // RESOLVED, AND STILL REFUSED. The subject is real and visible; the
        // ledger this tool reads simply has no column for it. Running anyway
        // and captioning the result with the subject's name is the same lie as
        // the unresolved case, so it gets the same treatment — plus the names
        // of the tools that CAN answer.
        const detail = copilotEntityNotFilterableRefusal(plan.tool, TOOL_LEDGER[plan.tool], entity);
        await audit(
          userId,
          "copilot_query",
          null,
          COPILOT_RULE_IDS.entityNotFilterable,
          `refused a copilot question whose subject resolved to the ` +
            `${COPILOT_ENTITY_KIND_LABELS[entity.kind]} '${entity.name}' (${entity.id}) but whose ` +
            `planned tool '${plan.tool}' reads a ledger with no ${entity.kind} column — the query ` +
            `could not be narrowed to the subject, and running it unfiltered would have produced ` +
            `real findings labelled with a subject nobody filtered on`,
          {
            entity: { kind: entity.kind, id: entity.id },
            tool: plan.tool,
            toolsThatCanFilter: copilotToolsFilteringEntityKind(entity.kind),
          },
          "deny",
        );
        return reply.status(422).send({
          error: "copilot_tool_cannot_filter_entity",
          detail,
          entity,
          tool: plan.tool,
          toolsThatCanFilter: copilotToolsFilteringEntityKind(entity.kind),
          plan,
          scopeCaveat: COPILOT_SCOPE_CAVEAT,
        });
      }
      // THE CASE THAT MAKES THE FEATURE TRUE: the plan now carries a real
      // filter, and every SELECT below is built with it.
      plan.entity = entity;
    }

    const evidence = await retrieveEvidence(db, plan, scope, now);

    // ADR-0042 — THE INJECTION SURFACE. Retrieved `reason` strings are text an
    // attacker may have influenced. They are evaluated as PHASE INPUT before
    // they reach a model or an answer; a block WITHHOLDS the samples. The
    // grounded answer is composed from counts, so it survives intact.
    const policy = await resolveGuardrailPolicy(db, { projectId: body.projectId ?? null });
    const sampleText = evidence.samples.map((s) => s.text).join("\n");
    const guard = sampleText ? runGuardrails(policy, "input", sampleText) : null;
    let guardrailAction: string | null = null;
    if (guard && guard.findings.length > 0) {
      guardrailAction = guard.action;
      if (guard.action === "block") {
        evidence.samples = [];
      }
      await audit(
        userId,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.guardrailActed,
        `a guardrail fired on evidence read out of the audit log itself (action '${guard.action}') — ` +
          `the copilot's context IS the governance record, so a crafted log entry is an injection ` +
          `vector and is treated as untrusted input, not as instructions`,
        { action: guard.action, categories: guard.findings.map((f) => f.detector) },
        guard.action === "block" ? "deny" : "allow",
      );
    }

    const grounded = renderGroundedAnswer(plan, evidence, body.question);
    let answerText = grounded.text;
    let generation: "grounded" | "model" = "grounded";
    let narratorAgentId: string | null = null;
    let narrationError: string | null = null;
    /** L6a: true only once a narration has PASSED `narrationIsGrounded` */
    let narrationGroundingChecked = false;
    let narrationRefused = false;

    if (body.narratorAgentId) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, body.narratorAgentId));
      if (!agent) return reply.status(404).send({ error: "unknown_narrator_agent" });
      // THE SAME ENTITLEMENT CHECK AN ORDINARY INVOKE TAKES. The copilot is a
      // tenant: a user who may not call this agent may not narrate with it.
      const decision = await agentDecision(db, userId, agent as AgentRow);
      if (decision.effect !== "allow") {
        await audit(
          userId,
          "copilot_query",
          null,
          COPILOT_RULE_IDS.narratorNotEntitled,
          `refused a copilot narration: ${decision.reason}. The copilot is a governed tenant, not a ` +
            `privileged system component — it inherits this user's entitlements and never exceeds them`,
          { narratorAgentId: agent.id, accessRuleId: decision.ruleId },
          "deny",
        );
        return reply.status(403).send({ error: "narrator_not_entitled", detail: decision.reason });
      }
      const narrator =
        opts.narrator ??
        new ModelBackedNarrator(db, opts.dataKey, {
          agent: agent as AgentRow,
          userId,
          projectId: body.projectId ?? null,
        });
      try {
        const narration = await narrator.narrate({
          question: body.question,
          plan,
          evidence,
          groundedText: grounded.text,
        });
        const check = narrationIsGrounded(narration, evidence);
        if (!check.ok) throw new Error(check.reason);
        answerText = `${grounded.text}\n\n--- narration ---\n${narration.text}`;
        generation = "model";
        narratorAgentId = agent.id;
        narrationGroundingChecked = true;
        narrationRefused = narration.refused;
      } catch (err) {
        // THE GROUNDED ANSWER STANDS. A narration that failed, or that cited a
        // figure the retrieval never produced, is DISCARDED — never merged in
        // and never allowed to replace the counts.
        narrationError = err instanceof Error ? err.message : String(err);
        await audit(
          userId,
          "copilot_query",
          null,
          COPILOT_RULE_IDS.narrationFailed,
          `a copilot narration was DISCARDED (${narrationError}) — the grounded, count-derived answer ` +
            `stands on its own, because an ungrounded narration is exactly the confidently-wrong ` +
            `failure mode this design refuses to paper over`,
          { narratorAgentId: agent.id },
          "deny",
        );
      }
    }

    const [row] = await db
      .insert(copilotQueries)
      .values({
        userId,
        question: body.question,
        plan: plan as unknown as Record<string, unknown>,
        evidence: evidence as unknown as Record<string, unknown>,
        answer: answerText,
        generation,
        narratorAgentId,
        scopeProjectIds: scope.projectIds,
        projectId: body.projectId ?? null,
        guardrailAction,
      })
      .returning();

    await audit(
      userId,
      "copilot_query",
      row!.id,
      COPILOT_RULE_IDS.asked,
      `copilot answered a governance question using the '${plan.tool}' read tool over ` +
        `${evidence.timeframe.label}, scoped to ` +
        (scope.projectIds === null
          ? "the whole organization (admin caller)"
          : `${scope.projectIds.length} entitled project(s)`) +
        ` — ${evidence.rowsExamined} record(s) examined. Read-only: the copilot has no mutating tools`,
      {
        tool: plan.tool,
        timeframe: plan.timeframe,
        // THE HONEST RECORD OF WHAT IT WAS PERMITTED TO SEE
        scopeProjectIds: scope.projectIds,
        rowsExamined: evidence.rowsExamined,
        generation,
        guardrailAction,
        // L6d — and the honest record of what it NARROWED ON. "Were those
        // figures actually about the thing that question named?" has to stay
        // answerable from the ledger alone, long after the answer text is gone.
        filters: describeCopilotFilters(plan.params, plan.entity),
        subjectFiltered: grounded.subjectFiltered,
        // ADR-0096 — the RESOLVED SUBJECT, by id and kind, on the row an
        // auditor reads. "Was that answer actually about the thing I asked?"
        // is now answerable with a primary key rather than an inference.
        entity: plan.entity
          ? { kind: plan.entity.kind, id: plan.entity.id, matchedOn: plan.entity.matchedOn }
          : null,
        entityCandidates: plan.entityCandidates,
      },
    );

    return reply.status(201).send({
      query: { ...row, evidence: undefined },
      plan,
      answer: {
        ...grounded,
        text: answerText,
        generation,
        // L6a — an HONEST per-answer flag, not a build-wide constant. True means
        // exactly one thing: THIS narration was cross-checked against THIS
        // retrieval's counts and object ids and passed. It is never a claim
        // that the model is generally reliable.
        modelNarrationVerified: narrationGroundingChecked,
        // the refusal is the grounded layer's, or the model's own agreement
        // with it — either way the caller sees "nothing to answer from"
        groundedRefusal: grounded.groundedRefusal || narrationRefused,
      },
      evidence,
      scope: { projectIds: scope.projectIds, statement: scope.statement },
      ...(narrationError ? { narrationDiscarded: narrationError } : {}),
      note:
        (grounded.subjectFiltered
          ? ""
          : `${grounded.unfilteredSubjectCaveat} `) +
        // ADR-0096 — when a subject WAS resolved, the note leads with what the
        // query was narrowed to, by id. The caveat's absence is not evidence
        // of narrowing; this sentence is.
        (plan.entity
          ? `SUBJECT RESOLVED AND FILTERED. "${plan.entity.matchedOn}" in your question resolved to ` +
            `the ${COPILOT_ENTITY_KIND_LABELS[plan.entity.kind]} '${plan.entity.name}' ` +
            `(${plan.entity.id}) in your own scope, and every figure above was retrieved with that ` +
            `as a SQL filter. `
          : "") +
        (narrationGroundingChecked
          ? "The retrieval, scoping and grounding above are real and tested. A model narration was " +
            "added on top and CROSS-CHECKED against this retrieval — every count key and every " +
            "governance-object id it cited was one this caller's own scoped query returned. That " +
            "cross-check covers the FIGURES AND IDS ONLY: it does not, and cannot, verify that the " +
            "narration attributed them to the right subject. The counts remain the authoritative " +
            "answer; the narration is prose over them."
          : narrationError
            ? "The retrieval, scoping and grounding above are real and tested. A model narration was " +
              "attempted and DISCARDED (see `narrationDiscarded`); the grounded, count-derived answer " +
              "stands alone."
            : "The retrieval, scoping and grounding above are real and tested. No narrator agent was " +
              "named, so this answer is the grounded, count-derived one and no model was called."),
    });
  });

  app.get("/v1/copilot/queries", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    // A NON-ADMIN SEES THEIR OWN QUESTIONS ONLY. Someone else's question, with
    // its retrieved evidence attached, is someone else's data.
    const where = req.authCtx.isAdmin
      ? undefined
      : eq(copilotQueries.userId, req.authCtx.userId ?? ZERO_UUID);
    const rows = await db
      .select()
      .from(copilotQueries)
      .where(where)
      .orderBy(desc(copilotQueries.createdAt))
      .limit(q.limit);
    return { queries: rows, decisionSupport: COPILOT_DECISION_SUPPORT_NOTICE };
  });

  /**
   * PROPOSE. The copilot's ONLY route to a change — and it is not a change.
   * This writes a proposal row and an ordinary `approvals` row. It writes no
   * grant, no role, no rule, no policy. Applying the diff is a separate,
   * governed act by the approving human through the existing decide path.
   */
  app.post("/v1/copilot/proposals", async (req, reply) => {
    const body = copilotProposalSchema.parse(req.body);
    const userId = req.authCtx.userId ?? null;
    if (!userId) return reply.status(403).send({ error: "copilot_requires_identity" });

    const [query] = await db.select().from(copilotQueries).where(eq(copilotQueries.id, body.queryId));
    if (!query) return reply.status(404).send({ error: "unknown_copilot_query" });

    // A PROPOSAL MUST REST ON THE PROPOSER'S OWN QUERY. Otherwise a user could
    // launder another user's (wider-scoped) evidence into a proposal of their
    // own — a scope-widening path dressed as a suggestion.
    if (query.userId !== userId && !req.authCtx.isAdmin) {
      await audit(
        userId,
        "copilot_proposal",
        null,
        COPILOT_RULE_IDS.proposalRefused,
        "refused a copilot proposal built on ANOTHER USER'S query: the evidence behind a proposal was " +
          "retrieved under that user's entitlement scope, and reusing it here would launder a wider " +
          "read into this caller's hands",
        { queryId: body.queryId },
        "deny",
      );
      return reply.status(403).send({ error: "proposal_evidence_not_yours" });
    }

    const [approver] = await db.select().from(users).where(eq(users.id, body.approverUserId));
    if (!approver) return reply.status(404).send({ error: "unknown_approver" });

    const record = buildProposalRecord({
      kind: body.kind as CopilotProposalKind,
      title: body.title,
      rationale: body.rationale,
      diff: body.diff as Record<string, unknown>,
      evidence: query.evidence as unknown as CopilotEvidence,
    });

    // THE ONE QUEUE. Not a copilot inbox.
    const [approval] = await db
      .insert(approvals)
      .values({
        userId,
        objectType: "copilot_proposal",
        approverUserId: body.approverUserId,
        status: "pending",
      })
      .returning();

    const [proposal] = await db
      .insert(copilotProposals)
      .values({
        queryId: query.id,
        kind: record.kind,
        title: record.title,
        rationale: record.rationale,
        diff: record.diff,
        evidence: record.evidence,
        approvalId: approval!.id,
        proposedByUserId: userId,
      })
      .returning();

    await audit(
      userId,
      "copilot_proposal",
      proposal!.id,
      COPILOT_RULE_IDS.proposalOpened,
      `copilot proposal '${record.title}' (${record.kind}) opened as an ordinary Approvals-Queue item ` +
        `for a named approver. NOTHING WAS APPLIED: the copilot has no mutating tools, and if this diff ` +
        `is ever applied it will be a governed action attributed to the approver, not to the copilot`,
      { kind: record.kind, approvalId: approval!.id, queryId: query.id },
    );

    return reply.status(201).send({
      proposal,
      approvalId: approval!.id,
      note: record.note,
    });
  });

  // -------------------------------------------------------------------------
  // L6b — THE CONSENT-GATED APPLIER.
  //
  // ADR-0056's amendment named this gap outright: "an approved proposal is not
  // applied by anything… the worked example loop stops at 'approved', not at
  // 'revoked'." This closes it, and the shape of the closure is the whole
  // point:
  //
  //  * CONSENT FIRST. The gate is the LINKED APPROVAL's status in the ONE
  //    existing approvals queue — reused, never forked. Pending, denied, and
  //    "no approval row at all" each refuse by their own name, audited, with
  //    the mutation not attempted.
  //  * THROUGH THE PUBLIC DOOR, NEVER PAST IT. A rule edit rides `applyRuleEdit`
  //    (ADR-0074's one choke point, so a versioned rule mints and activates a
  //    version instead of silently drifting); a grant removal rides the
  //    one-per-kind function in `grant-revocation.ts` that `DELETE /v1/grants/…`
  //    and an ADR-0090 campaign's revoke decision both call. There is no raw
  //    table write in this handler, and a kind whose change has no such door
  //    is REFUSED BY NAME rather than approximated.
  //  * ATTRIBUTED TO THE HUMAN. The audit row is written under the applying
  //    admin's identity with the proposal as context. The copilot proposed;
  //    a named person consented; a named person applied.
  //  * ONCE. `applied_at` is the idempotency gate — a second apply is refused,
  //    never re-executed.
  // -------------------------------------------------------------------------
  app.post("/v1/copilot/proposals/:proposalId/apply", async (req, reply) => {
    const { proposalId } = z.object({ proposalId: z.string().uuid() }).parse(req.params);
    const userId = req.authCtx.userId ?? null;

    const [proposal] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    if (!proposal) return reply.status(404).send({ error: "unknown_copilot_proposal" });

    /** every refusal takes this path: audited as a deny, naming the proposal */
    const refuse = async (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => {
      await audit(
        userId,
        "copilot_proposal",
        proposal.id,
        COPILOT_RULE_IDS.proposalApplyRefused,
        `refused to apply copilot proposal '${proposal.title}' (${proposal.kind}): ${detail}`,
        { kind: proposal.kind, error, ...extra },
        "deny",
      );
      return reply.status(status).send({ error, detail });
    };

    // ALREADY APPLIED. Checked before consent so a replay cannot re-execute a
    // mutation just because the approval is still 'approved'.
    if (proposal.appliedAt) {
      return refuse(
        409,
        "proposal_already_applied",
        `this proposal was already applied at ${proposal.appliedAt.toISOString()}. Applying is a ` +
          `mutation, so it happens once; propose a new change rather than re-applying this one.`,
        { appliedAt: proposal.appliedAt.toISOString() },
      );
    }

    // ---- THE CONSENT GATE ---------------------------------------------------
    if (!proposal.approvalId) {
      return refuse(
        409,
        "proposal_has_no_approval",
        "this proposal carries no Approvals-Queue item, so no human has consented to it. The " +
          "copilot's only route to a change is a proposal a named human approves.",
      );
    }
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, proposal.approvalId));
    if (!approval) {
      return refuse(
        409,
        "proposal_approval_missing",
        "the Approvals-Queue item this proposal was opened against no longer exists, so there is " +
          "no recorded consent to apply.",
        { approvalId: proposal.approvalId },
      );
    }
    if (approval.status !== "approved") {
      return refuse(
        409,
        "proposal_not_approved",
        `the linked approval is '${approval.status}', not 'approved'. A copilot proposal is applied ` +
          `only on a named human's recorded consent through the one approvals queue — the copilot ` +
          `cannot consent on anyone's behalf and neither can this endpoint.`,
        { approvalId: approval.id, approvalStatus: approval.status },
      );
    }

    // ---- THE KIND GATE ------------------------------------------------------
    if (!copilotProposalKindIsApplicable(proposal.kind)) {
      return refuse(
        422,
        "proposal_kind_not_applicable",
        COPILOT_UNAPPLICABLE_PROPOSAL_KINDS[proposal.kind] ??
          `there is no public endpoint that applies a '${proposal.kind}' proposal, and this endpoint ` +
            `will not write the change directly.`,
        { applicableKinds: COPILOT_APPLICABLE_PROPOSAL_KINDS },
      );
    }

    // ---- THE MUTATION, THROUGH THE PUBLIC DOOR ------------------------------
    let applied: Record<string, unknown>;
    let reason: string;

    if (proposal.kind === "grant_revocation") {
      const parsedDiff = copilotGrantRevocationDiffSchema.safeParse(proposal.diff);
      if (!parsedDiff.success) {
        return refuse(
          422,
          "proposal_diff_invalid",
          `a grant_revocation diff must name {grantKind, grantId}; this one does not (${parsedDiff.error.issues
            .map((i) => i.path.join(".") || "(root)")
            .join(", ")}).`,
        );
      }
      const { grantKind, grantId } = parsedDiff.data;
      // ADR-0090's ONE removal implementation per kind — the exact function the
      // DELETE endpoints and a campaign's revoke decision call. Not a copy.
      const removers = {
        agent: deleteAgentGrantById,
        connector: deleteConnectorGrantById,
        tool: deleteToolGrantById,
        server: deleteServerGrantById,
        role_agent: deleteRoleAgentGrantById,
        role_connector: deleteRoleConnectorGrantById,
        role_tool: deleteRoleToolGrantById,
        role_server: deleteRoleServerGrantById,
      } as const;
      const removed = await removers[grantKind](db, grantId);
      if (!removed) {
        return refuse(
          404,
          "proposal_target_gone",
          `the ${grantKind} grant this proposal names (${grantId}) no longer exists — nothing was ` +
            `removed, and the proposal stays unapplied so the record does not claim a change that ` +
            `did not happen.`,
          { grantKind, grantId },
        );
      }
      applied = { via: "grant-revocation", grantKind, grantId, removed: true };
      reason =
        `applied copilot proposal '${proposal.title}': removed ${grantKind} grant ${grantId} through the ` +
        `same one-per-kind removal the DELETE /v1/grants endpoints and an ADR-0090 campaign's revoke ` +
        `decision use. Consent came from approval ${approval.id}; this act is attributed to the ` +
        `applying admin, not to the copilot`;
    } else {
      const parsedDiff = copilotPolicyTighteningDiffSchema.safeParse(proposal.diff);
      if (!parsedDiff.success) {
        return refuse(
          422,
          "proposal_diff_invalid",
          `a policy_tightening diff must name {ruleKind, ruleId, patch}; this one does not (${parsedDiff.error.issues
            .map((i) => i.path.join(".") || "(root)")
            .join(", ")}).`,
        );
      }
      const { ruleKind, ruleId, patch } = parsedDiff.data;
      const artifactType = APPLY_RULE_ARTIFACT_TYPES[ruleKind];
      // ADR-0074's ONE DOOR. Never a `.update()` on the rule table: a versioned
      // rule must mint and activate, or the admin sees an edit that enforces
      // nothing — which in a governance product is worse than a refusal.
      const res = await applyRuleEdit(db, {
        artifactType,
        artifactId: ruleId,
        patch,
        actorUserId: userId,
        label: `applied copilot proposal ${proposal.id}`,
        reason:
          `${ruleKind} rule tightened by applying copilot proposal '${proposal.title}' ` +
          `(approval ${approval.id})`,
        auditObjectType: "restriction_rule",
        auditRuleId: "copilot-proposal-rule-edit",
        auditDetail: {
          phase: "copilot-proposal-apply",
          ruleKind,
          copilotProposalId: proposal.id,
          approvalId: approval.id,
        },
      });
      if (isRuleEditRefusal(res)) {
        // THE CHOKE POINT'S OWN REFUSAL, SURFACED VERBATIM. The applier does not
        // get a way around a refusal an admin editing by hand would hit.
        return refuse(res.status, res.error, res.detail, { ruleKind, ruleId });
      }
      applied = {
        via: "applyRuleEdit",
        ruleKind,
        ruleId,
        versionMinted: res.mintedVersion,
        note: res.note,
      };
      reason =
        `applied copilot proposal '${proposal.title}': edited ${ruleKind} rule ${ruleId} through ` +
        `applyRuleEdit, ADR-0074's single door for every rule-table write` +
        (res.mintedVersion ? ` (config version minted and activated)` : ` (unversioned rule: plain row write)`) +
        `. Consent came from approval ${approval.id}; this act is attributed to the applying admin, ` +
        `not to the copilot`;
    }

    const [updated] = await db
      .update(copilotProposals)
      .set({ appliedAt: new Date(), appliedByUserId: userId, appliedResult: applied })
      .where(eq(copilotProposals.id, proposal.id))
      .returning();

    await audit(userId, "copilot_proposal", proposal.id, COPILOT_RULE_IDS.proposalApplied, reason, {
      kind: proposal.kind,
      approvalId: approval.id,
      // THE PROPOSAL AS CONTEXT: what was proposed, on what evidence, and what
      // the choke point actually did — all on the one row an auditor reads.
      copilotProposalId: proposal.id,
      copilotQueryId: proposal.queryId,
      proposedByUserId: proposal.proposedByUserId,
      diff: proposal.diff,
      applied,
    });

    return reply.send({
      proposal: updated,
      applied,
      note:
        "APPLIED UNDER THE ADMIN'S OWN IDENTITY, through the same public endpoint an admin would " +
        "use by hand. The copilot proposed the change and a named human approved it; neither the " +
        "copilot nor this endpoint may apply anything that is not approved.",
    });
  });

  app.get("/v1/copilot/proposals", async (req) => {
    const rows = req.authCtx.isAdmin
      ? await db.select().from(copilotProposals).orderBy(desc(copilotProposals.createdAt)).limit(200)
      : await db
          .select()
          .from(copilotProposals)
          .where(eq(copilotProposals.proposedByUserId, req.authCtx.userId ?? ZERO_UUID))
          .orderBy(desc(copilotProposals.createdAt))
          .limit(200);
    return {
      proposals: rows,
      note:
        "A proposal is a diff plus its evidence. Recording one applies nothing — it opens an " +
        "Approvals-Queue item, and applying the diff is a governed act by the approver.",
    };
  });
}
