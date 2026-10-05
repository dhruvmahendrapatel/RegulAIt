import { describe, expect, it } from "vitest";
import {
  POLICY_SIMULATION_DEFAULT_DEADLINE_MS,
  POLICY_SIMULATION_DEFAULT_MAX_GLOBAL,
  POLICY_SIMULATION_DEFAULT_MAX_PER_CALLER,
  REPLAY_FIDELITY_DISCLOSURE,
  policySimulationIncompleteNote,
  resolvePolicySimulationRunLimits,
} from "./policy-simulation.js";

/** AER-016 (ADR-0179): the run bounds can be tuned but never switched off. */
describe("resolvePolicySimulationRunLimits", () => {
  it("defaults when nothing is set", () => {
    expect(resolvePolicySimulationRunLimits({})).toEqual({
      deadlineMs: POLICY_SIMULATION_DEFAULT_DEADLINE_MS,
      maxPerCaller: POLICY_SIMULATION_DEFAULT_MAX_PER_CALLER,
      maxGlobal: POLICY_SIMULATION_DEFAULT_MAX_GLOBAL,
    });
  });

  it("reads whole numbers from the environment", () => {
    expect(
      resolvePolicySimulationRunLimits({
        REGULAIT_POLICY_SIMULATION_DEADLINE_MS: " 5000 ",
        REGULAIT_POLICY_SIMULATION_MAX_PER_CALLER: "2",
        REGULAIT_POLICY_SIMULATION_MAX_GLOBAL: "8",
      }),
    ).toEqual({ deadlineMs: 5000, maxPerCaller: 2, maxGlobal: 8 });
  });

  it("a typo, a zero or a negative falls back to the default — never to 'no limit'", () => {
    for (const bad of ["", "abc", "0", "-1", "1.5", "1e9", "Infinity"]) {
      const out = resolvePolicySimulationRunLimits({
        REGULAIT_POLICY_SIMULATION_DEADLINE_MS: bad,
        REGULAIT_POLICY_SIMULATION_MAX_PER_CALLER: bad,
        REGULAIT_POLICY_SIMULATION_MAX_GLOBAL: bad,
      });
      expect(out.deadlineMs, bad).toBe(POLICY_SIMULATION_DEFAULT_DEADLINE_MS);
      expect(out.maxPerCaller, bad).toBe(POLICY_SIMULATION_DEFAULT_MAX_PER_CALLER);
      expect(out.maxGlobal, bad).toBe(POLICY_SIMULATION_DEFAULT_MAX_GLOBAL);
    }
  });
});

describe("the incomplete and replay disclosures", () => {
  it("the incomplete note says how far the run got and that nothing was stored", () => {
    const note = policySimulationIncompleteNote({ evaluated: 3, total: 6, deadlineMs: 20_000 });
    expect(note).toMatch(/^INCOMPLETE/);
    expect(note).toContain("3 of 6");
    expect(note).toMatch(/no preview was stored/);
  });

  it("the fidelity disclosure states how a rate limit is replayed and when it is indeterminate", () => {
    expect(REPLAY_FIDELITY_DISCLOSURE).toMatch(/strictly before/);
    expect(REPLAY_FIDELITY_DISCLOSURE).toMatch(/indeterminate/);
    expect(REPLAY_FIDELITY_DISCLOSURE).toMatch(/incomplete/);
  });
});
