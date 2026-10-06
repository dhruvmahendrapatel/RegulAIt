/**
 * ADR-0173 batch 2c (K) — MONITORING: key risk indicators over traces, the
 * thresholds that raise governance alerts, and custom dashboards.
 *
 *  - **KRI tiles** show each indicator's current value over its window, the
 *    threshold, the sample count against its minimum, and whether a
 *    governance alert is open. "Too few samples" is a state of its own: below
 *    the minimum a KRI neither raises nor clears an alert, and the tile says so.
 *  - **Thresholds** are edited here; a breach is evaluated on every
 *    governance-monitor pass and lands on the Governance alerts page.
 *  - **Series** plot one metric over time, overall or per agent / project
 *    (the top 20 by name, the rest as "Other"); the chart draws the first six
 *    and the table below it lists every value, so nothing is colour-only.
 *  - **Dashboards** save a set of KRI tiles and series (at most 24 panels).
 *
 * Charts use recharts (MIT, ADR-0173 batch 2c's pick for new dashboards).
 */
import { Suspense, lazy, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, SkeletonBlock, Table, type Tone } from "../../../ui/kit";
import { QueryGate, RemoveButton, agentOpts, optionEls, projectOpts, useAction, useAgents, useProjects } from "../adminKit";
import v from "../../views.module.css";
import m from "./monitoring.module.css";
import {
  EMPTY_KRI_FORM,
  KRI_METRIC_OPTIONS,
  KRI_STATE_WORDS,
  MONITORING_LIMITS,
  SERIES_RANGES,
  formatMetricValue,
  kriFormFrom,
  kriFormProblem,
  kriIsWindowTotal,
  kriPayload,
  pivotSeries,
  seriesPath,
  type Dashboard,
  type DashboardPanel,
  type Kri,
  type KriForm,
  type KrisResponse,
  type KriState,
  type SeriesResponse,
} from "./monitoringModel";

type OnBreach = "alert" | "propose_halt";
const STATE_TONE: Record<KriState, Tone> = { breached: "danger", ok: "ok", insufficient: "neutral", disabled: "neutral" };
// recharts lives in its own chunk, loaded with the first chart (the run graph's pattern)
const SeriesLineChart = lazy(() => import("./SeriesLineChart"));

export default function MonitoringPage() {
  const kris = useQuery({ queryKey: ["admin", "kris"], queryFn: () => api.get<KrisResponse>("/v1/kris") });
  const [editing, setEditing] = useState<Kri | "new" | null>(null);
  return (
    <>
      <PageHeader
        title="Monitoring"
        sub={
          "Key risk indicators over traces: volume, error rate, p50/p99 latency, cost and annotation feedback, for " +
          "the fleet, an agent or a project. A threshold you set here raises a governance alert when it is crossed."
        }
      />
      <div className={v.stack}>
        <Card
          title="Key risk indicators"
          actions={
            <Button size="sm" onClick={() => setEditing("new")}>
              New KRI
            </Button>
          }
        >
          <QueryGate loading={kris.isLoading} error={kris.error} onRetry={() => void kris.refetch()}>
            {(kris.data?.kris ?? []).length === 0 ? (
              <EmptyState title="No KRIs yet" body="Add one to watch a metric against a threshold." />
            ) : (
              <ul className={m.tiles} aria-label="Key risk indicators">
                {(kris.data?.kris ?? []).map((k) => (
                  <KriTile key={k.id} kri={k} onEdit={() => setEditing(k)} />
                ))}
              </ul>
            )}
            {kris.data?.note && <p className={v.faint}>{kris.data.note}</p>}
          </QueryGate>
        </Card>
        {editing && <KriEditor kri={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
        <SeriesCard />
        <DashboardsCard kris={kris.data?.kris ?? []} />
      </div>
    </>
  );
}

function KriTile(props: { kri: Kri; onEdit: () => void }) {
  const k = props.kri;
  const state: KriState = k.measurement?.state ?? (k.enabled ? "insufficient" : "disabled");
  const scope = k.scope === "fleet" ? "Fleet" : `${k.scope === "agent" ? "Agent" : "Project"} ${k.scopeLabel ?? k.scopeId?.slice(0, 8) ?? ""}`;
  return (
    <li className={m.tile} aria-label={`KRI ${k.name}`}>
      <div className={m.tileHead}>
        <span className={m.tileName}>{k.name}</span>
        <Badge tone={STATE_TONE[state]}>{KRI_STATE_WORDS[state]}</Badge>
      </div>
      <div className={m.tileValue}>{k.measurement ? formatMetricValue(k.metric, k.measurement.value) : "—"}</div>
      <div className={v.dim}>
        {k.metricLabel} · {scope} · {k.windowDays} {k.windowDays === 1 ? "day" : "days"}
      </div>
      <div className={v.faint}>
        Threshold: {k.comparator} {formatMetricValue(k.metric, k.threshold)} ·{" "}
        {kriIsWindowTotal(k.metric)
          ? "a total over the whole window, so no minimum sample count applies"
          : `${k.measurement?.samples ?? 0} of ${k.minSamples} samples needed`}
      </div>
      <div className={v.row}>
        {k.alert ? (
          <Link to="/admin/governance/alerts">Alert {k.alert.status}</Link>
        ) : (
          <span className={v.faint}>No open alert</span>
        )}
        <Button size="sm" variant="ghost" onClick={props.onEdit} aria-label={`Edit KRI ${k.name}`}>
          Edit
        </Button>
      </div>
    </li>
  );
}

function KriEditor(props: { kri: Kri | null; onClose: () => void }) {
  const [f, setF] = useState<KriForm>(() => (props.kri ? kriFormFrom(props.kri) : EMPTY_KRI_FORM));
  const set = <K extends keyof KriForm>(key: K, value: KriForm[K]) => setF((x) => ({ ...x, [key]: value }));
  // ADR-0182 S5 (PF-03): what a breach does. `propose_halt` is an agent KRI's
  // option only (the gateway answers 422 otherwise); it SUGGESTS a halt on
  // the alert and never files or halts anything on its own.
  const [onBreach, setOnBreach] = useState<OnBreach>(() => (props.kri as (Kri & { onBreach?: OnBreach }) | null)?.onBreach ?? "alert");
  const effectiveOnBreach: OnBreach = f.scope === "agent" ? onBreach : "alert";
  const storedOnBreach = (props.kri as (Kri & { onBreach?: OnBreach }) | null)?.onBreach ?? "alert";
  // sent for an agent KRI, or to clear a stored suggestion when the scope moves
  const onBreachField = f.scope === "agent" || storedOnBreach !== "alert" ? { onBreach: effectiveOnBreach } : {};
  const agents = useAgents();
  const projects = useProjects();
  const act = useAction();
  const problem = kriFormProblem(f);
  const save = () =>
    act
      .run(
        () =>
          props.kri
            ? api.patch(`/v1/kris/${props.kri.id}`, { ...kriPayload(f), ...onBreachField })
            : api.post("/v1/kris", { ...kriPayload(f), ...onBreachField }),
        props.kri ? "KRI saved" : "KRI created",
      )
      .then((ok) => ok && props.onClose());
  return (
    <Card title={props.kri ? `Edit KRI ${props.kri.name}` : "New KRI"}>
      <div className={v.stack}>
        <div className={v.grid3}>
          <Field label="KRI name">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
          </Field>
          <Field label="Metric">
            <Select value={f.metric} onChange={(e) => set("metric", e.target.value as KriForm["metric"])}>
              {KRI_METRIC_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} ({o.unit})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Select value={f.scope} onChange={(e) => setF((x) => ({ ...x, scope: e.target.value as KriForm["scope"], scopeId: "" }))}>
              <option value="fleet">Whole fleet</option>
              <option value="agent">One agent</option>
              <option value="project">One project</option>
            </Select>
          </Field>
          {f.scope === "agent" && (
            <Field label="Agent">
              <Select value={f.scopeId} onChange={(e) => set("scopeId", e.target.value)}>
                {optionEls(agentOpts(agents.data?.agents), "Pick an agent")}
              </Select>
            </Field>
          )}
          {f.scope === "project" && (
            <Field label="Project">
              <Select value={f.scopeId} onChange={(e) => set("scopeId", e.target.value)}>
                {optionEls(projectOpts(projects.data?.projects), "Pick a project")}
              </Select>
            </Field>
          )}
          <Field label="Window (days, at most 90)">
            <Input type="number" min={1} max={MONITORING_LIMITS.maxWindowDays} value={f.windowDays} onChange={(e) => set("windowDays", e.target.value)} />
          </Field>
          <Field label="Alert when the value is">
            <Select value={f.comparator} onChange={(e) => set("comparator", e.target.value as KriForm["comparator"])}>
              <option value="above">Above the threshold</option>
              <option value="below">Below the threshold</option>
            </Select>
          </Field>
          <Field label="Threshold">
            <Input type="number" value={f.threshold} onChange={(e) => set("threshold", e.target.value)} />
          </Field>
          <Field label="Minimum samples">
            <Input type="number" min={1} value={f.minSamples} onChange={(e) => set("minSamples", e.target.value)} />
          </Field>
          <Field label="Alert severity">
            <Select value={f.severity} onChange={(e) => set("severity", e.target.value as KriForm["severity"])}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="When it breaches">
            <Select
              value={effectiveOnBreach}
              disabled={f.scope !== "agent"}
              onChange={(e) => setOnBreach(e.target.value as OnBreach)}
            >
              <option value="alert">Raise an alert</option>
              <option value="propose_halt">Raise an alert that suggests halting the agent</option>
            </Select>
          </Field>
          {f.metric === "feedback_score" && (
            <Field label="Annotation score name (optional)">
              <Input value={f.scoreName} onChange={(e) => set("scoreName", e.target.value)} maxLength={128} />
            </Field>
          )}
        </div>
        <p className={v.faint}>
          Below the minimum sample count the KRI neither raises nor clears an alert, so one slow call or a quiet weekend
          never decides anything.
        </p>
        <p className={v.faint} data-testid="kri-on-breach-note">
          {f.scope !== "agent"
            ? "Only a KRI on one agent can suggest a halt: there is one agent to halt."
            : effectiveOnBreach === "propose_halt"
              ? "A breach raises an alert carrying a suggested halt. Nothing is filed and nothing stops on its own: a person may propose the halt from the alert, and a different person must approve it."
              : "A breach raises an alert only."}
        </p>
        {problem && (
          <p className={v.errLine} role="alert">
            {problem}
          </p>
        )}
        <div className={v.row}>
          <Button onClick={() => void save()} disabled={problem !== null || act.busy}>
            {props.kri ? "Save KRI" : "Create KRI"}
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {props.kri && (
            <RemoveButton
              what={`KRI ${props.kri.name}`}
              consequence="Its open governance alert, if any, is resolved and the deletion is audited."
              onRemove={() => api.del(`/v1/kris/${props.kri!.id}`)}
              onDone={props.onClose}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

function SeriesChart(props: { title: string; metric: string; groupBy: string; rangeDays: number; bucket: "hour" | "day"; showTable?: boolean }) {
  const path = useMemo(() => seriesPath(props), [props.metric, props.groupBy, props.rangeDays, props.bucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({ queryKey: ["admin", "series", path], queryFn: () => api.get<SeriesResponse>(path) });
  const [table, setTable] = useState(Boolean(props.showTable));
  const pivot = useMemo(() => (q.data ? pivotSeries(q.data) : null), [q.data]);
  return (
    <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
      {q.data && pivot && pivot.rows.length === 0 ? (
        <EmptyState title="No traces in this range" />
      ) : q.data && pivot ? (
        <div className={v.stackTight}>
          <figure className={`${m.chart} ${m.palette}`} aria-label={props.title}>
            <Suspense fallback={<SkeletonBlock lines={6} />}>
              <SeriesLineChart rows={pivot.rows} charted={pivot.charted} metric={props.metric} bucket={q.data.bucket} />
            </Suspense>
          </figure>
          <div className={v.row}>
            <span className={v.faint}>
              {q.data.groups.length > pivot.charted.length
                ? `The chart draws the first ${pivot.charted.length} of ${q.data.groups.length} groups; the table lists them all.`
                : "The table lists every value."}
              {q.data.otherIsApproximate ? " \"Other\" is a sample-weighted mean of the folded groups." : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setTable((t) => !t)} aria-expanded={table}>
              {table ? "Hide table" : "Show table"}
            </Button>
          </div>
          {table && (
            <Table
              rows={q.data.points}
              rowKey={(p) => `${p.bucket}|${p.group}`}
              columns={[
                { key: "bucket", header: "Bucket", render: (p) => <span className={v.num}>{p.bucket}</span>, sort: (p) => p.bucket },
                { key: "group", header: "Group", render: (p) => q.data!.groups.find((g) => g.key === p.group)?.label ?? p.group },
                { key: "value", header: "Value", align: "right", render: (p) => formatMetricValue(props.metric, p.value), sort: (p) => p.value ?? -1 },
                { key: "samples", header: "Samples", align: "right", render: (p) => <span className={v.num}>{p.samples}</span> },
              ]}
            />
          )}
        </div>
      ) : null}
    </QueryGate>
  );
}

function SeriesCard() {
  const [metric, setMetric] = useState("trace_volume");
  const [groupBy, setGroupBy] = useState("none");
  const [rangeDays, setRangeDays] = useState(7);
  const range = SERIES_RANGES.find((r) => r.days === rangeDays) ?? SERIES_RANGES[1];
  const label = KRI_METRIC_OPTIONS.find((o) => o.id === metric)?.label ?? metric;
  return (
    <Card title="Series">
      <div className={v.stack}>
        <div className={v.grid3}>
          <Field label="Series metric">
            <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {KRI_METRIC_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Group by">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              <option value="none">Nothing (all traces)</option>
              <option value="agent">Agent</option>
              <option value="project">Project</option>
            </Select>
          </Field>
          <Field label="Range">
            <Select value={String(rangeDays)} onChange={(e) => setRangeDays(Number(e.target.value))}>
              {SERIES_RANGES.map((r) => (
                <option key={r.days} value={r.days}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SeriesChart title={`${label} over ${range.label.toLowerCase()}`} metric={metric} groupBy={groupBy} rangeDays={range.days} bucket={range.bucket} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// dashboards
// ---------------------------------------------------------------------------

function DashboardsCard(props: { kris: Kri[] }) {
  const q = useQuery({ queryKey: ["admin", "dashboards"], queryFn: () => api.get<{ dashboards: Dashboard[] }>("/v1/monitoring/dashboards") });
  const act = useAction();
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [panelKind, setPanelKind] = useState<"kri" | "series">("series");
  const [panelKri, setPanelKri] = useState("");
  const [panelMetric, setPanelMetric] = useState("trace_volume");
  const [panelRange, setPanelRange] = useState(7);
  const list = q.data?.dashboards ?? [];
  const current = list.find((d) => d.id === selected) ?? null;
  const create = () =>
    act.run(async () => {
      const d = await api.post<Dashboard>("/v1/monitoring/dashboards", { name: name.trim(), panels: [] });
      setSelected(d.id);
      setName("");
    }, "Dashboard created");
  const savePanels = (panels: DashboardPanel[]) => act.run(() => api.patch(`/v1/monitoring/dashboards/${current!.id}`, { panels }), "Dashboard saved");
  const addPanel = () => {
    if (!current) return;
    const range = SERIES_RANGES.find((r) => r.days === panelRange) ?? SERIES_RANGES[1];
    const panel: DashboardPanel =
      panelKind === "kri"
        ? { kind: "kri", title: props.kris.find((k) => k.id === panelKri)?.name ?? "KRI", kriId: panelKri }
        : {
            kind: "series",
            title: `${KRI_METRIC_OPTIONS.find((o) => o.id === panelMetric)?.label ?? panelMetric}, ${range.label.toLowerCase()}`,
            metric: panelMetric,
            groupBy: "none",
            bucket: range.bucket,
            rangeDays: range.days,
          };
    void savePanels([...current.panels, panel]);
  };
  const full = (current?.panels.length ?? 0) >= MONITORING_LIMITS.maxPanels;
  return (
    <Card title="Dashboards">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div className={v.stack}>
          <div className={v.row}>
            <Field label="Dashboard">
              <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {optionEls(list.map((d) => ({ v: d.id, l: `${d.name} (${d.panels.length} panels)` })), list.length ? "Pick a dashboard" : "No dashboards yet")}
              </Select>
            </Field>
            <Field label="New dashboard name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="&nbsp;">
              <Button onClick={() => void create()} disabled={!name.trim() || act.busy}>
                Create dashboard
              </Button>
            </Field>
          </div>
          {current && (
            <>
              <div className={v.row}>
                <Field label="Panel type">
                  <Select value={panelKind} onChange={(e) => setPanelKind(e.target.value as "kri" | "series")}>
                    <option value="series">Series</option>
                    <option value="kri">KRI tile</option>
                  </Select>
                </Field>
                {panelKind === "kri" ? (
                  <Field label="Panel KRI">
                    <Select value={panelKri} onChange={(e) => setPanelKri(e.target.value)}>
                      {optionEls(props.kris.map((k) => ({ v: k.id, l: k.name })), "Pick a KRI")}
                    </Select>
                  </Field>
                ) : (
                  <>
                    <Field label="Panel metric">
                      <Select value={panelMetric} onChange={(e) => setPanelMetric(e.target.value)}>
                        {KRI_METRIC_OPTIONS.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Panel range">
                      <Select value={String(panelRange)} onChange={(e) => setPanelRange(Number(e.target.value))}>
                        {SERIES_RANGES.map((r) => (
                          <option key={r.days} value={r.days}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}
                <Field label="&nbsp;">
                  <Button onClick={addPanel} disabled={full || act.busy || (panelKind === "kri" && !panelKri)}>
                    Add panel
                  </Button>
                </Field>
                <Field label="&nbsp;">
                  <RemoveButton
                    what={`dashboard ${current.name}`}
                    consequence="The saved layout is deleted; the KRIs it shows are not."
                    onRemove={() => api.del(`/v1/monitoring/dashboards/${current.id}`)}
                    onDone={() => setSelected("")}
                  />
                </Field>
              </div>
              {full && <p className={v.faint}>A dashboard holds at most {MONITORING_LIMITS.maxPanels} panels.</p>}
              {current.panels.length === 0 ? (
                <EmptyState title="No panels yet" body="Add a KRI tile or a series." />
              ) : (
                <ul className={m.panels} aria-label={`Panels of ${current.name}`}>
                  {current.panels.map((p, i) => (
                    <li key={i} className={m.panel}>
                      <div className={m.tileHead}>
                        <span className={m.tileName}>{p.title}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove panel ${p.title}`}
                          onClick={() => void savePanels(current.panels.filter((_, j) => j !== i))}
                        >
                          Remove
                        </Button>
                      </div>
                      {p.kind === "kri" ? (
                        (() => {
                          const k = props.kris.find((x) => x.id === p.kriId);
                          return k ? (
                            <div className={v.stackTight}>
                              <div className={m.tileValue}>{k.measurement ? formatMetricValue(k.metric, k.measurement.value) : "—"}</div>
                              <Badge tone={STATE_TONE[k.measurement?.state ?? "disabled"]}>{KRI_STATE_WORDS[k.measurement?.state ?? "disabled"]}</Badge>
                            </div>
                          ) : (
                            <span className={v.faint}>This KRI was removed.</span>
                          );
                        })()
                      ) : (
                        <SeriesChart title={p.title} metric={p.metric} groupBy={p.groupBy} rangeDays={p.rangeDays} bucket={p.bucket} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {!current && list.length > 0 && <p className={v.faint}>Pick a dashboard to open it.</p>}
        </div>
      </QueryGate>
    </Card>
  );
}
