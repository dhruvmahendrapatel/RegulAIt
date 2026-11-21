/**
 * ADR-0193 addendum (lane E50, OWASP Agentic ASI06 memory poisoning): the content-trust floor on the two stores an
 * agent later reads back as context, on top of the ADR-0347 write path (`memory-governance.ts`).
 *
 *   POST /v1/projects/:projectId/context (and .../context/promote)   the Shared Project context store (pillar 4)
 *   POST /v1/builder/agents/:id/memory                               an agent's memory, part of its system prompt
 *
 * ADR-0347 already scans every memory write (prompt injection, jailbreak, secrets, PII) and checks a declared
 * producing run. This module adds only what that path does not have: the ADR-0193 P1 floor, through the same code
 * `contentTrustGate` runs for a write tool call (`contextContentTiers` + `contentTrustWriteFloor` +
 * `evaluateContentTrust`). There is no second scanner and no second floor (ADR-0176).
 *
 * The causal context is CHECKED, never asserted: a run must be the caller's own (or the caller is an admin) and, for
 * a project's store, in that project; a builder thread must be the caller's own thread on this agent. A foreign
 * context is refused before the floor runs, so a writer cannot borrow a clean context to dodge it.
 *
 * Secure by default (ADR-0180): the floor is `trusted`. An admin relaxes it only through the existing audited
 * setting (`PUT /v1/content-trust/settings`, a `settings_relax` step-up, never below `standard`); there is no
 * memory-only switch, so memory can never sit below the posture a write tool call has.
 */
import { and, auditLog, builderThreads, eq, orchestrationRuns, type Db } from "@regulait/db";
import {
  CONTENT_TRUST_REFUSAL_CODE,
  CONTENT_TRUST_RULE_ID,
  contentTrustRefusalReason,
  evaluateContentTrust,
  type ContentTrustTier,
  type ContentTrustVerdict,
  type ContentTrustWriteFloor,
} from "@regulait/shared";
import { contentTrustWriteFloor, contextContentTiers } from "./content-provenance.js";

export type MemoryWriteTarget =
  | { kind: "shared_context"; projectId: string; key: string }
  | { kind: "agent_memory"; agentId: string; projectId: string | null };

export type MemoryTrustFloorResult = { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

export function memoryWriteTargetLabel(target: MemoryWriteTarget): string {
  return target.kind === "shared_context" ? `shared context '${target.key}'` : `agent memory (${target.agentId})`;
}

/** the decision, with no I/O: the P1 rule for a write whose context holds these tiers. The gateway probe calls it. */
export function memoryFloorVerdict(floor: ContentTrustWriteFloor, contextTiers: readonly ContentTrustTier[]): ContentTrustVerdict {
  return evaluateContentTrust("write", contextTiers, floor);
}

/**
 * Is the declared causal context the caller's own? null = yes; otherwise the refusal body. A run is the caller's when
 * they initiated it (or are an admin) and, when the store belongs to a project, it is in that project. A builder
 * thread is the caller's own thread (admins included: a thread is a person's conversation) on this agent.
 */
async function foreignContext(
  db: Db,
  contextId: string,
  args: { userId: string; isAdmin: boolean; target: MemoryWriteTarget },
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const [kind, id] = contextId.split(":", 2) as [string, string];
  if (kind === "run") {
    const [run] = await db
      .select({ projectId: orchestrationRuns.projectId, initiatingUserId: orchestrationRuns.initiatingUserId })
      .from(orchestrationRuns)
      .where(eq(orchestrationRuns.id, id));
    if (!run) return { status: 422, body: { error: "unknown_context" } };
    if (args.target.projectId && run.projectId !== args.target.projectId) return { status: 422, body: { error: "context_not_in_project" } };
    if (!args.isAdmin && run.initiatingUserId !== args.userId) return { status: 403, body: { error: "not_your_context" } };
    return null;
  }
  if (kind === "builder_thread") {
    if (args.target.kind !== "agent_memory") return { status: 422, body: { error: "unknown_context" } };
    const [thread] = await db
      .select({ id: builderThreads.id })
      .from(builderThreads)
      .where(and(eq(builderThreads.id, id), eq(builderThreads.agentId, args.target.agentId), eq(builderThreads.userId, args.userId)));
    return thread ? null : { status: 403, body: { error: "not_your_context" } };
  }
  return { status: 422, body: { error: "unknown_context" } };
}

/**
 * The floor at the route. With no causal context there is nothing for the floor to refuse on (a person's own note;
 * the ADR-0347 scan still runs). With one, the context is checked as the caller's own, then refused when it holds
 * content below the write floor, with the P1 deny row (rule `content-trust-floor`).
 */
export async function memoryTrustFloor(
  db: Db,
  args: { userId: string; isAdmin: boolean; contextId: string | null; target: MemoryWriteTarget },
): Promise<MemoryTrustFloorResult> {
  if (!args.contextId) return { ok: true };
  const foreign = await foreignContext(db, args.contextId, args);
  if (foreign) return { ok: false, ...foreign };
  const [contextTiers, floor] = await Promise.all([contextContentTiers(db, args.contextId), contentTrustWriteFloor(db)]);
  const verdict = memoryFloorVerdict(floor, contextTiers);
  if (verdict.ok) return { ok: true };
  const target = args.target;
  const reason = contentTrustRefusalReason(verdict.lowest, verdict.floor, memoryWriteTargetLabel(target));
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: target.kind === "shared_context" ? "project" : "builder_agent",
    objectId: target.kind === "shared_context" ? target.projectId : target.agentId,
    detail: {
      surface: target.kind,
      ...(target.kind === "shared_context" ? { key: target.key } : {}),
      phase: "content-trust",
      code: CONTENT_TRUST_REFUSAL_CODE,
      contextId: args.contextId,
      lowestTier: verdict.lowest,
      writeFloor: verdict.floor,
      projectId: target.projectId,
      receiptClass: "decision",
    },
    effect: "deny",
    ruleId: CONTENT_TRUST_RULE_ID,
    ruleChain: [],
    reason,
  });
  return {
    ok: false,
    status: 403,
    body: { error: CONTENT_TRUST_REFUSAL_CODE, detail: reason, lowestTier: verdict.lowest, writeFloor: verdict.floor },
  };
}
