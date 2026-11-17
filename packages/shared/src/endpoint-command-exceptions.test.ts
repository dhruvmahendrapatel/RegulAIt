import { describe, expect, it } from "vitest";

import {
  ENDPOINT_EXCEPTION_STATES,
  ENDPOINT_EXCEPTION_STORED_STATES,
  ENDPOINT_EXCEPTION_TRANSITIONS,
  type EndpointExceptionAction,
  endpointExceptionDigest,
  endpointExceptionState,
  endpointExceptionTransitionRefusal,
} from "./endpoint-command-exceptions.js";

describe("ADR-0350 §5 exception lifecycle", () => {
  it("declares exactly the ADR's transitions", () => {
    const pairs = Object.values(ENDPOINT_EXCEPTION_TRANSITIONS).map((t) => `${t.from}>${t.to}`).sort();
    expect(pairs).toEqual(["approved>revoked", "requested>approved", "requested>cancelled", "requested>rejected"]);
  });

  it("refuses every transition the table does not list, from every state", () => {
    for (const state of ENDPOINT_EXCEPTION_STATES) {
      for (const action of Object.keys(ENDPOINT_EXCEPTION_TRANSITIONS) as EndpointExceptionAction[]) {
        const allowed = ENDPOINT_EXCEPTION_TRANSITIONS[action].from === state;
        expect(endpointExceptionTransitionRefusal(state, action) === null, `${state} ${action}`).toBe(allowed);
      }
    }
  });

  it("derives expired from the clock and never stores it", () => {
    expect(ENDPOINT_EXCEPTION_STORED_STATES).not.toContain("expired");
    const notAfter = new Date("2026-11-17T12:00:00Z");
    expect(endpointExceptionState({ status: "approved", notAfter }, new Date("2026-11-17T11:59:59Z"))).toBe("approved");
    expect(endpointExceptionState({ status: "approved", notAfter }, notAfter)).toBe("expired");
    expect(endpointExceptionTransitionRefusal("expired", "revoke")).not.toBeNull();
    expect(endpointExceptionState({ status: "requested", notAfter: null }, notAfter)).toBe("requested");
  });

  it("binds the approval to every term", () => {
    const t = { deviceId: "d", ruleId: "rm-rf", verdict: "ask" as const, hours: 4, reason: "cleanup" };
    const base = endpointExceptionDigest(t);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [{ deviceId: "e" }, { ruleId: "x" }, { verdict: "allow" as const }, { hours: 5 }, { reason: "other" }]) {
      expect(endpointExceptionDigest({ ...t, ...change })).not.toBe(base);
    }
  });
});
