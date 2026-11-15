/**
 * The governed change, end to end: the pure model behind ChangeTimeline.
 *
 * Two views of one workflow instance, both read from data the detail endpoint
 * already returns (GET /v1/workflows/instances/:instanceId, its `events`) and
 * the instance's PM links (GET /v1/pm/links?instanceId=…):
 *
 *  - the CHAIN: the pilot's story in seven steps (work item → plan → sign-off →
 *    build → pull request → checks → merge approval), each step's state derived
 *    from the template's own stages. A step the template does not contain says
 *    so; it is never shown as done.
 *  - the HISTORY: every recorded workflow event, oldest first, as a sentence.
 *    Sentences only name what the event carries; nothing is invented.
 *
 * Logic only; ChangeTimeline.tsx renders it (ADR-0200 #2).
 */
import { humanize } from "../../api/format";
import type { WorkflowDetailResponse, WorkflowStage } from "../../api/types";

/** one row of `workflow_events`, as the detail endpoint returns it */
export interface WorkflowEventRow {
  id: string;
  at: string;
  actorUserId?: string | null;
  event: { kind: string; stageId?: string; error?: string; reason?: string; failures?: string[] };
}

export type ChainStepId = "work_item" | "plan" | "sign_off" | "build" | "pull_request" | "checks" | "merge_approval";
export type ChainState = "done" | "current" | "attention" | "to_do" | "not_in_template";

export interface ChainStep {
  id: ChainStepId;
  label: string;
  state: ChainState;
  /** one plain line under the label; never a raw code */
  detail: string;
}

export const CHAIN_LABELS: Record<ChainStepId, string> = {
  work_item: "Work item",
  plan: "Plan",
  sign_off: "Plan sign-off",
  build: "Agent build",
  pull_request: "Pull request",
  checks: "Checks",
  merge_approval: "Merge approval",
};

export const CHAIN_STATE_WORDS: Record<ChainState, string> = {
  done: "Done",
  current: "In progress",
  attention: "Needs attention",
  to_do: "Not started",
  not_in_template: "Not in this template",
};

/** instance statuses that mean the current stage is stuck, not merely in progress */
const STUCK = new Set(["blocked_on_check", "denied", "failed", "aborted", "rolled_back"]);
const TERMINAL = new Set(["completed", "denied", "aborted", "rolled_back"]);

/**
 * Which chain step a stage belongs to. A human approval before the first build
 * or git stage is the plan sign-off; one after it is the merge approval.
 */
export function stagePhase(stages: WorkflowStage[], index: number): ChainStepId | null {
  const stage = stages[index];
  if (!stage) return null;
  const firstDelivery = stages.findIndex((s) => s.type === "automated_build" || s.type === "git_operation");
  switch (stage.type) {
    case "planning":
    case "artifact_generation":
      return "plan";
    case "human_approval":
      return firstDelivery === -1 || index < firstDelivery ? "sign_off" : "merge_approval";
    case "automated_build":
      return "build";
    case "git_operation":
      return "pull_request";
    case "automated_check":
      return "checks";
    default:
      return null; // trigger, deployment, rollback: outside the seven-step story
  }
}

export function buildChain(
  detail: WorkflowDetailResponse,
  pm: { count: number; loaded: boolean },
): ChainStep[] {
  const { instance } = detail;
  const stages = instance.definition.stages;
  const statuses = instance.state.stageStatuses;
  const terminal = TERMINAL.has(instance.status);
  const ctx = instance.context ?? {};

  const byPhase = new Map<ChainStepId, number[]>();
  stages.forEach((_, i) => {
    const p = stagePhase(stages, i);
    if (p) byPhase.set(p, [...(byPhase.get(p) ?? []), i]);
  });

  const stageStep = (id: Exclude<ChainStepId, "work_item">): ChainStep => {
    const idx = byPhase.get(id) ?? [];
    const label = CHAIN_LABELS[id];
    if (idx.length === 0) return { id, label, state: "not_in_template", detail: "This template has no such stage" };
    const done = idx.filter((i) => statuses[i] === "completed").length;
    const holdsCurrent = !terminal && idx.includes(instance.state.currentStageIndex);
    const stuckHere = idx.includes(instance.state.currentStageIndex) && STUCK.has(instance.status);
    let state: ChainState = done === idx.length ? "done" : holdsCurrent ? "current" : "to_do";
    if (stuckHere) state = "attention";
    let line = `${done} of ${idx.length} ${idx.length === 1 ? "stage" : "stages"} complete`;
    if (stuckHere) line = humanize(instance.status);
    if (id === "pull_request" && ctx.prUrl) line = state === "done" ? "Opened" : "Opened, not yet complete";
    if (id === "merge_approval" && ctx.mergeSha) line = "Merged";
    return { id, label, state, detail: line };
  };

  const workItem: ChainStep = !pm.loaded
    ? { id: "work_item", label: CHAIN_LABELS.work_item, state: "to_do", detail: "Loading the linked work items" }
    : pm.count > 0
      ? {
          id: "work_item",
          label: CHAIN_LABELS.work_item,
          state: "done",
          detail: pm.count === 1 ? "1 linked work item" : `${pm.count} linked work items`,
        }
      : { id: "work_item", label: CHAIN_LABELS.work_item, state: "to_do", detail: "No work item linked" };

  return [
    workItem,
    stageStep("plan"),
    stageStep("sign_off"),
    stageStep("build"),
    stageStep("pull_request"),
    stageStep("checks"),
    stageStep("merge_approval"),
  ];
}

/** the stage's id in words, or "the workflow" when the event names none */
const stageWords = (stageId: string | undefined) => (stageId ? humanize(stageId) : "the workflow");

/** one history line; only names what the event itself carries */
export function eventSentence(e: WorkflowEventRow["event"]): string {
  const at = stageWords(e.stageId);
  switch (e.kind) {
    case "start":
      return "Workflow started";
    case "artifact_submitted":
      return `Artifact submitted at ${at}`;
    case "approval_granted":
      return `Sign-off granted at ${at}`;
    case "approval_denied":
      return `Sign-off denied at ${at}`;
    case "approval_returned":
      return `Sent back for more information at ${at}`;
    case "human_trigger":
      return `Started by hand at ${at}`;
    case "stage_completed":
      return `Stage ${at} completed`;
    case "execute_stage":
      return `Stage ${at} started running`;
    case "execution_succeeded":
      return `Stage ${at} succeeded`;
    case "execution_failed":
      return `Stage ${at} failed${e.error ? `: ${e.error}` : ""}`;
    case "check_failed": {
      const n = e.failures?.length ?? 0;
      return `Checks failed at ${at}${n ? ` (${n === 1 ? "1 check" : `${n} checks`})` : ""}`;
    }
    case "recheck":
      return `Checks run again at ${at}`;
    case "deploy_blocked":
      return `Deploy held at ${at}${e.reason ? `: ${e.reason}` : ""}`;
    case "deploy_override":
      return `Deploy hold resolved by hand at ${at}`;
    case "rolled_back":
      return `Rolled back at ${at}`;
    case "reopen":
      return `Reopened to ${at}${e.reason ? `: ${e.reason}` : ""}`;
    case "abort":
      return "Workflow aborted";
    default:
      return humanize(e.kind);
  }
}

/** events the tone of a history line follows: failure, refusal, or neither */
export function eventTone(kind: string): "danger" | "warn" | "ok" | "neutral" {
  if (kind === "execution_failed" || kind === "check_failed" || kind === "approval_denied" || kind === "abort") return "danger";
  if (kind === "deploy_blocked" || kind === "approval_returned" || kind === "reopen" || kind === "rolled_back") return "warn";
  if (kind === "approval_granted" || kind === "execution_succeeded" || kind === "stage_completed") return "ok";
  return "neutral";
}

/** the history, oldest first, whatever order the server sent */
export function sortEvents(events: WorkflowEventRow[]): WorkflowEventRow[] {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
