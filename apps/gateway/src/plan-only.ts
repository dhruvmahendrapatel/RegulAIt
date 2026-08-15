/**
 * ADR-0079 — THE PLAN-ONLY STAGE, MADE ENFORCEABLE.
 *
 * WORKFLOW_ENGINE_SPEC §2 stage 2 promises "Auto-enter Plan mode — forced
 * planning-only reasoning first, NO CODE/STATE MUTATION POSSIBLE in this
 * stage." Two things were missing, and both are here:
 *
 *  1. **A join point.** An invoke body carried `projectId` but never an
 *     `instanceId`, so a direct `POST /v1/agents/:id/invoke` had no relation to
 *     any workflow instance and nothing about the instance could constrain it.
 *     `assertInstanceAttribution` is that join point, validated with exactly
 *     the shape `assertProjectAttribution` (projects.ts) uses: an unknown
 *     instance is `400 invalid_reference`, an instance the caller may not drive
 *     is a 403 — never silently ignored.
 *
 *  2. **A resting stage to enforce against.** The kernel used to auto-complete
 *     a `planning` stage; it now rests there (`blocked_on_plan`), and
 *     `currentPlanningStage` — the kernel's own predicate, not a status-string
 *     guess re-derived here — says so.
 *
 * THE MUTATING-MODE RULE (the one judgment call, stated rather than guessed).
 * The agent `mode` vocabulary is open (`z.string()`), so "mutating" cannot be
 * read off a closed enum. The rule is therefore **default-deny with a named
 * plan-safe allow-list**, matching pillar 1's posture everywhere else: a mode
 * is permitted at a planning stage only if it is one of PLAN_SAFE_MODES
 * (compared case-insensitively, trimmed). Every other mode — including one
 * invented tomorrow — is treated as mutating and refused. The alternative (a
 * deny-list of known-mutating modes) fails open on exactly the modes nobody
 * thought of, which is the wrong side for a control whose whole purpose is
 * "no mutation is POSSIBLE here".
 *
 * WHAT THIS DOES NOT CLAIM. The rule constrains the DECLARED INTENT, not the
 * semantics of the prompt: a caller who writes code inside a `plan`-mode
 * dispatch is not stopped by this, any more than pillar 1's per-mode grants
 * stop them. The declared mode is the governed dimension throughout this
 * codebase (`agent_grants.allowedModes`, node `mode`, the mode-scoped rules),
 * and this reuses it rather than inventing a second, softer one.
 */
import {
  auditLog,
  eq,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  currentPlanningStage,
  type InstanceState,
  type Stage,
  type WorkflowDefinition,
} from "@regulait/workflow-kernel";

type InstanceRow = typeof workflowInstances.$inferSelect;

/**
 * Modes a plan-only stage PERMITS. Everything else is mutating (default-deny).
 * These are the read/reason modes the codebase already uses on the invoke path
 * — `plan`, `review` and `chat` appear in the seed's own dispatch mix — plus
 * the two obvious read synonyms, so the allow-list is a vocabulary rather than
 * a list of two.
 */
export const PLAN_SAFE_MODES = ["plan", "review", "chat", "ask", "read"] as const;

const PLAN_SAFE = new Set<string>(PLAN_SAFE_MODES);

/** normalized membership test — the ONE definition of "mutating mode" */
export function isPlanSafeMode(mode: string): boolean {
  return PLAN_SAFE.has(mode.trim().toLowerCase());
}

export interface InstanceAttributionFailure {
  ok: false;
  status: 400 | 403;
  error: string;
  detail: string;
}
export type InstanceAttribution =
  | { ok: true; instance: InstanceRow }
  | InstanceAttributionFailure;

/**
 * ADR-0079: may this caller attribute work to this instance? Deliberately the
 * STRICT gate the driving routes use (initiator or admin), not the widened
 * read gate `loadInstanceFor(..., {allowParticipant:true})` grants: attributing
 * a dispatch to somebody else's change is driving it, not reading it. An
 * approver who can see an instance still cannot bill agent work into it.
 */
export async function assertInstanceAttribution(
  db: Db,
  instanceId: string,
  userId: string,
  isAdmin: boolean,
): Promise<InstanceAttribution> {
  const [instance] = await db
    .select()
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance) {
    return {
      ok: false,
      status: 400,
      error: "invalid_reference",
      detail: `no workflow instance '${instanceId}'`,
    };
  }
  if (isAdmin || instance.initiatorUserId === userId) return { ok: true, instance };
  return {
    ok: false,
    status: 403,
    error: "not_an_instance_participant",
    detail: `workflow instance '${instanceId}' is attributable by its initiator and admins only`,
  };
}

/** the planning stage an instance is resting at, or null */
export function planOnlyStage(instance: InstanceRow): Stage | null {
  return currentPlanningStage(
    instance.definition as WorkflowDefinition,
    instance.state as InstanceState,
  );
}

export interface PlanOnlyRefusal {
  status: 409;
  error: "plan_only_stage";
  detail: string;
  stageId: string;
}

/**
 * The refusal itself. `409` matches how this codebase reports "the object is
 * not in a state that permits this" (`invalid_workflow_state`,
 * `invalid_run_state`); the distinct `plan_only_stage` name is what makes it
 * actionable, and the message names BOTH the instance and the stage plus the
 * exact call that lifts it — a refusal nobody can act on is a bug report.
 *
 * Applies regardless of `dispatch`: a decision-only invoke sends nothing to a
 * provider, but "mode: execute against this change" is the intent the stage
 * exists to refuse, and answering it would make the gate look optional.
 */
export function planOnlyRefusal(
  instance: InstanceRow,
  mode: string,
  what = `mode '${mode}'`,
): PlanOnlyRefusal | null {
  const stage = planOnlyStage(instance);
  if (!stage) return null;
  if (isPlanSafeMode(mode)) return null;
  return {
    status: 409,
    error: "plan_only_stage",
    stageId: stage.id,
    detail:
      `workflow instance '${instance.id}' is at plan-only stage '${stage.id}' — ` +
      `${what} mutates and is refused there (§2 stage 2: planning-only reasoning first). ` +
      `Plan/read modes (${PLAN_SAFE_MODES.join(", ")}) are allowed now; ` +
      `to build, leave plan-only first: POST /v1/workflows/instances/${instance.id}/advance ` +
      `{"stageId":"${stage.id}"}.`,
  };
}

/**
 * The whole gate for one instance-attributed call: attribution, then plan-only.
 * Audits the plan-only DENY under objectType `workflow`/objectId = the instance
 * (so "what did this change's plan gate stop" is one query on the instance's
 * own trail, the reasoning ADR-0066 used for virtual keys), and audits the
 * ALLOW too — an attributed invoke that was permitted is part of the same
 * story. Attribution failures are NOT audited, matching the project-attribution
 * idiom they copy.
 */
export async function guardInstanceAttributedCall(
  db: Db,
  args: {
    instanceId: string;
    userId: string;
    isAdmin: boolean;
    mode: string;
    /** what is being attributed, for the audit detail (e.g. the agent id) */
    detail?: Record<string, unknown>;
    /** phrase naming the refused thing, e.g. "node 'implement' (mode 'execute')" */
    what?: string;
  },
): Promise<
  | { ok: true; instance: InstanceRow }
  | { ok: false; status: 400 | 403 | 409; error: string; detail: string }
> {
  const attributed = await assertInstanceAttribution(
    db,
    args.instanceId,
    args.userId,
    args.isAdmin,
  );
  if (!attributed.ok) return attributed;

  const instance = attributed.instance;
  const refusal = planOnlyRefusal(instance, args.mode, args.what);
  const stage = planOnlyStage(instance);
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: "workflow",
    objectId: instance.id,
    detail: {
      ...(args.detail ?? {}),
      mode: args.mode,
      planOnlyStageId: stage?.id ?? null,
      instanceStatus: instance.status,
    },
    effect: refusal ? "deny" : "allow",
    ruleId: refusal ? "workflow-plan-only-stage" : "workflow-instance-attributed",
    ruleChain: [],
    reason: refusal
      ? refusal.detail
      : `call attributed to workflow instance '${instance.id}' (status ${instance.status})` +
        (stage ? ` at plan-only stage '${stage.id}'; mode '${args.mode}' is plan-safe` : ""),
  });
  if (refusal) {
    return { ok: false, status: refusal.status, error: refusal.error, detail: refusal.detail };
  }
  return { ok: true, instance };
}
