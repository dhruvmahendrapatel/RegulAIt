// ADR-0189 spike B0. Run: `npm test` (Node 22+, for the canonicalJson import) or, offline, `npm run test:offline`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';
import { buildValidators, findEmails } from './validators.mjs';
import { normalise, renderAll, renderCycloneDx, renderSpdx } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(path.join(here, p), 'utf8'));
const recordsA = read('fixtures/records-a.json');
const recordsB = read('fixtures/records-b.json');
const validators = buildValidators();
// The product canonicaliser of every existing digest (ADR-0060), imported from source by Node's type stripping.
const { canonicalJson } = await import('../../packages/shared/src/audit-chain.ts');

// ------------------------------------------------------------------------------------------------ offline guard
test('offline: when B0_EXPECT_OFFLINE=1 the process has no network at all', { skip: process.env.B0_EXPECT_OFFLINE !== '1' }, async () => {
  const outcome = await new Promise((resolve) => {
    const s = connect({ host: '104.16.0.35', port: 443, timeout: 3000 }); // a registry address; must be unreachable
    s.on('connect', () => { s.destroy(); resolve('connected'); });
    s.on('error', (e) => resolve(e.code));
    s.on('timeout', () => { s.destroy(); resolve('timeout'); });
  });
  assert.notEqual(outcome, 'connected');
});

// ------------------------------------------------------------------------------------------------ item 1
test('item 1: cyclonedx-library 10.3.0 model lacks the ML-BOM fields, and its serializer drops them', () => {
  const r = JSON.parse(execFileSync(process.execPath, [path.join(here, 'model-check.mjs')], { encoding: 'utf8' }));
  assert.equal(r.library, '@cyclonedx/cyclonedx-library@10.3.0');
  for (const f of ['formulation', 'declarations', 'definitions', 'compositions']) assert.ok(r.absent.Bom.includes(f), f);
  for (const f of ['modelCard', 'data']) assert.ok(r.absent.Component.includes(f), f);
  for (const f of ['endpoints', 'data', 'trustZone']) assert.ok(r.absent.Service.includes(f), f);
  assert.equal(r.positiveControlEmitted, true, 'a known field set the same way must be emitted (non-vacuity)');
  assert.ok(Object.values(r.droppedOnSerialize).every(Boolean), JSON.stringify(r.droppedOnSerialize));
  assert.equal(r.externalReferenceTypeHasModelCard, true);
  assert.match(r.libraryStrictJsonValidator, /MissingOptionalDependencyError/);
});

// ------------------------------------------------------------------------------------------------ item 2
const sample = renderAll(recordsA);
const docs = Object.fromEntries(['cyclonedx-1.7', 'cyclonedx-1.6', 'spdx-3.0.1'].map((k) => [k, JSON.parse(sample.bytes[k])]));

test('item 2: the sample renders validate against the bundled 1.7, 1.6 and vendored SPDX 3.0.1 schemas', () => {
  for (const [k, d] of Object.entries(docs)) {
    const r = validators[k](d);
    assert.equal(r.valid, true, `${k}: ${JSON.stringify(r.errors.slice(0, 3))}`);
  }
});

test('item 2: the vendored SPDX schema is the recorded file', async () => {
  const { createHash } = await import('node:crypto');
  const h = (p) => createHash('sha256').update(readFileSync(path.join(here, p))).digest('hex');
  assert.equal(h('schemas/spdx-3.0.1-json-schema.json'), '582c64e809d5b3ef9bd0c4de13a32391b47b0284a3e8d199569fb96f649234b1');
  assert.equal(h('schemas/spdx-3.0.1-model.ttl'), '30ebb4af2d70a9809044ef46f44cc3dc5125226d70f818a50ed2e1d5f404c593');
  assert.equal(h('schemas/spdx-3.0.1-context.jsonld'), 'c72b0928f094c83e5c127784edb1ebca2af74a104fcacc007c332b23cbc788bd');
});

const mutate = (doc, fn) => { const d = structuredClone(doc); fn(d); return d; };
const dataComponent = (d) => d.components.find((c) => c.type === 'data' && c.data?.[0]?.governance);
const flowService = (d) => d.services.find((s) => s.data);

test('item 2: negative controls: every one of these is REJECTED by both CycloneDX validators', () => {
  const cases = {
    'an email anywhere (idn-email reject-all)': (d) => { dataComponent(d).data[0].governance.owners[0].contact.email = 'someone@example.com'; },
    'an unknown key on a component': (d) => { d.components[0].modelCard_typo = {}; },
    'an unknown key inside modelCard': (d) => { d.components.find((c) => c.modelCard).modelCard.notAField = 1; },
    'a bad data-flow enum': (d) => { flowService(d).data[0].flow = 'sideways'; },
    'a non-ASCII IRI in a service endpoint (our iri-reference = uri-reference)': (d) => { flowService(d).endpoints = ['https://例え.example/パス'] },
    'a malformed SHA-256': (d) => { d.components.find((c) => c.hashes).hashes[0].content = 'xyz'; },
    'a bad serialNumber': (d) => { d.serialNumber = 'not-a-urn'; },
  };
  for (const v of ['cyclonedx-1.7', 'cyclonedx-1.6']) {
    for (const [name, fn] of Object.entries(cases)) assert.equal(validators[v](mutate(docs[v], fn)).valid, false, `${v}: ${name}`);
  }
});

test('item 2: the upstream library\'s iri-reference choice (accept every value) would let a non-IRI through', () => {
  const lax = buildValidators({ iriReference: 'accept-all' });
  const bad = mutate(docs['cyclonedx-1.7'], (d) => { flowService(d).endpoints = ['not a reference at all \u0000']; });
  assert.equal(lax['cyclonedx-1.7'](bad).valid, true, 'accept-all lets it through');
  assert.equal(validators['cyclonedx-1.7'](bad).valid, false, 'our format refuses it');
});

test('item 2: negative controls: each is REJECTED by the SPDX 3.0.1 schema', () => {
  const pkg = (d) => d['@graph'].find((x) => x.type === 'ai_AIPackage');
  const cases = {
    'fractional seconds in created': (d) => { d['@graph'][0].created = '2026-10-10T09:15:27.481Z'; },
    'a bad autonomyType enum': (d) => { pkg(d).ai_autonomyType = 'maybe'; },
    'an unknown property': (d) => { pkg(d).notAField = 1; },
    'a dataset without datasetType': (d) => { delete d['@graph'].find((x) => x.type === 'dataset_DatasetPackage').dataset_datasetType; },
    'a wrong @context': (d) => { d['@context'] = 'https://spdx.org/rdf/3.0.0/spdx-context.jsonld'; },
  };
  for (const [name, fn] of Object.entries(cases)) assert.equal(validators['spdx-3.0.1'](mutate(docs['spdx-3.0.1'], fn)).valid, false, name);
});

test('item 2: the sample carries no email-shaped string at all', () => {
  for (const [k, b] of Object.entries(sample.bytes)) assert.doesNotMatch(b, /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i, k);
});

// ------------------------------------------------------------------------------------------------ item 3
const hex = (n, seed) => { let x = seed >>> 0; let o = ''; for (let i = 0; i < n; i += 1) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; o += (x >>> 28).toString(16); } return o; };
const uuid = (s) => { const h = hex(32, s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const pick = (arr, i) => arr[i % arr.length];

/** A `regulait.decision-bom.v1`-shaped body (ADR-0189 §2), every section, varied by i. */
function decisionBom(i) {
  const notRecorded = (reason) => ({ status: 'not_recorded', reason });
  const preIdentity = i % 5 === 0;
  return {
    v: 'regulait.decision-bom.v1',
    decision: { auditId: uuid(i), seq: 100000 + i * 13, at: new Date(Date.UTC(2026, 9, 1, 0, 0, i % 60, i % 1000)).toISOString(), objectType: pick(['mcp_tool', 'connector', 'agent', 'approval'], i), objectId: i % 3 ? uuid(i + 1) : null, serverId: i % 2 ? uuid(i + 2) : null, toolName: i % 7 ? `tool_${i}.read-file` : null, effect: pick(['allow', 'deny', 'require_approval'], i), ruleId: i % 4 ? `rule-${i}` : null, ruleChain: Array.from({ length: i % 4 }, (_, k) => `rule-${i}-${k}`) },
    receipt: { receiptSeq: i + 1, payloadSha256: hex(64, i + 3), keyId: `receipt-key-${i % 2}` },
    principal: { sponsorUserId: uuid(i + 4) },
    actors: preIdentity ? notRecorded('pre_identity') : {
      chain: Array.from({ length: 1 + (i % 3) }, (_, k) => `spiffe://tenant.example/regulait/${pick(['agent', 'worker', 'lead'], k)}/${uuid(i * 10 + k)}`),
      delegationGrantId: uuid(i + 5), path: Array.from({ length: 1 + (i % 3) }, (_, k) => uuid(i * 20 + k)), depth: 1 + (i % 3),
      scope: { tools: [`tool_${i}`], projects: [uuid(i + 6)] }, capMicroUsd: 2500000 + i, bindingKind: pick(['dpop', 'mtls'], i), thumbprint: hex(43, i + 7), authCredentialId: uuid(i + 8),
    },
    action: { argumentsDigest: hex(64, i + 9), contextDigest: hex(64, i + 10), target: { server: `srv-${i}`, tool: `tool_${i}`, model: 'alpha-large' }, inputs: [{ kind: 'prompt_commit', hash: hex(64, i + 11) }, { kind: 'dataset', version: `v${i % 9}`, checksum: hex(64, i + 12) }], dataSensitivity: pick(['public', 'internal', 'confidential', 'restricted'], i), complianceProfile: pick(['none', 'hipaa', 'gdpr'], i) },
    policy: { epoch: i, abac: [{ id: uuid(i + 13), version: i % 9, schemaVersion: 2 }], configVersionId: uuid(i + 14), canaryBucket: i % 100, guardrail: `gr-${i % 3}`, modelRuleIds: [`mr-${i}`], killSwitch: pick(['off', 'read_only', 'halt'], i) },
    model: { agentId: uuid(i + 15), provider: 'provider-alpha', requested: 'alpha-large', served: 'alpha-large-2026-08-01', pinned: i % 2 ? 'alpha-large-2026-08-01' : null, modelCardId: `mc-${i % 4}`, approvalId: uuid(i + 16), aiBomSnapshot: { serial: `urn:uuid:${uuid(i + 17)}`, version: 1 + (i % 5), sha256: hex(64, i + 18) } },
    approval: i % 3 ? notRecorded('not_applicable') : { id: uuid(i + 19), quorum: 2, deciders: [{ userId: uuid(i + 20), stepUp: 'passkey', signedDigest: hex(64, i + 21), credentialId: hex(22, i + 22) }, { userId: uuid(i + 23), stepUp: 'totp', signedDigest: null, credentialId: null }] },
    outcome: { status: pick(['ok', 'refused', 'error'], i), refusalCode: i % 3 === 1 ? 'policy_denied' : null, upstreamStatusClass: pick(['2xx', '4xx', '5xx', null], i), verification: null },
    cost: { usageEventIds: [uuid(i + 24)], tokensIn: 1000 + i, tokensOut: 50 + i, costMicroUsd: 12345 * (i + 1) },
    trace: { traceId: hex(32, i + 25), spanIds: [hex(16, i + 26), hex(16, i + 27)] },
    proof: { chain: Array.from({ length: 1 + (i % 4) }, (_, k) => ({ seq: 100000 + i * 13 + k, contentHash: hex(64, i + 30 + k), prevHash: hex(64, i + 40 + k), rowHash: hex(64, i + 50 + k) })), anchor: i % 6 ? { rowHash: hex(64, i + 60), destination: 's3-object-lock', externalRef: `anchors/${i}`, flushedAt: '2026-10-01T00:05:00.000Z' } : { status: 'absent' }, rfc3161: i % 2 ? { tokenB64: Buffer.from(hex(64, i + 70), 'hex').toString('base64') } : null },
    completeness: { actors: preIdentity ? 'not_recorded' : 'recorded', approval: i % 3 ? 'not_applicable' : 'recorded' },
    basis: { auditSeq: 100000 + i * 13, anchorId: uuid(i + 80), receiptSeq: i + 1, aiBomSnapshotId: uuid(i + 81), supersedes: i % 4 ? null : uuid(i + 82) },
    labels: { note: pick(['plain', 'quote " backslash \\ nl \n tab \t', 'non-ASCII é € 漢字 😀  ', '</script><!--', '\u0000\u001f\u007f'], i) },
  };
}
const reversedKeys = (v) => {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).reverse()) o[k] = reversedKeys(v[k]); return o; }
  return v;
};

test('item 3: canonicalize is byte-identical to canonicalJson on BOM shapes (Decision BOM, native AI BOM, renderings)', () => {
  const corpus = [];
  for (let i = 0; i < 600; i += 1) corpus.push(decisionBom(i));
  for (const k of Object.keys(sample.bytes)) corpus.push(JSON.parse(sample.bytes[k]));
  corpus.push(normalise(recordsA), normalise(recordsB), recordsA, recordsB);
  corpus.push(renderCycloneDx(normalise(recordsB), '1.7'), renderSpdx(normalise(recordsB)));
  let n = 0;
  for (const body of corpus) {
    const ours = canonicalJson(body);
    assert.equal(canonicalize(body), ours);
    assert.equal(canonicalize(reversedKeys(body)), ours);
    assert.equal(canonicalize(JSON.parse(ours)), ours, 'stored bytes re-parse to the same bytes (idempotent)');
    n += 1;
  }
  assert.ok(n >= 600);
});

test('item 3: what canonicalisation does NOT protect: floats and the jsonb hazard (why money is integer micro-USD and bodies are stored as text)', () => {
  // 0.1+0.2 canonicalises fine but is not the decimal anyone meant; integers are exact
  assert.equal(canonicalize({ usd: 0.1 + 0.2 }), '{"usd":0.30000000000000004}');
  assert.equal(canonicalize({ microUsd: 300000 }), '{"microUsd":300000}');
  // an integer above 2^53 does not survive JSON.parse: refused by construction in the builder (sizes are < 2^53)
  assert.notEqual(String(JSON.parse('{"n":9007199254740993}').n), '9007199254740993');
  assert.ok(Number.isSafeInteger(13421772800));
});

// ------------------------------------------------------------------------------------------------ item 4
test('item 4: same records twice in one process -> identical bytes and signature', () => {
  const again = renderAll(recordsA);
  assert.deepEqual(again.bytes, sample.bytes);
  assert.equal(again.signature, sample.signature);
});

test('item 4: a second replica\'s row/key order (records-b) -> identical bytes', () => {
  assert.notEqual(JSON.stringify(recordsA), JSON.stringify(recordsB), 'the inputs really differ as text');
  assert.deepEqual(renderAll(recordsB).bytes, sample.bytes);
});

test('item 4: non-vacuity: one changed fact changes the bytes; skipping normalisation changes them for records-b', () => {
  const changed = structuredClone(recordsA);
  changed.datasets[0].checksum = 'c'.repeat(64);
  assert.notEqual(renderAll(changed).sha256.native, sample.sha256.native);
  // list order: model-card lists pass straight into modelCard.considerations, so unsorted input reorders them
  const unsorted = (r) => canonicalize(renderCycloneDx({ ...normalise(r), modelCards: r.modelCards }, '1.7'));
  assert.notEqual(unsorted(recordsA), unsorted(recordsB), 'normalise() list sorting is load-bearing');
  // key order: the native body carries input objects; plain JSON.stringify would follow replica B's key order
  assert.notEqual(JSON.stringify(normalise(recordsB)), JSON.stringify(normalise(recordsA)), 'key order differs as text');
  assert.equal(canonicalize(normalise(recordsB)), canonicalize(normalise(recordsA)), 'RFC 8785 removes it');
});

const nodes = ['/opt/node20/bin/node', '/opt/node21/bin/node', '/opt/node22/bin/node', process.execPath].filter((p, i, a) => existsSync(p) && a.indexOf(p) === i);
test('item 4: fresh processes, both inputs, every available Node major -> identical hashes and signature', { skip: nodes.length < 2 && 'needs two Node binaries' }, () => {
  const results = [];
  for (const bin of nodes) {
    for (const f of ['fixtures/records-a.json', 'fixtures/records-b.json']) {
      results.push({ f, ...JSON.parse(execFileSync(bin, [path.join(here, 'render-cli.mjs'), path.join(here, f)], { encoding: 'utf8' })) });
    }
  }
  const majors = new Set(results.map((r) => r.node.split('.')[0]));
  assert.ok(majors.size >= 2, `need >=2 Node majors, got ${[...majors]}`);
  for (const r of results) {
    assert.deepEqual(r.sha256, sample.sha256, `${r.node} ${r.f}`);
    assert.equal(r.signature, sample.signature, `${r.node} ${r.f}`);
  }
  console.log(JSON.stringify({ processes: results.length, nodes: [...new Set(results.map((r) => r.node))], sha256: sample.sha256 }));
});

// ------------------------------------------------------------------------------------------------ review fixes (PR #265)
const cdx17 = (r) => JSON.parse(renderAll(r).bytes['cyclonedx-1.7']);
const spdxOf = (r) => JSON.parse(renderAll(r).bytes['spdx-3.0.1']);

test('review R10: an email in ANY string or key is refused by the whole-document scan, naming the path', () => {
  const email = 'someone@example.com';
  const cases = {
    'the use-case name': (r) => { r.useCase.name = `claims triage (owner ${email})`; },
    'a model-card limitation': (r) => { r.modelCards[0].limitations.push(`ask ${email}`); },
    'a properties[].value (requested model)': (r) => { r.agents[0].requestedModel = email; },
    'an object key carried into the native body': (r) => { r.agents[0][email] = 'x'; },
    'an internationalised address': (r) => { r.useCase.name = 'ü@例え.テスト'; },
  };
  for (const [name, fn] of Object.entries(cases)) {
    const r = structuredClone(recordsA);
    fn(r);
    assert.throws(() => renderAll(r), /email-shaped string in .* at \$/, name);
  }
});

test('review R10: non-vacuity: the schema validators alone ACCEPT an email in an ordinary string field', () => {
  // the gap the scan closes: idn-email only covers fields the schema types as email
  const d = mutate(docs['cyclonedx-1.7'], (x) => { x.metadata.component.name = 'someone@example.com'; });
  assert.equal(validators['cyclonedx-1.7'](d).valid, true);
  assert.deepEqual(findEmails(d), ['$.metadata.component.name']);
  for (const [k, b] of Object.entries(sample.bytes)) assert.deepEqual(findEmails(JSON.parse(b)), [], k);
});

test('review: a model card with no dataClaims renders, as provenance unknown, and validates', () => {
  const r = structuredClone(recordsA);
  delete r.modelCards[0].dataClaims;
  const out = renderAll(r);
  const d = JSON.parse(out.bytes['cyclonedx-1.7']);
  const model = d.components.find((c) => c.modelCard);
  assert.ok(model.properties.some((p) => p.name === 'regulait:trainingData:provenance' && p.value === 'unknown'));
  assert.ok(!model.modelCard.properties.some((p) => p.name === 'regulait:trainingData:source'));
  for (const k of ['cyclonedx-1.7', 'cyclonedx-1.6', 'spdx-3.0.1']) assert.equal(validators[k](JSON.parse(out.bytes[k])).valid, true, k);
  const withCard = r.agents.find((a) => a.modelCardId);
  const pkg = JSON.parse(out.bytes['spdx-3.0.1'])['@graph'].find((x) => x.spdxId?.endsWith(`agent-${withCard.id}`));
  assert.equal(pkg.ai_informationAboutTraining, 'unknown');
});

test('review R11: PII verdicts map from the persisted vocabulary clean | flagged | blocked', () => {
  const at = (verdict) => {
    const r = structuredClone(recordsA);
    r.datasets.forEach((d) => { d.piiVerdict = verdict; });
    const c = cdx17(r).components.filter((x) => x.type === 'data' && x.data[0].type === 'dataset');
    const s = spdxOf(r)['@graph'].filter((x) => x.type === 'dataset_DatasetPackage');
    return {
      cdx: [...new Set(c.map((x) => JSON.stringify(x.data[0].sensitiveData)))],
      spdx: [...new Set(s.map((x) => x.dataset_hasSensitivePersonalInformation))],
    };
  };
  assert.deepEqual(at('flagged'), { cdx: ['["pii"]'], spdx: ['yes'] });
  assert.deepEqual(at('blocked'), { cdx: ['["pii"]'], spdx: ['yes'] });
  assert.deepEqual(at('clean'), { cdx: ['[]'], spdx: ['noAssertion'] });
  for (const bad of ['contains_pii', 'unknown', null]) assert.throws(() => at(bad), /unknown pii_verdict/, String(bad));
});

test('review R12: two scans by one engine at different versions stay two scanner components, each attested exactly', () => {
  const d = docs['cyclonedx-1.7'];
  const containers = d.components.filter((c) => c.type === 'container');
  assert.deepEqual(containers.map((c) => `${c.name} ${c.version}`).sort(), ['model-scanner 1.4.2', 'model-scanner 1.5.0']);
  assert.equal(new Set(containers.map((c) => c.hashes[0].content)).size, 2);
  const assessors = new Set(d.declarations.assessors.map((a) => a['bom-ref']));
  for (const scan of recordsA.artifactScans) {
    const att = d.declarations.attestations.find((a) => a.map[0].claims[0] === `claim:${scan.id}`);
    assert.equal(att.assessor, `assessor:${scan.engine}/${scan.engineVersion}/${scan.imageDigest.replace(/^sha256:/, '')}`);
    assert.ok(assessors.has(att.assessor));
  }
});

test('review R12: every model_card_evidence kind (eval_run, external, engine_scan) becomes a claim, evidence and attestation', () => {
  const d = docs['cyclonedx-1.7'].declarations;
  for (const e of recordsA.modelCardEvidence) {
    const claim = d.claims.find((c) => c['bom-ref'] === `claim:mce:${e.id}`);
    assert.ok(claim, e.id);
    assert.equal(claim.target, `modelcard:${e.modelCardId}`);
    assert.ok(d.evidence.some((x) => x['bom-ref'] === `evidence:mce:${e.id}`), e.id);
    assert.ok(d.attestations.some((a) => a.map[0].claims.includes(`claim:mce:${e.id}`)), e.id);
  }
  assert.deepEqual([...new Set(recordsA.modelCardEvidence.map((e) => e.kind))].sort(), ['engine_scan', 'eval_run', 'external']);
  const scanEv = d.claims.find((c) => c['bom-ref'] === 'claim:mce:mce-3');
  assert.ok(scanEv.evidence.includes('evidence:scan-4'), 'engine_scan evidence links its artifact scan');
  assert.ok(d.assessors.some((a) => a['bom-ref'] === 'assessor:external' && a.thirdParty === true));
  const broken = structuredClone(recordsA);
  broken.modelCardEvidence.find((e) => e.kind === 'engine_scan').artifactScanId = 'scan-missing';
  assert.throws(() => renderAll(broken), /has no artifact scan/);
  const unknownKind = structuredClone(recordsA);
  unknownKind.modelCardEvidence[0].kind = 'vibes';
  assert.throws(() => renderAll(unknownKind), /unknown model_card_evidence kind/);
});

const python = ['/usr/local/bin/python3', '/usr/bin/python3'].find((p) => existsSync(p));
test('review R13: the offline SPDX driver FAILS when given no documents', { skip: !python && 'needs python3' }, () => {
  const driver = path.join(here, 'spdx3', 'run_offline.py');
  const r = spawnSync(python, ['-I', driver], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no SPDX documents given/);
  // non-vacuity: with a document argument the driver gets past the check (and then needs the venv's libraries)
  const withDoc = spawnSync(python, ['-I', driver, path.join(here, 'evidence', 'sample.spdx-3.0.1.json')], { encoding: 'utf8' });
  assert.notEqual(withDoc.status, 2);
});
