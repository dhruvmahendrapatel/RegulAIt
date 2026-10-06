/**
 * ADR-0182 (ADR-0175 batch D4) A11 — THE SHIPPED GOLDEN CASES. OWNER: A11 (D4).
 *
 * Each case is a complete set of registration Classify answers (the flat
 * `intakeScreeningAnswersSchema` shape a use case stores as `intakeAnswers`),
 * chosen so that together they reach every EU AI Act screening tier, the
 * unscreened route (answers the server would refuse), the Art. 6(3)
 * narrow-procedural derogation, and the ADR-0171 "Not sure" answers (counted
 * as yes, and refused when stored beside a no). The outcome each one must
 * produce under the code defaults is in `golden-expected.ts`; the CI test
 * (`decision-regression.test.ts`) runs this set and fails on any difference.
 *
 * Adding a case: add it here, run the CI test, and copy the outcome it prints
 * into `golden-expected.ts` after checking it is the outcome you intend.
 *
 * Synthetic content only: no real organisation, person or product.
 */

/** one shipped case: a stable id, a label a reviewer can read, the answers */
export interface GoldenCase {
  id: string;
  label: string;
  answers: Record<string, unknown>;
}

/** nothing fires from here: an internal productivity tool on proprietary data */
const BASE: Readonly<Record<string, unknown>> = Object.freeze({
  purposeDomain: "internal-productivity",
  affectedPersons: ["employees"],
  decisionAutonomy: "informs-human",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: false,
  safetyComponent: false,
  interactsWithHumans: false,
  generatesSyntheticContent: false,
  sectors: ["general"],
  dataCategories: ["proprietary"],
  deployment: "internal",
  euNexus: false,
  usesExternalVendor: false,
  generative: false,
  autonomousActions: false,
  toolsUsed: [],
});

const answers = (over: Record<string, unknown>): Record<string, unknown> => ({ ...BASE, ...over });

/** without the field: the answers the server refuses (no screening) */
const without = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const out = answers(over);
  delete out[key];
  return out;
};

export const SHIPPED_GOLDEN_CASES: readonly GoldenCase[] = Object.freeze([
  // ---- minimal -------------------------------------------------------------
  {
    id: "minimal-internal-search",
    label: "Minimal: internal document search over proprietary data",
    answers: answers({}),
  },
  {
    id: "minimal-eu-vendor-summariser",
    label: "Minimal: internal summariser on a third-party model, EU staff",
    answers: answers({ euNexus: true, usesExternalVendor: true, generative: true }),
  },
  {
    id: "minimal-hr-narrow-procedural",
    label: "Minimal: HR scheduling, a narrow procedural task without profiling (Art. 6(3))",
    answers: answers({ purposeDomain: "employment-hr", decisionAutonomy: "narrow-procedural", dataCategories: ["personal"] }),
  },
  // ---- limited -------------------------------------------------------------
  {
    id: "limited-customer-chatbot",
    label: "Limited: customer support chat assistant (Art. 50(1))",
    answers: answers({
      purposeDomain: "general-business",
      affectedPersons: ["customers"],
      interactsWithHumans: true,
      generative: true,
      deployment: "customer-facing",
      dataCategories: ["personal"],
      euNexus: true,
    }),
  },
  {
    id: "limited-public-synthetic-content",
    label: "Limited: public marketing image generator (Art. 50(2))",
    answers: answers({
      purposeDomain: "general-business",
      affectedPersons: ["general-public"],
      generatesSyntheticContent: true,
      generative: true,
      deployment: "public",
      dataCategories: ["public"],
      euNexus: true,
      usesExternalVendor: true,
    }),
  },
  // ---- high ----------------------------------------------------------------
  {
    id: "high-credit-scoring",
    label: "High: consumer credit scoring with profiling (Annex III essential services)",
    answers: answers({
      purposeDomain: "essential-services",
      affectedPersons: ["customers"],
      decisionAutonomy: "human-reviews",
      profilesNaturalPersons: true,
      sectors: ["financial-services"],
      dataCategories: ["personal", "financial"],
      deployment: "customer-facing",
      euNexus: true,
    }),
  },
  {
    id: "high-hiring-screen",
    label: "High: CV screening that ranks applicants (Annex III employment)",
    answers: answers({
      purposeDomain: "employment-hr",
      affectedPersons: ["general-public"],
      decisionAutonomy: "informs-human",
      profilesNaturalPersons: true,
      dataCategories: ["personal", "sensitive-personal"],
      euNexus: true,
      usesExternalVendor: true,
      generative: true,
    }),
  },
  {
    id: "high-medical-device-component",
    label: "High: triage component of a medical device (Art. 6(1)), health data",
    answers: answers({
      purposeDomain: "general-business",
      affectedPersons: ["customers", "vulnerable-groups"],
      safetyComponent: true,
      sectors: ["healthcare"],
      dataCategories: ["health"],
      deployment: "customer-facing",
      euNexus: true,
    }),
  },
  {
    id: "high-grid-operations-agent",
    label: "High: autonomous grid-balancing agent acting through tools (critical infrastructure)",
    answers: answers({
      purposeDomain: "critical-infrastructure",
      affectedPersons: ["general-public"],
      decisionAutonomy: "fully-automated",
      sectors: ["public-sector"],
      dataCategories: ["proprietary"],
      euNexus: true,
      autonomousActions: true,
      toolsUsed: ["scada-read", "dispatch-setpoint", "ticketing"],
    }),
  },
  {
    id: "high-card-fraud-review",
    label: "High: card-fraud holds with profiling, payments sector",
    answers: answers({
      purposeDomain: "essential-services",
      affectedPersons: ["customers"],
      decisionAutonomy: "fully-automated",
      profilesNaturalPersons: true,
      sectors: ["payments"],
      dataCategories: ["payment-card", "personal"],
      deployment: "customer-facing",
      euNexus: false,
    }),
  },
  // ---- prohibited ----------------------------------------------------------
  {
    id: "prohibited-social-scoring",
    label: "Prohibited: social scoring of residents (Art. 5(1)(c))",
    answers: answers({
      purposeDomain: "general-business",
      affectedPersons: ["general-public"],
      socialScoring: true,
      profilesNaturalPersons: true,
      dataCategories: ["personal"],
      deployment: "public",
      euNexus: true,
    }),
  },
  {
    id: "prohibited-workplace-emotion",
    label: "Prohibited: emotion recognition of employees at work (Art. 5(1)(f))",
    answers: answers({
      purposeDomain: "employment-hr",
      emotionRecognition: true,
      dataCategories: ["sensitive-personal"],
      euNexus: true,
    }),
  },
  // ---- "Not sure" (ADR-0171) -------------------------------------------------
  {
    id: "not-sure-profiling-counted-as-yes",
    label: "Not sure: profiling unknown on a benefits pre-check, counted as yes (high)",
    answers: answers({
      purposeDomain: "essential-services",
      affectedPersons: ["general-public"],
      decisionAutonomy: "narrow-procedural",
      profilesNaturalPersons: true,
      dataCategories: ["personal"],
      deployment: "public",
      euNexus: true,
      unsure: ["profilesNaturalPersons"],
    }),
  },
  {
    id: "not-sure-interaction-counted-as-yes",
    label: "Not sure: whether people talk to it directly, counted as yes (limited)",
    answers: answers({
      interactsWithHumans: true,
      generative: true,
      usesExternalVendor: true,
      unsure: ["interactsWithHumans", "usesExternalVendor"],
    }),
  },
  {
    id: "not-sure-stored-beside-no",
    label: "Not sure stored beside a no: refused, so the use case is unscreened",
    answers: answers({ safetyComponent: false, unsure: ["safetyComponent"] }),
  },
  // ---- unscreened ------------------------------------------------------------
  {
    id: "unscreened-missing-answer",
    label: "Unscreened: the decision-autonomy answer is missing",
    answers: without("decisionAutonomy"),
  },
  // ---- sector frameworks ------------------------------------------------------
  {
    id: "limited-broker-dealer-assistant",
    label: "Limited: broker-dealer research assistant talking to clients (securities sector)",
    answers: answers({
      purposeDomain: "general-business",
      affectedPersons: ["customers"],
      interactsWithHumans: true,
      generative: true,
      sectors: ["securities-broker-dealer"],
      dataCategories: ["financial"],
      deployment: "customer-facing",
      usesExternalVendor: true,
    }),
  },
]);
