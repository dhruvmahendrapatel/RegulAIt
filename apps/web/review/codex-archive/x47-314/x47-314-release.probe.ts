// Independent X47 B7 controls. Run after building the exact PR314 shared package.
// Verification flags model the trusted caller boundary; these are not cosign proofs.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AI_BOM_SNAPSHOTS_RELEASED, buildReleaseSbomIdentity, checkReleaseSbomBytes,
  releaseAiBomRecords, buildReleaseAiBom, runReleaseAiBomStep,
  verifiedReleaseSbomRecords, validateCycloneDx,
} from '../../../packages/shared/dist/index.js';
const root = new URL('../../../', import.meta.url);
const commit = 'd'.repeat(40);
const imageDigest = `sha256:${'e'.repeat(64)}`;
const privatePath = 'X47_PRIVATE_LOCATION';
const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
const makeSbom = (serial: string) => Buffer.from(JSON.stringify({bomFormat:'CycloneDX', specVersion:'1.6',serialNumber:serial,version:2,metadata:{component:{type:'application',name:privatePath}},components:[{type:'library',name:secret}]}));
const workspace = makeSbom('urn:uuid:00000000-0000-4000-8000-000000000071');
const image = makeSbom('urn:uuid:00000000-0000-4000-8000-000000000072');
const identity = buildReleaseSbomIdentity({commit,imageDigest,workspace,image});
const inventory = JSON.parse(readFileSync(new URL('security/ai-dev-stack.json',root),'utf8'));
const input = {commit,committedAt:'2026-10-10T12:00:00.000Z',inventory,sbomIdentity:identity,sbomIdentityVerification:{signatureVerified:true,method:'sigstore_keyless_ci' as const}};
let pass=0, fail=0;
function test(name:string,fn:()=>void){try{fn();pass++;console.log(`PASS ${name}`)}catch(e){fail++;console.log(`RED ${name}: ${(e as Error).message}`)}}
test('real signature control: changing identity commit invalidates exact-byte Ed25519 signature',()=>{
  const keys=generateKeyPairSync('ed25519'); const bytes=Buffer.from(JSON.stringify(identity));
  const sig=sign(null,bytes,keys.privateKey); assert.equal(verify(null,bytes,keys.publicKey,sig),true);
  assert.equal(verify(null,Buffer.from(JSON.stringify({...identity,commit:'f'.repeat(40)})),keys.publicKey,sig),false);
});
test('unverified identity is refused at caller verification seam',()=>assert.throws(()=>verifiedReleaseSbomRecords(identity,{signatureVerified:false,method:'sigstore_keyless_ci'}),/not verified/));
test('unknown verification method refused',()=>assert.throws(()=>verifiedReleaseSbomRecords(identity,{signatureVerified:true,method:'invented' as any}),/unknown verification/));
test('same serial/version with changed SBOM bytes is refused',()=>assert.throws(()=>checkReleaseSbomBytes(identity,{workspace:Buffer.concat([workspace,Buffer.from('\n')]),image}),/does not match/));
test('missing image SBOM is refused',()=>assert.throws(()=>checkReleaseSbomBytes(identity,{workspace}),/missing/));
test('identity for another release commit is refused',()=>assert.throws(()=>releaseAiBomRecords({...input,commit:'f'.repeat(40)}),/another release commit/));
test('linked bytes carry hashes and provenance, never raw SBOM content',()=>{
  const b=buildReleaseAiBom(input); const doc=JSON.parse(b.renderings[0]!.bytes);
  assert.equal(validateCycloneDx(doc,'1.7').valid,true);
  const refs=doc.metadata.component.externalReferences;
  for(const s of identity.sboms){const ref=refs.find((r:any)=>r.url===`urn:cdx:${s.serialNumber.slice(9)}/${s.version}`);assert.ok(ref);assert.deepEqual(ref.hashes,[{alg:'SHA-256',content:s.sha256}]);}
  assert.equal(identity.sboms.find(s=>s.kind==='workspace')!.sha256,createHash('sha256').update(workspace).digest('hex'));
  const output=[b.bodyBytes,...b.renderings.map(r=>r.bytes)].join('\n');assert.equal(output.includes(secret),false);assert.equal(output.includes(privatePath),false);
  assert.ok(doc.metadata.component.properties.some((p:any)=>p.name==='regulait:release:commit'&&p.value===commit));
  assert.ok(doc.metadata.component.properties.some((p:any)=>p.name==='regulait:release:imageDigest'&&p.value===imageDigest));
  assert.equal(doc.formulation[0].components.length,inventory.tools.length);assert.deepEqual(doc.components??[],[]);
});
test('absent identity omits BOM links and keeps honest incomplete composition',()=>{
  const b=buildReleaseAiBom({...input,sbomIdentity:null,sbomIdentityVerification:null});const d=JSON.parse(b.renderings[0]!.bytes);
  assert.equal(d.metadata.component.externalReferences,undefined);assert.ok(d.compositions.some((c:any)=>c.aggregate==='incomplete'));
  assert.equal(d.compositions.some((c:any)=>c.aggregate==='complete'),false);
});
test('R17 off returns inert before parsing; harness positive control produces bytes',()=>{
  assert.equal(AI_BOM_SNAPSHOTS_RELEASED,false);
  assert.deepEqual(runReleaseAiBomStep({...input,inventory:null}),{status:'inert',reason:'ai_bom_snapshots_not_released'});
  const on=runReleaseAiBomStep(input,{released:true});assert.equal(on.status,'built');if(on.status==='built')assert.ok(on.files.some(f=>f.name==='ai-bom.native.json'));
});
test('CLI has no release override and writes nothing while off',()=>{
  const out=mkdtempSync(path.join(tmpdir(),'x47-release-'));
  try{for(const args of [['identity','--out',path.join(out,'id.json')],['build','--out-dir',path.join(out,'bom'),'--released','true']]){
    const r=spawnSync(process.execPath,[new URL('scripts/release-ai-bom.mjs',root).pathname,...args],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/inert/);
  }assert.deepEqual(readdirSync(out),[]);}finally{rmSync(out,{recursive:true,force:true});}
});
console.log(JSON.stringify({pass,fail}));process.exitCode=fail?1:0;
