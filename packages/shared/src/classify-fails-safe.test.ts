/**
 * INDEPENDENT check by the reviewing session, on the direction of the failure.
 *
 * ADR-0072 exists because a governance stop was being scored as an attack
 * success. The first implementation of its classifier was a DENY-list, which
 * reintroduced the same shape one level down: anything unrecognised became
 * `governance_stop` — fully resisted, counted as the defence working. An
 * unknown refusal reason reported as good news is exactly the bug being fixed.
 *
 * These assert the direction, not the membership: whatever the lists contain,
 * an UNRECOGNISED code must never be credited to the defence.
 */
import { describe, it, expect } from "vitest";
import {
  classifyDispatchFailure,
  RED_TEAM_GOVERNANCE_STOP_CODES,
  RED_TEAM_TRANSPORT_FAILURE_CODES,
} from "@regulait/shared";

describe("ADVERSARIAL: an unrecognised failure is never credited to the defence", () => {
  it("a code nobody has seen is unknown_failure — not a platform hold", () => {
    for (const code of [
      "some_future_refusal_reason",
      "guardrail_blocked_v2",   // a plausible RENAME of a real governance code
      "",
      "undefined",
    ]) {
      expect(classifyDispatchFailure(code)).toBe("unknown_failure");
    }
  });

  it("null/undefined are unknown, not governance", () => {
    expect(classifyDispatchFailure(null)).toBe("unknown_failure");
    expect(classifyDispatchFailure(undefined)).toBe("unknown_failure");
  });

  it("every listed governance code really classifies as a stop", () => {
    for (const c of RED_TEAM_GOVERNANCE_STOP_CODES) {
      expect(classifyDispatchFailure(c)).toBe("governance_stop");
    }
  });

  it("every listed transport code really classifies as transport", () => {
    for (const c of RED_TEAM_TRANSPORT_FAILURE_CODES) {
      expect(classifyDispatchFailure(c)).toBe("transport_failure");
    }
  });

  it("the two lists are disjoint — a code cannot be both", () => {
    const gov = new Set<string>(RED_TEAM_GOVERNANCE_STOP_CODES);
    for (const c of RED_TEAM_TRANSPORT_FAILURE_CODES) expect(gov.has(c)).toBe(false);
  });
});
