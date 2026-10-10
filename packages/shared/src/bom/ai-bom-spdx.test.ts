/**
 * ADR-0189 slice B5: the SPDX 3.0.1 renderer and its offline validator.
 *
 * Every rule has a NEGATIVE CONTROL beside its positive case (M-002, M-033).
 * The fixtures are the SYNTHETIC record sets in `scripts/spdx3/fixtures/`, the
 * same ones CI renders through the built package and validates with the
 * official SHACL model (`scripts/spdx3/run_offline.py`); the triple counts CI
 * enforces are in `scripts/spdx3/expected-triples.json`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AiBomRecordError,
  SPDX_MANDATORY,
  SPDX_NO_ASSERTION_LICENSE,
  SPDX_SCHEMA_FILE,
  SPDX_SCHEMA_SHA256,
  aiBomNativeBodySchema,
  buildAiBom,
  isSpdxDateTime,
  isSpdxDownloadLocation,
  isSpdxLicenceId,
  normaliseAiBomRecords,
  readPinnedSpdxSchema,
  renderAiBomCycloneDx,
  renderAiBomSpdx,
  spdxCreatedTime,
  spdxMandatoryMissing,
  validateSpdx,
  warmCycloneDxValidators,
  warmSpdxValidator,
  type AiBomRecordSet,
  type AiBomSnapshotMeta,
} from "../index.js";

const FIXTURES = new URL("../../../../scripts/spdx3/fixtures/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as { meta: AiBomSnapshotMeta; records: AiBomRecordSet };
const producible = () => load("producible.json");
const withDatasets = () => load("with-datasets.json");
const opts = { cyclonedxVersions: ["1.7", "1.6"] as const };
type Doc = { "@graph": Array<Record<string, any>> };
const spdxOf = (b: ReturnType<typeof buildAiBom>) => {
  const r = b.renderings.find((x) => x.format === "spdx-3.0.1");
  return r ? (JSON.parse(r.bytes) as Doc) : null;
};
const draftOf = (f: { meta: AiBomSnapshotMeta; records: AiBomRecordSet }) => {
  const n = normaliseAiBomRecords(f.records);
  return renderAiBomSpdx(n, f.meta, renderAiBomCycloneDx(n, f.meta, "1.7")).doc as unknown as Doc;
};
const of = (d: Doc, type: string) => d["@graph"].filter((e) => e.type === type);
const byName = (d: Doc, name: string) => d["@graph"].find((e) => e.name === name)!;
const rels = (d: Doc, from: string, type: string) => of(d, "Relationship").filter((r) => r.from === from && r.relationshipType === type);
const withCard = (f: ReturnType<typeof producible>, i: number, claims: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const records = structuredClone(f.records);
  records.modelCards[i] = { ...records.modelCards[i]!, ...extra, dataClaims: { ...records.modelCards[i]!.dataClaims, ...claims } as never };
  return records;
};

/** B9 (R51): patch the declared SPDX properties of model card `i` (the only source of releaseTime and downloadLocation) */
const withDecl = (f: ReturnType<typeof producible>, i: number, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const records = structuredClone(f.records);
  const id = records.modelCards[i]!.id;
  records.modelCards[i] = { ...records.modelCards[i]!, ...extra };
  records.spdxFields = (records.spdxFields ?? []).map((x) => (x.subjectKind === "model_card" && x.subjectId === id ? ({ ...x, ...patch } as typeof x) : x));
  return records;
};

// a seeded shuffle of every list and every object's key order (no Math.random: reproducible)
function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function reorder(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return shuffle(v.map((x, i) => reorder(x, seed + i)), seed);
  if (v && typeof v === "object") return Object.fromEntries(shuffle(Object.entries(v).map(([k, x], i) => [k, reorder(x, seed + i)] as const), seed));
  return v;
}

beforeAll(() => {
  warmCycloneDxValidators();
  warmSpdxValidator();
}, 120_000);

describe("B5: exact bytes (amendment 5, §5)", () => {
  it("the SPDX rendering and the native body are byte-identical across input row and key orders", () => {
    const f = producible();
    const a = buildAiBom(f.records, f.meta, opts);
    expect(spdxOf(a)).not.toBeNull();
    for (const seed of [1, 7, 42, 1001]) {
      const b = buildAiBom(reorder(f.records, seed) as AiBomRecordSet, f.meta, opts);
      expect(b.renderings.find((r) => r.format === "spdx-3.0.1")!.bytes).toBe(a.renderings.find((r) => r.format === "spdx-3.0.1")!.bytes);
      expect(b.bodyBytes).toBe(a.bodyBytes);
    }
  });

  it("negative control: a changed fact changes the bytes", () => {
    const f = producible();
    const a = buildAiBom(f.records, f.meta, opts).renderings.find((r) => r.format === "spdx-3.0.1")!.bytes;
    const b = buildAiBom(withCard(f, 0, {}, { pinnedModelVersion: "2026-06-02" }), f.meta, opts).renderings.find((r) => r.format === "spdx-3.0.1")!.bytes;
    expect(b).not.toBe(a);
  });

  it("SPDX created is whole seconds; the native body keeps the full time", () => {
    const f = producible();
    const b = buildAiBom(f.records, f.meta, opts);
    expect(spdxOf(b)!["@graph"][0]).toMatchObject({ type: "CreationInfo", created: "2026-10-10T12:00:00Z", specVersion: "3.0.1" });
    expect(b.body.snapshot.createdAt).toBe("2026-10-10T12:00:00.123Z");
    expect(() => spdxCreatedTime("2026-10-10T12:00:00Z")).toThrow(/milliseconds/);
  });

  it("the signed body records the SPDX rendering's sha256, length and validator (R7)", () => {
    const f = producible();
    const b = buildAiBom(f.records, f.meta, opts);
    const r = b.renderings.find((x) => x.format === "spdx-3.0.1")!;
    expect(b.body.renderings["spdx-3.0.1"]).toEqual({ status: "rendered", sha256: createHash("sha256").update(r.bytes).digest("hex"), bytes: Buffer.byteLength(r.bytes), validator: r.validator });
    expect(r.validator).toContain(`sha256:${SPDX_SCHEMA_SHA256}`);
    expect(aiBomNativeBodySchema.safeParse(JSON.parse(b.bodyBytes)).success).toBe(true);
  });
});

describe("B5: schema validation (offline, vendored, pinned)", () => {
  it("every subject kind renders an SPDX document that passes the official 3.0.1 JSON schema (R31)", () => {
    const f = producible();
    const subjects = { use_case: f.records.subject.id, agent: f.records.agents[0]!.id, builder_agent: f.records.builderAgents[0]!.id, install: AI_BOM_INSTALL_SUBJECT_ID } as const;
    for (const [kind, id] of Object.entries(subjects)) {
      const b = buildAiBom({ ...f.records, subject: { kind: kind as never, id } }, { ...f.meta, subjectKind: kind as never, subjectId: id }, opts);
      const doc = spdxOf(b);
      expect(doc, kind).not.toBeNull();
      expect(validateSpdx(doc).errors, kind).toEqual([]);
      const document = of(doc!, "SpdxDocument")[0]!;
      expect(document.rootElement).toHaveLength(1);
      // every element is listed in the document, and every listed id exists
      const ids = doc!["@graph"].filter((e) => e.spdxId && e.type !== "SpdxDocument").map((e) => e.spdxId).sort();
      expect([...document.element].sort()).toEqual(ids);
    }
  });

  it("negative control: the schema rejects a broken document (unknown relationship type, missing creationInfo)", () => {
    const doc = spdxOf(buildAiBom(producible().records, producible().meta, opts))!;
    const bad = structuredClone(doc);
    of(bad, "Relationship")[0]!.relationshipType = "wasMadeFrom";
    expect(validateSpdx(bad).valid).toBe(false);
    const bad2 = structuredClone(doc);
    delete of(bad2, "ai_AIPackage")[0]!.creationInfo;
    expect(validateSpdx(bad2).valid).toBe(false);
  });

  it("R12 §5: the suppliedBy→Tool negative control PASSES the JSON schema, so the CI SHACL step is not optional", () => {
    const doc = spdxOf(buildAiBom(producible().records, producible().meta, opts))!;
    const tool = of(doc, "Tool")[0]!.spdxId;
    of(doc, "ai_AIPackage")[0]!.suppliedBy = tool;
    expect(validateSpdx(doc).valid).toBe(true);
  });

  it("the vendored schema is refused unless its bytes are the pinned ones (fail closed)", () => {
    expect(createHash("sha256").update(readFileSync(SPDX_SCHEMA_FILE)).digest("hex")).toBe(SPDX_SCHEMA_SHA256);
    expect(() => readPinnedSpdxSchema(SPDX_SCHEMA_FILE, "0".repeat(64))).toThrow(/not the pinned/);
    const dir = mkdtempSync(path.join(tmpdir(), "spdx-pin-"));
    const forged = path.join(dir, "schema.json");
    writeFileSync(forged, `${readFileSync(SPDX_SCHEMA_FILE, "utf8")} `); // one appended byte
    expect(() => readPinnedSpdxSchema(forged)).toThrow(/not the pinned/);
  });
});

describe("B5: R3 mandatory properties, never invented", () => {
  it("the producible fixture has every mandatory AIPackage property", () => {
    const doc = spdxOf(buildAiBom(producible().records, producible().meta, opts))!;
    expect(spdxMandatoryMissing(doc)).toEqual([]);
    for (const p of of(doc, "ai_AIPackage")) for (const k of SPDX_MANDATORY.ai_AIPackage!) expect(p[k], k).toBeTruthy();
  });

  it("spdxMandatoryMissing reads the document, independent of the renderer: removing any one property names it", () => {
    const doc = spdxOf(buildAiBom(producible().records, producible().meta, opts))!;
    for (const k of SPDX_MANDATORY.ai_AIPackage!) {
      const d = structuredClone(doc);
      delete of(d, "ai_AIPackage")[0]![k];
      expect(spdxMandatoryMissing(d)).toEqual([`ai_AIPackage.${k}`]);
    }
    expect(spdxMandatoryMissing({})).toEqual(["SpdxDocument.@graph"]);
  });

  // B9 (R51): the declarations are the only source; a missing one is not_producible
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string[]]> = [
    ["no declared releaseTime", { releaseTime: null }, {}, ["ai_AIPackage.releaseTime"]],
    ["no declared downloadLocation", { downloadLocation: null }, {}, ["ai_AIPackage.software_downloadLocation"]],
    ["no pinned version (agents have no version column)", {}, { pinnedModelVersion: null }, ["ai_AIPackage.software_packageVersion"]],
  ];
  for (const [what, patch, extra, missing] of cases) {
    it(`not_producible: ${what}`, () => {
      const f = producible();
      const records = withDecl(f, 1, patch, extra);
      const b = buildAiBom(records, f.meta, opts);
      expect(b.renderings.map((r) => r.format)).toEqual(["cyclonedx-1.7", "cyclonedx-1.6"]);
      expect(b.body.renderings["spdx-3.0.1"]).toEqual({ status: "not_producible", missing });
      // the CycloneDX renderings are unaffected (R3)
      expect(b.body.renderings["cyclonedx-1.7"]).toMatchObject({ status: "rendered" });
      expect(aiBomNativeBodySchema.safeParse(JSON.parse(b.bodyBytes)).success).toBe(true);
    });
  }

  // B9 (R51): a malformed declared value is refused outright (never padded, truncated or cut down), and the
  // refusal names the field and rule, never the value
  for (const [what, patch] of [
    ["a date, not a DateTime (never padded to midnight)", { releaseTime: "2026-06-01" }],
    ["fractional seconds (never truncated)", { releaseTime: "2026-06-01T00:00:00.5Z" }],
    ["an impossible date", { releaseTime: "2026-02-30T00:00:00Z" }],
    ["plain http", { downloadLocation: "http://models.provider-a.example" }],
  ] as const) {
    it(`refused: ${what}`, () => {
      const f = producible();
      expect(() => buildAiBom(withDecl(f, 1, patch), f.meta, opts)).toThrow(AiBomRecordError);
    });
  }

  it("R51: a card's data_claims can no longer supply releaseTime or downloadLocation (retired keys are refused)", () => {
    const f = producible();
    for (const k of ["releaseTime", "downloadLocation"]) {
      expect(() => buildAiBom(withCard(f, 0, { [k]: k === "releaseTime" ? "2026-06-01T00:00:00Z" : "https://models.provider-a.example" }), f.meta, opts), k).toThrow(/retired as an SPDX source/);
    }
  });

  it("an agent with no model card: its unknown model makes the rendering not_producible", () => {
    const f = producible();
    const records = structuredClone(f.records);
    records.modelCards = [];
    records.modelCardEvidence = [];
    const b = buildAiBom(records, f.meta, opts);
    expect(b.body.renderings["spdx-3.0.1"]).toEqual({
      status: "not_producible",
      missing: ["ai_AIPackage.releaseTime", "ai_AIPackage.software_downloadLocation", "ai_AIPackage.software_packageVersion"],
    });
  });

  it("the literal checks", () => {
    expect(isSpdxDateTime("2026-06-01T00:00:00Z")).toBe(true);
    for (const v of ["2026-06-01", "2026-06-01T00:00:00+00:00", "2026-13-01T00:00:00Z", " 2026-06-01T00:00:00Z", 1, null]) expect(isSpdxDateTime(v), String(v)).toBe(false);
    expect(isSpdxDownloadLocation("https://hub.example")).toBe(true);
    expect(isSpdxDownloadLocation("https://hub.example:8443")).toBe(true);
    for (const v of ["https://hub.example/", "https://hub.example/x", "https://hub.example?token=x", "https://u:p@hub.example", "https://hub.example#f", "ftp://hub.example"]) expect(isSpdxDownloadLocation(v), v).toBe(false);
  });
});

describe("B5: datasets (entry condition 4237371312; R11, R24, R26)", () => {
  it("a snapshot with datasets is not_producible, naming exactly the dataset properties no table records", () => {
    const f = withDatasets();
    const b = buildAiBom(f.records, f.meta, opts);
    expect(b.body.renderings["spdx-3.0.1"]).toEqual({
      status: "not_producible",
      missing: ["dataset_DatasetPackage.builtTime", "dataset_DatasetPackage.originatedBy", "dataset_DatasetPackage.releaseTime", "dataset_DatasetPackage.software_downloadLocation"],
    });
    expect(spdxOf(b)).toBeNull();
  });

  it("originatedBy has no no-assertion form: NoAssertionElement fails the official schema, so it is never used as a placeholder", () => {
    const d = draftOf(withDatasets());
    expect(validateSpdx(d).errors).toEqual([]);
    for (const e of of(d, "dataset_DatasetPackage")) e.originatedBy = ["NoAssertionElement"];
    expect(validateSpdx(d).valid).toBe(false);
  });

  it("datasets with and without classification: the draft maps what is recorded and B3 marks the gaps incomplete", () => {
    const f = withDatasets();
    const d = draftOf(f);
    const classified = byName(d, "claims-ft");
    const unclassified = byName(d, "claims-unclassified");
    const evalSet = byName(d, "triage-golden");
    expect(classified).toMatchObject({ type: "dataset_DatasetPackage", software_primaryPurpose: "data", dataset_datasetType: ["noAssertion"], dataset_confidentialityLevel: "red", dataset_hasSensitivePersonalInformation: "yes" });
    expect(classified.verifiedUsing).toEqual([{ type: "Hash", algorithm: "sha256", hashValue: "d".repeat(64) }]);
    // R24: no project, no classification; R11: clean is not proof of absence; R26: an empty checksum is no hash
    expect(unclassified.dataset_confidentialityLevel).toBeUndefined();
    expect(unclassified.dataset_hasSensitivePersonalInformation).toBe("noAssertion");
    expect(unclassified.verifiedUsing).toBeUndefined();
    // R24: an evaluation dataset maps only what is recorded
    expect(evalSet).toMatchObject({ dataset_hasSensitivePersonalInformation: "noAssertion", verifiedUsing: [{ type: "Hash", algorithm: "sha256", hashValue: "e".repeat(64) }] });
    expect(evalSet.dataset_confidentialityLevel).toBeUndefined();
    for (const e of [classified, unclassified, evalSet]) for (const k of ["builtTime", "originatedBy", "releaseTime", "software_downloadLocation"]) expect(e[k], k).toBeUndefined();
    const gaps = buildAiBom(f.records, f.meta, opts).gaps;
    expect(gaps).toContainEqual(expect.objectContaining({ ref: expect.stringContaining("dataset:training:00000000-0000-4000-8000-000000000022:3"), field: "classification" }));
    expect(gaps).toContainEqual(expect.objectContaining({ ref: expect.stringContaining("dataset:training:00000000-0000-4000-8000-000000000022:3"), field: "hash" }));
  });

  it("models link to their datasets with trainedOn / testedOn; a model with no known training data says noAssertion", () => {
    const d = draftOf(withDatasets());
    const card1 = of(d, "ai_AIPackage").find((p) => p.ai_informationAboutApplication === "Claims triage summaries")!;
    const card2 = of(d, "ai_AIPackage").find((p) => p.ai_informationAboutApplication === "Fraud hints")!;
    expect(rels(d, card1.spdxId, "trainedOn")[0]!.to).toEqual([byName(d, "claims-ft").spdxId]);
    expect(rels(d, card1.spdxId, "testedOn")[0]!.to).toEqual([byName(d, "triage-golden").spdxId]);
    expect(rels(d, card2.spdxId, "trainedOn")[0]).toMatchObject({ to: ["NoAssertionElement"], completeness: "noAssertion" });
    expect(card1.ai_informationAboutTraining).toBe("supplier-declared: public web corpus (supplier statement)");
    expect(card2.ai_informationAboutTraining).toBe("unknown");
  });
});

describe("B5: licence relationships (§3)", () => {
  const doc = () => spdxOf(buildAiBom(producible().records, producible().meta, opts))!;

  it("every package and file has exactly one declared and one concluded licence; concluded is always NoAssertion", () => {
    const d = doc();
    const artifacts = d["@graph"].filter((e) => ["software_Package", "software_File", "ai_AIPackage", "dataset_DatasetPackage"].includes(e.type));
    expect(artifacts.length).toBeGreaterThan(8);
    for (const a of artifacts) {
      expect(rels(d, a.spdxId, "hasDeclaredLicense"), a.name).toHaveLength(1);
      const concluded = rels(d, a.spdxId, "hasConcludedLicense");
      expect(concluded, a.name).toHaveLength(1);
      expect(concluded[0]!.to).toEqual([SPDX_NO_ASSERTION_LICENSE]);
    }
  });

  it("a supplier-declared SPDX id becomes a licence expression; a prose name stays NoAssertion; the engine's catalogue licence maps", () => {
    const d = doc();
    const declaredOf = (e: Record<string, any>) => d["@graph"].find((x) => x.spdxId === rels(d, e.spdxId, "hasDeclaredLicense")[0]!.to[0]) ?? rels(d, e.spdxId, "hasDeclaredLicense")[0]!.to[0];
    const card1 = of(d, "ai_AIPackage").find((p) => p.ai_informationAboutApplication === "Claims triage summaries")!;
    const card2 = of(d, "ai_AIPackage").find((p) => p.ai_informationAboutApplication === "Fraud hints")!;
    expect(declaredOf(card1)).toMatchObject({ type: "simplelicensing_LicenseExpression", simplelicensing_licenseExpression: "Apache-2.0" });
    expect(declaredOf(card2)).toBe(SPDX_NO_ASSERTION_LICENSE); // "proprietary" is not an SPDX id
    expect(declaredOf(byName(d, "modelscan"))).toMatchObject({ simplelicensing_licenseExpression: "Apache-2.0" });
    expect(of(d, "simplelicensing_LicenseExpression")).toHaveLength(1); // one element per distinct id
  });

  it("negative controls: an exception id, a compound expression and a case variant are never treated as a licence id", () => {
    expect(isSpdxLicenceId("Apache-2.0")).toBe(true);
    expect(isSpdxLicenceId("MIT")).toBe(true);
    for (const v of ["LLVM-exception", "Classpath-exception-2.0", "MIT OR Apache-2.0", "apache-2.0", "Apache-2.0 ", "unknown", null]) expect(isSpdxLicenceId(v), String(v)).toBe(false);
    const f = producible();
    const d = spdxOf(buildAiBom(withCard(f, 0, { license: "MIT OR Apache-2.0" }), f.meta, opts))!;
    expect(of(d, "simplelicensing_LicenseExpression").map((e) => e.simplelicensing_licenseExpression)).toEqual(["Apache-2.0"]); // the engine's only
  });
});

describe("B5: same elements and hashes as CycloneDX", () => {
  it("every CycloneDX component hash is listed in SPDX verifiedUsing, and SPDX lists no other", () => {
    for (const f of [producible(), withDatasets()]) {
      const b = buildAiBom(f.records, f.meta, opts);
      const cdx = JSON.parse(b.renderings[0]!.bytes) as { components: Array<{ hashes?: Array<{ content: string }> }> };
      const cdxHashes = cdx.components.flatMap((c) => (c.hashes ?? []).map((h) => h.content)).sort();
      const d = draftOf(f);
      const spdxHashes = d["@graph"].flatMap((e) => ((e.verifiedUsing ?? []) as Array<{ hashValue: string }>).map((h) => h.hashValue)).sort();
      expect(cdxHashes.length).toBeGreaterThan(4);
      expect(spdxHashes).toEqual(cdxHashes);
    }
  });

  it("one ai_AIPackage per model card (#280 4237488595), with the card's pinned version (#280 round 12)", () => {
    const d = spdxOf(buildAiBom(producible().records, producible().meta, opts))!;
    expect(of(d, "ai_AIPackage").map((p) => p.software_packageVersion).sort()).toEqual(["2026-05-01", "2026-06-01"]);
  });

  it("provider names reach IRIs only as a digest; IRIs carry no record names", () => {
    const f = producible();
    const records = structuredClone(f.records);
    records.agents[0]!.provider = "Provider Ä #1/../x";
    const d = spdxOf(buildAiBom(records, f.meta, opts))!;
    const iris = d["@graph"].flatMap((e) => [e.spdxId, e.from, ...(Array.isArray(e.to) ? e.to : [])]).filter((x): x is string => typeof x === "string");
    for (const i of iris) {
      expect(i, i).not.toContain("Provider");
      expect(i, i).not.toContain("triage");
      expect(i, i).not.toContain("modelscan");
    }
    const supplier = of(d, "Organization").find((o) => o.name === "Provider Ä #1/../x")!;
    expect(supplier.spdxId).toMatch(/#supplier-[0-9a-f]{32}$/);
  });
});

describe("B5: no leakage of endpoints, paths or secrets (canaries)", () => {
  const CANARIES = ["CANARY_QUERY", "CANARY_FRAG", "CANARY_PATH", "CANARY_MCP", "CANARY_EXTSIG", "CANARY_PRESIGN", "sk-live-CANARY", "CANARY_CONN"];
  function seeded(): { meta: AiBomSnapshotMeta; records: AiBomRecordSet } {
    const f = producible();
    const r = structuredClone(f.records);
    const CP = "00000000-0000-4000-8000-000000000006";
    r.customProviders = [{ id: CP, name: "in-house", wireProtocol: "openai_chat", baseUrl: "https://models.internal.example:8443/v1/sk-live-CANARY/CANARY_PATH?token=CANARY_QUERY#CANARY_FRAG", keySet: true }];
    r.agents[0]!.customProviderId = CP;
    r.mcpServers[0]!.url = "https://mcp.example/bot123456:sk-live-CANARY/api?key=CANARY_MCP";
    r.connectors[0]!.url = "https://crm.example/api?api_key=CANARY_CONN";
    r.modelCardEvidence[0]!.externalRef = "https://audits.example/report?token=CANARY_EXTSIG";
    return { meta: f.meta, records: r };
  }

  it("no canary reaches the SPDX rendering", () => {
    const f = seeded();
    const b = buildAiBom(f.records, f.meta, opts);
    const spdx = b.renderings.find((r) => r.format === "spdx-3.0.1")!.bytes;
    for (const c of CANARIES) expect(spdx.includes(c), c).toBe(false);
  });

  it("a presigned or token-bearing downloadLocation is refused, never cut down to its origin (R51), and the refusal leaks nothing", () => {
    const f = producible();
    for (const loc of [
      "https://bucket.example/m.bin?X-Amz-Signature=CANARY_PRESIGN",
      "https://hub.example/sk-live-CANARY/model",
      "https://hub.example:8443?token=CANARY_QUERY#CANARY_FRAG",
    ]) {
      let message = "";
      try {
        buildAiBom(withDecl(f, 0, { downloadLocation: loc }), f.meta, opts);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, loc).toMatch(/downloadLocation: download_location_not_origin/);
      for (const c of CANARIES) expect(message.includes(c), `${loc}: ${c}`).toBe(false);
    }
  });

  it("defence in depth: the renderer itself never exports a path-bearing location, even if a record bypassed normalisation", () => {
    const f = producible();
    const n = normaliseAiBomRecords(f.records);
    const decl = n.spdxFields!.find((x) => x.subjectKind === "model_card" && x.subjectId === n.modelCards[0]!.id)!;
    decl.downloadLocation = "https://hub.example/sk-live-CANARY/model";
    const d = renderAiBomSpdx(n, f.meta, renderAiBomCycloneDx(n, f.meta, "1.7")).doc;
    expect(JSON.stringify(d).includes("sk-live-CANARY")).toBe(false);
    expect(spdxMandatoryMissing(d)).toEqual(["ai_AIPackage.software_downloadLocation"]);
  });

  it("negative control for the canary scan: the seeded records really carry every endpoint canary", () => {
    const raw = JSON.stringify(seeded().records);
    for (const c of ["CANARY_QUERY", "CANARY_FRAG", "CANARY_PATH", "CANARY_MCP", "CANARY_EXTSIG", "sk-live-CANARY", "CANARY_CONN"]) expect(raw.includes(c), c).toBe(true);
  });

  it("an email in a model card field refuses the build (R10)", () => {
    const f = producible();
    expect(() => buildAiBom(withCard(f, 0, {}, { limitations: "contact owner@example.com" }), f.meta, opts)).toThrow(/email/);
  });
});
