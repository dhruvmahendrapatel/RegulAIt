/**
 * Demo task G1/C6 — THE CONTRACT between the demo fixtures (Gemini owns the
 * data in `./demo-intake/`) and the demo seeder (Claude owns
 * `apps/gateway/src/demo-intake-seed.ts`).
 *
 * The seeder loads these through the REAL APIs — never raw inserts — so every
 * seeded object passes the same validation, separation-of-duties and audit
 * path a user's would. Consequences for the data:
 *  - every enum value must be one the API accepts (types below enforce it);
 *  - every `controlRef` must exist in `DEFAULT_COMPLIANCE_PACKS`;
 *  - `key` fields are fixture-local identifiers used for cross-references
 *    (`useCaseKey`, `vendorKey`); they never reach the database;
 *  - no real person's name, email or PII; synthetic identifiers only.
 */
import type { AiRiskCategory, AiRiskLevel } from "./risks.js";
import type { IntakeAssistRequest } from "./intake-assist.js";
import type { BiasFairnessEntryInput } from "./mrm.js";
import type { AI_VENDOR_CATEGORIES } from "./vendors.js";

/** mirrors AI_USE_CASE_DATA_SENSITIVITIES (index.ts) — asserted equal by test */
export const DEMO_DATA_SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;

export type DemoUseCaseTarget = "proposed" | "under_review" | "approved" | "rejected" | "retired";
export type DemoVendorTarget = "proposed" | "under_assessment" | "approved" | "rejected";
export type DemoRiskTarget = "open" | "mitigating" | "accepted" | "closed";

export interface DemoVendor {
  key: string;
  name: string;
  description: string;
  category: (typeof AI_VENDOR_CATEGORIES)[number];
  /** agent provider tokens this vendor corresponds to (e.g. "anthropic", "openai", "mock") */
  linkedAgentProviders: string[];
  targetStatus: DemoVendorTarget;
}

export interface DemoUseCase {
  key: string;
  name: string;
  description: string;
  businessContext: string;
  dataSensitivity: (typeof DEMO_DATA_SENSITIVITIES)[number];
  complianceTags: string[];
  targetStatus: DemoUseCaseTarget;
  /**
   * The structured intake answers. The seeder runs them through the intake
   * assistant and submits the resulting questionnaire, so the EU AI Act tier
   * is COMPUTED by the platform, never stated here. Choose answers that
   * produce the tier you want (see `packages/shared/src/eu-ai-act.ts`).
   */
  intake: IntakeAssistRequest;
  /** names of agents created by the existing seed (`apps/gateway/src/seed.ts`) */
  intendedAgentNames: string[];
  /** required for `rejected` / `retired`: the decision or retirement reason */
  decisionReason?: string;
}

export interface DemoRisk {
  key: string;
  useCaseKey: string;
  vendorKey?: string;
  title: string;
  description: string;
  category: AiRiskCategory;
  likelihood: AiRiskLevel;
  impact: AiRiskLevel;
  mitigation?: string;
  targetStatus: DemoRiskTarget;
  /** declared residual position — give it for mitigated risks */
  residual?: { likelihood: AiRiskLevel; impact: AiRiskLevel };
  /** real `controlRef`s from DEFAULT_COMPLIANCE_PACKS */
  controls: string[];
  /** required when targetStatus is `accepted` */
  acceptanceNote?: string;
  /** required when targetStatus is `closed` */
  closeReason?: string;
}

export interface DemoModelCard {
  /** an agent created by the existing seed */
  agentName: string;
  intendedUse: string;
  dataClaims: Record<string, unknown>;
  limitations: string;
  biasFairness: BiasFairnessEntryInput[];
  standardRefs: string[];
}

export interface DemoShadowFinding {
  /** imported as `saas_export` evidence rows */
  appName: string;
  vendorHost: string;
  grantedBy: string;
  installCount: number;
}

export interface DemoIntakeFixtures {
  company: { name: string; description: string };
  /** the use case the live demo walks through — NOT pre-seeded; its intake is
   * typed live in the wizard. Kept here so the script and the e2e test share it. */
  hero: DemoUseCase;
  vendors: DemoVendor[];
  useCases: DemoUseCase[];
  risks: DemoRisk[];
  modelCards: DemoModelCard[];
  shadowAi: DemoShadowFinding[];
}
