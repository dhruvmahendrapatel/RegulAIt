#!/usr/bin/env node
// ADR-0189 slice B5: write SPDX 3.0.1 renderings PRODUCED BY THE PRODUCT CODE (the built @regulait/shared) for the CI
// SHACL step (`run_offline.py`). Run after `pnpm -r build`. Usage: node scripts/spdx3/render-fixtures.mjs <out dir>
//
// Writes, from the synthetic fixtures in ./fixtures:
//   <subject kind>.spdx.json        buildAiBom's real rendering, one per subject kind (R31)
//   with-datasets.draft.spdx.json   the renderer's document for a record set WITH datasets. buildAiBom refuses to
//                                   ship it (not_producible, R3); the draft is validated so the dataset mapping is
//                                   checked against the official model too. It is never a product output.
//   use_case.supplied-by-tool.expect-fail.json   the R12 §5 negative control, derived from the real rendering: an
//                                   ai_AIPackage whose suppliedBy points at the Tool. It passes the JSON schema and
//                                   must FAIL SHACL; the driver fails if it does not.
// Fails (exit 1) on any surprise, so the CI step can never validate less than it claims.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = await import(path.join(here, "..", "..", "packages", "shared", "dist", "index.js"));
const { AI_BOM_INSTALL_SUBJECT_ID, bomCanonicalBytes, buildAiBom, normaliseAiBomRecords, renderAiBomCycloneDx, renderAiBomSpdx, spdxMandatoryMissing, validateSpdx } = shared;

const out = process.argv[2];
if (!out) {
  console.error("render-fixtures: no output directory given");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const fixture = (name) => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));
const fail = (m) => {
  console.error(`render-fixtures: ${m}`);
  process.exit(1);
};
const write = (name, text) => {
  writeFileSync(path.join(out, name), text);
  console.log(`${name} ${Buffer.byteLength(text)} bytes`);
};

const { meta, records } = fixture("producible.json");
const subjects = {
  use_case: records.subject.id,
  agent: records.agents[0].id,
  builder_agent: records.builderAgents[0].id,
  install: AI_BOM_INSTALL_SUBJECT_ID,
};
let useCaseBytes = null;
for (const [kind, id] of Object.entries(subjects)) {
  const build = buildAiBom({ ...records, subject: { kind, id } }, { ...meta, subjectKind: kind, subjectId: id }, { cyclonedxVersions: ["1.7"] });
  const r = build.renderings.find((x) => x.format === "spdx-3.0.1");
  if (!r) fail(`${kind}: no SPDX rendering (${JSON.stringify(build.body.renderings["spdx-3.0.1"])})`);
  write(`${kind}.spdx.json`, r.bytes);
  if (kind === "use_case") useCaseBytes = r.bytes;
}

const ds = fixture("with-datasets.json");
const dsBuild = buildAiBom(ds.records, ds.meta, { cyclonedxVersions: ["1.7"] });
if (dsBuild.body.renderings["spdx-3.0.1"]?.status !== "not_producible") fail("with-datasets: expected not_producible");
const n = normaliseAiBomRecords(ds.records);
const draft = renderAiBomSpdx(n, ds.meta, renderAiBomCycloneDx(n, ds.meta, "1.7")).doc;
if (!spdxMandatoryMissing(draft).length) fail("with-datasets: the draft unexpectedly has every mandatory property");
const v = validateSpdx(draft);
if (!v.valid) fail(`with-datasets draft fails the JSON schema: ${JSON.stringify(v.errors.slice(0, 3))}`);
write("with-datasets.draft.spdx.json", bomCanonicalBytes(draft));

const neg = JSON.parse(useCaseBytes);
const toolId = neg["@graph"].find((e) => e.type === "Tool")?.spdxId;
const pkg = neg["@graph"].find((e) => e.type === "ai_AIPackage");
if (!toolId || !pkg) fail("negative control: no Tool or ai_AIPackage in the use_case rendering");
pkg.suppliedBy = toolId;
if (!validateSpdx(neg).valid) fail("negative control must pass the JSON schema (it is a SHACL-only violation)");
write("use_case.supplied-by-tool.expect-fail.json", bomCanonicalBytes(neg));
