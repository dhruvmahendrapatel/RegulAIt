// ADR-0190 placement vector self-consistency checks. Node built-ins only; imports no product implementation.
// Adopted from X50 (#319) and revised against ADR-0190 on b6-isolation-i3 (amendments K-W; see README.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PENDING = 'b6-isolation-i3@cee8a67c34766abc55fefa7f237dcafe688c99c0';
const ranks = { L0: 0, L1: 1, L2: 2, L3: 3 };
const kinds = ['mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker'];
const sensitivities = ['public', 'internal', 'confidential', 'regulated'];
// The broker's five reasons (decision 7) and the sixth, policy_unresolved (owner decision B, 2026-10-11), which is
// decided before any broker selection, from the request's facts alone.
const brokerReasons = ['no_executor', 'attestation_stale', 'class_below_required', 'executor_quarantined', 'profile_retired'];
const fixedReasons = [...brokerReasons, 'policy_unresolved'];
// Owner decision A (2026-10-11): warn is retired; the only mode a stored value reads as is enforce.
const ENFORCEMENT_MODES = ['enforce'];
const ORIGINS = ['X50', 'X50-revised', 'claude-new'];
const SECTION_RE = /^(Decision (1|2|3|4|6|7|8|11|14)(\b| )|Test strategy: |Amendment [A-W]$)/;
const PENDING_SECTION_RE = /^Amendment [K-W]$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const DOTTED_QUAD_127_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Attestation states the broker never counts: none exists, or the pass predates the re-enable (amendment T).
const UNCOUNTED = new Set(['missing', 'pass_before_reenable', 'pass_at_reenable']);
// Amendment item 12: why an actor's placement no longer holds (the executor not active, quarantined, or stale).
const LIVE_PLACEMENT_FAILURES = ['executor_not_active', 'executor_quarantined', 'executor_attestation_stale'];

export function readPlacementCorpus() {
  return JSON.parse(readFileSync(new URL('./placement-semantic-corpus.json', import.meta.url), 'utf8'));
}

// Decision 3: workload-kind floor. byoc_worker has none of its own ("the class the placement requires").
function workloadFloor(q) {
  if (q.workloadKindFloorOverride) return q.workloadKindFloorOverride;
  if (q.workloadKind === 'code_exec') return ['confidential', 'regulated'].includes(q.sensitivity) ? 'L3' : 'L2';
  if (q.workloadKind === 'byoc_worker') return null;
  return 'L2';
}

function requiredClassOf(q) {
  const inputs = [workloadFloor(q), q.sensitivityFloor, q.autonomyFloor, q.ownProfileFloor,
    ...q.complianceFloors.filter((x) => x !== null), q.parentRequiredClass].filter((x) => x !== null && x !== undefined);
  if (q.agentAssurance !== 'known') inputs.push('L3');
  assert(inputs.every((x) => x in ranks));
  return Object.keys(ranks)[Math.max(...inputs.map((x) => ranks[x]))];
}

// Amendment item 15: the first policy fact that is missing or outside its vocabulary, or null when all resolve.
// An explicitly absent optional fact (null parent, no compliance tags) is not unresolved; a named lookup is.
function unresolvedFact(q) {
  if (q.unresolvedPolicyLookup) return q.unresolvedPolicyLookup;
  if (!kinds.includes(q.workloadKind)) return 'workloadKind';
  if (!sensitivities.includes(q.sensitivity)) return 'sensitivity';
  for (const k of ['sensitivityFloor', 'autonomyFloor', 'ownProfileFloor']) if (!(q[k] in ranks)) return k;
  if (!Array.isArray(q.complianceFloors) || q.complianceFloors.some((x) => x !== null && !(x in ranks))) return 'complianceFloors';
  if (q.parentRequiredClass !== null && q.parentRequiredClass !== undefined && !(q.parentRequiredClass in ranks)) return 'parentRequiredClass';
  return null;
}

const classOf = (e) => (e.class === 'customer_declared' ? e.adminMappedClass : e.class);
const counted = (e) => e.profileMatches && !UNCOUNTED.has(e.attestation);
const fresh = (e) => counted(e) && e.active && e.attestation === 'fresh_passing';

// Decision 7 and amendment P: the most specific reason, or the selected executor.
export function brokerDecision(q, required) {
  if (q.profileRetired || q.profileDigestKnown === false) return { reason: 'profile_retired' };
  if (q.executors.length > 0 && q.executors.every((e) => e.quarantined)) return { reason: 'executor_quarantined' };
  const live = q.executors.filter((e) => !e.quarantined);
  const freshOnes = live.filter(fresh);
  if (freshOnes.length === 0) return { reason: live.some(counted) ? 'attestation_stale' : 'no_executor' };
  const eligible = freshOnes.filter((e) => classOf(e) && ranks[classOf(e)] >= ranks[required]);
  if (eligible.length === 0) return { reason: 'class_below_required' };
  const fewest = Math.min(...eligible.map((e) => e.openOffers ?? 0));
  return { selected: eligible.filter((e) => (e.openOffers ?? 0) === fewest).map((e) => e.id) };
}

function loopback(host) {
  return host === 'localhost' || host === '[::1]' || DOTTED_QUAD_127_RE.test(host);
}

export function checkPlacementCorpus(c) {
  assert.equal(c.format, 'synthetic-placement-semantic-vectors/2');
  assert.equal(c.source.reviewedAgainst.branch, 'b6-isolation-i3');
  const ids = new Set();
  for (const v of c.vectors) {
    assert.match(v.id, ID_RE);
    assert(!ids.has(v.id), `duplicate ${v.id}`);
    ids.add(v.id);
    assert(ORIGINS.includes(v.origin), `${v.id} origin`);
    if (v.origin === 'X50-revised') assert(typeof v.revision === 'string' && v.revision.length > 0, v.id);
    assert(v.adrSections.length > 0);
    for (const ref of v.adrSections) assert.match(ref, SECTION_RE, `${v.id}: ${ref}`);
    const needsPending = v.adrSections.some((s) => PENDING_SECTION_RE.test(s));
    assert.equal(v.pendingBranch, needsPending ? PENDING : undefined, `${v.id} pendingBranch`);
    const q = v.semanticRequest;
    const e = v.expectedProjection;
    assert(q && e && typeof v.note === 'string', v.id);
    if (typeof q.proofJti === 'string') assert(q.proofJti.includes('CANARY'), `${v.id}: secret-shaped jti without CANARY`);
    if (e.requiredClass) {
      assert(e.requiredClass in ranks);
      assert.equal(e.minimumSelectableClass, e.requiredClass, v.id);
      assert.equal(e.requiredClass, requiredClassOf(q), v.id);
    }
    if (e.outcome === 'placement_eligible') {
      assert.equal(e.notAnAuthorizationGrant, true);
      assert.equal(e.selectedClassAtLeast, e.requiredClass);
      const d = brokerDecision(q, e.requiredClass);
      assert(d.selected, `${v.id}: broker would refuse ${d.reason}`);
      if (e.selectedExecutor) assert.deepEqual(d.selected, [e.selectedExecutor], v.id);
    }
    if (e.error === 'execution_profile_unavailable') {
      assert.equal(e.httpStatus, 409);
      assert.equal(e.ruleId, 'execution-profile');
      assert.equal(e.upstreamContacts, 0);
      if (e.reason) {
        assert(fixedReasons.includes(e.reason));
        if (e.reason === 'policy_unresolved') {
          // decided before any offer: a fact that does not resolve, no class, no offer
          assert(unresolvedFact(q), `${v.id}: policy_unresolved needs an unresolved fact`);
          assert.equal(e.minimumSelectableClass, null, v.id);
          assert.equal(e.offersMade, 0, v.id);
          assert.equal(e.auditAction, 'execution-refused', v.id);
        } else if (Array.isArray(q.executors)) assert.equal(brokerDecision(q, e.requiredClass).reason, e.reason, v.id);
      }
    }
    if (e.requiredClass || e.outcome === 'placement_eligible') assert.equal(unresolvedFact(q), null, `${v.id}: a class from an unresolved fact`);
    if (q.enforcement !== undefined && !ENFORCEMENT_MODES.includes(q.enforcement)) {
      // a retired mode (owner decision A) is read as enforce and can no longer be set
      assert.equal(e.enforcementRead, 'enforce', v.id);
      assert.equal(e.settingWriteStatus, 400, v.id);
      assert.notEqual(e.outcome, 'placement_eligible', v.id);
    }
    if (v.id.startsWith('unknown-')) {
      assert.equal(e.outcome, 'refuse');
      assert.equal(e.error, 'execution_profile_unavailable');
      assert.equal(e.reason, 'policy_unresolved');
      assert.equal(e.minimumSelectableClass, null);
      assert.equal(e.upstreamContacts, 0);
    }
    if (v.id.startsWith('no-fallback-')) {
      assert.equal(e.fallbackAllowed, false);
      assert.equal(e.requiredClass, 'L3');
      assert.equal(e.outcome, 'refuse');
      assert.equal(e.sandboxesStarted, 0);
    }
    if (v.id.startsWith('delegation-')) {
      const lower = ranks[q.childRequestedClass] < ranks[q.parentRequiredClass];
      assert.equal(e.outcome, lower ? 'refuse' : 'isolation_constraint_satisfied');
      assert.equal(e.ruleId, lower ? 'delegation-isolation' : null);
      assert.equal(e.authorizationStillRequired, true);
      // amendment item 11 (pinned by slice I2): the token-endpoint shape, nothing created, the refusal audited
      if (lower && e.gap === null) {
        assert.deepEqual(e.tokenEndpoint, { error: 'invalid_grant', errorCode: 'delegation_isolation' }, v.id);
        assert.equal(e.grantsCreated, 0, v.id);
        assert.equal(e.auditRuleId, 'delegation-isolation', v.id);
      }
      // a child that names no class inherits its parent's (decision 8)
      if (e.storedChildClass !== undefined) assert.equal(e.storedChildClass, q.childRequestedClass ?? q.parentRequiredClass, v.id);
    }
    // review M1 (slice I2): an actor's placement holds only while its executor attests at the STRICTER of the grant's
    // class and the placement's own requirement; recomputed here wherever a vector states the three classes
    if (Array.isArray(q.actorPlacements) && q.actorPlacements.some((a) => a.attestedClass !== undefined)) {
      const failure = q.actorPlacements
        .map((a) => {
          if (a.executorQuarantined) return 'executor_quarantined';
          if (!a.executorActive) return 'executor_not_active';
          const needed = Math.max(ranks[a.grantClass] ?? 0, ranks[a.placementRequiredClass]);
          return a.attestation !== 'fresh_passing' || ranks[a.attestedClass] < needed ? 'executor_attestation_stale' : null;
        })
        .find((f) => f !== null) ?? null;
      assert.equal(e.liveFailure, failure, v.id);
      assert.equal(e.outcome, failure ? 'refuse' : 'live', v.id);
    }
    // amendment item 12 (pinned by slice I2): the live-chain refusal is actor-chain-invalid, nothing reaches the upstream
    if (v.id.startsWith('middle-actor-') && e.gap === null) {
      assert.equal(e.outcome, 'refuse', v.id);
      assert.equal(e.ruleId, 'actor-chain-invalid', v.id);
      assert.equal(e.upstreamContacts, 0, v.id);
      assert(LIVE_PLACEMENT_FAILURES.includes(e.liveFailure), v.id);
    }
    if (v.id.startsWith('reenable-') && q.executors) {
      for (const x of q.executors) if (x.reenabledAt !== undefined && x.lastPassObservedAt !== undefined)
        assert.equal(x.attestation === 'fresh_passing', x.lastPassObservedAt > x.reenabledAt, `${v.id}: observed_at > reenabled_at`);
    }
    if (v.id.startsWith('executor-url-') && e.outcome !== 'contract_gap') {
      const url = new URL(q.REGULAIT_GATEWAY_URL);
      const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && (loopback(url.hostname) || q.REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP === '1'));
      assert.equal(e.outcome, allowed ? 'start' : 'refuse_start', v.id);
    }
    if (v.id.startsWith('channel-proof-iat-') || v.id.startsWith('channel-proof-future-')) {
      const ok = (q.proofAgeSeconds ?? 0) <= 60 && (q.proofFutureSeconds ?? 0) <= 5;
      assert.equal(e.outcome, ok ? 'authenticated' : 'refuse', v.id);
    }
    if (v.id.startsWith('report-') && e.outcome === 'report_fail') {
      const required = ['runtime_identity'];
      if (q.backend === 'gvisor' || q.claimedClass === 'user_space_kernel') required.push('runtime_config');
      assert(required.includes(e.missingProbe) && !q.probesPresent.includes(e.missingProbe), v.id);
      assert(!q.profileProbesList.includes(e.missingProbe), `${v.id}: the profile must not list the probe it lacks`);
    }
  }
  for (const w of kinds) for (const s of sensitivities) assert(ids.has(`floor-${w}-${s}`));
  for (const a of ['L1', 'L2', 'L3']) for (const b of ['L1', 'L2', 'L3']) assert(ids.has(`delegation-${a}-${b}`));
  for (const r of fixedReasons) {
    assert(ids.has(`refusal-${r}`));
    assert.equal(c.vectors.find((v) => v.id === `refusal-${r}`).expectedProjection.reason, r);
  }
  for (const family of ['precedence-', 'reenable-', 'report-', 'profile-schema-', 'executor-url-', 'channel-', 'offer-'])
    assert(c.vectors.some((v) => v.id.startsWith(family)), `missing family ${family}`);
  const get = (id) => c.vectors.find((v) => v.id === id).expectedProjection;
  const engine = get('engine-not-run');
  assert.equal(engine.engineRunStatus, 'not_run');
  assert.equal(engine.engineRunReason, 'isolation_unavailable');
  assert.equal(engine.clean, false);
  const mismatch = get('placement-report-mismatch');
  for (const k of ['sandboxKilled', 'executorQuarantined', 'alertRaised', 'openOffersWithdrawn']) assert.equal(mismatch[k], true);
  assert.equal(mismatch.inputBytesDelivered, 0);
  assert.equal(mismatch.alertSeverity, 'high');
  const warn = get('warn-shortfall');
  assert.equal(warn.outcome, 'refuse');
  assert.equal(warn.reason, 'class_below_required');
  assert.equal(warn.enforcementRead, 'enforce');
  assert.equal(warn.fallbackAllowed, false);
  assert.equal(get('selftest-while-quarantined').error, 'executor_quarantined');
  assert.equal(get('channel-unproven-large-body').bodyBytesRead, 0);
  for (const id of ['profile-schema-omits-runtime_identity', 'profile-schema-omits-runtime_config']) assert.equal(get(id).outcome, 'refuse');
  return { vectors: c.vectors.length, pending: c.vectors.filter((v) => v.pendingBranch).length };
}

const find = (c, id) => c.vectors.find((v) => v.id === id);
export const PLACEMENT_MUTATIONS = [
  ['regulated stdio floor lowered', (c) => { find(c, 'floor-mcp_stdio-regulated').expectedProjection.requiredClass = 'L2'; }],
  ['refusal rule renamed', (c) => { find(c, 'refusal-no_executor').expectedProjection.ruleId = 'other'; }],
  ['fallback allowed on retry', (c) => { find(c, 'no-fallback-retry').expectedProjection.fallbackAllowed = true; }],
  ['matrix row removed', (c) => { c.vectors = c.vectors.filter((v) => v.id !== 'floor-code_exec-confidential'); }],
  ['lower child admitted', (c) => { find(c, 'delegation-L3-L2').expectedProjection.outcome = 'isolation_constraint_satisfied'; }],
  ['unknown fact made eligible', (c) => { find(c, 'unknown-sensitivity').expectedProjection.outcome = 'placement_eligible'; }],
  ['engine run marked clean', (c) => { find(c, 'engine-not-run').expectedProjection.engineRunStatus = 'clean'; }],
  ['mismatch delivers input', (c) => { find(c, 'placement-report-mismatch').expectedProjection.inputBytesDelivered = 1; }],
  ['pre-reenable pass counted', (c) => { find(c, 'reenable-old-pass-not-counted').semanticRequest.executors[0].attestation = 'fresh_passing'; }],
  ['precedence swapped', (c) => { find(c, 'precedence-quarantined-and-stale').expectedProjection.reason = 'executor_quarantined'; }],
  ['plain http remote accepted', (c) => { find(c, 'executor-url-http-remote').expectedProjection = { outcome: 'start', insecureFlagLogged: false }; }],
  ['proof 61 s old accepted', (c) => { find(c, 'channel-proof-iat-61').expectedProjection = { outcome: 'authenticated' }; }],
  ['pending marker dropped', (c) => { delete find(c, 'reenable-new-pass').pendingBranch; }],
  ['busy executor selected', (c) => { find(c, 'select-fewest-open-offers').expectedProjection.selectedExecutor = 'e-busy'; }],
  // owner decisions A and B (2026-10-11)
  ['unresolved fact given a capacity reason', (c) => { find(c, 'unknown-missing-sensitivity').expectedProjection.reason = 'no_executor'; }],
  ['unresolved fact defaulted to a class', (c) => { find(c, 'unknown-autonomyFloor').expectedProjection.minimumSelectableClass = 'L2'; }],
  ['policy_unresolved on resolved facts', (c) => { const q = find(c, 'refusal-policy_unresolved').semanticRequest; delete q.unresolvedPolicyLookup; q.sensitivityFloor = 'L2'; }],
  ['warn placed below its class', (c) => { find(c, 'warn-shortfall').expectedProjection.outcome = 'placement_eligible'; }],
  ['warn still settable', (c) => { find(c, 'warn-shortfall').expectedProjection.settingWriteStatus = 200; }],
  // amendment items 11 and 12, pinned by slice I2
  ['delegation refusal not invalid_grant', (c) => { find(c, 'delegation-L3-L2').expectedProjection.tokenEndpoint.error = 'invalid_request'; }],
  ['refused child created', (c) => { find(c, 'delegation-L2-L1').expectedProjection.grantsCreated = 1; }],
  ['live-chain refusal under another rule', (c) => { find(c, 'middle-actor-executor-stale').expectedProjection.ruleId = 'execution-profile'; }],
  ['child inherits a lower class', (c) => { find(c, 'delegation-L3-inherit').expectedProjection.storedChildClass = 'L2'; }],
  ['placement class ignored at use', (c) => { const e = find(c, 'middle-actor-attested-below-placement').expectedProjection; e.outcome = 'live'; e.liveFailure = null; }],
  ['relaxed sensitivity lowers code_exec', (c) => { const e = find(c, 'code_exec-relaxed-sensitivity-keeps-L3').expectedProjection; e.requiredClass = 'L1'; e.minimumSelectableClass = 'L1'; e.selectedClassAtLeast = 'L1'; }],
];

export function runPlacementChecks() {
  const corpus = readPlacementCorpus();
  const result = checkPlacementCorpus(corpus);
  for (const [name, mutate] of PLACEMENT_MUTATIONS) {
    const changed = structuredClone(corpus);
    mutate(changed);
    assert.throws(() => checkPlacementCorpus(changed), undefined, `mutation not rejected: ${name}`);
  }
  return { ...result, mutationsRejected: PLACEMENT_MUTATIONS.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runPlacementChecks();
  console.log(`placement corpus: ${r.vectors} vectors valid (${r.pending} pending b6-isolation-i3); ${r.mutationsRejected} corruption controls rejected. Not I2 conformance.`);
}
