/**
 * ADR-0195 SD0 — Discovery sources: where RegulAIt may scan, read-only, for
 * shadow AI (source-control organisations, cloud accounts, endpoint fleets).
 *
 * Honesty rules this page keeps:
 *  - A source kind is selectable only when its scanner is built. SD0 builds
 *    only SD3's two upload-fed endpoint kinds; every other kind shows "not built yet" with the slice that builds it,
 *    and the add form says so instead of offering a submit that would fail.
 *  - Every source starts disabled. Enabling one, widening an enabled one's
 *    target or scope, storing a static secret, lengthening the warning age or
 *    the endpoint retention, and revealing a pseudonym each ask the admin to
 *    confirm it's them (withStepUp); disabling and revoking never do.
 *  - A credential's secret is never shown: the gateway never returns it. The
 *    page shows its mode, its public config, its age and whether its write
 *    scope has been verified.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import v from "../../views.module.css";
import FederationCard from "./FederationCard";
import { EndpointImportCard } from "./EndpointImportCard";
import { EndpointAgentCard } from "./EndpointAgentCard";
import {
  couldNotRead,
  describeSchedule,
  describeScope,
  editablePublicConfig,
  formatKeyValues,
  parseIncludeList,
  parseKeyValueLines,
  scopeWidens,
  type DiscoveryPostureView,
  type DiscoveryRunView,
  type DiscoverySettingsView,
  type DiscoverySourceView,
  type ScannerKindView,
} from "./discoverySourcesModel";

const when = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : "—");
const RUN_TONE = { queued: "neutral", running: "info", succeeded: "ok", failed: "danger" } as const;

interface SourceForm {
  editing: DiscoverySourceView | null;
  name: string;
  kind: string;
  target: string;
  orgLevel: boolean;
  include: string;
  scheduleHours: string;
}
const EMPTY_FORM: SourceForm = { editing: null, name: "", kind: "", target: "", orgLevel: false, include: "", scheduleHours: "24" };

interface CredentialForm {
  source: DiscoverySourceView;
  mode: "federated" | "static";
  publicConfig: string;
  secret: string;
}

export default function DiscoverySourcesPage() {
  const act = useAction();
  const scanners = useQuery({ queryKey: ["admin", "discovery", "scanners"], queryFn: () => api.get<{ kinds: ScannerKindView[] }>("/v1/discovery/scanners") });
  const sources = useQuery({
    queryKey: ["admin", "discovery", "sources"],
    queryFn: () => api.get<{ sources: DiscoverySourceView[]; posture: DiscoveryPostureView }>("/v1/discovery/sources"),
  });
  const runs = useQuery({ queryKey: ["admin", "discovery", "runs"], queryFn: () => api.get<{ runs: DiscoveryRunView[] }>("/v1/discovery/runs?limit=50") });
  const settings = useQuery({ queryKey: ["admin", "discovery", "settings"], queryFn: () => api.get<DiscoverySettingsView>("/v1/discovery/settings") });

  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [cred, setCred] = useState<CredentialForm | null>(null);
  const [credError, setCredError] = useState<string | null>(null);
  const [warnDays, setWarnDays] = useState("");
  const [retentionDays, setRetentionDays] = useState("");
  // a finding's sighting links here with ?pseudonym=… (revealing still needs the step-up)
  const [params] = useSearchParams();
  const [pseudonym, setPseudonym] = useState(params.get("pseudonym") ?? "");
  const [revealed, setRevealed] = useState<{ pseudonym: string; kind: string; displayName: string } | null>(null);

  const kinds = scanners.data?.kinds ?? [];
  const built = kinds.filter((k) => k.built);
  const posture = sources.data?.posture;
  const list = sources.data?.sources ?? [];
  const refetchAll = async () => {
    await Promise.all([sources.refetch(), runs.refetch(), settings.refetch()]);
  };

  const submitSource = () => {
    const target = parseKeyValueLines(form.target);
    if ("error" in target) return setFormError(`Target: ${target.error}`);
    const include = parseIncludeList(form.include);
    if (!form.orgLevel && include.length === 0) return setFormError("Name at least one item to scan, or choose the organisation-level scope.");
    const hours = Number(form.scheduleHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) return setFormError("The schedule is a whole number of hours from 1 to 720.");
    if (!form.name.trim()) return setFormError("Give the source a name.");
    setFormError(null);
    const scope = { orgLevel: form.orgLevel, include: form.orgLevel ? [] : include };
    const editing = form.editing;
    void act.run(async () => {
      if (editing) {
        // widening an ENABLED source is the enable step-up; narrowing is free (the gateway decides; this only wraps)
        await withStepUp((h) =>
          stepUpApi.patch(`/v1/discovery/sources/${editing.id}`, { version: editing.version, name: form.name.trim(), target: target.value, scope, scheduleIntervalSeconds: hours * 3600 }, h),
        );
      } else {
        await api.post("/v1/discovery/sources", { name: form.name.trim(), kind: form.kind, target: target.value, scope, scheduleIntervalSeconds: hours * 3600 });
      }
      setForm(EMPTY_FORM);
      await refetchAll();
    }, editing ? (editing.enabled && scopeWidens(editing.scope, scope) ? "Source widened" : "Source saved") : "Source added (disabled)");
  };

  const enable = (s: DiscoverySourceView) =>
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.post(`/v1/discovery/sources/${s.id}/enable`, { version: s.version }, h));
      await refetchAll();
    }, `${s.name} enabled`);
  const disable = (s: DiscoverySourceView) =>
    void act.run(async () => {
      await api.post(`/v1/discovery/sources/${s.id}/disable`, {});
      await refetchAll();
    }, `${s.name} disabled`);
  const runNow = (s: DiscoverySourceView) =>
    void act.run(async () => {
      await api.post(`/v1/discovery/sources/${s.id}/runs`, {});
      await refetchAll();
    }, "Scan queued");
  const remove = (s: DiscoverySourceView) => {
    if (!window.confirm(`Delete ${s.name}? Its credential and run history go with it; its findings stay.`)) return;
    void act.run(async () => {
      await api.del(`/v1/discovery/sources/${s.id}`);
      await refetchAll();
    }, `${s.name} deleted`);
  };
  const revoke = (s: DiscoverySourceView) => {
    if (!window.confirm(`Revoke the credential of ${s.name}? Its stored secret is destroyed.`)) return;
    void act.run(async () => {
      await api.del(`/v1/discovery/sources/${s.id}/credential`);
      await refetchAll();
    }, "Credential revoked");
  };
  const saveCredential = () => {
    if (!cred) return;
    const publicConfig = parseKeyValueLines(cred.publicConfig);
    if ("error" in publicConfig) return setCredError(`Public config: ${publicConfig.error}`);
    if (cred.mode === "static" && !cred.secret) return setCredError("A static credential needs its secret.");
    setCredError(null);
    const body = {
      mode: cred.mode,
      publicConfig: publicConfig.value,
      ...(cred.mode === "static" ? { secret: cred.secret } : {}),
      replacesCredentialId: cred.source.credential?.id ?? null,
    };
    const sourceId = cred.source.id;
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.put(`/v1/discovery/sources/${sourceId}/credential`, body, h));
      setCred(null);
      await refetchAll();
    }, "Credential stored");
  };
  const saveSettings = () => {
    const s = settings.data;
    if (!s) return;
    const body: Record<string, number> = { version: s.version };
    if (warnDays.trim()) body.credentialWarningAgeDays = Number(warnDays);
    if (retentionDays.trim()) body.endpointRetentionDays = Number(retentionDays);
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.put("/v1/discovery/settings", body, h));
      setWarnDays("");
      setRetentionDays("");
      await refetchAll();
    }, "Discovery settings saved");
  };
  const reveal = () => {
    const p = pseudonym.trim();
    void act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<{ pseudonym: string; kind: string; displayName: string }>(`/v1/discovery/pseudonyms/${encodeURIComponent(p)}/reveal`, {}, h));
      setRevealed(out);
    }, null);
  };

  return (
    <>
      <PageHeader title="Discovery sources" sub="Where RegulAIt may scan, read-only, for shadow AI. Every source is off until you enable it." />
      <div className={v.stack}>
        <QueryGate loading={sources.isPending || scanners.isPending} error={sources.error ?? scanners.error} onRetry={() => void refetchAll()}>
          <Card title="Active discovery">
            <p data-testid="discovery-statement">{posture?.statement}</p>
            <p className={v.faint}>
              Findings land in <Link to="/admin/shadow-ai">Shadow-AI discovery</Link> only when an observation matches an enabled row of your
              signature catalogue. Unmatched observations are listed per run as catalogue gaps.
            </p>
          </Card>
          <div className={v.grid4}>
            <Stat value={`${posture?.sourcesEnabled.length ?? 0} of ${posture?.sourcesTotal ?? 0}`} label="sources enabled" />
            <Stat value={posture?.staticCredentials.length ?? 0} label="static credentials in use" />
            <Stat value={posture?.staleCredentials.length ?? 0} label={`static credentials older than ${posture?.credentialWarningAgeDays ?? 90} days`} />
            <Stat value={posture?.writeScopeUnverified.length ?? 0} label="credentials with write scope unverified" />
          </div>

          <Card title="Scanner kinds">
            <Table<ScannerKindView>
              rows={kinds}
              rowKey={(k) => k.kind}
              columns={[
                { key: "kind", header: "Kind", render: (k) => <span className={v.mono}>{k.kind}</span> },
                { key: "label", header: "Scans", render: (k) => k.label },
                {
                  key: "state",
                  header: "State",
                  render: (k) => (k.built ? <Badge tone="ok">built</Badge> : <Badge tone="neutral">{`not built yet (${k.slice})`}</Badge>),
                },
                { key: "evidence", header: "Evidence kinds", render: (k) => k.evidenceKinds.join(", ") },
              ]}
            />
          </Card>

          <Card title={form.editing ? `Edit ${form.editing.name}` : "Add a source"}>
            {built.length === 0 && !form.editing ? (
              <EmptyState
                title="No scanner is built yet"
                body="Repository, cloud and endpoint scanners arrive in later releases (ADR-0195 SD1 to SD4). A source can be added once its scanner is built."
              />
            ) : (
              <div className={v.stack}>
                <div className={v.row}>
                  <Field label="Name" error={formError}>
                    <Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </Field>
                  {!form.editing && (
                    <Field label="Kind">
                      <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                        <option value="">Choose a kind</option>
                        {built.map((k) => (
                          <option key={k.kind} value={k.kind}>
                            {k.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {/* an upload-fed kind (osquery results, MDM/EDR exports) is never scheduled */}
                  {!kinds.find((k) => k.kind === (form.editing?.kind ?? form.kind))?.uploadFed && (
                    <Field label="Schedule (hours)">
                      <Input type="number" min={1} max={720} value={form.scheduleHours} onChange={(e) => setForm({ ...form, scheduleHours: e.target.value })} />
                    </Field>
                  )}
                </div>
                <Field label="Target (one key=value per line)">
                  <Textarea rows={3} value={form.target} spellCheck={false} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                </Field>
                <label className={v.row}>
                  <input type="checkbox" checked={form.orgLevel} onChange={(e) => setForm({ ...form, orgLevel: e.target.checked })} />
                  Organisation-level scope (everything the target holds)
                </label>
                {!form.orgLevel && (
                  <Field label="Scope: what to scan (one per line)">
                    <Textarea rows={3} value={form.include} spellCheck={false} onChange={(e) => setForm({ ...form, include: e.target.value })} />
                  </Field>
                )}
                <div className={v.row}>
                  <Button variant="primary" disabled={act.busy || (!form.editing && !form.kind)} onClick={submitSource}>
                    {form.editing ? "Save source" : "Add source (disabled)"}
                  </Button>
                  {form.editing && <Button onClick={() => setForm(EMPTY_FORM)}>Cancel</Button>}
                </div>
              </div>
            )}
            {act.error && <div className={v.errLine}>{act.error}</div>}
          </Card>

          <Card title="Sources">
            <Table<DiscoverySourceView>
              rows={list}
              rowKey={(s) => s.id}
              empty={<EmptyState title="No discovery source" body="Nothing is scanned. Add a source once a scanner for its kind is built." />}
              columns={[
                { key: "name", header: "Source", render: (s) => <><strong>{s.name}</strong><div className={v.mono}>{s.kind}</div></> },
                { key: "state", header: "State", render: (s) => (s.enabled ? <Badge tone="warn">enabled</Badge> : <Badge tone="neutral">disabled</Badge>) },
                { key: "scope", header: "Scope", render: (s) => <>{describeScope(s.scope)}<div className={v.faint}>{kinds.find((k) => k.kind === s.kind)?.uploadFed ? "fed by uploads" : describeSchedule(s.scheduleIntervalSeconds)}</div></> },
                {
                  key: "credential",
                  header: "Credential",
                  render: (s) =>
                    s.credential ? (
                      <>
                        <Badge tone={s.credential.mode === "static" ? "warn" : "ok"}>{s.credential.mode}</Badge>{" "}
                        {s.credential.ageWarning && <Badge tone="danger">{`${s.credential.ageDays} days old`}</Badge>}
                        {s.credential.writeScope === "unverified" && <div className={v.faint}>write scope unverified</div>}
                        {s.credential.writeScope === "refused" && <Badge tone="danger">refused: grants write access</Badge>}
                      </>
                    ) : (
                      <span className={v.faint}>none</span>
                    ),
                },
                {
                  key: "lastRun",
                  header: "Last run",
                  render: (s) => (s.lastRun ? <Badge tone={RUN_TONE[s.lastRun.status]}>{s.lastRun.status}</Badge> : <span className={v.faint}>never</span>),
                },
                {
                  key: "actions",
                  header: "Actions",
                  render: (s) => (
                    <div className={v.row}>
                      {s.enabled ? (
                        <Button size="sm" disabled={act.busy} onClick={() => disable(s)}>Disable</Button>
                      ) : (
                        <Button size="sm" disabled={act.busy || !s.scannerBuilt} onClick={() => enable(s)}>Enable</Button>
                      )}
                      <Button size="sm" disabled={act.busy || !s.enabled} onClick={() => runNow(s)}>Run now</Button>
                      <Button
                        size="sm"
                        disabled={act.busy}
                        onClick={() =>
                          setForm({
                            editing: s,
                            name: s.name,
                            kind: s.kind,
                            target: formatKeyValues(s.target),
                            orgLevel: s.scope.orgLevel,
                            include: s.scope.include.join("\n"),
                            scheduleHours: String(Math.max(1, Math.round(s.scheduleIntervalSeconds / 3600))),
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button size="sm" disabled={act.busy} onClick={() => setCred({ source: s, mode: "federated", publicConfig: s.credential ? formatKeyValues(editablePublicConfig(s.credential.publicConfig)) : "", secret: "" })}>
                        {s.credential ? "Replace credential" : "Add credential"}
                      </Button>
                      {s.credential && <Button size="sm" variant="danger" disabled={act.busy} onClick={() => revoke(s)}>Revoke credential</Button>}
                      <Button size="sm" variant="danger" disabled={act.busy || s.enabled} onClick={() => remove(s)}>Delete</Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          {cred && (
            <Card title={`Credential for ${cred.source.name}`}>
              <div className={v.stack}>
                <p className={v.faint}>
                  Federated, short-lived credentials are the default. A static secret is allowed as a relaxation: storing one asks you to confirm it&apos;s
                  you, it is encrypted at rest, it is never shown again, and enforcement posture lists it.
                </p>
                <Field label="Mode" error={credError}>
                  <Select value={cred.mode} onChange={(e) => setCred({ ...cred, mode: e.target.value === "static" ? "static" : "federated" })}>
                    <option value="federated">federated (default)</option>
                    <option value="static">static secret (relaxation)</option>
                  </Select>
                </Field>
                <Field label="Public config (non-secret identifiers, one key=value per line)">
                  <Textarea rows={3} value={cred.publicConfig} spellCheck={false} onChange={(e) => setCred({ ...cred, publicConfig: e.target.value })} />
                </Field>
                {cred.mode === "static" && (
                  <Field label="Secret">
                    <Textarea rows={3} value={cred.secret} spellCheck={false} autoComplete="off" onChange={(e) => setCred({ ...cred, secret: e.target.value })} />
                  </Field>
                )}
                <div className={v.row}>
                  <Button variant="primary" disabled={act.busy} onClick={saveCredential}>Save credential</Button>
                  <Button onClick={() => setCred(null)}>Cancel</Button>
                </div>
              </div>
            </Card>
          )}

          <EndpointImportCard sources={list} onDone={refetchAll} />

          <EndpointAgentCard sources={list} />

          <Card title="Recent runs">
            <Table<DiscoveryRunView>
              rows={runs.data?.runs ?? []}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No scan has run" body="Runs appear here once an enabled source is scanned." />}
              columns={[
                { key: "source", header: "Source", render: (r) => list.find((s) => s.id === r.sourceId)?.name ?? r.sourceId },
                { key: "status", header: "Status", render: (r) => <><Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>{r.errorCode && <div className={v.faint}>{r.errorCode}</div>}</> },
                { key: "when", header: "Queued", render: (r) => <>{when(r.createdAt)}<div className={v.faint}>{r.trigger}, attempt {r.attempt}</div></> },
                { key: "counts", header: "Observed / matched", render: (r) => `${r.observed} / ${r.matched}` },
                { key: "findings", header: "Findings", render: (r) => `${r.findingsCreated} new, ${r.findingsUpdated} updated` },
                { key: "gaps", header: "Catalogue gaps", render: (r) => (r.catalogueGaps.length ? r.catalogueGaps.map((g) => `${g.kind}:${g.value}`).join(", ") : "none") },
                { key: "reads", header: "Reads", render: (r) => couldNotRead(r.readOutcomes) ?? <span className={v.faint}>all read</span> },
              ]}
            />
          </Card>

          <FederationCard />

          <Card title="Settings">
            <div className={v.stack}>
              <p className={v.faint}>
                Static credentials older than {settings.data?.credentialWarningAgeDays ?? 90} days are flagged. Endpoint evidence is kept{" "}
                {settings.data?.endpointRetentionDays ?? 90} days. Shortening either is free; lengthening either asks you to confirm it&apos;s you.
              </p>
              <div className={v.row}>
                <Field label="Credential warning age (days)">
                  <Input type="number" min={1} max={365} placeholder={String(settings.data?.credentialWarningAgeDays ?? "")} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} />
                </Field>
                <Field label="Endpoint evidence retention (days)">
                  <Input type="number" min={1} max={3650} placeholder={String(settings.data?.endpointRetentionDays ?? "")} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
                </Field>
              </div>
              <div>
                <Button disabled={act.busy || !settings.data || (!warnDays.trim() && !retentionDays.trim())} onClick={saveSettings}>Save settings</Button>
              </div>
            </div>
          </Card>

          <Card title="Reveal a pseudonym">
            <div className={v.stack}>
              <p className={v.faint}>
                Device users, commit authors and cloud principals appear in findings as pseudonyms (psn:…). Revealing the name behind one asks you to
                confirm it&apos;s you and is audited.
              </p>
              <div className={v.row}>
                <Field label="Pseudonym">
                  <Input value={pseudonym} spellCheck={false} placeholder="psn:…" onChange={(e) => setPseudonym(e.target.value)} />
                </Field>
                <Button disabled={act.busy || !/^psn:[0-9a-f]{24}$/.test(pseudonym.trim())} onClick={reveal}>Reveal</Button>
              </div>
              {revealed && (
                <p data-testid="revealed-pseudonym">
                  <span className={v.mono}>{revealed.pseudonym}</span> ({revealed.kind}) is <strong>{revealed.displayName}</strong>
                </p>
              )}
            </div>
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
