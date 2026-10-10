/** Browser mirrors of ADR-0190's shared contract. Read DTOs below are internal projections, never guessed HTTP responses. */
export const CLASSES = ['hardened_container', 'user_space_kernel', 'microvm'] as const;
export type IsolationClass = typeof CLASSES[number];
export const CLASS_LABEL: Record<IsolationClass, string> = { hardened_container: 'L1 · Hardened container', user_space_kernel: 'L2 · User-space kernel sandbox', microvm: 'L3 · MicroVM sandbox' };
export const SETTING_DEFAULTS = {
    isolationEnforcement: 'enforce', isolationFloorPublic: 'user_space_kernel', isolationFloorInternal: 'user_space_kernel', isolationFloorConfidential: 'user_space_kernel', isolationFloorRegulated: 'microvm', isolationFloorMcpStdio: 'user_space_kernel', isolationFloorEngineWorker: 'user_space_kernel', executorAttestationMaxAgeMinutes: 120,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];
export const SETTING_LABEL: Record<SettingKey, string> = {
    isolationEnforcement: 'Enforce isolation', isolationFloorPublic: 'Isolation floor: public projects', isolationFloorInternal: 'Isolation floor: internal projects', isolationFloorConfidential: 'Isolation floor: confidential projects', isolationFloorRegulated: 'Isolation floor: regulated projects', isolationFloorMcpStdio: 'Isolation floor: local (stdio) MCP servers', isolationFloorEngineWorker: 'Isolation floor: engine workers', executorAttestationMaxAgeMinutes: 'Executor attestation lifetime (minutes)',
};
export type SettingValues = Record<SettingKey, string | number>;
/** Read only the published settings envelope; absent/malformed data stays unmeasured. */
export function settingsFromEnvelope(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'settings')) return {};
    const settings = (value as Record<string, unknown>).settings;
    return settings !== null && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, unknown> : {};
}
export const isClass = (v: unknown): v is IsolationClass => typeof v === 'string' && (CLASSES as readonly string[]).includes(v);
export function isSetting(key: SettingKey, v: unknown): v is string | number {
    if (key === 'isolationEnforcement')
        return v === 'enforce' || v === 'warn';
    if (key === 'executorAttestationMaxAgeMinutes')
        return typeof v === 'number' && Number.isInteger(v) && v >= 60 && v <= 1440;
    return isClass(v);
}
export function settingRelaxed(key: SettingKey, next: string | number, base: unknown): boolean {
    if (!isSetting(key, base))
        return true;
    if (key === 'isolationEnforcement')
        return next === 'warn' && base === 'enforce';
    if (key === 'executorAttestationMaxAgeMinutes')
        return typeof next === 'number' && typeof base === 'number' && next > base;
    return isClass(next) && isClass(base) && CLASSES.indexOf(next) < CLASSES.indexOf(base);
}
export function settingChanges(loaded: Record<string, unknown>, draft: Record<SettingKey, string>, current: Record<string, unknown> | null): {
    error: string;
} | {
    body: Partial<SettingValues>;
    relaxed: string[];
} {
    const body: Partial<SettingValues> = {};
    const relaxed: string[] = [];
    for (const key of SETTING_KEYS) {
        const next = key === 'executorAttestationMaxAgeMinutes' ? (/^\d+$/.test(draft[key]) ? Number(draft[key]) : NaN) : draft[key];
        if (!isSetting(key, next))
            return { error: 'Choose a known isolation class or enforcement mode, and an attestation lifetime of 60–1,440 whole minutes.' };
        if (next === loaded[key] || next === current?.[key])
            continue;
        body[key] = next;
        if (settingRelaxed(key, next, SETTING_DEFAULTS[key]) || settingRelaxed(key, next, current?.[key]))
            relaxed.push(`${key}:${next}`);
    }
    return { body, relaxed };
}
export function classText(v: unknown): string { return isClass(v) ? CLASS_LABEL[v] : v === 'customer_declared' ? 'Customer declared · unverified' : 'Not reported'; }
export const PROBES = ['runtime_identity', 'proc_status', 'seccomp_enforced', 'root_read_only', 'egress_literal_address', 'egress_dns', 'network_interfaces', 'no_executor_credentials', 'visible_limits', 'host_cgroup_limits', 'runtime_config'] as const;
/** Structural mirror of shared ExecutionProfileBody; importing its runtime module would pull Node crypto into a browser build. */
export interface ProfileBody {
 schema: 'regulait.execution-profile.v1'; name: string;
 workloadKinds: Array<'mcp_stdio'|'code_exec'|'engine_worker'|'byoc_worker'>; minClass: IsolationClass;
 filesystem: {rootReadOnly:true;workDir:{path:string;tmpfsMiB:number};inputs:Array<{name:string;mountPath:string}>};
 network: {mode:'none'}|{mode:'gateway_only'}|{mode:'allow_list';entries:Array<{host:string;port:number}>};
 process: {uid:number;capabilities:never[];noNewPrivileges:true;seccomp:{type:'RuntimeDefault'}|{type:'Localhost';profile:string};pids:{workloadNproc:number;hostCgroupPidsMax:number};exec:'image_only'|'image_and_work_dir'};
 resources: {cpuMillis:number;memoryMiB:number;wallClockSecondsPerCall:number;wallClockSecondsPerSession:number;outputBytes:number};
 secrets:'none'|'task_scoped'|'injected_at_egress';persistence:'none'|'scoped_volume';
 runsc:{ociSeccomp:true;sidecarUsagePolicy:'STRICT';sidecarReleaseEnforcementPolicy:'ALWAYS';platform:'systrap'|'kvm';directfs:boolean};
 attestation:{probes:Array<typeof PROBES[number]>;executorMaxAgeMinutes:number;perPlacement:true};
}
export interface ProfileView {
    body: ProfileBody;
    digest: string;
    version: number;
    retired: boolean;
}
export interface AttestationView {
    profileDigest: string;
    isolationClass: IsolationClass | 'customer_declared';
    observedAt: string | null;
    expiresAt: string | null;
    verdict: 'pass' | 'fail' | 'unknown';
    probes: Array<{
        id: string;
        passed: boolean;
    }>;
}
export interface ExecutorView {
    id: string;
    name: string;
    backend: 'runc' | 'gvisor' | 'kata' | 'openshell' | 'customer';
    runtimeVersion: string;
    status: 'active' | 'quarantined' | 'revoked';
    classesDeclared: Array<IsolationClass | 'customer_declared'>;
    declaredClass: IsolationClass | null;
    attestation: AttestationView | null;
}
export const REFUSAL_TEXT = {
    no_executor: 'No executor is available.', attestation_stale: 'The executor attestation is stale.', class_below_required: 'Available isolation is below the required class.', executor_quarantined: 'The executor is quarantined.', profile_retired: 'The execution profile is retired.', execution_profile_mismatch: 'The sandbox report disagreed with the required profile; input was refused.',
} as const;
export interface PlacementView {
    id: string;
    required: IsolationClass;
    applied: IsolationClass | 'customer_declared' | null;
    profileDigest: string;
    outcome: 'placed' | 'refused' | 'mismatch';
    reason: keyof typeof REFUSAL_TEXT | null;
    enforcement: 'enforce' | 'warn';
}
export interface IsolationPreview {
    profiles: ProfileView[];
    executors: ExecutorView[];
    placements: PlacementView[];
    settings: Record<string, unknown>;
}
export function eligibleProfiles(profiles: ProfileView[], floor: unknown, workloadKind?: ProfileBody['workloadKinds'][number]): ProfileView[] {
    if (!isClass(floor) || !workloadKind)
        return [];
    return profiles.filter(p => { try {
        return !p.retired && p.body.workloadKinds.includes(workloadKind) && checkedProfiles.get(p) === profileFingerprint(p) && isClass(p.body.minClass) && CLASSES.indexOf(p.body.minClass) >= CLASSES.indexOf(floor);
    }
    catch {
        return false;
    } });
}
/** Canonical SHA-256 is checked with browser WebCrypto before any positive profile reading. */
const checkedProfiles = new WeakMap<ProfileView, string>();
function canonical(value: unknown, depth = 0): string {
    if (depth > 64)
        throw new Error('Profile nesting limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
    if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k], depth + 1)).join(',') + '}';
    throw new Error('Invalid profile value');
}
function profileFingerprint(p: ProfileView): string { return p.digest + ':' + canonical(p.body); }
export async function checkProfileIntegrity(profile: ProfileView): Promise<boolean> {
    checkedProfiles.delete(profile);
    try {
        if (!/^[0-9a-f]{64}$/.test(profile.digest))
            return false;
        const b = profile.body;
        if (b.schema !== 'regulait.execution-profile.v1' || !isClass(b.minClass) || b.filesystem.rootReadOnly !== true || b.process.noNewPrivileges !== true || !Array.isArray(b.process.capabilities) || b.process.capabilities.length !== 0 || !Number.isInteger(b.process.uid) || b.process.uid < 1 || b.runsc.ociSeccomp !== true || b.runsc.sidecarUsagePolicy !== 'STRICT' || b.runsc.sidecarReleaseEnforcementPolicy !== 'ALWAYS' || typeof b.runsc.directfs !== 'boolean' || !['systrap', 'kvm'].includes(b.runsc.platform) || b.attestation.perPlacement !== true || !Number.isInteger(b.process.pids.workloadNproc) || b.process.pids.workloadNproc < 1 || !Number.isInteger(b.process.pids.hostCgroupPidsMax) || b.process.pids.hostCgroupPidsMax < b.process.pids.workloadNproc + 128)
            return false;
        const text = canonical(b);
        if (text.length > 65536)
            return false;
        const fingerprint = profile.digest + ':' + text;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== profile.digest || fingerprint !== profileFingerprint(profile))
            return false;
        checkedProfiles.set(profile, fingerprint);
        return true;
    }
    catch {
        return false;
    }
}
export function attestationReading(executor: ExecutorView, profile: ProfileView | undefined, orgMinutes: unknown, now: number): {
    state: string;
    tone: 'ok' | 'warn' | 'danger' | 'neutral';
    detail: string;
} {
    const unknown = { state: 'Unmeasured', tone: 'neutral' as const, detail: 'A complete matching report, profile digest and validity window have not been verified.' };
    if (executor.status !== 'active')
        return { state: executor.status === 'quarantined' ? 'Quarantined' : 'Revoked', tone: 'danger', detail: 'This executor is unavailable for placement.' };
    const a = executor.attestation;
    if (!a || !profile || profile.retired || !Number.isFinite(now))
        return unknown;
    try {
        if (checkedProfiles.get(profile) !== profileFingerprint(profile))
            return unknown;
    }
    catch {
        return unknown;
    }
    if (!isClass(profile.body.minClass) || !profile.body.attestation || !Number.isInteger(profile.body.attestation.executorMaxAgeMinutes) || profile.body.attestation.executorMaxAgeMinutes < 1 || profile.body.attestation.executorMaxAgeMinutes > 1440)
        return unknown;
    if (a.verdict === 'fail')
        return { state: 'Failed', tone: 'danger', detail: 'The last self-test failed; no passing assurance is implied.' };
    const observed = a.observedAt ? Date.parse(a.observedAt) : NaN, expiry = a.expiresAt ? Date.parse(a.expiresAt) : NaN;
    if (a.verdict !== 'pass' || !Number.isFinite(observed) || !Number.isFinite(expiry) || observed > now || expiry <= observed || typeof orgMinutes !== 'number' || !Number.isInteger(orgMinutes) || orgMinutes < 60 || orgMinutes > 1440 || a.profileDigest !== profile.digest)
        return unknown;
    if (!Array.isArray(a.probes) || !Array.isArray(profile.body.attestation.probes) || !profile.body.attestation.probes.length)
        return unknown;
    const probes = new Map(a.probes.map(p => [p.id, p.passed]));
    if (probes.size !== a.probes.length || new Set(profile.body.attestation.probes).size !== profile.body.attestation.probes.length || profile.body.attestation.probes.some(p => !(PROBES as readonly string[]).includes(p) || probes.get(p) !== true) || a.probes.some(p => !(PROBES as readonly string[]).includes(p.id)))
        return unknown;
    const backendClasses: Record<string, string[]> = { runc: ['hardened_container'], gvisor: ['hardened_container', 'user_space_kernel'], kata: ['hardened_container', 'microvm'], openshell: ['hardened_container', 'microvm'], customer: ['customer_declared'] };
    if (!Object.hasOwn(backendClasses, executor.backend) || !backendClasses[executor.backend]?.includes(a.isolationClass) || !Array.isArray(executor.classesDeclared) || !executor.classesDeclared.includes(a.isolationClass))
        return unknown;
    const until = Math.min(expiry, observed + Math.min(orgMinutes, profile.body.attestation.executorMaxAgeMinutes) * 60000);
    if (until <= now)
        return { state: 'Stale', tone: 'warn', detail: 'The passing self-test has expired. It cannot justify placement.' };
    if (a.isolationClass === 'customer_declared')
        return { state: 'Customer declared', tone: 'warn', detail: isClass(executor.declaredClass) ? `Mapped to ${classText(executor.declaredClass)}; isolation is unverified.` : 'No administrative class mapping; satisfies no required class.' };
    if (!isClass(a.isolationClass) || CLASSES.indexOf(a.isolationClass) < CLASSES.indexOf(profile.body.minClass))
        return { state: 'Below profile floor', tone: 'danger', detail: 'The reported isolation class cannot justify placement under this profile.' };
    return { state: 'Fresh passing report', tone: 'ok', detail: `Software report; freshness checked against this device clock until ${new Date(until).toISOString()}. Actual admission is decided by the gateway.` };
}
