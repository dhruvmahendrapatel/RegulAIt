import { describe, expect, it } from "vitest";
import { BOM_POSTURE_SETTINGS, bomPostureValue, bomStoredValue, saveBomPostureAndReload } from "./EnforcementPosturePage";

const setting = (key: string) => BOM_POSTURE_SETTINGS.find((entry) => entry.key === key)!;
describe("BOM posture contract boundaries", () => {
  it("requires CycloneDX 1.7 and accepts only the optional 1.6 addition", () => {
    const versions = setting("cyclonedxExportVersions");
    expect(bomPostureValue(versions, "1.7")).toEqual(["1.7"]);
    expect(bomPostureValue(versions, "1.7,1.6")).toEqual(["1.7", "1.6"]);
    expect(bomPostureValue(versions, "1.6,1.7")).toEqual(["1.7", "1.6"]);
    for (const unsupported of ["", "1.6", "1.8", "1.7,1.7", "1.7,1.6,1.6"]) expect(bomPostureValue(versions, unsupported)).toBeNull();
  });
  it("refuses non-integral, unknown and out-of-range export limits", () => {
    const limit = setting("bomExportRateLimitPerMinute");
    expect(bomPostureValue(limit, "1")).toBe(1);
    expect(bomPostureValue(limit, "600")).toBe(600);
    for (const unsupported of ["", "0", "601", "-1", "1.5", "NaN", "Infinity", "0x20"]) expect(bomPostureValue(limit, unsupported)).toBeNull();
  });
  it("does not report a fresh baseline when the write succeeds but reloading fails", async () => {
    const calls: string[] = [];
    const body = { decisionFactsCapture: "off" };
    const write = async (captured: Record<string, unknown>) => { expect(captured).toEqual(body); calls.push("write accepted"); };
    const failedReload = async () => { calls.push("read failed"); return false; };
    expect(await saveBomPostureAndReload(body, write, failedReload)).toBe(false);
    expect(calls).toEqual(["write accepted", "read failed"]);
    expect(await saveBomPostureAndReload(body, write, async () => true)).toBe(true);
  });
  it("never reloads or claims a saved setting after the gateway refuses the write", async () => {
    let reloaded = false;
    await expect(saveBomPostureAndReload({ decisionFactsCapture: "off" }, async () => { throw new Error("step-up refused"); }, async () => { reloaded = true; return true; })).rejects.toThrow("step-up refused");
    expect(reloaded).toBe(false);
  });
  it("refuses malformed stored setting types rather than claiming strict defaults",()=>{expect(bomStoredValue(setting("decisionFactsCapture"),["on"])).toBeNull();expect(bomStoredValue(setting("bomExportRateLimitPerMinute"),"30")).toBeNull();expect(bomStoredValue(setting("cyclonedxExportVersions"),"1.7")).toBeNull();expect(bomStoredValue(setting("cyclonedxExportVersions"),["1.6","1.7"])).toEqual(["1.7","1.6"]);});
  it("never invents permissive states for missing or future settings", () => {
    for (const control of BOM_POSTURE_SETTINGS) {
      expect(bomPostureValue(control, "")).toBeNull();
      expect(bomPostureValue(control, "future_mode")).toBeNull();
    }
    expect(bomPostureValue(setting("decisionFactsCapture"), "on")).toBe("on");
    expect(bomPostureValue(setting("decisionBomFiniteLockFinality"), "refuse")).toBe("refuse");
  });
});
