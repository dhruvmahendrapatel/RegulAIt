/**
 * ADR-0232 §2 — the pipeline step catalogue, as built by lane E49 slice 1 on top of ADR-0341.
 *
 * ADR-0341 made the workflow template the pipeline document, so a step that can run today is exactly one workflow
 * stage type, executed by the existing governed workflow engine (ADR-0254: the stage runner stays the engine). Every
 * other step ADR-0232 §2 lists is declared here as `planned`, with the build-plan slice (§12) that brings it, so the
 * palette, the API and an agent read one list and nothing promises a step the engine cannot run.
 *
 * Pure data: no I/O. `GET /v1/pipelines/catalogue` serves it; a gateway test holds the `available` entries equal to
 * the workflow kernel's `EXECUTABLE_STAGE_TYPES`.
 */

export const PIPELINE_STEP_GROUPS = ["triggers", "ai", "calls", "control", "governance", "data", "advanced"] as const;
export type PipelineStepGroup = (typeof PIPELINE_STEP_GROUPS)[number];

export interface PipelineStepType {
  /** stable id; for an available step it equals its workflow stage type */
  id: string;
  group: PipelineStepGroup;
  label: string;
  /** `available`: runs today as the workflow stage `stageType`; `planned`: declared by ADR-0232, not yet runnable */
  availability: "available" | "planned";
  /** the workflow stage type that runs this step (available steps only) */
  stageType: string | null;
  /** the existing governed primitive the step is executed through; the pipeline never calls anything itself */
  builtOn: string;
  /** the step can change something outside the run (code, infrastructure, a record, an external system) */
  writes: boolean;
  /** ADR-0232 §3: an automatic retry is allowed only for a step that does not write; a write is never retried */
  autoRetry: boolean;
  /** ADR-0232 §12 build-plan slice that delivers a planned step; null when available */
  plannedSlice: number | null;
}

type Entry = Omit<PipelineStepType, "autoRetry" | "stageType" | "availability" | "plannedSlice">;

const available = (e: Entry): PipelineStepType => ({
  ...e,
  availability: "available",
  stageType: e.id,
  autoRetry: !e.writes,
  plannedSlice: null,
});
const planned = (slice: number, e: Entry): PipelineStepType => ({
  ...e,
  availability: "planned",
  stageType: null,
  autoRetry: !e.writes,
  plannedSlice: slice,
});

export const PIPELINE_STEP_CATALOGUE: readonly PipelineStepType[] = Object.freeze([
  // available: one per executable workflow stage type
  available({ id: "trigger", group: "triggers", label: "Manual trigger", builtOn: "workflow engine: waits for a person or the system to trigger the next stage", writes: false }),
  available({ id: "planning", group: "governance", label: "Plan gate", builtOn: "workflow engine: the forced plan-only stage (ADR-0079, ADR-0250)", writes: false }),
  available({ id: "artifact_generation", group: "ai", label: "Requirements artifact", builtOn: "workflow engine: a versioned artifact submitted to the instance", writes: false }),
  available({ id: "human_approval", group: "governance", label: "Approval", builtOn: "approvals queue: a sign-off with quorum and pool exclusion", writes: false }),
  available({ id: "automated_build", group: "ai", label: "Governed build", builtOn: "pillar 7 orchestration runner: a nested governed run inside the user's ceiling", writes: true }),
  available({ id: "automated_check", group: "governance", label: "Automated check", builtOn: "named checks and engine runs reported against the instance round", writes: false }),
  available({ id: "git_operation", group: "calls", label: "Git operation", builtOn: "governed git connection (branch, PR, merge, compensation)", writes: true }),
  available({ id: "deployment", group: "calls", label: "Deployment", builtOn: "governed deploy target, behind an earlier approval and check", writes: true }),
  available({ id: "rollback", group: "calls", label: "Rollback", builtOn: "governed deploy target: reverses a deployment", writes: true }),
  // planned: ADR-0232 §2, with the §12 slice that builds each
  planned(6, { id: "schedule", group: "triggers", label: "Schedule", builtOn: "scheduler (ADR-0064) with cron expressions", writes: false }),
  planned(6, { id: "inbound_webhook", group: "triggers", label: "Inbound webhook", builtOn: "inbound channel pattern: HMAC plus replay window (ADR-0173)", writes: false }),
  planned(6, { id: "pm_event", group: "triggers", label: "PM-tool event", builtOn: "pillar 8 inbound sync", writes: false }),
  planned(11, { id: "called_by_stage", group: "triggers", label: "Called by a workflow stage", builtOn: "pillar 2 stage type `pipeline`", writes: false }),
  planned(4, { id: "called_by_pipeline", group: "triggers", label: "Called by another pipeline", builtOn: "sub-pipeline as the caller's actor", writes: false }),
  planned(3, { id: "agent", group: "ai", label: "Agent", builtOn: "builder agent through the governed invoke path, optimiser applied", writes: true }),
  planned(3, { id: "model_call", group: "ai", label: "Model call", builtOn: "model binding through the governed invoke path, with an output schema", writes: false }),
  planned(3, { id: "remote_agent", group: "ai", label: "Remote agent", builtOn: "governed A2A call (ADR-0219)", writes: true }),
  planned(11, { id: "agent_team", group: "ai", label: "Agent team", builtOn: "pillar 7 lead/worker orchestration runner", writes: true }),
  planned(3, { id: "tool", group: "calls", label: "Tool", builtOn: "governed MCP tool call, single attempt (ADR-0129)", writes: true }),
  planned(3, { id: "connector", group: "calls", label: "Connector", builtOn: "governed connector call (egress guard, credentials, PII)", writes: true }),
  planned(4, { id: "router", group: "control", label: "Router", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "parallel", group: "control", label: "Parallel", builtOn: "pipeline control flow, ceilings from orchestration-kernel", writes: false }),
  planned(4, { id: "join", group: "control", label: "Join", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "for_each", group: "control", label: "For each", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "gather", group: "control", label: "Gather", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "loop", group: "control", label: "Loop (bounded)", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "sub_pipeline", group: "control", label: "Sub-pipeline", builtOn: "a governed run as the caller's actor", writes: false }),
  planned(4, { id: "wait", group: "control", label: "Wait / timer", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "error_handler", group: "control", label: "Error handler", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "fail", group: "control", label: "Fail", builtOn: "pipeline control flow", writes: false }),
  planned(4, { id: "escalate", group: "control", label: "Escalate", builtOn: "approvals queue", writes: false }),
  planned(3, { id: "guardrail_check", group: "governance", label: "Guardrail check", builtOn: "guardrail engine (ADR-0042)", writes: false }),
  planned(3, { id: "budget_checkpoint", group: "governance", label: "Budget checkpoint", builtOn: "project budget gate (preDispatchProjectGate)", writes: false }),
  planned(7, { id: "set", group: "data", label: "Set variables", builtOn: "pipeline data steps", writes: false }),
  planned(7, { id: "map", group: "data", label: "Map", builtOn: "pipeline data steps", writes: false }),
  planned(7, { id: "transform", group: "data", label: "Transform", builtOn: "pipeline data steps", writes: false }),
  planned(7, { id: "validate", group: "data", label: "Validate", builtOn: "JSON Schema validation", writes: false }),
  planned(7, { id: "convert", group: "data", label: "Convert", builtOn: "pipeline data steps", writes: false }),
  planned(7, { id: "filter", group: "data", label: "Filter", builtOn: "pipeline data steps", writes: false }),
  planned(7, { id: "lookup", group: "data", label: "Lookup", builtOn: "value table", writes: false }),
  planned(7, { id: "data_store", group: "data", label: "Data store", builtOn: "project-scoped data store with a TTL", writes: true }),
  planned(12, { id: "code", group: "advanced", label: "Code (sandboxed, off by default)", builtOn: "sandbox-executor, gVisor backend only", writes: true }),
  planned(12, { id: "aggregator", group: "advanced", label: "Aggregator (off by default)", builtOn: "data store, correlated across runs", writes: true }),
]);

/** the catalogue entry for a workflow stage type, or undefined for a type the catalogue does not run */
export function pipelineStepForStageType(stageType: string): PipelineStepType | undefined {
  return PIPELINE_STEP_CATALOGUE.find((s) => s.availability === "available" && s.stageType === stageType);
}
