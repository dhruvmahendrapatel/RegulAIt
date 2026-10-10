/**
 * ADR-0189 slice B3 — OFFLINE validation of AI BOM CycloneDX renderings
 * against the OFFICIAL 1.7 and 1.6 JSON schemas shipped in
 * `@cyclonedx/cyclonedx-library` 10.3.0 (amendment 1: the library is used for
 * its schema files only), compiled with the pinned `ajv` 8.20.0 and
 * `ajv-formats` 3.0.1. Ported from spike B0 `validators.mjs` (R12 §2):
 *
 *  - every schema is read from local files; `loadSchema` refuses any remote
 *    reference, so no runtime download can happen (air-gapped, ADR-0176);
 *  - `idn-email` is a format that REJECTS EVERY VALUE (a BOM never carries an
 *    email; the library's own validator would need the unmaintained
 *    `ajv-formats-draft2019`, which is not admitted);
 *  - `iri-reference` uses ajv-formats' ASCII `uri-reference` check (amendment
 *    2), never the library's accept-all;
 *  - `strict: true` with `strictRequired: false` (the schemas use `required`
 *    inside `oneOf`/`not` branches) and `meta:enum` as an annotation-only
 *    keyword (amendment 3);
 *  - compiled ONCE per process, lazily, because compiling takes 2-3 s.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import type { CycloneDxSpecVersion } from "./ai-bom-cyclonedx.js";

const require = createRequire(import.meta.url);
// ajv-formats is CommonJS with a default export; under NodeNext the namespace may arrive wrapped
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv, opts: { mode: "full" }) => Ajv;
const formats = require("ajv-formats/dist/formats") as { fullFormats: Record<string, unknown> };

const libraryRoot = path.dirname(require.resolve("@cyclonedx/cyclonedx-library/package.json"));
const schemaDir = path.join(libraryRoot, "res", "schema");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const versionOf = (pkg: string) => (readJson(require.resolve(`${pkg}/package.json`)) as { version: string }).version;

export const CYCLONEDX_SCHEMA_FILES = {
  "1.7": path.join(schemaDir, "bom-1.7.SNAPSHOT.schema.json"),
  "1.6": path.join(schemaDir, "bom-1.6.SNAPSHOT.schema.json"),
} as const;

/** the validator identity stored with each rendering (`bom_renderings.validator`) */
export function cycloneDxValidatorId(spec: CycloneDxSpecVersion): string {
  return `ajv ${versionOf("ajv")} ajv-formats ${versionOf("ajv-formats")} cyclonedx-library ${versionOf("@cyclonedx/cyclonedx-library")} bom-${spec}.SNAPSHOT.schema.json`;
}

export interface CycloneDxValidatorOptions {
  /** TEST ONLY (a negative control): the library's permissive accept-all `iri-reference` */
  iriReference?: "uri-reference" | "accept-all";
}

export function buildCycloneDxAjv(opts: CycloneDxValidatorOptions = {}): Ajv {
  const ajv = new Ajv({
    strict: true,
    strictRequired: false,
    allErrors: true,
    useDefaults: false,
    validateFormats: true,
    loadSchema: (uri: string) => {
      throw new Error(`remote schema refused: ${uri}`);
    },
  });
  addFormats(ajv, { mode: "full" });
  ajv.addKeyword({ keyword: "meta:enum", schemaType: "object" });
  ajv.addFormat("idn-email", { type: "string", validate: () => false });
  ajv.addFormat("iri-reference", opts.iriReference === "accept-all" ? true : (formats.fullFormats["uri-reference"] as never));
  ajv.addSchema(readJson(path.join(schemaDir, "spdx.SNAPSHOT.schema.json")), "http://cyclonedx.org/schema/spdx.SNAPSHOT.schema.json");
  ajv.addSchema(readJson(path.join(schemaDir, "jsf-0.82.SNAPSHOT.schema.json")), "http://cyclonedx.org/schema/jsf-0.82.SNAPSHOT.schema.json");
  ajv.addSchema(readJson(path.join(schemaDir, "cryptography-defs.SNAPSHOT.schema.json")), "http://cyclonedx.org/schema/cryptography-defs.SNAPSHOT.schema.json");
  return ajv;
}

let compiled: Record<CycloneDxSpecVersion, ValidateFunction> | null = null;
function validators(): Record<CycloneDxSpecVersion, ValidateFunction> {
  if (!compiled) {
    const ajv = buildCycloneDxAjv();
    compiled = { "1.7": ajv.compile(readJson(CYCLONEDX_SCHEMA_FILES["1.7"])), "1.6": ajv.compile(readJson(CYCLONEDX_SCHEMA_FILES["1.6"])) };
  }
  return compiled;
}

export interface CycloneDxValidation {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export function validateCycloneDx(doc: unknown, spec: CycloneDxSpecVersion): CycloneDxValidation {
  const fn = validators()[spec];
  if (fn(doc)) return { valid: true, errors: [] };
  return { valid: false, errors: (fn.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message ?? e.keyword })) };
}

/** compile both schemas now (boot or a test's beforeAll), so the first snapshot does not pay for it */
export function warmCycloneDxValidators(): void {
  validators();
}
