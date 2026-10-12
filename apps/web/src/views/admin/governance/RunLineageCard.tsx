/**
 * ADR-0050 — the headline lineage question for ONE run
 * (`GET /v1/lineage/runs/:runId`): where its inputs came from and what it
 * produced, one hop each way, per dispatch. Edges into projects the reader is
 * not a member of are counted, never shown.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { UUID_RE } from "../../../api/format";
import { Badge, Button, Card, Field, Input, Table } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import { withRefusalCopy } from "./refusalCopy";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface LineageNodeLite {
  id: string;
  kind: "source" | "run" | "output";
  subtype: string;
  label: string;
  version: number | null;
  contentRecorded: boolean;
}

interface RunLineage {
  runId: string;
  dispatches: Array<{
    node: LineageNodeLite & { refKey: string | null };
    suppliedInputs: LineageNodeLite[];
    producedOutputs: LineageNodeLite[];
    withheldEdges: number;
  }>;
  note: string;
}

const REFUSALS = { unknown_lineage_run: "No lineage is recorded for that run, or it is in a project you are not a member of." };

export function RunLineageCard(props: { runId: string | null; onRunId: (runId: string | null) => void }) {
  const [draft, setDraft] = useState(props.runId ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [lastProp, setLastProp] = useState(props.runId);
  if (props.runId !== lastProp) {
    setLastProp(props.runId);
    setDraft(props.runId ?? "");
  }
  const ids = { hint: useId(), problem: useId() };
  const lineage = useQuery({
    queryKey: ["admin", "lineage-run", props.runId],
    enabled: Boolean(props.runId),
    retry: false,
    queryFn: () => withRefusalCopy(() => api.get<RunLineage>(`/v1/lineage/runs/${props.runId}`), REFUSALS),
  });
  const nodeCols = [
    { key: "kind", header: "Kind", render: (n: LineageNodeLite) => <Badge tone={n.kind === "output" ? "ok" : "neutral"}>{n.kind}</Badge> },
    { key: "subtype", header: "Subtype", render: (n: LineageNodeLite) => n.subtype },
    { key: "label", header: "What", render: (n: LineageNodeLite) => n.label },
    { key: "ver", header: "Version", render: (n: LineageNodeLite) => n.version ?? "—" },
  ];
  return (
    <Card title="One run's inputs and outputs">
      <form
        aria-label="Look up a run's lineage"
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const id = draft.trim();
          if (!UUID_RE.test(id)) {
            setProblem("That is not a run id.");
            return;
          }
          setProblem(null);
          props.onRunId(id);
        }}
      >
        <Field label="Run id" grow>
          <Input value={draft} aria-describedby={ids.hint} onChange={(e) => { setProblem(null); setDraft(e.target.value); }} placeholder="paste a run id" />
        </Field>
        <Button type="submit" variant="primary" aria-describedby={problem ? ids.problem : undefined}>
          Show lineage
        </Button>
      </form>
      <p className={v.faint} id={ids.hint}>
        Or choose “Inputs and outputs” on a run in a traversal above. One hop each way: what was supplied to the run and
        what it produced.
      </p>
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      {props.runId && (
        <QueryGate loading={lineage.isLoading} error={lineage.error} onRetry={() => void lineage.refetch()}>
          {lineage.data ? (
            <div className={v.stack} data-testid="run-lineage">
              {lineage.data.dispatches.map((d) => (
                <div key={d.node.id} className={v.stack}>
                  <div className={v.row}>
                    <strong>{d.node.label}</strong>
                    {d.node.refKey ? <code>{d.node.refKey}</code> : null}
                  </div>
                  {d.withheldEdges > 0 && (
                    <div className={a.effectBanner}>
                      <strong>{d.withheldEdges} edge(s) withheld.</strong> They lead to a project you are not a member of, so
                      neither the node nor its id is shown.
                    </div>
                  )}
                  <div className={v.sectionTitle}>Supplied inputs</div>
                  <Table rows={d.suppliedInputs} rowKey={(n) => n.id} columns={nodeCols} empty={<span className={v.faint}>No recorded input reached this run.</span>} />
                  <div className={v.sectionTitle}>Produced outputs</div>
                  <Table rows={d.producedOutputs} rowKey={(n) => n.id} columns={nodeCols} empty={<span className={v.faint}>No recorded output.</span>} />
                </div>
              ))}
              <p className={v.faint}>{lineage.data.note}</p>
            </div>
          ) : null}
        </QueryGate>
      )}
    </Card>
  );
}
