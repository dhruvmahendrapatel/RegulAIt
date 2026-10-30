import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  breachedText,
  fileTooLarge,
  loosenedThresholds,
  parseFeatureFile,
  parseImportanceFile,
  stat,
  statusTone,
  topImportances,
} from "./classicalDrift";

const STRICT = { psiWarn: 0.1, psiAlert: 0.25, ksAlert: 0.1, jsAlert: 0.05 };

describe("classical drift tab logic", () => {
  it("reads a feature list in either shape and keeps the window", () => {
    const list = [{ name: "age", kind: "numeric", edges: [0, 1], counts: [3] }];
    expect(parseFeatureFile(JSON.stringify(list))).toEqual({ ok: true, value: { features: list } });
    const wrapped = parseFeatureFile(JSON.stringify({ features: list, windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-02T00:00:00Z" }));
    expect(wrapped).toEqual({ ok: true, value: { features: list, windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-02T00:00:00Z" } });
  });

  it("refuses a malformed file in words", () => {
    expect(parseFeatureFile("{")).toEqual({ ok: false, error: "The file is not valid JSON." });
    expect(parseFeatureFile("[]")).toEqual({ ok: false, error: "The file must hold a non-empty list of features." });
    expect(parseFeatureFile(JSON.stringify([{ name: "x", kind: "text", counts: [] }])).ok).toBe(false);
    expect(parseImportanceFile(JSON.stringify([{ feature: "x", value: "high" }]))).toEqual({ ok: false, error: "Each entry needs a feature name and a numeric value." });
    expect(parseImportanceFile(JSON.stringify({ importances: [{ feature: "x", value: 0.2 }] }))).toEqual({ ok: true, value: [{ feature: "x", value: 0.2 }] });
  });

  it("names a loosened threshold, and only a loosened one", () => {
    expect(loosenedThresholds(STRICT, STRICT)).toEqual([]);
    expect(loosenedThresholds({ ...STRICT, psiAlert: 0.2 }, STRICT)).toEqual([]);
    expect(loosenedThresholds({ ...STRICT, psiAlert: 0.3, jsAlert: 0.1 }, STRICT)).toEqual(["PSI alert", "Jensen–Shannon alert"]);
  });

  it("orders importances by magnitude and formats statistics", () => {
    const top = topImportances([
      { feature: "a", value: 0.1 },
      { feature: "b", value: -0.5 },
      { feature: "c", value: 0.3 },
    ], 2);
    expect(top.map((t) => t.feature)).toEqual(["b", "c"]);
    expect(stat(null)).toBe("—");
    expect(stat(0.12345)).toBe("0.123");
    expect(breachedText(["psi", "ks"])).toBe("past PSI, KS distance");
    expect(statusTone("drift")).toBe("danger");
    expect(statusTone("insufficient")).toBe("info");
  });

  it("refuses a file over the gateway's body limit before sending it", () => {
    expect(fileTooLarge({ size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(fileTooLarge({ size: MAX_UPLOAD_BYTES + 1 })).toMatch(/larger than 512 KB/);
  });
});
