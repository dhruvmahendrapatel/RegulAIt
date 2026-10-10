import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPublicKey,createHash,verify} from 'node:crypto';
const base = new URL('./', import.meta.url);
const corpus=JSON.parse(readFileSync(new URL('crypto-vectors.json',base),'utf8'));
const semantic=JSON.parse(readFileSync(new URL('semantic-vectors.json',base),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
// Limited RFC8785-compatible objects: ASCII keys, arrays, strings and safe integers.
// This is a fixture canonicality assertion, not a general RFC8785 implementation.
const canonical=x=> x===null||typeof x!=='object' ? JSON.stringify(x) : Array.isArray(x) ? '['+x.map(canonical).join(',')+']' : '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
for(const c of corpus.primitives){
 check(c.id+' authentic signature expectation',()=>{
  const key=createPublicKey({key:Buffer.from(c.pinnedPublicKeySpkiDerBase64,'base64'),format:'der',type:'spki'});
  const actual=verify(null,Buffer.from(c.bytes),key,Buffer.from(c.signatureBase64,'base64'));
  assert.equal(actual,c.expectedPrimitiveSignatureValid);
 });
 check(c.id+' canonical bytes and domain expectation',()=>{
  const parsed=JSON.parse(c.bytes);assert.equal(canonical(parsed),c.bytes);
  assert.equal(['regulait.decision-bom.v1','regulait.ai-bom.v1'].includes(parsed.v),c.expectedRecognisedBomDomain);
 });
}
check('exact facts bytes digest',()=>{assert.equal(sha(corpus.facts.canonicalBytes),corpus.facts.sha256);assert.equal(sha(corpus.facts.nonCanonicalBytes),corpus.facts.nonCanonicalSha256);assert.notEqual(corpus.facts.sha256,corpus.facts.nonCanonicalSha256);assert.deepEqual(JSON.parse(corpus.facts.canonicalBytes),JSON.parse(corpus.facts.nonCanonicalBytes));});
check('exact rendering bytes digest and length',()=>{assert.equal(sha(corpus.rendering.bytes),corpus.rendering.sha256);assert.equal(Buffer.byteLength(corpus.rendering.bytes),corpus.rendering.utf8ByteLength);assert.notEqual(sha(corpus.rendering.mutationBytes),corpus.rendering.sha256);});
check('ADR0116 SPKI fingerprints',()=>{assert.equal('sha256:'+sha(Buffer.from(corpus.primitives[0].pinnedPublicKeySpkiDerBase64,'base64')),corpus.fingerprints.A);assert.equal('sha256:'+sha(Buffer.from(corpus.primitives[2].pinnedPublicKeySpkiDerBase64,'base64')),corpus.fingerprints.B);});
check('corpus provenance and blocked status',()=>{assert.deepEqual(corpus.source,semantic.source);assert.equal(corpus.productWirePositiveStatus,'BLOCKED');assert.equal(semantic.productWirePositiveStatus,'BLOCKED');});
check('semantic case metadata',()=>{assert.equal(new Set(semantic.cases.map(c=>c.id)).size,semantic.cases.length);for(const c of semantic.cases){assert.ok(c.refs.length>0);assert.ok(c.given&&c.operation&&c.expected);assert.equal(c.kind,'semantic-or-lifecycle');}});
if(process.argv.includes('--red-signature')){
 // Simulate the forbidden primitive accepting every signature: K02 must reject it.
 const negative=corpus.primitives.find(c=>c.id==='K02');
 assert.equal(true,negative.expectedPrimitiveSignatureValid,'red proof: accepting altered signed bytes must fail');
}
if(process.argv.includes('--red-rendering')){
 // Simulate altered bytes accepted despite signed digest: must fail.
 assert.equal(sha(corpus.rendering.mutationBytes),corpus.rendering.sha256,'red proof: changed rendering must fail');
}
console.log(`${checks} fixture-integrity checks PASS; ${semantic.cases.length} semantic obligations listed, not executed against product. No product-verifier readiness claim.`);
