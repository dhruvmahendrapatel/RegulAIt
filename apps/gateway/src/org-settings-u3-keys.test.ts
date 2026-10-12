/**
 * U3 settings batch — the five org settings that had a column and a reader but
 * no writer through `PUT /v1/org/settings`: the review-workbench bulk fences
 * (ADR-0046) and the model-risk dials (ADR-0045 / ADR-0086). No database: this
 * pins the PUT schema's bounds and the strictness registry's looser-direction
 * rule for each, so the `settings_relax` step-up and `detail.relaxed` treat them
 * like every other key. The write itself is covered in org-settings.test.ts.
 */
import { describe, expect, it } from "vitest";
import { updateOrgSettingsSchema } from "@regulait/shared";
import { ORG_SETTING_STRICTNESS, relaxedOrgSettingKeys } from "./org-setting-strictness.js";

const ok = (body: Record<string, unknown>) => updateOrgSettingsSchema.safeParse(body).success;

describe("the PUT schema bounds match the DB CHECKs", () => {
  it("approvalBulkMaxItems is a whole number from 1 to 500", () => {
    expect(ok({ approvalBulkMaxItems: 1 })).toBe(true);
    expect(ok({ approvalBulkMaxItems: 500 })).toBe(true);
    for (const bad of [0, 501, 2.5, null, "25"]) expect(ok({ approvalBulkMaxItems: bad })).toBe(false);
  });
  it("mrmExpiryWarnDays is 0 to 3650; the threshold is 1 to 100000", () => {
    expect(ok({ mrmExpiryWarnDays: 0 })).toBe(true);
    expect(ok({ mrmExpiryWarnDays: 3650 })).toBe(true);
    expect(ok({ mrmExpiryWarnDays: 3651 })).toBe(false);
    expect(ok({ mrmStalenessRecertThreshold: 1 })).toBe(true);
    expect(ok({ mrmStalenessRecertThreshold: 100_000 })).toBe(true);
    expect(ok({ mrmStalenessRecertThreshold: 0 })).toBe(false);
    expect(ok({ mrmStalenessRecertThreshold: 100_001 })).toBe(false);
  });
  it("the two switches are booleans", () => {
    expect(ok({ approvalBulkSensitiveBlocked: false, mrmStalenessRecertEnabled: false })).toBe(true);
    expect(ok({ approvalBulkSensitiveBlocked: "off" })).toBe(false);
    expect(ok({ mrmStalenessRecertEnabled: null })).toBe(false);
  });
  it("mrmEnforced stays on its own audited endpoint (POST /v1/mrm/enforcement)", () => {
    expect(ok({ mrmEnforced: false })).toBe(false);
  });
});

describe("the strictness registry judges them like every other key", () => {
  it("strict defaults: 25, fenced, staleness on at threshold 1; the warn window is exempt", () => {
    expect(ORG_SETTING_STRICTNESS.approvalBulkMaxItems).toMatchObject({ kind: "rule", strict: 25 });
    expect(ORG_SETTING_STRICTNESS.approvalBulkSensitiveBlocked).toMatchObject({ kind: "rule", strict: true });
    expect(ORG_SETTING_STRICTNESS.mrmStalenessRecertEnabled).toMatchObject({ kind: "rule", strict: true });
    expect(ORG_SETTING_STRICTNESS.mrmStalenessRecertThreshold).toMatchObject({ kind: "rule", strict: 1 });
    expect(ORG_SETTING_STRICTNESS.mrmExpiryWarnDays.kind).toBe("exempt");
  });
  it("a larger bulk cap, the fence off, staleness off and a higher threshold are relaxations", () => {
    expect(
      relaxedOrgSettingKeys({
        approvalBulkMaxItems: 26,
        approvalBulkSensitiveBlocked: false,
        mrmStalenessRecertEnabled: false,
        mrmStalenessRecertThreshold: 2,
        mrmExpiryWarnDays: 0,
      }).sort(),
    ).toEqual(["approvalBulkMaxItems", "approvalBulkSensitiveBlocked", "mrmStalenessRecertEnabled", "mrmStalenessRecertThreshold"]);
  });
  it("tightening asks for nothing; loosening a value tightened past the default does (decision 26)", () => {
    expect(relaxedOrgSettingKeys({ approvalBulkMaxItems: 10, mrmStalenessRecertEnabled: true })).toEqual([]);
    expect(relaxedOrgSettingKeys({ approvalBulkMaxItems: 20 }, { approvalBulkMaxItems: 10 })).toEqual(["approvalBulkMaxItems"]);
    expect(relaxedOrgSettingKeys({ approvalBulkMaxItems: 5 }, { approvalBulkMaxItems: 10 })).toEqual([]);
    expect(relaxedOrgSettingKeys({ mrmStalenessRecertThreshold: 1 }, { mrmStalenessRecertThreshold: 50 })).toEqual([]);
  });
});
