import { describe, expect, it } from "vitest";
import { KILL_SWITCH_DIALS, killSwitchNarrowingOnly } from "./kill-switch-guard.js";

describe("killSwitchNarrowingOnly (ADR-0338 §7)", () => {
  it.each(KILL_SWITCH_DIALS)("narrowing runs under %s", (dial) => {
    expect(killSwitchNarrowingOnly({ dial, direction: "narrowing" })).toBeNull();
  });
  it("widening runs only under normal", () => {
    expect(killSwitchNarrowingOnly({ dial: "normal", direction: "widening" })).toBeNull();
    for (const dial of KILL_SWITCH_DIALS.filter((d) => d !== "normal")) {
      expect(killSwitchNarrowingOnly({ dial, direction: "widening" })).toMatch(new RegExp(`dial is ${dial}`));
    }
  });
});
