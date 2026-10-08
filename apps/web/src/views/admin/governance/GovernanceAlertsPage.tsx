import { batch4SettingRelaxed, BATCH4_SETTING_COPY, BATCH4_STRICT_DEFAULTS } from "./monitorThresholds";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, SeverityBadge, Tabs, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, useAction, useUsers } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type AlertStatus = "open" | "acknowledged" | "resolved";
interface GovernanceAlert {
  id: string;
  ruleId: string;
  ruleLabel: string;
  severity: string;
  status: AlertStatus;
  subject: { key: string; type: string; id: string | null; label: string; context: { key: string; id: string; label: string } | null };
  title: string;
  detail: {
    sourceNodeKey?: string;
    sourceRiskId?: string;
    path?: string[];
    pathLabels?: string[];
    /** ADR-0182 S5 (PF-03): a KRI set to suggest a halt; nothing was filed */
    suggestedAction?: { kind: "halt_agent"; agentId: string };
  };
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
  /** ADR-0182 S5 (PF-14): owner, SLA and ticket (absent on an older gateway) */
  owner?: { id: string; name: string | null; source: "derived" | "assigned" | null } | null;
  dueAt?: string | null;
  slaBreachedAt?: string | null;
  sla?: SlaState;
  ticket?: AlertTicket | null;
}
type SlaState = "none" | "on_track" | "due_soon" | "breached" | "met";
interface AlertTicket { connectionId: string; connectionName: string; externalId: string; externalUrl: string }
interface OwnershipView {
  owner: GovernanceAlert["owner"];
  dueAt: string | null;
  slaBreachedAt: string | null;
  sla: SlaState;
  ticket: AlertTicket | null;
}
interface AlertsResponse {
  alerts: GovernanceAlert[];
  counts: { open: number; acknowledged: number; resolved: number };
  lastEvaluatedAt: string | null;
  rules: Array<{ id: string; label: string; severity: string; description: string }>;
}
interface EvaluationResult { evaluatedAt: string; raised: number; refreshed: number; resolved: number; active: number }
interface RemediationCandidate {
  kind: string;
  executable: boolean;
  title: string;
  rationale: string;
  params: Record<string, unknown>;
  steps: string[];
  /** a guidance step that starts in an existing screen (ADR-0175 A9: the register flow, prefilled) */
  href?: string;
}
interface RemediationProposal {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  status: "pending_approval" | "applied" | "denied" | "failed";
  approvalId: string;
  proposedByUserId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  result: unknown;
  createdAt: string;
}
interface RemediationResponse {
  alert: { id: string; ruleId: string; status: string; title: string };
  candidates: RemediationCandidate[];
  proposals: RemediationProposal[];
  note: string;
}

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "acknowledged", label: "Acknowledged" },
  { id: "resolved", label: "Resolved" },
];

export default function GovernanceAlertsPage() {
  const [status, setStatus] = useState("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [evaluation, setEvaluation] = useState<EvaluationResult | null>(null);
  const [postResult, setPostResult] = useState<string | null>(null);
  const action = useAction();
  const alerts = useQuery({
    queryKey: ["governance", "alerts", status],
    queryFn: () => api.get<AlertsResponse>(`/v1/governance/alerts?status=${status}`),
  });
  const selected = alerts.data?.alerts.find((alert) => alert.id === selectedId) ?? null;
  const refresh = async () => { await alerts.refetch(); };
  // the detail column is sticky at desktop width; at phone width it sits
  // below the list, so selecting an alert brings it into view (UXJ-02)
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedId]);

  return (
    <>
      <PageHeader
        title="Governance alerts"
        sub="Monitor conditions that require a human response, with acknowledgement and automatic resolution kept distinct."
        info={<p>Evaluation checks the current governed graph, risk register, model-card state, vendor state, and evidence coverage. Acknowledging records ownership of the response; it does not resolve the underlying condition.</p>}
      />
      <div className={v.stack}>
        <Card>
          <div className={v.row}>
            <div className={v.kpiStrip} style={{ flex: 1 }}>
              <AlertStat label="Open" value={alerts.data?.counts.open ?? 0} alarm />
              <AlertStat label="Acknowledged" value={alerts.data?.counts.acknowledged ?? 0} />
              <AlertStat label="Resolved" value={alerts.data?.counts.resolved ?? 0} />
            </div>
            <Button
              variant="primary"
              disabled={action.busy}
              onClick={() => void action.run(async () => {
                const result = await api.post<EvaluationResult>("/v1/governance/monitor/evaluate");
                setEvaluation(result);
                await refresh();
              }, null)}
            >
              Evaluate now
            </Button>
          </div>
          <p className={v.faint}>Last evaluated: {alerts.data?.lastEvaluatedAt ? ago(alerts.data.lastEvaluatedAt) : "not evaluated yet"}</p>
          {evaluation ? <p className={s.statusLine} role="status">Evaluation raised {evaluation.raised}, refreshed {evaluation.refreshed}, resolved {evaluation.resolved}; {evaluation.active} remain active.</p> : null}
        </Card>

        <Tabs tabs={FILTERS} active={status} onChange={(next) => { setStatus(next); setSelectedId(null); }} />
        <QueryGate loading={alerts.isLoading} error={alerts.error} onRetry={() => void alerts.refetch()}>
          {(alerts.data?.alerts.length ?? 0) === 0 ? (
            <EmptyState
              title={`No ${status} alerts`}
              body={status === "active"
                ? alerts.data?.lastEvaluatedAt
                  ? "The latest monitor evaluation found no currently active governance conditions."
                  : "The governance monitor has not run yet. Select Evaluate now before treating this as an all-clear state."
                : "Alerts appear here when their lifecycle reaches this state."}
            />
          ) : (
            <div className={s.alertLayout}>
              <div className={s.alertList}>
                {alerts.data?.alerts.map((alert) => (
                  <button key={alert.id} className={`${s.alertRow} ${selectedId === alert.id ? s.alertRowActive : ""}`} onClick={() => setSelectedId(alert.id)}>
                    <span className={s.alertRowHead}><SeverityBadge severity={alert.severity} />{alert.status === "open" ? null : <span className={v.faint}>{alert.status}</span>}<SlaChip alert={alert} /></span>
                    <strong>{alert.title}</strong>
                    <span className={v.faint}>{alert.ruleLabel} · seen {ago(alert.lastDetectedAt)}{alert.owner !== undefined ? ` · ${alert.owner ? `owner ${alert.owner.name ?? "a user"}` : "unowned"}` : ""}</span>
                  </button>
                ))}
              </div>
              <div className={s.alertDetail} ref={detailRef} data-testid="alert-detail">
              {selected ? (
                <Card title={selected.subject.label}>
                  <div className={v.stack}>
                    <div className={v.row}><SeverityBadge severity={selected.severity} />{selected.status === "open" ? null : <span className={v.dim}>{selected.status}</span>}<span className={v.faint}>{selected.ruleLabel}</span></div>
                    <p>{selected.title}</p>
                    <SubjectLinks alert={selected} />
                    <OwnershipPanel alert={selected} onChanged={refresh} />
                    <div className={v.row}>
                      <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => void action.run(async () => {
                        const posted = await api.post<{ posted: true; connection: string; channel: string }>(`/v1/governance/alerts/${selected.id}/post`);
                        setPostResult(`Posted to ${posted.connection} · ${posted.channel}`);
                      }, null)}>Post to chat</Button>
                      <span className={v.faint}>Uses the first enabled workspace unless the API is given an explicit connection.</span>
                    </div>
                    {postResult ? <p className={s.statusLine} role="status">{postResult}</p> : null}
                    {action.error ? <p className={v.errLine} role="alert">{action.error}</p> : null}
                    {(selected.detail.pathLabels ?? selected.detail.path)?.length ? (
                      <div><strong>Inherited-risk path</strong><ol className={s.pathList}>{(selected.detail.pathLabels ?? selected.detail.path ?? []).map((part) => <li key={part}>{part}</li>)}</ol></div>
                    ) : null}
                    {selected.detail.sourceRiskId ? <Link to={`/admin/risks?riskId=${selected.detail.sourceRiskId}`}>Open source risk</Link> : null}
                    {/* ADR-0182 A12: report an incident from this alert (the form arrives pre-linked to it) */}
                    <div><Link to={`/incidents?new=1&detectionSource=monitor_alert&sourceRef=${selected.id}`}>Open incident</Link></div>
                    {selected.ackNote ? <p className={v.dim}>Acknowledgement note: {selected.ackNote}</p> : null}
                    {selected.status === "open" ? (
                      <div className={v.stack}>
                        <Field label="Acknowledgement note — required and audited">
                          <Textarea rows={3} maxLength={500} value={ackNote} onChange={(event) => setAckNote(event.target.value)} />
                        </Field>
                        <span className={v.faint}>{ackNote.length}/500 characters</span>
                        <div><Button disabled={action.busy || !ackNote.trim()} onClick={() => void action.run(async () => {
                          await api.post(`/v1/governance/alerts/${selected.id}/acknowledge`, { note: ackNote.trim() });
                          setAckNote("");
                          await refresh();
                        }, "Alert acknowledged")}>Acknowledge</Button></div>
                      </div>
                    ) : null}
                    {selected.detail.suggestedAction?.kind === "halt_agent" && selected.status !== "resolved" ? (
                      <p className={s.statusLine} role="note" data-testid="suggested-halt">
                        This KRI is set to suggest halting its agent when it breaches. Nothing has been filed and the agent is
                        still running: Propose halt below puts one halt request on the approvals queue with you as its
                        proposer, and a different person must approve it before anything stops.
                      </p>
                    ) : null}
                    <RemediationPanel alertId={selected.id} />
                  </div>
                </Card>
              ) : <Card><p className={v.dim}>Select an alert to inspect its condition, subject, and response history.</p></Card>}
              </div>
            </div>
          )}
        </QueryGate>
        <DetectionMonitorSettings />
        <AlertSettingsCard />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ADR-0182 S5 (PF-14) — owner, SLA and ticket
// ---------------------------------------------------------------------------

const SLA_CHIP: Record<Exclude<SlaState, "none">, { tone: Tone; label: string }> = {
  on_track: { tone: "info", label: "SLA on track" },
  due_soon: { tone: "warn", label: "SLA due soon" },
  breached: { tone: "danger", label: "SLA breached" },
  met: { tone: "ok", label: "SLA met" },
};

function SlaChip({ alert }: { alert: Pick<GovernanceAlert, "sla" | "dueAt"> }) {
  if (!alert.sla || alert.sla === "none") return null;
  const chip = SLA_CHIP[alert.sla];
  return <Badge tone={chip.tone} title={alert.dueAt ? `Due ${new Date(alert.dueAt).toUTCString()}` : undefined}>{chip.label}</Badge>;
}

/** a work item's link only when it is a web address; anything else is shown as text */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function OwnershipPanel({ alert, onChanged }: { alert: GovernanceAlert; onChanged: () => Promise<void> }) {
  const users = useUsers();
  const action = useAction();
  const [ownerId, setOwnerId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const connections = useQuery({
    queryKey: ["pm", "connections"],
    queryFn: () => api.get<{ connections: Array<{ id: string; name: string; provider: string }> }>("/v1/pm/connections"),
  });
  if (alert.owner === undefined) return null; // an older gateway: nothing to show
  const resolved = alert.status === "resolved";
  const active = (users.data?.users ?? []).filter((u) => !(u as { disabledAt?: string | null }).disabledAt);
  const href = alert.ticket ? safeHref(alert.ticket.externalUrl) : null;
  return (
    <div className={v.stack} data-testid="alert-ownership">
      <div className={v.sectionTitle} style={{ marginTop: 0 }}>Owner and SLA</div>
      <div className={v.row}>
        <span>
          Owner: {alert.owner ? <strong>{alert.owner.name ?? alert.owner.id}</strong> : <Badge tone="warn">unowned</Badge>}
          {alert.owner?.source ? <span className={v.faint}> · {alert.owner.source === "derived" ? "derived from the subject" : "assigned"}</span> : null}
        </span>
        <SlaChip alert={alert} />
        <span className={v.faint}>
          {alert.dueAt ? `Due ${new Date(alert.dueAt).toUTCString()}` : "No due time yet"}
          {alert.slaBreachedAt ? ` · breached ${ago(alert.slaBreachedAt)}, escalated to the admins` : ""}
        </span>
      </div>
      <p className={v.faint}>
        An alert is due until its condition clears; acknowledging records who is responding and does not stop the clock. regulAIt never resolves or acknowledges an alert because its time ran out.
      </p>
      {!resolved ? (
        <div className={v.row}>
          <Field label="Assign to">
            <Select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
              <option value="">Choose a person</option>
              {active.map((u) => <option key={u.id} value={u.id}>{u.displayName || u.email}</option>)}
            </Select>
          </Field>
          <Button size="sm" disabled={action.busy || !ownerId} onClick={() => void action.run(async () => {
            await api.put<OwnershipView>(`/v1/governance/alerts/${alert.id}/owner`, { userId: ownerId });
            setOwnerId("");
            await onChanged();
          }, "Owner assigned")}>Assign</Button>
        </div>
      ) : null}
      <div className={v.sectionTitle}>Work item</div>
      {alert.ticket ? (
        <p data-testid="alert-ticket">
          Filed as {href ? <a href={href} target="_blank" rel="noreferrer noopener">{alert.ticket.externalId}</a> : <code>{alert.ticket.externalId}</code>} on {alert.ticket.connectionName}. One work item per alert: filing again returns this one.
        </p>
      ) : resolved ? (
        <p className={v.faint}>No work item was filed for this alert.</p>
      ) : (connections.data?.connections ?? []).length === 0 ? (
        <p className={v.faint}>No PM connection is configured. Add one under integrations to file a work item.</p>
      ) : (
        <div className={v.row}>
          <Field label="PM connection">
            <Select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
              <option value="">Choose a connection</option>
              {(connections.data?.connections ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>)}
            </Select>
          </Field>
          <Button size="sm" disabled={action.busy || !connectionId} onClick={() => void action.run(async () => {
            await api.post(`/v1/governance/alerts/${alert.id}/ticket`, { connectionId });
            await onChanged();
          }, "Work item filed")}>File work item</Button>
          <span className={v.hint}>Sends the rule, the severity, the alert&apos;s title and a link to the PM tool; a person the alert is about is named only by user id.</span>
        </div>
      )}
      {action.error ? <p className={v.errLine} role="alert">{action.error}</p> : null}
    </div>
  );
}

/**
 * The two alert settings (admin; the page is admin-only). MIRRORS
 * `ACCOUNTABILITY_STRICT_DEFAULTS`, `_SETTING_COPY` and `_SETTING_LIMITS` in
 * packages/shared/src/accountability.ts — the SPA does not import the shared
 * package, and the gateway refuses anything outside the bounds, so drift
 * fails loudly. Every change goes through the audited PUT /v1/org/settings.
 */
const ALERT_SLA_STRICT = { high: 24, medium: 72, low: 168 } as const;
const ALERT_SLA_MAX = 720;
const SLA_COPY = {
  strict: "24 hours for high, 72 for medium, 168 for low; a breached episode is escalated to the admins.",
  relaxed: "Longer times (each up to 720 hours) let an alert stay unhandled longer before it is escalated.",
};
const TICKET_COPY = {
  strict: "Manual: a work item is filed in the PM tool only when a person asks for one.",
  relaxed:
    "Automatic for high alerts files a work item in the chosen third-party PM tool for every new high episode, with the " +
    "alert's title in the work item description; people appear as 'a user (id …)'.",
};
type Sev = keyof typeof ALERT_SLA_STRICT;
const SEVERITIES: Sev[] = ["high", "medium", "low"];

function AlertSettingsCard() {
  const action = useAction();
  const settings = useQuery({
    queryKey: ["org", "settings"],
    queryFn: () =>
      api.get<{ settings: { alertSlaHours?: Record<Sev, number>; alertTicketMode?: "manual" | "auto_high"; alertTicketConnectionId?: string | null } }>(
        "/v1/org/settings",
      ),
  });
  const connections = useQuery({
    queryKey: ["pm", "connections"],
    queryFn: () => api.get<{ connections: Array<{ id: string; name: string; provider: string }> }>("/v1/pm/connections"),
  });
  const [pickedConnection, setPickedConnection] = useState<string | null>(null);
  const current = settings.data?.settings;
  const [draft, setDraft] = useState<Partial<Record<Sev, string>>>({});
  if (!current?.alertSlaHours || !current.alertTicketMode) return null;
  const hours = current.alertSlaHours;
  const value = (sev: Sev) => draft[sev] ?? String(hours[sev]);
  const next = Object.fromEntries(SEVERITIES.map((sev) => [sev, Number(value(sev))])) as Record<Sev, number>;
  const valid = SEVERITIES.every((sev) => Number.isInteger(next[sev]) && next[sev] >= 1 && next[sev] <= ALERT_SLA_MAX);
  const changed = SEVERITIES.some((sev) => next[sev] !== hours[sev]);
  const slaRelaxed = SEVERITIES.some((sev) => hours[sev] > ALERT_SLA_STRICT[sev]);
  const ticketRelaxed = current.alertTicketMode !== "manual";
  // the ONE connection automatic tickets go to: never chosen for the admin
  const savedConnection = current.alertTicketConnectionId ?? null;
  const connection = pickedConnection ?? savedConnection ?? "";
  const stopped = current.alertTicketMode === "auto_high" && !savedConnection;
  return (
    <Card title="Alert SLA and tickets — settings">
      <div className={v.stack} data-testid="alert-settings">
        <div className={v.row}>
          <strong>Alert SLA (hours per severity)</strong>
          {slaRelaxed ? <Badge tone="warn">relaxed</Badge> : <Badge tone="ok">strict default</Badge>}
        </div>
        <p className={v.faint}>Strict default: {SLA_COPY.strict} {slaRelaxed ? SLA_COPY.relaxed : null}</p>
        <div className={v.row}>
          {SEVERITIES.map((sev) => (
            <Field key={sev} label={`${sev[0]!.toUpperCase()}${sev.slice(1)} (hours)`}>
              <Input type="number" min={1} max={ALERT_SLA_MAX} value={value(sev)} style={{ width: 110 }}
                onChange={(event) => setDraft((d) => ({ ...d, [sev]: event.target.value }))} />
            </Field>
          ))}
          <Button size="sm" disabled={action.busy || !valid || !changed} onClick={() => void action.run(async () => {
            await api.put("/v1/org/settings", { alertSlaHours: next });
            setDraft({});
            await settings.refetch();
          }, "Alert SLA saved (audited)")}>Save SLA</Button>
          <Button size="sm" variant="ghost" disabled={action.busy || SEVERITIES.every((sev) => hours[sev] === ALERT_SLA_STRICT[sev])} onClick={() => void action.run(async () => {
            await api.put("/v1/org/settings", { alertSlaHours: { ...ALERT_SLA_STRICT } });
            setDraft({});
            await settings.refetch();
          }, "Alert SLA back to the strict default")}>Restore strict</Button>
        </div>
        {!valid ? <p className={v.errLine} role="alert">Each SLA is a whole number of hours from 1 to {ALERT_SLA_MAX}.</p> : null}
        <div className={v.row}>
          <strong>Alert tickets</strong>
          {ticketRelaxed ? <Badge tone="warn">relaxed</Badge> : <Badge tone="ok">strict default</Badge>}
        </div>
        <p className={v.faint}>Strict default: {TICKET_COPY.strict} {ticketRelaxed ? TICKET_COPY.relaxed : null}</p>
        {stopped ? (
          <p className={v.errLine} role="alert">
            Automatic tickets have stopped: the PM connection named for them no longer exists. regulAIt does not switch to another
            connection; name one below or set filing back to manual.
          </p>
        ) : null}
        <div className={v.row}>
          <Field label="PM connection for automatic tickets">
            <Select value={connection} onChange={(event) => {
              const id = event.target.value || null;
              setPickedConnection(id ?? "");
              if (current.alertTicketMode === "auto_high" && id) {
                void action.run(async () => {
                  await api.put("/v1/org/settings", { alertTicketConnectionId: id });
                  setPickedConnection(null);
                  await settings.refetch();
                }, "Automatic tickets now go to the chosen connection (audited)");
              }
            }}>
              <option value="">None named</option>
              {(connections.data?.connections ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>)}
            </Select>
          </Field>
          <Field label="Filing">
            <Select value={current.alertTicketMode} onChange={(event) => {
              const mode = event.target.value as "manual" | "auto_high";
              if (mode === "auto_high" && !connection) {
                action.setError("Choose the PM connection automatic tickets go to first; regulAIt never picks one for you.");
                return;
              }
              void action.run(async () => {
                await api.put("/v1/org/settings", mode === "auto_high" ? { alertTicketMode: mode, alertTicketConnectionId: connection } : { alertTicketMode: mode });
                setPickedConnection(null);
                await settings.refetch();
              }, mode === "manual" ? "Alert tickets: manual (strict default)" : "Alert tickets: automatic for high alerts (relaxed, audited)");
            }}>
              <option value="manual">Manual — a person files each one (strict default)</option>
              <option value="auto_high">Automatic for every new high alert (relaxed)</option>
            </Select>
          </Field>
        </div>
        <p className={v.faint}>Every change is recorded in the audit log with its previous value.</p>
        {action.error ? <p className={v.errLine} role="alert">{action.error}</p> : null}
      </div>
    </Card>
  );
}

function RemediationPanel({ alertId }: { alertId: string }) {
  const { auth } = useSession();
  const users = useUsers();
  const action = useAction();
  const [approverByCandidate, setApproverByCandidate] = useState<Record<string, string>>({});
  const remediation = useQuery({
    queryKey: ["governance", "alerts", alertId, "remediation"],
    queryFn: () => api.get<RemediationResponse>(`/v1/governance/alerts/${alertId}/remediation`),
  });
  const approvers = (users.data?.users ?? []).filter((user) => user.id !== auth?.userId);

  return (
    <div className={v.stack}>
      <div className={v.sectionTitle} style={{ marginTop: 0 }}>Remediation</div>
      <QueryGate loading={remediation.isLoading} error={remediation.error} onRetry={() => void remediation.refetch()}>
        {remediation.data ? (
          <div className={v.stack}>
            <p className={v.faint}>{remediation.data.note}</p>
            {remediation.data.candidates.length === 0 ? (
              <p className={v.dim}>No current remediation candidates are available for this condition.</p>
            ) : remediation.data.candidates.map((candidate, index) => {
              const candidateKey = `${candidate.kind}:${index}`;
              const approver = approverByCandidate[candidateKey] ?? "";
              return (
                <div className={s.remediationCandidate} key={candidateKey}>
                  <div className={v.row}>
                    <strong>{candidate.title}</strong>
                    <span className={v.faint}>{candidate.executable ? "approval-gated action" : "operator guidance"}</span>
                  </div>
                  <p className={v.dim}>{candidate.rationale}</p>
                  {candidate.executable ? (
                    <div className={v.row}>
                      <Field label="Independent approver">
                        <Select value={approver} onChange={(event) => setApproverByCandidate((current) => ({ ...current, [candidateKey]: event.target.value }))}>
                          <option value="">Choose an approver</option>
                          {approvers.map((user) => <option key={user.id} value={user.id}>{user.displayName || user.email}</option>)}
                        </Select>
                      </Field>
                      <Button
                        size="sm"
                        disabled={action.busy || !approver}
                        onClick={() => void action.run(async () => {
                          await api.post(`/v1/governance/alerts/${alertId}/remediation`, {
                            kind: candidate.kind,
                            params: candidate.params,
                            approverUserId: approver,
                          });
                          await remediation.refetch();
                        }, "Remediation proposed for independent approval")}
                      >
                        {candidate.kind === "halt_agent" ? "Propose halt" : "Propose…"}
                      </Button>
                      {approvers.length === 0 ? <span className={v.hint}>Another user is required; proposers cannot approve their own remediation.</span> : null}
                    </div>
                  ) : (
                    <>
                      <ol className={s.remediationSteps}>{candidate.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                      {candidate.href && candidate.href.startsWith("/") ? (
                        <div><Link to={candidate.href}>{candidate.kind === "register_use_case" ? "Register as use case" : candidate.kind === "review_credential" ? "Manage credential" : "Open"}</Link></div>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
            {remediation.data.proposals.length ? (
            <div>
              <strong>Proposals</strong>
                <div className={v.stackTight}>
                  {remediation.data.proposals.map((proposal) => (
                    <div className={s.proposalRow} key={proposal.id}>
                      <span>{proposal.title}</span>
                      <Badge tone={proposalTone(proposal.status)}>{proposal.status.replaceAll("_", " ")}</Badge>
                      <Link to={`/admin/approvals?objectType=remediation`}>Open approval</Link>
                    </div>
                  ))}
                </div>
            </div>
            ) : null}
            {action.error ? <p className={v.errLine} role="alert">{action.error}</p> : null}
          </div>
        ) : null}
      </QueryGate>
    </div>
  );
}

function proposalTone(status: RemediationProposal["status"]): "ok" | "warn" | "danger" | "info" {
  if (status === "applied") return "ok";
  if (status === "pending_approval") return "info";
  if (status === "denied" || status === "failed") return "danger";
  return "warn";
}

/** a plain figure; colour only when there is something open to act on */
function AlertStat({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return <div className={v.stat}><span className={v.statValue} style={alarm && value > 0 ? { color: "var(--danger)" } : undefined}>{value}</span><span className={v.statLabel}>{label}</span></div>;
}

function SubjectLinks({ alert }: { alert: GovernanceAlert }) {
  const subject = alert.subject;
  const path = subject.type === "use_case" && subject.id
    ? `/admin/governance/use-cases/${subject.id}`
    : subject.type === "agent" && subject.context && subject.id
      ? `/admin/governance/use-cases/${subject.context.id}?tab=stack#agent-${subject.id}`
      : subject.type === "agent" && subject.id ? `/admin/agents#agent-${subject.id}`
      : subject.type === "agent" ? "/admin/agents"
      : subject.type === "vendor" ? `/admin/vendors${subject.id ? `?vendorId=${subject.id}` : ""}`
        : subject.type === "risk" ? `/admin/risks?riskId=${subject.id ?? ""}`
          // ADR-0175 A9 subjects
          : subject.type === "project" && subject.id ? `/projects/${subject.id}`
            : subject.type === "virtual_key" ? "/admin/virtual-keys"
              : subject.type === "caller" ? "/admin/users"
                // ADR-0175 A7 — a flagged credential opens the inventory
                : subject.type === "credential" ? "/admin/credentials"
                  : null;
  return (
    <div className={v.row}>
      {path ? <Link to={path}>Open {subject.type === "caller" ? "users" : subject.type.replace("_", " ")}</Link> : <span>{subject.label}</span>}
      {subject.context ? <Link to={`/admin/governance/use-cases/${subject.context.id}`}>Context: {subject.context.label}</Link> : null}
    </div>
  );
}

export function GovernanceAlertsSnapshot() {
  const alerts = useQuery({
    queryKey: ["governance", "alerts", "active"],
    queryFn: () => api.get<AlertsResponse>("/v1/governance/alerts?status=active"),
  });
  const active = (alerts.data?.counts.open ?? 0) + (alerts.data?.counts.acknowledged ?? 0);
  const open = alerts.data?.counts.open ?? 0;
  return (
    <Card title="Governance monitor" actions={<Link to="/admin/governance/alerts">Open alerts</Link>}>
      {alerts.isLoading ? <p className={v.faint}>Loading active governance conditions…</p> : alerts.isError ? <p className={v.errLine}>Alerts could not be loaded.</p> : !alerts.data?.lastEvaluatedAt ? (
        // a monitor that has never run has not found "0 open" — it has found nothing yet
        <div className={v.row}>
          <span className={v.dim}>Governance monitor not evaluated</span>
          <span className={v.faint}>· run Evaluate now on the alerts page before reading this as an all-clear</span>
        </div>
      ) : (
        <div className={v.row}>
          <span className={v.statValue}>{active}</span>
          <span className={v.dim}>active alert{active === 1 ? "" : "s"}</span>
          {open > 0 ? <Badge tone="danger">{open} open</Badge> : <span className={v.dim}>· 0 open</span>}
          <span className={v.dim}>· {alerts.data.counts.acknowledged} acknowledged</span>
        </div>
      )}
    </Card>
  );
}

/** ADR-0186 M: actual saved thresholds; missing settings stay unreported. */
function DetectionMonitorSettings() {
  const action=useAction();
  type Values={monitorMcpBaselineDays?:number;monitorJailbreakThreshold?:number;monitorJailbreakWindowHours?:number};
  const query=useQuery({queryKey:["org","settings"],retry:false,queryFn:()=>api.get<{settings:Values}>("/v1/org/settings")});
  const [draft,setDraft]=useState<Partial<Record<keyof Values,string>>>({});
  const [validation,setValidation]=useState<string|null>(null);
  const fields=[
    {key:"monitorMcpBaselineDays" as const,label:"MCP baseline days",min:1,max:90},
    {key:"monitorJailbreakThreshold" as const,label:"Jailbreak finding threshold",min:1,max:100},
    {key:"monitorJailbreakWindowHours" as const,label:"Jailbreak observation hours",min:1,max:168},
  ];
  const current=query.data?.settings;
  const reported=fields.every(field=>typeof current?.[field.key]==="number"&&Number.isInteger(current[field.key])&&current[field.key]!>=field.min&&current[field.key]!<=field.max);
  return <Card title="Detection monitor rules and thresholds">
    <p>These rules observe retained governance records; they do not block calls or prove a jailbreak succeeded.</p>
    <ul>
      <li>New MCP servers: compare attributed calls in the last 24 hours with the separate baseline window immediately before those hours.</li>
      <li>Sharing widened: observe wider scopes or additional selected recipients in the last 24 hours. An edit with no earlier recipient snapshot remains unmeasured.</li>
      <li>Instructions changed after approval: compare the current active prompt version with activation history at the latest approving decision. Missing or ambiguous history holds an existing alert.</li>
      <li>Jailbreak correlation: findings must reach the threshold before an allowed tool call by the same person within the observation window. Correlation does not establish cause or successful execution.</li>
    </ul>
    <QueryGate loading={query.isLoading} error={query.error} onRetry={()=>void query.refetch()}>
      {!reported?<p>Detection monitor thresholds are not reported by this gateway.</p>:<div className={v.stack}>
        {fields.map(field=><Field key={field.key} label={field.label} help={`Whole number from ${field.min} to ${field.max}. Saved value: ${current![field.key]}. ${BATCH4_SETTING_COPY[field.key].strict} ${BATCH4_SETTING_COPY[field.key].relaxed}`}>
          <Input type="number" min={field.min} max={field.max} step={1} disabled={action.busy} value={draft[field.key]??String(current![field.key])} onChange={event=>{setDraft(old=>({...old,[field.key]:event.target.value}));setValidation(null);}} />
        </Field>)}
        {fields.map(field=><p key={field.key}>{field.label}: <Badge tone={batch4SettingRelaxed(field.key,current![field.key]!)?"warn":"ok"}>{batch4SettingRelaxed(field.key,current![field.key]!)?"Relaxed":"Strict"}</Badge> <Button disabled={action.busy} onClick={()=>setDraft(old=>({...old,[field.key]:String(BATCH4_STRICT_DEFAULTS[field.key])}))}>Restore strict {field.label.toLowerCase()}</Button></p>)}
        <p>Relaxing these thresholds is audited and requires step-up authentication when the deployment enforces it.</p>
        {validation&&<p role="alert">{validation}</p>}
        <Button disabled={action.busy||!Object.keys(draft).length} onClick={()=>{
          const changes:Partial<Values>={};
          for(const field of fields){if(draft[field.key]===undefined)continue;const raw=draft[field.key]!.trim();const value=Number(raw);
            if(!raw||!Number.isInteger(value)||value<field.min||value>field.max){setValidation(`${field.label} must be a whole number from ${field.min} to ${field.max}.`);return;}changes[field.key]=value;}
          void action.run(async()=>{await api.put("/v1/org/settings",changes);setDraft({});await query.refetch();},"Detection monitor thresholds saved");
        }}>Save detection thresholds</Button>
      </div>}
    </QueryGate>
  </Card>;
}
