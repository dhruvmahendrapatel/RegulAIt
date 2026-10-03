/**
 * Executive & compliance reporting (ADR-0047).
 *
 * A READ-ONLY surface. Three things it exists to keep honest, rendered rather
 * than merely documented:
 *
 *  - **Nothing is scheduled.** There is no in-process scheduler in this
 *    deployment. The page says so at the top of the schedules card, in those
 *    words, and shows `lastGeneratedAt` so a schedule that has never produced
 *    anything is visibly idle rather than assumed to be working.
 *  - **Spend is an ESTIMATE.** Every generated report carries the list-price
 *    disclaimer, and the page renders it beside the number instead of below the
 *    fold.
 *  - **A report never widens what you can see.** Generating returns the exact
 *    project ids the caller was entitled to, and the page shows them. An admin
 *    org report shows "org-wide"; anyone else sees the narrowed list, so the
 *    scoping is legible rather than implicit.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, optionEls, projectOpts, teamOpts, useAction, useProjects, useTeams } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface ScheduleRow {
  id: string;
  definitionId: string;
  cadence: string;
  enabled: boolean;
  recipientUserIds: string[] | null;
  lastGeneratedAt: string | null;
  lastRunId: string | null;
}
interface DefinitionRow {
  id: string;
  name: string;
  kind: "exec_summary" | "team_scorecard" | "compliance";
  scopeKind: "org" | "initiative" | "team" | "project";
  scopeId: string | null;
  period: string;
  format: string;
  entitlementScope: "org" | "team" | "project";
  description: string | null;
  schedules: ScheduleRow[];
  lastGeneratedAt: string | null;
  runCount: number;
}
interface Overview {
  definitions: DefinitionRow[];
  schedulerPresent: boolean;
  note: string;
}
interface ControlRow {
  id: string;
  title: string;
  status: "met" | "gap";
  evidenceCount: number;
  note: string;
}
interface GeneratedReport {
  run: { id: string };
  report: {
    kind: string;
    definitionName: string;
    period: { label: string; start: string; end: string };
    disclaimer: string;
    spend?: {
      totalCostUsd: number;
      totalEvents: number;
      totalBudgetUsd: number | null;
      budgetVarianceUsd: number | null;
      overBudgetProjects: string[];
      lines: Array<{ projectId: string | null; projectName: string | null; costUsd: number; events: number; budgetUsd: number | null }>;
    };
    governance?: { totalDecisions: number; allow: number; deny: number; requireApproval: number; denyRate: number };
    workflow?: { approvalsRequested: number; approvalsDecided: number; approvalsPending: number; medianDecisionMinutes: number | null };
    controls?: { framework: string; met: number; gaps: number; controls: ControlRow[]; note: string };
  };
  scope: { entitlementScope: string; effectiveProjectIds: string[] | null; reason: string };
}

export default function ReportsPage() {
  const act = useAction();
  const teams = useTeams();
  const projects = useProjects();

  const overview = useQuery({
    queryKey: ["admin", "reports-overview"],
    queryFn: () => api.get<Overview>("/v1/reports/overview"),
  });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<DefinitionRow["kind"]>("exec_summary");
  const [scopeKind, setScopeKind] = useState<DefinitionRow["scopeKind"]>("org");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState("current_month");
  const [entitlementScope, setEntitlementScope] = useState<DefinitionRow["entitlementScope"]>("org");
  const [cadence, setCadence] = useState("monthly");
  const [scheduleFor, setScheduleFor] = useState("");
  const [result, setResult] = useState<GeneratedReport | null>(null);

  const defs = overview.data?.definitions ?? [];

  return (
    <>
      <PageHeader
        title="Executive & compliance reports"
        sub="A read-only projection over the ledgers the platform already holds."
        info={<p>A read-only projection over the ledgers this platform already holds — usage_events (spend), audit_log (governance decisions) and approvals (throughput). No second source of truth, no rollup table that could drift from the cost dashboard. Every generation is scoped to the requesting caller's own entitlement: a report can never show spend or audit data you could not see directly.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
          <Card title="Report definitions">
            <div className={v.stack}>
              <div className={a.formRow}>
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Board — quarterly spend & controls" />
                </Field>
                <Field label="Kind">
                  <Select value={kind} onChange={(e) => setKind(e.target.value as DefinitionRow["kind"])}>
                    <option value="exec_summary">exec_summary</option>
                    <option value="team_scorecard">team_scorecard</option>
                    <option value="compliance">compliance</option>
                  </Select>
                </Field>
                <Field label="Scope">
                  <Select
                    value={scopeKind}
                    onChange={(e) => {
                      const k = e.target.value as DefinitionRow["scopeKind"];
                      setScopeKind(k);
                      setScopeId("");
                      if (k !== "org") setEntitlementScope(k === "team" ? "team" : "project");
                      else setEntitlementScope("org");
                    }}
                  >
                    <option value="org">org</option>
                    <option value="team">team</option>
                    <option value="project">project</option>
                  </Select>
                </Field>
                {scopeKind !== "org" && (
                  <Field label={scopeKind === "team" ? "Team" : "Project"}>
                    <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                      {optionEls(
                        scopeKind === "team" ? teamOpts(teams.data?.teams) : projectOpts(projects.data?.projects),
                        "select…",
                      )}
                    </Select>
                  </Field>
                )}
                <Field label="Period">
                  <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
                    <option value="current_month">current_month</option>
                    <option value="last_month">last_month</option>
                    <option value="current_quarter">current_quarter</option>
                    <option value="last_quarter">last_quarter</option>
                    <option value="last_30_days">last_30_days</option>
                  </Select>
                </Field>
                <Field label="Reporting grant required">
                  <Input readOnly value={entitlementScope} />
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy || !name || (scopeKind !== "org" && !scopeId)}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post("/v1/reports/definitions", {
                          name,
                          kind,
                          scopeKind,
                          ...(scopeKind === "org" ? {} : { scopeId }),
                          period,
                          entitlementScope,
                        });
                        setName("");
                        await overview.refetch();
                      }, "Report definition created")
                    }
                  >
                    Create definition
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>
                An <strong>org</strong> reporting grant is admin-only: an org-wide rollup aggregates across teams,
                which is exactly where a naive report leaks one team's numbers to another. A team or project grant is
                further narrowed at generation time to the projects the caller is actually a member of.
              </div>
              {defs.length === 0 ? (
                <EmptyState title="No report definitions yet" body="A definition describes WHAT to compute and WHO may run it. It computes nothing until it is generated." />
              ) : (
                <Table
                  rows={defs}
                  rowKey={(d) => d.id}
                  columns={[
                    { key: "name", header: "Name", render: (d) => d.name },
                    { key: "kind", header: "Kind", render: (d) => <Badge tone="info">{d.kind}</Badge> },
                    { key: "scope", header: "Scope", render: (d) => d.scopeKind },
                    { key: "grant", header: "Grant", render: (d) => <Badge tone={d.entitlementScope === "org" ? "warn" : "neutral"}>{d.entitlementScope}</Badge> },
                    { key: "period", header: "Period", render: (d) => d.period },
                    { key: "runs", header: "Runs", render: (d) => d.runCount },
                    { key: "last", header: "Last generated", render: (d) => (d.lastGeneratedAt ? ago(d.lastGeneratedAt) : <span className={v.faint}>never</span>) },
                    {
                      key: "act",
                      header: "",
                      render: (d) => (
                        <div className={a.formRow}>
                          <Button
                            size="sm"
                            onClick={() =>
                              void act.run(async () => {
                                const r = await api.post<GeneratedReport>(
                                  `/v1/reports/definitions/${d.id}/generate`,
                                  {},
                                );
                                setResult(r);
                                await overview.refetch();
                                return "Report generated";
                              })
                            }
                          >
                            Generate
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              void act.run(async () => {
                                await api.del(`/v1/reports/definitions/${d.id}`);
                                await overview.refetch();
                              }, "Definition deleted")
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          </Card>

          <Card title="Schedules">
            <div className={v.stack}>
              <div className={v.errLine} role="note">
                Nothing in this deployment fires these. A schedule is a <strong>definition of a cadence</strong>; an
                operator or an external cron must call <code>POST /v1/reports/schedules/run-due</code>, or no
                scheduled report is ever produced. "Last generated: never" below means exactly that.
              </div>
              <div className={a.formRow}>
                <Field label="Definition">
                  <Select value={scheduleFor} onChange={(e) => setScheduleFor(e.target.value)}>
                    {optionEls(defs.map((d) => ({ v: d.id, l: d.name })), "select…")}
                  </Select>
                </Field>
                <Field label="Cadence">
                  <Select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                    <option value="monthly">monthly</option>
                    <option value="quarterly">quarterly</option>
                  </Select>
                </Field>
                <Field label="&nbsp;">
                  <Button
                    disabled={act.busy || !scheduleFor}
                    onClick={() =>
                      void act.run(async () => {
                        await api.post(`/v1/reports/definitions/${scheduleFor}/schedules`, { cadence });
                        await overview.refetch();
                      }, "Schedule recorded — nothing drives it automatically")
                    }
                  >
                    Add schedule
                  </Button>
                </Field>
                <Field label="&nbsp;">
                  <Button
                    onClick={() =>
                      void act.run(async () => {
                        const r = await api.post<{ generated: unknown[]; skipped: unknown[] }>(
                          "/v1/reports/schedules/run-due",
                          {},
                        );
                        await overview.refetch();
                        return `${r.generated.length} generated, ${r.skipped.length} skipped`;
                      })
                    }
                  >
                    Run due now (operator)
                  </Button>
                </Field>
              </div>
              {defs.flatMap((d) => d.schedules).length === 0 ? (
                <EmptyState title="No schedules" />
              ) : (
                <Table
                  rows={defs.flatMap((d) => d.schedules.map((s) => ({ ...s, definition: d.name })))}
                  rowKey={(s) => s.id}
                  columns={[
                    { key: "def", header: "Definition", render: (s) => s.definition },
                    { key: "cadence", header: "Cadence", render: (s) => s.cadence },
                    { key: "enabled", header: "Enabled", render: (s) => <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "yes" : "no"}</Badge> },
                    {
                      key: "last",
                      header: "Last generated",
                      render: (s) =>
                        s.lastGeneratedAt ? ago(s.lastGeneratedAt) : <Badge tone="warn">never — nothing drives this</Badge>,
                    },
                    {
                      key: "act",
                      header: "",
                      render: (s) => (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() =>
                            void act.run(async () => {
                              await api.del(`/v1/reports/schedules/${s.id}`);
                              await overview.refetch();
                            }, "Schedule deleted")
                          }
                        >
                          Delete
                        </Button>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          </Card>

          {result && (
            <Card
              title={`${result.report.definitionName} — ${result.report.period.label}`}
              actions={
                <div className={v.row}>
                  <a href={`/v1/reports/runs/${result.run.id}/export?format=csv`} target="_blank" rel="noreferrer">Export CSV</a>
                  <a href={`/v1/reports/runs/${result.run.id}/export?format=csv&signed=1`} target="_blank" rel="noreferrer">Signed CSV bundle</a>
                  <a href={`/v1/reports/runs/${result.run.id}/export?format=json&signed=1`} target="_blank" rel="noreferrer">Signed JSON bundle</a>
                </div>
              }
            >
              <div className={v.stack}>
                <div className={v.faint}>{result.report.disclaimer}</div>
                <div className={v.faint}>
                  Entitlement: <strong>{result.scope.entitlementScope}</strong> —{" "}
                  {result.scope.effectiveProjectIds === null
                    ? "org-wide (admin, org-scoped definition), including spend attributed to no project"
                    : `${result.scope.effectiveProjectIds.length} project(s)`}
                  . {result.scope.reason}
                </div>
                {result.report.spend && (
                  <div className={a.formRow}>
                    <Field label="Total spend (estimate)">
                      <Input readOnly value={fmtUsd(result.report.spend.totalCostUsd)} />
                    </Field>
                    <Field label="Metered calls">
                      <Input readOnly value={result.report.spend.totalEvents} />
                    </Field>
                    <Field label="Budget">
                      <Input readOnly value={result.report.spend.totalBudgetUsd == null ? "—" : fmtUsd(result.report.spend.totalBudgetUsd)} />
                    </Field>
                    <Field label="Variance">
                      <Input readOnly value={result.report.spend.budgetVarianceUsd == null ? "—" : fmtUsd(result.report.spend.budgetVarianceUsd)} />
                    </Field>
                  </div>
                )}
                {result.report.spend && result.report.spend.lines.length > 0 && (
                  <Table
                    rows={result.report.spend.lines}
                    rowKey={(l) => l.projectId ?? "(unattributed)"}
                    columns={[
                      { key: "p", header: "Project", render: (l) => l.projectName ?? <span className={v.faint}>(unattributed)</span> },
                      { key: "c", header: "Spend", render: (l) => fmtUsd(l.costUsd) },
                      { key: "e", header: "Calls", render: (l) => l.events },
                      { key: "b", header: "Budget", render: (l) => (l.budgetUsd == null ? "—" : fmtUsd(l.budgetUsd)) },
                    ]}
                  />
                )}
                {result.report.governance && (
                  <div className={a.formRow}>
                    <Field label="Governed decisions">
                      <Input readOnly value={result.report.governance.totalDecisions} />
                    </Field>
                    <Field label="Denied">
                      <Input readOnly value={result.report.governance.deny} />
                    </Field>
                    <Field label="Pending approval">
                      <Input readOnly value={result.report.governance.requireApproval} />
                    </Field>
                    <Field label="Deny rate">
                      <Input readOnly value={result.report.governance.denyRate} />
                    </Field>
                  </div>
                )}
                {result.report.controls && (
                  <>
                    <div className={v.faint}>{result.report.controls.note}</div>
                    <Table
                      rows={result.report.controls.controls}
                      rowKey={(c) => c.id}
                      columns={[
                        { key: "t", header: "Control", render: (c) => c.title },
                        { key: "s", header: "Status", render: (c) => <Badge tone={c.status === "met" ? "ok" : "danger"}>{c.status}</Badge> },
                        { key: "e", header: "Evidence", render: (c) => c.evidenceCount },
                        { key: "n", header: "Note", render: (c) => <span className={v.faint}>{c.note}</span> },
                      ]}
                    />
                  </>
                )}
              </div>
            </Card>
          )}
        </QueryGate>
      </div>
    </>
  );
}
