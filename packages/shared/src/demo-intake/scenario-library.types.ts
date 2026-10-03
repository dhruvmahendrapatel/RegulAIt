/**
 * G2 — types for the agentic risk-scenario library.
 * Consumed by scenario-library.ts (data) and scenario-library.test.ts (assertions).
 * Claude wires the export into packages/shared/src/index.ts on review.
 */
import type { AiRiskCategory, TrustDimension } from "../risks.js";
import { INTAKE_SECTORS } from "../intake-assist.js";

export type IntakeSector = (typeof INTAKE_SECTORS)[number];

export interface ScenarioLibraryEntry {
  /** kebab-slug of the title — stable identifier for X8's picker */
  key: string;
  title: string;
  /** 2–3 sentences: trigger, mechanism, impact. Unique per entry. */
  description: string;
  category: AiRiskCategory;
  /** the trust-dashboard dimension this scenario counts against */
  dimension: TrustDimension;
  /** values from INTAKE_SECTORS */
  domains: IntakeSector[];
  /** 2–4 real controlRef values from DEFAULT_COMPLIANCE_PACKS */
  suggestedControls: string[];
}
