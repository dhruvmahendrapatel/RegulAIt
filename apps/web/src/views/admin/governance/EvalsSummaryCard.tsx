/**
 * ADR-0044 — the drift view the Evaluations page opens on
 * (`GET /v1/evals/summary`): over the latest 200 runs, how many regressed, how
 * many failed their gate, what they cost, and the 25 most recent — who ran
 * what, against which baseline delta. The drift sweep (`POST /v1/evals/drift-sweep`)
 * re-runs every pinned baseline and spends model budget, so it is confirmed first.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, Table } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export interface EvalsSummaryRun {
  id: string;
  agentName: string;
  model: string | null;
  trigger: string;
  meanScore: number | null;
  passRate: number | null;
  scoreDelta: number | null;
  gatePassed: boolean | null;
  regression: boolean | null;
  isBaseline: boolean;
  startedAt: string;
  by: string | null;
}

export interface EvalsSummary {
  runs: number;
  regressions: number;
  failed: number;
  totalCostUsd: number;
  recent: EvalsSummaryRun[];
}

interface DriftSweepResult {
  ran: Array<{ datasetId: string; agentId: string; runId: string; regression: boolean; scoreDelta: number | null; trigger: string }>;
  skipped: Array<{ datasetId: string; agentId: string | null; reason: string }>;
  note: string;
}

export const driftSweepSentence = (r: Pick<DriftSweepResult, "ran" | "skipped">): string => {
  const regressed = r.ran.filter((x) => x.regression).length;
  if (r.ran.length === 0 && r.skipped.length === 0) return "No pinned baselines to re-run.";
  return `${r.ran.length} pinned ${r.ran.length === 1 ? "baseline" : "baselines"} re-run, ${regressed} regressed${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}.`;
};

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(3)}`);

export function EvalsSummaryCard(props: { onOpenRun?: (runId: string) => void }) {
  const act = useAction();
  const [confirm, setConfirm] = useState(false);
  const [sweep, setSweep] = useState<DriftSweepResult | null>(null);
  const summary = useQuery({ queryKey: ["admin", "eval-summary"], queryFn: () => api.get<EvalsSummary>("/v1/evals/summary") });
  const s = summary.data;
  return (
    <Card
      title="Drift — recent runs across every dataset"
      actions={
        <Button size="sm" disabled={act.busy} onClick={() => setConfirm(true)}>
          Re-run pinned baselines…
        </Button>
      }
    >
      <QueryGate loading={summary.isLoading} error={summary.error} onRetry={() => void summary.refetch()}>
        {s ? (
          <div className={v.stack} data-testid="evals-summary">
            <div className={a.statRow}>
              <Stat value={s.runs} label="runs (latest 200)" />
              <Stat value={<Badge tone={s.regressions > 0 ? "danger" : "ok"}>{s.regressions}</Badge>} label="regressed against baseline" />
              <Stat value={<Badge tone={s.failed > 0 ? "warn" : "ok"}>{s.failed}</Badge>} label="failed their gate" />
              <Stat value={fmtUsd(s.totalCostUsd)} label="spend on these runs" />
            </div>
            <Table<EvalsSummaryRun>
              rows={s.recent}
              rowKey={(r) => r.id}
              onRowClick={props.onOpenRun ? (r) => props.onOpenRun?.(r.id) : undefined}
              rowLabel={(r) => `Open the ${r.agentName} run from ${ago(r.startedAt)}`}
              empty={<span className={v.faint}>No evaluation has run yet, so there is nothing to compare.</span>}
              columns={[
                { key: "agent", header: "Agent", render: (r) => r.agentName },
                { key: "trigger", header: "Trigger", render: (r) => <Badge tone="info">{r.trigger.replaceAll("_", " ")}</Badge> },
                { key: "score", header: "Mean score", render: (r) => (r.meanScore === null ? "—" : r.meanScore.toFixed(3)) },
                { key: "pass", header: "Pass rate", render: (r) => pct(r.passRate) },
                { key: "delta", header: "Δ vs baseline", render: (r) => signed(r.scoreDelta) },
                {
                  key: "verdict",
                  header: "Verdict",
                  render: (r) =>
                    r.isBaseline ? (
                      <Badge tone="primary">baseline</Badge>
                    ) : r.regression ? (
                      <Badge tone="danger">regression</Badge>
                    ) : r.gatePassed === false ? (
                      <Badge tone="warn">gate failed</Badge>
                    ) : r.gatePassed ? (
                      <Badge tone="ok">passed</Badge>
                    ) : (
                      <span className={v.faint}>no gate</span>
                    ),
                },
                { key: "by", header: "Run by", render: (r) => r.by ?? <span className={v.faint}>scheduler</span> },
                { key: "when", header: "Started", render: (r) => ago(r.startedAt), sort: (r) => r.startedAt },
              ]}
            />
          </div>
        ) : null}
      </QueryGate>
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <div aria-live="polite">
        {sweep && (
          <div className={v.stackTight} data-testid="drift-sweep">
            <p className={v.dim}>{driftSweepSentence(sweep)}</p>
            {sweep.skipped.map((x) => (
              <p key={`${x.datasetId}:${x.agentId ?? "none"}`} className={v.faint}>
                Skipped: {x.reason}
              </p>
            ))}
            <p className={v.faint}>{sweep.note}</p>
          </div>
        )}
      </div>
      <ConfirmModal
        open={confirm}
        title="Re-run every pinned baseline now?"
        confirmLabel="Re-run baselines"
        body={
          <p>
            Each pinned dataset and agent pair runs again as the person who pinned it, through the same governed path as
            any evaluation. It spends model budget, charged to that person's runs. A pair whose pinner is gone is skipped
            and said so.
          </p>
        }
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void act.run(async () => {
            const out = await api.post<DriftSweepResult>("/v1/evals/drift-sweep", {});
            setSweep(out);
            await summary.refetch();
            return driftSweepSentence(out);
          });
        }}
      />
    </Card>
  );
}
