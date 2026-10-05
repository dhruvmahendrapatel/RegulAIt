import { describe, expect, it } from "vitest";
import {
  applyProposal,
  classificationFingerprint,
  contextAnswers,
  detailRationales,
  detailUnsure,
  diffIsEmpty,
  diffProposals,
  emptyForm,
  euAiActAnswers,
  euUnsureKeys,
  exampleForm,
  initialProposalState,
  missingAnswers,
  newIdempotencyKey,
  outcomeUnknown,
  readRegistrationDraft,
  unsureKeys,
  withUnsure,
  type IntakeAssistResponse,
  type ProposalState,
} from "./registrationModel";
import { canonicalDigest, planSubmission, type SubmissionCheckpoint } from "./intakeCheckpoint";

const proposal = (over: Partial<IntakeAssistResponse> = {}): IntakeAssistResponse => ({
  tier: { value: "high", reasons: [], rulesetVersion: 1, source: "rules", disclaimer: "Screening only." },
  frameworks: [
    { framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus", source: "rules" },
    { framework: "nist-ai-rmf", title: "NIST AI RMF", why: "agentic workflow", source: "rules" },
  ],
  risks: [{ scenarioKey: "bias", title: "Bias", description: "Outcomes differ.", category: "bias_fairness", dimension: "bias", likelihood: "medium", impact: "high", suggestedControls: [], why: "profiling", source: "rules" }],
  euAiActBlock: "```eu-ai-act-answers\n{\n  \"purposeDomain\": \"essential-services\",\n  \"socialScoring\": true\n}\n```",
  questionnaire: [
    { id: "q1", heading: "1. Purpose", text: "Draft 1", source: "rules" },
    { id: "q2", heading: "2. People", text: "Draft 2", source: "rules" },
  ],
  blocking: null,
  narrative: { status: "drafted" },
  disclaimer: "Suggestions only.",
  ...over,
});

/** the proposer has worked on it: rejected NIST, edited the EU explanation and the bias text, edited section 1 */
const worked = (): ProposalState => ({
  decisions: { "framework:eu-ai-act": "accepted", "framework:nist-ai-rmf": "rejected", "risk:bias": "accepted", "question:q1": "accepted", "question:q2": "rejected" },
  suggestionEdits: { "framework:eu-ai-act": "Our customers are in the EU.", "risk:bias": "My bias text.", "framework:nist-ai-rmf": "Edited, then rejected." },
  questionnaire: { q1: "My purpose.", q2: "Draft 2" },
});

describe("ADR-0171 registration model", () => {
  it("AER-051: the fingerprint ignores the Describe text and treats Not sure as the yes it counts as", () => {
    const a = exampleForm();
    expect(classificationFingerprint({ ...a, title: "Renamed", description: "Reworded" })).toBe(classificationFingerprint(a));
    expect(classificationFingerprint({ ...a, answers: { ...a.answers, profilesNaturalPersons: "unsure" } })).toBe(classificationFingerprint(a));
    expect(classificationFingerprint({ ...a, answers: { ...a.answers, emotionRecognition: "yes" } })).not.toBe(classificationFingerprint(a));
    expect(classificationFingerprint({ ...a, sectors: ["healthcare"] })).not.toBe(classificationFingerprint(a));
  });

  it("AER-053: Not sure is sent as yes everywhere, and listed (the EU block only carries EU keys)", () => {
    const form = exampleForm();
    form.answers.socialScoring = "unsure";
    form.answers.euNexus = "unsure";
    expect(euAiActAnswers(form).socialScoring).toBe(true);
    expect(contextAnswers(form).euNexus).toBe(true);
    expect(unsureKeys(form)).toEqual(["euNexus", "socialScoring"]);
    expect(euUnsureKeys(form)).toEqual(["socialScoring"]);
    const block = withUnsure(proposal().euAiActBlock, euUnsureKeys(form));
    expect(JSON.parse(/```eu-ai-act-answers\n([\s\S]*?)```/.exec(block)![1]!)).toEqual({ purposeDomain: "essential-services", socialScoring: true, unsure: ["socialScoring"] });
    // with nothing unsure the drafted block goes out byte for byte
    expect(withUnsure(proposal().euAiActBlock, [])).toBe(proposal().euAiActBlock);
  });

  it("AER-053: every unanswered question is named with its group, in page order", () => {
    const form = exampleForm();
    form.affectedPerson = "";
    form.sectors = [];
    form.answers.socialScoring = "";
    expect(missingAnswers(form)).toEqual([
      { key: "affectedPerson", label: "People affected", group: "Purpose and people" },
      { key: "sectors", label: "Sectors", group: "Data and sector" },
      { key: "socialScoring", label: "Social scoring", group: "What it does in practice" },
    ]);
    expect(missingAnswers(exampleForm())).toEqual([]);
    expect(missingAnswers(emptyForm())).toHaveLength(17);
    // Not sure is an answer
    expect(missingAnswers({ ...form, affectedPerson: "customers", sectors: ["general"], answers: { ...form.answers, socialScoring: "unsure" } })).toEqual([]);
  });

  it("AER-051: Keep my edits replaces and removes nothing the proposer decided or wrote; new suggestions arrive undecided", () => {
    const before = proposal();
    const after = proposal({
      frameworks: [before.frameworks[0]!],
      risks: [...before.risks, { ...before.risks[0]!, scenarioKey: "emotion", title: "Emotion" }],
      questionnaire: [{ ...before.questionnaire[0]!, text: "New draft 1" }, before.questionnaire[1]!, { id: "q3", heading: "3. New", text: "Draft 3", source: "rules" }],
    });
    const { proposal: next, state } = applyProposal("keep", before, after, worked());
    expect(next.frameworks.map((f) => [f.framework, Boolean(f.kept)])).toEqual([["eu-ai-act", false], ["nist-ai-rmf", true]]);
    expect(state.decisions["framework:nist-ai-rmf"]).toBe("rejected");
    expect(state.suggestionEdits).toEqual(worked().suggestionEdits);
    expect(state.decisions["risk:emotion"]).toBeUndefined();
    expect(state.questionnaire).toEqual({ q1: "My purpose.", q2: "Draft 2", q3: "Draft 3" });
    expect(state.decisions["question:q2"]).toBe("rejected");
    expect(state.decisions["question:q3"]).toBe("accepted");
  });

  it("AER-051: Regenerate replaces only the affected sections and drops stale suggestions with their decisions and edits", () => {
    const before = proposal();
    const after = proposal({
      frameworks: [before.frameworks[0]!],
      questionnaire: [{ ...before.questionnaire[0]!, text: "New draft 1" }, before.questionnaire[1]!],
    });
    const { proposal: next, state } = applyProposal("regenerate", before, after, worked());
    expect(next.frameworks.map((f) => f.framework)).toEqual(["eu-ai-act"]);
    expect(state.decisions["framework:nist-ai-rmf"]).toBeUndefined();
    expect(state.suggestionEdits).toEqual({ "framework:eu-ai-act": "Our customers are in the EU.", "risk:bias": "My bias text." });
    // section 1's draft changed: regenerated on consent; section 2 untouched, still rejected
    expect(state.questionnaire).toEqual({ q1: "New draft 1", q2: "Draft 2" });
    expect(state.decisions["question:q2"]).toBe("rejected");
  });

  it("AER-051: the diff names what changes, flags edited sections and the decided suggestions a regenerate removes", () => {
    const before = proposal();
    const after = proposal({ tier: { ...before.tier, value: "limited" }, frameworks: [before.frameworks[0]!], questionnaire: [{ ...before.questionnaire[0]!, text: "New draft 1" }, before.questionnaire[1]!] });
    const diff = diffProposals(before, after, worked());
    expect(diff.tier).toEqual({ from: "high", to: "limited" });
    expect(diff.frameworks.removed.map((f) => f.title)).toEqual(["NIST AI RMF"]);
    expect(diff.questionnaire.changed.map(({ item, edited }) => [item.id, edited])).toEqual([["q1", true]]);
    expect(diff.touchedRemovals).toEqual(["NIST AI RMF"]);
    expect(diffIsEmpty(diff)).toBe(false);
    expect(diffIsEmpty(diffProposals(before, proposal(), initialProposalState(before)))).toBe(true);
  });

  it("AER-050: a saved draft reads back; anything else is refused", () => {
    expect(readRegistrationDraft(null)).toBeNull();
    expect(readRegistrationDraft({ kind: "resubmission", version: 1, step: 0, form: {} })).toBeNull();
    const back = readRegistrationDraft({ kind: "registration", version: 1, step: 3, form: { title: "Old idea", answers: { euNexus: "unsure" } } })!;
    expect(back.form.title).toBe("Old idea");
    expect(back.form.answers.euNexus).toBe("unsure");
    expect(back.form.answers.socialScoring).toBe("");
    expect(back.checkpoint).toEqual({ risks: {} });
    expect(back.attempt).toBeNull();
  });

  it("AER-050: a create's outcome is unknown after a dropped connection or a server error, never after a refusal", () => {
    expect(outcomeUnknown(new Error("network"))).toBe(true);
    expect(outcomeUnknown({ status: 502 })).toBe(true);
    expect(outcomeUnknown({ status: 408 })).toBe(true);
    expect(outcomeUnknown({ status: 422 })).toBe(false);
    expect(outcomeUnknown({ status: 409 })).toBe(false);
    // ADR-0179: a key whose first request has not finished may still create — keep it
    expect(outcomeUnknown({ status: 409, payload: { error: "idempotency_key_in_flight" } })).toBe(true);
    expect(outcomeUnknown({ status: 422, payload: { error: "idempotency_key_reused" } })).toBe(false);
    const key = newIdempotencyKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it("AER-052: an edited framework explanation is a use-case edit while the intake is in flight, and refused once it is with reviewers", () => {
    const useCase = { name: "n", description: "d", businessContext: "d", dataSensitivity: "regulated", complianceTags: ["eu-ai-act"], intendedAgentIds: [] };
    const edited = { ...useCase, frameworkRationales: { "eu-ai-act": "Our customers are in the EU." } };
    const written: SubmissionCheckpoint = { useCase: { id: "uc", instanceId: "i", inputs: useCase, digest: canonicalDigest(useCase) }, risks: {} };
    const plan = planSubmission(written, { useCase: edited, questionnaire: "q", risks: [] });
    expect(plan).toMatchObject({ kind: "proceed", useCase: { action: "update", patch: { frameworkRationales: { "eu-ai-act": "Our customers are in the EU." } } } });
    const cleared = planSubmission({ ...written, useCase: { ...written.useCase!, inputs: edited, digest: canonicalDigest(edited) } }, { useCase, questionnaire: "q", risks: [] });
    expect(cleared).toMatchObject({ kind: "proceed", useCase: { action: "update", patch: { frameworkRationales: {} } } });
    const locked = planSubmission({ ...written, questionnaire: { digest: canonicalDigest("q") } }, { useCase: edited, questionnaire: "q", risks: [] });
    expect(locked).toMatchObject({ kind: "refuse" });
  });

  it("the record and the review task read the owner's explanations and unsure answers wherever the detail carries them", () => {
    expect(detailRationales({ frameworkRationales: { "eu-ai-act": "Why.", blank: " " } })).toEqual({ "eu-ai-act": "Why." });
    expect(detailRationales({ useCase: { frameworkRationales: { x: "y" } } })).toEqual({ x: "y" });
    expect(detailRationales(undefined)).toEqual({});
    expect(detailUnsure({ screeningUnsure: ["generatesSyntheticContent", "generative", "euNexus"] })).toEqual(["generatesSyntheticContent", "euNexus"]);
    expect(detailUnsure({ resubmission: { screeningAnswers: { unsure: ["socialScoring"] } } })).toEqual(["socialScoring"]);
    expect(detailUnsure({ screeningUnsure: "nope" })).toEqual([]);
  });
});
