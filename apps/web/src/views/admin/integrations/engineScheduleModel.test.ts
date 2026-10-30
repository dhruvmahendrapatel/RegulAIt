import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SCHEDULE_REFUSALS,
  parseIntervalHours,
  scheduleBody,
  scheduleDeletable,
  scheduleEditable,
  scheduleRequestSummary,
  scheduleToggle,
} from "./engineScheduleModel";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

describe("engine schedules", () => {
  it("accepts a whole number of hours from 1 to 720 only", () => {
    expect(parseIntervalHours("24")).toBe(24);
    expect(parseIntervalHours(" 1 ")).toBe(1);
    expect(parseIntervalHours("720")).toBe(720);
    for (const bad of ["0", "721", "1.5", "-3", "", "abc", "1e2"]) expect(parseIntervalHours(bad)).toBeNull();
  });

  it("wraps the run request exactly as createEngineScheduleSchema expects", () => {
    const request = { engineId: "promptfoo", target: { agentId: ME }, config: { sets: ["basic"], params: {} }, projectId: OTHER, trials: 3 };
    expect(scheduleBody(request, "12")).toEqual({ body: { request, intervalHours: 12 } });
    expect(scheduleBody(request, "0")).toHaveProperty("error");
  });

  it("anyone may switch a schedule off; only the person it runs as may switch it on", () => {
    expect(scheduleToggle({ enabled: true, runAsUserId: OTHER }, ME)).toEqual({ ok: true, next: false });
    expect(scheduleToggle({ enabled: false, runAsUserId: ME }, ME)).toEqual({ ok: true, next: true });
    expect(scheduleToggle({ enabled: false, runAsUserId: OTHER }, ME)).toMatchObject({ ok: false, reason: expect.stringContaining("Only the person") });
    expect(scheduleToggle({ enabled: false, runAsUserId: null }, ME)).toMatchObject({ ok: false, reason: expect.stringContaining("no longer exists") });
  });

  it("ADR-0208 G9: only the owner edits; the owner or an admin deletes", () => {
    expect(scheduleEditable({ runAsUserId: ME }, ME)).toBe(true);
    expect(scheduleEditable({ runAsUserId: OTHER }, ME)).toBe(false);
    expect(scheduleEditable({ runAsUserId: null }, null)).toBe(false);
    expect(scheduleDeletable({ runAsUserId: ME }, ME, false)).toBe(true);
    expect(scheduleDeletable({ runAsUserId: OTHER }, ME, false)).toBe(false);
    expect(scheduleDeletable({ runAsUserId: OTHER }, ME, true)).toBe(true);
    expect(scheduleDeletable({ runAsUserId: null }, ME, true)).toBe(true);
  });

  it("reads a stored request defensively", () => {
    expect(scheduleRequestSummary({ target: { agentId: ME }, config: { sets: ["a", 3, "b"] }, trials: 2 })).toEqual({ agentId: ME, sets: ["a", "b"], trials: 2 });
    expect(scheduleRequestSummary(null)).toEqual({ agentId: null, sets: [], trials: null });
  });

  it("every refusal code named here is one engine-runs.ts sends", () => {
    const gateway = readFileSync(new URL("../../../../../gateway/src/engine-runs.ts", import.meta.url), "utf8");
    expect(Object.keys(SCHEDULE_REFUSALS).filter((code) => !gateway.includes(`error: "${code}"`))).toEqual([]);
  });
});
