/**
 * Process analytics (ADR-0342), at `/admin/process-analytics`: how workflow instances move through their templates and
 * stages in a window. Per template (started, ended by status, cycle time, rework), the stages ranked by total wait (the
 * bottleneck ranking), a stage x period heatmap and the throughput per period, all read from the gateway's projection
 * of the workflow history. "Refresh now" runs one bounded projection pass (admin, audited by the gateway).
 *
 * Truthful state: a figure the gateway answers as `null` is "Not measured", a period it does not send is "No visits" or
 * "No events", a failed read is an error with Retry, and a projection that has never run says so. Nothing is shown as 0
 * unless the gateway said 0. The filters, the two tables' paging and the refresh flow are one reducer
 * (`analyticsReducer`, processAnalyticsModel.ts); this file renders its state.
 */
import { useReducer } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { WorkflowTemplate } from "../../../api/adminTypes";
import { errorText, fmtAt, fmtDay, fmtDur, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, InfoButton, Select, Table, type Column } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { rangeText } from "../../../ui/listState";
import { QueryGate } from "../adminKit";
import { ANALYTICS_KEY, fetchHeatmap, fetchStages, fetchTemplates, fetchThroughput, refreshAnalytics } from "./processAnalyticsApi";
import {
  BUCKETS,
  NOT_MEASURED,
  PAGE_SIZE,
  WINDOWS,
  analyticsReducer,
  cellsByPeriod,
  initialAnalyticsState,
  pct,
  waitLevel,
  type Bucket,
  type Envelope,
  type Heatmap,
  type StageRow,
  type TemplateRow,
  type Throughput,
  type WindowDays,
} from "./processAnalyticsModel";
import s from "./processAnalytics.module.css";
import v from "../../views.module.css";

const BUCKET_LABEL: Record<Bucket, string> = { day: "Day", week: "Week", month: "Month" };
const dur = (ms: number | null) => (ms == null ? NOT_MEASURED : fmtDur(ms));

export default function ProcessAnalyticsPage() {
  const [state, dispatch] = useReducer(analyticsReducer, new Date().toISOString(), initialAnalyticsState);
  const qc = useQueryClient();
  const f = { days: state.days, anchor: state.anchor, templateId: state.templateId };
  const key = [...ANALYTICS_KEY, state.days, state.anchor, state.templateId] as const;

  const catalogue = useQuery({
    queryKey: ["admin", "wf-templates"],
    queryFn: () => api.get<{ templates: WorkflowTemplate[] }>("/v1/workflows/templates"),
  });
  const templates = useQuery({ queryKey: [...key, "templates", state.templatesOffset], queryFn: () => fetchTemplates(f, state.templatesOffset), placeholderData: keepPreviousData });
  const stages = useQuery({ queryKey: [...key, "stages", state.stagesOffset], queryFn: () => fetchStages(f, state.stagesOffset), placeholderData: keepPreviousData });
  const heatmap = useQuery({ queryKey: [...key, "heatmap", state.bucket], queryFn: () => fetchHeatmap(f, state.bucket) });
  const throughput = useQuery({ queryKey: [...key, "throughput", state.bucket], queryFn: () => fetchThroughput(f, state.bucket) });

  const refresh = () => {
    if (state.refresh.phase === "running") return;
    dispatch({ type: "refreshStart" });
    refreshAnalytics()
      .then((result) => {
        dispatch({ type: "refreshDone", result, now: new Date().toISOString() });
        void qc.invalidateQueries({ queryKey: ANALYTICS_KEY });
      })
      .catch((e: unknown) => dispatch({ type: "refreshFailed", message: errorText(e) }));
  };

  // the freshness line comes from whichever read has answered; every response carries the same envelope
  const env: Envelope | undefined = templates.data ?? stages.data ?? heatmap.data ?? throughput.data;
  const neverProjected = env != null && env.lastProjectedAt == null;
  const running = state.refresh.phase === "running";

  return (
    <>
      <SubpageTrail parent="Workflow templates" parentTo="/admin/workflow-templates" current="Process analytics" />
      <PageHeader
        title="Process analytics"
        sub="How workflow instances move through their templates and stages: cycle time, where work waits, rework and throughput."
        actions={
          <Button size="sm" aria-disabled={running || undefined} onClick={refresh}>
            {running ? "Refreshing…" : "Refresh now"}
          </Button>
        }
      />
      <div className={v.stack}>
        <Card title="Window">
          <div className={v.row}>
            <Field label="Window">
              <Select value={state.days} onChange={(e) => dispatch({ type: "window", days: Number(e.target.value) as WindowDays, now: new Date().toISOString() })}>
                {WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
              </Select>
            </Field>
            <Field label="Template">
              <Select value={state.templateId} onChange={(e) => dispatch({ type: "template", templateId: e.target.value })}>
                <option value="">All templates</option>
                {(catalogue.data?.templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Period">
              <Select value={state.bucket} onChange={(e) => dispatch({ type: "bucket", bucket: e.target.value as Bucket })}>
                {BUCKETS.map((b) => <option key={b} value={b}>{BUCKET_LABEL[b]}</option>)}
              </Select>
            </Field>
          </div>
          <Freshness env={env} />
          {catalogue.isError && <p className={v.errLine} role="alert">The template list could not be loaded, so only "All templates" can be chosen.</p>}
        </Card>

        {neverProjected && (
          <Card>
            <EmptyState title="Not projected yet" body="The workflow history has not been projected for analytics yet, so there are no figures to show. Nothing here means zero. Refresh now runs a projection pass." />
          </Card>
        )}
        <RefreshOutcome flow={state.refresh} onDismiss={() => dispatch({ type: "refreshDismiss" })} />

        <QueryGate query={templates}>
          {templates.data && (
            <TemplatesCard
              data={templates.data}
              neverProjected={neverProjected}
              onPage={(offset) => dispatch({ type: "templatesPage", offset })}
            />
          )}
        </QueryGate>
        <QueryGate query={stages}>
          {stages.data && <StagesCard data={stages.data} neverProjected={neverProjected} onPage={(offset) => dispatch({ type: "stagesPage", offset })} />}
        </QueryGate>
        <QueryGate query={heatmap}>{heatmap.data && <HeatmapCard data={heatmap.data} />}</QueryGate>
        <QueryGate query={throughput}>{throughput.data && <ThroughputCard data={throughput.data} />}</QueryGate>
      </div>
    </>
  );
}

function Freshness({ env }: { env: Envelope | undefined }) {
  if (!env) return null;
  const excluded = env.excluded.diverged + env.excluded.tooLong;
  return (
    <p className={v.dim}>
      {fmtDay(env.window.from, env.window.from)} to {fmtDay(env.window.to, env.window.to)} (UTC).{" "}
      {env.lastProjectedAt ? `Figures as of ${fmtAt(env.lastProjectedAt)}; they can lag the workflow engine by a few minutes.` : "Not projected yet."}
      {excluded > 0 &&
        ` ${plural(excluded, "instance")} left out: ${env.excluded.diverged} whose history diverged, ${env.excluded.tooLong} too long to project.`}{" "}
      <InfoButton label="How these figures are calculated">
        <p>{env.basis}</p>
        <p>Instances whose history diverged are left out, never counted. A visit counts in the period it ended. Wait includes the time spent waiting for approvers.</p>
      </InfoButton>
    </p>
  );
}

function RefreshOutcome({ flow, onDismiss }: { flow: ReturnType<typeof initialAnalyticsState>["refresh"]; onDismiss: () => void }) {
  if (flow.phase === "idle" || flow.phase === "running") return null;
  if (flow.phase === "failed")
    return (
      <Card>
        <div className={v.row}>
          <p className={v.errLine} role="alert">The projection pass did not run: {flow.message}</p>
          <Button size="sm" onClick={onDismiss}>Dismiss</Button>
        </div>
      </Card>
    );
  const r = flow.result;
  return (
    <Card>
      <div className={v.row}>
        <p role="status">
          Projected {plural(r.projected, "instance")}
          {r.diverged + r.tooLong > 0 ? `; left out ${r.diverged} diverged and ${r.tooLong} too long` : ""}.
          {r.remaining ? " More remain: run Refresh now again to project the rest." : " Nothing is left to project."}
        </p>
        <Button size="sm" onClick={onDismiss}>Dismiss</Button>
      </div>
    </Card>
  );
}

function Pager(props: { offset: number; shown: number; total: number; noun: string; onPage: (offset: number) => void }) {
  const more = props.offset + props.shown < props.total;
  if (props.total <= PAGE_SIZE && props.offset === 0) return null;
  return (
    <div className={v.row}>
      <span aria-live="polite">{rangeText(props.offset, props.shown, props.total, false, more)}</span>
      <Button size="sm" aria-label={`Previous ${props.noun}`} aria-disabled={props.offset === 0 || undefined} onClick={() => props.offset > 0 && props.onPage(props.offset - PAGE_SIZE)}>
        Previous
      </Button>
      <Button size="sm" aria-label={`Next ${props.noun}`} aria-disabled={!more || undefined} onClick={() => more && props.onPage(props.offset + PAGE_SIZE)}>
        Next
      </Button>
    </div>
  );
}

const TEMPLATE_COLUMNS: Array<Column<TemplateRow>> = [
  { key: "name", header: "Template", render: (t) => t.name },
  { key: "started", header: "Started", align: "right", render: (t) => t.started },
  {
    key: "ended",
    header: "Ended",
    render: (t) =>
      t.ended.total === 0 ? "None ended" : `${t.ended.total}: ${t.ended.completed} completed, ${t.ended.aborted} aborted, ${t.ended.denied} denied, ${t.ended.rolledBack} rolled back`,
  },
  { key: "open", header: "Open", align: "right", render: (t) => t.open },
  {
    key: "cycle",
    header: "Cycle time",
    info: <p>From start to end, for instances that ended in the window. Not measured when none ended.</p>,
    infoLabel: "Cycle time",
    render: (t) => (t.cycleTimeMs.p50 == null ? NOT_MEASURED : `median ${dur(t.cycleTimeMs.p50)}, p90 ${dur(t.cycleTimeMs.p90)}`),
  },
  { key: "rework", header: "Rework", align: "right", render: (t) => pct(t.reworkRate) },
];

function TemplatesCard(props: { data: { templates: TemplateRow[]; total: number; offset: number }; neverProjected: boolean; onPage: (offset: number) => void }) {
  const d = props.data;
  return (
    <Card title="Templates" footer={<Pager offset={d.offset} shown={d.templates.length} total={d.total} noun="templates" onPage={props.onPage} />}>
      <Table
        columns={TEMPLATE_COLUMNS}
        rows={d.templates}
        rowKey={(t) => t.templateId}
        empty={<EmptyState title={props.neverProjected ? "Not projected yet" : "No workflow instances in this window"} />}
      />
    </Card>
  );
}

const STAGE_COLUMNS: Array<Column<StageRow>> = [
  { key: "rank", header: "Rank", align: "right", render: (r) => r.rank },
  { key: "stage", header: "Stage", render: (r) => <span>{r.stageId} <Badge>{r.stageType}</Badge></span> },
  { key: "visits", header: "Visits", align: "right", render: (r) => r.visits },
  { key: "duration", header: "Duration", render: (r) => (r.durationMs.p50 == null ? NOT_MEASURED : `median ${dur(r.durationMs.p50)}, p90 ${dur(r.durationMs.p90)}`) },
  {
    key: "wait",
    header: "Wait",
    info: <p>Time a visit spent waiting, including for approvers, against the time it was worked on. The share is of all wait in the window.</p>,
    infoLabel: "Wait",
    render: (r) => `${fmtDur(r.waitMs.total)} in total${r.waitShare == null ? "" : ` (${pct(r.waitShare)} of all wait)`}`,
  },
  { key: "work", header: "Work", render: (r) => `${fmtDur(r.workMs.total)} in total` },
  { key: "rework", header: "Rework", align: "right", render: (r) => pct(r.reworkRate) },
  { key: "open", header: "Open", render: (r) => (r.open === 0 ? "None" : `${r.open}${r.oldestOpenSince ? `, oldest since ${fmtAt(r.oldestOpenSince)}` : ""}`) },
];

function StagesCard(props: { data: { stages: StageRow[]; total: number; offset: number }; neverProjected: boolean; onPage: (offset: number) => void }) {
  const d = props.data;
  return (
    <Card
      title="Bottlenecks"
      caption={<span className={v.dim}>Stages ranked by their total wait in the window: the first is where work waits longest.</span>}
      footer={<Pager offset={d.offset} shown={d.stages.length} total={d.total} noun="stages" onPage={props.onPage} />}
    >
      <Table
        columns={STAGE_COLUMNS}
        rows={d.stages}
        rowKey={(r) => r.stageId}
        empty={<EmptyState title={props.neverProjected ? "Not projected yet" : "No stage visits in this window"} />}
      />
    </Card>
  );
}

function HeatmapCard({ data }: { data: Heatmap }) {
  const max = Math.max(0, ...data.stages.flatMap((st) => st.cells.map((c) => c.waitMs)));
  return (
    <Card
      title="Wait by stage and period"
      caption={<span className={v.dim}>The {plural(data.stages.length, "stage")} with the most wait, by {data.bucket}. Darker cells waited longer; each cell shows its visits and median duration.</span>}
    >
      {data.stages.length === 0 || data.periods.length === 0 ? (
        <EmptyState title="No stage visits in this window" />
      ) : (
        <div className={s.heatWrap}>
          <table className={s.heat}>
            <caption className={v.dim}>Wait by stage and period, {data.bucket}s starting in UTC</caption>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                {data.periods.map((p) => <th key={p} scope="col">{fmtDay(p, p)}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.stages.map((st) => (
                <tr key={st.stageId}>
                  <th scope="row">{st.stageId}</th>
                  {cellsByPeriod(data.periods, st.cells).map(({ period, cell }) =>
                    cell == null ? (
                      <td key={period} className={s.none}>No visits</td>
                    ) : (
                      <td key={period} className={s[`l${waitLevel(cell.waitMs, max)}`]}>
                        <strong>{fmtDur(cell.waitMs)} wait</strong>
                        {plural(cell.visits, "visit")}, median {dur(cell.medianDurationMs)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type Period = Throughput["periods"][number];
const THROUGHPUT_COLUMNS: Array<Column<Period>> = [
  { key: "period", header: "Period starting", render: (p) => fmtDay(p.period, p.period) },
  { key: "started", header: "Started", align: "right", render: (p) => p.started },
  { key: "completed", header: "Completed", align: "right", render: (p) => p.completed },
  { key: "aborted", header: "Aborted", align: "right", render: (p) => p.aborted },
  { key: "denied", header: "Denied", align: "right", render: (p) => p.denied },
  { key: "rolledBack", header: "Rolled back", align: "right", render: (p) => p.rolledBack },
];

function ThroughputCard({ data }: { data: Throughput }) {
  return (
    <Card title="Throughput" caption={<span className={v.dim}>Instances started and ended, by {data.bucket}. Periods with no starts or ends are not listed.</span>}>
      <Table columns={THROUGHPUT_COLUMNS} rows={data.periods} rowKey={(p) => p.period} empty={<EmptyState title="No instances started or ended in this window" />} />
    </Card>
  );
}
