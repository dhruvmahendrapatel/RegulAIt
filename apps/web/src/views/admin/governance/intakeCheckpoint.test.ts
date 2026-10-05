import { describe, expect, it } from "vitest";
import { canonicalDigest, emptyCheckpoint, planSubmission, type RiskInputs, type SubmissionCheckpoint, type SubmissionInputs } from "./intakeCheckpoint";

const useCase = {
  name: "Credit-limit-increase assistant",
  description: "Helps customers request a limit increase.",
  businessContext: "Helps customers request a limit increase.",
  dataSensitivity: "regulated",
  complianceTags: ["eu-ai-act", "nist-ai-rmf"],
  intendedAgentIds: ["agent-1"],
  screeningAnswers: {
    purposeDomain: "essential-services",
    affectedPersons: ["customers"],
    decisionAutonomy: "human-reviews",
    biometricUse: "none",
    emotionRecognition: false,
    socialScoring: false,
    manipulativeTechniques: false,
    profilesNaturalPersons: true,
    safetyComponent: false,
    interactsWithHumans: true,
    generatesSyntheticContent: true,
    sectors: ["financial-services"],
    dataCategories: ["personal", "financial"],
    deployment: "customer-facing",
    euNexus: true,
    usesExternalVendor: false,
    generative: true,
    autonomousActions: false,
    toolsUsed: [],
  },
};
const bias: RiskInputs = { title: "Disparate outcomes", description: "Profiling may differ by group.", category: "bias_fairness", likelihood: "medium", impact: "high", agentId: "agent-1" };
const inputs = (over: Partial<SubmissionInputs> = {}): SubmissionInputs => ({
  useCase,
  questionnaire: "## 1. Purpose\n\nDraft answer 1",
  risks: [{ key: "credit-bias", inputs: bias, controls: ["eu-ai-act:art-14-human-oversight"] }],
  ...over,
});
/** the checkpoint a fully completed first attempt with `inputs()` leaves behind */
const written = (): SubmissionCheckpoint => ({
  useCase: { id: "uc", instanceId: "inst", inputs: useCase, digest: canonicalDigest(useCase) },
  planningAdvanced: true,
  questionnaire: { digest: canonicalDigest(inputs().questionnaire) },
  risks: { "credit-bias": { id: "r1", inputs: bias, digest: canonicalDigest(bias), linkedControls: ["eu-ai-act:art-14-human-oversight"] } },
});

describe("AER-046 canonicalDigest", () => {
  it("ignores key order at every depth and drops undefined members", () => {
    expect(canonicalDigest({ a: 1, b: { y: [1, 2], x: "s" } })).toBe(canonicalDigest({ b: { x: "s", y: [1, 2] }, a: 1 }));
    expect(canonicalDigest({ a: 1, agentId: undefined })).toBe(canonicalDigest({ a: 1 }));
  });

  it("distinguishes every real difference: values, types, array order, added keys", () => {
    const base = canonicalDigest({ a: "1", list: ["x", "y"] });
    expect(canonicalDigest({ a: 1, list: ["x", "y"] })).not.toBe(base);
    expect(canonicalDigest({ a: "1", list: ["y", "x"] })).not.toBe(base);
    expect(canonicalDigest({ a: "1", list: ["x", "y"], b: null })).not.toBe(base);
    expect(canonicalDigest("Draft answer 1")).not.toBe(canonicalDigest("Draft answer 1 "));
  });
});

describe("AER-046 planSubmission — a retry reuses a record only when its inputs are unchanged", () => {
  it("a first attempt creates everything", () => {
    expect(planSubmission(emptyCheckpoint(), inputs())).toEqual({
      kind: "proceed",
      useCase: { action: "create" },
      questionnaire: "submit",
      risks: [{ key: "credit-bias", step: { action: "create" }, controlsToLink: ["eu-ai-act:art-14-human-oversight"] }],
    });
  });

  it("an unchanged retry reuses every written record and sends nothing new", () => {
    expect(planSubmission(written(), inputs())).toEqual({
      kind: "proceed",
      useCase: { action: "reuse" },
      questionnaire: "reuse",
      risks: [{ key: "credit-bias", step: { action: "reuse" }, controlsToLink: [] }],
    });
  });

  it("the accepted frameworks are a set: the same tags reordered are reused, a different set is still refused", () => {
    const reordered = { ...useCase, complianceTags: ["nist-ai-rmf", "eu-ai-act"] };
    const plan = planSubmission(written(), inputs({ useCase: reordered }));
    expect(plan).toMatchObject({ kind: "proceed", useCase: { action: "reuse" } });
    const changed = planSubmission(written(), inputs({ useCase: { ...useCase, complianceTags: ["eu-ai-act"] } }));
    expect(changed).toMatchObject({ kind: "refuse", useCaseId: "uc" });
  });

  it("edited inputs update the written records instead of being skipped (the Codex scenario)", () => {
    // the first attempt failed before the questionnaire was stored, so the use
    // case is still proposed — its own fields are editable
    const beforeReview: SubmissionCheckpoint = { ...written(), questionnaire: undefined };
    const plan = planSubmission(beforeReview, inputs({
      useCase: { ...useCase, description: "Edited.", businessContext: "Edited.", intendedAgentIds: [] },
      questionnaire: "## 1. Purpose\n\nEdited answer",
      risks: [{ key: "credit-bias", inputs: { ...bias, description: "Edited risk text.", agentId: undefined, vendorId: "v" }, controls: ["eu-ai-act:art-14-human-oversight"] }],
    }));
    expect(plan).toEqual({
      kind: "proceed",
      useCase: { action: "update", patch: { description: "Edited.", businessContext: "Edited.", intendedAgentIds: [] } },
      questionnaire: "submit",
      // a cleared agent goes as null, which is how PATCH unlinks it
      risks: [{ key: "credit-bias", step: { action: "update", patch: { description: "Edited risk text.", agentId: null, vendorId: "v" } }, controlsToLink: [] }],
    });
  });

  it("once the questionnaire is stored the use case is under review: its own fields are locked, answers and risks still update", () => {
    for (const change of [{ description: "Edited." }, { businessContext: "Edited." }, { intendedAgentIds: [] }]) {
      const plan = planSubmission(written(), inputs({ useCase: { ...useCase, ...change } }));
      expect(plan.kind, JSON.stringify(change)).toBe("refuse");
      if (plan.kind === "refuse") expect(plan.reasons.join(" ")).toMatch(/can't be edited while it is under review/);
    }
    const plan = planSubmission(written(), inputs({
      questionnaire: "## 1. Purpose\n\nEdited answer",
      risks: [{ key: "credit-bias", inputs: { ...bias, description: "Edited risk text." }, controls: ["eu-ai-act:art-14-human-oversight"] }],
    }));
    expect(plan).toEqual({
      kind: "proceed",
      useCase: { action: "reuse" },
      questionnaire: "resubmit",
      risks: [{ key: "credit-bias", step: { action: "update", patch: { description: "Edited risk text." } }, controlsToLink: [] }],
    });
  });

  it("a newly accepted scenario is created next to the reused ones, with only its own controls", () => {
    const injection: RiskInputs = { title: "Prompt injection", description: "Steering.", category: "prompt_injection", likelihood: "medium", impact: "medium" };
    const plan = planSubmission(written(), inputs({ risks: [...inputs().risks, { key: "injection", inputs: injection, controls: ["c-2"] }] }));
    expect(plan.kind === "proceed" && plan.risks).toEqual([
      { key: "credit-bias", step: { action: "reuse" }, controlsToLink: [] },
      { key: "injection", step: { action: "create" }, controlsToLink: ["c-2"] },
    ]);
  });

  it("refuses — before any request — a change the gateway has no edit for", () => {
    for (const [change, expected] of [
      [{ useCase: { ...useCase, name: "Renamed assistant" } }, /use-case name/],
      [{ useCase: { ...useCase, dataSensitivity: "confidential" } }, /data sensitivity/],
      [{ useCase: { ...useCase, complianceTags: ["eu-ai-act"] } }, /accepted frameworks/],
      // stored at registration; PATCH takes them only after a send-back
      [{ useCase: { ...useCase, screeningAnswers: { ...useCase.screeningAnswers, decisionAutonomy: "fully-automated" } } }, /classification answers/],
      [{ useCase: { ...useCase, screeningAnswers: { ...useCase.screeningAnswers, sectors: ["payments"] } } }, /classification answers/],
      [{ risks: [{ key: "credit-bias", inputs: { ...bias, category: "data_leakage_pii" }, controls: ["eu-ai-act:art-14-human-oversight"] }] }, /changed category/],
      [{ risks: [] }, /no longer accepted/],
      [{ risks: [{ key: "credit-bias", inputs: bias, controls: [] }] }, /no longer names/],
    ] as const) {
      const plan = planSubmission(written(), inputs(change as Partial<SubmissionInputs>));
      expect(plan.kind, JSON.stringify(change)).toBe("refuse");
      if (plan.kind === "refuse") {
        expect(plan.useCaseId).toBe("uc");
        expect(plan.reasons.join(" ")).toMatch(expected);
      }
    }
  });

  it("a refusal is not decided by the step order: a fixed-field change refuses even when later steps could be updated", () => {
    const plan = planSubmission(written(), inputs({
      useCase: { ...useCase, name: "Renamed", description: "Edited." },
      questionnaire: "changed",
    }));
    expect(plan.kind).toBe("refuse");
  });
});
