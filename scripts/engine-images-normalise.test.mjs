// ENG-IMG reproducible builds (ADR-0187 addendum 2026-10-21): what the normaliser makes deterministic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENGINE_IDS, LOCK_SCHEMA, PATHS, renderTs } from "./engine-images-lock.mjs";
import { neutraliseLock, NormaliseError, normaliseCycloneDx, normaliseModulesYaml } from "./engine-images-normalise.mjs";

const nullLock = { schema: LOCK_SCHEMA, engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, { repository: null, manifestDigest: null, imageId: null, publishGeneration: 0, sourceCommit: null, publishedAt: null }])) };

describe("ENG-IMG normaliser: the generated lock module in the build context", () => {
  it("the committed module becomes exactly the all-null module renderTs writes before the first publish", () => {
    expect(neutraliseLock(readFileSync(PATHS.ts, "utf8"))).toBe(renderTs(nullLock));
    expect(neutraliseLock(renderTs(nullLock))).toBe(renderTs(nullLock));
  });

  it("any other shape fails the build (never a silent partial rewrite)", () => {
    const real = readFileSync(PATHS.ts, "utf8");
    expect(() => neutraliseLock(real.replace(/\n {4}publishedAt: [^\n]*/, ""))).toThrow(NormaliseError);
    expect(() => neutraliseLock(real.replace(/publishGeneration: \d+/, "publishGeneration: three"))).toThrow(NormaliseError);
    expect(() => neutraliseLock(`${real}\nconst stray = "${"a".repeat(40)}";\n`)).toThrow(/still present/);
  });
});

describe("ENG-IMG normaliser: pnpm's .modules.yaml", () => {
  const a = { hoistedDependencies: { "zod@4": { zod: "private" }, "jose@6": { jose: "private" } }, prunedAt: "Wed, 21 Oct 2026 16:40:31 GMT", layoutVersion: 5 };
  const b = { layoutVersion: 5, prunedAt: "Thu, 22 Oct 2026 09:00:00 GMT", hoistedDependencies: { "jose@6": { jose: "private" }, "zod@4": { zod: "private" } } };

  it("two installs in different order and at different times write the same file", () => {
    const x = normaliseModulesYaml(JSON.stringify(a), "1700000000");
    expect(normaliseModulesYaml(JSON.stringify(b, null, 2), "1700000000")).toBe(x);
    expect(JSON.parse(x).prunedAt).toBe("Tue, 14 Nov 2023 22:13:20 GMT");
    expect(Object.keys(JSON.parse(x).hoistedDependencies)).toEqual(["jose@6", "zod@4"]);
    expect(normaliseModulesYaml(x, "1700000000")).toBe(x);
  });

  it("without SOURCE_DATE_EPOCH only the order is fixed; a malformed epoch fails", () => {
    expect(JSON.parse(normaliseModulesYaml(JSON.stringify(a), undefined)).prunedAt).toBe(a.prunedAt);
    expect(() => normaliseModulesYaml(JSON.stringify(a), "yesterday")).toThrow(NormaliseError);
  });
});

describe("ENG-IMG normaliser: npm's CycloneDX SBOM", () => {
  const sbom = (serial, ts) => JSON.stringify({ $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json", bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: serial, version: 1, metadata: { timestamp: ts, lifecycles: [{ phase: "build" }] }, components: [{ name: "promptfoo", version: "0.124.1" }] }, null, 2);

  it("a random serial number and the clock no longer change the document; the serial is a v5-layout UUID from the content", () => {
    const x = normaliseCycloneDx(sbom("urn:uuid:95f96759-2270-4bf1-9c3a-896aa08f0a58", "2026-10-21T16:43:50.231Z"), "1700000000");
    expect(normaliseCycloneDx(sbom("urn:uuid:42d374a3-8a71-4f66-941c-4537e34733c6", "2026-10-21T16:43:52.039Z"), "1700000000")).toBe(x);
    const doc = JSON.parse(x);
    expect(doc.metadata.timestamp).toBe("2023-11-14T22:13:20.000Z");
    expect(doc.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(doc)).toEqual(["$schema", "bomFormat", "specVersion", "serialNumber", "version", "metadata", "components"]);
    expect(normaliseCycloneDx(x, "1700000000")).toBe(x);
  });

  it("different content gets a different serial number", () => {
    const x = JSON.parse(normaliseCycloneDx(sbom("s", "t"), "1700000000"));
    const y = JSON.parse(normaliseCycloneDx(sbom("s", "t").replace("0.124.1", "0.124.2"), "1700000000"));
    expect(x.serialNumber).not.toBe(y.serialNumber);
  });
});
