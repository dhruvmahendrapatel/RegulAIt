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
import { NYC_LL144_PACK, SECTOR_PACKS, SR_11_7_PACK, SR_11_7_SUPERSESSION_NOTE } from "./sector-packs.js";
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
      "sr-11-7": "cd89b208a5a4131d407446d3ba119497f40f24253c067409e025f0b54b939a92",
      "nyc-ll144": "6a6df647d3b521d427909509414f4e5ec254037ec4b7f6df623f1cc1ddf50c9f",
    });
  });
});

describe("SR 11-7 is labelled superseded (SR 26-2, 17 April 2026)", () => {
  it("title, description and provenance say so, and the note states SR 26-2's generative and agentic AI scope", () => {
    expect(SR_11_7_PACK.title).toMatch(/historical mapping; superseded by SR 26-2/);
    expect(SR_11_7_PACK.description).toMatch(/superseded on 17 April 2026 by SR 26-2/);
    expect(SR_11_7_PACK.provenance.catalogueRevision).toMatch(/superseded 17 April 2026 by SR 26-2/);
    expect((SR_11_7_PACK.provenance.note ?? "").startsWith(SR_11_7_SUPERSESSION_NOTE)).toBe(true);
    expect(SR_11_7_SUPERSESSION_NOTE).toMatch(/generative AI and agentic AI models are not within its scope/);
  });
});

describe("citations and honest coverage", () => {
  it("every title cites its section: SR 11-7 by part, LL144 by code or rule section", () => {
    for (const c of SR_11_7_PACK.controls) expect(c.title, c.controlRef).toMatch(/^(IV|V|V\.\d|VI|III, V) — \S/);
    // the slug carries the part: the annual review and vendor models are Part V (Model Validation), not VI
    for (const c of SR_11_7_PACK.controls) {
      const part = /^sr-11-7:(iv|v|vi)-/.exec(c.controlRef)?.[1]?.toUpperCase();
      expect(c.title.split(" — ")[0]!.split(", ").at(-1)!.replace(/\.\d$/, ""), c.controlRef).toBe(part);
    }
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
    expect(audit.ownerNote).toMatch(/within the year before use/);
    expect(audit.ownerNote).toMatch(/no time window/);
    expect(dimensionForControl(audit)).toBe("bias");
    expect(dimensionForControl(NYC_LL144_PACK.controls.find((c) => c.controlRef === "nyc-ll144:candidate-notice")!)).toBe("compliance");
  });

  it("SR 11-7's annual review is partial (nothing caps recertification at a year), and every control is reliability", () => {
    const review = SR_11_7_PACK.controls.find((c) => c.controlRef === "sr-11-7:v-periodic-review")!;
    expect([review.collector, review.coverage]).toEqual(["model_cards_approved", "partial"]);
    expect(review.ownerNote).toMatch(/never expiring/);
    expect(review.ownerNote).toMatch(/on by default/);
    expect(SR_11_7_PACK.controls.some((c) => c.coverage === "enforced")).toBe(false);
    for (const c of SR_11_7_PACK.controls) expect(dimensionForControl(c), c.controlRef).toBe("reliability");
  });
});
