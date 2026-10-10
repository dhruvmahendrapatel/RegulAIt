// Offline corpus checks only; deliberately imports no product implementation.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const corpus = read('cases.json');
const crypto = read('crypto.json');
const ids = new Set();
for (const row of corpus.cases) {
  assert(!ids.has(row.id), `duplicate case ${row.id}`);
  ids.add(row.id);
  assert(row.sections.length && row.sections.every(s => typeof s === 'string'));
  assert(['active', 'signed-depth-enabled'].includes(row.profile));
  assert(['eligible', 'refuse', 'race', 'sequence'].includes(row.expected.effect));
  assert(row.input && typeof row.input === 'object');
  if (row.profile === 'signed-depth-enabled') assert(row.sections.some(s => /Decision (15|23)|S5/.test(s)));
}
for (const prefix of ['request-', 'resource-dpop-', 'client-assertion-', 'human-proof-', 'replay-', 'live-chain-', 'act-', 'depth-', 'child-', 'certificate-', 's5-']) {
  assert(corpus.cases.some(row => row.id.startsWith(prefix)), `missing family ${prefix}`);
}
const digest = value => createHash('sha256').update(value).digest('base64url');
for (const [name, jwk] of Object.entries(crypto.publicKeys)) {
  assert(!('d' in jwk), 'private key exported');
  assert.equal(digest(JSON.stringify({crv:jwk.crv,kty:jwk.kty,x:jwk.x})), crypto.thumbprints[name]);
}
const decoded = {};
for (const fixture of crypto.fixtures) {
  const [header64, payload64, signature64, extra] = fixture.compact.split('.');
  assert.equal(extra, undefined);
  const header = JSON.parse(Buffer.from(header64, 'base64url'));
  const payload = JSON.parse(Buffer.from(payload64, 'base64url'));
  const valid = verify(null, Buffer.from(`${header64}.${payload64}`), createPublicKey({key:crypto.publicKeys[fixture.signer],format:'jwk'}), Buffer.from(signature64, 'base64url'));
  assert.equal(valid, fixture.signatureValid, fixture.id);
  assert.equal(header.alg, 'EdDSA');
  if (header.jwk) assert.deepEqual(header.jwk, crypto.publicKeys[fixture.signer]);
  decoded[fixture.id] = payload;
}
assert.equal(decoded['client-assertion-valid'].aud, crypto.endpoint);
assert(Array.isArray(decoded['client-assertion-aud-array'].aud));
assert.equal(crypto.clock - decoded['as-dpop-stale'].iat, 61);
assert.equal(decoded['rs-dpop-valid'].ath, digest(crypto.parentTokenBytes));
assert.equal(decoded['delegation-authz-valid'].child_cnf.jkt, crypto.thumbprints.B);
assert.notEqual(crypto.thumbprints.other, crypto.thumbprints.A);
assert.deepEqual(decoded['delegation-authz-wrong-key'], decoded['delegation-authz-valid']);
assert.equal(decoded['delegation-authz-valid'].ath, digest(crypto.parentTokenBytes));
const guard = corpus.cases.find(row => row.id === 'child-depth-unenforced');
assert.deepEqual([guard.expected.errorCode, guard.expected.replayClaims, guard.expected.allocations], ['delegation_depth_unenforced', 0, 0]);
const act = corpus.cases.find(row => row.id === 'act-stored-path');
const actors = [];
for (let next = act.expected.act; next; next = next.act) actors.push(next.sub);
assert.deepEqual(actors.reverse(), act.input.storedRootToLeaf);
console.log(`${corpus.cases.length} semantic/template cases checked; ${crypto.fixtures.length} real Ed25519 fixtures verified (including tamper rejection). Product conformance unrun.`);
