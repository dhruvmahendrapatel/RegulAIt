import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLIANCE_PACKS } from "./compliance-packs.js";
import { TRUST_DIMENSIONS } from "./risks.js";
import { CONTROL_DIMENSION_OVERRIDES, dimensionForControl } from "./trust-dimensions.js";

const allControls = DEFAULT_COMPLIANCE_PACKS.flatMap((p) => p.controls);

describe("ADR-0148 — control → trust dimension", () => {
  it("every override names a control that a default pack actually defines", () => {
    // a stale override would silently classify nothing; fail loudly instead
    const refs = new Set(allControls.map((c) => c.controlRef));
    for (const ref of Object.keys(CONTROL_DIMENSION_OVERRIDES)) expect(refs, ref).toContain(ref);
  });

  it("every attestation-only default control has an explicit dimension", () => {
    // `none` says nothing about subject matter — falling through to the
    // catch-all would be a guess, so each one is classified on purpose
    for (const c of allControls.filter((x) => x.collector === "none")) {
      expect(CONTROL_DIMENSION_OVERRIDES[c.controlRef], c.controlRef).toBeDefined();
    }
  });

  it("classifies by evidence source", () => {
    expect(dimensionForControl({ controlRef: "x", collector: "guardrail_configs", collectorParams: { detector: "semantic_dlp" } })).toBe("privacy");
    expect(dimensionForControl({ controlRef: "x", collector: "guardrail_configs", collectorParams: { detector: "toxicity" } })).toBe("safety");
    expect(dimensionForControl({ controlRef: "x", collector: "guardrail_configs", collectorParams: { detector: "prompt_injection" } })).toBe("security");
    expect(dimensionForControl({ controlRef: "x", collector: "audit_decisions", collectorParams: { effect: "deny" } })).toBe("security");
    expect(dimensionForControl({ controlRef: "x", collector: "audit_decisions", collectorParams: {} })).toBe("compliance");
    expect(dimensionForControl({ controlRef: "x", collector: "eval_runs" })).toBe("reliability");
    expect(dimensionForControl({ controlRef: "x", collector: "some_future_collector" })).toBe("compliance");
  });

  it("every default control lands on a known dimension, and the default packs reach five of six", () => {
    const seen = new Set(allControls.map((c) => dimensionForControl(c)));
    for (const d of seen) expect(TRUST_DIMENSIONS).toContain(d);
    // RECORDED, not aspirational: no default control evidences BIAS until a
    // pack ships a fairness control (ADR-0148 §Consequences). When one does,
    // this assertion must be updated deliberately — it is the line that keeps
    // the radar from claiming a measured bias axis it does not have.
    expect([...seen].sort()).toEqual(["compliance", "privacy", "reliability", "safety", "security"]);
  });
});
