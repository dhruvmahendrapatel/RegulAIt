/** Independent pure finality review of PR #315, frozen f6963763.
 * node apps/web/review/x48-finite-lock-review.mjs [target checkout]
 * No database, real clock, HTTP, or cryptographic execution.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = process.argv[2] ?? process.cwd();
const { decisionBomFinality, reportedFinality } = await import(
  pathToFileURL(resolve(target, 'packages/shared/dist/bom/finality.js')).href);
const now = new Date('2026-10-10T12:00:00.000Z');
const base = { anchor: { status: 'flushed', tamperResistant: true, tsaGranted: true,
  retainUntil: new Date(now.getTime() + 2 * 86400000) }, receiptSigned: true,
  timestampMode: 'required', decisionAt: now, retainedDays: null, now };
const cases = [];
function check(name, input, expected) {
  const actual = decisionBomFinality(input);
  cases.push({ name, setting: input.setting, finiteLock: input.finiteLock,
    retainedDays: input.retainedDays, actual });
  assert.deepEqual(actual, expected, name);
  assert.ok(!actual.freeze || actual.state !== 'anchored_finite_lock' || input.finiteLock === 'accept', name);
}
for (const setting of ['anchored', 'anchored_unverified_destination', 'chain_signed']) {
  for (const finiteLock of ['refuse', 'accept']) {
    const input = { ...base, setting, finiteLock };
    check('unbounded future observed lock', input, finiteLock === 'accept'
      ? { freeze: true, state: 'anchored_finite_lock' } : setting === 'anchored'
        ? { freeze: false, reason: 'retention_unbounded' }
        : { freeze: true, state: 'anchored_unverified_destination' });
    for (const [name, patch, reason] of [
      ['missing lock observation', { retainUntil: null }, 'lock_not_recorded'],
      ['lock expires exactly now', { retainUntil: now }, 'lock_lapsed'],
      ['lock expired before now', { retainUntil: new Date(now.getTime() - 1) }, 'lock_lapsed'],
      ['untrusted destination', { tamperResistant: false }, 'destination_not_tamper_resistant'],
      ['required timestamp absent', { tsaGranted: false }, 'timestamp_pending'],
    ]) {
      check(name, { ...input, anchor: { ...input.anchor, ...patch } }, setting === 'anchored'
        ? { freeze: false, reason } : { freeze: true, state: 'anchored_unverified_destination' });
    }
    check('bounded retention fully covered', { ...input, retainedDays: 1 }, { freeze: true, state: 'anchored' });
    check('bounded retention outlasts lock', { ...input, retainedDays: 3 }, setting === 'anchored'
      ? { freeze: false, reason: 'lock_shorter_than_retention' }
      : { freeze: true, state: 'anchored_unverified_destination' });
    check('unsigned receipt always refused', { ...input, receiptSigned: false }, { freeze: false, reason: 'receipt_unsigned' });
    check('missing anchor', { ...input, anchor: null }, setting === 'chain_signed'
      ? { freeze: true, state: 'chain_signed' } : { freeze: false, reason: 'anchor_not_flushed' });
    check('timestamps explicitly off', { ...input, timestampMode: 'off', anchor: { ...input.anchor, tsaGranted: false } },
      finiteLock === 'accept' ? { freeze: true, state: 'anchored_finite_lock' }
        : setting === 'anchored' ? { freeze: false, reason: 'retention_unbounded' }
          : { freeze: true, state: 'anchored_unverified_destination' });
  }
}
for (const state of ['anchored', 'anchored_finite_lock']) {
  assert.equal(reportedFinality(state, base.anchor.retainUntil, now), state);
  assert.equal(reportedFinality(state, now, now), 'anchored_lapsed');
  assert.equal(reportedFinality(state, null, now), 'anchored_lapsed');
}
console.log(JSON.stringify({ scope: 'pure finality matrix; no deployment/crypto claim',
  target: resolve(target), finalityCases: cases.length, reportedFinalityAssertions: 6, cases }, null, 2));
