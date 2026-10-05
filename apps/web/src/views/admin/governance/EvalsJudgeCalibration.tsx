/**
 * Evaluations → run detail → Judge calibration (ADR-0173 batch 2c; ADR-0177
 * clean-room item 8).
 *
 * How far each judge agrees with the human labels annotation reviewers gave
 * the same cases, as Cohen's kappa. Below 20 completed paired labels the card
 * says "insufficient" and shows no number. OBSERVE-ONLY: the card says so, and
 * nothing it does changes the run's gate.
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import { Badge, Button, Card, Table } from "../../../ui/kit";
import v from "../../views.module.css";

interface KappaReport {
  status: "reported" | "insufficient";
  pairs: number;
  required: number;
  kappa: number | null;
  agreement: number | null;
  interval: { low: number; high: number; level: number } | null;
  note: string;
}
interface CalibrationResponse {
  judgedResults: number;
  labelledResults: number;
  judges: Array<{ judge: string; weight: number | null; report: KappaReport }>;
  combined: KappaReport;
  gate: { gatePassed: boolean | null };
  note: string;
}

function KappaCell(props: { r: KappaReport }) {
  if (props.r.status === "insufficient") {
    return (
      <Badge tone="neutral" title={props.r.note}>
        insufficient ({props.r.pairs} / {props.r.required})
      </Badge>
    );
  }
  if (props.r.kappa === null) return <Badge tone="neutral">undefined</Badge>;
  const k = props.r.kappa;
  return (
    <span>
      <Badge tone={k >= 0.6 ? "ok" : k >= 0.2 ? "warn" : "danger"}>κ {k.toFixed(2)}</Badge>{" "}
      {props.r.interval ? (
        <span className={v.faint}>
          {Math.round(props.r.interval.level * 100)}% CI {props.r.interval.low.toFixed(2)} to {props.r.interval.high.toFixed(2)}
        </span>
      ) : null}
    </span>
  );
}

export default function EvalsJudgeCalibration(props: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.post<CalibrationResponse>(`/v1/evals/runs/${props.runId}/calibration`, {}));
    } catch (e) {
      const err = e as ApiError;
      setData(null);
      setError(
        err instanceof ApiError && err.status === 503
          ? "No annotation labels are available to this deployment yet, so there is nothing to calibrate against."
          : err instanceof ApiError && typeof err.payload.detail === "string"
            ? err.payload.detail
            : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const rows = data ? [...data.judges.map((j) => ({ ...j, combined: false })), { judge: "Combined (panel)", weight: null, report: data.combined, combined: true }] : [];
  return (
    <Card title="Judge calibration — agreement with human labels">
      <div className={v.stack} data-testid="judge-calibration">
        <p className={v.dim}>
          Cohen's kappa between each judge's pass/fail and the labels annotation reviewers gave the same cases. It is
          reported from 20 completed paired labels; below that it says "insufficient". Observe-only: calibration never
          changes this run's gate, its scores or any stored verdict.
        </p>
        <div className={v.row}>
          <Button size="sm" disabled={busy} onClick={() => void run()}>
            {data ? "Recalculate" : "Calculate agreement"}
          </Button>
        </div>
        {error ? (
          <p className={v.faint} role="status">
            {error}
          </p>
        ) : null}
        {data ? (
          <>
            <p className={v.faint}>
              {data.labelledResults} of {data.judgedResults} judged case(s) carry a completed human label.
            </p>
            <Table
              rows={rows}
              rowKey={(r) => r.judge}
              columns={[
                { key: "judge", header: "Judge", render: (r) => (r.combined ? <strong>{r.judge}</strong> : <code>{r.judge}</code>) },
                { key: "weight", header: "Weight", render: (r) => (r.weight == null ? "—" : r.weight) },
                { key: "pairs", header: "Paired labels", render: (r) => r.report.pairs },
                { key: "kappa", header: "Agreement", render: (r) => <KappaCell r={r.report} /> },
              ]}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}
