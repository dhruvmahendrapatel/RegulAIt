/** Independent X44 probes of frozen PR297 a2f5489dd074075425860848ea3c0b4aa7749b7f.
 * First build the reviewed dependency: pnpm --filter @regulait/shared build.
 * Run: node apps/web/review/x44-spdx.probe.ts [output directory]
 * ADR0189 R3 and B5 entry4237371312 supply the independent required-field lists.
 * Synthetic recorded fixtures; no claim of live snapshot/API acceptance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAiBom, normaliseAiBomRecords, renderAiBomCycloneDx, renderAiBomSpdx, spdxMandatoryMissing, validateSpdx, bomCanonicalBytes } from "../../../packages/shared/dist/bom/index.js";
const root = fileURLToPath(new URL("../../../",import.meta.url));
const load = (name: string): any => JSON.parse(readFileSync(resolve(root,"scripts/spdx3/fixtures", name), "utf8"));
const out = resolve(process.argv[2] ?? "/tmp/x44-spdx-vectors"); mkdirSync(out, { recursive: true });
let pass = 0;
function check(name: string, probe: () => void) { probe(); pass++; console.log(`PASS ${name}`); }
const mandatory: Record<string,string[]> = {
 ai_AIPackage: ["releaseTime","suppliedBy","software_downloadLocation","software_packageVersion","software_primaryPurpose"],
 dataset_DatasetPackage: ["builtTime","originatedBy","releaseTime","software_downloadLocation","software_primaryPurpose","dataset_datasetType"],
};
const fixture = load("producible.json"), datasets = load("with-datasets.json");
const options = { cyclonedxVersions: ["1.7", "1.6"] as const };
const built = buildAiBom(fixture.records, fixture.meta, options);
const rendering = built.renderings.find(r => r.format === "spdx-3.0.1")!;
assert.ok(rendering); const doc: any = JSON.parse(rendering.bytes);
writeFileSync(resolve(out,"valid.spdx.json"), rendering.bytes);
for (const [kind, fields] of Object.entries(mandatory)) {
 const complete: any = { type: kind, ...Object.fromEntries(fields.map(k=>[k, k.endsWith("Type") ? ["noAssertion"] : "recorded"])) };
 check(`${kind} complete mandatory projection`,()=>assert.deepEqual(spdxMandatoryMissing({"@graph":[complete]}),[]));
 for (const field of fields) for (const empty of [undefined,null,"",[]]) {
  check(`${kind}.${field} detects ${empty === undefined ? "absent" : JSON.stringify(empty)} on second element`,()=>{
   const incomplete = {...complete,[field]:empty};
   assert.deepEqual(spdxMandatoryMissing({"@graph":[complete,incomplete,incomplete]}),[`${kind}.${field}`]);
  });
 }
}
check("R3 all five AIPackage fields missing still pass official JSON schema",()=>{
 const missing=structuredClone(doc); const pkg=missing["@graph"].find((e:any)=>e.type==="ai_AIPackage");
 for(const field of mandatory.ai_AIPackage!) delete pkg[field];
 assert.equal(validateSpdx(missing).valid,true);
 assert.deepEqual(spdxMandatoryMissing(missing),mandatory.ai_AIPackage!.map(k=>`ai_AIPackage.${k}`).sort());
 writeFileSync(resolve(out,"ai-missing-mandatory.spdx.json"),bomCanonicalBytes(missing));
});
const draft = renderAiBomSpdx(normaliseAiBomRecords(datasets.records),datasets.meta,renderAiBomCycloneDx(normaliseAiBomRecords(datasets.records),datasets.meta,"1.7")).doc;
check("dataset draft schema success does not satisfy mandatory external cardinalities",()=>{
 assert.equal(validateSpdx(draft).valid,true);
 assert.deepEqual(spdxMandatoryMissing(draft),["builtTime","originatedBy","releaseTime","software_downloadLocation"].map(k=>`dataset_DatasetPackage.${k}`).sort());
 writeFileSync(resolve(out,"dataset-missing-mandatory.spdx.json"),bomCanonicalBytes(draft));
});
check("dataset build signs exact missing names, omits SPDX bytes and keeps both CycloneDX renderings",()=>{
 const b=buildAiBom(datasets.records,datasets.meta,options);
 assert.deepEqual(b.body.renderings["spdx-3.0.1"],{status:"not_producible",missing:spdxMandatoryMissing(draft)});
 assert.deepEqual(b.renderings.map(r=>r.format).sort(),["cyclonedx-1.6","cyclonedx-1.7"]);
});
for(const field of ["releaseTime","downloadLocation","pinnedModelVersion"]){
 check(`recorded ${field} absence refuses SPDX only`,()=>{
  const changed=structuredClone(fixture);
  if(field==="pinnedModelVersion")changed.records.modelCards[0][field]=null;
  else delete changed.records.modelCards[0].dataClaims[field];
  const b=buildAiBom(changed.records,changed.meta,options);
  const property=field==="downloadLocation"?"software_downloadLocation":field==="pinnedModelVersion"?"software_packageVersion":field;
  assert.deepEqual(b.body.renderings["spdx-3.0.1"],{status:"not_producible",missing:[`ai_AIPackage.${property}`]});
  assert.equal(b.renderings.some(r=>r.format==="spdx-3.0.1"),false);
  assert.equal(b.renderings.length,2);
 });
}
check("SPDX rendering digest and byte count are signed native declarations",()=>{
 assert.equal(rendering.sha256,createHash("sha256").update(rendering.bytes).digest("hex"));
 assert.equal(rendering.byteLength,Buffer.byteLength(rendering.bytes));
 const signed=built.body.renderings["spdx-3.0.1"];
 assert.ok(signed);
 assert.equal(signed.status,"rendered"); if(signed.status!=="rendered")throw new Error("not rendered");
 assert.equal(signed.sha256,rendering.sha256);assert.equal(signed.bytes,rendering.byteLength);
});
check("each emitted package/file has exactly one declared and concluded licence relationship",()=>{
 for(const pkg of doc["@graph"].filter((e:any)=>["software_Package","software_File","ai_AIPackage","dataset_DatasetPackage"].includes(e.type))) {
  for(const kind of ["hasDeclaredLicense","hasConcludedLicense"]){
   const rs=doc["@graph"].filter((e:any)=>e.type==="Relationship"&&e.from===pkg.spdxId&&e.relationshipType===kind);
   assert.equal(rs.length,1);assert.equal(rs[0].to.length,1);
   if(kind==="hasConcludedLicense")assert.equal(rs[0].to[0],"expandedlicensing_NoAssertionLicense");
  }
 }
});
check("supplier reference to Tool is schema-valid but a SHACL negative control",()=>{
 const wrong=structuredClone(doc);wrong["@graph"].find((e:any)=>e.type==="ai_AIPackage").suppliedBy=wrong["@graph"].find((e:any)=>e.type==="Tool").spdxId;
 assert.equal(validateSpdx(wrong).valid,true);assert.deepEqual(spdxMandatoryMissing(wrong),[]);
 writeFileSync(resolve(out,"supplier-tool.expect-fail.json"),bomCanonicalBytes(wrong));
});
check("R17 gateway release switch stays false in frozen dependency",()=>{
 const routes=readFileSync(resolve(root,"apps/gateway/src/bom-routes.ts"),"utf8");
 const implementation=readFileSync(resolve(root,"apps/gateway/src/ai-bom.ts"),"utf8");
 assert.match(implementation,/AI_BOM_SNAPSHOTS_RELEASED\s*=\s*false/);
 assert.match(routes,/if \(!AI_BOM_SNAPSHOTS_RELEASED\) return reply\.status\(501\)/);
});
console.log(JSON.stringify({pass,failed:0,reviewedHead:"a2f5489dd074075425860848ea3c0b4aa7749b7f",vectors:out}));
