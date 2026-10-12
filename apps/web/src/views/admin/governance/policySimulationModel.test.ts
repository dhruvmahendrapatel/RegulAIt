import { describe, expect, it } from "vitest";
import { POLICY_SIMULATION_BOUNDS, settingsBody, settingsFormFrom, type PolicySimulationSettings } from "./policySimulationModel";

const current: PolicySimulationSettings = { requirePreviewBeforeActivate: true, defaultWindowDays: 30, defaultRowCap: 5000 };

describe("blast-radius settings form", () => {
  it("mirrors the gateway's bounds", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/policy-simulation.ts", import.meta.url).pathname);
    expect(POLICY_SIMULATION_BOUNDS.maxWindowDays).toBe(shared.POLICY_SIMULATION_MAX_WINDOW_DAYS);
    expect(POLICY_SIMULATION_BOUNDS.maxRows).toBe(shared.POLICY_SIMULATION_MAX_ROWS);
    expect(shared.policySimulationSettingsSchema.safeParse({ defaultWindowDays: POLICY_SIMULATION_BOUNDS.maxWindowDays + 1 }).success).toBe(false);
  });

  it("sends only what changed", () => {
    const f = settingsFormFrom(current);
    expect(settingsBody(f, current)).toEqual({ ok: true, body: {}, relaxes: false });
    expect(settingsBody({ ...f, defaultWindowDays: "60" }, current)).toEqual({ ok: true, body: { defaultWindowDays: 60 }, relaxes: false });
  });

  it("names turning the preview requirement off as a relaxation, and turning it on as not one", () => {
    const f = settingsFormFrom(current);
    expect(settingsBody({ ...f, requirePreviewBeforeActivate: false }, current)).toEqual({
      ok: true,
      body: { requirePreviewBeforeActivate: false },
      relaxes: true,
    });
    const relaxed = { ...current, requirePreviewBeforeActivate: false };
    expect(settingsBody({ ...settingsFormFrom(relaxed), requirePreviewBeforeActivate: true }, relaxed)).toEqual({
      ok: true,
      body: { requirePreviewBeforeActivate: true },
      relaxes: false,
    });
  });

  it("refuses numbers outside the bounds or not whole", () => {
    const f = settingsFormFrom(current);
    for (const bad of ["0", "181", "1.5", "abc", ""]) expect(settingsBody({ ...f, defaultWindowDays: bad }, current)).toMatchObject({ ok: false });
    for (const bad of ["0", "20001", "-3"]) expect(settingsBody({ ...f, defaultRowCap: bad }, current)).toMatchObject({ ok: false });
  });
});
