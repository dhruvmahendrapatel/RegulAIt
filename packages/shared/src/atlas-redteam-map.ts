/**
 * ADR-0293 — WHICH MITRE ATLAS TECHNIQUES EACH RED-TEAM ATTACK CLASS EXERCISES.
 *
 * The ATLAS tactics and techniques are vendored as the `mitre-atlas-techniques`
 * import source (framework-imports-data/mitre-atlas-techniques.json, ATLAS
 * release 2026.10, Apache-2.0). This table is OURS: a statement of which ATLAS
 * technique a passing run of one of our red-team attack classes is evidence
 * against, authored by reading the technique descriptions. Like every pack
 * mapping it is a starting point, not a claim that a technique is defended.
 *
 * Rules the test holds the table to:
 *  - every id is a technique (or sub-technique) of the vendored release, never a
 *    tactic, so a typo or a renumbered upstream id fails CI;
 *  - an attack class with no honest ATLAS counterpart maps to nothing and says
 *    why below, rather than borrowing a near-miss.
 *
 * `bias` maps to nothing: our bias class tests demographic disparity in model
 * output, and ATLAS has no technique for it (AML.T0130 "AI Agent Response
 * Biasing" is an adversary steering an assistant toward chosen sources, which
 * is prompt injection, not fairness).
 */
import type { RedTeamAttackClass } from "./redteam.js";

/** the import framework the technique refs belong to (its pack controls are `mitre-atlas-techniques:<id>`) */
export const ATLAS_TECHNIQUES_FRAMEWORK = "mitre-atlas-techniques";

/** the ATLAS release the ids below were checked against */
export const ATLAS_TECHNIQUES_RELEASE = "2026.10";

export const REDTEAM_CLASS_ATLAS_TECHNIQUES: Readonly<Record<RedTeamAttackClass, readonly string[]>> = {
  prompt_injection: ["AML.T0051", "AML.T0051.000", "AML.T0065"],
  jailbreak: ["AML.T0054"],
  data_exfiltration: ["AML.T0024", "AML.T0085", "AML.T0136"],
  pii_leak: ["AML.T0137", "AML.T0137.003"],
  bias: [],
  indirect_prompt_injection: ["AML.T0051.001", "AML.T0070", "AML.T0080", "AML.T0099"],
  tool_abuse: ["AML.T0053", "AML.T0086", "AML.T0110"],
  excessive_agency: ["AML.T0053", "AML.T0101"],
  system_prompt_extraction: ["AML.T0069", "AML.T0069.002"],
  encoding_evasion: ["AML.T0068"],
};

/** the pack control ref for an ATLAS technique id */
export const atlasTechniqueRef = (id: string): string => `${ATLAS_TECHNIQUES_FRAMEWORK}:${id}`;

/** the attack classes that exercise a technique (the inverse view, for a technique's "tested by") */
export function redTeamClassesForAtlasTechnique(id: string): RedTeamAttackClass[] {
  return (Object.keys(REDTEAM_CLASS_ATLAS_TECHNIQUES) as RedTeamAttackClass[])
    .filter((c) => REDTEAM_CLASS_ATLAS_TECHNIQUES[c].includes(id))
    .sort();
}
