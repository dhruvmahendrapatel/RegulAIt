/**
 * ADR-0360 §3 — the declared lifecycles of an endpoint agent update rollout and of its stages (owner rule 12,
 * ADR-0348, registered in `STATE_MACHINES`).
 *
 * The gateway guards every state write with `whereFrom(column, machine, event)`, so a stale or concurrent write
 * matches no row and is refused; the API returns `describe(state)`, so a person, the UI and an agent read the same
 * allowed next steps. Pure and zero-I/O.
 */
import { defineMachine } from "./state-machine.js";

/** `endpoint_update_rollouts.state` values (the column's CHECK lists the same, checked by the ADR-0348 test) */
export const ENDPOINT_ROLLOUT_STATES = ["draft", "start_requested", "running", "paused", "halted", "resume_requested", "completed", "aborted"] as const;
export type EndpointRolloutState = (typeof ENDPOINT_ROLLOUT_STATES)[number];

/** `endpoint_update_rollout_stages.state` values */
export const ENDPOINT_ROLLOUT_STAGE_STATES = ["pending", "active", "done"] as const;
export type EndpointRolloutStageState = (typeof ENDPOINT_ROLLOUT_STAGE_STATES)[number];

/**
 * The rollout halt threshold: the failed installs or rollbacks that halt a rollout (owner decision D-2026-11-22-04).
 * Configurable but bounded: the strict default is the minimum (the first failure halts, ADR-0180); lowering it is free,
 * raising it is a relaxation (a `settings_relax` step-up, audited) and never past `max`. The column's CHECK holds the
 * same bounds.
 */
export const ENDPOINT_ROLLOUT_HALT_THRESHOLD = Object.freeze({ strict: 1, min: 1, max: 10 });

/**
 * Starting or resuming a rollout replaces the agent binary on devices, so it is decided by two signed-in people
 * (ADR-0360 slice 1c, the review lessons of #979): one asks, a different admin approves with a fresh `approval_decide`
 * step-up bound to the rollout and the decision. A request nobody decides expires after
 * `ENDPOINT_ROLLOUT_DECISION_TTL_HOURS`, back to where it was asked from. Pausing, aborting and the system's halt only
 * stop the offer, so one admin (or the system) does them.
 */
export const ENDPOINT_ROLLOUT_MACHINE = defineMachine({
  id: "endpoint_update_rollout",
  stored: "endpoint_update_rollouts.state",
  states: ENDPOINT_ROLLOUT_STATES,
  initial: ["draft"],
  terminal: ["completed", "aborted"],
  transitions: {
    request_start: { from: ["draft"], to: "start_requested", by: ["admin"], summary: "Ask to start the rollout; a second admin approves it (self-update must be on)." },
    approve_start: { from: ["start_requested"], to: "running", by: ["approver"], summary: "A second admin approves (fresh step-up): the first stage's devices are offered the update." },
    reject_start: { from: ["start_requested"], to: "draft", by: ["approver"], summary: "A second admin rejects the start; the rollout stays a draft." },
    expire_start: { from: ["start_requested"], to: "draft", by: ["system"], summary: "Nobody decided the start within its time limit; the rollout stays a draft." },
    advance: { from: ["running"], to: "running", by: ["admin"], summary: "Finish the active stage and offer the update to the next stage's devices (the approved plan's next step)." },
    complete: { from: ["running"], to: "completed", by: ["admin"], summary: "Finish the last stage: the rollout is done." },
    pause: { from: ["running"], to: "paused", by: ["admin"], summary: "Stop offering the update until the rollout is resumed." },
    request_resume: { from: ["paused", "halted"], to: "resume_requested", by: ["admin"], summary: "Ask to offer the update again; a second admin approves it (self-update must be on)." },
    approve_resume: { from: ["resume_requested"], to: "running", by: ["approver"], summary: "A second admin approves (fresh step-up): the active stage's devices are offered the update again." },
    reject_resume: { from: ["resume_requested"], to: "paused", by: ["approver"], summary: "A second admin rejects the resume; the rollout stays paused." },
    expire_resume: { from: ["resume_requested"], to: "paused", by: ["system"], summary: "Nobody decided the resume within its time limit; the rollout stays paused." },
    halt: { from: ["running"], to: "halted", by: ["system"], summary: "Failed installs or rollbacks reached the rollout's halt threshold, so the update is no longer offered." },
    abort: { from: ["draft", "start_requested", "running", "paused", "halted", "resume_requested"], to: "aborted", by: ["admin"], summary: "Cancel the rollout for good; devices already updated keep their version." },
  },
});
/** a start or resume request nobody decides within this long expires (strict compiled default, ADR-0180) */
export const ENDPOINT_ROLLOUT_DECISION_TTL_HOURS = 24;
export type EndpointRolloutEvent = (typeof ENDPOINT_ROLLOUT_MACHINE.events)[number];

export const ENDPOINT_ROLLOUT_STAGE_MACHINE = defineMachine({
  id: "endpoint_update_rollout_stage",
  stored: "endpoint_update_rollout_stages.state",
  states: ENDPOINT_ROLLOUT_STAGE_STATES,
  initial: ["pending"],
  terminal: ["done"],
  transitions: {
    activate: { from: ["pending"], to: "active", by: ["admin"], summary: "This stage's devices are offered the update." },
    finish: { from: ["active"], to: "done", by: ["admin"], summary: "This stage is finished." },
  },
});

/**
 * ADR-0360 slice 1c — one device's attempt to install one rollout's version (`endpoint_update_attempts.state`).
 *
 *   directed ──report_installed──▶ installed        directed ──expire──▶ expired ──redirect──▶ directed
 *            ├─report_current───▶ current           (expired also takes a late report)
 *            ├─report_refused───▶ refused
 *            ├─report_failed────▶ failed            failed and rolled_back count toward the rollout's halt threshold
 *            └─report_rolled_back▶ rolled_back
 *
 * The gateway creates the attempt (`directed`) when it first offers the device a signed directive. The device's root
 * updater reports one outcome, which settles it. An attempt with no report within `ENDPOINT_UPDATE_ATTEMPT_TTL_HOURS`
 * expires, so a device that never reports holds nothing for good; it is offered again (`redirect`) while the rollout
 * still offers the update, and a late report still settles it.
 */
export const ENDPOINT_UPDATE_ATTEMPT_STATES = ["directed", "installed", "current", "refused", "failed", "rolled_back", "expired"] as const;
export type EndpointUpdateAttemptState = (typeof ENDPOINT_UPDATE_ATTEMPT_STATES)[number];
/** an attempt with no report within this long expires (the directive's own lifetime is at most 24 hours, ADR-0360 §4) */
export const ENDPOINT_UPDATE_ATTEMPT_TTL_HOURS = 24;
/**
 * One limit for an agent version everywhere (review of #1248): a rollout's target, the release manifest, the device's
 * reported version and the update result all hold at most 32 characters, the same as the agent (internal/update).
 */
export const ENDPOINT_AGENT_VERSION_MAX = 32;
/** a rollout target and a release version: semver, with an optional pre-release, at most 32 characters in all */
export const ENDPOINT_AGENT_RELEASE_VERSION = /^(?=.{1,32}$)[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,30})?$/;

const REPORTABLE = ["directed", "expired"] as const;
export const ENDPOINT_UPDATE_ATTEMPT_MACHINE = defineMachine({
  id: "endpoint_update_attempt",
  stored: "endpoint_update_attempts.state",
  states: ENDPOINT_UPDATE_ATTEMPT_STATES,
  initial: ["directed"],
  terminal: ["installed", "current", "refused", "failed", "rolled_back"],
  transitions: {
    report_installed: { from: REPORTABLE, to: "installed", by: ["agent"], summary: "The device installed the version and its health check passed." },
    report_current: { from: REPORTABLE, to: "current", by: ["agent"], summary: "The device already runs the version; nothing was installed." },
    report_refused: { from: REPORTABLE, to: "refused", by: ["agent"], summary: "The device's updater refused the directive, the manifest or the version (a fixed code says why)." },
    report_failed: { from: REPORTABLE, to: "failed", by: ["agent"], summary: "The install failed; this counts toward the rollout's halt threshold." },
    report_rolled_back: { from: REPORTABLE, to: "rolled_back", by: ["agent"], summary: "The installed version failed its health check and the previous one was restored; this counts toward the halt threshold." },
    expire: { from: ["directed"], to: "expired", by: ["system"], summary: "The device reported nothing within the attempt's time limit." },
    redirect: { from: ["expired"], to: "directed", by: ["system"], summary: "The rollout still offers the update, so the device is offered it again." },
  },
});
export type EndpointUpdateAttemptEvent = (typeof ENDPOINT_UPDATE_ATTEMPT_MACHINE.events)[number];
