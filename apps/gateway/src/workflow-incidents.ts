/**
 * ADR-0349 (slice 5 extension, owner 2026-11-17; Camunda gap row 7): the incident console for stuck or failed
 * workflow instances. Derived on read from the pending-work view (`describePendingWork`), so it cannot drift from
 * what the engine does. An instance is an incident when it waits on:
 *
 *   failed_stage    an executed stage failed and no retry is queued (`advance`)
 *   check_failed    a required check failed (blocked_on_check)
 *   deploy_handoff  a deploy is parked for a manual handoff
 *   stuck_claim     an executor claimed the stage and its lease lapsed without a result
 *
 * Three actions, each admin-only (the default admin gate), audited, and run through the kernel's declared
 * transitions (`transition()`), never by writing state:
 *
 *   retry   re-run the current stage: the executor for an executed stage, `recheck` for a failed check
 *   skip    `stage_skipped`, only on a check stage whose template sets `skippable`, never while an executor holds
 *           it, and with a `settings_relax` step-up; the instance runs on and stops at the next sign-off
 *   cancel  `abort`
 *
 * `actionsFor` says, per action, whether it is allowed now and in plain words why not, for people, the UI and agents.
 */
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import type { describePendingWork } from "./workflow-pending.js";

export const INCIDENT_KINDS = ["failed_stage", "check_failed", "deploy_handoff", "stuck_claim"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export const INCIDENT_ACTIONS = ["retry", "skip", "cancel"] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

type PendingView = ReturnType<typeof describePendingWork>;

/** the incident an instance is in, or null when it is waiting normally (or has ended) */
export function incidentOf(view: PendingView): IncidentKind | null {
  if (view.waitingOn === "advance") return "failed_stage";
  if (view.waitingOn === "check_failed") return "check_failed";
  if (view.waitingOn === "deploy_handoff") return "deploy_handoff";
  if (view.claim && !view.claim.live) return "stuck_claim";
  return null;
}

export interface ActionView {
  action: IncidentAction;
  allowed: boolean;
  /** set when not allowed: why, in words a person or an agent can act on */
  reason?: string;
  /** skip only: the step-up it needs */
  stepUp?: "settings_relax";
}

/** what each incident action would do on this instance now */
export function actionsFor(
  view: PendingView,
  row: { definition: unknown; state: unknown; status: string },
): ActionView[] {
  const def = row.definition as WorkflowDefinition;
  const stage = def.stages[(row.state as InstanceState).currentStageIndex];
  const terminal = view.waitingOn === "nothing";
  const running = view.claim?.live === true;
  const executed =
    !!stage &&
    (stage.type === "git_operation" ||
      stage.type === "deployment" ||
      stage.type === "rollback" ||
      (stage.type === "automated_build" && stage.run !== undefined) ||
      (stage.type === "automated_check" && (stage.checks?.length ?? 0) > 0));

  const retry: ActionView = { action: "retry", allowed: false };
  if (terminal) retry.reason = "the instance has ended";
  else if (running) retry.reason = "an executor is running the stage now; wait for its lease to lapse";
  else if (row.status === "blocked_on_check") retry.allowed = true;
  else if (row.status === "awaiting_execution" && executed) retry.allowed = true;
  else retry.reason = `the current stage is not one the engine executes (status ${row.status})`;
  if (retry.allowed) delete retry.reason;

  const skip: ActionView = { action: "skip", allowed: false, stepUp: "settings_relax" };
  if (terminal) skip.reason = "the instance has ended";
  else if (!stage || stage.type !== "automated_check" || stage.skippable !== true) {
    skip.reason = "the template does not allow this stage to be skipped (only a check stage marked skippable can be)";
  } else if (row.status !== "awaiting_execution" && row.status !== "blocked_on_check") {
    skip.reason = `the instance is not waiting on that stage (status ${row.status})`;
  } else if (running) skip.reason = "an executor is running the stage now; wait for its lease to lapse";
  else skip.allowed = true;
  if (skip.allowed) delete skip.reason;

  const cancel: ActionView = terminal ? { action: "cancel", allowed: false, reason: "the instance has ended" } : { action: "cancel", allowed: true };
  return [retry, skip, cancel];
}
