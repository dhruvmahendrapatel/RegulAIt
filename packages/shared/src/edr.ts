/**
 * ADR-0360 §6 — the declared lifecycle of an EDR isolation request (owner rule 12, ADR-0348, registered in
 * `STATE_MACHINES`).
 *
 *   requested ──approve──▶ submitting ──confirm──▶ isolated ──request_release──▶ release_requested ──approve_release──▶ releasing ──confirm_release──▶ released
 *     ├─reject/expire─▶ rejected  └─fail─▶ failed ─vendor_isolated─▶ isolated   ◀──reject_release/expire_release──┘      fail_release ──▶ isolated
 *                                                       isolated ──vendor_released──▶ released
 *
 * Isolating narrows access, so it needs a second admin's approval with a fresh step-up; releasing widens it back, so it
 * needs the same plus a `settings_relax` step-up. Both the requester and the decider are signed-in people and never the
 * same person (the route refuses a request without a person; the table's CHECKs hold it). The system events come from
 * the vendor or the clock:
 *  - `confirm`, `fail`, `confirm_release` and `fail_release` from the vendor's action status (a stranded or unsettled
 *    action fails after a bounded wait);
 *  - `expire` and `expire_release` when a request waits for a decision longer than its TTL;
 *  - `vendor_isolated` and `vendor_released` when the device signal shows the vendor's real state differs from ours, so
 *    a failed request whose device the vendor did isolate re-enters the governed release path, and a release made in
 *    the vendor console is recorded (and audited as outside governance) instead of being hidden.
 * `failed` does not hold the device's open-request slot, so a new request may be raised. Pure and zero-I/O; the gateway
 * guards every state write with `whereFrom`.
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
  terminal: ["rejected", "released"],
  transitions: {
    approve: { from: ["requested"], to: "submitting", by: ["approver"], summary: "A second admin approves (with a fresh step-up) and the EDR is asked to isolate the device." },
    reject: { from: ["requested"], to: "rejected", by: ["approver"], summary: "A second admin rejects the request; nothing is sent to the EDR." },
    expire: { from: ["requested"], to: "rejected", by: ["system"], summary: "Nobody decided the request within its time limit; nothing is sent to the EDR." },
    confirm: { from: ["submitting"], to: "isolated", by: ["system"], summary: "The EDR reports the device isolated." },
    fail: { from: ["submitting"], to: "failed", by: ["system"], summary: "The EDR refused or failed the isolation, or it did not settle in time." },
    vendor_isolated: { from: ["failed"], to: "isolated", by: ["system"], summary: "The EDR reports the device isolated after all, so the request re-enters the governed release path." },
    request_release: { from: ["isolated"], to: "release_requested", by: ["admin"], summary: "Ask to release the device from isolation (widens access back)." },
    approve_release: { from: ["release_requested"], to: "releasing", by: ["approver"], summary: "A second admin approves the release (settings_relax step-up) and the EDR is asked to release the device." },
    reject_release: { from: ["release_requested"], to: "isolated", by: ["approver"], summary: "A second admin rejects the release; the device stays isolated." },
    expire_release: { from: ["release_requested"], to: "isolated", by: ["system"], summary: "Nobody decided the release within its time limit; the device stays isolated." },
    confirm_release: { from: ["releasing"], to: "released", by: ["system"], summary: "The EDR reports the device released." },
    fail_release: { from: ["releasing"], to: "isolated", by: ["system"], summary: "The EDR failed the release, or it did not settle in time; the device stays isolated." },
    vendor_released: { from: ["isolated"], to: "released", by: ["system"], summary: "The EDR reports the device no longer isolated (released outside RegulAIt); recorded and audited as outside governance." },
  },
});
export type EdrIsolationEvent = (typeof EDR_ISOLATION_MACHINE.events)[number];

/** the states that hold a device's one open request (the table's partial unique index lists the others) */
export const EDR_ISOLATION_OPEN_STATES = ["requested", "submitting", "isolated", "release_requested", "releasing"] as const satisfies readonly EdrIsolationState[];
