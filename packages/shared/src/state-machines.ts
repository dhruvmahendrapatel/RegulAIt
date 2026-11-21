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
import { ENDPOINT_COMMAND_EXCEPTION_MACHINE } from "./endpoint-command-exceptions.js";
import { CLASSIFIER_VERSION_STATUSES } from "./custom-classifiers.js";
import { AGENT_NHI_LINK_STATUSES } from "./agent-identity.js";
import { VENDOR_ACTION_MACHINE } from "./vendor-agent-control.js";

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

/** `custom_classifier_versions.status` (ADR-0363 slice 2). A version takes effect only through an approval in the
 * one queue; publishing supersedes the classifier's previous published version in the same transaction. */
export const CLASSIFIER_VERSION_MACHINE = defineMachine({
  id: "custom_classifier_version",
  stored: "custom_classifier_versions.status",
  states: CLASSIFIER_VERSION_STATUSES,
  initial: ["draft"],
  terminal: ["rejected", "superseded", "retired"],
  transitions: {
    submit: {
      from: ["draft"],
      to: "pending_approval",
      by: ["admin"],
      summary: "The author submitted the version to a named reviewer; a looser version needs the author's step-up.",
    },
    approve: {
      from: ["pending_approval"],
      to: "published",
      by: ["approver"],
      summary: "The reviewer approved it in the Approvals Queue; it runs in every guardrail scan from the next call.",
    },
    reject: {
      from: ["pending_approval"],
      to: "rejected",
      by: ["approver"],
      summary: "The reviewer denied it; it never takes effect.",
    },
    supersede: {
      from: ["published"],
      to: "superseded",
      by: ["system"],
      summary: "A newer version of the classifier was published.",
    },
    retire: {
      from: ["published"],
      to: "retired",
      by: ["admin"],
      summary: "An admin retired the classifier with a step-up; it stops running.",
    },
  },
});

// ADR-0337 §6 (lane E18; owner decision 2026-11-17)
/**
 * `saas_entitlement_apps.agent_link_state` (ADR-0348 declared machine). An app starts unlinked (`none`). The system
 * links it on an EXACT match between the app's vendor id and an identifier an admin declared for an agent
 * (`auto`, audited); an admin links it by hand (`admin`, for a partial or fuzzy match) or unlinks it (`unlinked`). An
 * unlinked app is never auto-linked again: only an admin can link it.
 */
export const SAAS_APP_AGENT_LINK_MACHINE = defineMachine({
  id: "saas_app_agent_link",
  stored: "saas_entitlement_apps.agent_link_state",
  states: ["none", "auto", "admin", "unlinked"],
  initial: ["none"],
  terminal: [],
  transitions: {
    auto_link: {
      from: ["none"],
      to: "auto",
      by: ["system"],
      summary: "The app's vendor id exactly equals an identifier an admin declared for an agent, so the app is linked to that agent (audited).",
    },
    link: {
      from: ["none", "auto", "admin", "unlinked"],
      to: "admin",
      by: ["admin"],
      summary: "An admin linked the app to an agent (any match, including a partial one), or moved the link to another agent (audited).",
    },
    unlink: {
      from: ["auto", "admin"],
      to: "unlinked",
      by: ["admin"],
      summary: "An admin removed the link (audited); the app is not auto-linked again until an admin links it.",
    },
  },
});
export type SaasAppAgentLinkState = (typeof SAAS_APP_AGENT_LINK_MACHINE.def.states)[number];
/** `detection_incidents.status` (ADR-0333, lane E15). An admin acknowledges an open incident (again, idempotently)
 * or closes it; a closed incident is final, so a later burst raises a new incident instead of reopening this one.
 * Same values as `DETECTION_INCIDENT_STATUSES` in @regulait/db. */
export const DETECTION_INCIDENT_MACHINE = defineMachine({
  id: "detection_incident",
  stored: "detection_incidents.status",
  states: ["open", "acknowledged", "closed"],
  initial: ["open"],
  terminal: ["closed"],
  transitions: {
    acknowledge: {
      from: ["open", "acknowledged"],
      to: "acknowledged",
      by: ["admin"],
      summary: "An admin has seen the incident and is looking into it; nothing about the agent changes.",
    },
    close: {
      from: ["open", "acknowledged"],
      to: "closed",
      by: ["admin"],
      summary: "An admin closes the incident; it is final, and a new match raises a new incident.",
    },
  },
});

/** `detection_incidents.response_state` (ADR-0333 §5). A configured response runs at most once: it either took
 * effect or failed with a fixed code, and neither is retried. An alert-only incident stays `none`.
 * Same values as `DETECTION_RESPONSE_STATES` in @regulait/db. */
export const DETECTION_RESPONSE_MACHINE = defineMachine({
  id: "detection_response",
  stored: "detection_incidents.response_state",
  states: ["none", "done", "failed"],
  initial: ["none"],
  terminal: ["done", "failed"],
  transitions: {
    apply: {
      from: ["none"],
      to: "done",
      by: ["system"],
      summary: "The configured response (suspend the grant, revoke the credential, or require approval) took effect.",
    },
    fail: {
      from: ["none"],
      to: "failed",
      by: ["system"],
      summary: "The configured response could not be applied; the fixed reason is recorded and it is not retried.",
    },
  },
});

/** `endpoint_device_quarantines.status` (ADR-0333 §6, lane E15). A `quarantine_device` detection response opens a
 * quarantine `active`: the device's AI tools are refused until it ends. It ends exactly once, either released by an
 * admin with a step-up (a human decision; widening, so only under the `normal` execution dial) or expired by the
 * system at `expires_at` (also widening, so also only under `normal`). Both ends are final; a later incident opens a
 * new quarantine. Same values as `ENDPOINT_DEVICE_QUARANTINE_STATUSES` in @regulait/db. */
export const ENDPOINT_DEVICE_QUARANTINE_MACHINE = defineMachine({
  id: "endpoint_device_quarantine",
  stored: "endpoint_device_quarantines.status",
  states: ["active", "released", "expired"],
  initial: ["active"],
  terminal: ["released", "expired"],
  transitions: {
    release: {
      from: ["active"],
      to: "released",
      by: ["admin"],
      summary: "An admin released the device after a step-up; its AI tools are governed by the normal policy again.",
    },
    expire: {
      from: ["active"],
      to: "expired",
      by: ["system"],
      summary: "The quarantine reached its end time and the execution dial is normal, so it ended on its own.",
    },
  },
});
export type EndpointDeviceQuarantineState = (typeof ENDPOINT_DEVICE_QUARANTINE_MACHINE.def.states)[number];

/** `rule_step_suggestions.status` (ADR-0327). A scan inserts `suggested`. Shadow mode measures the suggested rule
 * beside the AI without changing routing, and can be stopped and started again. Dismissal is final: a rescan
 * refreshes a dismissed suggestion's evidence but never its status. */
export const RULE_STEP_SUGGESTION_MACHINE = defineMachine({
  id: "rule_step_suggestion",
  stored: "rule_step_suggestions.status",
  states: ["suggested", "shadow", "switched", "dismissed"],
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
    switch: {
      from: ["shadow"],
      to: "switched",
      by: ["approver"],
      summary:
        "The named reviewer approves the switch request; the rule is now the step's answer for inputs it covers, and the AI answers the rest.",
    },
    revert: {
      from: ["switched"],
      to: "suggested",
      by: ["admin"],
      summary: "An admin reverts the switch in one action, with no approval needed; the AI answers every request again.",
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
    time_out: {
      from: ["queued", "running"],
      to: "timed_out",
      by: ["worker", "system"],
      summary: "The run hit its wall-clock or step limit, or the stale-run sweep ended a run no gateway still holds.",
    },
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

/** `agent_identity_links.status` (ADR-0339 slice 2). An admin (or later the importer) stages a link; a second, named
 * admin confirms or rejects it under an `identity_manage` step-up. A link confers nothing in any state. Both outcomes
 * are final today; unlinking a rotated or deleted identity is a later event (triage-low, recorded on #892). */
export const AGENT_NHI_LINK_MACHINE = defineMachine({
  id: "agent_nhi_link",
  stored: "agent_identity_links.status",
  states: AGENT_NHI_LINK_STATUSES,
  initial: ["staged"],
  terminal: ["confirmed", "rejected"],
  transitions: {
    confirm: {
      from: ["staged"],
      to: "confirmed",
      by: ["admin"],
      summary: "A second, named admin (not the one who staged it) confirms the link under an identity_manage step-up.",
    },
    reject: {
      from: ["staged"],
      to: "rejected",
      by: ["admin"],
      summary: "A second, named admin (not the one who staged it) rejects the link under an identity_manage step-up.",
    },
  },
});

/**
 * ADR-0327 addendum (lane E12): a decision-table version's lifecycle. A version is proposed `pending_review` with a named
 * reviewer in the approvals queue; only that approval's decide path moves it on. Stored in
 * `decision_table_versions.status`.
 */
export const DECISION_TABLE_VERSION_MACHINE = defineMachine({
  id: "decision_table_version",
  stored: "decision_table_versions.status",
  states: ["pending_review", "published", "superseded", "rejected", "stale"],
  initial: ["pending_review"],
  terminal: ["superseded", "rejected", "stale"],
  transitions: {
    publish: {
      from: ["pending_review"],
      to: "published",
      by: ["approver"],
      summary: "The named reviewer approves the version; it becomes the table's published version.",
    },
    reject: {
      from: ["pending_review"],
      to: "rejected",
      by: ["approver"],
      summary: "The named reviewer denies the version; the published version is unchanged.",
    },
    mark_stale: {
      from: ["pending_review"],
      to: "stale",
      by: ["system"],
      summary:
        "The version was approved after another version was published, or its body no longer matches the digest its approval was bound to; it is recorded stale and not published.",
    },
    supersede: {
      from: ["published"],
      to: "superseded",
      by: ["system"],
      summary: "A newer version of the table is published in the same transaction; this one is kept as history.",
    },
  },
});

/*
 * The two ADR-0334 lifecycles below are declared with `defineMachine` and enforced by their routes (a revoke checks
 * `can(state, "revoke")` under the row lock and its UPDATE is guarded by `revoked_at IS NULL`), but their state is
 * DERIVED from timestamps and a counter rather than stored in a status column, so they are not in `STATE_MACHINES`,
 * whose entries each match a CHECK-constrained column (adr0348-state-machines.test.ts). Lane E29's app-wide audit
 * owns how derived lifecycles are listed.
 */

/** `browser_enrolment_tokens` (ADR-0334), derived from the row (`revoked_at`, `expires_at`, the device cap) by
 * `enrolmentTokenState`. Use and time move a token on without an admin; revocation is final. */
export const BROWSER_ENROLMENT_TOKEN_MACHINE = defineMachine({
  id: "browser_enrolment_token",
  stored: "browser_enrolment_tokens (revoked_at, expires_at, devices_enrolled vs device_cap)",
  states: ["active", "exhausted", "expired", "revoked"],
  initial: ["active"],
  terminal: ["revoked"],
  transitions: {
    exhaust: {
      from: ["active"],
      to: "exhausted",
      by: ["system"],
      summary: "The last device the token allows registers; it still answers the devices it enrolled, never a new one.",
    },
    expire: {
      from: ["active", "exhausted"],
      to: "expired",
      by: ["system"],
      summary: "The token's expiry passes; no device registers with it any more.",
    },
    revoke: {
      from: ["active", "exhausted", "expired"],
      to: "revoked",
      by: ["admin"],
      summary: "An admin revokes the token; no device registers with it again.",
    },
  },
});

/** `browser_devices.revoked_at` (ADR-0334): a device is active until an admin revokes it, and revocation is final. */
export const BROWSER_DEVICE_MACHINE = defineMachine({
  id: "browser_device",
  stored: "browser_devices.revoked_at",
  states: ["active", "revoked"],
  initial: ["active"],
  terminal: ["revoked"],
  transitions: {
    revoke: {
      from: ["active"],
      to: "revoked",
      by: ["admin"],
      summary: "An admin revokes the device; its proofs are refused and it blocks every governed site.",
    },
  },
});

/** `vendor_usage_pull_runs.status` (ADR-0322). A run opens `running`, or is written already `refused` when another
 * pull of the same connector holds the lease. A running run ends exactly once: the batch committed, the vendor or
 * the write failed, or a precondition (policy off, no credential, air-gapped) refused it. */
export const VENDOR_USAGE_PULL_RUN_STATUSES = ["running", "succeeded", "failed", "refused"] as const;
export type VendorUsagePullRunStatus = (typeof VENDOR_USAGE_PULL_RUN_STATUSES)[number];
export const VENDOR_USAGE_PULL_RUN_MACHINE = defineMachine({
  id: "vendor_usage_pull_run",
  stored: "vendor_usage_pull_runs.status",
  states: VENDOR_USAGE_PULL_RUN_STATUSES,
  initial: ["running", "refused"],
  terminal: ["succeeded", "failed", "refused"],
  transitions: {
    succeed: {
      from: ["running"],
      to: "succeeded",
      by: ["system"],
      summary: "The pulled lines, the batch and the connector's pulled-through day committed together.",
    },
    fail: {
      from: ["running"],
      to: "failed",
      by: ["system"],
      summary: "The vendor answered with an error or an unusable page, or the write was rolled back; nothing was imported.",
    },
    refuse: {
      from: ["running"],
      to: "refused",
      by: ["system"],
      summary: "A precondition failed before any request: the policy or connector is off, no live credential, no data key, or air-gapped.",
    },
  },
});

/**
 * ADR-0327 slice 4a (lane E12): one request to switch a step from the AI to its rule (a detector suggestion, or since
 * slice 4d one published decision-table version). Proposed `pending_review` with a
 * named reviewer in the approvals queue; only that approval's decide path moves it on. Stored in
 * `rule_step_switches.status`.
 */
export const RULE_STEP_SWITCH_MACHINE = defineMachine({
  id: "rule_step_switch",
  stored: "rule_step_switches.status",
  states: ["pending_review", "switched", "rejected", "stale", "reverted"],
  initial: ["pending_review"],
  terminal: ["rejected", "stale", "reverted"],
  transitions: {
    approve: {
      from: ["pending_review"],
      to: "switched",
      by: ["approver"],
      summary:
        "The named reviewer approves; the suggestion, or the decision table's published version (slice 4d), is switched in the same transaction.",
    },
    reject: {
      from: ["pending_review"],
      to: "rejected",
      by: ["approver"],
      summary: "The named reviewer denies the switch; the suggestion stays in shadow and the AI keeps answering.",
    },
    mark_stale: {
      from: ["pending_review"],
      to: "stale",
      by: ["system"],
      summary:
        "Approved, but the suggestion left shadow mode or its rule no longer matches the digest the approval was bound to; nothing is switched.",
    },
    revert: {
      from: ["switched"],
      to: "reverted",
      by: ["admin", "system"],
      summary:
        "An admin reverts the switch, or publishing a newer decision-table version reverts a switch of the old one; the AI answers every request again. No approval needed.",
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

/** `endpoint_addon_removals.status` (ADR-0331): one admin-started removal of an MCP server from endpoints. It is sent
 * to no device until a second person approves it (ADR-0186); expiry is `expires_at`, not a state. */
export const ENDPOINT_ADDON_REMOVAL_STATES = ["awaiting_approval", "active", "denied", "stale", "cancelled"] as const;
export const ENDPOINT_ADDON_REMOVAL_MACHINE = defineMachine({
  id: "endpoint_addon_removal",
  stored: "endpoint_addon_removals.status",
  states: ENDPOINT_ADDON_REMOVAL_STATES,
  initial: ["awaiting_approval"],
  terminal: ["denied", "stale", "cancelled"],
  transitions: {
    approve: {
      from: ["awaiting_approval"],
      to: "active",
      by: ["approver"],
      summary: "A second administrator approved it, and the endpoints it resolves to are unchanged; its directives may be delivered.",
    },
    deny: {
      from: ["awaiting_approval"],
      to: "denied",
      by: ["approver"],
      summary: "The approver refused it; nothing is sent to any endpoint.",
    },
    go_stale: {
      from: ["awaiting_approval"],
      to: "stale",
      by: ["system"],
      summary: "It was approved, but the endpoints it resolves to changed since it was requested; nothing is sent, and a new request is needed.",
    },
    cancel: {
      from: ["awaiting_approval", "active"],
      to: "cancelled",
      by: ["admin"],
      summary: "An admin cancelled it; nothing more is delivered, and outcomes of directives already delivered are still recorded.",
    },
  },
});

/** `endpoint_addon_removal_targets.status` (ADR-0331): one config entry on one device user's endpoint. */
export const ENDPOINT_ADDON_TARGET_STATES = ["pending", "delivered", "removed", "nothing_to_remove", "failed", "cancelled"] as const;
export const ENDPOINT_ADDON_TARGET_MACHINE = defineMachine({
  id: "endpoint_addon_target",
  stored: "endpoint_addon_removal_targets.status",
  states: ENDPOINT_ADDON_TARGET_STATES,
  initial: ["pending"],
  terminal: ["removed", "nothing_to_remove", "failed", "cancelled"],
  transitions: {
    deliver: {
      from: ["pending"],
      to: "delivered",
      by: ["agent"],
      summary: "The endpoint agent fetched the signed directive.",
    },
    report_removed: {
      from: ["delivered"],
      to: "removed",
      by: ["agent"],
      summary: "The agent removed the named entry from the config.",
    },
    report_nothing: {
      from: ["delivered"],
      to: "nothing_to_remove",
      by: ["agent"],
      summary: "The agent found the entry absent, or a different server under that name; nothing was changed.",
    },
    report_failed: {
      from: ["delivered"],
      to: "failed",
      by: ["agent"],
      summary: "The agent refused or could not make the edit; the code says why.",
    },
    cancel: {
      from: ["pending"],
      to: "cancelled",
      by: ["admin"],
      summary: "The removal was cancelled before this directive was delivered. A delivered directive is not cancelled: its outcome is still recorded.",
    },
  },
});

/** `pipeline_runs.status` (ADR-0232 §3–§5 as built by lane E49 slice 1). A pipeline run is one governed run of one
 * published workflow-template version (ADR-0341): it never executes anything itself. `start` is recorded in the same
 * transaction as the workflow instance the governed start path (`startWorkflowInstanceWithTemplates`) created, and
 * `refuse` when that path refused (nothing ran). The settling events are observed from the instance's own terminal
 * status: `completed` succeeds, `aborted` cancels, `denied` and `rolled_back` fail. */
export const PIPELINE_RUN_STATES = ["requested", "running", "succeeded", "failed", "cancelled", "refused"] as const;
export type PipelineRunState = (typeof PIPELINE_RUN_STATES)[number];
export const PIPELINE_RUN_MACHINE = defineMachine({
  id: "pipeline_run",
  stored: "pipeline_runs.status",
  states: PIPELINE_RUN_STATES,
  initial: ["requested"],
  terminal: ["succeeded", "failed", "cancelled", "refused"],
  transitions: {
    start: {
      from: ["requested"],
      to: "running",
      by: ["system"],
      summary: "The governed workflow start accepted the run and created its workflow instance.",
    },
    refuse: {
      from: ["requested"],
      to: "refused",
      by: ["system"],
      summary: "The governed workflow start refused the run (a retired template, attribution, a missing approver); nothing ran.",
    },
    succeed: {
      from: ["running"],
      to: "succeeded",
      by: ["system"],
      summary: "The workflow instance completed.",
    },
    fail: {
      from: ["running"],
      to: "failed",
      by: ["system"],
      summary: "The workflow instance was denied at a sign-off or rolled back.",
    },
    cancel: {
      from: ["running"],
      to: "cancelled",
      by: ["system"],
      summary: "The workflow instance was aborted.",
    },
  },
});

/** Every declared machine, by id: the one list an agent or a document reads. */
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
  [CLASSIFIER_VERSION_MACHINE.def.id]: CLASSIFIER_VERSION_MACHINE,
  [SAAS_APP_AGENT_LINK_MACHINE.def.id]: SAAS_APP_AGENT_LINK_MACHINE,
  [DETECTION_INCIDENT_MACHINE.def.id]: DETECTION_INCIDENT_MACHINE,
  [DETECTION_RESPONSE_MACHINE.def.id]: DETECTION_RESPONSE_MACHINE,
  [ENDPOINT_DEVICE_QUARANTINE_MACHINE.def.id]: ENDPOINT_DEVICE_QUARANTINE_MACHINE,
  [RULE_STEP_SUGGESTION_MACHINE.def.id]: RULE_STEP_SUGGESTION_MACHINE,
  [ENDPOINT_COMMAND_EXCEPTION_MACHINE.def.id]: ENDPOINT_COMMAND_EXCEPTION_MACHINE,
  [ROBOT_VERSION_MACHINE.def.id]: ROBOT_VERSION_MACHINE,
  [ROBOT_MACHINE.def.id]: ROBOT_MACHINE,
  [ROBOT_RUN_MACHINE.def.id]: ROBOT_RUN_MACHINE,
  [AGENT_NHI_LINK_MACHINE.def.id]: AGENT_NHI_LINK_MACHINE,
  [DECISION_TABLE_VERSION_MACHINE.def.id]: DECISION_TABLE_VERSION_MACHINE,
  [RULE_STEP_SWITCH_MACHINE.def.id]: RULE_STEP_SWITCH_MACHINE,
  [VENDOR_USAGE_PULL_RUN_MACHINE.def.id]: VENDOR_USAGE_PULL_RUN_MACHINE,
  [ENDPOINT_ADDON_REMOVAL_MACHINE.def.id]: ENDPOINT_ADDON_REMOVAL_MACHINE,
  [ENDPOINT_ADDON_TARGET_MACHINE.def.id]: ENDPOINT_ADDON_TARGET_MACHINE,
  [PIPELINE_RUN_MACHINE.def.id]: PIPELINE_RUN_MACHINE,
  // ADR-0338: a governed disable, quarantine or restore of an agent inside its vendor platform
  [VENDOR_ACTION_MACHINE.def.id]: VENDOR_ACTION_MACHINE,
  [SHADOW_AI_FINDING_MACHINE.def.id]: SHADOW_AI_FINDING_MACHINE,
  [USE_CASE_MACHINE.def.id]: USE_CASE_MACHINE,
  [APPROVAL_MACHINE.def.id]: APPROVAL_MACHINE,
  [REDTEAM_LIBRARY_MACHINE.def.id]: REDTEAM_LIBRARY_MACHINE,
} as Record<string, StateMachine<string, string>>);
