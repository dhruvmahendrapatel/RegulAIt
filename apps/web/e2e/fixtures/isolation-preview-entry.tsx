/** Explicit test-only UI entry, never included by the production index.html. Read projections are not API DTOs. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ToastProvider } from '../../src/ui/toast';
import { Button, Card } from '../../src/ui/kit';
import StepUpDialog from '../../src/stepup/StepUpDialog';
import { IsolationPanel, ExecutionProfileSelector } from '../../src/views/admin/integrations/isolation/IsolationPanel';
import { IsolationSettingsCard } from '../../src/views/admin/integrations/isolation/IsolationSettings';
import { PROBES, SETTING_DEFAULTS, type IsolationPreview, type ExecutorView } from '../../src/views/admin/integrations/isolation/isolationModel';
import { SHIPPED_PREVIEW_PROFILES } from '../../src/views/admin/integrations/isolation/shippedPreviewProfiles';
import '../../src/theme/fonts.css';
import '../../src/theme/tokens.css';
import '../../src/theme/global.css';
const now = Date.now(), profiles = structuredClone(SHIPPED_PREVIEW_PROFILES), profile = profiles[0]!;
const executor: ExecutorView = { id: 'preview-executor', name: 'Synthetic gVisor', backend: 'gvisor', runtimeVersion: 'synthetic-release', status: 'active', classesDeclared: ['user_space_kernel'], declaredClass: null, attestation: { profileDigest: profile.digest, isolationClass: 'user_space_kernel', observedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), verdict: 'pass', probes: PROBES.map(id => ({ id, passed: true })) } };
const snapshot: IsolationPreview = { profiles, settings: { ...SETTING_DEFAULTS }, executors: [executor, { ...structuredClone(executor), id: 'stale', name: 'Synthetic stale', attestation: { ...executor.attestation!, observedAt: new Date(now - 10800000).toISOString(), expiresAt: new Date(now - 3600000).toISOString() } }, { ...structuredClone(executor), id: 'quarantined', name: 'Synthetic quarantined', status: 'quarantined' }, { ...structuredClone(executor), id: 'missing', name: 'Synthetic unmeasured', attestation: null }, { ...structuredClone(executor), id: 'declared', name: 'Synthetic customer', backend: 'customer', classesDeclared: ['customer_declared'], attestation: { ...executor.attestation!, isolationClass: 'customer_declared' } }], placements: Object.keys({ no_executor: 1, attestation_stale: 1, class_below_required: 1, executor_quarantined: 1, profile_retired: 1, execution_profile_mismatch: 1 }).map((reason, index) => ({ id: `synthetic-refusal-${index}`, required: 'microvm', applied: null, profileDigest: profile.digest, outcome: reason === 'execution_profile_mismatch' ? 'mismatch' : 'refused', reason: reason as IsolationPreview['placements'][number]['reason'], enforcement: 'enforce' })) };
const mode = new URLSearchParams(location.search).get('mode');
if (mode === 'unknown-policy')
    snapshot.settings = {};
if (mode === 'expiry')
    snapshot.executors = [{ ...executor, attestation: { ...executor.attestation!, expiresAt: new Date(now + 4000).toISOString() } }];
if (mode === 'empty') {
    snapshot.profiles = [];
    snapshot.executors = [];
    snapshot.placements = [];
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Preview() { const [dark, setDark] = useState(false); return <main style={{ padding: 'var(--s6)', display: 'grid', gap: 'var(--s4)' }}><h1>Isolation UI mock preview</h1><p>Synthetic fixtures only. Profile selections are local previews. Organization settings and identity checks below use mocked HTTP in the browser tests.</p><Button onClick={() => { document.documentElement.dataset.theme = dark ? 'light' : 'dark'; setDark(!dark); }}>Switch to {dark ? 'light' : 'dark'} theme</Button><IsolationPanel preview={mode === 'unavailable' ? undefined : snapshot}/><Card title="Agent execution profile"><ExecutionProfileSelector context="agent" preview={snapshot} floor="microvm" workloadKind="code_exec"/></Card><Card title="Local MCP execution profile"><ExecutionProfileSelector context="local MCP server" preview={snapshot} floor="user_space_kernel" workloadKind="mcp_stdio"/></Card><IsolationSettingsCard /><StepUpDialog /></main>; }
createRoot(document.getElementById('root')!).render(<BrowserRouter><QueryClientProvider client={client}><ToastProvider><Preview /></ToastProvider></QueryClientProvider></BrowserRouter>);
