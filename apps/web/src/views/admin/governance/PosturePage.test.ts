/** UIB-04 — a 14-day window is 14 columns, days without spend at zero. */
import { describe, expect, it } from "vitest";
import { fillDailyWindow } from "./PosturePage";

const zero = (day: string) => ({ day, costUsd: 0 });

describe("fillDailyWindow", () => {
  it("pads a single busy day out to the full window ending TODAY, like the server's query", () => {
    const out = fillDailyWindow([{ day: "2026-10-02", costUsd: 0.1385 }], 14, zero, new Date("2026-10-05T11:00:00Z"));
    expect(out).toHaveLength(14);
    expect(out[0]!.day).toBe("2026-09-22");
    expect(out[13]!.day).toBe("2026-10-05");
    expect(out[10]).toEqual({ day: "2026-10-02", costUsd: 0.1385 });
    expect(out.filter((p) => p.costUsd === 0)).toHaveLength(13);
  });
  it("keeps every present day in place and fills the gaps, trailing quiet days included", () => {
    const out = fillDailyWindow([{ day: "2026-10-01", costUsd: 2 }, { day: "2026-09-28", costUsd: 1 }], 7, zero, new Date("2026-10-03T00:30:00Z"));
    expect(out.map((p) => p.day)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(out[1]!.costUsd).toBe(1);
    expect(out[4]!.costUsd).toBe(2);
    expect(out[6]!.costUsd).toBe(0);
  });
  it("ends on today when nothing was spent in the window", () => {
    const out = fillDailyWindow([], 3, zero, new Date("2026-10-03T10:00:00Z"));
    expect(out.map((p) => p.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
  it("never draws a day the server could not have returned", () => {
    // a point older than the window is dropped, not drawn before it
    const out = fillDailyWindow([{ day: "2026-09-01", costUsd: 5 }], 3, zero, new Date("2026-10-03T10:00:00Z"));
    expect(out.map((p) => p.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(out.every((p) => p.costUsd === 0)).toBe(true);
  });
});
