/**
 * ADR-0348: the declared lifecycles. One table per lifecycle column; the inventory of every machine in the
 * app (declared, already explicit elsewhere, or a follow-up) is internal/product/STATE_MACHINES.md.
 *
 * Each table's states equal the column's CHECK constraint; a gateway test holds the two equal.
 */
import { defineMachine, type StateMachine } from "./state-machine.js";
import { MCP_ADMISSION_STATES } from "./mcp-admission.js";
import { FAIRNESS_BREACH_REVIEW_STATUSES, FAIRNESS_EVALUATION_STATUSES } from "./fairness-evaluation.js";

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

/** `fairness_breach_reviews.status` (ADR-0346 decision 8). A breaching run opens one review in the Approvals Queue;
 * an approver accepts it (time-boxed risk acceptance, at most 90 days) or rejects it; a later passing run
 * supersedes it. A lapsed acceptance stays `accepted` with its end date in the past: time decides it, not a write. */
export const FAIRNESS_BREACH_REVIEW_MACHINE = defineMachine({
  id: "fairness_breach_review",
  stored: "fairness_breach_reviews.status",
  states: FAIRNESS_BREACH_REVIEW_STATUSES,
  initial: ["pending"],
  terminal: ["rejected", "superseded"],
  transitions: {
    accept: {
      from: ["pending"],
      to: "accepted",
      by: ["approver"],
      summary: "An approver accepted the breach with a reason and an end date; until then the run no longer holds the card.",
    },
    reject: {
      from: ["pending"],
      to: "rejected",
      by: ["approver"],
      summary: "An approver refused to accept the breach; the run keeps holding the card.",
    },
    supersede: {
      from: ["pending", "accepted"],
      to: "superseded",
      by: ["system"],
      summary: "A later run on the card passed, so this breach no longer decides anything.",
    },
  },
});

/** `fairness_evaluations.status` (ADR-0346 decision 1). Archived, never deleted (its runs cite it); final, so the
 * definition a run executed never changes under it. */
export const FAIRNESS_EVALUATION_MACHINE = defineMachine({
  id: "fairness_evaluation",
  stored: "fairness_evaluations.status",
  states: FAIRNESS_EVALUATION_STATUSES,
  initial: ["active"],
  terminal: ["archived"],
  transitions: {
    archive: {
      from: ["active"],
      to: "archived",
      by: ["admin"],
      summary: "An admin retired the evaluation; its schedule stops and its past runs stay as evidence.",
    },
  },
});

/** Every declared machine, by id: the one list an agent or a document reads. */
export const STATE_MACHINES: Readonly<Record<string, StateMachine<string, string>>> = Object.freeze({
  [TRAINING_JOB_MACHINE.def.id]: TRAINING_JOB_MACHINE,
  [MCP_ADMISSION_MACHINE.def.id]: MCP_ADMISSION_MACHINE,
  [FAIRNESS_BREACH_REVIEW_MACHINE.def.id]: FAIRNESS_BREACH_REVIEW_MACHINE,
  [FAIRNESS_EVALUATION_MACHINE.def.id]: FAIRNESS_EVALUATION_MACHINE,
} as Record<string, StateMachine<string, string>>);
