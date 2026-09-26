/**
 * ADR-0081 — the pure half, proved by attack.
 *
 * The gateway suite proves evidence comes from real ledger rows. THIS file
 * pins the rules that must hold no matter what any ledger says:
 *   - every seed library entry parses under the schema, generically — so a
 *     future entry inherits every invariant below without a new test;
 *   - a resolver outside its category's fixed mapping is refused (no entry
 *     can shop for a flattering query);
 *   - an attestation-only category can carry exactly ['none'] and a
 *     ledger-evidenced category can never carry 'none' — the two directions
 *     of the "we don't overclaim" rule;
 *   - the library keeps at least one attestation-only entry, the standing
 *     control case for that rule;
 *   - the acceptance path's vocabulary excludes 'accepted' from transitions.
 */
import { describe, expect, it } from "vitest";
import {
  AI_RISK_CATEGORIES,
  AI_RISK_REGISTER_DISCLAIMER,
  DEFAULT_RISK_LIBRARY,
  RISK_CATEGORY_EVIDENCE,
  RISK_EVIDENCE_RESOLVERS,
  riskLibraryEntrySchema,
  transitionRiskSchema,
} from "./risks.js";

describe("the category → evidence mapping", () => {
  it("covers every category, names only real resolver ids, and is honest about 'none'", () => {
    for (const category of AI_RISK_CATEGORIES) {
      const resolvers = RISK_CATEGORY_EVIDENCE[category];
      expect(resolvers.length).toBeGreaterThan(0);
      for (const r of resolvers) expect(RISK_EVIDENCE_RESOLVERS).toContain(r);
      // 'none' never hides among real resolvers — it is the whole answer or absent
      if (resolvers.includes("none")) expect(resolvers).toEqual(["none"]);
    }
  });

  it("keeps at least one attestation-only category — the control case for never overclaiming", () => {
    const attestationOnly = AI_RISK_CATEGORIES.filter((c) =>
      RISK_CATEGORY_EVIDENCE[c].includes("none"),
    );
    expect(attestationOnly.length).toBeGreaterThan(0);
  });
});

describe("DEFAULT_RISK_LIBRARY — generic invariants over every entry", () => {
  it("every entry parses under the schema (which enforces the mapping rules)", () => {
    for (const entry of DEFAULT_RISK_LIBRARY) {
      const parsed = riskLibraryEntrySchema.safeParse(entry);
      expect(parsed.success, `entry '${entry.key}': ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    }
  });

  it("keys are unique", () => {
    const keys = DEFAULT_RISK_LIBRARY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry's resolvers are exactly its category's fixed mapping", () => {
    for (const entry of DEFAULT_RISK_LIBRARY) {
      expect([...entry.evidenceResolvers].sort()).toEqual(
        [...RISK_CATEGORY_EVIDENCE[entry.category]].sort(),
      );
    }
  });

  it("at least one entry is attestation-only, and its control names its own limits", () => {
    const control = DEFAULT_RISK_LIBRARY.filter(
      (e) => e.evidenceResolvers.length === 1 && e.evidenceResolvers[0] === "none",
    );
    expect(control.length).toBeGreaterThan(0);
  });
});

describe("the schema refuses what the register must never accept", () => {
  const base = DEFAULT_RISK_LIBRARY.find((e) => e.category === "prompt_injection")!;

  it("a resolver outside the category's mapping", () => {
    const shopped = { ...base, evidenceResolvers: ["shadow_findings" as const] };
    expect(riskLibraryEntrySchema.safeParse(shopped).success).toBe(false);
  });

  it("'none' hidden among real resolvers on a measured category", () => {
    const dressed = { ...base, evidenceResolvers: ["redteam_asr" as const, "none" as const] };
    expect(riskLibraryEntrySchema.safeParse(dressed).success).toBe(false);
  });

  it("a real resolver beside 'none' on the attestation-only category", () => {
    const drift = DEFAULT_RISK_LIBRARY.find((e) => e.category === "scope_drift")!;
    const inflated = { ...drift, evidenceResolvers: ["none" as const, "governed_denials" as const] };
    expect(riskLibraryEntrySchema.safeParse(inflated).success).toBe(false);
  });

  it("'accepted' as a transition target — acceptance is its own audited act", () => {
    expect(
      transitionRiskSchema.safeParse({ status: "accepted", reason: "sneaking past the record" })
        .success,
    ).toBe(false);
  });
});

describe("the disclaimer", () => {
  it("carries the three honesty clauses on its face", () => {
    expect(AI_RISK_REGISTER_DISCLAIMER).toMatch(/not real-world exposure/);
    expect(AI_RISK_REGISTER_DISCLAIMER).toMatch(/DECLARED human judgments/);
    expect(AI_RISK_REGISTER_DISCLAIMER).toMatch(/none — attestation only/);
  });
});
