/**
 * ADR-0340 slice 3 — the pure part of template versioning for running workflows: the plan for MIGRATING a running
 * instance to another version of its template. (The migration request and canary lifecycles are ADR-0348 machines in
 * @regulait/shared.) The gateway computes the plan for its dry run, and again under the instance lock when the approved
 * migration is applied, and applies only a plan that is still `ok`. A migration may change what is AHEAD of the
 * instance; it may never rewrite what already happened, skip a gate it would have met, or drop the undo of something
 * that ran.
 */
import { isCompensating, workflowDefinitionSchema, type InstanceState, type Stage, type WorkflowDefinition } from "./index.js";

export type MigrationRefusalCode =
  | "terminal"
  | "compensating"
  | "invalid_target"
  | "stage_removed"
  | "stage_changed"
  | "order_changed"
  | "inserted_before_current"
  | "compensation_lost";

export interface MigrationRefusal {
  code: MigrationRefusalCode;
  stageId?: string;
  detail: string;
}

export type MigrationPlan =
  | { ok: true; state: InstanceState; added: string[]; removed: string[]; changed: string[] }
  | { ok: false; refusals: MigrationRefusal[] };

/** the fields that make a stage the SAME stage for what it already did (its effect and its identity) */
function stageIdentity(s: Stage): string {
  return JSON.stringify([s.type, s.action ?? null, s.connection ?? null, s.repo ?? null, s.output ?? null, s.compensates ?? null]);
}

export function planInstanceMigration(from: WorkflowDefinition, to: unknown, state: InstanceState): MigrationPlan {
  if (["completed", "aborted", "denied", "rolled_back"].includes(state.status)) {
    return { ok: false, refusals: [{ code: "terminal", detail: `the instance has ended (${state.status}); it finishes on its version` }] };
  }
  if (isCompensating(state)) {
    return { ok: false, refusals: [{ code: "compensating", detail: "the instance is compensating; it finishes its undo on its version" }] };
  }
  const parsed = workflowDefinitionSchema.safeParse(to);
  if (!parsed.success) {
    return { ok: false, refusals: [{ code: "invalid_target", detail: parsed.error.issues.map((i) => i.message).join("; ") }] };
  }
  const target = parsed.data;
  const refusals: MigrationRefusal[] = [];
  const current = from.stages[state.currentStageIndex];
  const reached = from.stages.filter((_, i) => state.stageStatuses[i] !== "pending" || i === state.currentStageIndex);
  const targetIndex = (id: string) => target.stages.findIndex((s) => s.id === id);
  for (const st of reached) {
    const t = target.stages[targetIndex(st.id)];
    if (!t) {
      refusals.push({ code: "stage_removed", stageId: st.id, detail: `stage '${st.id}' has already been reached and is missing from the target` });
    } else if (stageIdentity(t) !== stageIdentity(st)) {
      refusals.push({ code: "stage_changed", stageId: st.id, detail: `stage '${st.id}' has already been reached and the target changes what it is or what it acted on` });
    } else if (st === current && JSON.stringify(t) !== JSON.stringify(st)) {
      // the stage the instance rests at runs under the definition it entered with (its gates, its deadline)
      refusals.push({ code: "stage_changed", stageId: st.id, detail: `stage '${st.id}' is the current stage; a migration changes only what is ahead of it` });
    }
    const comp = from.stages.find((c) => c.compensates === st.id);
    if (comp && state.stageStatuses[from.stages.indexOf(st)] !== "pending" && !target.stages.some((c) => c.compensates === st.id)) {
      refusals.push({ code: "compensation_lost", stageId: st.id, detail: `stage '${st.id}' ran and its compensation '${comp.id}' is missing from the target` });
    }
  }
  // what was reached keeps its order, and nothing new may appear before the current stage (it would never run: a
  // gate added there would be skipped)
  const reachedTargetIdx = reached.map((s) => targetIndex(s.id)).filter((i) => i >= 0);
  if (reachedTargetIdx.some((v, i) => i > 0 && v < reachedTargetIdx[i - 1]!)) {
    refusals.push({ code: "order_changed", detail: "the target reorders stages the instance has already reached" });
  }
  const curInTarget = current ? targetIndex(current.id) : -1;
  if (curInTarget >= 0) {
    const reachedIds = new Set(reached.map((s) => s.id));
    for (const t of target.stages.slice(0, curInTarget)) {
      const skippable = t.type === "rollback" || t.compensates !== undefined;
      if (!reachedIds.has(t.id) && !skippable) {
        refusals.push({ code: "inserted_before_current", stageId: t.id, detail: `stage '${t.id}' is new and sits before the current stage, so it would never run` });
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };
  const fromIds = new Set(from.stages.map((s) => s.id));
  const toIds = new Set(target.stages.map((s) => s.id));
  const next: InstanceState = {
    ...state,
    currentStageIndex: curInTarget,
    stageStatuses: target.stages.map((t) => {
      const i = from.stages.findIndex((s) => s.id === t.id);
      return i >= 0 ? state.stageStatuses[i]! : "pending";
    }),
    artifactVersions: { ...state.artifactVersions },
  };
  return {
    ok: true,
    state: next,
    added: target.stages.filter((s) => !fromIds.has(s.id)).map((s) => s.id),
    removed: from.stages.filter((s) => !toIds.has(s.id)).map((s) => s.id),
    changed: target.stages
      .filter((t) => fromIds.has(t.id) && JSON.stringify(t) !== JSON.stringify(from.stages.find((s) => s.id === t.id)))
      .map((s) => s.id),
  };
}


/** the canary percentages an admin may choose: a canary is a minority of new instances, never most of them */
export const CANARY_MIN_PERCENT = 1;
export const CANARY_MAX_PERCENT = 50;
