/**
 * ADR-0348: the declared lifecycles. One table per lifecycle column; the inventory of every machine in the
 * app (declared, already explicit elsewhere, or a follow-up) is internal/product/STATE_MACHINES.md.
 *
 * Each table's states equal the column's CHECK constraint; a gateway test holds the two equal.
 */
import { defineMachine, type StateMachine } from "./state-machine.js";
import { MCP_ADMISSION_STATES } from "./mcp-admission.js";
import { INCIDENT_STATUSES } from "./accountability.js";

/** `training_jobs.status` (ADR-0065). Same values as `TRAINING_JOB_STATUSES` in @regulait/db. */
export const TRAINING_JOB_MACHINE = defineMachine({
  id: "training_job",
  stored: "training_jobs.status",
  states: ["pending_approval", "queued", "running", "succeeded", "failed", "cancelled", "refused"],
  initial: ["pending_approval", "queued"],
  terminal: ["succeeded", "failed", "cancelled", "refused"],
  transitions: {
    approve: {
      from: ["pending_approval"],
      to: "queued",
      by: ["approver"],
      summary: "An approver accepted the estimated cost in the Approvals Queue; the job may start.",
    },
    deny: {
      from: ["pending_approval"],
      to: "cancelled",
      by: ["approver"],
      summary: "An approver refused the estimated cost; the job never starts.",
    },
    start: {
      from: ["queued"],
      to: "running",
      by: ["system"],
      summary: "The gateway handed the job to its training backend.",
    },
    succeed: {
      from: ["running"],
      to: "succeeded",
      by: ["worker"],
      summary: "The backend finished and the artifact was recorded.",
    },
    fail: {
      from: ["running"],
      to: "failed",
      by: ["worker"],
      summary: "The backend tried and the job broke.",
    },
    refuse: {
      from: ["running"],
      to: "refused",
      by: ["system"],
      summary: "Nothing was tried: the backend is not configured, blocked by egress policy, or cannot do this method.",
    },
    cancel: {
      from: ["pending_approval", "queued", "running"],
      to: "cancelled",
      by: ["user", "worker"],
      summary: "Someone cancelled the job, or the backend reported it cancelled.",
    },
  },
});

/** `mcp_servers.admission_state` (ADR-0042, ADR-0100, ADR-0242). The next state of a scan is computed by
 * `nextAdmissionState`; this table is what that result, and every other writer, must stay inside. */
export const MCP_ADMISSION_MACHINE = defineMachine({
  id: "mcp_admission",
  stored: "mcp_servers.admission_state",
  states: MCP_ADMISSION_STATES,
  initial: ["unscanned", "grandfathered"],
  terminal: [],
  transitions: {
    scan_passed: {
      from: ["grandfathered", "unscanned", "clean", "held", "cleared"],
      to: "clean",
      by: ["system", "worker"],
      summary: "A manifest scan (live sync, scheduled re-scan or the admission engine) found nothing that holds.",
    },
    scan_held: {
      from: ["grandfathered", "unscanned", "clean", "held", "cleared"],
      to: "held",
      by: ["system", "worker"],
      summary: "A manifest scan found something that holds the server, or the cleared manifest changed and scans dirty.",
    },
    clearance_kept: {
      from: ["cleared"],
      to: "cleared",
      by: ["system"],
      summary: "A re-scan of exactly the manifest an admin cleared keeps the clearance.",
    },
    admin_cleared: {
      from: ["held"],
      to: "cleared",
      by: ["admin"],
      summary: "An admin reviewed the findings and admitted this manifest digest, with a reason and a step-up.",
    },
    endpoint_changed: {
      from: ["grandfathered", "unscanned", "clean", "held", "cleared"],
      to: "unscanned",
      by: ["admin"],
      summary: "The server's program or address changed, so the next manifest is adjudicated from scratch.",
    },
  },
});

/** `ai_incidents.status` (ADR-0182 A12, the AI incident register). Open, contained and resolved move freely between each other by an
 * edit (a responder's triage, including a re-open); closing is its own route, needs every clock final and every
 * corrective action done or cancelled, and is final. */
export const INCIDENT_MACHINE = defineMachine({
  id: "incident",
  stored: "ai_incidents.status",
  states: INCIDENT_STATUSES,
  initial: ["open"],
  terminal: ["closed"],
  transitions: {
    contain: {
      from: ["open", "resolved"],
      to: "contained",
      by: ["user", "admin"],
      summary: "A responder marks the incident contained: the harm has stopped spreading.",
    },
    contain_by_halt: {
      from: ["open"],
      to: "contained",
      by: ["admin", "agent"],
      summary: "Halting a linked agent from the incident contains an open incident (POST .../contain).",
    },
    resolve: {
      from: ["open", "contained"],
      to: "resolved",
      by: ["user", "admin"],
      summary: "A responder marks the incident resolved; this releases nothing.",
    },
    reopen: {
      from: ["contained", "resolved"],
      to: "open",
      by: ["user", "admin"],
      summary: "A responder re-opens the incident.",
    },
    close: {
      from: ["open", "contained", "resolved"],
      to: "closed",
      by: ["user", "admin"],
      summary:
        "Close with the root cause and lessons learned, once every notification clock is final and every corrective " +
        "action is done or cancelled. Closing a serious, high or critical incident is an admin's (it releases the deploy gate).",
    },
  },
});

/** `eval_runs.status` (ADR-0056). A run is inserted `running` and finishes `completed`; an engine ledger row is
 * inserted already `completed`. `error` is written when the runner throws after the run exists (ADR-0348; before,
 * such a run stayed `running` forever and blocked its red-team library's retirement). `denied` is in the column's
 * CHECK but no code writes it today; it is declared so the table covers every stored value. */
export const EVAL_RUN_MACHINE = defineMachine({
  id: "eval_run",
  stored: "eval_runs.status",
  states: ["running", "completed", "error", "denied"],
  initial: ["running", "completed", "denied"],
  terminal: ["completed", "error", "denied"],
  transitions: {
    complete: {
      from: ["running"],
      to: "completed",
      by: ["system"],
      summary: "Every case was dispatched and scored, and the aggregate and gate verdict were recorded.",
    },
    crash: {
      from: ["running"],
      to: "error",
      by: ["system"],
      summary: "The runner failed after the run started; the error is recorded and nothing is scored.",
    },
  },
});

/** `rule_step_suggestions.status` (ADR-0327). A scan inserts `suggested`. Shadow mode measures the suggested rule
 * beside the AI without changing routing, and can be stopped and started again. Dismissal is final: a rescan
 * refreshes a dismissed suggestion's evidence but never its status. */
export const RULE_STEP_SUGGESTION_MACHINE = defineMachine({
  id: "rule_step_suggestion",
  stored: "rule_step_suggestions.status",
  states: ["suggested", "shadow", "dismissed"],
  initial: ["suggested"],
  terminal: ["dismissed"],
  transitions: {
    shadow_start: {
      from: ["suggested"],
      to: "shadow",
      by: ["admin"],
      summary: "An admin starts measuring the suggested rule against live traffic; the AI still answers every request.",
    },
    shadow_stop: {
      from: ["shadow"],
      to: "suggested",
      by: ["admin"],
      summary: "An admin stops the measurement; the counts so far are kept and a rescan may refresh the suggestion again.",
    },
    dismiss: {
      from: ["suggested"],
      to: "dismissed",
      by: ["admin"],
      summary: "An admin dismisses the suggestion; it is never suggested again for this step.",
    },
  },
});

/** `robot_versions.status` (ADR-0364 §8). A version is edited only while `draft`; once submitted its content is
 * frozen (a trigger), and a rejected or retired version is never reopened: a fix is a new version number. */
export const ROBOT_VERSION_STATES = ["draft", "in_review", "approved", "rejected", "retired"] as const;
export type RobotVersionState = (typeof ROBOT_VERSION_STATES)[number];
export const ROBOT_VERSION_MACHINE = defineMachine({
  id: "robot_version",
  stored: "robot_versions.status",
  states: ROBOT_VERSION_STATES,
  initial: ["draft"],
  terminal: ["rejected", "retired"],
  transitions: {
    submit: {
      from: ["draft"],
      to: "in_review",
      by: ["user"],
      summary: "The author sends the version for review in the Approvals Queue; it needs a passing test run on its exact digest.",
    },
    approve: {
      from: ["in_review"],
      to: "approved",
      by: ["approver"],
      summary: "A reviewer who is not the author approved the version; it becomes one pinned tool on the Robots server.",
    },
    reject: {
      from: ["in_review"],
      to: "rejected",
      by: ["approver", "system"],
      summary: "A reviewer refused the version, or its robot was retired while it waited; the record of what was refused is kept.",
    },
    discard: {
      from: ["draft"],
      to: "rejected",
      by: ["system"],
      summary: "The robot was retired while this version was still a draft; it was never submitted.",
    },
    retire: {
      from: ["approved"],
      to: "retired",
      by: ["user", "admin", "system"],
      summary: "The version's tool is blocked; agents that pinned it show it as unavailable and calls are refused.",
    },
  },
});

/** `robots.status` (ADR-0364 §8): the robot's own lifecycle. The list's "Status" column is computed from the
 * versions on read (`robotListStatus`), never stored. */
export const ROBOT_STATES = ["active", "retired"] as const;
export type RobotState = (typeof ROBOT_STATES)[number];
export const ROBOT_MACHINE = defineMachine({
  id: "robot",
  stored: "robots.status",
  states: ROBOT_STATES,
  initial: ["active"],
  terminal: ["retired"],
  transitions: {
    retire: {
      from: ["active"],
      to: "retired",
      by: ["user", "admin"],
      summary: "The robot is retired: every approved version is retired and every draft or in-review version is rejected, in one transaction.",
    },
  },
});

/** `robot_runs.status` (ADR-0364 §8). S2 records runs; the sandbox runner that moves them is S3. */
export const ROBOT_RUN_STATES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "refused"] as const;
export type RobotRunState = (typeof ROBOT_RUN_STATES)[number];
export const ROBOT_RUN_MACHINE = defineMachine({
  id: "robot_run",
  stored: "robot_runs.status",
  states: ROBOT_RUN_STATES,
  initial: ["queued"],
  terminal: ["succeeded", "failed", "timed_out", "cancelled", "refused"],
  transitions: {
    start: { from: ["queued"], to: "running", by: ["system"], summary: "The sandbox placement was accepted and the runner started." },
    succeed: { from: ["running"], to: "succeeded", by: ["worker"], summary: "Every step ran and the outputs matched the output schema." },
    fail: { from: ["running"], to: "failed", by: ["worker"], summary: "A step failed; the run stopped with evidence." },
    time_out: { from: ["running"], to: "timed_out", by: ["worker", "system"], summary: "The run hit its wall-clock or step limit." },
    cancel: {
      from: ["queued", "running"],
      to: "cancelled",
      by: ["user", "system"],
      summary: "Someone cancelled the run, or the kill switch halted it at the next step.",
    },
    refuse: {
      from: ["queued"],
      to: "refused",
      by: ["system"],
      summary: "Nothing ran: the placement, the egress list or a secret could not be resolved.",
    },
  },
});

/** ADR-0364 §8: the Robots list's "Status" column, computed from the robot and its versions (never stored). */
export type RobotListStatus = "draft" | "in_review" | "approved" | "retired";
export function robotListStatus(robot: RobotState, versions: readonly RobotVersionState[]): RobotListStatus {
  if (robot === "retired") return "retired";
  if (versions.includes("approved")) return "approved";
  if (versions.includes("in_review")) return "in_review";
  return "draft";
}

/** Every declared machine, by id: the one list an agent or a document reads. */
export const STATE_MACHINES: Readonly<Record<string, StateMachine<string, string>>> = Object.freeze({
  [TRAINING_JOB_MACHINE.def.id]: TRAINING_JOB_MACHINE,
  [MCP_ADMISSION_MACHINE.def.id]: MCP_ADMISSION_MACHINE,
  [INCIDENT_MACHINE.def.id]: INCIDENT_MACHINE,
  [EVAL_RUN_MACHINE.def.id]: EVAL_RUN_MACHINE,
  [RULE_STEP_SUGGESTION_MACHINE.def.id]: RULE_STEP_SUGGESTION_MACHINE,
  [ROBOT_VERSION_MACHINE.def.id]: ROBOT_VERSION_MACHINE,
  [ROBOT_MACHINE.def.id]: ROBOT_MACHINE,
  [ROBOT_RUN_MACHINE.def.id]: ROBOT_RUN_MACHINE,
} as Record<string, StateMachine<string, string>>);
