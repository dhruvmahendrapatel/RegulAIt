/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): supplier-declared SPDX
 * properties feed the SPDX 3.0.1 renderer.
 *
 * Every rule has a NEGATIVE CONTROL beside its positive case (M-002, M-033):
 *  - complete declarations render SPDX that passes B5's cardinality check and
 *    the official JSON schema; the same records without them are not_producible;
 *  - partial declarations are not_producible and name EXACTLY the missing
 *    properties, never a placeholder;
 *  - the write-side validators refuse non-https, userinfo, path, query,
 *    fragment, fractional seconds, impossible dates, URLs and `@` in text, and
 *    credential-shaped values (synthetic CANARY values only);
 *  - the normaliser re-checks every loaded value (defence in depth).
 * Fixture: the SYNTHETIC `scripts/spdx3/fixtures/with-datasets-declared.json`,
 * which CI also renders through the built package and validates with SHACL.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AiBomRecordError,
  AiBomSpdxFieldError,
  buildAiBom,
  normaliseAiBomRecords,
  normaliseSpdxDeclaration,
  renderAiBomCycloneDx,
  renderAiBomSpdx,
  spdxMandatoryMissing,
  validateSpdx,
  warmCycloneDxValidators,
  warmSpdxValidator,
  type AiBomRecordSet,
  type AiBomSnapshotMeta,
  type SpdxFieldsRecord,
} from "../index.js";

const FIXTURES = new URL("../../../../scripts/spdx3/fixtures/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as { meta: AiBomSnapshotMeta; records: AiBomRecordSet };
const declared = () => load("with-datasets-declared.json");
const opts = { cyclonedxVersions: ["1.7"] as const };
type Doc = { "@graph": Array<Record<string, any>> };
const spdxOf = (b: ReturnType<typeof buildAiBom>) => {
  const r = b.renderings.find((x) => x.format === "spdx-3.0.1");
  return r ? (JSON.parse(r.bytes) as Doc) : null;
};
const of = (d: Doc, type: string) => d["@graph"].filter((e) => e.type === type);
const fields = (r: AiBomRecordSet) => r.spdxFields as SpdxFieldsRecord[];
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AiBomSpdxFieldError) return e.rule;
    throw e;
  }
  return "accepted";
};

beforeAll(() => {
  warmCycloneDxValidators();
  warmSpdxValidator();
}, 120_000);

describe("B9: complete declarations render SPDX (R51)", () => {
  it("every dataset declared: SPDX renders, passes B5's cardinality check and the official schema", () => {
    const f = declared();
    const b = buildAiBom(f.records, f.meta, opts);
    expect(b.body.renderings["spdx-3.0.1"]).toMatchObject({ status: "rendered" });
    const doc = spdxOf(b)!;
    expect(spdxMandatoryMissing(doc)).toEqual([]);
    expect(validateSpdx(doc).errors).toEqual([]);
    const ds = of(doc, "dataset_DatasetPackage");
    expect(ds).toHaveLength(3);
    for (const d of ds) {
      expect(d.builtTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(d.releaseTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(d.software_downloadLocation).toMatch(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);
      expect(d.originatedBy).toHaveLength(1);
      const org = doc["@graph"].find((e) => e.spdxId === d.originatedBy[0]);
      expect(org?.type).toBe("Organization");
    }
    expect(ds.map((d) => d.dataset_datasetType).sort()).toEqual([["structured", "text"], ["text"], ["text"]]);
  });

  it("negative control: the same records with no declarations are not_producible", () => {
    const f = declared();
    delete f.records.spdxFields;
    const b = buildAiBom(f.records, f.meta, opts);
    expect(b.body.renderings["spdx-3.0.1"]).toEqual({
      status: "not_producible",
      missing: ["dataset_DatasetPackage.builtTime", "dataset_DatasetPackage.originatedBy", "dataset_DatasetPackage.releaseTime", "dataset_DatasetPackage.software_downloadLocation"],
    });
    expect(spdxOf(b)).toBeNull();
  });

  it("the declarations are in the signed native body and its basis (table ai_bom_spdx_declarations)", () => {
    const f = declared();
    const b = buildAiBom(f.records, f.meta, opts);
    const body = JSON.parse(b.bodyBytes) as { records: Record<string, unknown[]> };
    expect(body.records.spdxFields).toHaveLength(3);
    expect(b.basis.filter((x) => x.table === "ai_bom_spdx_declarations")).toHaveLength(3);
    // a changed declaration changes the signed bytes (drift is visible)
    const g = declared();
    fields(g.records)[0]!.builtTime = "2026-03-15T08:00:01Z";
    expect(buildAiBom(g.records, g.meta, opts).bodyBytes).not.toBe(b.bodyBytes);
  });

  it("a dataset with no declared type keeps the standard's noAssertion (R3) and stays producible", () => {
    const f = declared();
    for (const x of fields(f.records)) x.datasetType = [];
    const doc = spdxOf(buildAiBom(f.records, f.meta, opts))!;
    expect(of(doc, "dataset_DatasetPackage").map((d) => d.dataset_datasetType)).toEqual([["noAssertion"], ["noAssertion"], ["noAssertion"]]);
  });
});

describe("B9: partial declarations stay not_producible, naming exactly what is missing", () => {
  for (const [what, edit, missing] of [
    ["one dataset lacks builtTime", (x: SpdxFieldsRecord[]) => (x[0]!.builtTime = null), ["dataset_DatasetPackage.builtTime"]],
    ["one lacks originatedBy, another releaseTime", (x: SpdxFieldsRecord[]) => ((x[0]!.originatedBy = null), (x[1]!.releaseTime = null)), ["dataset_DatasetPackage.originatedBy", "dataset_DatasetPackage.releaseTime"]],
    ["the eval dataset is not declared at all", (x: SpdxFieldsRecord[]) => x.splice(x.findIndex((y) => y.subjectKind === "eval_dataset"), 1), ["dataset_DatasetPackage.builtTime", "dataset_DatasetPackage.originatedBy", "dataset_DatasetPackage.releaseTime", "dataset_DatasetPackage.software_downloadLocation"]],
  ] as const) {
    it(what, () => {
      const f = declared();
      (edit as (x: SpdxFieldsRecord[]) => unknown)(fields(f.records));
      const b = buildAiBom(f.records, f.meta, opts);
      expect(b.body.renderings["spdx-3.0.1"]).toEqual({ status: "not_producible", missing });
      expect(b.renderings.some((r) => r.format === "spdx-3.0.1")).toBe(false);
    });
  }
});

describe("B9: model cards (releaseTime, downloadLocation, packageVersion)", () => {
  const cardId = (f: ReturnType<typeof declared>) => f.records.modelCards[0]!.id;
  const modelPkg = (f: ReturnType<typeof declared>) => {
    const n = normaliseAiBomRecords(f.records);
    const cdx = renderAiBomCycloneDx(n, f.meta, "1.7");
    const doc = renderAiBomSpdx(n, f.meta, cdx).doc as unknown as Doc;
    const components = (cdx.doc as unknown as { components: Array<Record<string, any>> }).components;
    const name = components.find((c) => c["bom-ref"] === `model:${cardId(f)}`)!.name as string;
    return { doc, pkg: of(doc, "ai_AIPackage").find((p) => p.name === name)! };
  };
  const decl = (f: ReturnType<typeof declared>, v: Partial<SpdxFieldsRecord>) =>
    fields(f.records).push({ subjectKind: "model_card", subjectId: cardId(f), releaseTime: null, downloadLocation: null, packageVersion: null, builtTime: null, originatedBy: null, datasetType: [], ...v });

  it("a declared value is used before the card's data_claims value", () => {
    const f = declared();
    decl(f, { releaseTime: "2026-01-02T03:04:05Z", downloadLocation: "https://declared.supplier-a.example" });
    const { pkg } = modelPkg(f);
    expect(pkg.releaseTime).toBe("2026-01-02T03:04:05Z");
    expect(pkg.software_downloadLocation).toBe("https://declared.supplier-a.example");
  });

  it("packageVersion: the pin first; a declared version only when there is no pin", () => {
    const f = declared();
    decl(f, { packageVersion: "declared-1.2.3" });
    expect(modelPkg(f).pkg.software_packageVersion).toBe(f.records.modelCards[0]!.pinnedModelVersion);
    f.records.modelCards[0]!.pinnedModelVersion = null;
    expect(modelPkg(f).pkg.software_packageVersion).toBe("declared-1.2.3");
  });

  it("negative control: no pin, no declaration, no claim -> the model's mandatory properties are named missing", () => {
    const f = declared();
    f.records.modelCards[0] = { ...f.records.modelCards[0]!, pinnedModelVersion: null, dataClaims: { license: "Apache-2.0" } as never };
    const b = buildAiBom(f.records, f.meta, opts);
    expect(b.body.renderings["spdx-3.0.1"]).toEqual({
      status: "not_producible",
      missing: ["ai_AIPackage.releaseTime", "ai_AIPackage.software_downloadLocation", "ai_AIPackage.software_packageVersion"],
    });
    decl(f, { releaseTime: "2026-01-02T03:04:05Z", downloadLocation: "https://declared.supplier-a.example", packageVersion: "v7" });
    expect(buildAiBom(f.records, f.meta, opts).body.renderings["spdx-3.0.1"]).toMatchObject({ status: "rendered" });
  });
});

describe("B9: the write-side validators (R51), each refusal named", () => {
  it("times: whole seconds, Z or an offset, normalised to UTC xsd:dateTime", () => {
    expect(normaliseSpdxDeclaration("training_dataset", "builtTime", "2026-03-15T08:00:00Z")).toBe("2026-03-15T08:00:00Z");
    expect(normaliseSpdxDeclaration("training_dataset", "builtTime", "2026-03-15T10:30:00+02:30")).toBe("2026-03-15T08:00:00Z");
    for (const bad of ["2026-03-15T08:00:00.5Z", "2026-03-15", "2026-02-30T00:00:00Z", "2026-03-15T08:00:00", "yesterday", 1_700_000_000, null]) {
      expect(refusal(() => normaliseSpdxDeclaration("model_card", "releaseTime", bad)), String(bad)).toBe("spdx_time_invalid");
    }
  });

  it("download locations: an https origin only; refused, never cut down", () => {
    expect(normaliseSpdxDeclaration("eval_dataset", "downloadLocation", "https://evals.supplier-c.example:8443")).toBe("https://evals.supplier-c.example:8443");
    const cases: Array<[string, string]> = [
      ["http://models.supplier.example", "download_location_not_https"],
      ["ftp://models.supplier.example", "download_location_not_https"],
      ["https://user:CANARY_PASS@models.supplier.example", "download_location_credentials"],
      ["https://models.supplier.example/", "download_location_not_origin"],
      ["https://models.supplier.example/bot123:sk-live-CANARY0123456789abcdefABCD/w", "download_location_not_origin"],
      ["https://models.supplier.example?token=CANARY_QS", "download_location_not_origin"],
      ["https://models.supplier.example#CANARY_FRAG", "download_location_not_origin"],
      ["https://xn--mdels-wua.example", "accepted"],
      ["https://models.example.é", "download_location_not_origin"],
      ["models.supplier.example", "download_location_invalid"],
      [`https://${"a".repeat(2100)}.example`, "download_location_invalid"],
    ];
    for (const [v, rule] of cases) expect(refusal(() => normaliseSpdxDeclaration("model_card", "downloadLocation", v)), v.slice(0, 60)).toBe(rule);
  });

  it("text: no URL, no @, no control character, no credential shape, bounded", () => {
    expect(normaliseSpdxDeclaration("model_card", "packageVersion", "2026-06-01.rc1+build.7")).toBe("2026-06-01.rc1+build.7");
    expect(normaliseSpdxDeclaration("training_dataset", "originatedBy", "Synthetic Data Supplier B")).toBe("Synthetic Data Supplier B");
    const cases: Array<[string, string, unknown, string]> = [
      ["model_card", "packageVersion", "1.0 beta", "package_version_invalid"],
      ["model_card", "packageVersion", "pkg@1.0", "package_version_invalid"],
      ["model_card", "packageVersion", "https://x.example/v1", "package_version_invalid"],
      ["model_card", "packageVersion", "sk-live-CANARY0123456789abcdefABCD", "credential_shaped"],
      ["model_card", "packageVersion", "", "package_version_invalid"],
      ["training_dataset", "originatedBy", "ops@supplier.example", "originated_by_invalid"],
      ["training_dataset", "originatedBy", "see https://supplier.example", "originated_by_invalid"],
      ["training_dataset", "originatedBy", "Supplier\nB", "originated_by_invalid"],
      ["training_dataset", "originatedBy", " Supplier B", "originated_by_invalid"],
      ["training_dataset", "originatedBy", "x".repeat(257), "originated_by_invalid"],
      ["training_dataset", "originatedBy", "ghp_CANARY0123456789abcdefghijklmnopqrstuv", "credential_shaped"],
    ];
    for (const [kind, p, v, rule] of cases) expect(refusal(() => normaliseSpdxDeclaration(kind as never, p, v)), `${p} ${String(v).slice(0, 40)}`).toBe(rule);
  });

  it("dataset types: a non-empty set of SPDX DatasetType values, sorted", () => {
    expect(normaliseSpdxDeclaration("eval_dataset", "datasetType", ["text", "image"])).toEqual(["image", "text"]);
    for (const bad of [[], ["text", "text"], ["Text"], ["tabular"], "text", [1]]) {
      expect(refusal(() => normaliseSpdxDeclaration("eval_dataset", "datasetType", bad)), JSON.stringify(bad)).toBe("dataset_type_invalid");
    }
  });

  it("a property the parent kind does not declare is refused", () => {
    expect(refusal(() => normaliseSpdxDeclaration("model_card", "builtTime", "2026-03-15T08:00:00Z"))).toBe("spdx_property_not_allowed");
    expect(refusal(() => normaliseSpdxDeclaration("training_dataset", "packageVersion", "1"))).toBe("spdx_property_not_allowed");
    expect(refusal(() => normaliseSpdxDeclaration("model_card", "suppliedBy", "x"))).toBe("spdx_property_not_allowed");
  });
});

describe("B9: the normaliser re-checks every loaded value (defence in depth)", () => {
  for (const [what, edit] of [
    ["a path-bearing download location", (x: SpdxFieldsRecord) => (x.downloadLocation = "https://datasets.supplier-b.example/a?token=CANARY_QS")],
    ["a fractional-second time", (x: SpdxFieldsRecord) => (x.builtTime = "2026-03-15T08:00:00.123Z")],
    ["an email-shaped originator", (x: SpdxFieldsRecord) => (x.originatedBy = "ops@supplier.example")],
    ["a model-only property on a dataset", (x: SpdxFieldsRecord) => (x.packageVersion = "1.0")],
    ["an unknown subject kind", (x: SpdxFieldsRecord) => ((x as { subjectKind: string }).subjectKind = "agent")],
  ] as const) {
    it(`refuses ${what}`, () => {
      const f = declared();
      (edit as (x: SpdxFieldsRecord) => unknown)(fields(f.records)[0]!);
      expect(() => normaliseAiBomRecords(f.records)).toThrow(AiBomRecordError);
    });
  }
  it("refuses an unknown key and the same subject loaded twice", () => {
    const f = declared();
    (fields(f.records)[0] as unknown as Record<string, unknown>).declaredBy = "00000000-0000-4000-8000-0000000000aa";
    expect(() => normaliseAiBomRecords(f.records)).toThrow(/unknown key/);
    const g = declared();
    fields(g.records).push({ ...fields(g.records)[0]! });
    expect(() => normaliseAiBomRecords(g.records)).toThrow(/loaded twice/);
  });
});
