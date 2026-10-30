/**
 * ADR-0195 SD0 — Discovery sources: where RegulAIt may scan, read-only, for
 * shadow AI (source-control organisations, cloud accounts, endpoint fleets).
 *
 * Honesty rules this page keeps:
 *  - A source kind is selectable only when its scanner is built. SD0 builds
 *    only SD3's two upload-fed endpoint kinds; every other kind shows "Not built yet", and the add form says so
 *    instead of offering a submit that would fail.
 *  - Every source starts disabled. Enabling one, widening an enabled one's
 *    target or scope, storing a static secret, lengthening the warning age or
 *    the endpoint retention, and revealing a pseudonym each ask the admin to
 *    confirm it's them (withStepUp); disabling and revoking never do.
 *  - A credential's secret is never shown: the gateway never returns it. The
 *    page shows its mode, its public config, its age and whether its write
 *    scope has been verified.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtDateTime, humanize, plural } from "../../../api/format";
import ds from "./discoverySources.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, InfoButton, Input, RowActions, Select, Table, Textarea } from "../../../ui/kit";
import { FoldTable } from "../../../ui/fold";
import { DataList } from "../../../ui/DataList";
import { QueryGate, Stat, useAction } from "../adminKit";
import v from "../../views.module.css";
import FederationCard from "./FederationCard";
import { EndpointImportCard } from "./EndpointImportCard";
import { EndpointAgentCard } from "./EndpointAgentCard";
import {
  couldNotRead,
  describeGap,
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

const nowrap = { whiteSpace: "nowrap" } as const;
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
  const queryClient = useQueryClient();
  const scanners = useQuery({ queryKey: ["admin", "discovery", "scanners"], queryFn: () => api.get<{ kinds: ScannerKindView[] }>("/v1/discovery/scanners") });
  const sources = useQuery({
    queryKey: ["admin", "discovery", "sources"],
    queryFn: () => api.get<{ sources: DiscoverySourceView[]; posture: DiscoveryPostureView }>("/v1/discovery/sources"),
  });
  // ADR-0219: the runs page on the server; one small page carries the total and the failed count across every run
  const runs = useQuery({
    queryKey: ["admin", "discovery", "runs", "summary"],
    queryFn: () => api.get<{ items: DiscoveryRunView[]; total: number | null; totalIsEstimate: boolean; failed?: number }>("/v1/discovery/runs?limit=10&count=estimate&sort=when&dir=desc"),
  });
  const runTotal = runs.data?.total ?? null;
  const runTotalText = runTotal === null ? "—" : runs.data?.totalIsEstimate ? `${runTotal.toLocaleString("en-GB")}+ recent runs` : plural(runTotal, "recent run");
  // X6b: a collapsed "Recent runs" still says when a scan failed
  const failedRuns = runs.data?.failed ?? 0;
  // A15: the Recent runs fold header (and its count) waits for the runs read, so a pending or failed read never says
  // "0 runs"; until then the table shows its skeleton, or the error with Retry
  const runsFold = runs.data
    ? ({ contain: true, foldable: true, startCollapsed: true, count: runTotal ?? 0 } as const)
    : ({ contain: true } as const);
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
  // a psn: link lands on the prefilled Pseudonym field: scrolled into view and focused, once the page has rendered
  const pseudonymRef = useRef<HTMLInputElement>(null);
  const linkedPseudonym = params.get("pseudonym");
  const pageReady = !sources.isPending && !scanners.isPending && !sources.error && !scanners.error;
  useEffect(() => {
    const el = pseudonymRef.current;
    if (!linkedPseudonym || !pageReady || !el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }, [linkedPseudonym, pageReady]);

  const kinds = scanners.data?.kinds ?? [];
  const built = kinds.filter((k) => k.built);
  const posture = sources.data?.posture;
  const list = sources.data?.sources ?? [];
  const refetchAll = async () => {
    await Promise.all([sources.refetch(), queryClient.invalidateQueries({ queryKey: ["admin", "discovery", "runs"] }), settings.refetch()]);
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
    }, editing ? (editing.enabled && scopeWidens(editing.scope, scope) ? "Source widened" : "Source saved") : "Source added. It stays off until you enable it.");
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
      <PageHeader
        title="Discovery sources"
        info={
          <>
            Discovery sources are the places regulAIt reads, read-only, to find AI use nobody registered, such as cloud
            accounts, code repositories and identity logs. Each source is off until an admin turns it on, and every scan
            is audited.
          </>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={sources.isPending || scanners.isPending} error={sources.error ?? scanners.error} onRetry={() => void refetchAll()}>
          {/* S1: how discovery works, in three steps drawn from the live posture */}
          <ol className={ds.howItWorks} aria-label="How discovery works">
            <li>
              <span className={ds.stepNo} aria-hidden="true">1</span>
              <span><strong>Connect read-only</strong><span className={v.faint}>{posture?.sourcesEnabled.length ?? 0} of {posture?.sourcesTotal ?? 0} sources enabled</span></span>
            </li>
            <li>
              <span className={ds.stepNo} aria-hidden="true">2</span>
              <span><strong>Scan on a schedule</strong><span className={v.faint}>{runTotalText}</span></span>
            </li>
            <li>
              <span className={ds.stepNo} aria-hidden="true">3</span>
              <span><strong>Findings land in Shadow-AI discovery</strong><span className={v.faint}><Link to="/admin/shadow-ai">Open the findings</Link></span></span>
            </li>
          </ol>
          <Card
            title="Active discovery"
            info={
              <p className={ds.inlineLinks}>
                Findings land in <Link to="/admin/shadow-ai">Shadow-AI discovery</Link> only when an observation matches an enabled row of your
                signature catalogue. Unmatched observations are listed per run as catalogue gaps.
              </p>
            }
          >
            <p data-testid="discovery-statement">{posture?.statement}</p>
          </Card>
          <div className={v.grid5}>
            <Stat value={`${posture?.sourcesEnabled.length ?? 0} of ${posture?.sourcesTotal ?? 0}`} label={<>Sources enabled<InfoButton label="Sources enabled">How many configured sources are switched on. A source that is off is never scanned, so anything it would find is missing from the findings.</InfoButton></>} />
            <Stat value={posture?.staticCredentials.length ?? 0} label={<>Static credentials in use<InfoButton label="Static credentials in use">Sources that sign in with a stored key instead of short-lived federated access. Allowed, but rotate them regularly. Federation is preferred.</InfoButton></>} />
            <Stat value={posture?.staleCredentials.length ?? 0} label={<>Static credentials older than {posture?.credentialWarningAgeDays ?? 90} days<InfoButton label="old static credentials">Stored keys past the warning age set in Settings on this page. Rotate them or switch the source to federated access.</InfoButton></>} />
            <Stat value={posture?.writeScopeUnverified.length ?? 0} label={<>Write scope unverified<InfoButton label="Write scope unverified">regulAIt asks only for read access. This counts credentials it could not confirm are read-only. Check the role in the provider console before the next scan.</InfoButton></>} />
            <Stat value={posture?.credentialsRefused?.length ?? 0} label={<>Credentials refused (write access)<InfoButton label="Credentials refused">regulAIt refuses a credential that grants write access, and its source is not scanned until a read-only credential replaces it.</InfoButton></>} />
          </div>

          <Card title="Scanner kinds">
            <Table<ScannerKindView>
              rows={kinds}
              rowKey={(k) => k.kind}
              columns={[
                { key: "kind", header: "Kind", render: (k) => <>{k.label}<div className={`${v.faint} ${v.mono}`}>{k.kind}</div></> },
                {
                  key: "state",
                  header: "State",
                  render: (k) => (k.built ? <Badge tone="ok">built</Badge> : <Badge tone="neutral">Not built yet</Badge>),
                },
                { key: "evidence", header: "Evidence kinds", render: (k) => <>{k.evidenceKinds.map(humanize).join(", ")}<div className={`${v.faint} ${v.mono}`}>{k.evidenceKinds.join(", ")}</div></> },
              ]}
            />
          </Card>

          <Card title={form.editing ? `Edit ${form.editing.name}` : "Add a source"}>
            {built.length === 0 && !form.editing ? (
              <EmptyState
                title="No scanner is built yet"
                body="Repository, cloud and endpoint scanners arrive in later releases. A source can be added once its scanner is built."
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
                    <Field label="Schedule (hours)" help="How often an enabled source is scanned. A shorter interval finds new use sooner and makes more calls to the provider.">
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
                  <Field label="Scope: what to scan (one per line)" help="List at least one account, project or group, one per line. To scan everything, choose the organisation-level scope.">
                    <Textarea rows={3} value={form.include} spellCheck={false} onChange={(e) => setForm({ ...form, include: e.target.value })} />
                  </Field>
                )}
                <div className={v.row}>
                  <Button
                    variant="primary"
                    disabled={act.busy || (!form.editing && !form.kind)}
                    title={!form.editing && !form.kind ? "Choose a kind first" : undefined}
                    aria-describedby={form.editing ? undefined : "add-source-hint"}
                    onClick={submitSource}
                  >
                    {form.editing ? "Save source" : "Add source"}
                  </Button>
                  {form.editing && <Button onClick={() => setForm(EMPTY_FORM)}>Cancel</Button>}
                </div>
                {!form.editing && (
                  <p id="add-source-hint" className={v.faint} data-testid="add-source-hint">
                    A new source is added turned off. Enabling it asks you to confirm it&apos;s you.
                  </p>
                )}
              </div>
            )}
            {act.error && <div className={v.errLine} role="alert">{act.error}</div>}
          </Card>

          <SourceWarnings sources={list} />
          <Card title="Sources" contain>
            <Table<DiscoverySourceView>
              rows={list}
              rowKey={(s) => s.id}
              empty={<EmptyState title="No discovery source" body="Nothing is scanned yet. Add a source above to start scanning, read-only." />}
              columns={[
                { key: "name", header: "Source", render: (s) => <><strong>{s.name}</strong><div className={v.faint}>{kinds.find((k) => k.kind === s.kind)?.label ?? s.kind}</div></> },
                { key: "state", header: "State", render: (s) => (s.enabled ? <Badge tone="warn">enabled</Badge> : <Badge tone="neutral">disabled</Badge>) },
                { key: "scope", header: "Scope", render: (s) => <>{describeScope(s.scope)}<div className={v.faint}>{kinds.find((k) => k.kind === s.kind)?.uploadFed ? "fed by uploads" : describeSchedule(s.scheduleIntervalSeconds)}</div></> },
                {
                  key: "credential",
                  header: "Credential",
                  render: (s) =>
                    s.credential ? (
                      <>
                        <Badge tone={s.credential.mode === "static" ? "warn" : "ok"}>{s.credential.mode === "static" ? "Static key" : humanize(s.credential.mode)}</Badge>{" "}
                        {s.credential.ageWarning && <Badge tone="danger">{`${s.credential.ageDays} days old`}</Badge>}
                        {s.credential.writeScope === "unverified" && (
                          <div>
                            <Badge tone="warn" info="regulAIt asks only for read access and could not confirm this credential is read-only. Check the role in the provider console before the next scan.">Write scope unverified</Badge>
                          </div>
                        )}
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
                    <>
                    <RowActions
                      slot="6.5rem"
                      primary={
                        s.enabled ? (
                          <Button size="sm" disabled={act.busy} onClick={() => runNow(s)}>Run now</Button>
                        ) : (
                          <Button size="sm" disabled={act.busy || !s.scannerBuilt} onClick={() => enable(s)}>Enable</Button>
                        )
                      }
                      secondary={
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
                      }
                      rest={
                        <details className={ds.more}>
                          <summary>More</summary>
                          <div className={v.row}>
                            {s.enabled ? <Button size="sm" disabled={act.busy} onClick={() => disable(s)}>Disable</Button> : null}
                      <Button size="sm" disabled={act.busy} onClick={() => setCred({ source: s, mode: "federated", publicConfig: s.credential ? formatKeyValues(editablePublicConfig(s.credential.publicConfig)) : "", secret: "" })}>
                        {s.credential ? "Replace credential" : "Add credential"}
                      </Button>
                            {s.credential && <Button size="sm" variant="danger" disabled={act.busy} onClick={() => revoke(s)}>Revoke credential</Button>}
                            <Button size="sm" variant="danger" disabled={act.busy || s.enabled} onClick={() => remove(s)}>Delete</Button>
                          </div>
                          {s.enabled ? <p className={v.faint}>Delete is available once the source is disabled.</p> : null}
                        </details>
                      }
                    />
                    {!s.enabled && !s.scannerBuilt ? <div className={v.faint}>Its scanner is not built yet, so it cannot be enabled.</div> : null}
                    </>
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
                    <option value="federated">Federated (default)</option>
                    <option value="static">Static secret (relaxation)</option>
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

          {/* F20 (#453): Recent runs takes the full width, and Reveal a pseudonym its own row below it */}
          <Card
            title="Recent runs"
            {...runsFold}
            // the folding card mounts fresh once the runs are read, so it starts collapsed (a fold reads its start once)
            key={runs.data ? "runs" : "runs-pending"}
            countIsLimit={runs.data?.totalIsEstimate ?? false}
            countNoun={["run", "runs"]}
            attention={failedRuns > 0 ? <Badge tone="danger">{failedRuns} failed</Badge> : undefined}
          >
            <DataList<DiscoveryRunView>
              listId="discovery-runs"
              noun="runs"
              endpoint="/v1/discovery/runs"
              exportPath="/v1/discovery/runs/export.xlsx"
              queryKey={["admin", "discovery", "runs", "list"]}
              legacyKey="runs"
              count="estimate"
              defaultSort={{ key: "when", dir: "desc" }}
              table={FoldTable}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No scan has run" body="Runs appear here once an enabled source is scanned." />}
              columns={[
                // below 1000 px of table width, Queued folds under Source, Observed / matched under Findings and Reads
                // under Status; on a phone Findings and Catalogue gaps fold under Source too
                { key: "source", main: true, sortable: true, header: "Source", render: (r) => list.find((s) => s.id === r.sourceId)?.name ?? r.sourceId },
                { key: "status", main: true, sortable: true, required: "Status, and a failed scan, are always shown", header: "Status", render: (r) => (
                  <>
                    <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
                    {/* A20: the reason in words, the code as secondary text under it */}
                    {r.errorCode && (
                      <>
                        <div>{humanize(r.errorCode)}{r.errorDetail ? `: ${r.errorDetail}` : ""}</div>
                        <div className={`${v.faint} ${v.mono}`} style={{ overflowWrap: "anywhere" }}>{r.errorCode}</div>
                      </>
                    )}
                  </>
                ) },
                { key: "when", main: true, sortable: true, header: "Queued", fold: { md: "source" }, render: (r) => <><span style={nowrap}>{fmtDateTime(r.createdAt)}</span><div className={v.faint}>{r.trigger === "schedule" ? "Scheduled" : "Manual"} · attempt {r.attempt}</div></> },
                { key: "counts", main: true, sortable: true, header: "Observed / matched", fold: { md: "findings" }, render: (r) => `${r.observed} / ${r.matched}` },
                { key: "findings", main: true, sortable: true, header: "Findings", fold: { sm: "source" }, render: (r) => `${r.findingsCreated} new, ${r.findingsUpdated} updated` },
                {
                  key: "gaps",
                  header: "Catalogue gaps",
                  main: true,
                  sortable: true,
                  fold: { sm: "source" },
                  render: (r) =>
                    r.catalogueGaps.length ? (
                      <div className={v.stackTight}>
                        {r.catalogueGaps.map((g) => {
                          const d = describeGap(g);
                          return (
                            <div key={d.code} data-testid="catalogue-gap">
                              {d.kind}: <strong>{d.name}</strong>
                              <div className={`${v.faint} ${v.mono}`}>{d.code}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      "none"
                    ),
                },
                { key: "reads", header: "Reads", fold: { md: "status" }, render: (r) => couldNotRead(r.readOutcomes) ?? <span className={v.faint} style={nowrap}>all read</span> },
              ]}
            />
          </Card>

          <Card title="Reveal a pseudonym" actions={<Badge tone="info">Audited · step-up</Badge>}>
            <div className={v.stack}>
              <div className={v.row}>
                <Field label="Pseudonym" help="Device users, commit authors and cloud principals appear in findings as pseudonyms (psn:…). Revealing the name behind one asks you to confirm it's you, and every reveal is audited.">
                  <Input ref={pseudonymRef} value={pseudonym} spellCheck={false} placeholder="psn:…" onChange={(e) => setPseudonym(e.target.value)} />
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

          <FederationCard />

          <Card title="Settings">
            {/* A15: the stated ages wait for the read; a failed read says so, with Retry */}
            <QueryGate loading={settings.isPending} error={settings.error} onRetry={() => void settings.refetch()}>
            <div className={v.stack}>
              <p className={v.faint}>
                Static credentials older than {settings.data?.credentialWarningAgeDays ?? 90} days are flagged. Endpoint evidence is kept{" "}
                {settings.data?.endpointRetentionDays ?? 90} days. Shortening either is free; lengthening either asks you to confirm it&apos;s you.
              </p>
              <div className={v.row}>
                <Field label="Credential warning age (days)" help="Static credentials older than this are flagged on this page.">
                  <Input type="number" min={1} max={365} placeholder={String(settings.data?.credentialWarningAgeDays ?? "")} value={warnDays} onChange={(e) => setWarnDays(e.target.value)} />
                </Field>
                <Field label="Endpoint evidence retention (days)" help="Device findings and pseudonyms not seen within this window are deleted. The audit log is kept.">
                  <Input type="number" min={1} max={3650} placeholder={String(settings.data?.endpointRetentionDays ?? "")} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
                </Field>
              </div>
              <div>
                <Button disabled={act.busy || !settings.data || (!warnDays.trim() && !retentionDays.trim())} onClick={saveSettings}>Save settings</Button>
              </div>
            </div>
            </QueryGate>
          </Card>

        </QueryGate>
      </div>
    </>
  );
}

/**
 * Every credential warning on the Sources table, listed above its scroll box: a warning never sits only inside a
 * contained section (ADR-0180), so none can be scrolled out of sight. Renders nothing when no source needs attention.
 */
function SourceWarnings(props: { sources: DiscoverySourceView[] }) {
  const items = props.sources.flatMap((s) => {
    const c = s.credential;
    if (!c) return [];
    const out: { key: string; tone: "danger" | "warn"; text: string }[] = [];
    if (c.writeScope === "refused") out.push({ key: "refused", tone: "danger", text: "credential refused: it grants write access" });
    if (c.ageWarning) out.push({ key: "age", tone: "danger", text: `static key ${c.ageDays} days old` });
    if (c.writeScope === "unverified") out.push({ key: "unverified", tone: "warn", text: "write scope unverified" });
    return out.map((w) => ({ ...w, key: `${s.id}:${w.key}`, name: s.name }));
  });
  if (items.length === 0) return null;
  return (
    <div className={v.stackTight} role="list" aria-label="Sources that need attention" data-testid="source-warnings">
      {items.map((w) => (
        <div key={w.key} role="listitem">
          <Badge tone={w.tone}>{w.name}</Badge> <span className={v.dim}>{w.text}</span>
        </div>
      ))}
    </div>
  );
}
