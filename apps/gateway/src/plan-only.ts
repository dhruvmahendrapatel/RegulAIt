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
  and,
  auditLog,
  engineRuns,
  eq,
  notInArray,
  virtualKeys,
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
 *
 * ADR-0124 MOVED THE DEFINITION INTO THE POLICY KERNEL and re-exports it here
 * so every existing importer is unchanged. It moved because "does this mode
 * mutate anything?" is a POLICY judgement, and ADR-0124's read-only mode has
 * to answer exactly the same question on the dispatch path. Two copies of that
 * judgement would eventually disagree, and the disagreement would show up as a
 * safe mode that let a write through.
 */
import { PLAN_SAFE_MODES, isPlanSafeMode } from "@regulait/policy-kernel";
export { PLAN_SAFE_MODES, isPlanSafeMode };

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

/**
 * ADR-0250 (review P-02) — THE PLAN-ONLY GATE AT PROJECT LEVEL.
 *
 * ADR-0079 made the gate enforceable only for a call that NAMED its workflow
 * instance, so the same `execute` without an `instanceId` (and every IDE call
 * through the compat shims and every MCP tool call, which have no way to name
 * one) went through while the change sat in planning. Pillar 2 says the
 * plan-only stage is FORCED, so the gate now keys on the PROJECT: while any
 * live workflow instance of the project the call is attributed to rests at a
 * planning stage, a mutating call is refused on every surface, audited on that
 * instance's own trail, whether or not the caller names the instance.
 *
 * - `mutating` is the surface's own judgement: `!isPlanSafeMode(mode)` on the
 *   invoke, runs and compat paths (compat is always `execute`), and a
 *   WRITE-classified tool on the MCP path. A plan-safe call takes no query.
 * - No project = nothing to key on. Compat and MCP require attribution by
 *   default (ADR-0181), so an unattributed call there is already refused; an
 *   unattributed invoke is a disclosed limit in ADR-0250.
 * - THE ONE EXCEPTION (ADR-0250, audited): the workflow engine's own work for
 *   an instance at an executable stage — a nested build-stage run, or a call
 *   made with an engine run's key — is not stopped by ANOTHER instance of the
 *   same project resting in planning. It is still refused when its OWN
 *   instance is in planning. Each pass under the exception writes an `allow`
 *   row `workflow-plan-only-engine-exception` on the planning instance's trail.
 */
export type PlanOnlySurface = "invoke" | "runs" | "compat" | "mcp";

export interface ProjectPlanOnlyRefusal {
  ok: false;
  status: 409;
  error: "plan_only_stage";
  detail: string;
  stageId: string;
  instanceId: string;
}

/** the instance statuses that can never rest at a stage again (mirrors `currentPlanningStage`) */
const TERMINAL_INSTANCE_STATUSES = ["completed", "aborted", "denied", "rolled_back"] as const;

/** live instances of a project that rest at a planning stage, oldest first */
export async function projectPlanningInstances(
  db: Db,
  projectId: string,
): Promise<Array<{ instance: InstanceRow; stage: Stage }>> {
  const rows = await db
    .select()
    .from(workflowInstances)
    .where(
      and(
        eq(workflowInstances.projectId, projectId),
        notInArray(workflowInstances.status, [...TERMINAL_INSTANCE_STATUSES]),
      ),
    )
    .orderBy(workflowInstances.createdAt);
  const out: Array<{ instance: InstanceRow; stage: Stage }> = [];
  for (const instance of rows) {
    const stage = planOnlyStage(instance);
    if (stage) out.push({ instance, stage });
  }
  return out;
}

/**
 * The workflow instance an ENGINE run's key works for, or null for any other
 * credential (ADR-0187: an engine key is minted for one engine run, and that
 * run belongs to at most one instance).
 */
export async function engineKeyWorkflowInstance(
  db: Db,
  req: { authCtx: { via: string; virtualKeyId?: string; virtualKeyPurpose?: string } },
): Promise<string | null> {
  if (req.authCtx.via !== "virtual-key" || req.authCtx.virtualKeyPurpose !== "engine" || !req.authCtx.virtualKeyId) {
    return null;
  }
  const [row] = await db
    .select({ instanceId: engineRuns.workflowInstanceId })
    .from(virtualKeys)
    .innerJoin(engineRuns, eq(engineRuns.id, virtualKeys.engineRunId))
    .where(eq(virtualKeys.id, req.authCtx.virtualKeyId));
  return row?.instanceId ?? null;
}

export async function guardProjectPlanOnly(
  db: Db,
  args: {
    /** every project the call is attributed to (nulls and duplicates ignored) */
    projectIds: ReadonlyArray<string | null | undefined>;
    userId: string;
    surface: PlanOnlySurface;
    /** the surface's own judgement: does this call mutate? (false = no query) */
    mutating: boolean;
    /** the declared mode, for the audit detail and the message */
    mode: string;
    /** phrase naming the refused thing, e.g. "write tool 'git.push'" */
    what?: string;
    /** correlation for the audit detail (agent id, server, tool) */
    detail?: Record<string, unknown>;
    /** the workflow engine's own instance, when the call IS the engine's work (the ADR-0250 exception) */
    engineInstanceId?: string | null;
    serverId?: string;
    toolName?: string;
  },
): Promise<{ ok: true } | ProjectPlanOnlyRefusal> {
  if (!args.mutating) return { ok: true };
  const projects = [...new Set(args.projectIds.filter((p): p is string => typeof p === "string" && p.length > 0))];
  const what = args.what ?? `mode '${args.mode}'`;
  for (const projectId of projects) {
    for (const { instance, stage } of await projectPlanningInstances(db, projectId)) {
      const excepted = !!args.engineInstanceId && args.engineInstanceId !== instance.id;
      const detail = {
        ...(args.detail ?? {}),
        phase: "plan-only",
        enforcement: "project",
        surface: args.surface,
        projectId,
        mode: args.mode,
        planOnlyStageId: stage.id,
        instanceStatus: instance.status,
        ...(args.engineInstanceId ? { engineInstanceId: args.engineInstanceId } : {}),
      };
      if (excepted) {
        await db.insert(auditLog).values({
          userId: args.userId,
          objectType: "workflow",
          objectId: instance.id,
          ...(args.serverId ? { serverId: args.serverId } : {}),
          ...(args.toolName ? { toolName: args.toolName } : {}),
          detail,
          effect: "allow",
          ruleId: "workflow-plan-only-engine-exception",
          ruleChain: [],
          reason:
            `${what} allowed while workflow instance '${instance.id}' rests at plan-only stage '${stage.id}': ` +
            `it is the workflow engine's own work for instance '${args.engineInstanceId}' (ADR-0250 exception)`,
        });
        continue;
      }
      const message =
        `project '${projectId}' has workflow instance '${instance.id}' at plan-only stage '${stage.id}' — ` +
        `${what} mutates and is refused on every surface while it plans (§2 stage 2: planning-only reasoning ` +
        `first; ADR-0250). Plan/read modes (${PLAN_SAFE_MODES.join(", ")}) and read tools are allowed now; ` +
        `to build, leave plan-only first: POST /v1/workflows/instances/${instance.id}/advance ` +
        `{"stageId":"${stage.id}"}.`;
      await db.insert(auditLog).values({
        userId: args.userId,
        objectType: "workflow",
        objectId: instance.id,
        ...(args.serverId ? { serverId: args.serverId } : {}),
        ...(args.toolName ? { toolName: args.toolName } : {}),
        detail,
        effect: "deny",
        ruleId: "workflow-plan-only-stage",
        ruleChain: [],
        reason: message,
      });
      return { ok: false, status: 409, error: "plan_only_stage", detail: message, stageId: stage.id, instanceId: instance.id };
    }
  }
  return { ok: true };
}
