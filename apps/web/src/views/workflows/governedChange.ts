/**
 * The governed change, end to end: the pure model behind ChangeTimeline.
 *
 * Two views of one workflow instance, both read from data the detail endpoint
 * already returns (GET /v1/workflows/instances/:instanceId, its `events`) and
 * the instance's PM links (GET /v1/pm/links?instanceId=…):
 *
 *  - the CHAIN: the change in seven steps (work item → plan → sign-off →
 *    build → pull request → checks → merge approval), each step's state derived
 *    from the template's own stages. A step the template does not contain says
 *    so; it is never shown as done.
 *  - the HISTORY: every recorded workflow event, oldest first, as a sentence.
 *    Sentences only name what the event carries; nothing is invented. The server
 *    returns the events oldest first (workflows.ts), so the order is kept as sent.
 *
 * Logic only; ChangeTimeline.tsx renders it (ADR-0200 #2).
 */
import { humanize, plural } from "../../api/format";
import type { CheckResult, WorkflowDetailResponse, WorkflowStage } from "../../api/types";

/** one row of `workflow_events`, as the detail endpoint returns it */
export interface WorkflowEventRow {
  id: string;
  at: string;
  actorUserId?: string | null;
  // the server's own error and reason text is deliberately not read: history lines are fixed sentences
  event: { kind: string; stageId?: string; failures?: string[] };
}

export type ChainStepId = "work_item" | "plan" | "sign_off" | "build" | "pull_request" | "checks" | "merge_approval";
export type ChainState = "done" | "current" | "attention" | "to_do" | "unknown" | "not_in_template";

/**
 * What the PM-links read told us. `hidden` is the server's own rule: the links
 * route admits an admin, the initiator or a pending approver, so a past approver
 * can open the page but not the links. That is not an error.
 */
export type PmLinksRead =
  | { state: "loading" }
  | { state: "error" }
  | { state: "hidden" }
  | { state: "ok"; links: Array<{ orphanedAt?: string | null }> };

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
  unknown: "Unknown",
  not_in_template: "Not in template",
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

/** a stage's recorded check results, from the context the page already reads */
const failedChecks = (ctx: Record<string, unknown>, stageId: string) =>
  ((ctx[`checks:${stageId}`] as CheckResult[] | undefined) ?? []).filter((c) => c.status === "failed").length;

export function buildChain(detail: WorkflowDetailResponse, pm: PmLinksRead): ChainStep[] {
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
    if (idx.length === 0) return { id, label, state: "not_in_template", detail: "No such stage" };
    const done = idx.filter((i) => statuses[i] === "completed").length;
    const holdsCurrent = !terminal && idx.includes(instance.state.currentStageIndex);
    const stuckHere = idx.includes(instance.state.currentStageIndex) && STUCK.has(instance.status);
    let state: ChainState = done === idx.length ? "done" : holdsCurrent ? "current" : "to_do";
    if (stuckHere) state = "attention";
    let line = `${done} of ${plural(idx.length, "stage")} complete`;
    if (stuckHere) line = humanize(instance.status);
    if (id === "checks") {
      // A post-deploy verify that fails is marked completed before the kernel jumps to rollback, so
      // "every stage completed" is not "every check passed": read the recorded results too.
      const failed = idx.reduce((n, i) => n + failedChecks(ctx, stages[i]!.id), 0);
      if (failed > 0) {
        state = "attention";
        line = `${plural(failed, "check")} failed`;
      } else if (instance.status === "rolled_back") {
        state = "attention";
        line = "The change was rolled back";
      }
    }
    return { id, label, state, detail: line };
  };

  const wi = (state: ChainState, detail: string): ChainStep => ({ id: "work_item", label: CHAIN_LABELS.work_item, state, detail });
  // an orphaned link (its item was deleted or moved in the PM tool) is not a linked work item
  const live = pm.state === "ok" ? pm.links.filter((l) => !l.orphanedAt).length : 0;
  const workItem: ChainStep =
    pm.state === "loading"
      ? wi("unknown", "Reading")
      : pm.state === "error"
        ? wi("unknown", "Could not read the linked work items")
        : pm.state === "hidden"
          ? wi("unknown", "Not visible to you")
          : live > 0
            ? wi("done", `${plural(live, "linked work item")}`)
            : wi("to_do", "No work item linked");

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
const stageWords = (stageId: string | undefined) =>
  stageId ? humanize(stageId).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) : "the workflow";

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
      return `Stage ${at} failed`;
    case "check_failed": {
      const n = e.failures?.length ?? 0;
      return `Checks failed at ${at}${n ? ` (${plural(n, "check")})` : ""}`;
    }
    case "recheck":
      return `Checks run again at ${at}`;
    case "deploy_blocked":
      return `Deploy held at ${at}`;
    case "deploy_override":
      return `Deploy hold resolved by hand at ${at}`;
    case "rolled_back":
      return `Rolled back at ${at}`;
    case "reopen":
      return `Reopened to ${at}`;
    case "abort":
      return "Workflow aborted";
    default:
      return humanize(e.kind);
  }
}
