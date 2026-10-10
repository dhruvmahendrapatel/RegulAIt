import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../../api/client';
import { putOrgSettings } from '../../../../stepup/stepUp';
import { Button, Card, ConfirmModal, Field, Input, Select, Badge } from '../../../../ui/kit';
import { QueryGate, readCurrentOrgSettings, reconfirmNeeded, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight } from '../../adminKit';
import { CLASSES, CLASS_LABEL, SETTING_DEFAULTS, SETTING_KEYS, SETTING_LABEL, isSetting, settingChanges, settingRelaxed, settingsFromEnvelope, type SettingKey } from './isolationModel';
import v from '../../../views.module.css';
export function IsolationSettingsCard() {
    const q = useQuery({ queryKey: ['admin', 'org-settings'], queryFn: () => api.get<unknown>('/v1/org/settings') });
    const settings = settingsFromEnvelope(q.data), loaded = q.data !== undefined;
    return <Card title="Isolation settings"><QueryGate loading={q.isLoading} error={loaded ? null : q.error} onRetry={() => void q.refetch()}>{loaded && q.isError && <p role="alert">Current settings could not be reloaded. Last loaded values are shown; further saves stay locked after a write.</p>}{loaded && <IsolationSettingsForm key={JSON.stringify(settings)} settings={settings}/>}</QueryGate></Card>;
}
export function IsolationSettingsForm({ settings }: {
    settings: Record<string, unknown>;
}) {
    const act = useAction(), flight = useSingleFlight(), baseline = useSettleAfterWrite(['admin', 'org-settings']);
    const [draft, setDraft] = useState(() => Object.fromEntries(SETTING_KEYS.map(k => [k, isSetting(k, settings[k]) ? String(settings[k]) : ''])) as Record<SettingKey, string>);
    const confirming = useRef(false);
    const [pending, setPending] = useState<{
        intent: Record<SettingKey, string>;
        relaxed: string[];
        changed: boolean;
        current: Record<string, unknown>;
    } | null>(null);
    const unavailable = SETTING_KEYS.some(k => !isSetting(k, settings[k]));
    const write = async (body: Record<string, unknown>) => { if (await act.run(() => putOrgSettings(body), 'Isolation settings saved'))
        await baseline.settle(); };
    const submit = async () => {
        if (unavailable || baseline.stale || !flight.enter())
            return;
        let keep = false;
        try {
            const current = await readCurrentOrgSettings();
            if (!current || SETTING_KEYS.some(k => !isSetting(k, current[k]))) {
                act.setError('Current isolation settings could not be read. Nothing was saved.');
                return;
            }
            const change = settingChanges(settings, draft, current);
            if ('error' in change) {
                act.setError(change.error);
                return;
            }
            if (!Object.keys(change.body).length) {
                act.setError('No isolation setting changed.');
                return;
            }
            if (change.relaxed.length) {
                keep = true;
                setPending({ intent: { ...draft }, relaxed: change.relaxed, changed: false, current: { ...current } });
                return;
            }
            await write(change.body);
        }
        finally {
            if (!keep)
                flight.leave();
        }
    };
    const confirm = async () => {
        if (confirming.current)
            return;
        confirming.current = true;
        const intent = pending;
        setPending(null);
        let keep = false;
        try {
            if (!intent)
                return;
            const current = await readCurrentOrgSettings();
            if (!current || SETTING_KEYS.some(k => !isSetting(k, current[k]))) {
                act.setError('Current isolation settings could not be read. Nothing was saved.');
                return;
            }
            const change = settingChanges(settings, intent.intent, current);
            if ('error' in change) {
                act.setError(change.error);
                return;
            }
            if (!Object.keys(change.body).length) {
                act.setError('The stored settings already match. Nothing was saved.');
                return;
            }
            if (reconfirmNeeded(intent.relaxed, { adds: change.relaxed.length > 0, added: change.relaxed }) || Object.keys(change.body).some(key => current[key] !== intent.current[key])) {
                keep = true;
                setPending({ ...intent, relaxed: change.relaxed, changed: true, current: { ...current } });
                return;
            }
            await write(change.body);
        }
        finally {
            confirming.current = false;
            if (!keep)
                flight.leave();
        }
    };
    const busy = act.busy || flight.busy || baseline.stale;
    return <form className={v.stack} onSubmit={e => { e.preventDefault(); void submit(); }}>
  <p>Strict defaults require L2 for public, internal and confidential workloads, L3 for regulated workloads, and a passing executor self-test no older than two hours. Relaxations require confirmation of your identity and are audited. A saved setting does not prove that a live workload ran under it.</p>
  {settings.isolationEnforcement === 'warn' && <p role="status"><Badge tone="warn">Isolation: not enforced</Badge> Warn is an audited relaxation. No placement outcome has been measured here.</p>}
  {unavailable && <p role="status">Isolation settings are unmeasured. The gateway has not reported all eight values; editing is unavailable.</p>}
  <div className={v.grid3}>{SETTING_KEYS.map(key => <div key={key}><Field label={SETTING_LABEL[key]} help={`Strict default: ${key.startsWith('isolationFloor') ? CLASS_LABEL[SETTING_DEFAULTS[key] as keyof typeof CLASS_LABEL] : String(SETTING_DEFAULTS[key])}`}>
   {key === 'executorAttestationMaxAgeMinutes' ? <Input type="number" min={60} max={1440} step={1} required value={draft[key]} disabled={busy || unavailable} onChange={e => setDraft({ ...draft, [key]: e.target.value })}/> : <Select value={draft[key]} disabled={busy || unavailable} onChange={e => setDraft({ ...draft, [key]: e.target.value })}>
    {!draft[key] && <option value="">Not reported</option>}
    {key === 'isolationEnforcement' ? <><option value="enforce">Enforce</option><option value="warn">Warn · audited relaxation</option></> : CLASSES.map(c => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
   </Select>}
  </Field>
   {isSetting(key, settings[key]) && <Badge tone={settingRelaxed(key, settings[key], SETTING_DEFAULTS[key]) ? 'warn' : 'neutral'}>{settingRelaxed(key, settings[key], SETTING_DEFAULTS[key]) ? 'Audited relaxation' : 'At least as strict as default'}</Badge>}
  </div>)}</div>
  <p>Warn is an audited relaxation; placement behavior is unmeasured on this gateway. A lower floor relaxes the required isolation, never below L1. A longer attestation lifetime permits older reports. Third-party code remains outside the gateway.</p>
  <Button type="submit" variant="primary" disabled={busy || unavailable}>Save isolation settings</Button>
  {act.error && <p role="alert">{act.error}</p>}
  {baseline.stale && <StaleAfterWrite onRetry={() => void baseline.settle()}/>}
  <ConfirmModal open={pending !== null} title="Relax isolation controls?" confirmLabel="Save audited relaxation" onCancel={() => { setPending(null); flight.leave(); }} onConfirm={() => void confirm()} body={<div>{pending?.changed && <p>The stored controls changed. Review this relaxation again.</p>}<ul>{pending?.relaxed.map(change => <li key={change}>{change}</li>)}</ul><p>These changes allow weaker isolation or older executor reports. The gateway records the changed settings in its audit log and asks for confirmation of your identity.</p></div>}/>
 </form>;
}
