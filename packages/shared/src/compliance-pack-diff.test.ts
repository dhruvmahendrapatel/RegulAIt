/**
 * ADR-0087 — the pack-version differ, proved by attack.
 *
 * The properties that must hold no matter what two versions are handed in:
 *   - diff(a, a) is empty and says `identical: true` (symmetric sanity);
 *   - every change KIND is detected: added, removed, and each per-field
 *     change (coverage, collector, params, threshold, attestation flag,
 *     owner note, title);
 *   - a cascadeTag change is flagged DISTINCTLY with HIGH consequence, not
 *     buried among prose edits;
 *   - the result is deterministic and order-independent: shuffling control
 *     order or object key order changes nothing;
 *   - the output parses under its own zod schema.
 */
import { describe, expect, it } from "vitest";
import {
  compliancePackDiffSchema,
  diffCompliancePacks,
  type PackVersionSnapshot,
} from "./compliance-pack-diff.js";

const V1: PackVersionSnapshot = {
  title: "ACME internal AI standard",
  description: "v1 mapping",
  provenance: { source: "ACME GRC team", catalogueRevision: "2026.1" },
  cascadeTag: null,
  controls: [
    {
      controlRef: "acme:1.1",
      title: "Every governed decision is recorded",
      coverage: "enforced",
      collector: "audit_decisions",
      collectorParams: { effect: "deny", ruleIdPrefix: "egress" },
      minEvidenceCount: 1,
      attestationRequired: false,
      ownerNote: null,
    },
    {
      controlRef: "acme:2.1",
      title: "Human approvals happen",
      coverage: "evidenced",
      collector: "approvals",
      collectorParams: { status: "approved" },
      minEvidenceCount: 1,
      attestationRequired: false,
      ownerNote: null,
    },
    {
      controlRef: "acme:9.9",
      title: "Staff are trained",
      coverage: "unaddressed",
      collector: "none",
      collectorParams: {},
      minEvidenceCount: 1,
      attestationRequired: true,
      ownerNote: "Training records live in the LMS.",
    },
  ],
};

/** v2: one control removed (2.1), one added (3.1), 1.1 changed on several
 * fields, 9.9 untouched; pack title + cascadeTag changed */
const V2: PackVersionSnapshot = {
  title: "ACME internal AI standard (rev. 2027)",
  description: "v1 mapping",
  provenance: { source: "ACME GRC team", catalogueRevision: "2026.1" },
  cascadeTag: "acme-restricted",
  controls: [
    {
      controlRef: "acme:1.1",
      title: "Every governed decision is recorded and reviewed",
      coverage: "evidenced",
      collector: "audit_decisions",
      collectorParams: { effect: "deny" },
      minEvidenceCount: 10,
      attestationRequired: false,
      ownerNote: "Review cadence is the customer's.",
    },
    {
      controlRef: "acme:3.1",
      title: "Lineage is recorded",
      coverage: "evidenced",
      collector: "lineage_edges",
      collectorParams: {},
      minEvidenceCount: 1,
      attestationRequired: false,
      ownerNote: null,
    },
    { ...V1.controls[2]! },
  ],
};

describe("diffCompliancePacks — symmetric sanity", () => {
  it("diff(a, a) is empty, identical, and parses under its own schema", () => {
    const d = diffCompliancePacks(V1, V1);
    expect(d.identical).toBe(true);
    expect(d.packChanges).toEqual([]);
    expect(d.cascadeTagChange).toBeNull();
    expect(d.controlsAdded).toEqual([]);
    expect(d.controlsRemoved).toEqual([]);
    expect(d.controlsChanged).toEqual([]);
    expect(d.summary).toEqual({
      controlsAdded: 0,
      controlsRemoved: 0,
      controlsChanged: 0,
      controlsUnchanged: 3,
      packFieldsChanged: 0,
      cascadeTagChanged: false,
    });
    expect(() => compliancePackDiffSchema.parse(d)).not.toThrow();
  });

  it("null vs undefined vs {} in nullish fields is NOT a change", () => {
    const a: PackVersionSnapshot = {
      ...V1,
      description: undefined,
      cascadeTag: undefined,
      controls: [{ ...V1.controls[0]!, ownerNote: undefined, description: undefined }],
    };
    const b: PackVersionSnapshot = {
      ...V1,
      description: null,
      cascadeTag: null,
      controls: [{ ...V1.controls[0]!, ownerNote: null, description: null }],
    };
    expect(diffCompliancePacks(a, b).identical).toBe(true);
  });
});

describe("diffCompliancePacks — every change kind is detected", () => {
  const d = diffCompliancePacks(V1, V2);

  it("detects the added control", () => {
    expect(d.controlsAdded.map((c) => c.controlRef)).toEqual(["acme:3.1"]);
    expect(d.controlsAdded[0]!.collector).toBe("lineage_edges");
    expect(d.summary.controlsAdded).toBe(1);
  });

  it("detects the removed control", () => {
    expect(d.controlsRemoved.map((c) => c.controlRef)).toEqual(["acme:2.1"]);
    expect(d.summary.controlsRemoved).toBe(1);
  });

  it("detects each changed field with its before/after", () => {
    expect(d.controlsChanged.map((c) => c.controlRef)).toEqual(["acme:1.1"]);
    const fields = new Map(d.controlsChanged[0]!.fields.map((f) => [f.field, f]));
    expect(fields.get("title")!.to).toBe("Every governed decision is recorded and reviewed");
    expect(fields.get("coverage")).toEqual({ field: "coverage", from: "enforced", to: "evidenced" });
    expect(fields.get("collectorParams")).toEqual({
      field: "collectorParams",
      from: { effect: "deny", ruleIdPrefix: "egress" },
      to: { effect: "deny" },
    });
    expect(fields.get("minEvidenceCount")).toEqual({ field: "minEvidenceCount", from: 1, to: 10 });
    expect(fields.get("ownerNote")!.from).toBeNull();
    // collector did NOT change — a field that is equal must not be listed
    expect(fields.has("collector")).toBe(false);
    expect(fields.has("attestationRequired")).toBe(false);
  });

  it("detects collector and attestationRequired changes when they do differ", () => {
    const d2 = diffCompliancePacks(
      { ...V1, controls: [V1.controls[0]!] },
      {
        ...V1,
        controls: [
          {
            ...V1.controls[0]!,
            collector: "none",
            collectorParams: {},
            attestationRequired: true,
            coverage: "unaddressed",
          },
        ],
      },
    );
    const fields = new Map(d2.controlsChanged[0]!.fields.map((f) => [f.field, f]));
    expect(fields.get("collector")).toEqual({ field: "collector", from: "audit_decisions", to: "none" });
    expect(fields.get("attestationRequired")).toEqual({
      field: "attestationRequired",
      from: false,
      to: true,
    });
  });

  it("the untouched control counts as unchanged, and identical is false", () => {
    expect(d.summary.controlsUnchanged).toBe(1); // acme:9.9
    expect(d.identical).toBe(false);
  });

  it("detects pack-level changes (title, provenance) as such", () => {
    expect(d.packChanges.map((c) => c.field)).toEqual(["title", "cascadeTag"]);
    const prov = diffCompliancePacks(V1, {
      ...V1,
      provenance: { source: "ACME GRC team", catalogueRevision: "2027.1" },
    });
    expect(prov.packChanges.map((c) => c.field)).toEqual(["provenance"]);
    expect(prov.cascadeTagChange).toBeNull();
  });
});

describe("diffCompliancePacks — the cascadeTag flag", () => {
  it("a cascadeTag change is flagged DISTINCTLY with HIGH consequence", () => {
    const d = diffCompliancePacks(V1, V2);
    expect(d.cascadeTagChange).not.toBeNull();
    expect(d.cascadeTagChange!.consequence).toBe("HIGH");
    expect(d.cascadeTagChange!.from).toBeNull();
    expect(d.cascadeTagChange!.to).toBe("acme-restricted");
    expect(d.cascadeTagChange!.note).toMatch(/§8.3/);
    expect(d.summary.cascadeTagChanged).toBe(true);
    // and it ALSO appears among the pack-level changes — flagged twice on purpose
    expect(d.packChanges.some((c) => c.field === "cascadeTag")).toBe(true);
  });

  it("no flag when the tag is unchanged — including when other fields moved", () => {
    const d = diffCompliancePacks(V1, { ...V1, title: "renamed" });
    expect(d.cascadeTagChange).toBeNull();
    expect(d.summary.cascadeTagChanged).toBe(false);
  });
});

describe("diffCompliancePacks — deterministic and order-independent", () => {
  it("shuffling control order and object key order changes NOTHING", () => {
    const shuffledV1: PackVersionSnapshot = {
      ...V1,
      provenance: { catalogueRevision: "2026.1", source: "ACME GRC team" },
      controls: [
        { ...V1.controls[2]!, collectorParams: {} },
        { ...V1.controls[0]!, collectorParams: { ruleIdPrefix: "egress", effect: "deny" } },
        V1.controls[1]!,
      ],
    };
    const shuffledV2: PackVersionSnapshot = { ...V2, controls: [...V2.controls].reverse() };
    expect(diffCompliancePacks(shuffledV1, shuffledV2)).toEqual(diffCompliancePacks(V1, V2));
    expect(diffCompliancePacks(V1, shuffledV1).identical).toBe(true);
  });

  it("output lists are sorted by controlRef", () => {
    const many: PackVersionSnapshot = {
      ...V1,
      controls: [
        { ...V1.controls[0]!, controlRef: "z:9" },
        { ...V1.controls[0]!, controlRef: "a:1" },
        { ...V1.controls[0]!, controlRef: "m:5" },
      ],
    };
    const none: PackVersionSnapshot = { ...V1, controls: [{ ...V1.controls[0]!, controlRef: "kept" }] };
    const d = diffCompliancePacks(none, many);
    expect(d.controlsAdded.map((c) => c.controlRef)).toEqual(["a:1", "m:5", "z:9"]);
    expect(d.controlsRemoved.map((c) => c.controlRef)).toEqual(["kept"]);
  });

  it("the full diff parses under compliancePackDiffSchema", () => {
    expect(() => compliancePackDiffSchema.parse(diffCompliancePacks(V1, V2))).not.toThrow();
  });
});
