import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AI_APP_RISK_DATASET,
  AI_APP_RISK_DATASET_VERSION,
  AI_APP_RISK_WEIGHTS,
  aiAppRiskDatasetDigest,
  aiAppRiskRowProblems,
  scoreAiApp,
  type AiAppRiskRow,
} from "./ai-app-risk.js";
import { SHADOW_AI_CATALOG_V3 } from "./shadow-catalog-v3.js";

const S = (url = "https://vendor.example/trust") => ({ url, checkedOn: "2026-11-17" });
const good: AiAppRiskRow = {
  provider: "vendor-x",
  offering: "Vendor X Enterprise",
  attributes: {
    trainsOnCustomerData: { value: "no", source: S() },
    retention: { value: "none", source: S() },
    hostingRegions: { value: ["us", "eu"], source: S() },
    certifications: { value: ["soc2_type2", "iso27001"], source: S() },
    ssoSupport: { value: "saml", source: S() },
    subProcessors: { value: { url: "https://vendor.example/subprocessors" }, source: S() },
  },
};

describe("ADR-0363 slice 3: AI app risk dataset", () => {
  it("pins version, row count and content hash: v1 can never drift silently", () => {
    expect(AI_APP_RISK_DATASET_VERSION).toBe(1);
    expect(AI_APP_RISK_DATASET.length).toBe(PINNED_ROWS);
    expect(createHash("sha256").update(JSON.stringify(AI_APP_RISK_DATASET)).digest("hex")).toBe(PINNED_HASH);
    expect(Object.isFrozen(AI_APP_RISK_DATASET)).toBe(true);
    expect(Object.isFrozen(AI_APP_RISK_DATASET[0]!.attributes.retention)).toBe(true);
  });

  it("every row validates: each known value has an https source and a check date, each unknown has none", () => {
    for (const r of AI_APP_RISK_DATASET) expect(aiAppRiskRowProblems(r), r.provider).toEqual([]);
    const providers = AI_APP_RISK_DATASET.map((r) => r.provider);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("every row's provider is a catalogue provider, so the inventory join can find it", () => {
    const catalogue = new Set(SHADOW_AI_CATALOG_V3.map((e) => e.provider));
    for (const r of AI_APP_RISK_DATASET) expect(catalogue.has(r.provider), r.provider).toBe(true);
  });

  it("the validator refuses an unsourced known value, a sourced unknown, http and bad shapes", () => {
    expect(aiAppRiskRowProblems(good)).toEqual([]);
    const bad: AiAppRiskRow = {
      ...good,
      attributes: {
        ...good.attributes,
        trainsOnCustomerData: { value: "no", source: null },
        retention: { value: "unknown", source: S() },
        hostingRegions: { value: ["US East"], source: S("http://vendor.example") },
        certifications: { value: ["made_up" as never], source: S() },
      },
    };
    const problems = aiAppRiskRowProblems(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        "vendor-x.trainsOnCustomerData: a known value needs its source",
        "vendor-x.retention: an unknown value carries no source",
        "vendor-x.hostingRegions: source must be an https URL",
        "vendor-x: hosting regions",
        "vendor-x: certification",
      ]),
    );
  });

  it("the score is the sum of its shown factors; maxima sum to 100", () => {
    const w = AI_APP_RISK_WEIGHTS;
    expect(w.training.yes + w.retention.until_deleted + w.regions.unknown + w.certifications.none + w.sso.none + w.subProcessors.unknown).toBe(100);
    const s = scoreAiApp("vendor-x", [good]);
    expect(s).toMatchObject({ score: 0, band: "low", suggestedSiteRule: "allow", offering: "Vendor X Enterprise" });
    expect(s.factors.map((f) => f.attribute)).toEqual(["trainsOnCustomerData", "retention", "hostingRegions", "certifications", "ssoSupport", "subProcessors"]);
    expect(s.factors.every((f) => f.source?.url.startsWith("https://"))).toBe(true);

    const risky: AiAppRiskRow = {
      ...good,
      attributes: { ...good.attributes, trainsOnCustomerData: { value: "opt_out", source: S() }, retention: { value: { days: 90 }, source: S() } },
    };
    const r = scoreAiApp("vendor-x", [risky]);
    expect(r.score).toBe(30);
    expect(r.band).toBe("medium");
    expect(r.factors.reduce((n, f) => n + f.points, 0)).toBe(r.score);
  });

  it("an app not in the dataset scores as every attribute unknown, says so, and is suggested for blocking", () => {
    const s = scoreAiApp("never-heard-of-it", []);
    expect(s.factors[0]).toMatchObject({ attribute: "dataset", points: 0 });
    expect(s.score).toBe(95);
    expect(s.band).toBe("high");
    expect(s.suggestedSiteRule).toBe("block");
    expect(s.offering).toBeNull();
  });

  it("the canonical digest is stable and moves with any change", () => {
    expect(aiAppRiskDatasetDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(aiAppRiskDatasetDigest([good])).not.toBe(aiAppRiskDatasetDigest([{ ...good, offering: "other" }]));
  });
});

// filled from the frozen dataset (ai-app-risk-data.ts); a v2 is the only way to change them
const PINNED_ROWS = 10;
const PINNED_HASH = "17e21cce428d8bda3126f306de82d653845c7230b8b90432a43ae1bf34c920e6";
