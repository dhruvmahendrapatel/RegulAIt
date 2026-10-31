import { describe, expect, it } from "vitest";
import { previewHeading } from "./ListPreview";

describe("P3 preview heading", () => {
  it("says the count and every attention count that is not zero", () => {
    expect(previewHeading(146, "devices", [{ label: "silent", count: 2 }])).toBe("146 devices · 2 silent");
    expect(previewHeading(1284, "runs", [{ label: "failed", count: 1 }, { label: "stuck", count: 0 }])).toBe("1,284 runs · 1 failed");
  });
  it("says nothing before the count is known, and never invents an attention count", () => {
    expect(previewHeading(null, "runs", [{ label: "failed", count: 3 }])).toBe("");
    expect(previewHeading(12, "runs", [{ label: "failed", count: null }])).toBe("12 runs");
  });
});
