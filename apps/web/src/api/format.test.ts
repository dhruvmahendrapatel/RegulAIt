import { describe, expect, it } from "vitest";
import { actorLabel, evidenceLabel, fmtAt, frameworkLabel, humanize, plural, providerLabel } from "./format";

describe("display helpers — the UI never shows identifiers where words belong", () => {
  it("humanize turns ids into words and spells sign-off", () => {
    expect(humanize("use_case_questionnaire")).toBe("Use case questionnaire");
    expect(humanize("compliance-signoff")).toBe("Compliance sign-off");
    expect(humanize("signoff")).toBe("Sign-off");
    expect(humanize(null)).toBe("");
  });

  it("plural never writes (s)", () => {
    expect(plural(1, "row")).toBe("1 row");
    expect(plural(0, "row")).toBe("0 rows");
    expect(plural(1200, "alert")).toBe("1,200 alerts");
    expect(plural(2, "policy", "policies")).toBe("2 policies");
  });

  it("names frameworks, providers and evidence kinds, with a readable fallback", () => {
    expect(frameworkLabel("eu-ai-act")).toBe("EU AI Act");
    expect(frameworkLabel("hipaa")).toBe("HIPAA");
    expect(frameworkLabel("some-new-pack")).toBe("Some new pack");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("acme_llm")).toBe("Acme llm");
    expect(evidenceLabel("saas_export")).toBe("SaaS export");
    expect(evidenceLabel("new_kind")).toBe("New kind");
  });

  it("names the gateway's own actor and never prints a bare nil UUID", () => {
    const names = new Map([["u-1", "Ada Admin"]]);
    expect(actorLabel("00000000-0000-0000-0000-000000000000", names)).toBe("System");
    expect(actorLabel(null, names)).toBe("System");
    expect(actorLabel("u-1", names)).toBe("Ada Admin");
    expect(actorLabel("9f1c2d3e-aaaa-bbbb-cccc-000000000001", names)).toBe("9f1c2d3e…");
  });

  it("formats a timestamp on one line, to the minute", () => {
    expect(fmtAt("2026-10-02T15:25:01.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(fmtAt("not a date")).toBe("not a date");
  });
});
