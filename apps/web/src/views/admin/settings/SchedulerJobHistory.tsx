/**
 * ADR-0064 — one scheduler job's full run ledger
 * (`GET /v1/scheduler/jobs/:name/runs`): every recorded pass, newest first,
 * with what it processed and how it ended. The status card shows only the
 * last few; this answers "and what did it do last month?".
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import { Badge, Field, Select, Table, type Tone } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import a from "../admin.module.css";
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

export const HISTORY_LIMITS = [50, 100, 200] as const;

export function SchedulerJobHistory(props: { name: string }) {
  const [limit, setLimit] = useState<number>(50);
  const runs = useQuery({
    queryKey: ["admin", "scheduler-job-runs", props.name, limit],
    queryFn: () =>
      api.get<{ runs: JobRun[]; registered: boolean }>(`/v1/scheduler/jobs/${encodeURIComponent(props.name)}/runs?limit=${limit}`),
  });
  return (
    <div className={v.stack} data-testid={`scheduler-history-${props.name}`}>
      <div className={a.formRow}>
        <Field label={`Runs to show for ${props.name}`}>
          <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {HISTORY_LIMITS.map((n) => (
              <option key={n} value={n}>
                Latest {n}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <QueryGate loading={runs.isLoading} error={runs.error} onRetry={() => void runs.refetch()}>
        <Table<JobRun>
          rows={runs.data?.runs ?? []}
          rowKey={(r) => r.id}
          empty={<span className={v.faint}>This job has no recorded runs.</span>}
          columns={[
            { key: "started", header: "Started", render: (r) => fmtAt(r.startedAt), sort: (r) => r.startedAt },
            { key: "outcome", header: "Outcome", render: (r) => <Badge tone={tone(r.outcome)}>{r.outcome}</Badge> },
            { key: "trigger", header: "Trigger", render: (r) => r.trigger },
            { key: "items", header: "Items", render: (r) => r.itemsProcessed },
            { key: "ms", header: "Duration", render: (r) => (r.durationMs === null ? "—" : `${r.durationMs}ms`) },
            { key: "instance", header: "Ran on", render: (r) => <code>{r.instanceId}</code> },
            { key: "err", header: "Error", render: (r) => r.error ?? <span className={v.faint}>—</span> },
          ]}
        />
        {(runs.data?.runs.length ?? 0) >= limit ? (
          <p className={v.faint}>Showing the latest {limit}. Older runs are kept; choose a larger number to see more.</p>
        ) : null}
      </QueryGate>
    </div>
  );
}
