/**
 * Executive & compliance reporting (ADR-0047).
 *
 * A READ-ONLY surface. Three things it exists to keep honest, rendered rather
 * than merely documented:
 *
 *  - **What drives the schedules is said, per deployment.** The overview's
 *    `schedulerPresent` says whether ADR-0064's in-process scheduler is on; the
 *    page says either "the scheduler fires these" or "nothing in this
 *    deployment fires these" (CXR-REV-001), and shows `lastGeneratedAt` so a
 *    schedule that has never produced anything is visibly idle.
 *  - **A definition is archived, never deleted** (CXR-REV-002, ADR-0047
 *    addendum): its schedules stop and its generated runs are kept as
 *    evidence. The confirmation says both before anything happens.
 *  - **Spend is an ESTIMATE.** Every generated report carries the list-price
 *    disclaimer, and the page renders it beside the number instead of below the
 *    fold.
 *  - **A report never widens what you can see.** Generating returns the exact
 *    project ids the caller was entitled to, and the page shows them. An admin
 *    org report shows "org-wide"; anyone else sees the narrowed list, so the
 *    scoping is legible rather than implicit.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, InfoButton, Input, Select, SkeletonBlock, Switch, Table } from "../../../ui/kit";
import { QueryGate, optionEls, projectOpts, teamOpts, useAction, useProjects, useTeams, useUsers, userOpts } from "../adminKit";
import { EditReportScheduleButton } from "../editForms";
import { ReportDefinitionDetail, ReportPayloadView, ReportRunDetail, ReportRunsCard } from "./ReportsHistory";
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
  /** absent from a gateway that predates archiving (CXR-REV-002): read as active */
  status?: "active" | "archived";
  schedules: ScheduleRow[];
  lastGeneratedAt: string | null;
  runCount: number;
}
interface Overview {
  definitions: DefinitionRow[];
  schedulerPresent: boolean;
  note: string;
}
interface GeneratedReport {
  run: { id: string };
  /** the payload, rendered by the one shared renderer (ReportPayloadView) */
  report: { definitionName: string; period: { label: string } } & Record<string, unknown>;
  scope: { entitlementScope: string; effectiveProjectIds: string[] | null; reason: string };
}

export default function ReportsPage() {
  const act = useAction();
  const teams = useTeams();
  const projects = useProjects();

  const users = useUsers();
  const [showArchived, setShowArchived] = useState(false);
  const overview = useQuery({
    queryKey: ["admin", "reports-overview", showArchived],
    queryFn: () => api.get<Overview>(showArchived ? "/v1/reports/overview?include=archived" : "/v1/reports/overview"),
  });
  // CXR-REV-002: the definition an Archive click is confirming
  const [archiving, setArchiving] = useState<DefinitionRow | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<DefinitionRow["kind"]>("exec_summary");
  const [scopeKind, setScopeKind] = useState<DefinitionRow["scopeKind"]>("org");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState("current_month");
  const [entitlementScope, setEntitlementScope] = useState<DefinitionRow["entitlementScope"]>("org");
  const [cadence, setCadence] = useState("monthly");
  const [scheduleFor, setScheduleFor] = useState("");
  const [result, setResult] = useState<GeneratedReport | null>(null);
  // Batch U4: a definition or a run opened for its full record
  const [openDefinition, setOpenDefinition] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  // the "Details" button that opened the definition dialog: a run opened from inside that dialog
  // replaces it, so closing the run hands focus back here (the dialog's own return target is gone)
  const definitionOpener = useRef<HTMLButtonElement | null>(null);
  const [runFromDefinition, setRunFromDefinition] = useState(false);

  const defs = overview.data?.definitions ?? [];
  const activeDefs = defs.filter((d) => d.status !== "archived");
  // CXR-REV-001: whether a scheduler actually drives the schedules here, as the gateway reports it
  const schedulerOn = overview.data?.schedulerPresent === true;
  // I-2: one empty state while nothing exists. This is the run history's own first read (same key, one request);
  // only an answered, empty history counts, and a failed one falls through to the page as it is, where it says so.
  const runs = useQuery({
    queryKey: ["admin", "report-runs", "", 50],
    queryFn: () => api.get<{ runs: Array<{ id: string }> }>("/v1/reports/runs?limit=50"),
  });
  // only the first answer is waited for: a card that later refetches this read never flips the page back
  const settling = overview.isSuccess && defs.length === 0 && runs.dataUpdatedAt === 0 && runs.errorUpdatedAt === 0;
  const nothingYet = overview.isSuccess && defs.length === 0 && runs.isSuccess && (runs.data?.runs ?? []).length === 0;

  return (
    <>
      <PageHeader
        title="Executive & compliance reports"
        info={<p>A read-only projection over the ledgers this platform already holds — spend, governance decisions and approval throughput. No second source of truth, no rollup table that could drift from the cost dashboard. Every generation is scoped to the requesting caller's own entitlement: a report can never show spend or audit data you could not see directly.</p>}
      />
      <div className={v.stack}>
        <QueryGate query={overview}>
          <Card
            title="Report definitions"
            info={
              <p>
                An <strong>org</strong> reporting grant is admin-only: an org-wide rollup aggregates across teams,
                which is exactly where a naive report leaks one team's numbers to another. A team or project grant is
                further narrowed at generation time to the projects the caller is actually a member of.
              </p>
            }
          >
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
              {settling ? (
                <SkeletonBlock lines={3} />
              ) : nothingYet ? (
                <EmptyState
                  title="No reports yet"
                  body={
                    <>
                      No definition, no schedule and no run exist yet. A definition describes WHAT to compute and WHO
                      may run it. It computes nothing until it is generated. Create one above, then generate it or give
                      it a schedule.
                      <span className={schedulerOn ? v.faint : v.errLine} role="note" style={{ display: "block", marginTop: "var(--s1)" }}>
                        {schedulerOn
                          ? "The in-process scheduler is on in this deployment: it generates each schedule when its cadence comes due."
                          : "Nothing in this deployment fires schedules: an operator or an external cron must run them."}{" "}
                        <InfoButton label="schedules">
                          {schedulerOn ? (
                            <>
                              A schedule is a cadence the in-process scheduler acts on;{" "}
                              <code>POST /v1/reports/schedules/run-due</code> runs the same sweep on demand.
                            </>
                          ) : (
                            <>
                              A schedule is a definition of a cadence; an operator or an external cron must call{" "}
                              <code>POST /v1/reports/schedules/run-due</code>, or no scheduled report is ever produced.
                              &ldquo;Last generated: never&rdquo; on a schedule means exactly that.
                            </>
                          )}
                        </InfoButton>
                      </span>
                    </>
                  }
                />
              ) : (
                <>
                <div className={v.row}>
                  <span id="reports-show-archived" className={v.faint}>
                    Show archived definitions
                  </span>
                  <Switch size="sm" checked={showArchived} labelledBy="reports-show-archived" onChange={setShowArchived} />
                </div>
                {defs.length === 0 ? (
                <EmptyState title="No report definitions yet" body="A definition describes WHAT to compute and WHO may run it. It computes nothing until it is generated." />
              ) : (
                <Table
                  rows={defs}
                  rowKey={(d) => d.id}
                  columns={[
                    {
                      key: "name",
                      header: "Name",
                      render: (d) =>
                        d.status === "archived" ? (
                          <>
                            {d.name} <Badge tone="neutral">archived</Badge>
                          </>
                        ) : (
                          d.name
                        ),
                    },
                    { key: "kind", header: "Kind", render: (d) => <Badge tone="info">{d.kind}</Badge> },
                    { key: "scope", header: "Scope", render: (d) => d.scopeKind },
                    { key: "grant", header: "Grant", render: (d) => <Badge tone={d.entitlementScope === "org" ? "warn" : "neutral"}>{d.entitlementScope}</Badge> },
                    { key: "period", header: "Period", render: (d) => d.period },
                    { key: "runs", header: "Runs", render: (d) => d.runCount },
                    { key: "last", header: "Last generated", render: (d) => (d.lastGeneratedAt ? ago(d.lastGeneratedAt) : <span className={v.faint}>never</span>) },
                    {
                      key: "act",
                      header: "",
                      srHeader: "Actions",
                      render: (d) => (
                        <div className={a.formRow}>
                          <Button
                            size="sm"
                            aria-label={`Details of ${d.name}`}
                            onClick={(e) => {
                              definitionOpener.current = e.currentTarget;
                              setOpenDefinition(d.id);
                            }}
                          >
                            Details
                          </Button>
                          {d.status !== "archived" && (
                            <>
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
                              <Button size="sm" variant="danger" aria-label={`Archive ${d.name}`} onClick={() => setArchiving(d)}>
                                Archive
                              </Button>
                            </>
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              )}
                </>
              )}
            </div>
          </Card>

          {!settling && !nothingYet && (
          <>
          <Card
            title="Schedules"
            info={
              schedulerOn ? (
                <p>
                  A schedule is a <strong>cadence the in-process scheduler acts on</strong> in this deployment.{" "}
                  <code>POST /v1/reports/schedules/run-due</code> runs the same sweep on demand. Schedules of an
                  archived definition are disabled and never fire.
                </p>
              ) : (
                <p>
                  A schedule is a <strong>definition of a cadence</strong>; an
                  operator or an external cron must call <code>POST /v1/reports/schedules/run-due</code>, or no
                  scheduled report is ever produced. "Last generated: never" below means exactly that.
                </p>
              )
            }
          >
            <div className={v.stack}>
              <div className={schedulerOn ? v.faint : v.errLine} role="note">
                {schedulerOn
                  ? "The in-process scheduler fires these when their cadence comes due."
                  : "Nothing in this deployment fires these: an operator or an external cron must run them."}
              </div>
              <div className={a.formRow}>
                <Field label="Definition">
                  <Select value={scheduleFor} onChange={(e) => setScheduleFor(e.target.value)}>
                    {optionEls(activeDefs.map((d) => ({ v: d.id, l: d.name })), "select…")}
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
                      }, schedulerOn ? "Schedule recorded — the scheduler generates it when it is due" : "Schedule recorded — nothing drives it automatically")
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
                        s.lastGeneratedAt ? (
                          ago(s.lastGeneratedAt)
                        ) : schedulerOn ? (
                          <Badge tone="neutral">never yet</Badge>
                        ) : (
                          <Badge tone="warn">never — nothing drives this</Badge>
                        ),
                    },
                    {
                      key: "act",
                      header: "",
                      srHeader: "Actions",
                      render: (s) => (
                        <div className={v.row}>
                          {s.lastRunId && (
                            <Button size="sm" aria-label={`Last run of ${s.definition}`} onClick={() => setOpenRun(s.lastRunId)}>
                              Last run
                            </Button>
                          )}
                          <EditReportScheduleButton schedule={s} definitionName={s.definition} users={userOpts(users.data?.users).map((o) => ({ value: o.v, label: o.l }))} usersLoading={users.isLoading} onSaved={() => void overview.refetch()} />
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
                        </div>
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
                <div className={v.faint}>
                  Entitlement: <strong>{result.scope.entitlementScope}</strong> —{" "}
                  {result.scope.effectiveProjectIds === null
                    ? "org-wide (admin, org-scoped definition), including spend attributed to no project"
                    : `${result.scope.effectiveProjectIds.length} project(s)`}
                  . {result.scope.reason}
                </div>
                <ReportPayloadView payload={result.report} />
              </div>
            </Card>
          )}
          <ReportRunsCard definitions={defs.map((d) => ({ id: d.id, name: d.name }))} onOpenRun={(id) => {
              setRunFromDefinition(false);
              setOpenRun(id);
            }}
          />
          </>
          )}
        </QueryGate>
      </div>
      {openDefinition && (
        <ReportDefinitionDetail key={openDefinition} id={openDefinition} onClose={() => setOpenDefinition(null)} onOpenRun={(id) => {
            setOpenDefinition(null);
            setRunFromDefinition(true);
            setOpenRun(id);
          }}
        />
      )}
      <ConfirmModal
        open={archiving !== null}
        danger
        title={archiving ? `Archive ${archiving.name}?` : "Archive definition?"}
        confirmLabel="Archive"
        body={
          archiving && (
            <div className={v.stack}>
              <p>
                Archiving is final. The definition is hidden from this list and generates no new report.
              </p>
              <p>
                {archiving.schedules.length === 0
                  ? "It has no schedule."
                  : `Its ${archiving.schedules.length} schedule${archiving.schedules.length === 1 ? " is" : "s are"} disabled and stop${archiving.schedules.length === 1 ? "s" : ""} firing.`}{" "}
                {archiving.runCount === 0
                  ? "It has generated no run yet."
                  : `The ${archiving.runCount} generated run${archiving.runCount === 1 ? " is" : "s are"} kept and stay${archiving.runCount === 1 ? "s" : ""} readable in the run history.`}
              </p>
              <p className={v.faint}>The archive is recorded in the audit log.</p>
            </div>
          )
        }
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          const d = archiving;
          setArchiving(null);
          if (!d) return;
          void act.run(async () => {
            const r = await api.post<{ runsKept: number; schedulesDisabled: number }>(`/v1/reports/definitions/${d.id}/archive`, {});
            await overview.refetch();
            return `Definition archived: ${r.schedulesDisabled} schedule(s) stopped, ${r.runsKept} run(s) kept`;
          });
        }}
      />
      {openRun && (
        <ReportRunDetail
          key={openRun}
          id={openRun}
          onClose={() => {
            setOpenRun(null);
            if (runFromDefinition) {
              setRunFromDefinition(false);
              // after the dialog unmounts and its own focus return has run
              requestAnimationFrame(() => {
                if (definitionOpener.current?.isConnected) definitionOpener.current.focus();
              });
            }
          }}
        />
      )}
    </>
  );
}
