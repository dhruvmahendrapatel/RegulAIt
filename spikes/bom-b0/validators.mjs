// B0 item 2: compile the CycloneDX 1.7 and 1.6 JSON schemas bundled in @cyclonedx/cyclonedx-library 10.3.0 and the
// vendored official SPDX 3.0.1 JSON schema with the repository's already-pinned ajv 8.20.0 + ajv-formats 3.0.1,
// from local files only. No network: `loadSchema` throws, and the test suite runs this under `unshare -n`.
//
// Formats the schemas use (counted in the files, see R12): CycloneDX 1.7 uses date, date-time, idn-email,
// iri-reference; 1.6 uses date-time, idn-email, iri-reference; jsf-0.82 uses uri; SPDX 3.0.1 uses none.
// ajv-formats provides date, date-time, uri, uri-reference; it provides neither idn-email nor iri-reference.
//   * idn-email  -> a format that REJECTS EVERY VALUE (ADR-0189: a BOM never carries an email address).
//   * iri-reference -> ajv-formats' own `uri-reference` check. This is STRICTER than the schema (an IRI may hold
//     non-ASCII characters; a URI-reference may not), so our emitter must percent-encode. The library's own validator
//     instead accepts EVERY value for iri-reference (`ajv.addFormat('iri-reference', true)`), which is the permissive
//     default ADR-0180 forbids. This choice is an ADR-0189 amendment (R12 §2).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { fullFormats } from 'ajv-formats/dist/formats.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cdxRoot = path.join(path.dirname(require.resolve('@cyclonedx/cyclonedx-library/package.json')), 'res', 'schema');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const refuseRemote = (uri) => {
  throw new Error(`remote schema refused: ${uri}`);
};

export const SCHEMA_FILES = {
  'cyclonedx-1.7': path.join(cdxRoot, 'bom-1.7.SNAPSHOT.schema.json'),
  'cyclonedx-1.6': path.join(cdxRoot, 'bom-1.6.SNAPSHOT.schema.json'),
  'cyclonedx-spdx': path.join(cdxRoot, 'spdx.SNAPSHOT.schema.json'),
  'cyclonedx-jsf': path.join(cdxRoot, 'jsf-0.82.SNAPSHOT.schema.json'),
  'cyclonedx-crypto': path.join(cdxRoot, 'cryptography-defs.SNAPSHOT.schema.json'),
  'spdx-3.0.1': path.join(here, 'schemas', 'spdx-3.0.1-json-schema.json'),
};

const rejectAllEmail = { type: 'string', validate: () => false };

/**
 * @param {{ strict?: boolean|'log', iriReference?: 'uri-reference'|'accept-all' }} [opts]
 */
export function buildCycloneDxAjv(opts = {}) {
  const ajv = new Ajv({
    strict: opts.strict ?? true,
    // CycloneDX 1.6/1.7 use `required` inside `oneOf`/`not` branches for properties declared elsewhere; Ajv's
    // strictRequired treats that as a schema-authoring error. It is valid JSON Schema, so only that check is off.
    strictRequired: opts.strictRequired ?? false,
    allErrors: true,
    useDefaults: false,
    validateFormats: true,
    loadSchema: refuseRemote,
  });
  addFormats(ajv, { mode: 'full' });
  // `meta:enum` is CycloneDX's documentation annotation for enum values (179 uses); declared as a no-op keyword
  ajv.addKeyword({ keyword: 'meta:enum', schemaType: 'object' });
  ajv.addFormat('idn-email', rejectAllEmail);
  ajv.addFormat('iri-reference', opts.iriReference === 'accept-all' ? true : fullFormats['uri-reference']);
  // the three referenced sub-schemas, registered under the ids the bom schemas resolve their relative $refs to
  ajv.addSchema(readJson(SCHEMA_FILES['cyclonedx-spdx']), 'http://cyclonedx.org/schema/spdx.SNAPSHOT.schema.json');
  ajv.addSchema(readJson(SCHEMA_FILES['cyclonedx-jsf']), 'http://cyclonedx.org/schema/jsf-0.82.SNAPSHOT.schema.json');
  ajv.addSchema(readJson(SCHEMA_FILES['cyclonedx-crypto']), 'http://cyclonedx.org/schema/cryptography-defs.SNAPSHOT.schema.json');
  return ajv;
}

export function buildValidators(opts = {}) {
  const cdx = buildCycloneDxAjv(opts);
  const v17 = cdx.compile(readJson(SCHEMA_FILES['cyclonedx-1.7']));
  const v16 = cdx.compile(readJson(SCHEMA_FILES['cyclonedx-1.6']));
  // SPDX 3.0.1's generated schema uses the same pattern (`required: ["@graph"]` inside its top-level `if`)
  const spdxAjv = new Ajv2020({
    strict: opts.strict ?? true,
    strictRequired: opts.strictRequired ?? false,
    allErrors: true,
    loadSchema: refuseRemote,
  });
  addFormats(spdxAjv, { mode: 'full' });
  const spdx = spdxAjv.compile(readJson(SCHEMA_FILES['spdx-3.0.1']));
  const wrap = (fn) => (doc) => (fn(doc) ? { valid: true, errors: [] } : { valid: false, errors: fn.errors ?? [] });
  return { 'cyclonedx-1.7': wrap(v17), 'cyclonedx-1.6': wrap(v16), 'spdx-3.0.1': wrap(spdx) };
}

// ADR-0189 R10: an email shape anywhere in a document, in a key or a string value. Deliberately broad (fail closed):
// a false positive refuses the BOM and names the path; nothing is redacted.
const EMAIL = /[^\s"'<>()[\],;:@]+@[^\s"'<>()[\],;:@]+\.[\p{L}\p{N}-]{2,}/u;
export function findEmails(value, path = '$') {
  const hits = [];
  if (typeof value === 'string') {
    if (EMAIL.test(value)) hits.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findEmails(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (EMAIL.test(k)) hits.push(`${path}{key ${JSON.stringify(k)}}`);
      hits.push(...findEmails(v, `${path}.${k}`));
    }
  }
  return hits;
}
