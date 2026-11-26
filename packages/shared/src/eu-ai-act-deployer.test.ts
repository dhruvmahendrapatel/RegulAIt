/**
 * ADR-0351 slice 2 — the EU AI Act deployer-obligation register: the pack and its declared lifecycle.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, EVIDENCE_COLLECTORS, createCompliancePackSchema } from "./compliance-packs.js";
import {
  DEPLOYER_ITEM_EVENTS,
  DEPLOYER_ITEM_STATES,
  DEPLOYER_ITEM_TRANSITIONS,
  EU_AI_ACT_DEPLOYER_CONTROLS,
  EU_AI_ACT_DEPLOYER_FRAMEWORK,
  EU_AI_ACT_DEPLOYER_PACK,
  EU_AI_ACT_DEPLOYER_PACKS,
  deployerAttestSchema,
  deployerItemState,
  deployerItemTransition,
} from "./eu-ai-act-deployer.js";
import { CONTROL_DIMENSION_OVERRIDES } from "./trust-dimensions.js";

const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

describe("the pack", () => {
  it("parses, is seeded once, is in the picker vocabulary and claims no review or conformity", () => {
    createCompliancePackSchema.parse(EU_AI_ACT_DEPLOYER_PACK);
    expect(DEFAULT_COMPLIANCE_PACKS.filter((p) => p.framework === EU_AI_ACT_DEPLOYER_FRAMEWORK)).toHaveLength(1);
    expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(EU_AI_ACT_DEPLOYER_FRAMEWORK);
    expect(EU_AI_ACT_DEPLOYER_PACK.provenance.reviewedBy).toBeNull();
    expect(JSON.stringify(EU_AI_ACT_DEPLOYER_PACK.controls)).not.toMatch(/\b(compliant|conformant|certified)\b/i);
  });

  it("covers every Art. 26 duty paragraph and the related deployer articles, once each", () => {
    const refs = EU_AI_ACT_DEPLOYER_CONTROLS.map((c) => c.controlRef);
    expect(new Set(refs).size).toBe(refs.length);
    for (const para of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(refs.some((r) => r.startsWith(`${EU_AI_ACT_DEPLOYER_FRAMEWORK}:art-26-${para}-`)), `Art. 26(${para})`).toBe(true);
    }
    for (const art of ["art-4-", "art-27-", "art-50-3-", "art-50-4-", "art-86-"]) {
      expect(refs.some((r) => r.startsWith(`${EU_AI_ACT_DEPLOYER_FRAMEWORK}:${art}`)), art).toBe(true);
    }
  });

  it("each duty has one basis: a real collector (observed) or a person's attestation (attested), never both", () => {
    const observed = EU_AI_ACT_DEPLOYER_CONTROLS.filter((c) => !c.attestationRequired);
    const attested = EU_AI_ACT_DEPLOYER_CONTROLS.filter((c) => c.attestationRequired);
    expect(observed.length).toBeGreaterThanOrEqual(5);
    for (const c of observed) {
      expect(c.collector).not.toBe("none");
      expect(EVIDENCE_COLLECTORS as readonly string[]).toContain(c.collector);
    }
    for (const c of attested) {
      expect(c.collector).toBe("none");
      expect(c.ownerNote, c.controlRef).toMatch(/Attest/);
      expect(CONTROL_DIMENSION_OVERRIDES[c.controlRef], c.controlRef).toBeDefined();
    }
  });

  it("is pinned: a published version is never edited (ADR-0058)", () => {
    expect(Object.fromEntries(EU_AI_ACT_DEPLOYER_PACKS.map((p) => [`${p.framework}@${p.version}`, digest(p)]))).toEqual({
      "eu-ai-act-deployer@1": "9162a295beb8af5be0fdac669815aa3082f8548ea2da9b5ba379d979961b06f6",
    });
  });
});

describe("the lifecycle table", () => {
  it("names only declared states and events, and every transition is unique", () => {
    const keys = DEPLOYER_ITEM_TRANSITIONS.map((t) => `${t.basis}:${t.from}:${t.event}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of DEPLOYER_ITEM_TRANSITIONS) {
      expect(DEPLOYER_ITEM_STATES).toContain(t.from);
      expect(DEPLOYER_ITEM_STATES).toContain(t.to);
      expect(DEPLOYER_ITEM_EVENTS).toContain(t.event);
    }
  });

  it("an observed duty can never be attested; an attested duty only by a person", () => {
    for (const s of DEPLOYER_ITEM_STATES) expect(deployerItemTransition("observed", s, "attest")).toBeNull();
    expect(DEPLOYER_ITEM_TRANSITIONS.filter((t) => t.event === "attest").every((t) => t.by === "person" && t.basis === "attested")).toBe(true);
    expect(deployerItemTransition("attested", "open", "attest")?.to).toBe("attested");
    expect(deployerItemTransition("attested", "review_due", "attest")?.to).toBe("attested");
    expect(deployerItemTransition("attested", "attested", "review_date_passed")?.to).toBe("review_due");
    expect(deployerItemTransition("attested", "open", "evidence_found")).toBeNull();
  });

  it("derives the state from evidence or the newest attestation", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    expect(deployerItemState("observed", { evidenceCount: 0, minEvidenceCount: 1, latestAttestation: null }, now)).toBe("open");
    expect(deployerItemState("observed", { evidenceCount: 3, minEvidenceCount: 1, latestAttestation: null }, now)).toBe("observed");
    expect(deployerItemState("attested", { evidenceCount: null, minEvidenceCount: 1, latestAttestation: null }, now)).toBe("open");
    expect(deployerItemState("attested", { evidenceCount: null, minEvidenceCount: 1, latestAttestation: { reviewDate: "2027-01-01T00:00:00Z" } }, now)).toBe("attested");
    expect(deployerItemState("attested", { evidenceCount: null, minEvidenceCount: 1, latestAttestation: { reviewDate: "2026-11-16T00:00:00Z" } }, now)).toBe("review_due");
    // an attestation with no review date (recorded through the plain pack route) is due for review, not standing forever
    expect(deployerItemState("attested", { evidenceCount: null, minEvidenceCount: 1, latestAttestation: { reviewDate: null } }, now)).toBe("review_due");
  });

  it("an attestation needs a statement, an evidence reference and a review date", () => {
    expect(deployerAttestSchema.safeParse({ controlRef: "x", statement: "s", evidenceRef: "doc-1", reviewDate: "2027-01-01T00:00:00Z" }).success).toBe(true);
    expect(deployerAttestSchema.safeParse({ controlRef: "x", statement: "s", evidenceRef: "doc-1" }).success).toBe(false);
    expect(deployerAttestSchema.safeParse({ controlRef: "x", statement: "s", reviewDate: "2027-01-01T00:00:00Z" }).success).toBe(false);
    expect(deployerAttestSchema.safeParse({ controlRef: "x", statement: " ", evidenceRef: "d", reviewDate: "2027-01-01T00:00:00Z" }).success).toBe(false);
  });
});
