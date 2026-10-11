/** Independent DTO review of PR #307, frozen 19b80068; no HTTP or crypto claims.
 * Build @regulait/shared at the target revision first, then run:
 * node apps/web/review/x48-b4-contract-counterexamples.mjs [checkout] [--expect-fixed]
 * Default records the frozen regressions; --expect-fixed is the owner-fix gate.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? process.cwd();
const fixed = process.argv.includes('--expect-fixed');
const {
  bomVerifyResponseSchema, BOM_VERIFY_CHECKS, AI_BOM_ONLY_CHECKS,
  DECISION_BOM_SECTIONS, DECISION_BOM_CANNOT_PROVE_FIXED, DECISION_BOM_VERSION,
} = await import(pathToFileURL(resolve(target, 'packages/shared/dist/bom/index.js')).href);
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const valid = (check) => ({ check, status: 'valid', reason: null, ref: null });
const unverified = (check, reason) => ({ check, status: 'unverifiable', reason, ref: null });
const decisionChecks = BOM_VERIFY_CHECKS.filter((check) => !AI_BOM_ONLY_CHECKS.includes(check));
const outcome = (checks) => checks.some((c) => c.status === 'invalid') ? 'invalid'
  : checks.some((c) => c.status === 'unverifiable') ? 'valid_with_unverifiable' : 'valid';
function baseline() {
  const checks = decisionChecks.map((check) => check.startsWith('bundle_')
    ? unverified(check, 'not_a_bundle') : check === 'decision_content_binding'
      ? unverified(check, 'preimage_not_exported') : check === 'receipt_facts_binding'
        ? unverified(check, 'receipt_v1_no_factsHash') : valid(check));
  return {
    trust: 'deployment_registry', source: 'decision_bom', bodyVersion: DECISION_BOM_VERSION,
    identity: { subject: 'decision-bom', auditId: uuid(1), bomId: uuid(2), version: 1,
      recordedFinality: 'anchored', reportedFinality: 'anchored', receiptPayloadVersion: 'v1' },
    outcome: outcome(checks), checks,
    sections: DECISION_BOM_SECTIONS.map((section) => ({ section, status: 'valid',
      completeness: 'recorded', notRecordedReason: null })),
    cannotProve: [...DECISION_BOM_CANNOT_PROVE_FIXED, 'facts_recorded_at_decision_time'],
    manifest: null, verifiedAt: '2026-10-10T12:00:00.000Z',
    capabilities: { access: 'admin', exportRoles: 'admins_only', auditorGrant: null,
      canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true,
      exportRequiresStepUp: false, rateLimitPerMinute: 30 },
  };
}
const results = [];
function run(name, dto, expected, finding = null) {
  const parsed = bomVerifyResponseSchema.safeParse(dto);
  const accepted = parsed.success;
  results.push({ name, finding, accepted, outcome: dto.outcome,
    checkCount: dto.checks.length, sectionStatuses: [...new Set(dto.sections.map((s) => s.status))] });
  assert.equal(accepted, expected, `${name}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`);
}
run('complete decision DTO with mandated limitations', baseline(), true);
const wrongOutcome = baseline(); wrongOutcome.outcome = 'valid';
run('existing guard rejects wrong overall outcome', wrongOutcome, false);
const foreignCheck = baseline(); foreignCheck.checks.push(valid('serial_number'));
run('existing guard rejects foreign subject check', foreignCheck, false);
const missingSection = baseline(); missingSection.sections.pop();
run('existing guard rejects missing section', missingSection, false);
const sparse = baseline(); sparse.checks = [valid('body_schema')]; sparse.outcome = 'valid';
run('one check claims valid without signature or binding checks', sparse, !fixed, 'B4C-01');
const duplicates = baseline(); duplicates.checks = [valid('body_schema'), valid('body_schema')]; duplicates.outcome = 'valid';
run('duplicate one-check substitute also claims valid', duplicates, !fixed, 'B4C-01');
const r39 = baseline(); r39.checks = r39.checks.map((c) => c.check === 'decision_content_binding' ? valid(c.check) : c);
run('R39 binding claims valid despite undisclosed preimage', r39, !fixed, 'B4C-01');
const r46 = baseline(); r46.checks = r46.checks.map((c) => c.check === 'receipt_facts_binding' ? valid(c.check) : c);
run('R46 v1 receipt claims facts bound', r46, !fixed, 'B4C-01');
const invalidSection = baseline(); invalidSection.sections[0].status = 'invalid';
run('invalid section beside valid projection and non-invalid outcome (independent of B4C-01)', invalidSection, !fixed, 'B4C-02');
const contradictory = baseline(); contradictory.checks = contradictory.checks.map((c) => valid(c.check));
contradictory.outcome = 'valid'; contradictory.identity.receiptPayloadVersion = 'v2';
contradictory.sections[0].status = 'invalid';
run('combined omissions allow invalid section and overall valid', contradictory, !fixed, 'B4C-02');
const wrongSource = baseline(); wrongSource.source = 'ai_bom_snapshot';
run('AI stored-source response identifies a Decision BOM', wrongSource, !fixed, 'B4C-03');
console.log(JSON.stringify({ target: resolve(target), mode: fixed ? 'owner-fix gate' : 'frozen regression receipt',
  scope: 'response-schema counterexamples only; no implemented verifier or signature validation exercised',
  cases: results }, null, 2));
