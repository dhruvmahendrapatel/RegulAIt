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
    const frameworks = DEFAULT_COMPLIANCE_PACKS.map((p) => p.framework).sort();
    expect(frameworks).toEqual(["eu-ai-act", "finra", "hipaa", "iso-27001", "iso-42001", "nist-ai-rmf", "pci-dss", "soc-2"]);
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
