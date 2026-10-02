/**
 * G4 — types for the regulatory intelligence feed.
 * Claude wires the export into packages/shared/src/index.ts on review.
 */

export interface RegulatoryUpdate {
  /** kebab-slug, stable identifier for the feed renderer */
  key: string;
  /** geographic scope (EU, US-CO, US-NYC, US, International, etc.) */
  jurisdiction: string;
  /** the regulation or standard name */
  instrument: string;
  /** short human-readable label */
  title: string;
  /** 2–3 sentence plain-English description */
  summary: string;
  /** YYYY-MM-DD date this provision entered or is expected to enter force */
  effectiveDate: string;
  status: "in_force" | "upcoming" | "proposed";
  /** pack framework ids this entry is relevant to */
  frameworks: string[];
  /** real controlRef values from DEFAULT_COMPLIANCE_PACKS */
  controlRefs: string[];
  /** primary or official source URL (must be HTTPS) */
  sourceUrl: string;
  /** YYYY-MM-DD date this entry was last verified against its sourceUrl */
  verifiedOn: string;
}
