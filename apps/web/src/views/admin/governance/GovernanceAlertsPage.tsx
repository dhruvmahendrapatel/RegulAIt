import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select, SeverityBadge, Tabs, Textarea } from "../../../ui/kit";
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
  detail: { sourceNodeKey?: string; sourceRiskId?: string; path?: string[]; pathLabels?: string[] };
  firstDetectedAt: string;
  lastDetectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
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
            <div className={v.grid3} style={{ flex: 1 }}>
              <AlertStat label="Open" value={alerts.data?.counts.open ?? 0} tone="danger" />
              <AlertStat label="Acknowledged" value={alerts.data?.counts.acknowledged ?? 0} tone="warn" />
              <AlertStat label="Resolved" value={alerts.data?.counts.resolved ?? 0} tone="ok" />
            </div>
            <Button
              variant="primary"
              disabled={action.busy}
              onClick={() => void action.run(async () => {
                const result = await api.post<EvaluationResult>("/v1/governance/monitor/evaluate");
                setEvaluation(result);
                await refresh();
              }, "Governance monitor evaluation completed")}
            >
              Evaluate now
            </Button>
          </div>
          <p className={v.faint}>Last evaluated: {alerts.data?.lastEvaluatedAt ? ago(alerts.data.lastEvaluatedAt) : "not evaluated yet"}</p>
          {evaluation ? <p className={s.callout} role="status">Evaluation raised {evaluation.raised}, refreshed {evaluation.refreshed}, resolved {evaluation.resolved}; {evaluation.active} remain active.</p> : null}
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
                    <span className={s.alertRowHead}><SeverityBadge severity={alert.severity} /><Badge tone={alert.status === "resolved" ? "ok" : alert.status === "acknowledged" ? "warn" : "danger"}>{alert.status}</Badge></span>
                    <strong>{alert.title}</strong>
                    <span className={v.faint}>{alert.ruleLabel} · seen {ago(alert.lastDetectedAt)}</span>
                  </button>
                ))}
              </div>
              {selected ? (
                <Card title={selected.subject.label}>
                  <div className={v.stack}>
                    <div className={v.row}><SeverityBadge severity={selected.severity} /><Badge tone="neutral">{selected.ruleId}</Badge></div>
                    <p>{selected.title}</p>
                    <SubjectLinks alert={selected} />
                    <div className={v.row}>
                      <Button size="sm" disabled={action.busy} onClick={() => void action.run(async () => {
                        const posted = await api.post<{ posted: true; connection: string; channel: string }>(`/v1/governance/alerts/${selected.id}/post`);
                        setPostResult(`Posted to ${posted.connection} · ${posted.channel}`);
                      }, "Governance alert posted to chat")}>Post to chat</Button>
                      <span className={v.faint}>Uses the first enabled workspace unless the API is given an explicit connection.</span>
                    </div>
                    {postResult ? <p className={s.callout} role="status">{postResult}</p> : null}
                    {action.error ? <p className={v.errLine} role="alert">{action.error}</p> : null}
                    {(selected.detail.pathLabels ?? selected.detail.path)?.length ? (
                      <div><strong>Inherited-risk path</strong><ol className={s.pathList}>{(selected.detail.pathLabels ?? selected.detail.path ?? []).map((part) => <li key={part}>{part}</li>)}</ol></div>
                    ) : null}
                    {selected.detail.sourceRiskId ? <Link to={`/admin/risks?riskId=${selected.detail.sourceRiskId}`}>Open source risk</Link> : null}
                    {selected.ackNote ? <p className={s.callout}>Acknowledgement note: {selected.ackNote}</p> : null}
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
                    <RemediationPanel alertId={selected.id} />
                  </div>
                </Card>
              ) : <Card><p className={v.dim}>Select an alert to inspect its condition, subject, and response history.</p></Card>}
            </div>
          )}
        </QueryGate>
      </div>
    </>
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
      <div className={v.sectionTitle}>Remediation</div>
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
                    <Badge tone={candidate.executable ? "info" : "neutral"}>{candidate.executable ? "approval-gated action" : "operator guidance"}</Badge>
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
                        variant="primary"
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
                        Propose…
                      </Button>
                      {approvers.length === 0 ? <span className={v.hint}>Another user is required; proposers cannot approve their own remediation.</span> : null}
                    </div>
                  ) : (
                    <ol className={s.remediationSteps}>{candidate.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  )}
                </div>
              );
            })}
            <div>
              <strong>Proposals</strong>
              {remediation.data.proposals.length ? (
                <div className={v.stackTight}>
                  {remediation.data.proposals.map((proposal) => (
                    <div className={s.proposalRow} key={proposal.id}>
                      <span>{proposal.title}</span>
                      <Badge tone={proposalTone(proposal.status)}>{proposal.status.replaceAll("_", " ")}</Badge>
                      <Link to={`/admin/approvals?objectType=remediation`}>Open approval</Link>
                    </div>
                  ))}
                </div>
              ) : <p className={v.faint}>No remediation has been proposed for this alert.</p>}
            </div>
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

function AlertStat({ label, value, tone }: { label: string; value: number; tone: "danger" | "warn" | "ok" }) {
  return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}><Badge tone={tone}>{label}</Badge></span></div>;
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
          : null;
  return (
    <div className={v.row}>
      {path ? <Link to={path}>Open {subject.type.replace("_", " ")}</Link> : <span>{subject.label}</span>}
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
  return (
    <Card title="Governance monitor" actions={<Link to="/admin/governance/alerts">Open alerts</Link>}>
      {alerts.isLoading ? <p className={v.faint}>Loading active governance conditions…</p> : alerts.isError ? <p className={v.errLine}>Alerts could not be loaded.</p> : (
        <div className={v.row}>
          <span className={v.statValue}>{active}</span>
          <span className={v.dim}>active alert{active === 1 ? "" : "s"}</span>
          <Badge tone={(alerts.data?.counts.open ?? 0) > 0 ? "danger" : "ok"}>{alerts.data?.counts.open ?? 0} open</Badge>
          <Badge tone={(alerts.data?.counts.acknowledged ?? 0) > 0 ? "warn" : "neutral"}>{alerts.data?.counts.acknowledged ?? 0} acknowledged</Badge>
        </div>
      )}
    </Card>
  );
}
