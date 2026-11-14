/**
 * ADR-0297 (P18 B6) — the SR 11-7 and NYC Local Law 144 sector packs.
 *
 *  1. Each parses, is seeded once, is in the picker vocabulary, claims no review or compliance, and is pinned.
 *  2. Every title cites its section; attested controls use `none` and say what to attest.
 *  3. LL144's bias audit rests on the ADR-0222 fairness evidence and names the duties the employer keeps
 *     (independence, annual repeat); its audit controls are bias controls on the trust radar.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { NYC_LL144_PACK, SECTOR_PACKS, SR_11_7_PACK } from "./sector-packs.js";
import { dimensionForControl } from "./trust-dimensions.js";

const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");

describe("schema, seed and pins", () => {
  it("each pack parses, is seeded once and is in the picker vocabulary", () => {
    for (const p of SECTOR_PACKS) {
      createCompliancePackSchema.parse(p);
      expect(DEFAULT_COMPLIANCE_PACKS.filter((x) => x.framework === p.framework)).toHaveLength(1);
      expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(p.framework);
      expect(p.provenance.reviewedBy).toBeNull();
      expect(JSON.stringify(p.controls)).not.toMatch(/\b(compliant|certified)\b/i);
    }
  });

  it("is pinned: a published version is never edited (ADR-0058)", () => {
    expect(Object.fromEntries(SECTOR_PACKS.map((p) => [p.framework, digest(p)]))).toEqual({
      "sr-11-7": "6717ba8d1f4c67806ca7a8efd78fdc3ae4776ccf29281cfb6ee87b21834b2931",
      "nyc-ll144": "5930fc095e6ad33b263c1d46eff7a456b2305deff68b19065a089b0054517b78",
    });
  });
});

describe("citations and honest coverage", () => {
  it("every title cites its section: SR 11-7 by part, LL144 by code or rule section", () => {
    for (const c of SR_11_7_PACK.controls) expect(c.title, c.controlRef).toMatch(/^(IV|V|V\.\d|VI) — \S/);
    for (const c of NYC_LL144_PACK.controls) expect(c.title, c.controlRef).toMatch(/^(§ 20-87\d(\([ab]\)\(\d\))?|6 RCNY § 5-30\d) — \S/);
  });

  it("attested controls use `none` and say what to attest", () => {
    for (const c of SECTOR_PACKS.flatMap((p) => p.controls)) {
      if (c.attestationRequired) {
        expect(c.collector, c.controlRef).toBe("none");
        expect(c.ownerNote ?? "", c.controlRef).toMatch(/Attest/);
      } else expect(c.collector, c.controlRef).not.toBe("none");
    }
  });

  it("LL144's bias audit rests on fairness evidence, and says independence and the yearly repeat are the employer's", () => {
    const audit = NYC_LL144_PACK.controls.find((c) => c.controlRef === "nyc-ll144:bias-audit")!;
    expect(audit.collector).toBe("model_card_fairness");
    expect(audit.coverage).toBe("partial");
    expect(audit.ownerNote).toMatch(/independent auditor/);
    expect(audit.ownerNote).toMatch(/within a year/);
    expect(dimensionForControl(audit)).toBe("bias");
    expect(dimensionForControl(NYC_LL144_PACK.controls.find((c) => c.controlRef === "nyc-ll144:candidate-notice")!)).toBe("compliance");
  });

  it("SR 11-7's annual review is enforced by approval expiry, and every SR 11-7 control is a reliability control", () => {
    const review = SR_11_7_PACK.controls.find((c) => c.controlRef === "sr-11-7:vi-periodic-review")!;
    expect([review.collector, review.coverage]).toEqual(["model_cards_approved", "enforced"]);
    for (const c of SR_11_7_PACK.controls) expect(dimensionForControl(c), c.controlRef).toBe("reliability");
  });
});
