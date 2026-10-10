import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../../../api/client';
import { Badge, Button, Card, EmptyState, Field, Modal, Select, Table } from '../../../../ui/kit';
import { attestationReading, checkProfileIntegrity, classText, isClass, eligibleProfiles, REFUSAL_TEXT, type IsolationPreview, type ProfileView, type IsolationClass } from './isolationModel';
import v from '../../../views.module.css';
/** I1 publishes routes, not success DTOs. Never decode or fabricate those responses until I2–I4 freezes them. */
async function probeAvailability(path: string): Promise<never> {
    try {
        await api.get<unknown>(path);
    }
    catch (e) {
        if (e instanceof ApiError && e.status === 501)
            throw new Error('This gateway has not implemented isolation administration yet.');
        throw new Error('Isolation administration could not be read. No isolation assurance is available.');
    }
    throw new Error('Isolation administration is unavailable on this gateway.');
}
export function IsolationPanel({ preview }: {
    preview?: IsolationPreview;
}) {
    const q = useQuery({ queryKey: ['admin', 'isolation-availability'], enabled: !preview, retry: false, queryFn: () => Promise.all(['/v1/execution-profiles', '/v1/executors', '/v1/execution-placements'].map(probeAvailability)) });
    const [clock, setClock] = useState(Date.now());
    const [, setIntegrity] = useState(0);
    useEffect(() => { let live = true; void Promise.all((preview?.profiles ?? []).map(checkProfileIntegrity)).then(() => { if (live)
        setIntegrity(n => n + 1); }); return () => { live = false; }; }, [preview]);
    useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const [selected, setSelected] = useState<ProfileView | null>(null);
    if (!preview)
        return <Card title="Execution profiles and executors"><p>Profiles define filesystem, network, process and resource controls. Executors report the isolation they provide before a workload receives input.</p><EmptyState title={q.isPending ? 'Loading isolation administration…' : 'Isolation administration unavailable'} body={q.error instanceof Error ? q.error.message : 'No measured profiles, executors or placements are available.'}/><Button disabled={q.isFetching} onClick={() => void q.refetch()}>Refresh isolation administration</Button></Card>;
    return <div className={v.stack}>
  <p role="status">Mock preview · synthetic profiles, executors and placements. No workload is run and no setting or profile assignment is saved.</p>
  <Card title="Execution profiles"><Table rows={preview.profiles} rowKey={p => p.digest} columns={[
            { key: 'name', header: 'Profile', render: p => p.body.name }, { key: 'version', header: 'Version', render: p => p.version }, { key: 'class', header: 'Minimum isolation', render: p => classText(p.body.minClass) }, { key: 'digest', header: 'Digest', render: p => <code>{p.digest}</code> }, { key: 'state', header: 'State', render: p => <Badge tone={p.retired ? 'warn' : 'neutral'}>{p.retired ? 'Retired' : 'Live in preview'}</Badge> }, { key: 'inspect', header: 'Controls', render: p => <Button size="sm" onClick={() => setSelected(p)}>Inspect {p.body.name}</Button> },
        ]} empty={<EmptyState title="No profiles reported" body="A missing profile is unavailable, never a weaker fallback."/>}/></Card>
  <Card title="Executors"><p>Software attestation is a reported measurement, not hardware verification. A fresh self-test is required separately from the per-placement report.</p><Table rows={preview.executors} rowKey={e => e.id} columns={[
            { key: 'name', header: 'Executor', render: e => e.name }, { key: 'backend', header: 'Backend / runtime', render: e => `${e.backend} · ${e.runtimeVersion}` }, { key: 'classes', header: 'Declared classes', render: e => e.classesDeclared.map(classText).join(', ') }, { key: 'status', header: 'Status', render: e => e.status }, { key: 'fresh', header: 'Attestation', render: e => { const p = preview.profiles.find(p => p.digest === e.attestation?.profileDigest); const r = attestationReading(e, p, preview.settings.executorAttestationMaxAgeMinutes, clock); return <span><Badge tone={r.tone}>{r.state}</Badge><span className={v.faint}> {r.detail}</span></span>; } },
        ]} empty={<EmptyState title="No executors reported" body="No executor means no placement assurance."/>}/></Card>
  <Card title="Placement decisions"><Table rows={preview.placements} rowKey={p => p.id} columns={[
            { key: 'id', header: 'Placement', render: p => p.id }, { key: 'required', header: 'Required', render: p => classText(p.required) }, { key: 'applied', header: 'Applied', render: p => classText(p.applied) }, { key: 'state', header: 'Outcome', render: p => <Badge tone={p.outcome === 'placed' ? 'info' : 'warn'}>{p.outcome === 'placed' ? 'Placed in preview' : p.outcome === 'mismatch' ? 'Mismatch · input refused' : 'Refused'}</Badge> }, { key: 'reason', header: 'Reason', render: p => p.reason ? <span><code>{p.reason}</code> · {Object.hasOwn(REFUSAL_TEXT, p.reason) ? REFUSAL_TEXT[p.reason] : 'Unknown refusal; placement is unavailable.'}</span> : 'No refusal recorded' }, { key: 'enforcement', header: 'Enforcement', render: p => p.enforcement === 'warn' ? <Badge tone="warn">Warn · audited relaxation</Badge> : 'Enforce' },
        ]} empty={<EmptyState title="No placements reported" body="No outcome has been measured."/>}/></Card>
  <Modal open={selected !== null} title={selected ? `Execution profile: ${selected.body.name}` : ''} onClose={() => setSelected(null)} actions={<Button onClick={() => setSelected(null)}>Close profile</Button>}>
   {selected && <div className={v.stack}><p>{classText(selected.body.minClass)}. Digest <code>{selected.digest}</code>.</p><p>Read-only root; no capabilities; no new privileges; UID {selected.body.process.uid}. Work directory {selected.body.filesystem.workDir.path}: {selected.body.filesystem.workDir.tmpfsMiB} MiB tmpfs.</p><p>Network: {selected.body.network.mode}. Secrets: {selected.body.secrets}. Persistence: {selected.body.persistence}.</p><p>Workload process limit: {selected.body.process.pids.workloadNproc}. Host cgroup limit: {selected.body.process.pids.hostCgroupPidsMax}.</p><p>CPU: {selected.body.resources.cpuMillis} millicores; memory: {selected.body.resources.memoryMiB} MiB; per-call wall clock: {selected.body.resources.wallClockSecondsPerCall} seconds; session: {selected.body.resources.wallClockSecondsPerSession} seconds; output: {selected.body.resources.outputBytes} bytes.</p><p>runsc: OCI seccomp on, sidecars STRICT / ALWAYS, platform {selected.body.runsc.platform}, directfs {selected.body.runsc.directfs ? 'on · audited relaxation' : 'off'}.</p><p>{selected.body.attestation.probes.length} required probes; executor report lifetime {selected.body.attestation.executorMaxAgeMinutes} minutes; a report is required before input for every placement.</p><p>Root read-only requires EROFS or an observed read-only mount. Non-root EACCES proves nothing. Host cgroup limits must be reported by the executor.</p></div>}
  </Modal>
 </div>;
}
export function ExecutionProfileSelector({ context, preview, floor, workloadKind }: {
    context: string;
    preview?: IsolationPreview;
    floor?: IsolationClass;
    workloadKind?: ProfileView['body']['workloadKinds'][number];
}) {
    const [choice, setChoice] = useState('');
    const [, setIntegrity] = useState(0);
    useEffect(() => { let live = true; void Promise.all((preview?.profiles ?? []).map(checkProfileIntegrity)).then(() => { if (live)
        setIntegrity(n => n + 1); }); return () => { live = false; }; }, [preview]);
    const profiles = eligibleProfiles(preview?.profiles ?? [], floor, workloadKind);
    const allowed = profiles.some(p => p.digest === choice);
    return <div className={v.stack} data-testid="execution-profile-selector">
  <Field label={`Execution profile · ${context}`} help={preview ? `Mock computed floor: ${classText(floor)}. Profiles below this floor and retired profiles are unavailable.` : 'Required isolation floor and current assignment are unmeasured; profile assignment is unavailable.'}>
   <Select disabled={!preview || !isClass(floor) || !workloadKind} value={allowed ? choice : ''} onChange={e => setChoice(e.target.value)}>
    <option value="">{preview ? 'Choose a preview profile' : 'Profile assignment unavailable'}</option>
    {profiles.map(p => <option key={p.digest} value={p.digest}>{p.body.name} · {classText(p.body.minClass)}</option>)}
   </Select>
  </Field>
  {preview ? <p role="status">{allowed ? 'Preview selection only; nothing was saved.' : 'No profile selected. No weaker fallback is selected automatically.'}</p> : <p>Profile assignment is unavailable on this gateway.</p>}
 </div>;
}
