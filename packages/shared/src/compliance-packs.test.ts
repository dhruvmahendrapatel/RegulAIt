/**
 * ADR-0058 — the pure half, proved by attack.
 *
 * The gateway suite proves evidence comes from real ledger rows. THIS file
 * proves the rules that must hold no matter what the ledger says:
 *   - an attestation-required control can never reach 'satisfied', including
 *     when a caller hands the assessor a huge evidence count;
 *   - an EXPIRED attestation falls back to 'attestation_required' rather than
 *     standing forever;
 *   - the threshold is compared, not ignored;
 *   - the scorecard has no verdict field and every seed pack carries the
 *     honest markers ADR-0058 requires.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPLIANCE_PACK_DISCLAIMER,
  DEFAULT_COMPLIANCE_PACKS,
  assessPackControl,
  buildPackScorecard,
  createCompliancePackSchema,
  packControlSchema,
  type PackControlSpec,
} from "./compliance-packs.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");

const auto: PackControlSpec = {
  controlRef: "x:1",
  title: "auto-evidenced",
  coverage: "enforced",
  collector: "audit_decisions",
  minEvidenceCount: 3,
  attestationRequired: false,
};

const organisational: PackControlSpec = {
  controlRef: "x:2",
  title: "organisational",
  coverage: "unaddressed",
  collector: "none",
  minEvidenceCount: 1,
  attestationRequired: true,
};

describe("assessPackControl — the satisfaction rule", () => {
  it("compares the threshold rather than checking for any row at all", () => {
    expect(assessPackControl(auto, 2, null, NOW).status).toBe("unsatisfied");
    expect(assessPackControl(auto, 3, null, NOW).status).toBe("satisfied");
    expect(assessPackControl(auto, 0, null, NOW).status).toBe("unsatisfied");
  });

  it("never returns 'satisfied' for an attestation-required control — not even with evidence", () => {
    // the attack: hand the assessor a mis-authored control that carries BOTH
    // the flag and a huge count. The flag branch returns first.
    const mixed: PackControlSpec = { ...organisational, collector: "audit_decisions" };
    expect(assessPackControl(organisational, null, null, NOW).status).toBe("attestation_required");
    expect(assessPackControl(mixed, 1_000_000, null, NOW).status).toBe("attestation_required");
    expect(assessPackControl(mixed, 1_000_000, null, NOW).evidenceCount).toBeNull();
  });

  it("reports 'attested' — never 'satisfied' — when a live attestation exists", () => {
    const a = assessPackControl(
      organisational,
      null,
      { statement: "we train everyone", attestedBy: "u1", attestedAt: NOW.toISOString(), validUntil: null },
      NOW,
    );
    expect(a.status).toBe("attested");
    expect(a.status).not.toBe("satisfied");
    expect(a.note).toMatch(/NOT evidence RegulAIt collected/);
  });

  it("falls back to attestation_required when the attestation has EXPIRED", () => {
    const expired = assessPackControl(
      organisational,
      null,
      {
        statement: "we trained everyone last year",
        attestedBy: "u1",
        attestedAt: "2025-01-01T00:00:00.000Z",
        validUntil: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(expired.status).toBe("attestation_required");
    expect(expired.note).toMatch(/EXPIRED/);
    expect(expired.attestation).toBeNull();
  });

  it("reports an unaddressed control as unaddressed, not as a silent pass", () => {
    const unaddressed: PackControlSpec = {
      controlRef: "x:3",
      title: "nope",
      coverage: "unaddressed",
      collector: "none",
      minEvidenceCount: 1,
      attestationRequired: false,
    };
    expect(assessPackControl(unaddressed, null, null, NOW).status).toBe("unaddressed");
  });
});

describe("buildPackScorecard — counts, never a verdict", () => {
  const scorecard = buildPackScorecard({
    framework: "iso-42001",
    packVersion: 3,
    packTitle: "t",
    cascadeTag: null,
    scope: { kind: "org", id: null, projectIds: null },
    period: { period: "current_quarter", label: "Q3 2026", start: "a", end: "b" },
    generatedAt: NOW.toISOString(),
    controls: [
      assessPackControl(auto, 5, null, NOW),
      assessPackControl(organisational, null, null, NOW),
    ],
  });

  it("has no verdict field of any kind", () => {
    expect(scorecard).not.toHaveProperty("compliant");
    expect(scorecard).not.toHaveProperty("verdict");
    expect(scorecard).not.toHaveProperty("passed");
    expect(scorecard).not.toHaveProperty("score");
  });

  it("counts attestation-required separately from satisfied", () => {
    expect(scorecard.totals.satisfied).toBe(1);
    expect(scorecard.totals.attestationRequired).toBe(1);
    expect(scorecard.totals.controls).toBe(2);
  });

  it("carries the disclaimer and says plainly it is not a verdict", () => {
    expect(scorecard.disclaimer).toBe(COMPLIANCE_PACK_DISCLAIMER);
    expect(scorecard.statement).toMatch(/NOT a compliance verdict/);
  });
});

describe("the pack schema refuses the shapes that would manufacture assurance", () => {
  it("refuses an attestation-required control paired with a real collector", () => {
    const res = packControlSchema.safeParse({
      controlRef: "x:1",
      title: "t",
      coverage: "partial",
      collector: "audit_decisions",
      attestationRequired: true,
    });
    expect(res.success).toBe(false);
  });

  it("refuses a collector-less control that is neither attested nor declared unaddressed", () => {
    const res = packControlSchema.safeParse({
      controlRef: "x:1",
      title: "t",
      coverage: "enforced",
      collector: "none",
      attestationRequired: false,
    });
    expect(res.success).toBe(false);
  });

  it("refuses a duplicate controlRef inside one pack version", () => {
    const one = {
      controlRef: "dup",
      title: "t",
      coverage: "enforced" as const,
      collector: "audit_decisions" as const,
      attestationRequired: false,
    };
    const res = createCompliancePackSchema.safeParse({
      framework: "f",
      version: 1,
      title: "t",
      provenance: { source: "s" },
      controls: [one, one],
    });
    expect(res.success).toBe(false);
  });
});

describe("the launch packs are honest data", () => {
  it("every one parses under the schema the API accepts", () => {
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      const res = createCompliancePackSchema.safeParse(pack);
      expect(res.success, `${pack.framework} failed to parse`).toBe(true);
    }
  });

  it("every one marks at least one control attestation-required — the honest stopping point", () => {
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      expect(
        pack.controls.some((c) => c.attestationRequired),
        `${pack.framework} claims to cover everything, which would be the overclaim`,
      ).toBe(true);
    }
  });

  it("none of them claims a counsel review it has not had", () => {
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      expect(pack.provenance.reviewedBy ?? null).toBeNull();
    }
  });

  it("covers the launch frameworks and the ISO 27001 partial mapping", () => {
    const frameworks = [...new Set(DEFAULT_COMPLIANCE_PACKS.map((p) => p.framework))].sort();
    // ADR-0182 S5: the ISACA AI agents checklist joins the launch set
    expect(frameworks).toEqual(["eu-ai-act", "finra", "hipaa", "isaca-ai-agents", "iso-27001", "iso-42001", "nist-ai-rmf", "pci-dss", "soc-2"]);
    // ADR-0150: exactly two frameworks ship a second version (bias/safety controls)
    const versions = DEFAULT_COMPLIANCE_PACKS.map((p) => `${p.framework}@${p.version}`).sort();
    expect(versions.filter((v) => v.endsWith("@2"))).toEqual(["eu-ai-act@2", "nist-ai-rmf@2"]);
    // ADR-0175: the NIST AI RMF pack ships a third version (ID correction);
    // ADR-0182 S5: the EU AI Act a third (Art. 4 as amended, Art. 73) and NIST
    // a fourth (the accountability records as evidence)
    expect(versions.filter((v) => v.endsWith("@3"))).toEqual(["eu-ai-act@3", "nist-ai-rmf@3"]);
    expect(versions.filter((v) => v.endsWith("@4"))).toEqual(["nist-ai-rmf@4"]);
    expect(versions.filter((v) => /@([5-9]|\d\d)$/.test(v))).toEqual([]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("never presents the ISO 27001 seed as a Statement of Applicability or certification", () => {
    const pack = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === "iso-27001")!;
    expect(pack.description).toMatch(/not a Statement of Applicability/);
    expect(pack.description).toMatch(/not .*certification/);
    expect(pack.controls.every((c) => c.coverage !== "enforced")).toBe(true);
    expect(pack.controls.some((c) => c.attestationRequired && c.controlRef === "iso-27001:6.1.3")).toBe(true);
  });

  // batch B1 — ADR-0058 §2's preset half: a pack with a cascade tag now
  // carries the profile its activation seeds, and the pairing rules are pinned
  // at the schema so an admin pack cannot ship a preset with nothing to hang
  // it on.
  it("every pack with a cascadeTag carries a preset, every tagless pack carries none", () => {
    for (const pack of DEFAULT_COMPLIANCE_PACKS) {
      if (pack.cascadeTag) {
        expect(pack.cascadePreset, `${pack.framework} names '${pack.cascadeTag}' but seeds nothing`).toBeTruthy();
      } else {
        // SOC 2 / NIST AI RMF / ISO 42001 force no data-sensitivity cascade
        expect(pack.cascadePreset ?? null, `${pack.framework} has no tag to hang a preset on`).toBeNull();
      }
    }
  });

  describe("ADR-0175 — nist-ai-rmf v3 corrects the subcategory IDs without touching v1 or v2", () => {
    const nist = (v: number) => DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === "nist-ai-rmf" && p.version === v)!;

    it("v1 and v2 are byte-for-byte what was published (immutability)", () => {
      // sha256 of JSON.stringify(pack), taken from the build BEFORE v3 was
      // added. Any edit to a published version — even a typo fix — fails here;
      // a correction is a new version, never a rewrite.
      const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
      expect(digest(nist(1))).toBe("505b02ede976ece7148e14119ba21917f52774cfd61a31633135a83bdb0b988a");
      expect(digest(nist(2))).toBe("8a51156213b6a81253cae990f6e047da6be0701fd57d28106b3f3305ecaa110b");
      expect(nist(1).controls.map((c) => c.controlRef)).toContain("nist-ai-rmf:MANAGE-2.2");
    });

    it("v3 re-keys the two misfiled controls with their evidence unchanged", () => {
      const v2 = new Map(nist(2).controls.map((c) => [c.controlRef, c]));
      const v3 = new Map(nist(3).controls.map((c) => [c.controlRef, c]));
      expect(v3.has("nist-ai-rmf:MANAGE-2.2")).toBe(false);
      expect(v3.get("nist-ai-rmf:GOVERN-2.1")?.collector).toBe(v2.get("nist-ai-rmf:GOVERN-1.2")?.collector);
      expect(v3.get("nist-ai-rmf:MANAGE-2.4")?.collector).toBe(v2.get("nist-ai-rmf:MANAGE-2.2")?.collector);
      expect(v3.get("nist-ai-rmf:MANAGE-2.4")?.collectorParams).toEqual(v2.get("nist-ai-rmf:MANAGE-2.2")?.collectorParams);
      // GOVERN-1.2 keeps its id but now means what the framework says
      expect(v3.get("nist-ai-rmf:GOVERN-1.2")?.collector).not.toBe("abac_policies_active");
      // MEASURE-2.7 (security) counts red-team runs, not quality evaluations
      expect(v3.get("nist-ai-rmf:MEASURE-2.7")?.collectorParams).toEqual({ ruleIdPrefix: "redteam-run-" });
    });

    it("v3 marks the organisational subcategories attestation-required", () => {
      const v3 = new Map(nist(3).controls.map((c) => [c.controlRef, c]));
      for (const id of ["GOVERN-1.1", "GOVERN-2.2", "GOVERN-2.3", "GOVERN-3.1", "GOVERN-4.1"]) {
        const c = v3.get(`nist-ai-rmf:${id}`);
        expect(c?.attestationRequired, id).toBe(true);
        expect(c?.collector, id).toBe("none");
      }
    });

    it("v3's version note and description explain the correction", () => {
      const v3 = nist(3);
      expect(v3.title).toMatch(/ — v3 /);
      expect(v3.provenance.note).toMatch(/GOVERN 1\.2 -> GOVERN 2\.1/);
      expect(v3.provenance.note).toMatch(/MANAGE 2\.2 -> MANAGE 2\.4/);
      expect(v3.provenance.note).toMatch(/v1 and v2 are unchanged/);
      expect(v3.description).toMatch(/GOVERN 2\.1/);
      expect(v3.provenance.reviewedBy ?? null).toBeNull();
    });

    it("v3 widens coverage with collector-backed controls and keeps every v2 subject", () => {
      const v3 = nist(3).controls;
      expect(v3.length).toBeGreaterThan(nist(2).controls.length * 3);
      expect(v3.filter((c) => c.collector !== "none").length).toBeGreaterThan(20);
      const refs = new Set(v3.map((c) => c.controlRef));
      for (const kept of ["MAP-4.1", "MEASURE-2.7", "MEASURE-2.11", "MEASURE-2.6", "GOVERN-4.1"]) {
        expect(refs, kept).toContain(`nist-ai-rmf:${kept}`);
      }
      for (const added of ["GOVERN-1.5", "GOVERN-1.6", "GOVERN-1.7", "GOVERN-6.1", "MANAGE-1.1", "MANAGE-1.4", "MEASURE-3.1"]) {
        expect(refs, added).toContain(`nist-ai-rmf:${added}`);
      }
    });
  });

  it("refuses a cascadePreset without a cascadeTag, and an ill-typed preset", () => {
    const base = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === "soc-2")!;
    const orphanPreset = createCompliancePackSchema.safeParse({
      ...base,
      cascadePreset: { piiMode: "block" },
    });
    expect(orphanPreset.success).toBe(false);
    // the preset passes the SAME validator as a compliance_profile version
    // body: a selection column (`tag`) and a wrong type are both refused
    const hipaa = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === "hipaa")!;
    expect(
      createCompliancePackSchema.safeParse({ ...hipaa, cascadePreset: { tag: "smuggled" } }).success,
    ).toBe(false);
    expect(
      createCompliancePackSchema.safeParse({ ...hipaa, cascadePreset: { auditRetentionDays: "six years" } })
        .success,
    ).toBe(false);
  });
});
