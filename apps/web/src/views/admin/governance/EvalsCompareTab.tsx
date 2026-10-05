/**
 * Evaluations → Compare (ADR-0173 batch 2c, item 7).
 *
 * Any two runs of the SAME dataset version, side by side: what differed in the
 * measured configuration, the aggregate deltas, and every case. The server
 * refuses a pair across dataset versions or scoring semantics, and the page
 * shows that refusal as the answer rather than a table of meaningless deltas.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import { optionEls } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export interface CompareRunOption {
  id: string;
  datasetId: string;
  datasetName?: string | null;
  datasetVersion: number;
  agentName: string;
  model: string | null;
  trigger: string;
  status: string;
  startedAt: string;
}

interface RunSide {
  id: string;
  agentName: string;
  model: string | null;
  tier: number | null;
  configHash: string;
  judgeImpl: string | null;
  repetitions: number;
  trigger: string;
  meanScore: number | null;
  passRate: number | null;
  cases: number;
  gatePassed: boolean | null;
  scoreCi: { low: number; high: number; level: number } | null;
}
interface CompareResponse {
  datasetVersion: number;
  a: RunSide;
  b: RunSide;
  differs: Record<"model" | "tier" | "systemPrompt" | "configuration" | "judge", boolean>;
  delta: { meanScore: number | null; passRate: number | null };
  cases: Array<{
    caseId: string;
    input: string;
    a: { score: number; passed: boolean } | null;
    b: { score: number; passed: boolean } | null;
    delta: number | null;
    changed: boolean;
  }>;
  changedCases: number;
}

const signed = (n: number | null | undefined) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(3)}`);
const tone = (n: number | null) => (n == null ? "neutral" : n < 0 ? "danger" : n > 0 ? "ok" : "info");

function Refusal(props: { error: unknown }) {
  const e = props.error as { payload?: { error?: string; detail?: unknown }; message?: string };
  const detail = typeof e.payload?.detail === "string" ? e.payload.detail : e.message;
  return (
    <div className={v.errLine} role="alert" data-testid="compare-refusal">
      <strong>{e.payload?.error ?? "error"}</strong> — {detail ?? "the comparison was refused"}
    </div>
  );
}

export default function EvalsCompareTab(props: { runs: CompareRunOption[] }) {
  const [runA, setRunA] = useState("");
  const [runB, setRunB] = useState("");
  const [asked, setAsked] = useState<{ a: string; b: string } | null>(null);
  const cmp = useQuery({
    queryKey: ["admin", "eval-compare", asked?.a, asked?.b],
    enabled: Boolean(asked),
    retry: false,
    queryFn: () => api.get<CompareResponse>(`/v1/evals/compare?a=${asked!.a}&b=${asked!.b}`),
  });
  const label = (r: CompareRunOption) =>
    `${r.datasetName ?? "?"} v${r.datasetVersion} · ${r.agentName} · ${r.trigger} · ${ago(r.startedAt)}`;
  const options = props.runs.filter((r) => r.status === "completed").map((r) => ({ v: r.id, l: label(r) }));
  return (
    <Card title="Compare two runs">
      <div className={v.stack}>
        <p className={v.dim}>
          Pick two completed runs of the same dataset version. Runs across dataset versions or scoring semantics are
          refused: their cases are different questions, or their numbers mean different things.
        </p>
        <div className={a.formRow}>
          <Field label="Run A (before)" grow>
            <Select value={runA} onChange={(e) => setRunA(e.target.value)}>
              <option value="">Select…</option>
              {optionEls(options)}
            </Select>
          </Field>
          <Field label="Run B (after)" grow>
            <Select value={runB} onChange={(e) => setRunB(e.target.value)}>
              <option value="">Select…</option>
              {optionEls(options)}
            </Select>
          </Field>
          <Button variant="primary" disabled={!runA || !runB} onClick={() => setAsked({ a: runA, b: runB })}>
            Compare
          </Button>
        </div>
        {!asked ? (
          <EmptyState title="Nothing compared yet" body="Choose two runs to see what changed and which cases moved." />
        ) : cmp.isLoading ? (
          <p className={v.faint}>Comparing…</p>
        ) : cmp.error ? (
          <Refusal error={cmp.error} />
        ) : cmp.data ? (
          <div className={v.stack} data-testid="compare-result">
            <Table<{ field: string; a: string; b: string; differs: boolean }>
              rows={[
                { field: "Agent", a: cmp.data.a.agentName, b: cmp.data.b.agentName, differs: cmp.data.a.agentName !== cmp.data.b.agentName },
                { field: "Model", a: cmp.data.a.model ?? "—", b: cmp.data.b.model ?? "—", differs: cmp.data.differs.model },
                { field: "Tier", a: String(cmp.data.a.tier ?? "—"), b: String(cmp.data.b.tier ?? "—"), differs: cmp.data.differs.tier },
                {
                  field: "Configuration",
                  a: cmp.data.a.configHash.slice(0, 12),
                  b: cmp.data.b.configHash.slice(0, 12),
                  differs: cmp.data.differs.configuration,
                },
                { field: "Judge", a: cmp.data.a.judgeImpl ?? "—", b: cmp.data.b.judgeImpl ?? "—", differs: cmp.data.differs.judge },
                {
                  field: "Mean score",
                  a: (cmp.data.a.meanScore ?? 0).toFixed(3),
                  b: (cmp.data.b.meanScore ?? 0).toFixed(3),
                  differs: cmp.data.delta.meanScore !== 0,
                },
              ]}
              rowKey={(r) => r.field}
              columns={[
                { key: "f", header: "", render: (r) => r.field },
                { key: "a", header: "Run A", render: (r) => <code>{r.a}</code> },
                { key: "b", header: "Run B", render: (r) => <code>{r.b}</code> },
                {
                  key: "d",
                  header: "Changed",
                  render: (r) => (r.differs ? <Badge tone="warn">changed</Badge> : <span className={v.faint}>same</span>),
                },
              ]}
            />
            <p className={v.dim}>
              Mean score {signed(cmp.data.delta.meanScore)} · pass rate {signed(cmp.data.delta.passRate)} ·{" "}
              {cmp.data.changedCases} case(s) changed pass/fail
            </p>
            <Table
              rows={cmp.data.cases}
              rowKey={(r) => r.caseId}
              columns={[
                { key: "input", header: "Case", render: (r) => r.input.slice(0, 100) },
                { key: "a", header: "A", render: (r) => (r.a ? r.a.score.toFixed(3) : "—") },
                { key: "b", header: "B", render: (r) => (r.b ? r.b.score.toFixed(3) : "—") },
                { key: "d", header: "Δ", render: (r) => <Badge tone={tone(r.delta)}>{signed(r.delta)}</Badge> },
                {
                  key: "c",
                  header: "Pass/fail",
                  render: (r) => (r.changed ? <Badge tone="warn">flipped</Badge> : <span className={v.faint}>same</span>),
                },
              ]}
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
