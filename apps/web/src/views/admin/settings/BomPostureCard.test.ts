import { describe, expect, it } from "vitest";
import { BOM_POSTURE_SETTINGS, bomLooserThanStored, bomPostureValue, bomRelaxed, bomStoredValue, saveBomPostureAndReload } from "./BomPostureCard";

/* eslint-disable @typescript-eslint/no-explicit-any */
const shared = async (): Promise<any> => import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/bom/settings.ts", import.meta.url).pathname);
const setting = (key: string) => BOM_POSTURE_SETTINGS.find((s) => s.key === key)!;

describe("the BOM posture rows mirror @regulait/shared", () => {
  it("every BOM setting, its strict default, its options and its copy", async () => {
    const s = await shared();
    expect(BOM_POSTURE_SETTINGS.map((x) => x.key)).toEqual(s.BOM_SETTING_KEYS);
    for (const row of BOM_POSTURE_SETTINGS) {
      expect(row.strictDefault, row.key).toEqual(s.BOM_STRICT_DEFAULTS[row.key]);
      expect({ label: row.label, strict: row.strict, relaxed: row.relaxed }, row.key).toEqual(s.BOM_SETTING_COPY[row.key]);
      // the relaxation predicate agrees with the gateway's on every offered value
      for (const option of row.options ?? []) {
        const value = bomPostureValue(row, option)!;
        expect(bomRelaxed(row, value), `${row.key}=${option}`).toBe(s.bomSettingRelaxed(row.key, value));
        // and the gateway's PUT schema accepts every value the form can send
        expect(s.bomOrgSettingsFields[row.key].safeParse(value).success, `${row.key}=${option}`).toBe(true);
      }
    }
    expect(setting("decisionFactsCapture").options).toEqual(s.DECISION_FACTS_CAPTURE_MODES);
    expect(setting("bomExportRoles").options).toEqual(s.BOM_EXPORT_ROLE_MODES);
    expect(setting("bomPersonIdentifiers").options).toEqual(s.BOM_PERSON_IDENTIFIER_MODES);
    expect(setting("aiBomSnapshotTriggers").options).toEqual(s.AI_BOM_SNAPSHOT_TRIGGER_MODES);
    expect(setting("aiBomSnapshotWithoutKey").options).toEqual(s.AI_BOM_SNAPSHOT_WITHOUT_KEY_MODES);
    expect(setting("decisionBomFiniteLockFinality").options).toEqual(s.DECISION_BOM_FINITE_LOCK_FINALITY_MODES);
  });
});

describe("the step-up sentence follows the stored value (bomSettingLooser)", () => {
  it("agrees with the gateway's comparator for every pair of offered values", async () => {
    const s = await shared();
    for (const row of BOM_POSTURE_SETTINGS) {
      const inputs = row.options ?? ["10", "30", "31", "600"];
      for (const a of inputs) {
        for (const b of inputs) {
          const value = bomPostureValue(row, a)!;
          const stored = bomPostureValue(row, b)!;
          expect(bomLooserThanStored(row, value, stored), `${row.key}: ${a} over stored ${b}`).toBe(s.bomSettingLooser(row.key, value, stored));
        }
      }
    }
  });
  it("tightening from a relaxed value asks for no step-up, though the value is still relaxed", () => {
    const finality = setting("decisionBomFinality");
    expect(bomLooserThanStored(finality, "anchored_unverified_destination", "chain_signed")).toBe(false);
    expect(bomRelaxed(finality, "anchored_unverified_destination")).toBe(true);
    const limit = setting("bomExportRateLimitPerMinute");
    expect(bomLooserThanStored(limit, 100, 200)).toBe(false);
    expect(bomLooserThanStored(limit, 20, 10)).toBe(true);
  });
});

describe("BOM posture values", () => {
  it("CycloneDX: 1.7 is required; 1.6 may be added; order is normalised", () => {
    const versions = setting("cyclonedxExportVersions");
    expect(bomPostureValue(versions, "1.7")).toEqual(["1.7"]);
    expect(bomPostureValue(versions, "1.6,1.7")).toEqual(["1.7", "1.6"]);
    for (const bad of ["", "1.6", "1.8", "1.7,1.7"]) expect(bomPostureValue(versions, bad)).toBeNull();
  });
  it("the export limit is a whole number from 1 to 600; above 30 is a relaxation", () => {
    const limit = setting("bomExportRateLimitPerMinute");
    expect(bomPostureValue(limit, "600")).toBe(600);
    for (const bad of ["", "0", "601", "-1", "1.5", "NaN", "0x20", "1e2"]) expect(bomPostureValue(limit, bad)).toBeNull();
    expect(bomRelaxed(limit, 10)).toBe(false);
    expect(bomRelaxed(limit, 31)).toBe(true);
  });
  it("a stored value of the wrong type is unknown, never read as the strict default", () => {
    expect(bomStoredValue(setting("decisionFactsCapture"), ["on"])).toBeNull();
    expect(bomStoredValue(setting("bomExportRateLimitPerMinute"), "30")).toBeNull();
    expect(bomStoredValue(setting("cyclonedxExportVersions"), "1.7")).toBeNull();
    expect(bomStoredValue(setting("decisionBomFinality"), "future_mode")).toBeNull();
    expect(bomStoredValue(setting("cyclonedxExportVersions"), ["1.6", "1.7"])).toEqual(["1.7", "1.6"]);
  });
  it("a saved write is not a fresh baseline until the read-back succeeds; a refused write is never reloaded", async () => {
    const write = async () => undefined;
    expect(await saveBomPostureAndReload({ decisionFactsCapture: "off" }, write, async () => false)).toBe(false);
    expect(await saveBomPostureAndReload({ decisionFactsCapture: "off" }, write, async () => true)).toBe(true);
    let reloaded = false;
    await expect(
      saveBomPostureAndReload({ decisionFactsCapture: "off" }, async () => { throw new Error("step-up declined"); }, async () => { reloaded = true; return true; }),
    ).rejects.toThrow("step-up declined");
    expect(reloaded).toBe(false);
  });
});
