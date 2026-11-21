import { describe, expect, it } from "vitest";
import { AUDIENCE_STATES, AUDIENCE_TRANSITIONS, audienceIssues, audienceState } from "./agent-credential.js";

// ADR-0315: the audience's declared lifecycle (owner build rule 12)
describe("agent credential audience lifecycle", () => {
  it("derives the state from disabled_at", () => {
    expect(audienceState({ disabledAt: null })).toBe("enabled");
    expect(audienceState({ disabledAt: new Date() })).toBe("disabled");
    expect(audienceIssues({ disabledAt: null })).toBe(true);
    expect(audienceIssues({ disabledAt: new Date() })).toBe(false);
  });
  it("declares every state; disabled is terminal (re-enabling is a new registration)", () => {
    expect(Object.keys(AUDIENCE_TRANSITIONS).sort()).toEqual([...AUDIENCE_STATES].sort());
    expect(AUDIENCE_TRANSITIONS.enabled).toEqual(["disabled"]);
    expect(AUDIENCE_TRANSITIONS.disabled).toEqual([]);
  });
});
