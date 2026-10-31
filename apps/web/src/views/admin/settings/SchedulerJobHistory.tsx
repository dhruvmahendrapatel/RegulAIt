/**
 * ADR-0064 — one scheduler job's full run ledger
 * (`GET /v1/scheduler/jobs/:name/runs`): every recorded pass, newest first,
 * with what it processed and how it ended. The status card shows only the
 * last few; this answers "and what did it do last month?".
 */
import { fmtAt } from "../../../api/format";
import { Badge, type Tone } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import v from "../../views.module.css";

interface JobRun {
  id: string;
  trigger: string;
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string;
  itemsProcessed: number;
  error: string | null;
}

const tone = (outcome: string): Tone =>
  outcome === "ok" ? "ok" : outcome === "failed" ? "danger" : outcome === "skipped" ? "warn" : "info";

export function SchedulerJobHistory(props: { name: string }) {
  const name = encodeURIComponent(props.name);
  return (
    <div className={v.stack} data-testid={`scheduler-history-${props.name}`}>
      <DataList<JobRun>
        listId="scheduler-runs"
        noun={`runs of ${props.name}`}
        endpoint={`/v1/scheduler/jobs/${name}/runs`}
        exportPath={`/v1/scheduler/jobs/${name}/runs/export.xlsx`}
        queryKey={["admin", "scheduler-job-runs", props.name, "list"]}
        legacyKey="runs"
        count="estimate"
        defaultSort={{ key: "started", dir: "desc" }}
        rowKey={(r) => r.id}
        empty={<span className={v.faint}>This job has no recorded runs.</span>}
        columns={[
          { key: "started", header: "Started", main: true, sortable: true, render: (r) => fmtAt(r.startedAt) },
          { key: "outcome", header: "Outcome", main: true, sortable: true, required: "The outcome is always shown", render: (r) => <Badge tone={tone(r.outcome)}>{r.outcome}</Badge> },
          { key: "trigger", header: "Trigger", main: true, sortable: true, render: (r) => r.trigger },
          { key: "items", header: "Items", main: true, sortable: true, render: (r) => r.itemsProcessed },
          { key: "ms", header: "Duration", main: true, sortable: true, render: (r) => (r.durationMs === null ? "—" : `${r.durationMs}ms`) },
          { key: "instance", header: "Ran on", main: true, sortable: true, render: (r) => <code>{r.instanceId}</code> },
          { key: "err", header: "Error", main: true, sortable: true, required: "A failed run's error is always shown", render: (r) => r.error ?? <span className={v.faint}>—</span> },
        ]}
      />
    </div>
  );
}
