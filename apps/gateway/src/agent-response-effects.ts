/**
 * ADR-0354 slice 2 — the side effects of the graduated responses that end a session or quarantine an agent.
 *
 * The kernel's declared table (`AGENT_RESPONSE_TABLE`) says WHAT a response does; this module is the one place that
 * DOES it, after the decision row is written and the call is already refused:
 *
 *  - `block_session` (`endSession`): the calling agent's session is its delegation grant (ADR-0188), so the session
 *    ends by revoking the LEAF grant with reason `policy_response`. The existing cascade revokes every grant under it
 *    and returns unspent allocation to the parent; every later call on that chain is refused by the chain check.
 *  - `disable` (`quarantineAgent`): the leaf workload identity is SUSPENDED as well. Narrowing only, by construction:
 *    the update moves `active → suspended` and nothing else, so it can never reinstate a suspended identity or touch
 *    a revoked one. Reinstating stays on the workload-identity route with its own step-up. This is the same
 *    narrowing-only rule lane E19 encodes as `kill_switch_narrowing_only` (#881): a narrowing action applies under
 *    every kill-switch dial, because it can only take capability away.
 *  - A call with no agent session (a person's own call, an API key's single request) has nothing to end. The refusal
 *    stands as a deny and the outcome is audited as `sessionEnded: false`; nothing broader (the person's login) is
 *    ended in its place.
 *
 * Error never widens: every effect runs after the refusal is recorded, and a failure is audited
 * (`response-effect-failed`) while the call stays refused.
 */
import { and, auditLog, eq, sql, workloadIdentities, type Db } from "@regulait/db";
import type { AgentResponse, GovernedActor } from "@regulait/policy-kernel";
import { revokeDelegationGrant } from "./delegation.js";
import { errMessage } from "./err-serializer.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export const AGENT_RESPONSE_EFFECT_RULE_IDS = {
  sessionEnded: "response-session-ended",
  agentQuarantined: "response-agent-quarantined",
  noSession: "response-no-session",
  failed: "response-effect-failed",
} as const;

export interface AgentResponseEffectOutcome {
  sessionEnded: boolean;
  agentQuarantined: boolean;
  revokedGrantIds: string[];
}

const NONE: AgentResponseEffectOutcome = Object.freeze({ sessionEnded: false, agentQuarantined: false, revokedGrantIds: [] });

/**
 * Apply a decision's session and agent side effects. A no-op for every response that has none, so a call site can
 * call it on every refusal.
 */
export async function applyAgentResponseEffects(
  db: Db,
  input: {
    response: AgentResponse | undefined;
    actor: GovernedActor | null | undefined;
    /** the person the call was for (audit attribution) */
    userId: string;
    /** the decision row these effects follow from */
    decisionAuditId?: string | null;
    surface: "mcp_tool" | "model" | "connector" | "a2a";
  },
): Promise<AgentResponseEffectOutcome> {
  const r = input.response;
  if (!r || (!r.endSession && !r.quarantineAgent)) return NONE;
  const base = { response: r.kind, policyId: r.policyId, decisionAuditId: input.decisionAuditId ?? null, surface: input.surface };
  const chain = input.actor?.chain;
  const leaf = chain?.actors[chain.actors.length - 1];
  if (!chain || !leaf) {
    await db.insert(auditLog).values({
      userId: input.userId,
      objectType: "abac_policy",
      objectId: r.policyId,
      detail: { ...base, sessionEnded: false, agentQuarantined: false, receiptClass: "decision" },
      effect: "deny",
      ruleId: AGENT_RESPONSE_EFFECT_RULE_IDS.noSession,
      ruleChain: [],
      reason: `policy response '${r.kind}' refused the call; it came from no agent session, so there was no session to end and no agent to quarantine`,
    });
    return NONE;
  }
  try {
    let agentQuarantined = false;
    if (r.quarantineAgent) {
      agentQuarantined = await db.transaction(async (tx) => {
        // narrowing only: active → suspended, never any other move
        const moved = await tx
          .update(workloadIdentities)
          .set({ status: "suspended", updatedAt: sql`now()` })
          .where(and(eq(workloadIdentities.id, leaf.identityId), eq(workloadIdentities.status, "active")))
          .returning({ id: workloadIdentities.id });
        await tx.insert(auditLog).values({
          userId: input.userId,
          objectType: "workload_identity",
          objectId: leaf.identityId,
          detail: { ...base, identifier: leaf.identifier, changed: moved.length > 0, receiptClass: "configuration" },
          effect: "deny",
          ruleId: AGENT_RESPONSE_EFFECT_RULE_IDS.agentQuarantined,
          ruleChain: [],
          reason:
            moved.length > 0
              ? `agent identity ${leaf.identifier} SUSPENDED by policy response 'disable'; reinstating it is an audited, step-up change on the workload-identity route`
              : `policy response 'disable' found agent identity ${leaf.identifier} already not active; nothing was changed`,
        });
        return moved.length > 0;
      });
    }
    const revoked = await revokeDelegationGrant(db, { grantId: chain.delegationGrantId, reason: "policy_response", actorUserId: null });
    await db.insert(auditLog).values({
      userId: input.userId,
      objectType: "delegation_grant",
      objectId: chain.delegationGrantId,
      detail: { ...base, revokedGrantIds: revoked.revokedGrantIds, agentQuarantined, receiptClass: "decision" },
      effect: "deny",
      ruleId: AGENT_RESPONSE_EFFECT_RULE_IDS.sessionEnded,
      ruleChain: [],
      reason: `policy response '${r.kind}' ended the agent session (delegation grant ${chain.delegationGrantId} and ${Math.max(0, revoked.revokedGrantIds.length - 1)} grant(s) under it)`,
    });
    return { sessionEnded: true, agentQuarantined, revokedGrantIds: revoked.revokedGrantIds };
  } catch (err) {
    // the call is already refused; record that the side effect did not complete so an operator can finish it
    await db
      .insert(auditLog)
      .values({
        userId: input.userId ?? SYSTEM_USER_ID,
        objectType: "delegation_grant",
        objectId: chain.delegationGrantId,
        detail: { ...base, error: errMessage(err), receiptClass: "decision" },
        effect: "deny",
        ruleId: AGENT_RESPONSE_EFFECT_RULE_IDS.failed,
        ruleChain: [],
        reason: `policy response '${r.kind}' refused the call, but ending the session or quarantining the agent failed; the call stays refused`,
      })
      .catch(() => undefined);
    return NONE;
  }
}
