import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const corpus = JSON.parse(readFileSync(new URL('./placement-semantic-corpus.json', import.meta.url), 'utf8'));
const ranks = { L0: 0, L1: 1, L2: 2, L3: 3 };
const kinds = ['mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker'];
const sensitivities = ['public', 'internal', 'confidential', 'regulated'];
const fixedReasons = ['no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired'];
function validate(c) {
  assert.equal(c.format, 'synthetic-placement-semantic-vectors/1');
  assert.equal(c.source.gitBlob, 'e359ffd660f0b023659ae28ded5a4a36cbc443b3');
  assert.equal(c.vectors.length, 89);
  const ids = new Set();
  for (const v of c.vectors) {
    assert.match(v.id, /^[A-Za-z0-9_-]+$/);
    assert(!ids.has(v.id), `duplicate ${v.id}`); ids.add(v.id);
    assert(v.adrSections.length > 0);
    for (const ref of v.adrSections) assert.match(ref, /^(Decision (1|2|3|4|6|7|8|11|14)(\b| )|Test strategy: |Amendment F$)/);
    const q = v.semanticRequest, e = v.expectedProjection;
    assert(q && e && typeof v.note === 'string');
    if (e.requiredClass) {
      assert(e.requiredClass in ranks);
      assert.equal(e.minimumSelectableClass, e.requiredClass);
      const workloadFloor = q.workloadKindFloorOverride ??
        (q.workloadKind === 'code_exec' && ['confidential','regulated'].includes(q.sensitivity) ? 'L3' : 'L2');
      const inputs = [workloadFloor, q.sensitivityFloor, q.autonomyFloor, q.ownProfileFloor,
        ...q.complianceFloors.filter(x => x !== null), q.parentRequiredClass].filter(x => x !== null);
      if (q.agentAssurance !== 'known') inputs.push('L3');
      assert(inputs.every(x => x in ranks));
      assert.equal(ranks[e.requiredClass], Math.max(...inputs.map(x => ranks[x])), v.id);
    }
    if (e.outcome === 'placement_eligible') {
      assert.equal(e.notAnAuthorizationGrant, true);
      assert.equal(e.selectedClassAtLeast, e.requiredClass);
      assert(q.executors.some(x => (ranks[x.class] ?? ranks[x.adminMappedClass]) >= ranks[e.requiredClass]
        && x.profileMatches && x.active && !x.quarantined && x.attestation === 'fresh_passing'), v.id);
    }
    if (e.error === 'execution_profile_unavailable') {
      assert.equal(e.httpStatus, 409); assert.equal(e.ruleId, 'execution-profile');
      assert.equal(e.upstreamContacts, 0);
      if (e.reason) assert(fixedReasons.includes(e.reason));
    }
    if (v.id.startsWith('unknown-')) {
      assert.equal(e.outcome, 'fail_closed_pending_contract');
      assert.equal(e.minimumSelectableClass, null); assert.equal(e.upstreamContacts, 0);
    }
    if (v.id.startsWith('no-fallback-')) {
      assert.equal(e.fallbackAllowed, false); assert.equal(e.requiredClass, 'L3');
      assert.equal(e.outcome, 'refuse'); assert.equal(e.sandboxesStarted, 0);
    }
    if (v.id.startsWith('delegation-')) {
      const lower = ranks[q.childRequestedClass] < ranks[q.parentRequiredClass];
      assert.equal(e.outcome, lower ? 'refuse' : 'isolation_constraint_satisfied');
      assert.equal(e.ruleId, lower ? 'delegation-isolation' : null);
      assert.equal(e.authorizationStillRequired, true);
    }
  }
  for (const w of kinds) for (const s of sensitivities) assert(ids.has(`floor-${w}-${s}`));
  for (const a of ['L1','L2','L3']) for (const b of ['L1','L2','L3']) assert(ids.has(`delegation-${a}-${b}`));
  for (const r of fixedReasons) {
    assert(ids.has(`refusal-${r}`));
    assert.equal(c.vectors.find(v => v.id === `refusal-${r}`).expectedProjection.reason, r);
  }
  const engine = c.vectors.find(v => v.id === 'engine-not-run').expectedProjection;
  assert.equal(engine.engineRunStatus, 'not_run'); assert.equal(engine.engineRunReason, 'isolation_unavailable');
  assert.equal(engine.clean, false);
  const mismatch = c.vectors.find(v => v.id === 'placement-report-mismatch').expectedProjection;
  for (const k of ['sandboxKilled','executorQuarantined','alertRaised']) assert.equal(mismatch[k], true);
  assert.equal(mismatch.inputBytesDelivered, 0);
  const warn = c.vectors.find(v => v.id === 'warn-shortfall').expectedProjection;
  assert.equal(warn.outcome, 'contract_gap'); assert.equal(warn.fallbackAllowed, false);
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const frozen = execFileSync('git', ['hash-object', corpus.source.adrPath], {cwd: root, encoding:'utf8'}).trim();
assert.equal(frozen, corpus.source.gitBlob, 'ADR changed: review citations and expected semantics before use');
validate(corpus);
const mutations = [
 c => { c.vectors.find(v => v.id === 'floor-mcp_stdio-regulated').expectedProjection.requiredClass = 'L2'; },
 c => { c.vectors.find(v => v.id === 'refusal-no_executor').expectedProjection.ruleId = 'other'; },
 c => { c.vectors.find(v => v.id === 'no-fallback-retry').expectedProjection.fallbackAllowed = true; },
 c => { c.vectors = c.vectors.filter(v => v.id !== 'floor-code_exec-confidential'); },
 c => { c.vectors.find(v => v.id === 'delegation-L3-L2').expectedProjection.outcome = 'isolation_constraint_satisfied'; },
 c => { c.vectors.find(v => v.id === 'unknown-sensitivity').expectedProjection.outcome = 'placement_eligible'; },
 c => { c.vectors.find(v => v.id === 'engine-not-run').expectedProjection.engineRunStatus = 'clean'; },
 c => { c.vectors.find(v => v.id === 'placement-report-mismatch').expectedProjection.inputBytesDelivered = 1; },
];
for (const mutate of mutations) { const changed = structuredClone(corpus); mutate(changed); assert.throws(() => validate(changed)); }
console.log(`placement corpus: ${corpus.vectors.length} vectors valid; ${mutations.length} corruption controls rejected; frozen ADR matches`);
