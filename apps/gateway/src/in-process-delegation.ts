/**
 * ADR-0188 (batch 6 item 1) slice S4 — IN-PROCESS WIRING: the internal agent
 * identities, the delegation grants an in-process agent acts under, and the
 * actor the kernel decides each of its calls with.
 *
 *  - FIRST LOAD (the S4 row: "creates the internal identities and grants
 *    BEFORE any agent path requires them"): `ensureInternalIdentities` gives
 *    every `agents`, `builder_agents` and `engine_runners` row its one
 *    workload identity (decision 2), at boot and lazily at first use
 *    (`ensureIdentityFor`). An identity starts with NO grants of its own
 *    (OWNER DECISION 1; ADR-0180: nothing is grandfathered); an admin grants
 *    through `PUT /v1/workload-identities/:id/grants` (`workload-identity-admin.ts`).
 *  - CHAINS (decision 6): an in-process hop never mints a token; it gets a
 *    delegation grant row and passes its id down the governed path.
 *    `startInProcessChain` creates the root (sponsored by the person the work
 *    is for) and admits each further hop as a child (decision 22), so a
 *    worker's grant is always inside its lead's, the lead ceiling folded in as
 *    the `ceiling` input (orchestration §5.1). Over-scope is REFUSED, never
 *    narrowed (decision 16). `endInProcessChain` revokes the root when the
 *    work ends (`run_ended`), which cascades and returns unspent allocation.
 *  - AT EACH USE (decision 17): `actorForGrant` reads the stored chain fresh
 *    (S3's `governedActorFor`), never a cached or caller-supplied one.
 *  - STAMPING (decision 9): `runAsActor` runs governed work inside the audit
 *    writer's actor context (`runWithAuditActor`), so every audit row, trace
 *    span and usage row written while the agent acts names it.
 *
 * Open source first (ADR-0176): none — this is RegulAIt's own policy semantics
 * (CLAUDE.md rule 4). The identifier is a SPIFFE ID (decision 2); the scope
 * algebra is the kernel's.
 */
import { randomUUID } from "node:crypto";
import {
  agents,
  and,
  auditLog,
  builderAgents,
  currentAuditActor,
  engineRunners,
  eq,
  isNull,
  runWithAuditActor,
  workloadIdentities,
  type AuditActorStamp,
  type Db,
} from "@regulait/db";
import type { Decision, DelegationScope, DelegationScopeItem, GovernedActor } from "@regulait/policy-kernel";
import { defaultWorkloadIdentifier, SPIFFE_TRUST_DOMAIN_PATTERN, type WorkloadIdentityKind } from "@regulait/shared";
import { resolveDeployMode } from "./deploy-posture.js";
import {
  admitChildGrant,
  createRootGrant,
  DelegationRefusedError,
  governedActorFor,
  revokeDelegationGrant,
  type GrantContext,
} from "./delegation.js";
import { isPlanSafeMode } from "./plan-only.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

/** the deploy-time trust domain of the default identifiers (decision 2); an identifier, not a secret */
export const TRUST_DOMAIN_ENV = "REGULAIT_TRUST_DOMAIN";
export const DEFAULT_TRUST_DOMAIN = "regulait.internal";

export function resolveTrustDomain(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[TRUST_DOMAIN_ENV]?.trim();
  if (!raw) return DEFAULT_TRUST_DOMAIN;
  if (!SPIFFE_TRUST_DOMAIN_PATTERN.test(raw)) {
    throw new Error(`${TRUST_DOMAIN_ENV}=${JSON.stringify(raw)} is not a SPIFFE trust domain (lowercase letters, digits, '.', '-', '_')`);
  }
  return raw;
}

/**
 * The environment an IN-PROCESS grant is made for: this deployment's mode
 * (`hosted | byoc | air_gapped`). A grant's environment must be one its
 * identity allows (S3), and an internal identity is created allowing exactly
 * this one.
 */
export function inProcessEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDeployMode(env);
}

/** a grant made for one piece of in-process work lives at most this long (the work ends it sooner) */
export const IN_PROCESS_GRANT_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Identities (first load, and lazily at first use)
// ---------------------------------------------------------------------------

export type InternalSubject =
  | { kind: "agent"; id: string }
  | { kind: "builder_agent"; id: string }
  | { kind: "engine_runner"; id: string };

export interface InternalIdentity {
  id: string;
  kind: WorkloadIdentityKind;
  identifier: string;
  status: string;
}

function subjectColumn(kind: InternalSubject["kind"]) {
  return kind === "agent" ? workloadIdentities.agentId : kind === "builder_agent" ? workloadIdentities.builderAgentId : workloadIdentities.engineRunnerId;
}

async function stewardFor(db: Db, s: InternalSubject): Promise<string> {
  if (s.kind === "agent") {
    const [a] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, s.id));
    return a?.owner ?? SYSTEM_USER_ID;
  }
  if (s.kind === "builder_agent") {
    const [b] = await db.select({ owner: builderAgents.ownerUserId }).from(builderAgents).where(eq(builderAgents.id, s.id));
    return b?.owner ?? SYSTEM_USER_ID;
  }
  return SYSTEM_USER_ID;
}

/**
 * The ONE workload identity of an internal subject, created if absent
 * (idempotent across replicas: the per-subject unique constraint decides a
 * race, and the loser reads the winner's row). Created ACTIVE, allowed in
 * this deployment's environment, with NO grants of its own. The steward is
 * the subject's owner where it has one, else the system principal (an admin
 * names stewards on the identity page). Audited once, on creation.
 */
export async function ensureIdentityFor(db: Db, subject: InternalSubject): Promise<InternalIdentity> {
  const col = subjectColumn(subject.kind);
  const pick = { id: workloadIdentities.id, kind: workloadIdentities.kind, identifier: workloadIdentities.identifier, status: workloadIdentities.status };
  const [existing] = await db.select(pick).from(workloadIdentities).where(eq(col, subject.id));
  if (existing) return existing;
  const steward = await stewardFor(db, subject);
  const inserted = await db
    .insert(workloadIdentities)
    .values({
      kind: subject.kind,
      agentId: subject.kind === "agent" ? subject.id : null,
      builderAgentId: subject.kind === "builder_agent" ? subject.id : null,
      engineRunnerId: subject.kind === "engine_runner" ? subject.id : null,
      identifier: defaultWorkloadIdentifier(resolveTrustDomain(), subject.kind, subject.id),
      sponsorUserIds: [steward],
      environments: [inProcessEnvironment()],
    })
    .onConflictDoNothing()
    .returning(pick);
  if (inserted[0]) {
    await db.insert(auditLog).values({
      userId: SYSTEM_USER_ID,
      objectType: "workload_identity",
      objectId: inserted[0].id,
      detail: { phase: "create", kind: subject.kind, subjectId: subject.id, origin: "first_load", grants: "none" },
      effect: "allow",
      ruleId: "workload-identity-created",
      ruleChain: [],
      reason: `internal workload identity created for ${subject.kind} ${subject.id}, with no grants of its own (ADR-0188 OWNER DECISION 1)`,
    });
    return inserted[0];
  }
  const [row] = await db.select(pick).from(workloadIdentities).where(eq(col, subject.id));
  if (!row) throw new Error(`workload identity for ${subject.kind} ${subject.id} could not be created`);
  return row;
}

/**
 * THE FIRST-LOAD STEP: every internal subject that has no identity yet gets
 * one. Run at boot before the server listens; idempotent; returns how many
 * were created. Grants are never created here (OWNER DECISION 1).
 */
export async function ensureInternalIdentities(db: Db): Promise<{ created: number }> {
  const [a, b, r] = await Promise.all([
    db.select({ id: agents.id }).from(agents).leftJoin(workloadIdentities, eq(workloadIdentities.agentId, agents.id)).where(isNull(workloadIdentities.id)),
    db
      .select({ id: builderAgents.id })
      .from(builderAgents)
      .leftJoin(workloadIdentities, eq(workloadIdentities.builderAgentId, builderAgents.id))
      .where(isNull(workloadIdentities.id)),
    db
      .select({ id: engineRunners.id })
      .from(engineRunners)
      .leftJoin(workloadIdentities, eq(workloadIdentities.engineRunnerId, engineRunners.id))
      .where(isNull(workloadIdentities.id)),
  ]);
  let created = 0;
  const subjects: InternalSubject[] = [
    ...a.map((x) => ({ kind: "agent" as const, id: x.id })),
    ...b.map((x) => ({ kind: "builder_agent" as const, id: x.id })),
    ...r.map((x) => ({ kind: "engine_runner" as const, id: x.id })),
  ];
  for (const s of subjects) {
    const before = await db.select({ id: workloadIdentities.id }).from(workloadIdentities).where(and(eq(subjectColumn(s.kind), s.id)));
    if (before.length > 0) continue;
    await ensureIdentityFor(db, s);
    created += 1;
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Scope atoms an in-process call needs (decision 32)
// ---------------------------------------------------------------------------

/** `agent` scope for a model dispatch in `mode`: `read` for a plan-safe mode, `write` otherwise (ADR-0124) */
export function agentScopeItem(agentId: string, mode: string): DelegationScopeItem {
  return { type: "agent", agentId, modes: [mode], kind: isPlanSafeMode(mode) ? "read" : "write" };
}

/** `mcp_tool` scope, one entry per server and kind */
export function toolScopeItems(tools: ReadonlyArray<{ serverId: string; toolName: string; kind: "read" | "write" }>): DelegationScopeItem[] {
  const by = new Map<string, { serverId: string; kind: "read" | "write"; names: Set<string> }>();
  for (const t of tools) {
    const k = `${t.serverId}|${t.kind}`;
    const e = by.get(k) ?? { serverId: t.serverId, kind: t.kind, names: new Set<string>() };
    e.names.add(t.toolName);
    by.set(k, e);
  }
  return [...by.values()].map((e) => ({ type: "mcp_tool", serverId: e.serverId, toolNames: [...e.names].sort(), kind: e.kind }));
}

/** `connector` scope */
export function connectorScopeItem(connectorId: string, kind: "read" | "write"): DelegationScopeItem {
  return { type: "connector", connectorId, kind };
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export interface InProcessHop {
  identityId: string;
  /** what this hop is granted; a child's must lie inside its parent's (refused otherwise) */
  scope: DelegationScope;
  /** integer micro-dollars; null = uncapped. A child of a capped hop must carry a cap. */
  capMicros: number | null;
  /** the lead ceiling (§5.1) this hop's scope must lie inside, when the hand-off has one */
  ceiling?: DelegationScope | null;
}

export interface InProcessChain {
  rootGrantId: string;
  leafGrantId: string;
  /** one per hop actually made, root first (consecutive hops by the same identity collapse into one) */
  grantIds: string[];
}

/**
 * Create the chain an in-process piece of work acts under: a ROOT grant from
 * the sponsor to the first hop, then each further hop admitted as a CHILD of
 * the previous one (decision 22). Every check is S3's: the actor's own grants
 * (under `own_grants`), the sponsor's grants, the parent's scope, the
 * ceiling, depth, lifetime and budget. Throws `DelegationRefusedError` on the
 * first refusal, after revoking whatever part of the chain was made (nothing
 * half-made is left live).
 *
 * The same identity twice in a row (a lead that is also its own worker) is one
 * hop, not two: an identity appears at most once in a chain (S3).
 */
export async function startInProcessChain(
  db: Db,
  input: {
    sponsorUserId: string;
    projectId: string | null;
    context: GrantContext;
    hops: readonly InProcessHop[];
    ttlMs?: number;
    now?: Date;
  },
): Promise<InProcessChain> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? IN_PROCESS_GRANT_TTL_MS));
  const env = inProcessEnvironment();
  const hops: InProcessHop[] = [];
  for (const h of input.hops) {
    const prev = hops[hops.length - 1];
    if (prev && prev.identityId === h.identityId) {
      // collapse: the narrower scope, cap and ceiling are the leaf's
      hops[hops.length - 1] = h;
      continue;
    }
    hops.push(h);
  }
  if (hops.length === 0) throw new DelegationRefusedError("delegation-request-invalid", "no_hops", "an in-process chain has at least one actor");
  const grantIds: string[] = [];
  try {
    const root = await createRootGrant(db, {
      sponsorUserId: input.sponsorUserId,
      environment: env,
      projectId: input.projectId,
      context: input.context,
      actorIdentityId: hops[0]!.identityId,
      scope: hops[0]!.scope,
      capMicros: hops[0]!.capMicros,
      expiresAt,
      binding: { kind: "in_process" },
      ceiling: hops[0]!.ceiling ?? null,
      now,
    });
    grantIds.push(root.id);
    let parentId = root.id;
    for (let i = 1; i < hops.length; i++) {
      const h = hops[i]!;
      const { grant } = await admitChildGrant(db, {
        parentGrantId: parentId,
        environment: env,
        projectId: input.projectId,
        actorIdentityId: h.identityId,
        scope: h.scope,
        capMicros: h.capMicros,
        expiresAt,
        binding: { kind: "in_process" },
        ceiling: h.ceiling ?? null,
        idempotencyKey: `in-process:${randomUUID()}`,
        now,
      });
      grantIds.push(grant.id);
      parentId = grant.id;
    }
  } catch (err) {
    if (grantIds[0]) await revokeDelegationGrant(db, { grantId: grantIds[0], reason: "run_ended" }).catch(() => {});
    throw err;
  }
  return { rootGrantId: grantIds[0]!, leafGrantId: grantIds[grantIds.length - 1]!, grantIds };
}

/** the work ended: revoke the root (cascades to every hop) and return unspent allocation. Idempotent. */
export async function endInProcessChain(db: Db, chain: Pick<InProcessChain, "rootGrantId"> | null): Promise<void> {
  if (!chain) return;
  await revokeDelegationGrant(db, { grantId: chain.rootGrantId, reason: "run_ended" });
}

/**
 * The kernel's actor for one call under `grantId`, read NOW (decision 17).
 * A grant that no longer exists is a refusal, never `actor: null`: a call that
 * came through an agent path is never decided as a person acting directly.
 */
export async function actorForGrant(db: Db, grantId: string, opts: { costKnown: boolean }): Promise<GovernedActor> {
  const out = await governedActorFor(db, grantId, { costKnown: opts.costKnown });
  if (!out) throw new DelegationRefusedError("actor-chain-invalid", "grant_not_found", `no delegation grant ${grantId}`);
  // the stored decision 23 depth limit narrows the org's at use (migration 0184)
  const maxDepth = Math.min(out.actor.maxDepth, out.live.leaf.depthLimit);
  return { ...out.actor, maxDepth };
}

/** a refusal to create or use a grant, as a kernel-shaped deny (rule id and reason; ids only, never secrets) */
export function delegationRefusalDecision(err: DelegationRefusedError): Decision {
  return {
    effect: "deny",
    ruleId: err.ruleId,
    ruleChain: [],
    reason: `delegation refused (${err.code}): ${err.message}`,
  };
}

// ---------------------------------------------------------------------------
// Stamping (decision 9)
// ---------------------------------------------------------------------------

/** the stamp of the leaf grant of a chain: its actor, the grant, and every identity on the path, root first */
export function stampFor(actor: GovernedActor): AuditActorStamp {
  const actors = actor.chain.actors;
  return {
    actorIdentityId: actors[actors.length - 1]!.identityId,
    delegationGrantId: actor.chain.delegationGrantId,
    actorChain: actors.map((a) => a.identityId),
  };
}

/** run `fn` with every audit row (and trace span, usage row) it writes stamped with this actor */
export function runAsActor<T>(stamp: AuditActorStamp, fn: () => Promise<T>): Promise<T> {
  return runWithAuditActor(stamp, fn);
}

/** the actor columns for a trace span or usage row written in the current context (empty outside one) */
export function actorColumns(): { actorIdentityId: string; delegationGrantId: string } | Record<string, never> {
  const s = currentAuditActor();
  return s ? { actorIdentityId: s.actorIdentityId, delegationGrantId: s.delegationGrantId } : {};
}

/** measured dollars to integer micro-dollars (decision 16: budgets are never floating point); unknown = 0 */
export function usdToMicros(usd: number | null | undefined): number {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1_000_000);
}
