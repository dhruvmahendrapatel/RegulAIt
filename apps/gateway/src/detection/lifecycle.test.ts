import { describe, expect, it } from "vitest";
import {
  ADMIN_SETTABLE_STATUSES,
  INCIDENT_STATUS_TRANSITIONS,
  RESPONSE_STATE_TRANSITIONS,
  incidentStatusSources,
  responseStateSources,
} from "./lifecycle.js";

describe("ADR-0333 incident lifecycles (rule 12)", () => {
  it("closed is terminal and open is never re-entered", () => {
    expect(INCIDENT_STATUS_TRANSITIONS.closed).toEqual([]);
    expect(incidentStatusSources("open")).toEqual([]);
    expect(incidentStatusSources("closed")).toEqual(["open", "acknowledged"]);
    expect(incidentStatusSources("acknowledged")).toEqual(["open", "acknowledged"]);
  });
  it("the API can set exactly acknowledged and closed", () => {
    expect(ADMIN_SETTABLE_STATUSES).toEqual(["acknowledged", "closed"]);
  });
  it("a response runs at most once", () => {
    expect(RESPONSE_STATE_TRANSITIONS.done).toEqual([]);
    expect(RESPONSE_STATE_TRANSITIONS.failed).toEqual([]);
    expect(responseStateSources("done")).toEqual(["none"]);
    expect(responseStateSources("failed")).toEqual(["none"]);
  });
});

describe("ADR-0333 response runner pending set", () => {
  it("is exactly the non-terminal response states", async () => {
    const { RESPONSE_PENDING_STATES } = await import("./lifecycle.js");
    expect(RESPONSE_PENDING_STATES).toEqual(["none"]);
  });
});
