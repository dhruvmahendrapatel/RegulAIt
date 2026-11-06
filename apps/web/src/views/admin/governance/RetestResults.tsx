/**
 * ADR-0217: the automatic re-tests run after a model change, shown on the sign-off request they are evidence for.
 * Read-only: the decision stays in the Approvals Queue, and a re-test never signs anything off.
 */
import { ago } from "../../../api/format";
import { Badge, Table } from "../../../ui/kit";
import v from "../../views.module.css";

export interface Retest {
  id: string;
  kind: "eval" | "redteam";
  sourceName: string;
  status: "running" | "passed" | "failed_gate" | "reported" | "refused" | "skipped";
  reason: string | null;
  summary: { meanScore?: number | null; passRate?: number | null; asr?: number | null };
  createdAt: string;
  finishedAt: string | null;
}

const LABEL: Record<Retest["status"], string> = {
  running: "running",
  passed: "passed",
  failed_gate: "failed its gate",
  reported: "no verdict",
  refused: "refused",
  skipped: "skipped",
};
const TONE: Record<Retest["status"], "ok" | "danger" | "warn" | "info" | "neutral"> = {
  running: "info",
  passed: "ok",
  failed_gate: "danger",
  reported: "warn",
  refused: "warn",
  skipped: "neutral",
};

function figure(r: Retest): string {
  if (r.kind === "redteam" && typeof r.summary.asr === "number") return `attack success ${(r.summary.asr * 100).toFixed(1)}%`;
  if (typeof r.summary.passRate === "number") return `pass rate ${(r.summary.passRate * 100).toFixed(1)}%`;
  return "—";
}

/** a short count for the sign-off history row */
export function retestTally(rows: Retest[]): string {
  if (!rows.length) return "—";
  const failed = rows.filter((r) => r.status === "failed_gate").length;
  const passed = rows.filter((r) => r.status === "passed").length;
  const other = rows.length - failed - passed;
  return [passed && `${passed} passed`, failed && `${failed} failed`, other && `${other} other`].filter(Boolean).join(", ");
}

export function RetestResults({ title, rows }: { title: string; rows: Retest[] }) {
  if (!rows.length) return null;
  return (
    <div data-testid="mrm-retest-results">
      <div className={v.faint}>
        {title} A passing re-test is evidence for the person signing off; it does not sign anything off, and the model
        stays refused until they decide.
      </div>
      <Table
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          { key: "suite", header: "Suite", render: (r) => `${r.kind === "eval" ? "Evaluation" : "Red team"}: ${r.sourceName}` },
          { key: "result", header: "Result", render: (r) => <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge> },
          { key: "figure", header: "Measured", render: figure },
          { key: "detail", header: "Detail", render: (r) => r.reason ?? "—" },
          { key: "when", header: "Run", render: (r) => ago(r.finishedAt ?? r.createdAt) },
        ]}
      />
    </div>
  );
}
