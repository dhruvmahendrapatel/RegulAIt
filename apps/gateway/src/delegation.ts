/**
 * ADR-0188 (batch 6 item 1) slice S3 — DELEGATION GRANTS: the unit of
 * authority, created, checked, charged, released and revoked in one module.
 *
 *  - CREATION REFUSES OVER-SCOPE (decisions 4, 16; OWNER DECISION 9). A grant
 *    is created exactly as asked or not at all: its scope must lie inside the
 *    parent's scope (`delegation-scope`), the actor's OWN grants
 *    (`actor-allow-list`, under `own_grants`), the sponsor's grants
 *    (`delegation-scope`, code `sponsor_not_entitled`) and the lead ceiling
 *    when one is given (`lead-ceiling`); its lifetime inside the parent's; its
 *    depth within `delegation_max_depth` (`delegation-depth`); its cap within
 *    the parent's remaining (`delegation-budget`). Nothing is narrowed.
 *  - BUDGETS LIVE ON EDGES (decision 22). Admitting a child locks ONLY its
 *    parent, checks `Remaining(P) = cap − settled − reserved`, inserts the
 *    child and the parent→child allocation and adds the child's cap to
 *    `P.reserved`; no other ancestor changes. The idempotency key makes a
 *    retried (lost-reply) request return the same child and edge.
 *  - SETTLEMENT (decision 22) runs in the usage row's transaction, locks the
 *    path root first, records the charge once per usage row, and turns
 *    reserved into settled once per edge; the excess of a first crossing lands
 *    as settled with nothing reserved behind it.
 *  - RELEASE / REVOCATION (decisions 4, 22): revoking a grant revokes every
 *    grant whose `path` contains it in one statement (GIN index), then closes
 *    the subtree's open edges leaves first, returning only the unspent part,
 *    to the parent only. A sweep closes edges of expired grants. Idempotent.
 *  - THE LIVE CHAIN (decision 17): `loadLiveChain` is one fresh query, never a
 *    cache, over every grant on the STORED path (never a caller-supplied
 *    chain): each grant unrevoked, unexpired and consistent with its parent
 *    row; each actor identity active, its subject in service and not halted,
 *    the grant's environment one the identity allows, its credentials
 *    unrevoked; the sponsor not disabled; the org not halted. Each actor's
 *    own grants are read at the same moment (`loadActorEntitlements`).
 *    `governedActorFor` hands the kernel exactly that (decision 29).
 *
 * The decision 23 authorization check (a parent authorising one specific
 * child and body) is in `delegated-token.ts`, beside the verifier it uses.
 *
 * Open source first (ADR-0176): there is no library for RFC 9396-scoped,
 * edge-allocated delegation budgets; this is RegulAIt's own policy semantics
 * (CLAUDE.md rule 4). The scope algebra is the kernel's (`scopeSubset`).
 */
import { randomUUID } from "node:crypto";
import {
  agentGrants,
  agentRevocations,
  agents,
  and,
  asc,
  auditLog,
  builderAgents,
  connectorGrants,
  connectorRevocations,
  delegationAllocations,
  delegationCharges,
  delegationGrants,
  desc,
  engineRunners,
  eq,
  inArray,
  isNull,
  or,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  serverGrants,
  sql,
  toolGrants,
  users,
  workloadCredentials,
  workloadIdentities,
  type Db,
  type DelegationAllocationRow,
  type SQL,
  type DelegationGrantRow,
} from "@regulait/db";
import {
  scopeSubset,
  type ActorChain,
  type ActorEntitlements,
  type ActorIdentityKind,
  type ActorLinkFacts,
  type DelegationScope,
  type GovernedActor,
  type ScopeCall,
} from "@regulait/policy-kernel";
import {
  delegationScopeSchema,
  DELEGATION_DEPTH_CEILING,
  SHA256_B64URL_PATTERN,
  type DelegationRevokeReason,
  type DelegationRuleId,
} from "@regulait/shared";
import { loadActorEntitlements } from "./actor-entitlements.js";
import { loadOrgSettings } from "./org-settings.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why a delegation was refused: the kernel's rule id (decision 3, 28) plus a
 * short machine CODE. Never secret material; the detail names ids only.
 */
export class DelegationRefusedError extends Error {
  constructor(
    readonly ruleId: DelegationRuleId | "delegation-request-invalid" | "delegation-idempotency-conflict",
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "DelegationRefusedError";
  }
}
const refuse = (ruleId: DelegationRefusedError["ruleId"], code: string, detail: string): never => {
  throw new DelegationRefusedError(ruleId, code, detail);
};

// ---------------------------------------------------------------------------
// The live chain (decision 17)
// ---------------------------------------------------------------------------

/** why a link is not live: a short CODE for reason prose and refusals */
export type LiveFailureCode =
  | "grant_revoked"
  | "grant_expired"
  | "chain_inconsistent"
  | "identity_suspended"
  | "identity_revoked"
  | "subject_not_in_service"
  | "agent_halted"
  | "environment_not_allowed"
  | "credential_revoked"
  | "credential_not_live"
  | "sponsor_disabled"
  | "org_halted";

// ---------------------------------------------------------------------------
// The clock and the shared liveness predicates (PR #279 review, rounds 3-4)
// ---------------------------------------------------------------------------

/**
 * THE clock of every S3 decision: the database's `now()`. Every timestamp S3
 * writes to, or compares with, a database row (grant creation and expiry,
 * credential windows, revocation, token issue and expiry, key lifecycle,
 * DPoP freshness and nonce slots) is taken from here unless a caller passes
 * an explicit `now` (tests). One replica's clock running ahead or behind then
 * changes nothing. Inside a transaction this is that transaction's `now()`.
 */
export async function databaseNow(db: DbOrTx): Promise<Date> {
  const r = await db.execute<{ ms: number | string }>(sql`select (extract(epoch from now()) * 1000)::float8 as ms`);
  return new Date(Number(r.rows[0]!.ms));
}

/** the facts about an identity and its subject that decide whether it is in service */
export interface IdentityServiceFacts {
  kind: string;
  status: string;
  environments: readonly string[];
  agentHaltedAt: Date | null;
  agentLifecycle: string | null;
  agentEnabled: boolean | null;
  builderArchivedAt: Date | null;
  runnerRevokedAt: Date | null;
}

/**
 * ONE predicate for "is this identity in service in `environment`", used by
 * the live chain (governed use, minting, verification, admission's parent
 * check) and by creation/admission of a new link, so the two can never drift:
 * active (not suspended or revoked); not halted (ADR-0124); its subject in
 * service — an agent enabled in the registry and not suspended or retired (a
 * missing agent row is not in service), a builder agent not archived, an
 * engine runner not revoked; and allowed in the environment.
 */
export function identityServiceFailure(
  f: IdentityServiceFacts,
  environment: string,
): "identity_revoked" | "identity_suspended" | "agent_halted" | "subject_not_in_service" | "environment_not_allowed" | null {
  if (f.status === "revoked") return "identity_revoked";
  if (f.status !== "active") return "identity_suspended";
  if (f.agentHaltedAt) return "agent_halted";
  if (
    (f.kind === "agent" && (f.agentEnabled !== true || f.agentLifecycle === "suspended" || f.agentLifecycle === "retired")) ||
    (f.kind === "builder_agent" && f.builderArchivedAt) ||
    (f.kind === "engine_runner" && f.runnerRevokedAt)
  ) {
    return "subject_not_in_service";
  }
  if (!f.environments.includes(environment)) return "environment_not_allowed";
  return null;
}

/** a workload credential row's lifecycle facts */
export interface CredentialFacts {
  identityId: string;
  revokedAt: Date | null;
  notBefore: Date;
  notAfter: Date;
}

/**
 * ONE predicate for "is this credential live for `identityId` at `now`":
 * it exists, belongs to that identity, is not revoked, and `now` is inside
 * [not_before, not_after). Used for a grant's authenticating credential and a
 * child's subject credential, at creation, admission and every use.
 */
export function credentialLiveAt(c: CredentialFacts | null | undefined, identityId: string | null, now: Date): boolean {
  return (
    !!c &&
    (identityId === null || c.identityId === identityId) &&
    c.revokedAt === null &&
    c.notBefore.getTime() <= now.getTime() &&
    c.notAfter.getTime() > now.getTime()
  );
}

export interface LiveLink {
  grant: DelegationGrantRow;
  identity: { id: string; kind: ActorIdentityKind; identifier: string; status: string; environments: string[] };
  live: boolean;
  liveFailure: LiveFailureCode | null;
}

export interface LiveChain {
  /** root first, leaf last (decision 25) */
  links: LiveLink[];
  leaf: DelegationGrantRow;
  /** the first failure on the path, root first; null = every link live */
  failure: { index: number; code: LiveFailureCode } | null;
  chain: ActorChain;
}

/** remaining = cap − settled − reserved (decision 22); null = uncapped */
export function remainingMicros(g: Pick<DelegationGrantRow, "capMicros" | "settledMicros" | "reservedMicros">): number | null {
  return g.capMicros === null ? null : g.capMicros - g.settledMicros - g.reservedMicros;
}

const sameArray = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * THE decision 17 query: one fresh statement over every grant on the stored
 * path of `leafGrantId` (the leaf included), joined to each actor identity, its
 * subject, the grant's authenticating credential and the sponsor. The path is
 * read from the leaf row, never from a caller. Returns null when the leaf does
 * not exist. Liveness is judged here; nothing is cached.
 */
export async function loadLiveChain(db: DbOrTx, leafGrantId: string, nowIn?: Date): Promise<LiveChain | null> {
  const now = nowIn ?? (await databaseNow(db));
  const at = sql`${now.toISOString()}::timestamptz`;
  const rows = await db
    .select({
      grant: delegationGrants,
      identity: {
        id: workloadIdentities.id,
        kind: workloadIdentities.kind,
        identifier: workloadIdentities.identifier,
        status: workloadIdentities.status,
        environments: workloadIdentities.environments,
      },
      agentHaltedAt: agents.haltedAt,
      agentLifecycle: agents.lifecycleStatus,
      agentEnabled: agents.enabled,
      builderArchivedAt: builderAgents.archivedAt,
      runnerRevokedAt: engineRunners.revokedAt,
      sponsorDisabledAt: users.disabledAt,
      authCredential: {
        id: workloadCredentials.id,
        identityId: workloadCredentials.identityId,
        revokedAt: workloadCredentials.revokedAt,
        notBefore: workloadCredentials.notBefore,
        notAfter: workloadCredentials.notAfter,
      },
      // the subject credential (decision 12): a workload credential that is revoked or outside its window
      subjectCredentialRevoked: sql<boolean>`EXISTS (SELECT 1 FROM ${workloadCredentials} sc WHERE sc.id = ${delegationGrants.subjectCredentialId} AND sc.revoked_at IS NOT NULL)`,
      subjectCredentialOutsideWindow: sql<boolean>`EXISTS (SELECT 1 FROM ${workloadCredentials} sc WHERE sc.id = ${delegationGrants.subjectCredentialId} AND sc.revoked_at IS NULL AND (sc.not_before > ${at} OR sc.not_after <= ${at}))`,
    })
    .from(delegationGrants)
    .innerJoin(workloadIdentities, eq(workloadIdentities.id, delegationGrants.actorIdentityId))
    .innerJoin(users, eq(users.id, delegationGrants.sponsorUserId))
    .leftJoin(agents, eq(agents.id, workloadIdentities.agentId))
    .leftJoin(builderAgents, eq(builderAgents.id, workloadIdentities.builderAgentId))
    .leftJoin(engineRunners, eq(engineRunners.id, workloadIdentities.engineRunnerId))
    .leftJoin(workloadCredentials, eq(workloadCredentials.id, delegationGrants.authCredentialId))
    .where(
      sql`${delegationGrants.id} IN (SELECT unnest(g2.path || g2.id) FROM ${delegationGrants} g2 WHERE g2.id = ${leafGrantId})`,
    )
    .orderBy(asc(delegationGrants.depth));
  const leafRow = rows.find((r) => r.grant.id === leafGrantId);
  if (!leafRow) return null;
  const leaf = leafRow.grant;
  const org = await loadOrgSettings(db as Db);

  const links: LiveLink[] = [];
  let failure: LiveChain["failure"] = null;
  // the stored path must be exactly reconstructed: one row per depth 0..leaf.depth, leaf last
  const complete = rows.length === leaf.depth + 1 && rows[rows.length - 1]!.grant.id === leaf.id;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const g = r.grant;
    let code: LiveFailureCode | null = null;
    // the chain itself: consistent with its parent row (decision 17)
    const parent = i > 0 ? rows[i - 1]!.grant : null;
    const consistent =
      complete &&
      g.depth === i &&
      g.depth <= g.depthLimit &&
      (parent === null
        ? g.parentGrantId === null && g.rootGrantId === g.id && g.path.length === 0
        : g.parentGrantId === parent.id &&
          g.rootGrantId === parent.rootGrantId &&
          sameArray(g.path, [...parent.path, parent.id]) &&
          g.sponsorUserId === parent.sponsorUserId &&
          g.projectId === parent.projectId &&
          g.environment === parent.environment &&
          g.runId === parent.runId &&
          g.builderTurnId === parent.builderTurnId &&
          g.engineRunId === parent.engineRunId &&
          g.scheduleId === parent.scheduleId &&
          g.depthLimit <= parent.depthLimit &&
          g.expiresAt.getTime() <= parent.expiresAt.getTime());
    const authCred = r.authCredential?.id ? r.authCredential : null;
    const serviceFailure = identityServiceFailure(
      { ...r.identity, agentHaltedAt: r.agentHaltedAt, agentLifecycle: r.agentLifecycle, agentEnabled: r.agentEnabled, builderArchivedAt: r.builderArchivedAt, runnerRevokedAt: r.runnerRevokedAt },
      g.environment,
    );
    if (!consistent) code = "chain_inconsistent";
    else if (g.revokedAt) code = "grant_revoked";
    else if (g.expiresAt.getTime() <= now.getTime()) code = "grant_expired";
    else if (serviceFailure) code = serviceFailure;
    else if ((g.authCredentialId !== null && authCred?.revokedAt) || r.subjectCredentialRevoked === true) code = "credential_revoked";
    // the full credential predicate: this identity's, unrevoked, and inside its [not_before, not_after) window
    else if ((g.authCredentialId !== null && !credentialLiveAt(authCred, r.identity.id, now)) || r.subjectCredentialOutsideWindow === true) {
      code = "credential_not_live";
    } else if (r.sponsorDisabledAt) code = "sponsor_disabled";
    else if (org.executionMode === "halted") code = "org_halted";
    if (code && !failure) failure = { index: i, code };
    links.push({
      grant: g,
      identity: { ...r.identity, kind: r.identity.kind as ActorIdentityKind, environments: [...r.identity.environments] },
      live: code === null,
      liveFailure: code,
    });
  }
  if (!complete && !failure) failure = { index: 0, code: "chain_inconsistent" };
  const chain: ActorChain = {
    sponsorUserId: leaf.sponsorUserId,
    delegationGrantId: leaf.id,
    depth: links.length,
    actors: links.map((l) => ({ identityId: l.identity.id, kind: l.identity.kind, identifier: l.identity.identifier })),
  };
  return { links, leaf, failure, chain };
}

/**
 * The kernel's `actor` input for a call made under `leafGrantId` (decisions
 * 17, 29): the stored chain, read now, with each actor's own grants read now.
 * Null when the grant does not exist (the caller refuses). A link that is not
 * live is handed over as such and the kernel refuses `actor-chain-invalid`.
 * `abacDecision` is left for the gateway's Cedar wiring (decision 36).
 */
export async function governedActorFor(
  db: Db,
  leafGrantId: string,
  opts: { costKnown: boolean; now?: Date },
): Promise<{ actor: GovernedActor; live: LiveChain } | null> {
  const live = await loadLiveChain(db, leafGrantId, opts.now);
  if (!live) return null;
  const [entitlements, org] = await Promise.all([
    loadActorEntitlements(db, live.links.map((l) => l.identity.id)),
    loadOrgSettings(db),
  ]);
  const links: ActorLinkFacts[] = live.links.map((l) => {
    const rem = remainingMicros(l.grant);
    return {
      identityId: l.identity.id,
      grantId: l.grant.id,
      live: l.live,
      liveFailure: l.liveFailure,
      scope: l.grant.scope,
      budget: rem === null ? null : { remainingMicros: rem },
      entitlements: entitlements.get(l.identity.id)!,
    };
  });
  return {
    actor: {
      chain: live.chain,
      entitlementMode: org.agentEntitlementMode,
      maxDepth: org.delegationMaxDepth,
      costKnown: opts.costKnown,
      links,
    },
    live,
  };
}

// ---------------------------------------------------------------------------
// Scope against grants (creation-time; the use-time check is the kernel's)
// ---------------------------------------------------------------------------

/** the atomic calls a scope covers (the unit `scopeSubset` compares; decision 32) */
export function scopeAtoms(scope: DelegationScope): ScopeCall[] {
  const out: ScopeCall[] = [];
  for (const item of scope) {
    if (item.type === "mcp_tool" && item.serverId) {
      for (const toolName of item.toolNames ?? []) out.push({ type: "mcp_tool", serverId: item.serverId, toolName, kind: item.kind });
    } else if (item.type === "connector" && item.connectorId) {
      out.push({ type: "connector", connectorId: item.connectorId, kind: item.kind });
    } else if (item.type === "agent" && item.agentId) {
      for (const mode of item.modes ?? []) out.push({ type: "agent", agentId: item.agentId, mode, kind: item.kind });
    }
  }
  return out;
}

const atomLabel = (a: ScopeCall) =>
  a.type === "mcp_tool" ? `tool ${a.serverId}/${a.toolName} (${a.kind})` : a.type === "agent" ? `agent ${a.agentId} mode ${a.mode} (${a.kind})` : `connector ${a.connectorId} (${a.kind})`;

/**
 * Does an actor's OWN entitlement set (decision 24) reach this atom? The same
 * grant shapes the kernel's `actor-allow-list` term reads (decision 35). A
 * connector atom names no object, so it needs a grant for the connector with
 * the right mode that lists at least one object; the per-object check stays
 * the kernel's at use.
 */
export function actorEntitlementsReach(e: ActorEntitlements, a: ScopeCall): boolean {
  switch (a.type) {
    case "mcp_tool":
      return (
        e.tools.some((g) => g.serverId === a.serverId && g.toolName === a.toolName) ||
        (a.kind === "read" && e.servers.some((g) => g.serverId === a.serverId && g.readOnlyAll))
      );
    case "agent":
      return e.agents.some((g) => g.agentId === a.agentId && g.allowedModes.includes(a.mode));
    case "connector":
      return e.connectors.some(
        (g) => g.connectorId === a.connectorId && (a.kind === "read" || g.mode === "readwrite") && g.allowedObjects.length > 0,
      );
  }
}

/**
 * Do the SPONSOR's grants (direct and role-derived) reach every atom? A
 * GRANT-level check, conservative by construction: any revocation of the
 * person's on that tool, server, agent or connector refuses the atom. The
 * person's full evaluation (rules, approvals, ABAC) still runs at every use
 * (decision 17); this only refuses a delegation of what the person was never
 * granted. Returns the first atom not reached, or null.
 */
export async function sponsorGrantsMiss(db: DbOrTx, userId: string, atoms: readonly ScopeCall[]): Promise<ScopeCall | null> {
  if (atoms.length === 0) return null;
  const roleIds = [
    ...new Set((await db.select({ roleId: roleAssignments.roleId }).from(roleAssignments).where(eq(roleAssignments.userId, userId))).map((r) => r.roleId)),
  ];
  const byRole = roleIds.length > 0;
  const [tg, sg, ag, cg, rtg, rsg, rag, rcg, rev, arev, crev] = await Promise.all([
    db.select().from(toolGrants).where(eq(toolGrants.userId, userId)),
    db.select().from(serverGrants).where(eq(serverGrants.userId, userId)),
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    db.select().from(connectorGrants).where(eq(connectorGrants.userId, userId)),
    byRole ? db.select().from(roleToolGrants).where(inArray(roleToolGrants.roleId, roleIds)) : Promise.resolve([]),
    byRole ? db.select().from(roleServerGrants).where(inArray(roleServerGrants.roleId, roleIds)) : Promise.resolve([]),
    byRole ? db.select().from(roleAgentGrants).where(inArray(roleAgentGrants.roleId, roleIds)) : Promise.resolve([]),
    byRole ? db.select().from(roleConnectorGrants).where(inArray(roleConnectorGrants.roleId, roleIds)) : Promise.resolve([]),
    db.select().from(revocations).where(eq(revocations.userId, userId)),
    db.select().from(agentRevocations).where(eq(agentRevocations.userId, userId)),
    db.select().from(connectorRevocations).where(eq(connectorRevocations.userId, userId)),
  ]);
  const modesAllow = (m: unknown, mode: string) => m === null || m === undefined || (Array.isArray(m) && m.includes(mode));
  for (const a of atoms) {
    let ok = false;
    if (a.type === "mcp_tool") {
      const revoked = rev.some((r) => r.serverId === a.serverId && (r.toolName === null || r.toolName === a.toolName));
      ok =
        !revoked &&
        ([...tg, ...rtg].some((g) => g.serverId === a.serverId && g.toolName === a.toolName) ||
          (a.kind === "read" && [...sg, ...rsg].some((g) => g.serverId === a.serverId && g.readOnlyAll)));
    } else if (a.type === "agent") {
      ok = !arev.some((r) => r.agentId === a.agentId) && [...ag, ...rag].some((g) => g.agentId === a.agentId && modesAllow(g.allowedModes, a.mode));
    } else {
      ok =
        !crev.some((r) => r.connectorId === a.connectorId) &&
        [...cg, ...rcg].some((g) => g.connectorId === a.connectorId && (a.kind === "read" || g.mode === "readwrite"));
    }
    if (!ok) return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Creation (decisions 4, 12, 16, 22)
// ---------------------------------------------------------------------------

/** how the grant's tokens are bound (decision 12); `in_process` mints none (decision 6) */
export type GrantBinding =
  | { kind: "in_process" }
  | { kind: "dpop" | "mtls"; thumbprint: string; authCredentialId: string; audience: string };

/** the run context a root is made for (at most one) */
export interface GrantContext {
  runId?: string | null;
  builderTurnId?: string | null;
  engineRunId?: string | null;
  scheduleId?: string | null;
}

interface CommonGrantInput {
  actorIdentityId: string;
  scope: DelegationScope;
  /** integer micro-dollars; null = uncapped */
  capMicros: number | null;
  expiresAt: Date;
  binding: GrantBinding;
  /** decision 12: the credential behind the parent's proof (child) or the human delegation proof's id (root) */
  subjectCredentialId?: string | null;
  /** the lead ceiling (orchestration §5.1) when the hand-off has one; the scope must lie inside it */
  ceiling?: DelegationScope | null;
  now?: Date;
}
export interface CreateRootGrantInput extends CommonGrantInput {
  sponsorUserId: string;
  /**
   * decision 23 `max_depth` for a root: how many delegations may follow it. Absent = the org's
   * `delegation_max_depth`; more than that is refused. Stored as the absolute `depth_limit` (migration 0184).
   */
  maxFurtherDepth?: number;
  environment: string;
  projectId: string | null;
  context?: GrantContext;
}
export interface AdmitChildGrantInput extends CommonGrantInput {
  parentGrantId: string;
  /** decision 22: a retried request with the same key returns the same child and edge */
  idempotencyKey: string;
  /**
   * decision 23 `max_depth`: how many further delegations the child may make.
   * STORED (migration 0184) as the absolute `depth_limit = min(parent.depth_limit,
   * child.depth + max_depth)`, so every descendant is bound by it, not only this
   * admission. A value past the parent's limit or the org setting is refused,
   * never narrowed. Absent = inherit the parent's limit.
   */
  maxFurtherDepth?: number;
  /**
   * What the request ASKS for (decision 23's signed body `env` / `project_id`). A child inherits both
   * from its parent and can never change them, so a request naming anything else is refused
   * `delegation_body_mismatch` — never silently replaced with the parent's values.
   */
  environment: string;
  projectId: string | null;
}

function validateCommon(input: CommonGrantInput, now: Date): void {
  const parsed = delegationScopeSchema.min(1).safeParse(input.scope);
  if (!parsed.success) refuse("delegation-request-invalid", "scope_invalid", "the delegation scope is not a valid, non-empty scope list");
  if (input.capMicros !== null && (!Number.isSafeInteger(input.capMicros) || input.capMicros < 0)) {
    refuse("delegation-request-invalid", "cap_invalid", "a cap is a non-negative integer of micro-dollars, or null");
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime()) || input.expiresAt.getTime() <= now.getTime()) {
    refuse("delegation-request-invalid", "lifetime_invalid", "a grant expires in the future");
  }
  if (input.binding.kind !== "in_process") {
    if (!SHA256_B64URL_PATTERN.test(input.binding.thumbprint)) refuse("delegation-request-invalid", "binding_invalid", "a binding thumbprint is a SHA-256 base64url value");
    if (!input.binding.audience || input.binding.audience.length > 2048) refuse("delegation-request-invalid", "audience_invalid", "an external grant names one audience");
  }
}

/**
 * The first atom of `atoms` that some identity's CURRENT own grants do not
 * reach (I7), or null. Applies only under `own_grants`, the mode in which the
 * kernel checks every link's own grants at use (`actor-allow-list`), so
 * creation, admission and use apply one rule.
 */
async function ownGrantsMiss(db: DbOrTx, identityIds: readonly string[], atoms: readonly ScopeCall[]): Promise<{ identityId: string; atom: ScopeCall } | null> {
  const org = await loadOrgSettings(db as Db);
  if (org.agentEntitlementMode !== "own_grants" || identityIds.length === 0) return null;
  const ents = await loadActorEntitlements(db as Db, [...identityIds]);
  for (const id of identityIds) {
    const own = ents.get(id)!;
    const miss = atoms.find((a) => !actorEntitlementsReach(own, a));
    if (miss) return { identityId: id, atom: miss };
  }
  return null;
}

/**
 * Everything a grant's actor, sponsor and binding must satisfy at creation,
 * whether root or child — the SAME predicates the live chain applies at use
 * (`identityServiceFailure`, `credentialLiveAt`, sponsor, org halt): the actor
 * active and in service in this environment, the authenticating credential
 * this identity's and live, the sponsor not disabled, the organisation not
 * halted, and the scope inside the actor's own grants (under `own_grants`),
 * the sponsor's grants and the ceiling. `now` is the database clock.
 */
async function checkActorSponsorScope(
  db: DbOrTx,
  input: CommonGrantInput & { sponsorUserId: string; environment: string },
  now: Date,
): Promise<void> {
  const [idRow] = await db
    .select({
      identity: workloadIdentities,
      agentHaltedAt: agents.haltedAt,
      agentLifecycle: agents.lifecycleStatus,
      agentEnabled: agents.enabled,
      builderArchivedAt: builderAgents.archivedAt,
      runnerRevokedAt: engineRunners.revokedAt,
    })
    .from(workloadIdentities)
    .leftJoin(agents, eq(agents.id, workloadIdentities.agentId))
    .leftJoin(builderAgents, eq(builderAgents.id, workloadIdentities.builderAgentId))
    .leftJoin(engineRunners, eq(engineRunners.id, workloadIdentities.engineRunnerId))
    .where(eq(workloadIdentities.id, input.actorIdentityId));
  if (!idRow) return refuse("actor-chain-invalid", "identity_not_found", `no workload identity ${input.actorIdentityId}`);
  const ident = idRow.identity;
  const serviceFailure = identityServiceFailure({ ...ident, ...idRow }, input.environment);
  if (serviceFailure) {
    refuse(
      "actor-chain-invalid",
      serviceFailure,
      serviceFailure === "environment_not_allowed"
        ? `identity ${ident.id} is not allowed in environment '${input.environment}'`
        : serviceFailure === "identity_revoked" || serviceFailure === "identity_suspended"
          ? `identity ${ident.id} is ${ident.status}`
          : `the subject of identity ${ident.id} is not in service`,
    );
  }
  if (input.binding.kind !== "in_process") {
    const [cred] = await db.select().from(workloadCredentials).where(eq(workloadCredentials.id, input.binding.authCredentialId));
    if (!credentialLiveAt(cred, ident.id, now)) {
      refuse("actor-chain-invalid", "credential_not_live", "the authenticating credential is not a live credential of this identity");
    }
  }
  const [sponsor] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, input.sponsorUserId));
  if (!sponsor) refuse("actor-chain-invalid", "sponsor_not_found", "a delegation needs a sponsor (decision 10: never without one)");
  if (sponsor!.disabledAt) refuse("actor-chain-invalid", "sponsor_disabled", "the sponsor is disabled");
  const org = await loadOrgSettings(db as Db);
  if (org.executionMode === "halted") refuse("actor-chain-invalid", "org_halted", "the organisation's execution is halted");

  const atoms = scopeAtoms(input.scope);
  const own = await ownGrantsMiss(db, [ident.id], atoms);
  if (own) refuse("actor-allow-list", "actor_not_entitled", `identity ${ident.id}'s own grants do not cover ${atomLabel(own.atom)}`);
  const sponsorMiss = await sponsorGrantsMiss(db, input.sponsorUserId, atoms);
  if (sponsorMiss) refuse("delegation-scope", "sponsor_not_entitled", `the sponsor is not granted ${atomLabel(sponsorMiss)}`);
  if (input.ceiling && !scopeSubset(input.scope, input.ceiling)) {
    refuse("lead-ceiling", "outside_ceiling", "the requested scope is wider than the lead's ceiling");
  }
}

function bindingColumns(b: GrantBinding) {
  return b.kind === "in_process"
    ? { bindingKind: "in_process" as const, bindingThumbprint: null, authCredentialId: null, audience: null }
    : { bindingKind: b.kind, bindingThumbprint: b.thumbprint, authCredentialId: b.authCredentialId, audience: b.audience };
}

/**
 * A ROOT grant: a person delegates to a first agent (in-process for a run,
 * builder turn, schedule or engine run, decision 6; or external from a
 * human delegation proof, decision 15). Refuses over-scope; never narrows.
 */
export async function createRootGrant(db: Db, input: CreateRootGrantInput): Promise<DelegationGrantRow> {
  const ctx = input.context ?? {};
  if ([ctx.runId, ctx.builderTurnId, ctx.engineRunId, ctx.scheduleId].filter((v) => v != null).length > 1) {
    refuse("delegation-request-invalid", "context_invalid", "a grant is made for at most one run context");
  }
  return db.transaction(async (tx) => {
    // the database clock: `created_at` and every window below are judged by it (a test may pin `now`)
    const now = input.now ?? (await databaseNow(tx));
    validateCommon(input, now);
    await checkActorSponsorScope(tx, input, now);
    const org = await loadOrgSettings(tx as unknown as Db);
    let depthLimit = Math.min(org.delegationMaxDepth, DELEGATION_DEPTH_CEILING);
    if (input.maxFurtherDepth !== undefined) {
      if (!Number.isInteger(input.maxFurtherDepth) || input.maxFurtherDepth < 0 || input.maxFurtherDepth > depthLimit) {
        refuse("delegation-depth", "delegation_depth", `a root may allow at most ${depthLimit} further delegations`);
      }
      depthLimit = input.maxFurtherDepth;
    }
    const id = randomUUID();
    const [row] = await tx
      .insert(delegationGrants)
      .values({
        id,
        rootGrantId: id,
        parentGrantId: null,
        path: [],
        depth: 0,
        depthLimit,
        sponsorUserId: input.sponsorUserId,
        actorIdentityId: input.actorIdentityId,
        runId: ctx.runId ?? null,
        builderTurnId: ctx.builderTurnId ?? null,
        engineRunId: ctx.engineRunId ?? null,
        scheduleId: ctx.scheduleId ?? null,
        projectId: input.projectId,
        scope: input.scope as DelegationGrantRow["scope"],
        capMicros: input.capMicros,
        environment: input.environment,
        subjectCredentialId: input.subjectCredentialId ?? null,
        expiresAt: input.expiresAt,
        createdAt: now,
        ...bindingColumns(input.binding),
      })
      .returning();
    await auditGrantCreated(tx, row!, "create");
    return row!;
  });
}

/**
 * The audit row of a grant's creation or admission, in the creating transaction. Ids, depth, cap and
 * binding KIND only: no thumbprint, credential material or token. The actor fields of `audit_log` stay
 * empty until the audit v2 cutover (decision 19, S4); the chain is in `detail`.
 */
async function auditGrantCreated(tx: Tx, g: DelegationGrantRow, phase: "create" | "admit"): Promise<void> {
  await tx.insert(auditLog).values({
    userId: g.sponsorUserId,
    objectType: "delegation_grant",
    objectId: g.id,
    detail: {
      phase,
      grantId: g.id,
      rootGrantId: g.rootGrantId,
      parentGrantId: g.parentGrantId,
      path: g.path,
      depth: g.depth,
      depthLimit: g.depthLimit,
      actorIdentityId: g.actorIdentityId,
      projectId: g.projectId,
      environment: g.environment,
      capMicros: g.capMicros,
      bindingKind: g.bindingKind,
      expiresAt: g.expiresAt.toISOString(),
    },
    effect: "allow",
    ruleId: phase === "create" ? "delegation-create" : "delegation-admit",
    ruleChain: [],
    reason: phase === "create" ? "root delegation grant created (ADR-0188 decision 4)" : "child delegation grant admitted under its parent (ADR-0188 decision 22)",
  });
}

/** does a stored child answer this (retried) request exactly? */
function sameChildRequest(child: DelegationGrantRow, input: AdmitChildGrantInput): boolean {
  const b = bindingColumns(input.binding);
  // a uuid compares case-insensitively; absent and null are the same "no subject credential"
  const subjectCredential = input.subjectCredentialId ? input.subjectCredentialId.toLowerCase() : null;
  return (
    child.actorIdentityId === input.actorIdentityId &&
    (input.maxFurtherDepth === undefined || child.depthLimit === child.depth + input.maxFurtherDepth) &&
    (child.subjectCredentialId?.toLowerCase() ?? null) === subjectCredential &&
    // the same authority (jsonb does not keep key order, so compare meaning, both ways)
    scopeSubset(child.scope, input.scope) &&
    scopeSubset(input.scope, child.scope) &&
    child.capMicros === input.capMicros &&
    child.expiresAt.getTime() === input.expiresAt.getTime() &&
    child.bindingKind === b.bindingKind &&
    child.bindingThumbprint === b.bindingThumbprint &&
    child.authCredentialId === b.authCredentialId &&
    child.audience === b.audience
  );
}

/**
 * ADMIT A CHILD under `parentGrantId` (decision 22), one transaction: lock
 * the parent, return the existing child for a repeated idempotency key (or
 * refuse a different request under the same key), run the decision 17 check
 * on the parent's chain, refuse anything over scope, depth, lifetime or
 * budget, then insert the child and its edge and add the cap to
 * `parent.reserved`. No ancestor above the parent changes.
 */
export async function admitChildGrant(
  db: Db,
  input: AdmitChildGrantInput,
): Promise<{ grant: DelegationGrantRow; allocation: DelegationAllocationRow; replayed: boolean }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    refuse("delegation-request-invalid", "idempotency_key_invalid", "an idempotency key is 1 to 200 characters");
  }
  return db.transaction(async (tx) => {
    const now = input.now ?? (await databaseNow(tx));
    validateCommon(input, now);
    const [parent] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, input.parentGrantId)).for("update");
    if (!parent) return refuse("actor-chain-invalid", "parent_not_found", `no delegation grant ${input.parentGrantId}`);
    if (input.environment !== parent.environment || input.projectId !== parent.projectId) {
      refuse("delegation-request-invalid", "delegation_body_mismatch", "the requested environment or project is not the parent's (a child inherits both)");
    }

    // a retried request (lost reply) returns the same child and edge, never a second allocation
    const [edge] = await tx
      .select()
      .from(delegationAllocations)
      .where(and(eq(delegationAllocations.parentGrantId, parent.id), eq(delegationAllocations.idempotencyKey, input.idempotencyKey)));
    if (edge) {
      const [child] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, edge.childGrantId));
      if (!child || !sameChildRequest(child, input)) {
        return refuse("delegation-idempotency-conflict", "idempotency_key_reused", "this idempotency key was used for a different delegation request");
      }
      return { grant: child, allocation: edge, replayed: true };
    }

    // decision 17 on the parent's whole stored chain, read now
    const live = await loadLiveChain(tx, parent.id, now);
    if (!live || live.failure) {
      return refuse("actor-chain-invalid", live?.failure?.code ?? "chain_inconsistent", "the parent's delegation chain is not live");
    }
    if (live.links.some((l) => l.identity.id === input.actorIdentityId)) {
      refuse("actor-chain-invalid", "identity_in_chain", "an identity appears at most once in a chain");
    }
    // every EXISTING link's current own grants must still cover what the child is given: the kernel refuses
    // any call one of them does not cover (actor-allow-list), so admitting it would reserve budget for authority
    // nobody on the chain still holds (PR #279 review)
    const chainMiss = await ownGrantsMiss(tx, live.links.map((l) => l.identity.id), scopeAtoms(input.scope));
    if (chainMiss) {
      refuse("actor-allow-list", "chain_actor_not_entitled", `identity ${chainMiss.identityId}'s own grants no longer cover ${atomLabel(chainMiss.atom)}`);
    }
    // a child's subject credential is the credential behind the PARENT's proof (decision 12): when named it must
    // be a live credential of the parent's actor, never an arbitrary id the live chain could not judge
    if (input.subjectCredentialId) {
      const [sc] = await tx.select().from(workloadCredentials).where(sql`${workloadCredentials.id}::text = lower(${input.subjectCredentialId})`);
      if (!credentialLiveAt(sc, parent.actorIdentityId, now)) {
        refuse("actor-chain-invalid", "subject_credential_not_live", "the subject credential is not a live credential of the parent's actor");
      }
    }

    const org = await loadOrgSettings(tx as unknown as Db);
    const depth = parent.depth + 1;
    if (depth > org.delegationMaxDepth || depth > DELEGATION_DEPTH_CEILING) {
      refuse("delegation-depth", "delegation_depth", `depth ${depth} is past the delegation limit ${org.delegationMaxDepth}`);
    }
    // the PARENT's stored limit (decision 23 max_depth, migration 0184): a child of a `max_depth: 0` grant is refused
    if (depth > parent.depthLimit) {
      refuse("delegation-depth", "delegation_depth", `depth ${depth} is past the depth its parent was authorised to delegate (${parent.depthLimit})`);
    }
    let depthLimit = Math.min(parent.depthLimit, org.delegationMaxDepth);
    if (input.maxFurtherDepth !== undefined) {
      if (!Number.isInteger(input.maxFurtherDepth) || input.maxFurtherDepth < 0 || depth + input.maxFurtherDepth > depthLimit) {
        refuse("delegation-depth", "delegation_depth", `a child at depth ${depth} may delegate at most ${Math.max(0, depthLimit - depth)} further`);
      }
      depthLimit = depth + input.maxFurtherDepth;
    }
    if (!scopeSubset(input.scope, parent.scope)) {
      refuse("delegation-scope", "outside_parent_scope", "the requested scope is wider than the parent's");
    }
    if (input.expiresAt.getTime() > parent.expiresAt.getTime()) {
      refuse("delegation-scope", "outlives_parent", "a child never outlives its parent");
    }
    const parentRemaining = remainingMicros(parent);
    if (parentRemaining !== null) {
      if (input.capMicros === null) refuse("delegation-budget", "delegation_budget", "a child of a capped grant must carry a cap");
      if (input.capMicros! > parentRemaining) {
        refuse("delegation-budget", "delegation_budget", `the requested cap is more than the parent's remaining budget`);
      }
    }
    await checkActorSponsorScope(tx, { ...input, sponsorUserId: parent.sponsorUserId, environment: parent.environment }, now);

    const id = randomUUID();
    const [grant] = await tx
      .insert(delegationGrants)
      .values({
        id,
        rootGrantId: parent.rootGrantId,
        parentGrantId: parent.id,
        path: [...parent.path, parent.id],
        depth,
        depthLimit,
        sponsorUserId: parent.sponsorUserId,
        actorIdentityId: input.actorIdentityId,
        runId: parent.runId,
        builderTurnId: parent.builderTurnId,
        engineRunId: parent.engineRunId,
        scheduleId: parent.scheduleId,
        projectId: parent.projectId,
        scope: input.scope as DelegationGrantRow["scope"],
        capMicros: input.capMicros,
        environment: parent.environment,
        subjectCredentialId: input.subjectCredentialId ?? null,
        expiresAt: input.expiresAt,
        createdAt: now,
        ...bindingColumns(input.binding),
      })
      .returning();
    // the allocation sits on this one edge; an uncapped parent reserves nothing (its `reserved` stays 0)
    const amount = parent.capMicros === null ? 0 : input.capMicros!;
    const [allocation] = await tx
      .insert(delegationAllocations)
      .values({ parentGrantId: parent.id, childGrantId: id, amountMicros: amount, idempotencyKey: input.idempotencyKey, createdAt: now })
      .returning();
    if (amount > 0) {
      await tx
        .update(delegationGrants)
        .set({ reservedMicros: sql`${delegationGrants.reservedMicros} + ${amount}` })
        .where(eq(delegationGrants.id, parent.id));
    }
    await auditGrantCreated(tx, grant!, "admit");
    return { grant: grant!, allocation: allocation!, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Settlement (decision 22)
// ---------------------------------------------------------------------------

/**
 * SETTLE one usage row's measured cost `amountMicros` along the path of
 * `leafGrantId`. Call it inside the usage row's transaction. Locks the path
 * root first; records the charge once (`delegation_charges`, keyed by the
 * usage row: a retried settlement changes nothing); `leaf.settled += x`; then
 * on every edge P→Q of the path `d = min(x, amount − drawn)` (what is still
 * reserved there), `edge.drawn += x`, `P.reserved −= d`, `P.settled += x`.
 * A closed edge (the child was released) reserves nothing: the cost lands on
 * P as settled. The excess `x − d` of a first crossing does the same.
 */
export async function settleDelegationCharge(
  tx: DbOrTx,
  input: { usageEventId: string; leafGrantId: string; amountMicros: number },
): Promise<{ applied: boolean }> {
  const x = input.amountMicros;
  if (!Number.isSafeInteger(x) || x < 0) throw new RangeError("settleDelegationCharge: a charge is a non-negative integer of micro-dollars");
  const [leaf] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, input.leafGrantId));
  if (!leaf) throw new Error(`settleDelegationCharge: no delegation grant ${input.leafGrantId}`);
  const pathIds = [...leaf.path, leaf.id];
  // lock the whole path in ONE order, root first (by depth), so concurrent settlements serialise without deadlock
  const path = await tx
    .select()
    .from(delegationGrants)
    .where(inArray(delegationGrants.id, pathIds))
    .orderBy(asc(delegationGrants.depth))
    .for("update");
  const inserted = await tx
    .insert(delegationCharges)
    .values({ usageEventId: input.usageEventId, leafGrantId: leaf.id, amountMicros: x })
    .onConflictDoNothing({ target: delegationCharges.usageEventId })
    .returning({ id: delegationCharges.usageEventId });
  if (inserted.length === 0) return { applied: false };
  if (x === 0) return { applied: true };

  await tx
    .update(delegationGrants)
    .set({ settledMicros: sql`${delegationGrants.settledMicros} + ${x}` })
    .where(eq(delegationGrants.id, leaf.id));
  const edges = await tx
    .select()
    .from(delegationAllocations)
    .where(inArray(delegationAllocations.childGrantId, pathIds.slice(1)))
    .for("update");
  for (let i = path.length - 1; i >= 1; i--) {
    const parent = path[i - 1]!;
    const child = path[i]!;
    const edge = edges.find((e) => e.childGrantId === child.id && e.parentGrantId === parent.id);
    let d = 0;
    if (edge && edge.status === "open") {
      d = Math.max(0, Math.min(x, edge.amountMicros - edge.drawnMicros));
      await tx
        .update(delegationAllocations)
        .set({ drawnMicros: sql`${delegationAllocations.drawnMicros} + ${x}` })
        .where(eq(delegationAllocations.id, edge.id));
    }
    await tx
      .update(delegationGrants)
      .set({
        settledMicros: sql`${delegationGrants.settledMicros} + ${x}`,
        reservedMicros: sql`${delegationGrants.reservedMicros} - ${d}`,
      })
      .where(eq(delegationGrants.id, parent.id));
  }
  return { applied: true };
}

// ---------------------------------------------------------------------------
// Release and revocation (decisions 4, 22)
// ---------------------------------------------------------------------------

/**
 * Close one open edge: `released = max(0, amount − drawn)` returns to the
 * PARENT only (`parent.reserved −= released`). Idempotent: a closed edge is
 * left alone (the trigger also refuses a second release).
 */
async function closeEdge(tx: Tx, edgeId: string, closedAt: Date | SQL): Promise<number> {
  const [edge] = await tx.select().from(delegationAllocations).where(eq(delegationAllocations.id, edgeId)).for("update");
  if (!edge || edge.status !== "open") return 0;
  const released = Math.max(0, edge.amountMicros - edge.drawnMicros);
  await tx
    .update(delegationAllocations)
    .set({ status: "closed", releasedMicros: released, closedAt })
    .where(eq(delegationAllocations.id, edge.id));
  if (released > 0) {
    await tx
      .update(delegationGrants)
      .set({ reservedMicros: sql`${delegationGrants.reservedMicros} - ${released}` })
      .where(eq(delegationGrants.id, edge.parentGrantId));
  }
  return released;
}

/**
 * END a grant: revoke it (if it is still live) and every grant whose `path`
 * contains it, in ONE statement over the GIN index (descendants with reason
 * `cascade`), then close the subtree's open edges leaves first and finally
 * its own incoming edge, so only unspent allocation returns, to each parent.
 * Idempotent: an already revoked or expired grant only has its edges closed.
 * Audited (`delegation_grant`).
 */
export async function revokeDelegationGrant(
  db: Db,
  input: { grantId: string; reason: DelegationRevokeReason; actorUserId?: string | null; now?: Date },
): Promise<{ revokedGrantIds: string[]; releasedMicros: number }> {
  return db.transaction(async (tx) => {
    const now = input.now ?? (await databaseNow(tx));
    const at = sql`${now.toISOString()}::timestamptz`;
    const [g] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, input.grantId));
    if (!g) throw new DelegationRefusedError("actor-chain-invalid", "grant_not_found", `no delegation grant ${input.grantId}`);
    // lock the parent and the whole subtree in one order (depth, then id)
    await tx
      .select({ id: delegationGrants.id })
      .from(delegationGrants)
      .where(
        or(
          eq(delegationGrants.id, g.id),
          sql`${delegationGrants.path} @> ARRAY[${g.id}]::uuid[]`,
          g.parentGrantId ? eq(delegationGrants.id, g.parentGrantId) : sql`false`,
        ),
      )
      .orderBy(asc(delegationGrants.depth), asc(delegationGrants.id))
      .for("update");
    // a grant that has already EXPIRED (database clock) ended on its own: it is not stamped revoked, so its
    // record keeps saying how it really ended; only its edges are closed below (PR #279 review)
    const revoked = await tx
      .update(delegationGrants)
      .set({
        revokedAt: now,
        revokedReason: sql`CASE WHEN ${delegationGrants.id} = ${g.id} THEN ${input.reason} ELSE 'cascade' END`,
      })
      .where(
        and(
          or(eq(delegationGrants.id, g.id), sql`${delegationGrants.path} @> ARRAY[${g.id}]::uuid[]`),
          isNull(delegationGrants.revokedAt),
          sql`${delegationGrants.expiresAt} > ${at}`,
        ),
      )
      .returning({ id: delegationGrants.id });
    const alreadyExpired = await tx
      .select({ id: delegationGrants.id })
      .from(delegationGrants)
      .where(
        and(
          or(eq(delegationGrants.id, g.id), sql`${delegationGrants.path} @> ARRAY[${g.id}]::uuid[]`),
          isNull(delegationGrants.revokedAt),
          sql`${delegationGrants.expiresAt} <= ${at}`,
        ),
      );
    // the subtree's open edges, deepest child first, then the grant's own incoming edge
    const open = await tx
      .select({ id: delegationAllocations.id, depth: delegationGrants.depth })
      .from(delegationAllocations)
      .innerJoin(delegationGrants, eq(delegationGrants.id, delegationAllocations.childGrantId))
      .where(
        and(
          eq(delegationAllocations.status, "open"),
          or(eq(delegationGrants.id, g.id), sql`${delegationGrants.path} @> ARRAY[${g.id}]::uuid[]`),
        ),
      )
      .orderBy(desc(delegationGrants.depth), asc(delegationAllocations.id));
    let releasedMicros = 0;
    for (const e of open) releasedMicros += await closeEdge(tx, e.id, now);
    await tx.insert(auditLog).values({
      userId: input.actorUserId ?? SYSTEM_USER_ID,
      objectType: "delegation_grant",
      objectId: g.id,
      detail: {
        phase: "revoke",
        reason: input.reason,
        revokedGrantIds: revoked.map((r) => r.id),
        alreadyExpiredGrantIds: alreadyExpired.map((r) => r.id),
        edgesClosed: open.length,
        releasedMicros,
      },
      effect: "allow",
      ruleId: "delegation-revoke",
      ruleChain: [],
      reason:
        `delegation grant ended (${input.reason}); ${revoked.length} grant(s) revoked including descendants` +
        (alreadyExpired.length > 0 ? `; ${alreadyExpired.length} had already expired and were left unrevoked` : "") +
        "; unspent allocation returned to each parent",
    });
    return { revokedGrantIds: revoked.map((r) => r.id), releasedMicros };
  });
}

/**
 * THE RELEASE SWEEP (decision 22): close every open edge whose child grant
 * has expired or been revoked, deepest first, each in its own short
 * transaction. Idempotent; safe on every replica at once (each edge is
 * re-read under its lock and a closed edge is skipped).
 *
 * "Expired" is judged by the DATABASE clock (`now()`), both in the selection
 * and again under the lock, never by this replica's clock: a replica whose
 * clock runs ahead would otherwise release a live child's reservation, and one
 * that runs behind would hold an expired one (PR #279 review; the same rule as
 * the signing-key lifecycle and the replay sweep).
 */
export async function sweepDelegationAllocations(db: Db, opts: { limit?: number } = {}): Promise<{ closed: number; releasedMicros: number }> {
  const due = await db
    .select({ id: delegationAllocations.id, parentGrantId: delegationAllocations.parentGrantId })
    .from(delegationAllocations)
    .innerJoin(delegationGrants, eq(delegationGrants.id, delegationAllocations.childGrantId))
    .where(
      and(
        eq(delegationAllocations.status, "open"),
        or(sql`${delegationGrants.revokedAt} IS NOT NULL`, sql`${delegationGrants.expiresAt} <= now()`),
      ),
    )
    .orderBy(desc(delegationGrants.depth), asc(delegationAllocations.id))
    .limit(opts.limit ?? 500);
  let closed = 0;
  let releasedMicros = 0;
  for (const e of due) {
    await db.transaction(async (tx) => {
      await tx.select({ id: delegationGrants.id }).from(delegationGrants).where(eq(delegationGrants.id, e.parentGrantId)).for("update");
      // re-check under the lock, by the database clock: still open, and the child really ended
      const [still] = await tx
        .select({ id: delegationAllocations.id })
        .from(delegationAllocations)
        .innerJoin(delegationGrants, eq(delegationGrants.id, delegationAllocations.childGrantId))
        .where(
          and(
            eq(delegationAllocations.id, e.id),
            eq(delegationAllocations.status, "open"),
            or(sql`${delegationGrants.revokedAt} IS NOT NULL`, sql`${delegationGrants.expiresAt} <= now()`),
          ),
        );
      if (!still) return;
      releasedMicros += await closeEdge(tx, e.id, sql`now()`);
      closed += 1;
    });
  }
  return { closed, releasedMicros };
}
