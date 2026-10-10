/**
 * ADR-0188 slice S4 — the AGENT-PATH decision for a model dispatch made under a
 * delegation grant (decision 6: in-process agents pass a grant id, never a
 * token), read fresh immediately before the effect (decision 17).
 *
 * The sponsor's inputs are exactly the ones the human path and the pillar-7
 * owner check load (grants, role grants, revocations, tier ceiling, the
 * ADR-0124 execution posture and the ADR-0182 literacy slot); the actor is the
 * stored chain read now (`actorForGrant`). The kernel then decides the
 * intersection (decision 3, term order of decision 30). A grant that is gone,
 * or a chain that is not live, is a refusal — never "a person acting directly".
 *
 * Every refusal here is audited (objectType `agent`), and, because the caller
 * runs inside the actor context (`runAsActor`), the row names the actor.
 */
import {
  agentGrants,
  agents,
  auditLog,
  eq,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { evaluateAgent, type AgentDecision, type GovernedActor } from "@regulait/policy-kernel";
import { literacySlot, type GovernedCallOrigin } from "./ai-literacy.js";
import { DelegationRefusedError } from "./delegation.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { agentHaltOf, loadExecutionMode, postureOf } from "./execution-posture.js";
import { actorForGrant, delegationRefusalDecision } from "./in-process-delegation.js";

type AgentRow = typeof agents.$inferSelect;

/** is this agent's price known (decision 16: an unpriced call under a capped grant is refused)? */
export function agentCostKnown(agent: Pick<AgentRow, "costPerMTokIn" | "costPerMTokOut">): boolean {
  return agent.costPerMTokIn != null && agent.costPerMTokOut != null;
}

/** the sponsor's agent-path inputs, loaded once (the same set `evaluateNodeOwner` loads) */
export async function loadSponsorAgentInputs(db: Db, userId: string) {
  const [grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db.select({ tier: agents.tier }).from(agents).where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return { grants, roleGrants, revocations, ceilingTier };
}

/**
 * Decide one model dispatch of `agent` in `mode` for sponsor `userId` under
 * delegation grant `grantId`. Returns the kernel decision and the actor it was
 * decided with (null only when the grant could not be read, which is a deny).
 */
export async function evaluateDelegatedAgentCall(
  db: Db,
  input: {
    userId: string;
    agent: AgentRow;
    mode: string;
    grantId: string;
    ceilingAgentIds?: readonly string[] | null;
    origin?: GovernedCallOrigin;
    sponsor?: Awaited<ReturnType<typeof loadSponsorAgentInputs>>;
  },
): Promise<{ decision: AgentDecision; actor: GovernedActor | null }> {
  let actor: GovernedActor;
  try {
    actor = await actorForGrant(db, input.grantId, { costKnown: agentCostKnown(input.agent) });
  } catch (err) {
    if (!(err instanceof DelegationRefusedError)) throw err;
    return { decision: delegationRefusalDecision(err) as AgentDecision, actor: null };
  }
  const sponsor = input.sponsor ?? (await loadSponsorAgentInputs(db, input.userId));
  const decision = evaluateAgent({
    userId: input.userId,
    actor,
    execution: {
      ...postureOf(await loadExecutionMode(db), agentHaltOf(input.agent)),
      ...(await literacySlot(db, input.userId, input.origin ? { origin: input.origin } : undefined)),
    },
    agent: { id: input.agent.id, name: input.agent.name, tier: input.agent.tier, enabled: input.agent.enabled, modes: input.agent.modes ?? null },
    mode: input.mode,
    agentGrants: sponsor.grants,
    roleAgentGrants: sponsor.roleGrants,
    agentRevocations: sponsor.revocations,
    ceilingTier: sponsor.ceilingTier,
    ceilingAgentIds: input.ceilingAgentIds ?? null,
  });
  return { decision, actor };
}

/** audit an agent-path refusal (the row is stamped with the actor by the caller's context) */
export async function auditDelegatedAgentRefusal(
  db: Db,
  input: { userId: string; agentId: string; mode: string; grantId: string; decision: Pick<AgentDecision, "ruleId" | "ruleChain" | "reason">; detail?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: input.userId,
    objectType: "agent",
    objectId: input.agentId,
    detail: { phase: "delegated-dispatch", mode: input.mode, delegationGrantId: input.grantId, ...(input.detail ?? {}), receiptClass: "decision" },
    effect: "deny",
    ruleId: input.decision.ruleId,
    ruleChain: input.decision.ruleChain,
    reason: input.decision.reason,
  });
}
