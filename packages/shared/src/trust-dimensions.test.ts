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

  it("v1 packs reach five of six dimensions; the v2 packs (ADR-0150) add bias", () => {
    // RECORDED, not aspirational: no v1 control evidences BIAS (ADR-0148
    // §Consequences). ADR-0150's v2 packs add fairness controls; this is the
    // line that keeps the radar from claiming a bias axis the active packs
    // do not have.
    const v1 = DEFAULT_COMPLIANCE_PACKS.filter((p) => p.version === 1).flatMap((p) => p.controls);
    const seenV1 = new Set(v1.map((c) => dimensionForControl(c)));
    expect([...seenV1].sort()).toEqual(["compliance", "privacy", "reliability", "safety", "security"]);
    const seenAll = new Set(allControls.map((c) => dimensionForControl(c)));
    for (const d of seenAll) expect(TRUST_DIMENSIONS).toContain(d);
    expect([...seenAll].sort()).toEqual([...TRUST_DIMENSIONS].sort());
  });

  it("the v2 packs are v1 plus additions — no v1 control is dropped or changed", () => {
    for (const fw of ["eu-ai-act", "nist-ai-rmf"]) {
      const v1 = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === fw && p.version === 1)!;
      const v2 = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === fw && p.version === 2)!;
      expect(v2, fw).toBeDefined();
      expect(v2.controls.slice(0, v1.controls.length)).toEqual(v1.controls);
      expect(v2.controls.length).toBeGreaterThan(v1.controls.length);
      expect(new Set(v2.controls.map((c) => c.controlRef)).size).toBe(v2.controls.length);
    }
    // de-duplicated: NIST v3 (ADR-0175) carries MEASURE-2.11 forward from v2
    const bias = [...new Set(allControls.filter((c) => dimensionForControl(c) === "bias").map((c) => c.controlRef))];
    expect(bias.sort()).toEqual(["eu-ai-act:art-10-bias-examination", "nist-ai-rmf:MEASURE-2.11"]);
  });
});
