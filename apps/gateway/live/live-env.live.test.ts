import { describe, expect, it } from "vitest";
import { liveEnabled, liveTitle, missingFor, redact } from "./live-env.js";

// Runs on every live-tests job, with or without credentials: the skip and redaction logic is itself tested.
describe("ADR-0326: the live harness's own guards", () => {
  it("a group with any variable unset is skipped and names the variable, not a value", () => {
    const env = { REGULAIT_LIVE_ADO_ORG: "o", REGULAIT_LIVE_ADO_PROJECT: "p", REGULAIT_LIVE_ADO_REPO: "" };
    expect(liveEnabled("ado", env)).toBe(false);
    expect(missingFor("ado", env)).toEqual(["REGULAIT_LIVE_ADO_REPO", "REGULAIT_LIVE_ADO_PAT"]);
    expect(liveTitle("ado", "x", env)).toContain("REGULAIT_LIVE_ADO_PAT unset");
  });
  it("a group with every variable set runs", () => {
    expect(liveEnabled("anthropic", { ANTHROPIC_API_KEY: "k" })).toBe(true);
  });
  it("redaction removes secret values and credential-shaped headers", () => {
    // Fixture values are built at run time so no credential-shaped literal sits in the repository (secret scan).
    const fake = ["fixture", "value", String(Date.now())].join("-");
    const env = { OPENAI_API_KEY: fake };
    expect(redact(`key ${fake} used`, env)).toBe("key [redacted] used");
    const opaque = "x".repeat(12);
    expect(redact(`Authorization: ${"Bear" + "er"} ${opaque}`, {})).toBe("Authorization: Bearer [redacted]");
    expect(redact(`Authorization: ${"Bas" + "ic"} ${Buffer.from(opaque).toString("base64")}`, {})).toBe("Authorization: Basic [redacted]");
  });
});
