import { z } from "zod";

// ---------------------------------------------------------------------------
// Template definition (§3): declarative, version-controllable, validated here.
// Executable stage types in this slice: trigger, planning, artifact_generation,
// human_approval, automated_build, automated_check. git_operation/deployment/
// rollback are declared for forward-compat but rejected until integrations
// exist — a template must never promise a stage the engine can't run.
// ---------------------------------------------------------------------------

export const EXECUTABLE_STAGE_TYPES = [
  "trigger",
  "planning",
  "artifact_generation",
  "human_approval",
  "automated_build",
  "automated_check",
] as const;

export type StageType = (typeof EXECUTABLE_STAGE_TYPES)[number];

const stageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(EXECUTABLE_STAGE_TYPES),
  /** human_approval: named approver user ids, or "requesting_user" */
  approvers: z.array(z.string().min(1)).min(1).optional(),
  /** artifact_generation: logical name of the produced artifact */
  output: z.string().min(1).optional(),
  /** automated_build: artifact (by output name) the build is scope-locked to */
  scope: z.string().min(1).optional(),
  /** automated_check: named checks (informational in this slice) */
  checks: z.array(z.string().min(1)).optional(),
});
export type Stage = z.infer<typeof stageSchema>;

export const workflowDefinitionSchema = z
  .object({
    workflow: z.string().min(1),
    stages: z.array(stageSchema).min(1),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    for (const s of def.stages) {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stage id '${s.id}'` });
      }
      ids.add(s.id);
      if (s.type === "human_approval" && !s.approvers?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `human_approval stage '${s.id}' needs at least one approver`,
        });
      }
      if (s.type === "artifact_generation" && !s.output) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `artifact_generation stage '${s.id}' needs an output name`,
        });
      }
      if (s.type === "automated_build" && s.scope) {
        const producers = def.stages.filter(
          (o) => o.type === "artifact_generation" && o.output === s.scope,
        );
        if (producers.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `build stage '${s.id}' is scoped to artifact '${s.scope}' no stage produces`,
          });
        }
      }
    }
    if (def.stages[0]!.type !== "trigger") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "first stage must be a trigger" });
    }
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export function validateDefinition(raw: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Assignment rules (§4): which template(s) apply to a change, automatically.
// ---------------------------------------------------------------------------

export interface ChangeDescriptor {
  description: string;
  paths: string[];
  changeType: string;
  environment: string;
}

export interface AssignmentRule {
  id: string;
  templateId: string;
  /** glob-ish path pattern: '*' matches within a segment, '**' across segments */
  pathPattern: string | null;
  changeType: string | null;
  environment: string | null;
}

function pathMatches(pattern: string, path: string): boolean {
  const rx = new RegExp(
    "^" +
      pattern
        .split(/(\*\*|\*)/)
        .map((part) =>
          part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
  return rx.test(path);
}

/**
 * A rule matches when every condition it sets is satisfied (conditions are
 * ANDed; unset conditions don't constrain). Returns the DISTINCT template ids
 * of all matching rules — §4 composability: several templates can apply at
 * once and are merged by mergeDefinitions().
 */
export function matchTemplates(
  change: ChangeDescriptor,
  rules: readonly AssignmentRule[],
): string[] {
  const matched: string[] = [];
  for (const rule of rules) {
    if (rule.pathPattern !== null && !change.paths.some((p) => pathMatches(rule.pathPattern!, p)))
      continue;
    if (rule.changeType !== null && rule.changeType !== change.changeType) continue;
    if (rule.environment !== null && rule.environment !== change.environment) continue;
    if (rule.pathPattern === null && rule.changeType === null && rule.environment === null)
      continue; // a rule with no conditions matches nothing rather than everything
    if (!matched.includes(rule.templateId)) matched.push(rule.templateId);
  }
  return matched;
}

/**
 * §4 union/merge: stages of all applicable templates in order, deduped by
 * stage id — the strictest set survives because every template's
 * human-approval stages are retained. Later templates' unseen stages append
 * after the trigger of the merged flow.
 */
export function mergeDefinitions(defs: readonly WorkflowDefinition[]): WorkflowDefinition {
  if (defs.length === 0) throw new Error("mergeDefinitions requires at least one definition");
  if (defs.length === 1) return defs[0]!;
  const seen = new Set<string>();
  const stages: Stage[] = [];
  for (const def of defs) {
    for (const stage of def.stages) {
      if (seen.has(stage.id)) continue;
      if (stage.type === "trigger" && stages.some((s) => s.type === "trigger")) continue;
      seen.add(stage.id);
      stages.push(stage);
    }
  }
  return { workflow: defs.map((d) => d.workflow).join("+"), stages };
}

// ---------------------------------------------------------------------------
// Instance state machine — pure transitions, effects returned to the caller.
// ---------------------------------------------------------------------------

export type StageStatus = "pending" | "active" | "completed" | "reopened";

export type InstanceStatus =
  | "running"
  | "blocked_on_approval"
  | "blocked_on_artifact"
  | "awaiting_trigger"
  | "completed"
  | "aborted"
  | "denied";

export interface InstanceState {
  status: InstanceStatus;
  currentStageIndex: number;
  stageStatuses: StageStatus[];
  /** version of the most recently submitted artifact per artifact name */
  artifactVersions: Record<string, number>;
}

export type WorkflowEvent =
  | { kind: "start" }
  | { kind: "artifact_submitted"; stageId: string }
  | { kind: "approval_granted" }
  | { kind: "approval_denied" }
  | { kind: "human_trigger"; stageId: string }
  | { kind: "stage_completed"; stageId: string }
  | { kind: "abort" };

/** side effects the caller (gateway) must perform after a transition */
export type Effect =
  | { kind: "request_approval"; stageId: string; approvers: string[] }
  | { kind: "await_artifact"; stageId: string; output: string }
  | { kind: "await_human_trigger"; stageId: string }
  | { kind: "instance_completed" }
  | { kind: "instance_denied" }
  | { kind: "instance_aborted" };

export interface TransitionResult {
  state: InstanceState;
  effects: Effect[];
}

export function initialState(def: WorkflowDefinition): InstanceState {
  return {
    status: "running",
    currentStageIndex: 0,
    stageStatuses: def.stages.map(() => "pending"),
    artifactVersions: {},
  };
}

function stageAt(def: WorkflowDefinition, index: number): Stage | undefined {
  return def.stages[index];
}

/**
 * Advance from the current stage through every auto-completing stage until a
 * blocking stage (approval / artifact / human trigger) or the end.
 *
 * Blocking semantics per §2: artifact_generation waits for a submitted
 * artifact; human_approval waits for the named approver; automated_build and
 * automated_check wait for an explicit human trigger in this slice (no real
 * executors yet) — "decide" and "execute" stay separate user actions.
 */
function runForward(def: WorkflowDefinition, state: InstanceState): TransitionResult {
  const effects: Effect[] = [];
  const s: InstanceState = {
    ...state,
    stageStatuses: [...state.stageStatuses],
    artifactVersions: { ...state.artifactVersions },
  };

  for (;;) {
    const stage = stageAt(def, s.currentStageIndex);
    if (!stage) {
      s.status = "completed";
      effects.push({ kind: "instance_completed" });
      return { state: s, effects };
    }
    s.stageStatuses[s.currentStageIndex] = "active";

    if (stage.type === "trigger" || stage.type === "planning") {
      // trigger fired at start; planning is a mode marker, not a blocker here
      s.stageStatuses[s.currentStageIndex] = "completed";
      s.currentStageIndex += 1;
      continue;
    }
    if (stage.type === "artifact_generation") {
      const submitted = s.artifactVersions[stage.output!] !== undefined;
      if (!submitted) {
        s.status = "blocked_on_artifact";
        effects.push({ kind: "await_artifact", stageId: stage.id, output: stage.output! });
        return { state: s, effects };
      }
      s.stageStatuses[s.currentStageIndex] = "completed";
      s.currentStageIndex += 1;
      continue;
    }
    if (stage.type === "human_approval") {
      s.status = "blocked_on_approval";
      effects.push({
        kind: "request_approval",
        stageId: stage.id,
        approvers: stage.approvers ?? [],
      });
      return { state: s, effects };
    }
    // automated_build / automated_check: await explicit trigger in this slice
    s.status = "awaiting_trigger";
    effects.push({ kind: "await_human_trigger", stageId: stage.id });
    return { state: s, effects };
  }
}

export function transition(
  def: WorkflowDefinition,
  state: InstanceState,
  event: WorkflowEvent,
): TransitionResult {
  if (state.status === "completed" || state.status === "aborted" || state.status === "denied") {
    throw new Error(`instance is terminal (${state.status}) and accepts no events`);
  }

  if (event.kind === "abort") {
    const s = { ...state, status: "aborted" as const };
    return { state: s, effects: [{ kind: "instance_aborted" }] };
  }

  if (event.kind === "start") {
    return runForward(def, state);
  }

  const current = stageAt(def, state.currentStageIndex);

  if (event.kind === "artifact_submitted") {
    const producer = def.stages.find(
      (st) => st.id === event.stageId && st.type === "artifact_generation",
    );
    if (!producer) throw new Error(`no artifact_generation stage '${event.stageId}'`);
    const producerIndex = def.stages.findIndex((st) => st.id === event.stageId);
    const version = (state.artifactVersions[producer.output!] ?? 0) + 1;
    const s: InstanceState = {
      ...state,
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions, [producer.output!]: version },
    };

    // §2 stage 4: an edit AFTER the artifact stage completed re-opens the
    // workflow at that stage — downstream sign-offs are stale and re-run.
    if (producerIndex < state.currentStageIndex) {
      for (let i = producerIndex; i < s.stageStatuses.length; i++) {
        if (s.stageStatuses[i] !== "pending") s.stageStatuses[i] = "reopened";
      }
      s.currentStageIndex = producerIndex;
      s.status = "running";
      return runForward(def, s);
    }
    if (current?.id !== event.stageId) {
      throw new Error(`instance is not waiting on artifact stage '${event.stageId}'`);
    }
    s.status = "running";
    return runForward(def, s);
  }

  if (event.kind === "approval_granted") {
    if (current?.type !== "human_approval") {
      throw new Error("instance is not blocked on an approval");
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  if (event.kind === "approval_denied") {
    if (current?.type !== "human_approval") {
      throw new Error("instance is not blocked on an approval");
    }
    const s = { ...state, status: "denied" as const };
    return { state: s, effects: [{ kind: "instance_denied" }] };
  }

  if (event.kind === "human_trigger" || event.kind === "stage_completed") {
    if (!current || current.id !== event.stageId) {
      throw new Error(`instance is not waiting on stage '${event.stageId}'`);
    }
    if (current.type !== "automated_build" && current.type !== "automated_check") {
      throw new Error(`stage '${event.stageId}' is not triggerable`);
    }
    const s: InstanceState = {
      ...state,
      status: "running",
      stageStatuses: [...state.stageStatuses],
      artifactVersions: { ...state.artifactVersions },
    };
    s.stageStatuses[s.currentStageIndex] = "completed";
    s.currentStageIndex += 1;
    return runForward(def, s);
  }

  throw new Error(`unhandled event`);
}
