import { describe, expect, it } from "vitest";
import { BOM_POSTURE_SETTINGS } from "./BomPostureCard";
import { SETTING_DEFAULTS, SETTING_KEYS } from "../integrations/isolation/isolationModel";
import { bomUnresolved, discoveryUnresolved, isolationUnresolved, orgSettingsUnresolved, tabLabel } from "./postureTabs";

const EVIDENCE = ["decisionReceiptsMode", "auditAnchorTimestampMode", "vendoredDetectionPacks", "outboundCredentialAudience"];
const loaded = (settings: unknown) => ({ data: { settings }, failed: false });
const LOADING = { data: undefined, failed: false };
const FAILED = { data: undefined, failed: true };
const bomStrict = Object.fromEntries(BOM_POSTURE_SETTINGS.map((s) => [s.key, s.strictDefault]));
const KEY = { state: "install_generated" as const, keyId: "k1", publicKeyFingerprint: "f", publicKeys: "", note: "" };
const KEYS_OK = { data: { keys: [] }, failed: false };

describe("I-2: the Enforcement posture tab labels name what is unresolved inside each tab", () => {
  it("a tab with nothing unresolved shows just its name; otherwise its counts, unknown first", () => {
    expect(tabLabel("Isolation", { unknown: 0, warnings: 0 })).toBe("Isolation");
    expect(tabLabel("Isolation", { unknown: 2, warnings: 0 })).toBe("Isolation · 2 unknown");
    expect(tabLabel("Discovery", { unknown: 0, warnings: 1 })).toBe("Discovery · 1 warning");
    expect(tabLabel("BOM evidence", { unknown: 1, warnings: 3 })).toBe("BOM evidence · 1 unknown · 3 warnings");
    // still loading: the name alone, never a zero that reads as "all clear"
    expect(tabLabel("Isolation", null)).toBe("Isolation");
  });

  it("Evidence and detection: a key not reported is unknown, a relaxed key is a warning, a failed read is all unknown", () => {
    expect(orgSettingsUnresolved(EVIDENCE, LOADING)).toBeNull();
    expect(orgSettingsUnresolved(EVIDENCE, FAILED)).toEqual({ unknown: 4, warnings: 0 });
    expect(orgSettingsUnresolved(EVIDENCE, { data: {}, failed: false })).toEqual({ unknown: 4, warnings: 0 });
    expect(orgSettingsUnresolved(EVIDENCE, loaded({ decisionReceiptsMode: "off" }))?.unknown).toBe(3);
  });

  it("BOM evidence: an unreported key or settings are unknown, a missing key and a relaxed setting are warnings", () => {
    expect(bomUnresolved(loaded(bomStrict), KEY, KEYS_OK)).toEqual({ unknown: 0, warnings: 0 });
    expect(bomUnresolved(loaded(bomStrict), undefined, KEYS_OK)).toEqual({ unknown: 1, warnings: 0 });
    expect(bomUnresolved(loaded(bomStrict), { ...KEY, state: "missing" }, KEYS_OK)).toEqual({ unknown: 0, warnings: 1 });
    expect(bomUnresolved(loaded({ ...bomStrict, decisionFactsCapture: "off" }), KEY, KEYS_OK)).toEqual({ unknown: 0, warnings: 1 });
    expect(bomUnresolved(loaded(bomStrict), KEY, { data: { nope: 1 }, failed: false })).toEqual({ unknown: 1, warnings: 0 });
    expect(bomUnresolved(FAILED, KEY, KEYS_OK)).toEqual({ unknown: BOM_POSTURE_SETTINGS.length, warnings: 0 });
    expect(bomUnresolved(loaded(bomStrict), KEY, LOADING)).toBeNull();
  });

  it("Isolation: unmeasured values read not reported, each one counted; measured relaxed floors are warnings", () => {
    expect(isolationUnresolved(LOADING)).toBeNull();
    expect(isolationUnresolved(loaded({ ...SETTING_DEFAULTS }))).toEqual({ unknown: 0, warnings: 0 });
    const two = { ...SETTING_DEFAULTS } as Record<string, unknown>;
    delete two[SETTING_KEYS[1]!];
    delete two[SETTING_KEYS[2]!];
    expect(isolationUnresolved(loaded(two))).toEqual({ unknown: 2, warnings: 0 });
    expect(isolationUnresolved(FAILED)).toEqual({ unknown: SETTING_KEYS.length, warnings: 0 });
    expect(isolationUnresolved(loaded({ ...SETTING_DEFAULTS, executorAttestationMaxAgeMinutes: 1440 }))).toEqual({ unknown: 0, warnings: 1 });
  });

  it("Discovery: every warning row counts; a posture the gateway did not report is unknown", () => {
    const clear = {
      sourcesTotal: 0,
      sourcesEnabled: [],
      staticCredentials: [],
      staleCredentials: [],
      writeScopeUnverified: [],
      credentialsRefused: [],
      credentialWarningAgeDays: 90,
      endpointRetentionDays: 30,
      statement: "",
    };
    expect(discoveryUnresolved(clear)).toEqual({ unknown: 0, warnings: 0 });
    const src = { sourceId: "s1", name: "acme-proxy", kind: "proxy" };
    expect(discoveryUnresolved({ ...clear, sourcesEnabled: [src], staleCredentials: [{ ...src, ageDays: 200 }] })).toEqual({ unknown: 0, warnings: 2 });
    expect(discoveryUnresolved(undefined)).toEqual({ unknown: 1, warnings: 0 });
  });
});
