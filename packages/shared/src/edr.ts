/**
 * ADR-0360 §6 — the declared lifecycle of an EDR isolation request (owner rule 12, ADR-0348, registered in
 * `STATE_MACHINES`).
 *
 *   requested ──approve──▶ submitting ──confirm──▶ isolated ──request_release──▶ release_requested ──approve_release──▶ releasing ──confirm_release──▶ released
 *        └──reject──▶ rejected     └──fail──▶ failed                    reject_release ◀──┘        fail_release ──▶ isolated
 *
 * Isolating narrows access, so it needs a second admin's approval with a fresh step-up; releasing widens it back, so it
 * needs the same plus a `settings_relax` step-up. `confirm`, `fail`, `confirm_release` and `fail_release` are the
 * system's, from the vendor's action status. The gateway guards every state write with `whereFrom`. Pure and zero-I/O.
 */
import { defineMachine } from "./state-machine.js";

/** `edr_isolation_requests.state` values (the column's CHECK lists the same, checked by the ADR-0348 test) */
export const EDR_ISOLATION_STATES = ["requested", "rejected", "submitting", "isolated", "failed", "release_requested", "releasing", "released"] as const;
export type EdrIsolationState = (typeof EDR_ISOLATION_STATES)[number];

export const EDR_ISOLATION_MACHINE = defineMachine({
  id: "edr_isolation_request",
  stored: "edr_isolation_requests.state",
  states: EDR_ISOLATION_STATES,
  initial: ["requested"],
  terminal: ["rejected", "failed", "released"],
  transitions: {
    approve: { from: ["requested"], to: "submitting", by: ["approver"], summary: "A second admin approves (with a fresh step-up) and the EDR is asked to isolate the device." },
    reject: { from: ["requested"], to: "rejected", by: ["approver"], summary: "A second admin rejects the request; nothing is sent to the EDR." },
    confirm: { from: ["submitting"], to: "isolated", by: ["system"], summary: "The EDR reports the device isolated." },
    fail: { from: ["submitting"], to: "failed", by: ["system"], summary: "The EDR refused or failed the isolation." },
    request_release: { from: ["isolated"], to: "release_requested", by: ["admin"], summary: "Ask to release the device from isolation (widens access back)." },
    approve_release: { from: ["release_requested"], to: "releasing", by: ["approver"], summary: "A second admin approves the release (settings_relax step-up) and the EDR is asked to release the device." },
    reject_release: { from: ["release_requested"], to: "isolated", by: ["approver"], summary: "A second admin rejects the release; the device stays isolated." },
    confirm_release: { from: ["releasing"], to: "released", by: ["system"], summary: "The EDR reports the device released." },
    fail_release: { from: ["releasing"], to: "isolated", by: ["system"], summary: "The EDR failed the release; the device stays isolated." },
  },
});
export type EdrIsolationEvent = (typeof EDR_ISOLATION_MACHINE.events)[number];
