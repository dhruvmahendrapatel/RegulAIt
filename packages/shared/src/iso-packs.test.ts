/**
 * ADR-0295 (P18 B4) — the ISO/IEC ID-only packs.
 *
 *  1. SCHEMA: each pack parses, is seeded once, and claims no review, conformity or certification.
 *  2. ID ONLY: every title cites its standard and clause; the clause in the ref and the title agree.
 *  3. COMPLETENESS: 42001@2 has every requirement clause 4 to 10 and all 38 Annex A controls.
 *  4. v1 → v2: v1 is untouched, three v1 controls carry over unchanged, and the mis-numbered impact-assessment ref is
 *     replaced by 8.4 (what an admin sees in the ADR-0087 diff).
 *  5. HONEST COVERAGE: attested controls use `none` and say what to attest; each has a trust dimension.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { diffCompliancePacks } from "./compliance-pack-diff.js";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import { ISO_23894_PACK, ISO_42001_PACK_V2, ISO_42005_PACK, ISO_PACKS } from "./iso-packs.js";
import { CONTROL_DIMENSION_OVERRIDES } from "./trust-dimensions.js";

const pack = (fw: string, v: number) => DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === fw && p.version === v)!;
const digest = (p: unknown) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
const V1_CARRIED = ["iso-42001:5.3-roles-responsibilities", "iso-42001:9.1-monitoring-measurement", "iso-42001:A.6-ai-system-lifecycle"];
const STD: Record<string, string> = { "iso-42001": "42001", "iso-23894": "23894", "iso-42005": "42005" };

describe("schema and seed", () => {
  it("each pack parses, is seeded exactly once, and its framework is in the picker vocabulary", () => {
    for (const p of ISO_PACKS) {
      createCompliancePackSchema.parse(p);
      expect(DEFAULT_COMPLIANCE_PACKS.filter((x) => x.framework === p.framework && x.version === p.version)).toHaveLength(1);
      expect(COMPLIANCE_PACK_FRAMEWORKS as readonly string[]).toContain(p.framework);
    }
  });

  it("claims no review, conformity or certification", () => {
    for (const p of ISO_PACKS) {
      expect(p.provenance.reviewedBy).toBeNull();
      expect(p.provenance.note).toMatch(/NOT reproduced/);
      expect(JSON.stringify(p.controls)).not.toMatch(/\b(compliant|conformant|certified)\b/i);
    }
  });

  it("is pinned: a published version is never edited (a change is a new version, ADR-0058)", () => {
    expect(Object.fromEntries(ISO_PACKS.map((p) => [`${p.framework}@${p.version}`, digest(p)]))).toEqual({
      "iso-42001@2": "233138d2dae3edf91e32caa4053a3444d14c54e53f38fc831a524c87d96387ab",
      "iso-23894@1": "6ddcf13c5bb45cce7be0937acf8001d2a04278025238e23a15558704705a68fd",
      "iso-42005@1": "2f18b1fe841eeaae16ad5d4057264fc77ded681ddbbb99c3bab9318abab40068",
    });
  });
});

describe("ID only, and the ref agrees with the title", () => {
  it("every new title is `ISO/IEC <standard> <clause> — <our words>` and the clause matches the ref", () => {
    for (const p of ISO_PACKS) {
      for (const c of p.controls.filter((x) => !V1_CARRIED.includes(x.controlRef))) {
        const m = /^ISO\/IEC (\d{5}) ((?:A\.)?\d+(?:\.\d+)*) — \S/.exec(c.title);
        expect(m, c.title).not.toBeNull();
        expect(m![1]).toBe(STD[p.framework]);
        expect(c.controlRef.startsWith(`${p.framework}:${m![2]}-`), `${c.controlRef} vs ${c.title}`).toBe(true);
      }
      expect(new Set(p.controls.map((c) => c.controlRef)).size).toBe(p.controls.length);
    }
  });
});

describe("iso-42001@2 completeness", () => {
  const refs = ISO_42001_PACK_V2.controls.map((c) => c.controlRef.replace("iso-42001:", "").replace(/-.*$/, ""));

  it("has all 38 Annex A controls", () => {
    const annexA = refs.filter((r) => /^A\.\d+\.\d+/.test(r));
    expect(annexA).toEqual([
      "A.2.2", "A.2.3", "A.2.4", "A.3.2", "A.3.3", "A.4.2", "A.4.3", "A.4.4", "A.4.5", "A.4.6",
      "A.5.2", "A.5.3", "A.5.4", "A.5.5", "A.6.1.2", "A.6.1.3", "A.6.2.2", "A.6.2.3", "A.6.2.4", "A.6.2.5",
      "A.6.2.6", "A.6.2.7", "A.6.2.8", "A.7.2", "A.7.3", "A.7.4", "A.7.5", "A.7.6", "A.8.2", "A.8.3",
      "A.8.4", "A.8.5", "A.9.2", "A.9.3", "A.9.4", "A.10.2", "A.10.3", "A.10.4",
    ]);
  });

  it("has every requirement clause 4 to 10", () => {
    expect(refs.filter((r) => /^\d/.test(r))).toEqual([
      "4.1", "4.2", "4.3", "4.4", "5.1", "5.2", "5.3", "6.1.2", "6.1.3", "6.1.4", "6.2", "6.3", "7.1", "7.2", "7.3",
      "7.4", "7.5", "8.1", "8.2", "8.3", "8.4", "9.1", "9.2", "9.3", "10.1", "10.2",
    ]);
  });

  it("23894 covers clauses 5.2 to 6.7 and 42005 clauses 5.2 to 6.9", () => {
    expect(ISO_23894_PACK.controls).toHaveLength(18);
    expect(ISO_42005_PACK.controls).toHaveLength(19);
  });
});

describe("iso-42001 v1 → v2 (the diff an admin reviews)", () => {
  const v1 = pack("iso-42001", 1);
  const v2 = pack("iso-42001", 2);

  it("v1 is unchanged and three of its controls carry over byte for byte", () => {
    expect(v1.controls).toHaveLength(4);
    for (const ref of V1_CARRIED) expect(v2.controls.find((c) => c.controlRef === ref)).toEqual(v1.controls.find((c) => c.controlRef === ref));
  });

  it("the mis-numbered impact-assessment ref leaves and 8.4 arrives with the same evidence", () => {
    const d = diffCompliancePacks(v1, v2);
    expect(d.controlsRemoved.map((c) => c.controlRef)).toEqual(["iso-42001:8.3-ai-system-impact-assessment"]);
    expect(d.controlsChanged).toEqual([]);
    expect(d.cascadeTagChange).toBeNull();
    const added = v2.controls.find((c) => c.controlRef === "iso-42001:8.4-ai-system-impact-assessment")!;
    const old = v1.controls.find((c) => c.controlRef === "iso-42001:8.3-ai-system-impact-assessment")!;
    expect([added.collector, added.coverage]).toEqual([old.collector, old.coverage]);
    expect(v2.controls.find((c) => c.controlRef === "iso-42001:8.3-ai-risk-treatment")).toBeDefined();
  });
});

describe("honest coverage", () => {
  it("attested controls use `none`, say what to attest, and have an explicit trust dimension", () => {
    for (const p of ISO_PACKS) {
      for (const c of p.controls) {
        if (c.attestationRequired) {
          expect(c.collector, c.controlRef).toBe("none");
          expect(c.ownerNote ?? "", c.controlRef).toMatch(/Attest|attest|artefact/);
          expect(CONTROL_DIMENSION_OVERRIDES[c.controlRef], c.controlRef).toBeDefined();
        } else expect(c.collector, c.controlRef).not.toBe("none");
      }
    }
  });

  it("controls that wait for the impact-assessment record (P18 C1) say so", () => {
    const waiting = ISO_42005_PACK.controls.filter((c) => /P18 lane C1/.test(c.ownerNote ?? ""));
    expect(waiting.map((c) => c.controlRef)).toEqual([
      "iso-42005:5.2-documenting-process",
      "iso-42005:5.8-performing",
      "iso-42005:5.10-recording-reporting",
      "iso-42005:5.11-approval",
    ]);
  });
});
