// ADR-0188 delegation vector self-consistency checks. Offline; imports no product implementation.
// Adopted from X49 (#320) and revised against ADR-0188 on b6-identity-s5 (see README.md).
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PENDING = 'b6-identity-s5@31157923b9f9bfc4290acb0df0d298a04b75ef7c';
const EFFECTS = ['eligible', 'refuse', 'race', 'sequence'];
const PROFILES = ['active', 'signed-depth-enabled'];
const ORIGINS = ['X49', 'X49-revised', 'claude-new'];
const FAMILIES = ['request-', 'resource-dpop-', 'client-assertion-', 'human-proof-', 'replay-', 'live-chain-', 'act-', 'depth-',
  'child-', 'certificate-', 's5-', 'introspection-', 'timeout-'];
// Keys whose string values are secret-shaped (one-use ids, nonces, token bytes) and must carry CANARY.
const SECRET_KEYS = new Set(['jti', 'nonce', 'sameKey', 'parentTokenBytes', 'idempotency_key']);
// Semantic markers (not values) the corpus uses in those keys: "current nonce", "fresh jti", and so on.
const SEMANTIC_MARKERS = new Set(['current', 'stale', 'fresh', 'already-claimed', 'spent', 'expected', 'other']);
const ID_RE = /^[a-z0-9_-]+$/i;
const STEP_UP_FACTS = ['op', 'agentIdentityId', 'projectId', 'resource', 'env', 'authorizationDetails', 'capMicros', 'maxDepth',
  'lifetimeSeconds', 'agentKeyThumbprint'];

export function readCorpus(dir = new URL('./', import.meta.url)) {
  const read = (name) => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  return { corpus: read('cases.json'), crypto: read('crypto.json') };
}

function walkSecrets(value, path, out) {
  if (Array.isArray(value)) value.forEach((v, i) => walkSecrets(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k) && typeof v === 'string' && !SEMANTIC_MARKERS.has(v) && !v.includes('CANARY')) out.push(`${path}.${k}`);
      walkSecrets(v, `${path}.${k}`, out);
    }
  }
}

const digest = (value) => createHash('sha256').update(value).digest('base64url');

export function checkDelegationCorpus(corpus, crypto) {
  assert.equal(corpus.format, 'regulait.delegation-spec-vectors.v2');
  assert.equal(corpus.source.reviewedAgainst.branch, 'b6-identity-s5');
  const ids = new Set();
  for (const row of corpus.cases) {
    assert.match(row.id, ID_RE, row.id);
    assert(!ids.has(row.id), `duplicate case ${row.id}`);
    ids.add(row.id);
    assert(Array.isArray(row.sections) && row.sections.length > 0 && row.sections.every((s) => typeof s === 'string'), row.id);
    assert(PROFILES.includes(row.profile), `${row.id} profile`);
    assert(ORIGINS.includes(row.origin), `${row.id} origin`);
    if (row.origin === 'X49-revised') assert(typeof row.revision === 'string' && row.revision.length > 0, `${row.id} revision`);
    if ('pendingBranch' in row) assert.equal(row.pendingBranch, PENDING, `${row.id} pendingBranch`);
    assert(EFFECTS.includes(row.expected.effect), `${row.id} effect`);
    assert(row.input && typeof row.input === 'object', `${row.id} input`);
    if (row.profile === 'signed-depth-enabled') assert(row.sections.some((s) => /Decision (15|16|23)|S5/.test(s)), row.id);
    // S5 item 1: every external child exchange is refused today, so no active vector may expect a child token.
    if (row.profile === 'active' && row.expected.effect === 'eligible') {
      assert.notEqual(row.input.signedDepthEnforced, true, `${row.id}: active child exchange cannot be eligible`);
      assert(!row.expected.act || !row.expected.act.act, `${row.id}: a nested act needs a child exchange`);
    }
    // The token-endpoint delegation_depth code is reachable only once signed depth is enforced.
    if (row.expected.errorCode === 'delegation_depth') assert.equal(row.profile, 'signed-depth-enabled', row.id);
    if (row.expected.errorCode === 'delegation_depth_unenforced') {
      assert.equal(row.profile, 'active', row.id);
      assert.equal(row.expected.oauthError, 'invalid_grant', row.id);
      assert.equal(row.expected.replayClaims, 0, row.id);
      assert.equal(row.expected.allocations, 0, row.id);
    }
    const secrets = [];
    walkSecrets(row, row.id, secrets);
    assert.deepEqual(secrets, [], `secret-shaped values without CANARY: ${secrets.join(', ')}`);
  }
  for (const prefix of FAMILIES) assert(corpus.cases.some((row) => row.id.startsWith(prefix)), `missing family ${prefix}`);

  const byId = (id) => {
    const row = corpus.cases.find((r) => r.id === id);
    assert(row, `missing ${id}`);
    return row;
  };
  // S5 item 6: strict lifetime default and cap requirement.
  assert.equal(byId('s5-lifetime-default-15-min').expected.grantLifetimeSeconds, 900);
  assert.equal(byId('s5-lifetime-over-default').expected.errorCode, 'delegation_lifetime');
  assert.equal(byId('s5-cap-required').expected.errorCode, 'delegation_cap_required');
  // S5 item 2: explicit membership; an admin is not a member; a project without members is closed.
  for (const id of ['s5-project-without-members', 's5-admin-not-member', 's5-no-project-access'])
    assert.equal(byId(id).expected.errorCode, 'delegation_project_access', id);
  // S5 item 8: the step-up action body is the whole authority, and a grant for other facts is not spent.
  assert.deepEqual(byId('human-proof-sensitive-write-stepup').expected.actionBodyKeys, STEP_UP_FACTS);
  const otherFacts = corpus.cases.filter((r) => r.id.startsWith('s5-step-up-other-'));
  assert(otherFacts.length >= 9);
  for (const row of otherFacts) {
    assert(STEP_UP_FACTS.includes(row.input.requestDiffersIn), row.id);
    assert.equal(row.expected.stepUpGrantSpent, false, row.id);
  }
  // S5 item 7: one-string aud.
  assert(Array.isArray(byId('client-assertion-aud-array').input.aud));
  assert.equal(byId('client-assertion-aud-array').expected.oauthError, 'invalid_client');
  assert.equal(byId('introspection-aud-array-inactive').expected.introspectionActive, false);
  // S5 item 9: claim lifetimes outlive the signed window.
  const ca = byId('replay-claim-lifetime-client_assertion');
  assert.equal(ca.expected.claimExpiresAtNotBefore, ca.input.verifiedExp + 5);
  const dp = byId('replay-claim-lifetime-as_dpop');
  assert.equal(dp.expected.claimExpiresAtNotBefore, dp.input.proofIat + 60 + 5);
  // S5 item 3: every issuer rule names certificate_issuer.
  for (const id of ['certificate-issuerNotCA', 'certificate-issuerMissingKeyCertSign', 'certificate-issuerPathLenTooSmall',
    'certificate-anchorNotCA', 'certificate-intermediateNotCA']) assert.equal(byId(id).expected.errorCode, 'certificate_issuer', id);
  const pl = byId('certificate-issuerPathLenTooSmall').input;
  assert(pl.pathLenConstraint < pl.intermediatesBelowIssuer);
  const ok = byId('certificate-pathLen-satisfied').input;
  assert(ok.pathLenConstraint >= ok.intermediatesBelowIssuer);
  // Decisions 26/30/34: hop count outside 1..9 is actor-chain-invalid; within it, depth past the limit is delegation-depth.
  assert.equal(byId('depth-stored-9-max-8').expected.ruleId, 'actor-chain-invalid');
  for (const row of corpus.cases.filter((r) => r.id.startsWith('depth-stored-'))) {
    assert.equal(row.input.surface, 'kernel-depth-term', row.id);
    assert.equal(row.input.actorHopCount, row.input.storedGrantDepth + 1, row.id);
    const over = row.input.storedGrantDepth > row.input.orgMaxDepth;
    assert.equal(row.expected.effect, over ? 'refuse' : 'eligible', row.id);
  }
  // Decision 25: nested act rebuilt from the stored root-to-leaf path.
  const act = byId('act-stored-path');
  const actors = [];
  for (let next = act.expected.act; next; next = next.act) actors.push(next.sub);
  assert.deepEqual(actors.reverse(), act.input.storedRootToLeaf);

  // Crypto fixtures: genuine Ed25519 signatures over separately stored JWS parts.
  assert.equal(crypto.format, 'regulait.delegation-generic-crypto.v2');
  for (const key of ['parentTokenBytes', 'nonce']) assert(crypto[key].includes('CANARY'), key);
  for (const [name, jwk] of Object.entries(crypto.publicKeys)) {
    assert(!('d' in jwk), 'private key exported');
    assert.equal(digest(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })), crypto.thumbprints[name]);
  }
  const decoded = {};
  for (const fixture of crypto.fixtures) {
    assert(!('compact' in fixture), `${fixture.id}: compact token must not be stored`);
    const header = JSON.parse(Buffer.from(fixture.protected, 'base64url'));
    const payload = JSON.parse(Buffer.from(fixture.payload, 'base64url'));
    const valid = verify(null, Buffer.from(`${fixture.protected}.${fixture.payload}`),
      createPublicKey({ key: crypto.publicKeys[fixture.signer], format: 'jwk' }), Buffer.from(fixture.signature, 'base64url'));
    assert.equal(valid, fixture.signatureValid, fixture.id);
    assert.equal(header.alg, 'EdDSA');
    if (header.jwk) assert.deepEqual(header.jwk, crypto.publicKeys[fixture.signer]);
    const secrets = [];
    walkSecrets(payload, fixture.id, secrets);
    assert.deepEqual(secrets, [], `fixture secret-shaped values without CANARY: ${secrets.join(', ')}`);
    decoded[fixture.id] = payload;
  }
  assert.equal(decoded['client-assertion-valid'].aud, crypto.endpoint);
  assert(decoded['client-assertion-valid'].exp - decoded['client-assertion-valid'].iat <= 300);
  assert(Array.isArray(decoded['client-assertion-aud-array'].aud));
  assert.equal(crypto.clock - decoded['as-dpop-stale'].iat, 61);
  assert.equal(decoded['rs-dpop-valid'].ath, digest(crypto.parentTokenBytes));
  assert.equal(decoded['delegation-authz-valid'].child_cnf.jkt, crypto.thumbprints.B);
  assert.equal(decoded['delegation-authz-valid'].ath, digest(crypto.parentTokenBytes));
  assert.notEqual(crypto.thumbprints.other, crypto.thumbprints.A);
  assert.deepEqual(decoded['delegation-authz-wrong-key'], decoded['delegation-authz-valid']);
  return { cases: corpus.cases.length, fixtures: crypto.fixtures.length, pending: corpus.cases.filter((r) => r.pendingBranch).length };
}

// Deliberate corruptions the checker must reject (proves it can fail).
export const DELEGATION_MUTATIONS = [
  ['depth_unenforced claims a replay', (c) => { c.corpus.cases.find((r) => r.id === 'child-depth-unenforced').expected.replayClaims = 1; }],
  ['active child exchange made eligible', (c) => { c.corpus.cases.find((x) => x.id === 'child-authorization-valid').profile = 'active'; }],
  ['default lifetime back to one hour', (c) => { c.corpus.cases.find((r) => r.id === 's5-lifetime-default-15-min').expected.grantLifetimeSeconds = 3600; }],
  ['admin treated as member', (c) => { c.corpus.cases.find((r) => r.id === 's5-admin-not-member').expected.errorCode = 'none'; }],
  ['step-up body loses cap', (c) => { c.corpus.cases.find((r) => r.id === 'human-proof-sensitive-write-stepup').expected.actionBodyKeys.splice(6, 1); }],
  ['jti without CANARY', (c) => { c.corpus.cases.find((r) => r.id === 'human-proof-one-use').input.jti = 'plain-jti'; }],
  ['tampered fixture marked valid', (c) => { c.crypto.fixtures.find((f) => f.id === 'client-assertion-tampered-payload').signatureValid = true; }],
  ['pending marker on wrong branch', (c) => { c.corpus.cases.find((r) => r.pendingBranch).pendingBranch = 'main'; }],
  ['hop 10 back to unspecified', (c) => { c.corpus.cases.find((r) => r.id === 'depth-stored-9-max-8').expected = { effect: 'refuse', exactErrorUnspecified: true }; }],
];

export function runDelegationChecks() {
  const loaded = readCorpus();
  const result = checkDelegationCorpus(loaded.corpus, loaded.crypto);
  const rejected = [];
  for (const [name, mutate] of DELEGATION_MUTATIONS) {
    const copy = structuredClone(loaded);
    mutate(copy);
    assert.throws(() => checkDelegationCorpus(copy.corpus, copy.crypto), undefined, `mutation not rejected: ${name}`);
    rejected.push(name);
  }
  return { ...result, mutationsRejected: rejected.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runDelegationChecks();
  console.log(`${r.cases} delegation cases (${r.pending} pending b6-identity-s5); ${r.fixtures} Ed25519 fixtures verified; ${r.mutationsRejected} corruptions rejected. Product conformance unrun.`);
}
