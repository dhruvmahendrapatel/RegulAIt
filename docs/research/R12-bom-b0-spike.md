# R12: ADR-0189 Decision BOM and AI BOM, spike B0

Checked 2026-10-10 UTC against ADR-0189 (accepted by the owner on 2026-10-10), slice B0. The code that reproduces these
results is in [`spikes/bom-b0`](../../spikes/bom-b0/README.md). The spike changes no gateway, shared, database,
workspace or CI source. It imports one function, `canonicalJson`, read-only from `packages/shared/src/audit-chain.ts`.

## Decision

**GO on decision 3's ADR-0176 §4 exception, with the amendments in §9.** The one maintained CycloneDX library cannot
represent or emit the ML-BOM fields. Its bundled official schemas, together with our pinned Ajv, validate our own
emitter offline. RFC 8785 bytes from `canonicalize` are byte-identical to `canonicalJson` on every BOM shape. A
sample AI BOM gives identical bytes and an identical signature in every one of these conditions:

- twice in one process;
- from a second replica's row order and key order;
- in fresh processes on Node 20, 21 and 22.

SPDX 3.0.1 is GO for B5. One condition applies: `spdx3-validate` as shipped is **not** air-gapped and must run through
the offline driver (§5).

| # | B0 item (ADR-0189 slice row) | Verdict |
|---|---|---|
| 1 | Runtime check that `@cyclonedx/cyclonedx-library` 10.3.0 lacks `modelCard`, `data`, `declarations` and `formulation` | **GO.** Confirmed, and the gap is wider than the ADR lists (§1) |
| 2 | Compile the bundled 1.7 and 1.6 schemas and the SPDX 3.0.1 schema with the pinned Ajv, offline, with a reject-all `idn-email` | **GO**, with two needed changes: an `iri-reference` format and the Ajv strict options (§2) |
| 3 | Extend the `canonicalize` byte-identity corpus to BOM shapes | **GO** (§3) |
| 4 | Render a sample AI BOM twice and on two Node versions, and compare the bytes | **GO.** Identical across 6 fresh processes on 3 Node majors (§4) |
| 5 | Run `spdx3-validate` pinned in a CI container | **GO, with an amendment.** No container runtime was available. It ran hash-locked and network-isolated instead. The stock CLI fetches its schema and model from the network (§5) |
| 6 | Read the OWASP AIBOM field guidance | **Done, partially.** The field registry was read. The project page and repository were not (§6) |
| — | Go/no-go on decision 3's exception | **GO** (§7) |

`npm run test:offline` runs the whole suite inside `unshare -n`, a network namespace with no interfaces. A guard test
proves that the namespace has no network. Result: 14 of 14 pass, recorded in
[`evidence/test-output.txt`](../../spikes/bom-b0/evidence/test-output.txt).

## 1. The library's model (item 1)

I checked this at runtime, not by reading the source alone ([`model-check.mjs`](../../spikes/bom-b0/model-check.mjs),
output in [`evidence/model-check.json`](../../spikes/bom-b0/evidence/model-check.json)). The check had three parts:

1. It lists the fields of constructed `Bom`, `Component` (type `machine-learning-model`) and `Service` instances,
   including prototype accessors.
2. It forces the missing fields onto those instances and serializes them with the library's own 1.7 normalizer.
3. It runs the library's own strict JSON validator.

- **Absent from the model:**
  - `Bom`: `formulation`, `declarations`, `definitions`, `compositions`, `annotations` and top-level
    `externalReferences`;
  - `Component`: `modelCard`, `data`, `omniborId`, `swhid`, `manufacturer`, `authors` and `tags`;
  - `Service`: `endpoints`, `data`, `trustZone` and `authenticated`.

  This matches the class declarations I read: `src/models/bom.ts:36-40`, `src/models/component.ts:59-85` and
  `src/models/service.ts:44-57`.
- **Silently dropped on serialization:** `modelCard`, component `data`, service `data` and `endpoints`,
  `declarations`, `formulation` and `compositions` were all forced onto the instances, and none reached the output.
  A positive control shows the probe is not vacuous: `description`, set the same way, is emitted.
- `model-card` exists only as an `ExternalReferenceType` value.
- The library's `JsonStrictValidator` throws `MissingOptionalDependencyError: No JsonValidator available.` when the
  unadmitted `ajv-formats-draft2019` is absent. Its validator cannot be used. Its **schema files** can be.

npm `dist-tags` show 10.3.0 (2026-09-17) as the latest release, so no newer version closes the gap.

## 2. Offline schema compilation (item 2)

[`validators.mjs`](../../spikes/bom-b0/validators.mjs) compiles the following with `ajv` 8.20.0 and
`ajv-formats` 3.0.1. Both pins are identical to `apps/gateway/package.json` and `pnpm-lock.yaml`.

- **CycloneDX:** `bom-1.7.SNAPSHOT.schema.json` and `bom-1.6.SNAPSHOT.schema.json` from the library's
  `res/schema/`, plus the three sub-schemas they `$ref`: `spdx`, `jsf-0.82` and `cryptography-defs`. These are
  registered under the ids the relative `$ref`s resolve to.
- **SPDX:** the vendored official SPDX 3.0.1 schema, compiled with `Ajv2020`.

`loadSchema` throws, and the suite passes inside `unshare -n`.

**Formats.** I counted the formats in the schema files:

- 1.7 uses `date`, `date-time`, `idn-email` and `iri-reference`;
- 1.6 uses `date-time`, `idn-email` and `iri-reference`;
- `jsf` uses `uri`;
- SPDX 3.0.1 uses none.

`ajv-formats` has neither `idn-email` nor `iri-reference`.

- `idn-email` rejects every value, as the ADR says. The suite proves this with an email placed in a dataset owner
  contact, which is rejected.
- **`iri-reference` is not in the ADR, and the library's choice is insecure by default.** Its validator sets
  `ajv.addFormat('iri-reference', true)`, which accepts every value (`src/_optPlug.node/__jsonValidators/ajv.ts:55-56`),
  because no working implementation exists. The spike maps it to `ajv-formats`' own `uri-reference` check. That is
  stricter than the schema, since it refuses non-ASCII IRIs. A test shows that the accept-all setting lets
  `"not a reference at all \u0000"` through and ours refuses it.

**Strict mode.** With `strict: true`, compilation fails for two reasons:

1. CycloneDX uses the annotation keyword `meta:enum` 179 times. The fix is to declare it as a no-op keyword.
2. Both CycloneDX and SPDX use `required` inside `oneOf`/`not`/`if` branches for properties they declare
   elsewhere. Ajv's `strictRequired` treats that as an error, although it is valid JSON Schema.

The spike keeps `strict: true` and turns off only `strictRequired`.

**Cost.** Compiling all three takes 2.3 to 3.0 s per process. Validating one roughly 10 KB CycloneDX 1.7 document
takes about 0.35 ms. B3 should compile once at boot, or precompile with Ajv's bundled standalone code generation.
It must not compile per request.

**Negative controls.** Each control below is rejected by both CycloneDX validators:

- an email address;
- an unknown key on a component;
- an unknown key inside `modelCard`;
- a bad data-flow enum;
- a non-ASCII IRI;
- a malformed SHA-256;
- a bad `serialNumber`.

Each control below is rejected by the SPDX validator:

- fractional seconds in `created`;
- a bad `ai_autonomyType`;
- an unknown property;
- a dataset with no `dataset_datasetType`;
- a 3.0.0 `@context`.

**Vendored SPDX files** were fetched 2026-10-10 from spdx.org, which redirects to the specification site:

| File | Source | sha256 |
|---|---|---|
| `spdx-3.0.1-json-schema.json` | `https://spdx.org/schema/3.0.1/spdx-json-schema.json` (Last-Modified 2025-11-21) | `582c64e809d5b3ef9bd0c4de13a32391b47b0284a3e8d199569fb96f649234b1` |
| `spdx-3.0.1-model.ttl` | `https://spdx.org/rdf/3.0.1/spdx-model.ttl` | `30ebb4af2d70a9809044ef46f44cc3dc5125226d70f818a50ed2e1d5f404c593` |
| `spdx-3.0.1-context.jsonld` | `https://spdx.org/rdf/3.0.1/spdx-context.jsonld` | `c72b0928f094c83e5c127784edb1ebca2af74a104fcacc007c332b23cbc788bd` |

A test pins the three hashes. The specification site lists the Community Specification License 1.0 and CC-BY-3.0.
Neither is on ADR-0176's code-licence list (see amendment 7).

## 3. `canonicalize` byte-identity on BOM shapes (item 3)

The ADR-0186 admission test (`packages/shared/src/canonicalize-admission.test.ts`) covers receipt payloads. The spike
extends the same comparison against the product `canonicalJson` to the following corpus:

- **600 generated `regulait.decision-bom.v1` bodies**, covering every ADR-0189 §2 section. They include
  `not_recorded` sections, 1 to 3 deep SPIFFE actor chains, micro-dollar integers, chain segments, anchors, an
  absent anchor, RFC 3161 tokens, and strings that need escaping: non-ASCII, emoji, `</script>` and control
  characters.
- **The native AI BOM and all three renderings** of the sample.
- **Both raw fixture record sets and their normalised forms**, plus renderings built from replica B.

Every item passes three checks:

- its bytes equal `canonicalJson`;
- its bytes are unchanged with every object's keys reversed;
- the stored bytes re-parse to the same bytes.

**Not protected by canonicalisation, and pinned in a test:**

- Floats canonicalise, but to the wrong decimal (`0.1+0.2` gives `0.30000000000000004`). This is why money stays in
  integer micro-dollars and evaluation metric values are strings. CycloneDX types `performanceMetrics.value` as a
  string.
- An integer above 2^53 does not survive `JSON.parse`.

The ADR's text-column `body` (rather than `jsonb`) is therefore load-bearing. `jsonb` would reorder keys and
normalise numbers.

## 4. Exact bytes across runs and Node versions (item 4)

[`render.mjs`](../../spikes/bom-b0/render.mjs) is a pure renderer. It reads no clock and uses no randomness or
locale. Lists are sorted by code-unit comparison, never `localeCompare`. Times come from rows; SPDX `created` is
truncated to the second (§9 amendment 5). The serial number is an RFC 9562 v8 UUID from SHA-256 of
`regulait:ai-bom:<snapshot id>`. The native body records each rendering's SHA-256 and byte length, and is signed
with Ed25519 under a synthetic fixed-seed key. Ed25519 is deterministic, so the signature is comparable across runs.

The fixtures are [`records-a.json`](../../spikes/bom-b0/fixtures/records-a.json) and `records-b.json`. B holds the
same facts with every array reversed and every key order reversed, which models a second replica or machine.

| Run | native | CycloneDX 1.7 | CycloneDX 1.6 | SPDX 3.0.1 | signature |
|---|---|---|---|---|---|
| A and B, Node v20.20.2, v21.7.3 and v22.22.2, each in a fresh process (6 runs), plus twice in-process | `cdf0c876…d3cc` | `c9a367e3…1ee5` | `1d451d5a…023e` | `e3dede3a…bf91` | `n9ZXFfLc…S6kcBA==` |

The full hashes are in [`evidence/sample.sha256.json`](../../spikes/bom-b0/evidence/sample.sha256.json), and the
renderings are in `evidence/sample.*.json`.

**Non-vacuity checks:**

- One changed checksum changes the native hash.
- Without `normalise()`, A and B render different bytes, because model-card lists pass straight into
  `modelCard.considerations`.
- `JSON.stringify` of the two normalised record sets differs, while `canonicalize` does not. Both list sorting and
  RFC 8785 are therefore load-bearing.

## 5. `spdx3-validate` (item 5)

Version 0.0.7 (MIT, 2026-08-10) is **not air-gapped as shipped**, and the ADR's table says "Yes". In
`spdx3_validate/core.py` (`load_validation_data`):

- every run downloads the JSON schema and the SHACL model from `spdx.org` with `urllib.request.urlopen`;
- rdflib's JSON-LD parser fetches the `@context` URL.

Under `unshare -n` the stock CLI fails with `URLError: Network is unreachable`. With network access it fetches
unpinned content at run time.

[`spdx3/run_offline.py`](../../spikes/bom-b0/spdx3/run_offline.py) calls the library's own `schema_validator` and
`check_graph`, which runs pyshacl, with the three vendored files. It parses the graph with the vendored context
substituted in memory. The document is unchanged.

**No container runtime was available:** the Docker CLI exists, but no daemon socket. So the "CI container" was
replaced by a fresh venv installed with `pip install --no-deps --require-hashes -r spdx3/requirements.lock`, which
holds 23 packages and every wheel hash, and run under `unshare -n`. B5 still has to put this into a real CI job.

Results ([`evidence/spdx3-validate-offline.txt`](../../spikes/bom-b0/evidence/spdx3-validate-offline.txt)):

- The sample conforms: 179 triples, 0 schema errors, 0 SHACL errors. The stock online CLI agrees (exit 0).
- A negative control, `ai_AIPackage.suppliedBy` pointing at a `Tool`, **passes Ajv's JSON schema** and fails SHACL
  with `sh:ClassConstraintComponent`. The stock CLI also fails it (exit 1).

So JSON-schema validation in the product is necessary but not sufficient for SPDX, and the CI SHACL step is not
optional.

The closure's licences are MIT, BSD, Apache-2.0, and three outside ADR-0176's list:

- PSF-2.0 (`typing_extensions`);
- W3C-20150513 (`owlrl`);
- Apache-2.0 OR BSD-2-Clause (`packaging`).

The first two are acceptable only because this closure is CI tooling and never shipped (amendment 6).

## 6. OWASP AIBOM field guidance (item 6)

- `https://owasp.org/www-project-aibom/` redirects to `owasp.org/projects/aibom`, which returned **404**. The
  project's source repository host was **refused by this session's sandbox rule** for commands that name that host,
  as the ADR found. I recorded the refusal and did not route around it. I found no published "operationalizing
  guide".
- What I did read: the OWASP GenAI Security Project's generator page (genai.owasp.org, dated 2025-12-17) and the
  generator's `src/models/field_registry.json`. The registry is the field checklist and weights the generator scores
  against. I read it from the public Space the OWASP page links to, at commit `6165ba9e`, last modified 2026-03-12,
  sha256 `948b03a8…52e8`, Apache-2.0.

  It is a scoring tool's configuration, not a normative specification. It defaults to CycloneDX 1.6, and some of its
  JSONPaths (`$.component.modelCard…`) do not exist in CycloneDX.

What it scores, and what ADR-0189 §3 lacks:

| OWASP field (tier) | CycloneDX location | ADR-0189 §3 today | Recommendation |
|---|---|---|---|
| `primaryPurpose` (critical) | `modelCard.modelParameters.task` | not mapped | **Add**: `model_cards.task` if held, otherwise omit and leave the composition `incomplete` |
| `suppliedBy` (critical) | `component.supplier.name` | "supplier = provider" | Already covered |
| `typeOfModel` (important) | `modelCard.modelParameters.modelArchitecture` | not mapped | **Add**, as supplier-declared |
| `licenses` (important) | `components[].licenses` | SPDX only; not in the CycloneDX mapping | **Add** to the CycloneDX mapping: the declared licence where known; otherwise state unknown and mark the composition `incomplete`, as SPDX does |
| `purl`, `downloadLocation` (important) | `purl`, `externalReferences[type=distribution]` | not mapped | **Add** when the provider gives a stable identifier; never invent one |
| `datasets`, `intendedUse`, `technicalLimitations`, `ethicalConsiderations` (important) | `modelCard.*` | mapped | Covered |
| `energyConsumption`, `safetyRiskAssessment` (important); `autonomyType`, `domain`, `standardCompliance`, `informationAboutTraining`, `useSensitivePersonalInformation`, `modelDataPreprocessing`, `metric` (supplementary) | unnamespaced `metadata.properties` names (the SPDX AI-profile vocabulary) | partly, through `standard_refs` and `data_claims` | **Add** as `regulait:` properties carrying `unknown` or `supplier-declared` (decision 10), and map them to the native SPDX `ai_*` fields in B5. Settle the property names under open question 4 |
| `vcs`, `website`, `paper` (supplementary) | external references | `standard_refs` only | Optional |
| GGUF/tokenizer internals (supplementary) | `modelCard.properties` | — | Out of scope: we govern hosted models by reference |

The guidance also supports OWNER DECISION 6. The OWASP tooling emits 1.6, so the 1.6 export is worth keeping.

## 7. Decision 3's exception: GO

The unmet requirement is real and measured. No maintained JavaScript module can represent or emit `modelCard`,
`data`, `declarations`, `compositions`, service `data`/`endpoints`/`trustZone`, or `definitions`. The only
CycloneDX JavaScript model silently drops them, and its validator depends on an unmaintained package.

The exception stays narrow. Our emitter writes plain objects, and every output is validated with the pinned Ajv
against the official schemas that ship inside the library. That is a dependency on the library's `res/schema` files
only, with no dependency on its runtime code. B3 should therefore depend on `@cyclonedx/cyclonedx-library` 10.3.0
for its schema files. It has zero runtime dependencies and is Apache-2.0. B3 should not import its model.

The re-check trigger stays as written: the next library release is checked at runtime with `model-check.mjs`. For
SPDX, the native-schema approach holds. No maintained JavaScript SPDX 3 model was found, and none was re-searched
beyond the ADR's search.

The spike's npm closure has 8 packages: Apache-2.0 2, MIT 5, BSD-3-Clause 1. `npm audit --omit=dev` reports 0
advisories for this isolated closure. Every package except the CycloneDX library is already in `pnpm-lock.yaml` at
the same version. Lock sha256: `d93a4bfb3d43eea4489617654d35a1e705f1859704c940f3ec124f44629b9235`.

## 8. Not checked

- No product code, PostgreSQL or replica round-trip. The "second machine" is a second row and key order plus fresh
  processes on three Node majors on **one host and one CPU architecture**.
- No real CI job and no container.
- No Decision BOM verifier or BOM-Link resolution.
- No XML.
- The sample's SPDX mapping covers models, datasets, licence relationships, `trainedOn` and `testedOn` only. Services,
  MCP tools and connectors are not rendered to SPDX.

## 9. Amendments ADR-0189 needs (for the master session; ADR not edited)

1. **Decision table, `@cyclonedx/cyclonedx-library` row, and the §4 exception paragraph.** List the full measured
   gap:
   - `Bom` lacks `compositions`, `annotations` and top-level `externalReferences`, as well as the fields already
     listed;
   - `Service` lacks `endpoints`, `data`, `trustZone` and `authenticated`;
   - the serializer **silently drops** fields forced onto it;
   - the library's strict validator throws `MissingOptionalDependencyError` without `ajv-formats-draft2019`.

   B3 depends on the package for `res/schema` only and never imports its model or serializer.
2. **`iri-reference` format (decision table `ajv-formats-draft2019` row; §6; §7 invariants).** The library accepts
   every value for `iri-reference`. We define it as `ajv-formats`' `uri-reference`, which is strict and ASCII-only,
   and the emitter percent-encodes paths and punycodes hosts. This follows ADR-0180: the library's accept-all is an
   insecure default.
3. **Ajv options.** Use `strict: true` with `strictRequired: false`, and register `meta:enum` as an annotation-only
   keyword. Compile once per process (2.3 to 3.0 s), or precompile with Ajv standalone. Never compile per request.
4. **`spdx3-validate` row (air-gapped "Yes" → "No as shipped").** The stock CLI downloads the schema, SHACL model
   and context on every run. The CI job (B5) must:
   - use the vendored, hash-pinned schema, model and context;
   - use an offline driver that calls the library's `schema_validator`/`check_graph`, as `spikes/bom-b0/spdx3`
     does;
   - install the closure with `pip --require-hashes`;
   - run with no network.

   Also record that schema validation alone missed a class violation that SHACL caught.
5. **§5 exact bytes.**
   - SPDX `created` has no fractional seconds, so the SPDX renderer truncates the snapshot time to the second. The
     native body keeps the full value.
   - Specify the `serialNumber` derivation. Recommended: an RFC 9562 v8 UUID from SHA-256 of
     `regulait:ai-bom:<snapshot id>`.
   - Sorting is by code unit, never `localeCompare`.
   - Integers must be safe integers (≤ 2^53).
   - Metric values are strings.
6. **CI-only licences.** The SHACL closure includes PSF-2.0 (`typing_extensions`) and W3C-20150513 (`owlrl`). Both
   are permissive, never shipped, and outside ADR-0176's list. The ADR should state that the rule allows this for
   CI tooling, or the owner decides.
7. **Vendored standard data files.** The SPDX 3.0.1 schema, model and context sit under Community-Spec-1.0 and
   CC-BY-3.0 per the specification site. They are data, not code. ADR-0176's licence list covers code, so the ADR
   should record how vendored standard schemas are admitted. The CycloneDX schemas avoid this because they ship
   inside the Apache-2.0 package.
8. **§3 mapping additions from the OWASP guidance (§6):**
   - `modelCard.modelParameters.task` and `modelArchitecture`;
   - CycloneDX `licenses` on model components, with unknown stated and an `incomplete` composition;
   - `purl` or a distribution reference only when the provider supplies one;
   - SPDX AI-profile vocabulary as `regulait:` properties marked `unknown` or `supplier-declared`.

   Update open question 6: the guidance was read through the OWASP generator's field registry. The project page
   returned 404, and the repository host was refused by the sandbox and not routed around.
9. **B0 slice row and test strategy.** "Run `spdx3-validate` pinned in a CI container" was met only as a hash-locked,
   network-isolated venv. No container runtime was available, so B5 owns the real CI job.

## 10. Review fixes (2026-10-10, PR #265)

A review of the spike raised findings that were checked and fixed in the spike, with tests (ADR-0189 amendments R10
to R13 record what binds the product slices):

- **Email anywhere (R10).** `validators.mjs` gains `findEmails`, a scan of every key and string; `renderAll` refuses a
  document with any hit and names the path. Tests put an email into the use-case name, a model-card limitation, a
  `properties[].value`, an object key and an internationalised address, and show that the schema validators alone
  accept an email in an ordinary string field.
- **No `dataClaims`.** A model card without supplier training-data claims now renders as provenance `unknown` and
  validates; it used to throw.
- **PII verdicts (R11).** The fixtures use the persisted `clean | flagged | blocked` vocabulary. `flagged` and
  `blocked` map to `["pii"]` and SPDX `yes`, `clean` to no entry and `noAssertion`, and any other value is refused.
- **Scanner identity and model-card evidence (R12).** Engine components are keyed by engine, version and image
  digest; the fixture now has two runs of one engine at two versions. `modelCardEvidence` rows of all three kinds
  become claims, evidence and attestations, and `engine_scan` evidence links its artifact scan.
- **Offline driver (R13).** `spdx3/run_offline.py` exits 2 when given no document, before it imports anything.

Because the fixtures changed, the §4 hashes changed. The SPDX rendering is byte-identical, so its §5 SHACL result
still applies. New values, from `npm run test:offline` (21 tests, all passing, network namespace without
interfaces, Node v20.20.2, v21.7.3 and v22.22.2):

| native | CycloneDX 1.7 | CycloneDX 1.6 | SPDX 3.0.1 | signature |
|---|---|---|---|---|
| `3c36cfee…fab1` | `efebbf0d…09ca` | `58f7d5bc…6322` | `e3dede3a…bf91` (unchanged) | `lrUdt/mQ…axZ2BA==` |

Not fixed in the spike: the sample `AIPackage` entries lack `releaseTime` and `downloadLocation`, which SPDX 3.0.1
makes mandatory for `AIPackage` but its SHACL model does not enforce. ADR-0189 R3 and owner item 1 decide how B5
handles them.

## 11. Third review round (2026-10-10, PR #265)

The spike is a feasibility check, not the product renderer. Where a finding was about mapping real tables, the fix is a
binding requirement on B3 in ADR-0189 (R24 and R26 to R32), and B3's loader is tested against rows shaped by the
`packages/db` schema (R32). The spike code changed only where it made a false claim or the change was cheap:

- **Email scan.** Any `@` with a non-space character on both sides is now refused, so quoted local parts, address
  literals and dotless domains are caught (fail closed; a false positive names the path).
- **Loader allowlist and persisted model cards.** `normalise` takes only allowlisted keys per record type and refuses
  any other (an agent's system prompt, a prompt template, a skill body). `modelCardFromRow` maps the real
  `model_cards` shape: `intended_use` and `limitations` stay whole strings, `bias_fairness` entries render by
  `dimension` with method and status as a property (assessor and note are dropped), and `data_claims` is rendered as
  supplier claims, never split or invented. Task and architecture appear only when the supplier declared them.
- **Safe integers.** A number that is not a safe integer is refused before canonicalisation.
- **Absent values.** `prop()` omits null and undefined; a null MCP release digest is `not_recorded`.
- **Clean PII verdict.** No `sensitiveData` key at all (it was an empty list).
- **Datasets (R24, R26).** Training checksums parse `sha256:<hex>:<rows>`; `fnv1a32:` stays a property only; the
  evaluation dataset has a cases digest and no classification, owner or PII verdict; gaps are `incomplete`.
- **Licences.** Every model component states a licence: the supplier-declared one, else `unknown`, with an
  `incomplete` composition.
- **SPDX.** Every artifact hash of an agent is listed; provider names reach IRIs only as a digest.
- **No fabricated digests or claims (R30).** Evidence entries say `digest: not_recorded` (no table stores one);
  `standard_refs` render as properties, not URLs; `authenticated` is emitted only from a recorded boolean.
- **Fixtures.** Model cards, datasets, evidence and scans now follow the real columns. `make-records-b.mjs` keeps
  array order inside `data_claims` (a jsonb value), reordering only its keys.

Left to B3 by ADR amendment, not spiked: many-to-many artifact edges (R29), agent, builder-agent and install subjects
(R31), and per-use-case data flows (R27).

New values, from `npm run test:offline` (33 tests, all passing, no network namespace interfaces); the offline SHACL
check of the new SPDX sample passes (`evidence/spdx3-validate-offline.txt`):

| native | CycloneDX 1.7 | CycloneDX 1.6 | SPDX 3.0.1 | signature |
|---|---|---|---|---|
| `34e8e54b…9a6c` | `428fbe83…1a04` | `fc2b7b00…7897` | `47e13615…7031` | `/MUhBadU…WehMBg==` |
