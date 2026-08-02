/**
 * Cost forecasting & spend-anomaly detection (ADR-0049).
 *
 * A surface whose whole job is to keep three uncomfortable facts VISIBLE
 * rather than merely true in the backend:
 *
 *  - **A forecast is not a commitment.** The projection is never rendered
 *    alone: the method, the 95% interval and the stated limits sit beside it.
 *    When history is too thin the page shows the INSUFFICIENT-DATA sentence
 *    the API returned — never a zero, never a dash that could be read as one.
 *  - **An anomaly is a signal, not a finding.** Every flag renders the method,
 *    the baseline, the threshold and the score it was derived from, so a
 *    reviewer can re-check the arithmetic rather than trust a badge.
 *  - **Nothing is scheduled.** There is no in-process scheduler. The page says
 *    so at the top of the policies card and shows `lastEvaluatedAt`, so a
 *    policy that has never been evaluated is visibly idle rather than assumed
 *    to be working.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, optionEls, projectOpts, useAction, useProjects } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface PolicyRow {
  id: string;
  projectId: string | null;
  enabled: boolean;
  sensitivity: "low" | "medium" | "high";
  baselineDays: number;
  action: "alert" | "require_approval";
  lastEvaluatedAt: string | null;
}
interface AnomalyRow {
  id: string;
  projectId: string;
  signal: string;
  method: string;
  observed: number;
  baselineMedian: number | null;
  baselineMad: number | null;
  baselineSamples: number;
  score: number | null;
  threshold: number | null;
  explanation: string;
  action: string;
  approvalId: string | null;
  status: "open" | "acknowledged" | "dismissed";
  detectedAt: string;
}
interface ScheduledChangeRow {
  id: string;
  projectId: string;
  deltaUsd: number;
  effectiveAt: string;
  reason: string;
}
interface Overview {
  policies: PolicyRow[];
  openAnomalies: number;
  recentAnomalies: AnomalyRow[];
  scheduledChanges: ScheduledChangeRow[];
  schedulerPresent: boolean;
  minBaselineSamples: number;
  note: string;
}
interface ForecastBody {
  runId: string;
  forecast: {
    method: string;
    sufficient: boolean;
    insufficientReason: string | null;
    spendToDateUsd: number;
    observedDays: number;
    activeDays: number;
    meanDailyUsd: number;
    projectedSpendUsd: number | null;
    lowUsd: number | null;
    highUsd: number | null;
    relativeBandWidth: number | null;
    scheduledDeltaUsd: number;
    budgetUsd: number | null;
    projectedPctOfBudget: number | null;
    budgetBreachDay: number | null;
    assumptions: string[];
    limits: string[];
    disclaimer: string;
    period: { label: string };
  };
  scope: { effectiveProjectIds: string[] | null; reason: string };
}

export default function SpendMonitorPage() {
  const act = useAction();
  const projects = useProjects();
  const overview = useQuery({
    queryKey: ["admin", "spend-monitor-overview"],
    queryFn: () => api.get<Overview>("/v1/spend/monitor-overview"),
  });

  const [fcProject, setFcProject] = useState("");
  const [fcMethod, setFcMethod] = useState("run_rate");
  const [fcPeriod, setFcPeriod] = useState("current_month");
  const [forecast, setForecast] = useState<ForecastBody | null>(null);

  const [polProject, setPolProject] = useState("");
  const [polEnabled, setPolEnabled] = useState("true");
  const [polSensitivity, setPolSensitivity] = useState("medium");
  const [polAction, setPolAction] = useState("alert");
  const [polBaselineDays, setPolBaselineDays] = useState("30");

  const [scProject, setScProject] = useState("");
  const [scDelta, setScDelta] = useState("");
  const [scAt, setScAt] = useState("");
  const [scReason, setScReason] = useState("");

  const projectName = (id: string | null) =>
    id ? (projects.data?.projects.find((p) => p.id === id)?.name ?? id.slice(0, 8) + "…") : "org-wide default";

  const f = forecast?.forecast;

  return (
    <>
      <PageHeader
        title="Spend forecast & anomalies"
        sub="Budget-vs-FORECAST and statistical spend-anomaly detection over the measured usage ledger. The projector is a run-rate (or EWMA) extrapolation you can re-derive with a calculator, reported with a real confidence interval; the detector is a modified z-score against each project's own rolling baseline. A forecast is not a commitment and an anomaly is not proof — both say so on their face, and enforcement rides the existing Approvals Queue rather than a second inbox."
      />
      <div className={v.stack}>
        {/* ---------------- forecast ---------------- */}
        <Card title="Forecast">
          <div className={v.stack}>
            <div className={a.formRow}>
              <Field label="Scope">
                <Select value={fcProject} onChange={(e) => setFcProject(e.target.value)}>
                  {optionEls(projectOpts(projects.data?.projects), "whole organization")}
                </Select>
              </Field>
              <Field label="Method">
                <Select value={fcMethod} onChange={(e) => setFcMethod(e.target.value)}>
                  <option value="run_rate">run_rate (flat mean daily rate)</option>
                  <option value="ewma">ewma (recency-weighted)</option>
                </Select>
              </Field>
              <Field label="Period">
                <Select value={fcPeriod} onChange={(e) => setFcPeriod(e.target.value)}>
                  <option value="current_month">current_month</option>
                  <option value="current_quarter">current_quarter</option>
                  <option value="last_30_days">last_30_days</option>
                </Select>
              </Field>
              <Field label="&nbsp;">
                <Button
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(async () => {
                      const q = new URLSearchParams({ method: fcMethod, period: fcPeriod });
                      if (fcProject) q.set("projectId", fcProject);
                      setForecast(await api.get<ForecastBody>(`/v1/spend/forecast?${q.toString()}`));
                    }, "Forecast computed")
                  }
                >
                  Compute forecast
                </Button>
              </Field>
            </div>

            {!f ? (
              <EmptyState
                title="No forecast computed yet"
                body="A forecast is a read-only projection over usage_events. Nothing is stored until you ask for one, and asking again recomputes from the ledger."
              />
            ) : !f.sufficient ? (
              /* THE HONEST EMPTY ANSWER. Deliberately NOT a zero or a dash. */
              <div className={a.effectBanner}>
                <strong>Insufficient data — no projection is offered.</strong>
                <div>{f.insufficientReason}</div>
                <div className={v.faint}>
                  Measured spend to date is still shown because it is observed, not projected:{" "}
                  <strong>{fmtUsd(f.spendToDateUsd)}</strong> over {f.activeDays} active day(s) of{" "}
                  {f.observedDays} elapsed.
                </div>
              </div>
            ) : (
              <div className={v.stack}>
                <div className={a.formRow}>
                  <Field label={`Projected (${f.method}, ${f.period.label})`}>
                    <Input readOnly value={fmtUsd(f.projectedSpendUsd)} />
                  </Field>
                  <Field label="95% interval">
                    <Input readOnly value={`${fmtUsd(f.lowUsd)} – ${fmtUsd(f.highUsd)}`} />
                  </Field>
                  <Field label="Spend to date">
                    <Input readOnly value={fmtUsd(f.spendToDateUsd)} />
                  </Field>
                  <Field label="Mean daily">
                    <Input readOnly value={fmtUsd(f.meanDailyUsd)} />
                  </Field>
                  <Field label="Budget">
                    <Input readOnly value={f.budgetUsd == null ? "none set" : fmtUsd(f.budgetUsd)} />
                  </Field>
                  <Field label="% of budget">
                    <Input readOnly value={f.projectedPctOfBudget == null ? "—" : `${f.projectedPctOfBudget}%`} />
                  </Field>
                </div>
                {f.budgetBreachDay != null && (
                  <div className={a.effectBanner}>
                    <strong>Early warning:</strong> at the current rate this scope reaches its budget on day{" "}
                    {f.budgetBreachDay} of the period.
                  </div>
                )}
                {f.scheduledDeltaUsd !== 0 && (
                  <div className={v.faint}>
                    Includes {fmtUsd(f.scheduledDeltaUsd)} of DECIDED scheduled change still ahead in the period.
                  </div>
                )}
                <div className={v.faint}>
                  <strong>Assumptions:</strong> {f.assumptions.join("; ")}.
                </div>
                <div className={v.faint}>
                  <strong>Where this breaks:</strong> {f.limits.join("; ")}.
                </div>
                <div className={v.faint}>{f.disclaimer}</div>
              </div>
            )}
            {forecast && (
              <div className={v.faint}>
                Entitlement scope:{" "}
                {forecast.scope.effectiveProjectIds === null
                  ? "org-wide (admin, org-scoped request)"
                  : `${forecast.scope.effectiveProjectIds.length} entitled project(s)`}{" "}
                — {forecast.scope.reason}
              </div>
            )}
          </div>
        </Card>

        <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
          {/* ---------------- policies ---------------- */}
          <Card title="Anomaly policies">
            <div className={v.stack}>
              <div className={a.effectBanner}>
                <strong>Nothing drives these.</strong> {overview.data?.note}
              </div>
              <div className={a.formRow}>
                <Field label="Scope">
                  <Select value={polProject} onChange={(e) => setPolProject(e.target.value)}>
                    {optionEls(projectOpts(projects.data?.projects), "org-wide default")}
                  </Select>
                </Field>
                <Field label="Enabled">
                  <Select value={polEnabled} onChange={(e) => setPolEnabled(e.target.value)}>
                    <option value="true">enabled</option>
                    <option value="false">disabled (default)</option>
                  </Select>
                </Field>
                <Field label="Sensitivity">
                  <Select value={polSensitivity} onChange={(e) => setPolSensitivity(e.target.value)}>
                    <option value="low">low (z &gt; 5.0)</option>
                    <option value="medium">medium (z &gt; 3.5)</option>
                    <option value="high">high (z &gt; 2.5)</option>
                  </Select>
                </Field>
                <Field label="Baseline days">
                  <Input value={polBaselineDays} onChange={(e) => setPolBaselineDays(e.target.value)} />
                </Field>
                <Field label="Action">
                  <Select value={polAction} onChange={(e) => setPolAction(e.target.value)}>
                    <option value="alert">alert only (default)</option>
                    <option value="require_approval">require approval for further spend</option>
                  </Select>
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        await api.put("/v1/spend/monitor-policies", {
                          ...(polProject ? { projectId: polProject } : {}),
                          enabled: polEnabled === "true",
                          sensitivity: polSensitivity,
                          baselineDays: Number(polBaselineDays),
                          action: polAction,
                        });
                        await overview.refetch();
                      }, "Policy saved")
                    }
                  >
                    Save policy
                  </Button>
                </Field>
                <Field label="&nbsp;">
                  <Button
                    variant="ghost"
                    disabled={act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post("/v1/spend/anomalies/evaluate", {});
                        await overview.refetch();
                      }, "Evaluator driven once")
                    }
                  >
                    Run evaluator now
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>
                A project with fewer than {overview.data?.minBaselineSamples ?? 7} days of measured spend in its
                baseline window gets <strong>no anomaly claims at all</strong> — the page reports &ldquo;baseline
                building&rdquo; rather than a spurious flag. That cold-start window is a disclosed blind spot: only
                the static budget and compliance caps protect a brand-new project.
              </div>
              {(overview.data?.policies ?? []).length === 0 ? (
                <EmptyState title="No policies" body="Spend monitoring is OFF by default. Nothing is evaluated until a policy enables it." />
              ) : (
                <Table
                  rows={overview.data!.policies}
                  rowKey={(p) => p.id}
                  columns={[
                    { key: "k23105", header: "Scope", render: (p) => projectName(p.projectId) },
                    { key: "k21584", header: "Enabled", render: (p) => <Badge tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? "on" : "off"}</Badge> },
                    { key: "k840", header: "Sensitivity", render: (p) => p.sensitivity },
                    { key: "k7008", header: "Baseline", render: (p) => `${p.baselineDays}d` },
                    { key: "k28434", header: "Action", render: (p) => p.action },
                    {
                      key: "last",
                      header: "Last evaluated",
                      render: (p) =>
                        p.lastEvaluatedAt ? ago(p.lastEvaluatedAt) : <Badge tone="warn">never — nothing has driven it</Badge>,
                    },
                  ]}
                />
              )}
            </div>
          </Card>

          {/* ---------------- anomalies ---------------- */}
          <Card title={`Anomaly signals (${overview.data?.openAnomalies ?? 0} open)`}>
            <div className={v.stack}>
              <div className={v.faint}>
                An anomaly is a <strong>signal for human review, never proof of wrongdoing</strong>. Every row below
                carries the method, the baseline and the threshold it was derived from so the arithmetic can be
                re-checked. Where a policy escalates, the review item lands on the existing Approvals Queue.
              </div>
              {(overview.data?.recentAnomalies ?? []).length === 0 ? (
                <EmptyState title="No anomalies recorded" body="Either nothing has been flagged, or no operator has driven the evaluator yet." />
              ) : (
                <Table
                  rows={overview.data!.recentAnomalies}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: "k43750", header: "Project", render: (r) => projectName(r.projectId) },
                    { key: "k27824", header: "Signal", render: (r) => r.signal },
                    { key: "k64489", header: "Method", render: (r) => r.method },
                    { key: "k78980", header: "Observed", render: (r) => r.observed },
                    { key: "k7008", header: "Baseline", render: (r) => (r.baselineMedian == null ? "—" : `median ${r.baselineMedian} / MAD ${r.baselineMad} / n=${r.baselineSamples}`) },
                    { key: "k96109", header: "Score vs threshold", render: (r) => (r.score == null ? "—" : `${r.score} vs ${r.threshold}`) },
                    { key: "k28434", header: "Action", render: (r) => (r.approvalId ? <Badge tone="warn">approval raised</Badge> : <Badge tone="info">alert only</Badge>) },
                    { key: "k6039", header: "Status", render: (r) => r.status },
                    { key: "k88636", header: "Detected", render: (r) => ago(r.detectedAt) },
                    {
                      key: "act",
                      header: "",
                      render: (r) =>
                        r.status !== "open" ? null : (
                          <Button
                            variant="ghost"
                            disabled={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await api.patch(`/v1/spend/anomalies/${r.id}`, {
                                  status: "acknowledged",
                                  reason: "reviewed from the spend monitor page",
                                });
                                await overview.refetch();
                              }, "Acknowledged")
                            }
                          >
                            Acknowledge
                          </Button>
                        ),
                    },
                  ]}
                />
              )}
            </div>
          </Card>

          {/* ---------------- scheduled changes ---------------- */}
          <Card title="Decided future changes">
            <div className={v.stack}>
              <div className={v.faint}>
                The forecast extrapolates the past. A change that has been <strong>decided</strong> but not yet
                happened is invisible to any extrapolation, so it is recorded here and added on top. Nothing else is
                anticipated — an undeclared change simply makes the projection wrong, which is why the limits are
                printed beside every number.
              </div>
              <div className={a.formRow}>
                <Field label="Project">
                  <Select value={scProject} onChange={(e) => setScProject(e.target.value)}>
                    {optionEls(projectOpts(projects.data?.projects), "select…")}
                  </Select>
                </Field>
                <Field label="Delta (USD, signed)">
                  <Input value={scDelta} onChange={(e) => setScDelta(e.target.value)} placeholder="250 or -80" />
                </Field>
                <Field label="Effective at (ISO)">
                  <Input value={scAt} onChange={(e) => setScAt(e.target.value)} placeholder="2026-09-01T00:00:00.000Z" />
                </Field>
                <Field label="Reason">
                  <Input value={scReason} onChange={(e) => setScReason(e.target.value)} placeholder="new team onboards onto the frontier agent" />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy || !scProject || !scDelta || !scAt || !scReason}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post("/v1/spend/scheduled-changes", {
                          projectId: scProject,
                          deltaUsd: Number(scDelta),
                          effectiveAt: scAt,
                          reason: scReason,
                        });
                        setScDelta("");
                        setScReason("");
                        await overview.refetch();
                      }, "Scheduled change recorded")
                    }
                  >
                    Record change
                  </Button>
                </Field>
              </div>
              {(overview.data?.scheduledChanges ?? []).length === 0 ? (
                <EmptyState title="No decided changes recorded" body="Forecasts therefore reflect the observed trend only." />
              ) : (
                <Table
                  rows={overview.data!.scheduledChanges}
                  rowKey={(c) => c.id}
                  columns={[
                    { key: "k43750", header: "Project", render: (c) => projectName(c.projectId) },
                    { key: "k19608", header: "Delta", render: (c) => fmtUsd(c.deltaUsd) },
                    { key: "k86937", header: "Effective", render: (c) => new Date(c.effectiveAt).toISOString() },
                    { key: "k12014", header: "Reason", render: (c) => c.reason },
                    {
                      key: "act",
                      header: "",
                      render: (c) => (
                        <Button
                          variant="ghost"
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(async () => {
                              await api.del(`/v1/spend/scheduled-changes/${c.id}`);
                              await overview.refetch();
                            }, "Change withdrawn")
                          }
                        >
                          Withdraw
                        </Button>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
