import { describe, expect, it } from "vitest";
import { gateBody, gateFormFrom, gateState, REDTEAM_GATE_BOUNDS, relaxations, type RedteamGateSettings } from "./copilotRedteamGateModel";

const LIB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const current: RedteamGateSettings = {
  enabled: true,
  maxAgeDays: 30,
  minResistRate: 1,
  libraryId: LIB,
  minTrials: 3,
  requiredClasses: ["prompt_injection", "indirect_prompt_injection", "data_exfiltration", "pii_leak"],
};

describe("copilot narrator red-team gate model (ADR-0056 §5)", () => {
  it("pins the gateway's bounds", () => {
    // COPILOT_REDTEAM_MAX_AGE_LIMIT_DAYS and RED_TEAM_MAX_TRIALS
    expect(REDTEAM_GATE_BOUNDS).toEqual({ maxAgeDays: 365, maxTrials: 25 });
  });

  it("an unchanged form sends nothing", () => {
    const out = gateBody(gateFormFrom(current), current);
    expect(out).toEqual({ ok: true, body: {}, relaxes: [] });
  });

  it("tightening is sent without a relaxation", () => {
    const out = gateBody({ ...gateFormFrom(current), maxAgeDays: "14", minTrials: "5" }, current);
    expect(out).toEqual({ ok: true, body: { maxAgeDays: 14, minTrials: 5 }, relaxes: [] });
  });

  it("names every relaxation, like the gateway's copilotRedteamRelaxed", () => {
    const out = gateBody({ enabled: false, maxAgeDays: "60", minResistPercent: "90", libraryId: OTHER, minTrials: "1" }, current);
    if (!out.ok) throw new Error(out.problem);
    expect(out.body).toEqual({ enabled: false, maxAgeDays: 60, minResistRate: 0.9, libraryId: OTHER, minTrials: 1 });
    expect(out.relaxes).toHaveLength(5);
    expect(out.relaxes[0]).toMatch(/turns the gate off/);
  });

  it("any library change is a relaxation, clearing it included, and designating the first one too", () => {
    expect(relaxations({ libraryId: null }, current)).toEqual(["clears the library, so no agent may narrate"]);
    expect(relaxations({ libraryId: LIB }, { ...current, libraryId: null })).toEqual(["changes which library decides"]);
    const cleared = gateBody({ ...gateFormFrom(current), libraryId: "" }, current);
    expect(cleared.ok && cleared.body).toEqual({ libraryId: null });
  });

  it("refuses out-of-range values with a sentence", () => {
    const f = gateFormFrom(current);
    expect(gateBody({ ...f, maxAgeDays: "0" }, current)).toMatchObject({ ok: false, problem: expect.stringMatching(/1 to 365/) });
    expect(gateBody({ ...f, maxAgeDays: "366" }, current).ok).toBe(false);
    expect(gateBody({ ...f, minResistPercent: "101" }, current)).toMatchObject({ ok: false, problem: expect.stringMatching(/0 to 100/) });
    expect(gateBody({ ...f, minTrials: "26" }, current)).toMatchObject({ ok: false, problem: expect.stringMatching(/1 to 25/) });
    expect(gateBody({ ...f, minTrials: "2.5" }, current).ok).toBe(false);
  });

  it("compares the floor in whole percent, so a stored fraction is not changed by display rounding", () => {
    const s = { ...current, minResistRate: 0.955 };
    expect(gateFormFrom(s).minResistPercent).toBe("96");
    expect(gateBody(gateFormFrom(s), s)).toEqual({ ok: true, body: {}, relaxes: [] });
  });

  it("states the gate in one line", () => {
    expect(gateState(current)).toEqual({ label: "Gate on", tone: "ok" });
    expect(gateState({ ...current, libraryId: null }).tone).toBe("warn");
    expect(gateState({ ...current, enabled: false }).tone).toBe("danger");
  });
});
