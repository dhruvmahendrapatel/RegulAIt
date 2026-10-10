/**
 * ADR-0188 (batch 6 item 1) slice S2 — THE ACTOR CHAIN, as the kernel sees it.
 *
 * Dependency-free on purpose, like the rest of the kernel: these are plain
 * structural types that mirror the S1 zod contract in
 * `packages/shared/src/identity/contract.ts` (`actorChainSchema`,
 * `delegationScopeItemSchema`, `actorEntitlementsSchema`). The gateway's
 * `actor-contract-types.test.ts` proves every S1 `z.infer` type is assignable
 * to its twin here, so the two cannot drift silently.
 *
 * WHAT THE KERNEL IS HANDED. Not a token, not a caller-asserted `act` claim: a
 * `GovernedActor` that S3/S4 BUILD from the stored grant path with a fresh read
 * at the point of use (decision 17). The kernel stays pure — it never looks a
 * grant, an identity or a balance up — and decides the intersection of
 * decision 3:
 *
 *   allow ⇔ sponsor allowed (the existing per-user evaluation, unchanged)
 *         ∧ every actor's OWN grants allow (unless `sponsor_only`)
 *         ∧ every link's delegation scope covers the call
 *         ∧ the chain is consistent and live, within depth and budget
 *         ∧ no actor's Cedar (v4, as `Agent`) forbids.
 *
 * Every term can only narrow. See `index.ts` for the order the terms run in.
 *
 * THREE RULINGS THESE TYPES ENCODE (ADR-0188 decisions 25–27):
 *  - actor order is ROOT FIRST, leaf (the caller) last;
 *  - `depth` is the hop count, `actors.length` (a human acting directly is
 *    `actor: null`, never an empty chain);
 *  - scope is STRICT: nothing implies anything. `write` does not include
 *    `read`, one mode never implies another, an entry with no `modes` allows no
 *    mode and an `mcp_tool` entry with no `toolNames` covers no tool.
 */

/** the identity kinds of S1's `WORKLOAD_IDENTITY_KINDS` (migration 0180 CHECK) */
export type ActorIdentityKind = "agent" | "builder_agent" | "engine_runner" | "worker_runtime" | "pdp";

/** the most hops a chain can have: a root grant (depth 0) plus 8 descendants (S1 `ACTOR_CHAIN_MAX_HOPS`) */
export const ACTOR_CHAIN_MAX_HOPS = 9;
/** the hard ceiling of `delegation_max_depth` (S1 `DELEGATION_DEPTH_CEILING`) */
export const DELEGATION_MAX_DEPTH_CEILING = 8;

/** one link of the chain: an agent principal */
export interface ActorChainLink {
  readonly identityId: string;
  readonly kind: ActorIdentityKind;
  /** the identity's SPIFFE ID (decision 2) — reason prose and the Cedar `Agent` entity */
  readonly identifier: string;
}

/**
 * Who the action is FOR (`sponsorUserId`, the `sub`) and who is DOING it
 * (`actors`, root first, leaf last).
 */
export interface ActorChain {
  readonly sponsorUserId: string;
  /** the LEAF delegation grant the call is made under */
  readonly delegationGrantId: string;
  /** hop count: `actors.length`, 1..9 */
  readonly depth: number;
  /** ROOT FIRST, leaf (the caller) last (decision 25) */
  readonly actors: readonly ActorChainLink[];
}

export type DelegationScopeType = "mcp_tool" | "connector" | "agent";
export type DelegationScopeKind = "read" | "write";

/** one RFC 9396-style scope entry (decision 4), strict semantics (decision 27) */
export interface DelegationScopeItem {
  readonly type: DelegationScopeType;
  readonly serverId?: string | undefined;
  readonly connectorId?: string | undefined;
  readonly agentId?: string | undefined;
  /** `mcp_tool` only; absent = NO tool */
  readonly toolNames?: readonly string[] | undefined;
  /** `agent` only; absent = NO mode */
  readonly modes?: readonly string[] | undefined;
  /** exactly this kind: `write` does not include `read` */
  readonly kind: DelegationScopeKind;
}
export type DelegationScope = readonly DelegationScopeItem[];

/**
 * An agent principal's OWN grants (decisions 3 and 24), role grants already
 * expanded by the gateway. The twin of S1's `ActorEntitlements`: lists are
 * REQUIRED — an agent never gets a user's "NULL = every mode / object".
 */
export interface ActorEntitlements {
  readonly tools: readonly { readonly serverId: string; readonly toolName: string }[];
  readonly servers: readonly { readonly serverId: string; readonly readOnlyAll: boolean }[];
  readonly agents: readonly { readonly agentId: string; readonly allowedModes: readonly string[] }[];
  readonly connectors: readonly {
    readonly connectorId: string;
    readonly mode: "read" | "readwrite";
    readonly allowedObjects: readonly string[];
  }[];
}

/** an identity with no grants of its own (OWNER DECISION 1: every identity starts here) */
export const NO_ACTOR_ENTITLEMENTS: ActorEntitlements = Object.freeze({
  tools: [],
  servers: [],
  agents: [],
  connectors: [],
});

/**
 * The verdict of ONE actor's Cedar evaluation (as `Agent`, against v4 policies
 * only — decision 18). Structurally the kernel's `AbacDecision`, restated here
 * so this module stays import-free.
 */
export interface ActorAbacVerdict {
  readonly effect: "permit" | "forbid" | "require_approval";
  readonly policyId?: string | null | undefined;
  readonly policyName?: string | null | undefined;
  readonly policyVersion?: number | null | undefined;
  readonly matchedPolicyIds?: readonly string[] | undefined;
  readonly approverUserId?: string | null | undefined;
  readonly approverName?: string | null | undefined;
  readonly reason?: string | null | undefined;
}

/**
 * What S3's live-chain query (decision 17) established about ONE link, read
 * fresh at the point of use. Same order and length as `chain.actors`.
 */
export interface ActorLinkFacts {
  /** must equal `chain.actors[i].identityId` */
  readonly identityId: string;
  /** the delegation grant this actor acts under (the leaf's is `chain.delegationGrantId`) */
  readonly grantId: string;
  /**
   * true only when the grant is unrevoked and unexpired with a consistent
   * path, the identity is active and not halted, and its credentials are live
   * (decision 17). Anything else is `actor-chain-invalid`.
   */
  readonly live: boolean;
  /** why `live` is false — a short CODE for the reason prose, never secret material */
  readonly liveFailure?: string | null | undefined;
  /** the grant's delegation scope (decision 4) */
  readonly scope: DelegationScope;
  /**
   * The grant's budget (decision 22): `remainingMicros` = cap − settled −
   * reserved, which may be negative after a first crossing. `null` = this
   * grant carries no cap.
   */
  readonly budget: { readonly remainingMicros: number } | null;
  /** the actor's OWN grants, read now (I7: a grant removed after mint narrows immediately) */
  readonly entitlements: ActorEntitlements;
  /**
   * This actor's Cedar verdict as `Agent` (v4 only). Absent/null = no v4
   * policy applied — neutral, the grants decide (decision 18). Filled by the
   * gateway (`evaluateAbacForChain`), never by S3.
   */
  readonly abacDecision?: ActorAbacVerdict | null | undefined;
}

/** S1 `AGENT_ENTITLEMENT_MODES`: `own_grants` = I7 on (strict default); `sponsor_only` = today's behaviour */
export type AgentEntitlementMode = "own_grants" | "sponsor_only";

/**
 * The kernel's `actor` input: the chain plus everything needed to decide it
 * without I/O. `null` on an input means "a human acting directly" and keeps
 * every decision byte-identical to the pre-ADR-0188 kernel.
 */
export interface GovernedActor {
  readonly chain: ActorChain;
  /** the org's `agent_entitlement_mode` (decision 10) */
  readonly entitlementMode: AgentEntitlementMode;
  /** the org's `delegation_max_depth` (0..8): caps the LEAF grant's stored depth, `chain.depth − 1` */
  readonly maxDepth: number;
  /**
   * Is this call's price known? An unpriced call under any capped grant is
   * refused (decision 16: an unknown cost never buys free authority).
   */
  readonly costKnown: boolean;
  /** one per `chain.actors`, same order (root first) */
  readonly links: readonly ActorLinkFacts[];
}

// ---------------------------------------------------------------------------
// Scope algebra (decision 27)
// ---------------------------------------------------------------------------

/** the ONE governed call a scope is asked about */
export type ScopeCall =
  | { readonly type: "mcp_tool"; readonly serverId: string; readonly toolName: string; readonly kind: DelegationScopeKind }
  | { readonly type: "connector"; readonly connectorId: string; readonly kind: DelegationScopeKind }
  | { readonly type: "agent"; readonly agentId: string; readonly mode: string; readonly kind: DelegationScopeKind };

function itemCovers(item: DelegationScopeItem, call: ScopeCall): boolean {
  if (item.type !== call.type || item.kind !== call.kind) return false;
  switch (call.type) {
    case "mcp_tool":
      return item.serverId === call.serverId && (item.toolNames ?? []).includes(call.toolName);
    case "connector":
      return item.connectorId === call.connectorId;
    case "agent":
      return item.agentId === call.agentId && (item.modes ?? []).includes(call.mode);
  }
}

/** does this scope cover exactly this call? Strict: absence is denial (decision 27). */
export function scopeCovers(scope: DelegationScope, call: ScopeCall): boolean {
  return scope.some((item) => itemCovers(item, call));
}

/**
 * The atomic calls one item covers, as keys — the unit `scopeSubset` compares.
 * An item with no `toolNames`/`modes` covers nothing, so it has no atoms and is
 * trivially inside any parent.
 */
function atomsOf(item: DelegationScopeItem): ScopeCall[] {
  switch (item.type) {
    case "mcp_tool":
      return item.serverId === undefined
        ? []
        : (item.toolNames ?? []).map((toolName) => ({ type: "mcp_tool", serverId: item.serverId!, toolName, kind: item.kind }));
    case "connector":
      return item.connectorId === undefined ? [] : [{ type: "connector", connectorId: item.connectorId, kind: item.kind }];
    case "agent":
      return item.agentId === undefined
        ? []
        : (item.modes ?? []).map((mode) => ({ type: "agent", agentId: item.agentId!, mode, kind: item.kind }));
  }
}

/**
 * Is `child` inside `parent`? Every atomic call the child covers must be
 * covered by the parent — possibly by a different parent entry, since a parent
 * may split one server's tools across entries. This is the "a child grant
 * wider than its parent: never" invariant (decision 10), and it is exactly the
 * relation under which `scopeCovers(child, x) ⇒ scopeCovers(parent, x)`.
 */
export function scopeSubset(child: DelegationScope, parent: DelegationScope): boolean {
  return child.every((item) => atomsOf(item).every((atom) => scopeCovers(parent, atom)));
}

// ---------------------------------------------------------------------------
// The chain's structural and liveness check (decisions 17, 25, 26)
// ---------------------------------------------------------------------------

export type ActorChainCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Is the chain internally consistent and live, and is it THIS sponsor's?
 * Pure. Refusals here are `actor-chain-invalid` (decision 28). It never
 * repairs anything: a chain S3 handed over inconsistent is a bug or a forgery,
 * and both refuse.
 *
 * Checked: hop count = `actors.length` within 1..9; no identity twice; one
 * fact row per actor in the same order; the leaf fact's grant is the chain's
 * grant; grant ids unique; the chain's sponsor is the evaluated user; every
 * link live; each link's scope inside its parent's; settings in range.
 */
export function checkActorChain(actor: GovernedActor, sponsorUserId: string): ActorChainCheck {
  const { chain, links } = actor;
  const bad = (reason: string): ActorChainCheck => ({ ok: false, reason });
  const n = chain.actors.length;
  if (n < 1 || n > ACTOR_CHAIN_MAX_HOPS) return bad(`a chain has 1 to ${ACTOR_CHAIN_MAX_HOPS} actors, this one has ${n}`);
  if (chain.depth !== n) return bad(`depth ${chain.depth} is not the hop count ${n}`);
  if (new Set(chain.actors.map((a) => a.identityId)).size !== n) return bad("an identity appears twice in the chain");
  if (links.length !== n) return bad(`${links.length} link facts for ${n} actors`);
  for (let i = 0; i < n; i++) {
    if (links[i]!.identityId !== chain.actors[i]!.identityId) {
      return bad(`link ${i} names identity ${links[i]!.identityId}, the chain names ${chain.actors[i]!.identityId}`);
    }
  }
  if (new Set(links.map((l) => l.grantId)).size !== n) return bad("a delegation grant appears twice in the chain");
  if (links[n - 1]!.grantId !== chain.delegationGrantId) return bad("the leaf link's grant is not the chain's delegation grant");
  if (chain.sponsorUserId !== sponsorUserId) return bad("the chain's sponsor is not the user this call is evaluated for");
  if (actor.entitlementMode !== "own_grants" && actor.entitlementMode !== "sponsor_only") {
    return bad(`unknown agent entitlement mode '${String(actor.entitlementMode)}'`);
  }
  if (!Number.isInteger(actor.maxDepth) || actor.maxDepth < 0 || actor.maxDepth > DELEGATION_MAX_DEPTH_CEILING) {
    return bad(`delegation max depth ${actor.maxDepth} is outside 0..${DELEGATION_MAX_DEPTH_CEILING}`);
  }
  for (let i = 0; i < n; i++) {
    const l = links[i]!;
    if (l.live !== true) {
      return bad(`actor ${chain.actors[i]!.identifier} is not live` + (l.liveFailure ? ` (${l.liveFailure})` : ""));
    }
    if (i > 0 && !scopeSubset(l.scope, links[i - 1]!.scope)) {
      return bad(`the delegation scope of actor ${chain.actors[i]!.identifier} is wider than its parent's`);
    }
  }
  return { ok: true };
}
