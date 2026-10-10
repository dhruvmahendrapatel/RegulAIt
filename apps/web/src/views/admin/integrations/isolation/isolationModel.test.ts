import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { attestationReading, checkProfileIntegrity, eligibleProfiles, PROBES, SETTING_DEFAULTS, SETTING_KEYS, SETTING_LABEL, settingChanges, settingRelaxed, type ExecutorView, type ProfileView } from './isolationModel';
import { SHIPPED_PREVIEW_PROFILES } from './shippedPreviewProfiles';
import { ISOLATION_STRICT_DEFAULTS, ISOLATION_SETTING_COPY, SHIPPED_EXECUTION_PROFILES, canonicalExecutionProfile, executionProfileDigest } from '../../../../../../../packages/shared/src/isolation/index';
const now = Date.parse('2026-10-10T12:00:00Z');
const profile = () => structuredClone(SHIPPED_PREVIEW_PROFILES[0]!);
const executor = (p: ProfileView): ExecutorView => ({ id: 'synthetic', name: 'Synthetic', backend: 'gvisor', runtimeVersion: 'synthetic', status: 'active', classesDeclared: ['hardened_container', 'user_space_kernel'], declaredClass: null, attestation: { profileDigest: p.digest, isolationClass: 'user_space_kernel', observedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), verdict: 'pass', probes: PROBES.map(id => ({ id, passed: true })) } });
const draft = (values: Record<string, unknown>) => Object.fromEntries(SETTING_KEYS.map(k => [k, String(values[k])])) as Record<typeof SETTING_KEYS[number], string>;
afterEach(() => vi.restoreAllMocks());
describe('published contract parity and partial settings changes', () => {
    it('all eight defaults, labels and three canonical profile fixtures equal the shared contract', () => {
        expect(SETTING_DEFAULTS).toEqual(ISOLATION_STRICT_DEFAULTS);
        for (const k of SETTING_KEYS)
            expect(SETTING_LABEL[k]).toBe(ISOLATION_SETTING_COPY[k].label);
        for (const p of SHIPPED_PREVIEW_PROFILES) {
            const shared = SHIPPED_EXECUTION_PROFILES[p.body.name as keyof typeof SHIPPED_EXECUTION_PROFILES];
            expect(p.body).toEqual(shared);
            expect(p.digest).toBe(executionProfileDigest(shared));
        }
    });
    it('sends only an edited field and keeps another administrator\'s unrelated change', () => {
        const d = draft(SETTING_DEFAULTS);
        d.isolationFloorPublic = 'hardened_container';
        expect(settingChanges(SETTING_DEFAULTS, d, { ...SETTING_DEFAULTS, executorAttestationMaxAgeMinutes: 60 })).toEqual({ body: { isolationFloorPublic: 'hardened_container' }, relaxed: ['isolationFloorPublic:hardened_container'] });
    });
    it('returning to a strict default still relaxes a stronger stored policy', () => {
        const loaded = { ...SETTING_DEFAULTS, isolationFloorPublic: 'microvm' };
        const d = draft(loaded);
        d.isolationFloorPublic = 'user_space_kernel';
        expect(settingChanges(loaded, d, loaded)).toEqual({ body: { isolationFloorPublic: 'user_space_kernel' }, relaxed: ['isolationFloorPublic:user_space_kernel'] });
    });
    it('an already-matching stored value is no write', () => {
        const d = draft(SETTING_DEFAULTS);
        d.isolationEnforcement = 'warn';
        expect(settingChanges(SETTING_DEFAULTS, d, { ...SETTING_DEFAULTS, isolationEnforcement: 'warn' })).toEqual({ body: {}, relaxed: [] });
    });
    it.each(['59', '1441', '60.5', 'NaN', 'Infinity', '-1'])('rejects invalid lifetime %s', value => { const d = draft(SETTING_DEFAULTS); d.executorAttestationMaxAgeMinutes = value; expect(settingChanges(SETTING_DEFAULTS, d, SETTING_DEFAULTS)).toHaveProperty('error'); });
    it('an unreadable current value is conservatively relaxed, not strict by default', () => { expect(settingRelaxed('isolationFloorPublic', 'user_space_kernel', undefined)).toBe(true); });
});
describe('profile eligibility and integrity', () => {
    it('unknown floor/context offers no selection; only L3 is offered for a regulated floor', async () => {
        const ps = structuredClone(SHIPPED_PREVIEW_PROFILES);
        await Promise.all(ps.map(checkProfileIntegrity));
        expect(eligibleProfiles(ps, undefined, 'mcp_stdio')).toEqual([]);
        expect(eligibleProfiles(ps, 'microvm')).toEqual([]);
        expect(eligibleProfiles(ps, 'microvm', 'mcp_stdio').map(p => p.body.name)).toEqual(['restricted-microvm']);
        expect(eligibleProfiles(ps, 'user_space_kernel', 'mcp_stdio').map(p => p.body.name)).toEqual(['restricted', 'restricted-microvm']);
    });
    it('retired and unsupported workload profiles are excluded', async () => {
        const p = profile();
        await checkProfileIntegrity(p);
        p.retired = true;
        expect(eligibleProfiles([p], 'user_space_kernel', 'mcp_stdio')).toEqual([]);
        const engine = structuredClone(SHIPPED_PREVIEW_PROFILES[2]!);
        await checkProfileIntegrity(engine);
        expect(eligibleProfiles([engine], 'user_space_kernel', 'mcp_stdio')).toEqual([]);
    });
    it('digest mismatch and unsafe fixed process invariant cannot become checked', async () => {
        const p = profile();
        p.digest = '0'.repeat(64);
        expect(await checkProfileIntegrity(p)).toBe(false);
        const q = profile();
        q.body.process.uid = 0;
        q.digest = createHash('sha256').update(canonicalExecutionProfile(q.body)).digest('hex');
        expect(await checkProfileIntegrity(q)).toBe(false);
    });
    it('body mutation during a delayed WebCrypto digest cannot inherit the old verification', async () => {
        const p = profile();
        const actual = crypto.subtle.digest.bind(crypto.subtle);
        let release: (value: ArrayBuffer) => void = () => { };
        const digest = await actual('SHA-256', new TextEncoder().encode(canonicalExecutionProfile(p.body)));
        vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => new Promise<ArrayBuffer>(resolve => { release = resolve; }));
        const checking = checkProfileIntegrity(p);
        p.body.minClass = 'hardened_container';
        release(digest);
        expect(await checking).toBe(false);
        expect(eligibleProfiles([p], 'hardened_container', 'mcp_stdio')).toEqual([]);
    });
});
describe('attestation evidence refuses unsupported assurance', () => {
    it('no positive chip before canonical digest validation, then a fresh matching report is usable', async () => { const p = profile(), e = executor(p); expect(attestationReading(e, p, 120, now).state).toBe('Unmeasured'); await checkProfileIntegrity(p); expect(attestationReading(e, p, 120, now).state).toBe('Fresh passing report'); });
    it.each(['lower-class', 'missing-probe', 'failed-probe', 'duplicate-probe', 'unknown-probe', 'wrong-digest', 'future-time', 'null-expiry', 'invalid-backend', 'unknown-policy', 'invalid-clock'])('does not produce green for %s', async (kind) => {
        const p = profile(), e = executor(p);
        await checkProfileIntegrity(p);
        let policy: unknown = 120, clock = now;
        if (kind === 'lower-class')
            e.attestation!.isolationClass = 'hardened_container';
        if (kind === 'missing-probe')
            e.attestation!.probes.pop();
        if (kind === 'failed-probe')
            e.attestation!.probes[0]!.passed = false;
        if (kind === 'duplicate-probe')
            e.attestation!.probes.push(e.attestation!.probes[0]!);
        if (kind === 'unknown-probe')
            e.attestation!.probes.push({ id: 'unknown', passed: true });
        if (kind === 'wrong-digest')
            e.attestation!.profileDigest = '0'.repeat(64);
        if (kind === 'future-time')
            e.attestation!.observedAt = new Date(now + 1).toISOString();
        if (kind === 'null-expiry')
            e.attestation!.expiresAt = null;
        if (kind === 'invalid-backend')
            (e as {
                backend: string;
            }).backend = 'constructor';
        if (kind === 'unknown-policy')
            policy = undefined;
        if (kind === 'invalid-clock')
            clock = NaN;
        expect(attestationReading(e, p, policy, clock).tone).not.toBe('ok');
    });
    it('an open view becomes stale at the stricter org/profile expiry', async () => { const p = profile(), e = executor(p); await checkProfileIntegrity(p); const expiry = Date.parse(e.attestation!.observedAt!) + 60 * 60000; expect(attestationReading(e, p, 60, expiry - 1).state).toBe('Fresh passing report'); expect(attestationReading(e, p, 60, expiry).state).toBe('Stale'); });
    it('customer declaration is never green and still expires', async () => { const p = profile(), e = executor(p); await checkProfileIntegrity(p); e.backend = 'customer'; e.classesDeclared = ['customer_declared']; e.attestation!.isolationClass = 'customer_declared'; expect(attestationReading(e, p, 120, now).state).toBe('Customer declared'); expect(attestationReading(e, p, 120, now).tone).toBe('warn'); expect(attestationReading(e, p, 120, now + 7200000).state).toBe('Stale'); });
    it('mutation after integrity validation immediately invalidates the reading', async () => { const p = profile(), e = executor(p); await checkProfileIntegrity(p); p.body.runsc.directfs = true; expect(attestationReading(e, p, 120, now).state).toBe('Unmeasured'); });
});
