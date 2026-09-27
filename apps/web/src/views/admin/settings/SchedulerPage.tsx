/**
 * Scheduled jobs (ADR-0064).
 *
 * This page exists because six ADRs each shipped a schedule and then disclosed
 * that nothing drove it. The gap was documented in six places and visible in
 * none of them, and the shape of the failure was always the same: a screen full
 * of null timestamps that looks exactly like a screen full of "nothing was due".
 *
 * So the page leads with the one fact that decides everything else — IS THE
 * SCHEDULER ON — and says it as an alarm when it is not. Then, per job: when it
 * last ran, what it did, when it is next due, and its last error. That is the
 * "did the MRM sweep run last night, and what did it do?" question, rendered.
 *
 * Two honesty rules the UI keeps rather than leaving to the ADR:
 *
 *  - "Next due" renders as em-dash, never as a future timestamp, when the
 *    scheduler is off or the job is disabled. A time nothing will act on is a
 *    lie with a clock on it.
 *  - The page states, in the UI, that these jobs buy TIMELINESS and not
 *    enforcement — MRM still refuses a lapsed card at dispatch, SLA breach is
 *    still caught on read — so nobody reads a red row here as "we were
 *    unprotected".
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Table } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface SchedulerRun {
  id: string;
  jobName: string;
  trigger: string;
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  outcome: string;
  itemsProcessed: number;
  error: string | null;
  detail?: Record<string, unknown>;
}

interface SchedulerJob {
  name: string;
  description: string;
  adr: string | null;
  enabled: boolean;
  intervalSeconds: number;
  nextDueAt: string;
  effectiveNextDueAt: string | null;
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastOutcome: string | null;
  lastError: string | null;
  lastItemsProcessed: number | null;
  lastDurationMs: number | null;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  registered: boolean;
  recentRuns: SchedulerRun[];
}

interface SchedulerStatus {
  enabled: boolean;
  posture: string;
  tickMs: number;
  leaseSeconds: number;
  instanceId: string | null;
  jobs: SchedulerJob[];
  stuckRuns: SchedulerRun[];
  note: string;
}

function cadence(seconds: number): string {
  if (seconds % 86400 === 0) return `every ${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

function outcomeTone(outcome: string | null): "ok" | "danger" | "warn" | "info" {
  if (outcome === "ok") return "ok";
  if (outcome === "failed") return "danger";
  if (outcome === "skipped") return "warn";
  return "info";
}

export default function SchedulerPage() {
  const act = useAction();
  const status = useQuery({
    queryKey: ["admin", "scheduler"],
    queryFn: () => api.get<SchedulerStatus>("/v1/scheduler"),
  });

  const s = status.data;
  const jobs = s?.jobs ?? [];
  const failing = jobs.filter((j) => j.lastOutcome === "failed").length;
  const neverRun = jobs.filter((j) => j.lastRunAt === null).length;

  const toggle = (job: SchedulerJob) =>
    void act.run(async () => {
      await api.patch(`/v1/scheduler/jobs/${encodeURIComponent(job.name)}`, { enabled: !job.enabled });
      await status.refetch();
    }, job.enabled ? `${job.name} disabled` : `${job.name} enabled`);

  const runNow = (job: SchedulerJob) =>
    void act.run(async () => {
      const out = await api.post<{ outcome: string; error?: string }>(
        `/v1/scheduler/jobs/${encodeURIComponent(job.name)}/run`,
      );
      await status.refetch();
      if (out.outcome === "failed") throw new Error(out.error ?? "the job failed — see its run history");
    }, `${job.name} ran`);

  return (
    <>
      <PageHeader
        title="Scheduled jobs"
        sub="Six governance sweeps on an in-process timer. Timeliness, never enforcement."
        info={<p>Six governance sweeps — model-card expiry, approval SLA, report generation, spend anomalies, eval drift and red-team runs — run on an in-process timer with a database lock, so a BYOC or air-gapped install needs no external cron. They buy TIMELINESS, never enforcement: model-card expiry is still recomputed at dispatch and an SLA breach is still caught when the queue is read, whether or not any of this has run.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={status.isLoading} error={status.error} onRetry={() => void status.refetch()}>
          <Card title="This deployment">
            <div className={a.statRow}>
              <Stat
                value={<Badge tone={s?.enabled ? "ok" : "danger"}>{s?.enabled ? "running" : "OFF"}</Badge>}
                label="scheduler"
              />
              <Stat value={jobs.length} label="registered jobs" />
              <Stat
                value={<Badge tone={failing > 0 ? "danger" : "ok"}>{failing}</Badge>}
                label="jobs whose last pass failed"
              />
              <Stat
                value={<Badge tone={neverRun > 0 ? "warn" : "ok"}>{neverRun}</Badge>}
                label="jobs that have never run"
              />
            </div>

            {s && !s.enabled && (
              <EmptyState
                title="The scheduler is off, so none of these sweeps run on their own"
                body={
                  "This is the default, in every environment, on purpose: a background loop that mutates governed " +
                  "state is an operator's decision. Set REGULAIT_SCHEDULER=on to start it, or keep driving each " +
                  "sweep's own endpoint from your own cron — both call exactly the same function. Nothing is " +
                  "unenforced either way; what you lose is timeliness."
                }
              />
            )}

            {(s?.stuckRuns ?? []).length > 0 && (
              <EmptyState
                title={`${s?.stuckRuns.length} run(s) never finished`}
                body="A run still marked 'running' past its lease is a gateway process that died mid-pass. Its lease has expired and the job is claimable again, but the pass it was doing did not complete."
              />
            )}

            <div className={v.faint}>{s?.posture}</div>
            <div className={v.faint}>{s?.note}</div>
          </Card>

          {jobs.length === 0 ? (
            <Card title="Jobs">
              <EmptyState title="No jobs registered" body="This gateway registered no scheduler jobs." />
            </Card>
          ) : (
            jobs.map((job) => (
              <Card key={job.name} title={job.name}>
                <div className={v.faint}>{job.description}</div>
                <div className={a.statRow}>
                  <Stat
                    value={<Badge tone={job.enabled ? "ok" : "warn"}>{job.enabled ? "enabled" : "disabled"}</Badge>}
                    label={job.adr ?? "job"}
                  />
                  <Stat value={cadence(job.intervalSeconds)} label="cadence" />
                  <Stat
                    value={
                      job.lastOutcome ? (
                        <Badge tone={outcomeTone(job.lastOutcome)}>{job.lastOutcome}</Badge>
                      ) : (
                        <span className={v.faint}>never run</span>
                      )
                    }
                    label="last outcome"
                  />
                  <Stat
                    value={job.lastRunAt ?? <span className={v.faint}>—</span>}
                    label="last run"
                  />
                  <Stat
                    value={
                      // never render a future time nothing will act on
                      job.effectiveNextDueAt ?? <span className={v.faint}>— (not scheduled)</span>
                    }
                    label="next due"
                  />
                  <Stat
                    value={job.lastItemsProcessed ?? <span className={v.faint}>—</span>}
                    label="items last pass"
                  />
                </div>

                {!job.registered && (
                  <EmptyState
                    title="This job is in the database but not in this gateway's code"
                    body="Its history is kept rather than deleted — it is the evidence that it used to run — but nothing will claim it."
                  />
                )}
                {job.consecutiveFailures > 0 && (
                  <EmptyState
                    title={`${job.consecutiveFailures} consecutive failure(s)`}
                    body={job.lastError ?? "no error recorded"}
                  />
                )}

                <div className={a.formRow}>
                  <Button size="sm" onClick={() => runNow(job)} disabled={act.busy || job.running}>
                    Run now
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggle(job)} disabled={act.busy}>
                    {job.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>

                {job.recentRuns.length === 0 ? (
                  <div className={v.faint}>No recorded runs.</div>
                ) : (
                  <Table
                    rows={job.recentRuns}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: "started", header: "Started", render: (r) => r.startedAt },
                      {
                        key: "outcome",
                        header: "Outcome",
                        render: (r) => <Badge tone={outcomeTone(r.outcome)}>{r.outcome}</Badge>,
                      },
                      { key: "trigger", header: "Trigger", render: (r) => <Badge tone="info">{r.trigger}</Badge> },
                      { key: "items", header: "Items", render: (r) => r.itemsProcessed },
                      {
                        key: "ms",
                        header: "Duration",
                        render: (r) => (r.durationMs === null ? <span className={v.faint}>—</span> : `${r.durationMs}ms`),
                      },
                      {
                        key: "err",
                        header: "Error",
                        render: (r) => r.error ?? <span className={v.faint}>—</span>,
                      },
                    ]}
                  />
                )}
              </Card>
            ))
          )}
          {act.error && <div className={v.faint}>{act.error}</div>}
        </QueryGate>
      </div>
    </>
  );
}
