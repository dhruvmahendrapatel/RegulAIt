/**
 * ADR-0294 (P18 A3, A4, B5) — NIST AI 600-1 and the AI RMF Playbook.
 *
 *  1. The authored pack: twelve controls, one per §2 GAI risk, in the seed catalogue, claiming no review, honest about
 *     what the platform does not address.
 *  2. The vendored AI 600-1 snapshot: 212 suggested actions, each tagged with known GAI risks and pointing at a real
 *     AI RMF subcategory; importing it onto the pack keeps the twelve risk controls and adds every action unmapped.
 *  3. The Playbook supplement: every AI RMF subcategory carries suggested actions, pinned by sha256.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_PACK_FRAMEWORKS, DEFAULT_COMPLIANCE_PACKS, createCompliancePackSchema } from "./compliance-packs.js";
import {
  NIST_AI_600_1_RISKS,
  frameworkImportSnapshotSchema,
  normaliseNistAi600Text,
  planFrameworkImport,
  withPlaybookActions,
} from "./framework-imports.js";
import { NIST_AI_600_1_FRAMEWORK, NIST_AI_600_1_PACK } from "./nist-ai-600-1-pack.js";
import { isNistAiRmfSubcategory } from "./nist-ai-rmf-subcategories.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "framework-imports-data");
const snapshot = (name: string) => frameworkImportSnapshotSchema.parse(JSON.parse(readFileSync(path.join(dataDir, name), "utf8")));

describe("the authored nist-ai-600-1@1 pack", () => {
  it("parses, is in the seed catalogue once and its framework is in the picker vocabulary", () => {
    createCompliancePackSchema.parse(NIST_AI_600_1_PACK);
    expect(DEFAULT_COMPLIANCE_PACKS.filter((p) => p.framework === NIST_AI_600_1_FRAMEWORK)).toHaveLength(1);
    expect(COMPLIANCE_PACK_FRAMEWORKS).toContain(NIST_AI_600_1_FRAMEWORK);
  });

  it("has one control per GAI risk, in §2 order, named as NIST names it", () => {
    expect(NIST_AI_600_1_PACK.controls.map((c) => c.title.replace(/^GAI risk \d+ — /, ""))).toEqual([...NIST_AI_600_1_RISKS]);
    expect(NIST_AI_600_1_PACK.controls.map((c) => c.title.match(/^GAI risk (\d+)/)![1])).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 1)),
    );
    for (const c of NIST_AI_600_1_PACK.controls) expect(c.controlRef).toMatch(/^nist-ai-600-1:risk-[a-z-]+$/);
  });

  it("is pinned: a published version is never edited (a change is a new version, ADR-0058)", () => {
    const pinned = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === NIST_AI_600_1_FRAMEWORK && p.version === 1)!;
    expect(createHash("sha256").update(JSON.stringify(pinned)).digest("hex")).toBe(
      "324d75b2983c6269c4fac566e1b22688fcce9159abfc823056b9b43dd908ba82",
    );
  });

  it("claims no review and no conformity, and every attested control says what to attest", () => {
    expect(NIST_AI_600_1_PACK.provenance.reviewedBy).toBeNull();
    expect(JSON.stringify(NIST_AI_600_1_PACK)).not.toMatch(/\b(compliant|certified|certification)\b/i);
    for (const c of NIST_AI_600_1_PACK.controls) {
      if (c.attestationRequired) {
        expect(c.collector, c.controlRef).toBe("none");
        expect(c.ownerNote ?? "", c.controlRef).toMatch(/Attest/);
      } else expect(c.collector, c.controlRef).not.toBe("none");
      if (c.coverage === "unaddressed") expect(c.ownerNote ?? "", c.controlRef).toMatch(/^Not addressed by the platform/);
    }
  });
});

describe("the vendored NIST AI 600-1 suggested actions", () => {
  const snap = snapshot("nist-ai-600-1.json");

  it("holds the profile's 212 actions, each pointing at a real AI RMF subcategory", () => {
    expect(snap.source.framework).toBe(NIST_AI_600_1_FRAMEWORK);
    expect(snap.source.licence).toBe("US-Gov-Public-Domain");
    expect(snap.controls).toHaveLength(212);
    for (const c of snap.controls) {
      const m = /^nist-ai-600-1:(GV|MP|MS|MG)-(\d+\.\d+)-\d{3}$/.exec(c.controlRef);
      expect(m, c.controlRef).not.toBeNull();
      const fn = { GV: "GOVERN", MP: "MAP", MS: "MEASURE", MG: "MANAGE" }[m![1]!]!;
      expect(isNistAiRmfSubcategory(`${fn}-${m![2]}`), c.controlRef).toBe(true);
      expect(c.description).toContain(`AI RMF subcategory: ${fn} ${m![2]}.`);
    }
  });

  it("tags every action with known GAI risks, and every risk tags at least one action", () => {
    const known = new Set<string>([...NIST_AI_600_1_RISKS, "Civil Rights violations"]);
    const used = new Set<string>();
    for (const c of snap.controls) {
      const tags = /GAI risks: (.*?)\. AI RMF subcategory/.exec(c.description ?? "")![1]!.split("; ");
      for (const t of tags) {
        expect(known.has(t), `${c.controlRef}: '${t}'`).toBe(true);
        used.add(t);
      }
    }
    for (const r of NIST_AI_600_1_RISKS) expect(used.has(r), r).toBe(true);
  });

  it("importing onto the seeded pack keeps the twelve risk controls and adds every action unmapped", () => {
    const plan = planFrameworkImport({
      snapshot: snap,
      baseline: null,
      current: { ...NIST_AI_600_1_PACK, description: NIST_AI_600_1_PACK.description ?? null, cascadeTag: null, cascadePreset: null },
    });
    expect(plan.summary.not_in_source).toBe(12);
    expect(plan.summary.added).toBe(212);
    expect(plan.toVersion).toBe(2);
    expect(plan.proposedPack.controls.filter((c) => c.coverage === "unaddressed" && c.collector === "none")).toHaveLength(212 + 3);
  });
});

describe("normaliseNistAi600Text", () => {
  const text = [
    "GOVERN 1.1: Legal and regulatory requirements involving AI are understood.",
    "Action ID Suggested Action GAI Risks",
    "GV-1.1-001",
    "Align GAI development with applicable laws, including",
    "data privacy law.",
    "Data Privacy; Harmful Bias and",
    "Homogenization",
    "14",
    "A footnote that is not part of any action.",
    "GV4.3--001",
    "Measure provenance methods.",
    "Information Integrity",
    "MS-2.7-008 Verify fine-tuning does not compromise controls.",
    "Human AI Configuration; Environmental",
    "AI Actor Tasks: Governance and Oversight",
  ].join("\n");

  it("splits actions from their risk tags, repairs the known id defect, normalises tag spellings, drops footnotes", () => {
    const out = normaliseNistAi600Text(text, { framework: "nist-ai-600-1", licence: "US-Gov-Public-Domain" });
    expect(out.map((c) => c.controlRef)).toEqual(["nist-ai-600-1:GV-1.1-001", "nist-ai-600-1:GV-4.3-001", "nist-ai-600-1:MS-2.7-008"]);
    expect(out[0]!.title).toBe("GV-1.1-001 — Align GAI development with applicable laws, including data privacy law.");
    expect(out[0]!.description).toBe(
      "Align GAI development with applicable laws, including data privacy law. GAI risks: Data Privacy; Harmful Bias and " +
        "Homogenization. AI RMF subcategory: GOVERN 1.1.",
    );
    expect(out[2]!.description).toContain("GAI risks: Human-AI Configuration; Environmental Impacts.");
  });

  it("refuses an action with no risk tag and a repeated id, so a changed layout fails the refresh", () => {
    expect(() => normaliseNistAi600Text("GV-1.1-001\nDo a thing.\n", { framework: "f", licence: "US-Gov-Public-Domain" })).toThrow(/no GAI risk tag/);
    expect(() =>
      normaliseNistAi600Text("GV-1.1-001\nA. Data Privacy\nGV-1.1-001\nB. Data Privacy\n", { framework: "f", licence: "US-Gov-Public-Domain" }),
    ).toThrow(/appears twice/);
  });
});

describe("the AI RMF Playbook supplement", () => {
  const snap = snapshot("nist-ai-rmf-oscal.json");

  it("every subcategory carries Playbook suggested actions, and the supplement is pinned and public domain", () => {
    expect(snap.controls).toHaveLength(72);
    for (const c of snap.controls) expect(c.description ?? "", c.controlRef).toMatch(/^Suggested actions \(NIST AI RMF Playbook\): \S/);
    const [supp] = snap.source.supplements ?? [];
    expect(supp?.upstreamUrl).toBe("https://airc.nist.gov/docs/playbook.json");
    expect(supp?.upstreamSha256).toBe("aecbee3d3c8820816d295b11d10fb61324b17c25c2ff39ee95e2aa5654555bba");
    expect(supp?.licence).toBe("US-Gov-Public-Domain");
  });

  it("refuses a Playbook that leaves a subcategory without actions, and strips bullets and links", () => {
    const controls = [{ controlRef: "nist-ai-rmf:GOVERN-1.1", title: "GOVERN 1.1", description: null }];
    expect(() => withPlaybookActions(controls, [], { framework: "nist-ai-rmf" })).toThrow(/no suggested actions for nist-ai-rmf:GOVERN-1.1/);
    const out = withPlaybookActions(
      controls,
      [{ title: "GOVERN 1.1", section_actions: "* Keep a [register](https://x.test).\n* Review it." }],
      { framework: "nist-ai-rmf" },
    );
    expect(out[0]!.description).toBe("Suggested actions (NIST AI RMF Playbook): Keep a register. Review it.");
  });

  it("a supplement under a licence that does not allow text is refused by the snapshot schema", () => {
    const raw = JSON.parse(readFileSync(path.join(dataDir, "nist-ai-rmf-oscal.json"), "utf8"));
    raw.source.supplements[0].licence = "CC-BY-SA-4.0";
    expect(frameworkImportSnapshotSchema.safeParse(raw).success).toBe(false);
  });
});
