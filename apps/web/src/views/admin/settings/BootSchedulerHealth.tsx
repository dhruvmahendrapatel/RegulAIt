/**
 * Batch U4 — the two BOOT schedulers' health (`GET /v1/health/schedulers`,
 * ADR-0031 item 6): the audit-log retention prune and the backup verification
 * pass. They are separate from the governance sweeps below, and their health is
 * in memory, per gateway process, reset on restart. An empty list means neither
 * has ticked in this process (both ship off): absence of failures, not proof of
 * success, and the card says exactly that.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, humanize } from "../../../api/format";
import { Badge, Card, EmptyState, Table } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";

interface BootScheduler {
  name: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  healthy: boolean;
}

export function BootSchedulerHealth() {
  const q0 = useQuery({
    queryKey: ["admin", "health-schedulers"],
    queryFn: () => api.get<{ schedulers: BootScheduler[]; healthy: boolean; note: string }>("/v1/health/schedulers"),
  });
  // an answer without the list is read as "nothing reported", never as healthy
  const q = { ...q0, data: q0.data ? { ...q0.data, schedulers: q0.data.schedulers ?? [] } : undefined, refetch: q0.refetch };
  return (
    <Card title="Boot schedulers — retention prune and backup verification">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && (
          <div className={v.stack}>
            {q.data.schedulers.length === 0 ? (
              <EmptyState
                title="Neither boot scheduler has run in this gateway process"
                body="Both ship off. This is the absence of failures, not proof that anything succeeded."
              />
            ) : (
              <>
                <p role="status">
                  <Badge tone={q.data.healthy ? "ok" : "danger"}>{q.data.healthy ? "healthy" : "failing"}</Badge>{" "}
                  {q.data.healthy ? "The latest tick of each succeeded." : "At least one scheduler's latest tick failed."}
                </p>
                <Table<BootScheduler>
                  rows={q.data.schedulers}
                  rowKey={(s) => s.name}
                  columns={[
                    { key: "n", header: "Scheduler", render: (s) => humanize(s.name) },
                    { key: "h", header: "State", render: (s) => <Badge tone={s.healthy ? "ok" : "danger"}>{s.healthy ? "healthy" : `failing (${s.consecutiveFailures} in a row)`}</Badge> },
                    { key: "r", header: "Runs / failures", render: (s) => `${s.runs} / ${s.failures}` },
                    { key: "last", header: "Last run", render: (s) => (s.lastRunAt ? ago(s.lastRunAt) : "never") },
                    { key: "ok", header: "Last success", render: (s) => (s.lastSuccessAt ? ago(s.lastSuccessAt) : "never") },
                    { key: "err", header: "Last error", render: (s) => (s.lastError ? <span className={v.errLine}>{s.lastError}</span> : <span className={v.faint}>none</span>) },
                  ]}
                />
              </>
            )}
            <p className={v.faint}>{q.data.note}</p>
          </div>
        )}
      </QueryGate>
    </Card>
  );
}
