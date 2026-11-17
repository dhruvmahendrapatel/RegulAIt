/**
 * ADR-0341 — the visual pipeline builder's governance rules, pure.
 *
 * The builder edits workflow template definitions in place of a second format, so everything here takes the
 * definitions `workflowDefinitionSchema` already accepts. Three things live here because the gateway runs them on
 * validate AND again on publish, and the tests pin them without a database:
 *
 *  - `builderRuleIssues`: the rules a publish can never relax — the forced plan gate (ADR-0079, ADR-0250) and the
 *    governed deploy tail (ADR-0161's rule in template form).
 *  - `stageDiff`: which stages a change adds, removes, changes or moves (the diff view's summary).
 *  - `findRelaxations`: what a change weakens. A publish that relaxes anything must say so and give a reason.
 */
import type { Stage, WorkflowDefinition } from "./index.js";

/** stages that change code or infrastructure: none may run before a planning stage (ADR-0079) */
export const MUTATING_STAGE_TYPES: ReadonlySet<Stage["type"]> = new Set(["automated_build", "git_operation", "deployment", "rollback"]);

export interface BuilderIssue {
  code: "plan_gate_missing" | "deploy_without_signoff" | "deploy_without_checks";
  stageId: string;
  message: string;
}

/** the rules no builder publish may break (both refuse; neither is an admin relaxation) */
export function builderRuleIssues(def: WorkflowDefinition): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const firstMutating = def.stages.findIndex((s) => MUTATING_STAGE_TYPES.has(s.type));
  if (firstMutating >= 0 && !def.stages.slice(0, firstMutating).some((s) => s.type === "planning")) {
    const s = def.stages[firstMutating]!;
    issues.push({
      code: "plan_gate_missing",
      stageId: s.id,
      message: `stage '${s.id}' (${s.type}) changes code or infrastructure, so a planning stage must come before it (the forced plan gate)`,
    });
  }
  def.stages.forEach((s, i) => {
    if (s.type !== "deployment") return;
    const earlier = def.stages.slice(0, i);
    if (!earlier.some((o) => o.type === "human_approval")) {
      issues.push({
        code: "deploy_without_signoff",
        stageId: s.id,
        message: `deployment stage '${s.id}' needs an earlier human_approval stage (a deploy is signed off first)`,
      });
    }
    if (!earlier.some((o) => o.type === "automated_check" && (o.checks?.length ?? 0) > 0)) {
      issues.push({
        code: "deploy_without_checks",
        stageId: s.id,
        message: `deployment stage '${s.id}' needs an earlier automated_check stage with named checks`,
      });
    }
  });
  return issues;
}

export interface StageDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** stages present in both whose relative order changed */
  moved: string[];
  /** a change outside the stages (the workflow name, the cost sensitivity) */
  topLevel: string[];
}

/** key-order-insensitive structural equality over JSON values */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && sameJson(ao[k], bo[k]));
}

/** the stage-level summary of a change from `before` to `after` */
export function stageDiff(before: WorkflowDefinition, after: WorkflowDefinition): StageDiff {
  const b = new Map(before.stages.map((s) => [s.id, s]));
  const a = new Map(after.stages.map((s) => [s.id, s]));
  const added = after.stages.filter((s) => !b.has(s.id)).map((s) => s.id);
  const removed = before.stages.filter((s) => !a.has(s.id)).map((s) => s.id);
  const changed = after.stages.filter((s) => b.has(s.id) && !sameJson(b.get(s.id), s)).map((s) => s.id);
  // relative order of the stages both sides keep
  const keptBefore = before.stages.map((s) => s.id).filter((id) => a.has(id));
  const keptAfter = after.stages.map((s) => s.id).filter((id) => b.has(id));
  const moved = keptAfter.filter((id, i) => keptBefore[i] !== id);
  const topLevel: string[] = [];
  if (before.workflow !== after.workflow) topLevel.push("workflow");
  if ((before.costSensitivity ?? "standard") !== (after.costSensitivity ?? "standard")) topLevel.push("costSensitivity");
  return { added, removed, changed, moved, topLevel };
}

export interface Relaxation {
  code:
    | "gate_stage_removed"
    | "quorum_relaxed"
    | "approvers_reduced"
    | "offline_auto_pass_enabled"
    | "evidence_only_review_enabled"
    | "review_fail_on_relaxed"
    | "checks_removed"
    | "retry_enabled"
    | "cost_sensitivity_relaxed";
  stageId: string | null;
  message: string;
}

/** stage types whose removal weakens the governance of a change */
const GATE_STAGE_TYPES: ReadonlySet<Stage["type"]> = new Set(["planning", "human_approval", "automated_check"]);
const FAIL_ON_RANK = { medium: 0, high: 1, blocker: 2 } as const;
const COST_RANK = { "cost-sensitive": 0, standard: 1, "quality-sensitive": 2 } as const;

/**
 * Everything `after` weakens compared with `before`. Tightenings are not listed; a stage that is new in `after` is
 * compared with nothing, except that a retry policy or an auto-pass is a relaxation wherever it appears.
 */
export function findRelaxations(before: WorkflowDefinition, after: WorkflowDefinition): Relaxation[] {
  const out: Relaxation[] = [];
  const a = new Map(after.stages.map((s) => [s.id, s]));
  for (const old of before.stages) {
    const now = a.get(old.id);
    if (!now || now.type !== old.type) {
      if (GATE_STAGE_TYPES.has(old.type)) {
        out.push({ code: "gate_stage_removed", stageId: old.id, message: `the ${old.type} stage '${old.id}' is removed` });
      }
      continue;
    }
    if (old.type === "human_approval") {
      if ((old.quorum ?? "all") === "all" && now.quorum === "any") {
        out.push({ code: "quorum_relaxed", stageId: old.id, message: `sign-off '${old.id}' moves from every approver to any one` });
      }
      const kept = new Set(now.approvers ?? []);
      if ((old.approvers ?? []).some((x) => !kept.has(x))) {
        out.push({ code: "approvers_reduced", stageId: old.id, message: `sign-off '${old.id}' loses a named approver` });
      }
    }
    if (old.type === "automated_check") {
      const kept = new Set(now.checks ?? []);
      if ((old.checks ?? []).some((c) => !kept.has(c))) {
        out.push({ code: "checks_removed", stageId: old.id, message: `check stage '${old.id}' drops a named check` });
      }
      const oldFailOn = new Map((old.reviews ?? []).map((r) => [r.check, r.failOn ?? "medium"]));
      for (const r of now.reviews ?? []) {
        const was = oldFailOn.get(r.check);
        if (was !== undefined && FAIL_ON_RANK[r.failOn ?? "medium"] > FAIL_ON_RANK[was]) {
          out.push({ code: "review_fail_on_relaxed", stageId: old.id, message: `review '${r.check}' now fails only at ${r.failOn}` });
        }
      }
    }
  }
  const b = new Map(before.stages.map((s) => [s.id, s]));
  for (const now of after.stages) {
    const old = b.get(now.id);
    const same = old && old.type === now.type ? old : undefined;
    if (now.offlineAutoPass === true && same?.offlineAutoPass !== true) {
      out.push({ code: "offline_auto_pass_enabled", stageId: now.id, message: `check stage '${now.id}' auto-passes unreported checks offline` });
    }
    const oldEvidenceOnly = new Set((same?.reviews ?? []).filter((r) => r.allowEvidenceOnly).map((r) => r.check));
    for (const r of now.reviews ?? []) {
      if (r.allowEvidenceOnly && !oldEvidenceOnly.has(r.check)) {
        out.push({ code: "evidence_only_review_enabled", stageId: now.id, message: `review '${r.check}' may run on evidence only` });
      }
    }
    if (now.retry && !same?.retry) {
      out.push({ code: "retry_enabled", stageId: now.id, message: `stage '${now.id}' retries automatically` });
    }
  }
  if (COST_RANK[after.costSensitivity ?? "standard"] < COST_RANK[before.costSensitivity ?? "standard"]) {
    out.push({ code: "cost_sensitivity_relaxed", stageId: null, message: `cost sensitivity moves to ${after.costSensitivity}` });
  }
  return out;
}
