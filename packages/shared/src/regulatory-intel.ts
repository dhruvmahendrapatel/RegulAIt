/**
 * ADR-0158 — REGULATORY INTELLIGENCE: a curated feed of regulatory updates,
 * joined to THIS organisation's state.
 *
 * The feed itself is data (demo task G4, `demo-intake/regulatory-updates.ts`):
 * every entry carries a primary `sourceUrl` and the date someone verified it.
 * The platform does not monitor regulators and does not interpret law — it
 * answers the question a compliance lead asks of each entry: "which of OUR
 * controls does this touch, are they evidenced, and which of our use cases are
 * in scope?" That join is the product; the feed is an input.
 *
 * Pure: the gateway passes in active packs, per-control evaluation status and
 * use cases; nothing here reads a database or a clock.
 */
import type { ControlEvaluationStatus } from "./compliance-packs.js";
import type { EuAiActTier } from "./eu-ai-act.js";

export const REGULATORY_UPDATE_STATUSES = ["in_force", "upcoming", "proposed"] as const;
export type RegulatoryUpdateStatus = (typeof REGULATORY_UPDATE_STATUSES)[number];

/** The shape G4 authors. Everything except `scope` is required. */
export interface RegulatoryUpdate {
  key: string;
  /** e.g. "EU", "US-CO", "US-NYC", "International" */
  jurisdiction: string;
  /** e.g. "EU AI Act (Regulation (EU) 2024/1689)" */
  instrument: string;
  title: string;
  summary: string;
  /** YYYY-MM-DD */
  effectiveDate: string;
  status: RegulatoryUpdateStatus;
  /** pack framework ids, e.g. "eu-ai-act", "nist-ai-rmf", "iso-42001" */
  frameworks: string[];
  /** real controlRefs from DEFAULT_COMPLIANCE_PACKS */
  controlRefs: string[];
  /** a primary or official source for every date and claim above */
  sourceUrl: string;
  /** YYYY-MM-DD the entry was checked against sourceUrl */
  verifiedOn: string;
  /**
   * Optional narrowing of which use cases are in scope. Omitted = every live
   * use case (the packs are org-level). `euAiActTiers` narrows by computed tier.
   */
  scope?: { euAiActTiers?: EuAiActTier[] };
}

export interface RegulatoryControlState {
  controlRef: string;
  title: string | null;
  /** the active pack that defines it, when one does */
  framework: string | null;
  status: ControlEvaluationStatus | "not_in_active_pack";
}

export interface RegulatoryUseCaseInput {
  id: string;
  name: string;
  status: string;
  euAiActTier: EuAiActTier | null;
}

export interface RegulatoryImpact {
  key: string;
  jurisdiction: string;
  instrument: string;
  title: string;
  summary: string;
  effectiveDate: string;
  status: RegulatoryUpdateStatus;
  /** negative = already in force for that many days */
  daysUntilEffective: number;
  sourceUrl: string;
  verifiedOn: string;
  frameworks: Array<{ framework: string; packActive: boolean; activeVersion: number | null }>;
  controls: RegulatoryControlState[];
  impact: {
    scopeBasis: "all_live_use_cases" | "eu_ai_act_tier";
    useCases: Array<{ id: string; name: string; status: string; euAiActTier: EuAiActTier | null }>;
    controlsMapped: number;
    /** satisfied or attested */
    controlsEvidenced: number;
    /** mapped controls that are unsatisfied, unaddressed, attestation-required, or in no active pack */
    controlGaps: number;
    /** a framework the update names that has no active pack here */
    frameworkGaps: number;
  };
}

/** live = could be affected: everything except rejected and retired */
const LIVE_USE_CASE = new Set(["proposed", "under_review", "approved"]);
const EVIDENCED = new Set<string>(["satisfied", "attested"]);

export function computeRegulatoryImpact(
  updates: readonly RegulatoryUpdate[],
  ctx: {
    activePacks: ReadonlyMap<string, number>;
    controls: ReadonlyMap<string, { title: string; framework: string; status: ControlEvaluationStatus }>;
    useCases: readonly RegulatoryUseCaseInput[];
    /** YYYY-MM-DD, the caller's today (UTC) */
    today: string;
  },
): RegulatoryImpact[] {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  return updates
    .map((u) => {
      const controls: RegulatoryControlState[] = u.controlRefs.map((ref) => {
        const c = ctx.controls.get(ref);
        return c
          ? { controlRef: ref, title: c.title, framework: c.framework, status: c.status }
          : { controlRef: ref, title: null, framework: null, status: "not_in_active_pack" as const };
      });
      const tiers = u.scope?.euAiActTiers;
      const useCases = ctx.useCases
        .filter((uc) => LIVE_USE_CASE.has(uc.status))
        .filter((uc) => !tiers || (uc.euAiActTier !== null && tiers.includes(uc.euAiActTier)))
        .map((uc) => ({ id: uc.id, name: uc.name, status: uc.status, euAiActTier: uc.euAiActTier }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const frameworks = u.frameworks.map((f) => ({
        framework: f,
        packActive: ctx.activePacks.has(f),
        activeVersion: ctx.activePacks.get(f) ?? null,
      }));
      const evidenced = controls.filter((c) => EVIDENCED.has(c.status)).length;
      return {
        key: u.key,
        jurisdiction: u.jurisdiction,
        instrument: u.instrument,
        title: u.title,
        summary: u.summary,
        effectiveDate: u.effectiveDate,
        status: u.status,
        daysUntilEffective: Math.round(day(u.effectiveDate) - day(ctx.today)),
        sourceUrl: u.sourceUrl,
        verifiedOn: u.verifiedOn,
        frameworks,
        controls,
        impact: {
          scopeBasis: tiers ? ("eu_ai_act_tier" as const) : ("all_live_use_cases" as const),
          useCases,
          controlsMapped: controls.length,
          controlsEvidenced: evidenced,
          controlGaps: controls.length - evidenced,
          frameworkGaps: frameworks.filter((f) => !f.packActive).length,
        },
      };
    })
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.key.localeCompare(b.key));
}

export const REGULATORY_INTEL_NOTES = {
  source:
    "Each entry is curated from the primary source linked on it and dated by when it was checked. The platform " +
    "does not monitor regulators or interpret law; verify the source before acting.",
  evidence:
    "Control status is this organisation's pack evaluation over the posture window: satisfied or attested counts " +
    "as evidenced; anything else, or a control in no active pack, is a gap.",
  scope:
    "Use cases in scope are live ones (proposed, under review, approved); an entry may narrow by computed EU AI " +
    "Act tier. Scope is a prompt for review, not a legal determination.",
} as const;
