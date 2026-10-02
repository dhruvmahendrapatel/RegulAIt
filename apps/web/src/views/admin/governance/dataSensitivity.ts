/**
 * AER-042 — the use case's `dataSensitivity`, derived from the data categories
 * the proposer declared in the intake wizard. Mirrors
 * `AI_USE_CASE_DATA_SENSITIVITIES` in @regulait/shared (the SPA mirrors shared
 * enums rather than importing the package); the gateway parses the field with
 * that exact enum, so drift fails loudly with a 400.
 *
 * FAIL CLOSED: no categories, or any category this list does not know, yields
 * the strictest level — an unclassified answer must never lower the bar.
 */
export const DATA_SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;
export type DataSensitivity = (typeof DATA_SENSITIVITIES)[number];

const LEVEL_FOR_CATEGORY: Record<string, DataSensitivity> = {
  health: "regulated",
  "sensitive-personal": "regulated",
  "payment-card": "regulated",
  financial: "regulated",
  personal: "confidential",
  proprietary: "confidential",
  public: "public",
};

export function deriveDataSensitivity(categories: readonly string[]): DataSensitivity {
  if (categories.length === 0) return "regulated";
  let worst = 0;
  for (const category of categories) {
    const level = LEVEL_FOR_CATEGORY[category];
    if (!level) return "regulated";
    worst = Math.max(worst, DATA_SENSITIVITIES.indexOf(level));
  }
  return DATA_SENSITIVITIES[worst]!;
}
