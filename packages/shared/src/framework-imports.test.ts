import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffFeedEntries,
  FRAMEWORK_IMPORT_SCHEMA,
  frameworkImportSnapshotSchema,
  importContentSha256,
  importTextPolicy,
  mergeRegulatoryFeeds,
  normaliseAtlasRelease,
  normaliseFederalRegister,
  normaliseOscalCatalog,
  planFrameworkImport,
  REGULATORY_FEED_IMPORT_SCHEMA,
  regulatoryFeedSnapshotSchema,
  type FrameworkImportSnapshot,
  type ImportBasePack,
} from "./framework-imports.js";
import { NIST_AI_RMF_SUBCATEGORIES } from "./nist-ai-rmf-subcategories.js";
import type { RegulatoryUpdate } from "./regulatory-intel.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "framework-imports-data");

const oscal = (order: "asc" | "desc") => {
  const subs = [
    { id: "GOVERN_1.1", class: "subcategory", title: "GOVERN 1.1", parts: [{ name: "overview", prose: "Legal requirements are understood." }] },
    { id: "GOVERN_1.2", class: "subcategory", title: "GOVERN 1.2", parts: [{ name: "overview", prose: "Trustworthy AI is in policy." }] },
    { id: "GOVERN_1.3", class: "subcategory", title: "GOVERN 1.3", props: [{ name: "status", value: "withdrawn" }], parts: [] },
  ];
  const controls = order === "asc" ? subs : [...subs].reverse();
  return { catalog: { groups: [{ id: "GOVERN", controls: [{ id: "GOVERN_1", class: "category", controls }] }] } };
};

const atlas = {
  mitigations: {
    "AML.M0001": { id: "AML.M0001", name: "Limit Model Artifact Release", description: "See [Model](/techniques/AML.T0002)." },
    "AML.M0000": { id: "AML.M0000", name: "Limit Public Release of Information", description: "Limit release." },
  },
  relationships: {
    "AML.M0000": { mitigates: [{ target: "AML.T0001" }, { target: "AML.T0000" }, { target: "AML.T0001" }] },
  },
};

function snapshotOf(controls: FrameworkImportSnapshot["controls"], over: Partial<FrameworkImportSnapshot["source"]> = {}): FrameworkImportSnapshot {
  return frameworkImportSnapshotSchema.parse({
    schema: FRAMEWORK_IMPORT_SCHEMA,
    source: {
      sourceId: "nist-ai-rmf-oscal",
      framework: "nist-ai-rmf",
      title: "NIST AI RMF 1.0",
      publisher: "NIST",
      licence: "US-Gov-Public-Domain",
      licenceUrl: "https://example.org/licence",
      upstreamUrl: "https://example.org/catalog.json",
      sourceVersion: "1.0.0",
      upstreamRevision: "abc",
      upstreamSha256: "0".repeat(64),
      retrievedOn: "2026-10-30",
      ...over,
    },
    controls,
  });
}

const mapped = (ref: string, title: string, description: string | null = null) => ({
  controlRef: ref,
  title,
  description,
  coverage: "enforced" as const,
  collector: "abac_policies_active" as const,
  collectorParams: {},
  minEvidenceCount: 3,
  attestationRequired: false,
  ownerNote: "the admin's own note",
});

const base = (controls: ImportBasePack["controls"]): ImportBasePack => ({
  version: 3,
  title: "NIST AI RMF (mapping)",
  description: "admin authored",
  cascadeTag: null,
  cascadePreset: null,
  controls,
});

describe("ADR-0215 normalisers are deterministic", () => {
  it("an OSCAL catalog gives the same sorted controls whatever the input order, and skips withdrawn ones", () => {
    const a = normaliseOscalCatalog(oscal("asc"), { framework: "nist-ai-rmf", classes: ["subcategory"], licence: "US-Gov-Public-Domain" });
    const b = normaliseOscalCatalog(oscal("desc"), { framework: "nist-ai-rmf", classes: ["subcategory"], licence: "US-Gov-Public-Domain" });
    expect(a).toEqual(b);
    expect(a.map((c) => c.controlRef)).toEqual(["nist-ai-rmf:GOVERN-1.1", "nist-ai-rmf:GOVERN-1.2"]);
    expect(a[0]!.title).toBe("GOVERN 1.1 — Legal requirements are understood.");
  });

  it("the ATLAS release lists sorted, de-duplicated mitigated techniques and drops markdown links", () => {
    const out = normaliseAtlasRelease(atlas, { framework: "mitre-atlas", licence: "Apache-2.0" });
    expect(out.map((c) => c.controlRef)).toEqual(["mitre-atlas:AML.M0000", "mitre-atlas:AML.M0001"]);
    expect(out[0]!.description).toBe("Limit release. Mitigates ATLAS techniques: AML.T0000, AML.T0001.");
    expect(out[1]!.description).toBe("See Model.");
    expect(normaliseAtlasRelease(structuredClone(atlas), { framework: "mitre-atlas", licence: "Apache-2.0" })).toEqual(out);
  });

  it("the content hash ignores key order and changes with the content", () => {
    const s = snapshotOf([{ controlRef: "nist-ai-rmf:GOVERN-1.1", title: "t", description: null }]);
    const reordered = JSON.parse(JSON.stringify({ controls: s.controls, source: s.source, schema: s.schema })) as FrameworkImportSnapshot;
    expect(importContentSha256(reordered)).toBe(importContentSha256(s));
    const changed = snapshotOf([{ controlRef: "nist-ai-rmf:GOVERN-1.1", title: "t2", description: null }]);
    expect(importContentSha256(changed)).not.toBe(importContentSha256(s));
  });

  it("planning the same import twice gives byte-identical plans", () => {
    const snap = snapshotOf(normaliseOscalCatalog(oscal("asc"), { framework: "nist-ai-rmf", classes: ["subcategory"], licence: "US-Gov-Public-Domain" }));
    const current = base([mapped("nist-ai-rmf:GOVERN-1.2", "admin text")]);
    const one = planFrameworkImport({ snapshot: snap, baseline: null, current });
    const two = planFrameworkImport({ snapshot: structuredClone(snap), baseline: null, current: structuredClone(current) });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it("the Federal Register normaliser keeps AI rules only and computes status from the retrieval date", () => {
    const results = [
      { document_number: "2026-1", type: "Rule", title: "Use of Artificial Intelligence", publication_date: "2026-09-01", effective_on: "2026-12-01", html_url: "https://www.federalregister.gov/d/2026-1", agencies: [{ name: "B" }, { name: "A" }] },
      { document_number: "2026-2", type: "Proposed Rule", title: "AI disclosures", publication_date: "2026-08-01", html_url: "https://www.federalregister.gov/d/2026-2" },
      { document_number: "2026-3", type: "Rule", title: "Fishing quotas", abstract: "No AI here at all? AIR quality.", publication_date: "2026-08-01", html_url: "https://www.federalregister.gov/d/2026-3" },
      { document_number: "2026-4", type: "Notice", title: "Artificial intelligence workshop", publication_date: "2026-08-01", html_url: "https://www.federalregister.gov/d/2026-4" },
      { document_number: "2026-5", type: "Rule", title: "Artificial intelligence", publication_date: "2026-08-01", html_url: "https://elsewhere.example/d/2026-5" },
    ];
    const out = normaliseFederalRegister(results, { retrievedOn: "2026-10-30" });
    expect(out.map((e) => [e.key, e.status, e.effectiveDate])).toEqual([
      ["us-fr-2026-1", "upcoming", "2026-12-01"],
      ["us-fr-2026-2", "proposed", "2026-08-01"],
    ]);
    expect(out[0]!.instrument).toBe("Federal Register 2026-1 (A; B)");
    expect(normaliseFederalRegister([...results].reverse(), { retrievedOn: "2026-10-30" })).toEqual(out);
  });

  it("the vendored NIST AI RMF catalog is exactly the checked-in list of 72 subcategories", () => {
    const snap = frameworkImportSnapshotSchema.parse(JSON.parse(readFileSync(path.join(dataDir, "nist-ai-rmf-oscal.json"), "utf8")));
    const refs = snap.controls.map((c) => c.controlRef.replace("nist-ai-rmf:", ""));
    expect([...refs].sort()).toEqual(NIST_AI_RMF_SUBCATEGORIES.map((s) => s.id).sort());
  });

  it("every vendored snapshot validates, is sorted, and has a stable content hash", () => {
    const files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(path.join(dataDir, f), "utf8")) as { schema: string };
      const parsed =
        raw.schema === FRAMEWORK_IMPORT_SCHEMA ? frameworkImportSnapshotSchema.parse(raw) : regulatoryFeedSnapshotSchema.parse(raw);
      expect(raw.schema === FRAMEWORK_IMPORT_SCHEMA || raw.schema === REGULATORY_FEED_IMPORT_SCHEMA).toBe(true);
      expect(importContentSha256(parsed)).toBe(importContentSha256(JSON.parse(JSON.stringify(parsed))));
      expect(f).toBe(`${parsed.source.sourceId}.json`);
    }
  });
});

describe("ADR-0215 licences", () => {
  it("permissive and public-domain text is stored, share-alike is cited by id only, anything else is refused", () => {
    expect(importTextPolicy("Apache-2.0")).toBe("text");
    expect(importTextPolicy("US-Gov-Public-Domain")).toBe("text");
    expect(importTextPolicy("CC-BY-SA-4.0")).toBe("id_only");
    expect(importTextPolicy("CC-BY-NC-4.0")).toBe("id_only");
    expect(importTextPolicy("GPL-3.0-only")).toBe("refused");
    const idOnly = normaliseAtlasRelease(atlas, { framework: "mitre-atlas", licence: "CC-BY-SA-4.0" });
    expect(idOnly).toEqual([
      { controlRef: "mitre-atlas:AML.M0000", title: "AML.M0000", description: null },
      { controlRef: "mitre-atlas:AML.M0001", title: "AML.M0001", description: null },
    ]);
    expect(() => normaliseAtlasRelease(atlas, { framework: "mitre-atlas", licence: "proprietary" })).toThrow(/not allowed/);
    expect(() => snapshotOf([{ controlRef: "nist-ai-rmf:X", title: "x", description: null }], { licence: "SSPL-1.0" })).toThrow();
  });
});

describe("ADR-0215 an import never overwrites an edited control", () => {
  const incoming = snapshotOf([
    { controlRef: "nist-ai-rmf:GOVERN-1.1", title: "GOVERN 1.1 — new text", description: null },
    { controlRef: "nist-ai-rmf:GOVERN-1.2", title: "GOVERN 1.2 — new text", description: null },
    { controlRef: "nist-ai-rmf:GOVERN-1.3", title: "GOVERN 1.3 — brand new", description: null },
    { controlRef: "nist-ai-rmf:GOVERN-1.4", title: "GOVERN 1.4 — same", description: null },
  ]);
  const baseline = [
    { controlRef: "nist-ai-rmf:GOVERN-1.1", title: "GOVERN 1.1 — old text", description: null },
    { controlRef: "nist-ai-rmf:GOVERN-1.2", title: "GOVERN 1.2 — old text", description: null },
  ];
  const current = base([
    // untouched since the last import: may be updated
    mapped("nist-ai-rmf:GOVERN-1.1", "GOVERN 1.1 — old text"),
    // the admin rewrote it after the last import: must be kept
    mapped("nist-ai-rmf:GOVERN-1.2", "Our own wording for GOVERN 1.2"),
    mapped("nist-ai-rmf:GOVERN-1.4", "GOVERN 1.4 — same"),
    // not in the source at all: kept, never deleted
    mapped("nist-ai-rmf:CUSTOM-1", "An org-specific control"),
  ]);

  it("keeps the edited text, updates the unedited, adds the new, keeps the rest", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline, current });
    const kinds = Object.fromEntries(plan.changes.map((c) => [c.controlRef, c.kind]));
    expect(kinds).toEqual({
      "nist-ai-rmf:CUSTOM-1": "not_in_source",
      "nist-ai-rmf:GOVERN-1.1": "text_updated",
      "nist-ai-rmf:GOVERN-1.2": "kept_edited",
      "nist-ai-rmf:GOVERN-1.3": "added",
      "nist-ai-rmf:GOVERN-1.4": "unchanged",
    });
    const byRef = new Map(plan.proposedPack.controls.map((c) => [c.controlRef, c]));
    expect(byRef.get("nist-ai-rmf:GOVERN-1.2")!.title).toBe("Our own wording for GOVERN 1.2");
    expect(byRef.get("nist-ai-rmf:GOVERN-1.1")!.title).toBe("GOVERN 1.1 — new text");
    expect(byRef.get("nist-ai-rmf:CUSTOM-1")!.title).toBe("An org-specific control");
    // the mapping is never touched, even where the text is updated
    for (const ref of ["nist-ai-rmf:GOVERN-1.1", "nist-ai-rmf:GOVERN-1.2"]) {
      expect(byRef.get(ref)).toMatchObject({ coverage: "enforced", collector: "abac_policies_active", minEvidenceCount: 3, ownerNote: "the admin's own note" });
    }
    // a new control starts unmapped
    expect(byRef.get("nist-ai-rmf:GOVERN-1.3")).toMatchObject({ coverage: "unaddressed", collector: "none", attestationRequired: false });
    expect(plan.proposedPack.version).toBe(4);
    expect(plan.proposedPack.title).toBe("NIST AI RMF (mapping)");
    expect(plan.summary).toMatchObject({ added: 1, text_updated: 1, kept_edited: 1, unchanged: 1, not_in_source: 1, edited_replaced: 0 });
    expect(plan.noChange).toBe(false);
  });

  it("with no baseline, every differing existing control counts as edited and is kept", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline: null, current });
    expect(plan.changes.find((c) => c.controlRef === "nist-ai-rmf:GOVERN-1.1")!.kind).toBe("kept_edited");
    expect(plan.proposedPack.controls.find((c) => c.controlRef === "nist-ai-rmf:GOVERN-1.1")!.title).toBe("GOVERN 1.1 — old text");
  });

  it("an edited control is overwritten only when the admin names it, and only that one", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline: null, current, takeIncoming: ["nist-ai-rmf:GOVERN-1.2"] });
    const byRef = new Map(plan.proposedPack.controls.map((c) => [c.controlRef, c]));
    expect(byRef.get("nist-ai-rmf:GOVERN-1.2")!.title).toBe("GOVERN 1.2 — new text");
    expect(byRef.get("nist-ai-rmf:GOVERN-1.1")!.title).toBe("GOVERN 1.1 — old text");
    expect(plan.summary.edited_replaced).toBe(1);
    expect(plan.unknownResolutions).toEqual([]);
  });

  it("naming a control that is not a kept edit is reported, not silently applied", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline, current, takeIncoming: ["nist-ai-rmf:CUSTOM-1", "nist-ai-rmf:GOVERN-1.3"] });
    expect(plan.unknownResolutions).toEqual(["nist-ai-rmf:CUSTOM-1", "nist-ai-rmf:GOVERN-1.3"]);
  });

  it("an import onto no pack creates version 1 with provenance that names the source and its licence", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline: null, current: null });
    expect(plan.proposedPack.version).toBe(1);
    expect(plan.proposedPack.provenance.note).toContain("US-Gov-Public-Domain");
    expect(plan.proposedPack.provenance.note).toContain(plan.contentSha256);
    expect(plan.changes.every((c) => c.kind === "added")).toBe(true);
  });

  it("new source text for an edited control is worth review, the same text again is not", () => {
    const edited = base([mapped("nist-ai-rmf:GOVERN-1.1", "admin wording")]);
    const only = snapshotOf([{ controlRef: "nist-ai-rmf:GOVERN-1.1", title: "GOVERN 1.1 — v2", description: null }]);
    const fresh = planFrameworkImport({ snapshot: only, baseline: [{ controlRef: "nist-ai-rmf:GOVERN-1.1", title: "GOVERN 1.1 — v1", description: null }], current: edited });
    expect(fresh.changes[0]).toMatchObject({ kind: "kept_edited", upstreamChanged: true });
    expect(fresh.noChange).toBe(false);
    const seen = planFrameworkImport({ snapshot: only, baseline: only.controls, current: edited });
    expect(seen.changes[0]).toMatchObject({ kind: "kept_edited", upstreamChanged: false });
    expect(seen.noChange).toBe(true);
  });

  it("re-importing what is already there is no change", () => {
    const plan = planFrameworkImport({ snapshot: incoming, baseline: null, current: null });
    const again = planFrameworkImport({
      snapshot: incoming,
      baseline: incoming.controls,
      current: { ...base(plan.proposedPack.controls), version: plan.proposedPack.version },
    });
    expect(again.noChange).toBe(true);
  });
});

describe("ADR-0215 the imported feed", () => {
  const entry = (key: string, title = key): RegulatoryUpdate => ({
    key,
    jurisdiction: "US",
    instrument: "Federal Register",
    title,
    summary: "s",
    instrumentKind: "law",
    effectiveDate: "2026-01-01",
    status: "in_force",
    frameworks: [],
    controlRefs: [],
    sourceUrl: "https://www.federalregister.gov/d/x",
    verifiedOn: "2026-10-30",
  });

  it("the diff lists added, removed and changed keys, sorted", () => {
    const d = diffFeedEntries([entry("b"), entry("a"), entry("c")], [entry("d"), entry("a", "new title"), entry("b")]);
    expect(d).toEqual({ added: ["d"], removed: ["c"], changed: ["a"], unchanged: 1, noChange: false });
    expect(diffFeedEntries([entry("a")], [entry("a")]).noChange).toBe(true);
  });

  it("a curated entry wins a key collision with an imported one", () => {
    const merged = mergeRegulatoryFeeds([entry("a", "curated")], [[entry("a", "imported"), entry("b")]]);
    expect(merged.map((e) => [e.key, e.title])).toEqual([
      ["a", "curated"],
      ["b", "b"],
    ]);
  });
});
