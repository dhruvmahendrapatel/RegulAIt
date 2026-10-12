import { describe, expect, it } from "vitest";
import { asrText, probeTrialSummary, type ProbeTrial } from "./redteamModel";

const t = (probeKey: string, trial: number, defeated: boolean, extra: Partial<ProbeTrial> = {}): ProbeTrial => ({
  probeKey,
  attackClass: "jailbreak",
  severity: "high",
  trial,
  defeated,
  error: null,
  ...extra,
});

describe("probeTrialSummary", () => {
  it("counts defeats over usable trials and keeps errors apart", () => {
    const [s] = probeTrialSummary([t("p1", 1, true), t("p1", 2, false), t("p1", 3, false, { error: "timeout" })]);
    expect(s).toMatchObject({ probeKey: "p1", trials: 2, defeated: 1, errored: 1, flapped: true });
  });

  it("does not call a steady result a flap, and ranks the worst first", () => {
    const out = probeTrialSummary([t("steady", 1, false), t("steady", 2, false), t("bad", 1, true, { severity: "low" }), t("bad", 2, true, { severity: "low" })]);
    expect(out.map((s) => [s.probeKey, s.flapped])).toEqual([
      ["bad", false],
      ["steady", false],
    ]);
  });

  it("breaks a tie by severity", () => {
    const out = probeTrialSummary([t("lo", 1, true, { severity: "low" }), t("crit", 1, true, { severity: "critical" })]);
    expect(out[0]!.probeKey).toBe("crit");
  });
});

describe("asrText", () => {
  it("states the rate with its interval and denominator", () => {
    expect(asrText({ asr: 0.25, asrLower: 0.1, asrUpper: 0.5, asrTrials: 8 })).toBe("25.0% (95% CI 10.0%–50.0%) over 8 trials");
  });
  it("says an unmeasured run is unmeasured, never 0%", () => {
    expect(asrText({ asr: null, asrLower: null, asrUpper: null, asrTrials: 0 })).toMatch(/not measured/);
  });
});
