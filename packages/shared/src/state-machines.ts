/**
 * ADR-0348: the declared lifecycles. One table per lifecycle column; the inventory of every machine in the
 * app (declared, already explicit elsewhere, or a follow-up) is internal/product/STATE_MACHINES.md.
 *
 * Each table's states equal the column's CHECK constraint; a gateway test holds the two equal.
 */
import { defineMachine, type StateMachine } from "./state-machine.js";
import { MCP_ADMISSION_STATES } from "./mcp-admission.js";
import { INCIDENT_STATUSES } from "./accountability.js";
import { SHADOW_AI_DISPOSITIONS } from "./shadow-ai.js";

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

/** `shadow_ai_findings.disposition` (ADR-0055). A triage verdict an admin may revise in any direction, re-setting
 * the same one with a new reason included; declared so that is a stated rule rather than an accident. Linking a
 * remediation workflow confirms the finding. */
const ALL_DISPOSITIONS = SHADOW_AI_DISPOSITIONS;
export const SHADOW_AI_FINDING_MACHINE = defineMachine({
  id: "shadow_ai_finding",
  stored: "shadow_ai_findings.disposition",
  states: SHADOW_AI_DISPOSITIONS,
  initial: ["open"],
  terminal: [],
  transitions: {
    reopen: { from: ALL_DISPOSITIONS, to: "open", by: ["admin"], summary: "Put the finding back in the triage queue." },
    confirm: {
      from: ALL_DISPOSITIONS,
      to: "confirmed",
      by: ["admin", "system"],
      summary: "The use is real and needs governance; linking a remediation workflow also confirms it.",
    },
    sanction: { from: ALL_DISPOSITIONS, to: "sanctioned", by: ["admin"], summary: "The use is known and allowed, with a reason." },
    mark_false_positive: {
      from: ALL_DISPOSITIONS,
      to: "false_positive",
      by: ["admin"],
      summary: "The finding is not AI use, with a reason.",
    },
    mark_remediated: { from: ALL_DISPOSITIONS, to: "remediated", by: ["admin"], summary: "The use was brought under governance or stopped." },
  },
});

/** `ai_use_cases.status` (ADR-0080 intake, ADR-0168 review policy). The intake workflow drives it: the sync maps the
 * instance's status onto the use case (`statusForInstance` in use-cases.ts), a returned sign-off parks it at
 * `needs_info`, an expired or re-reviewed approval re-opens it, and an admin retires it. Same values as
 * `AI_USE_CASE_STATUSES` in @regulait/db. */
export const USE_CASE_MACHINE = defineMachine({
  id: "use_case",
  stored: "ai_use_cases.status",
  states: ["proposed", "under_review", "needs_info", "approved", "rejected", "retired"],
  initial: ["proposed"],
  terminal: ["retired"],
  transitions: {
    submit_for_review: {
      from: ["proposed", "needs_info"],
      to: "under_review",
      by: ["system"],
      summary: "The intake reached its sign-off: the use case waits on its reviewers.",
    },
    back_to_draft: {
      from: ["under_review"],
      to: "proposed",
      by: ["system"],
      summary: "The intake went back before its sign-off (a re-opened plan or artifact).",
    },
    return_for_info: {
      from: ["proposed", "under_review"],
      to: "needs_info",
      by: ["approver"],
      summary: "A reviewer returned the sign-off for more information.",
    },
    approve: {
      from: ["proposed", "under_review", "needs_info"],
      to: "approved",
      by: ["approver"],
      summary: "The intake workflow completed: the use case is approved, for a lifetime set by its tier.",
    },
    reject: {
      from: ["proposed", "under_review", "needs_info"],
      to: "rejected",
      by: ["approver"],
      summary: "The intake was denied or aborted.",
    },
    reopen_review: {
      from: ["approved"],
      to: "under_review",
      by: ["admin", "system"],
      summary: "An expired approval (recertification) or an admin's re-review puts the use case back in front of its reviewers.",
    },
    retire: {
      from: ["proposed", "under_review", "needs_info", "approved", "rejected"],
      to: "retired",
      by: ["admin"],
      summary: "An admin retires the use case, with a reason; nothing leaves retired.",
    },
  },
});

/** `approvals.status`, the ONE Approvals Queue (GOVERNANCE_LAYER_SPEC §6). A pending entry is decided once
 * (approved, denied, or for an intake sign-off returned for information); an approved entry is spent by exactly one
 * retried call; an entry the world has moved past (a re-opened stage, an expiry, a changed policy context, a failed
 * signature recheck) is superseded. The column has no CHECK constraint yet (STATE_MACHINES.md §4). */
export const APPROVAL_MACHINE = defineMachine({
  id: "approval",
  stored: "approvals.status",
  states: ["pending", "approved", "denied", "returned", "consumed", "superseded"],
  initial: ["pending"],
  terminal: ["denied", "returned", "consumed", "superseded"],
  transitions: {
    approve: { from: ["pending"], to: "approved", by: ["approver"], summary: "The named approver (or a signed quorum) approved it." },
    deny: { from: ["pending"], to: "denied", by: ["approver"], summary: "The approver denied it, with a reason." },
    return: {
      from: ["pending"],
      to: "returned",
      by: ["approver"],
      summary: "An intake sign-off sent back for more information; the next version asks again in a new entry.",
    },
    consume: { from: ["approved"], to: "consumed", by: ["system"], summary: "The one retried call this approval allowed was made." },
    supersede: {
      from: ["pending", "approved"],
      to: "superseded",
      by: ["system"],
      summary: "The work moved on (re-opened, reassigned, expired, or its policy context changed); the entry can no longer be decided or spent.",
    },
  },
});

/** `redteam_libraries.status` (ADR-0057, ADR-0208 G9). A draft is edited; publishing freezes it into an eval dataset
 * (editing a published library mints the next version); retiring withdraws a draft or a published version for good. */
export const REDTEAM_LIBRARY_MACHINE = defineMachine({
  id: "redteam_library",
  stored: "redteam_libraries.status",
  states: ["draft", "published", "retired"],
  initial: ["draft"],
  terminal: ["retired"],
  transitions: {
    publish: {
      from: ["draft"],
      to: "published",
      by: ["admin"],
      summary: "Freeze the probes into an eval dataset; an empty library is refused.",
    },
    retire: {
      from: ["draft", "published"],
      to: "retired",
      by: ["admin"],
      summary: "Withdraw this version, with a reason (a published one needs a step-up); refused while a run is in progress.",
    },
  },
});

/** Every declared machine, by id: the one list an agent or a document reads. */
export const STATE_MACHINES: Readonly<Record<string, StateMachine<string, string>>> = Object.freeze({
  [TRAINING_JOB_MACHINE.def.id]: TRAINING_JOB_MACHINE,
  [MCP_ADMISSION_MACHINE.def.id]: MCP_ADMISSION_MACHINE,
  [INCIDENT_MACHINE.def.id]: INCIDENT_MACHINE,
  [EVAL_RUN_MACHINE.def.id]: EVAL_RUN_MACHINE,
  [SHADOW_AI_FINDING_MACHINE.def.id]: SHADOW_AI_FINDING_MACHINE,
  [USE_CASE_MACHINE.def.id]: USE_CASE_MACHINE,
  [APPROVAL_MACHINE.def.id]: APPROVAL_MACHINE,
  [REDTEAM_LIBRARY_MACHINE.def.id]: REDTEAM_LIBRARY_MACHINE,
} as Record<string, StateMachine<string, string>>);
