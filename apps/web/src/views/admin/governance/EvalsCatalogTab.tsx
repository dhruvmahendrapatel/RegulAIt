/**
 * Evaluations → Catalog (ADR-0173 batch 2c, item 7).
 *
 * One catalog over every scorer, guardrail detector, red-team class and
 * registered external scorer, each with the controls it is evidence for: NIST
 * AI RMF subcategories, ISO/IEC 42001 and EU AI Act pack controls, and OWASP
 * ids. The OWASP vocabulary is vendored data (promptfoo's MIT framework
 * tables), and the page says so with the pinned release beside it.
 *
 * Every row states what the evaluator CANNOT do next to what it does — the
 * same discipline as the scorer table.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Card, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, Stat, optionEls } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export interface CatalogEvaluator {
  id: string;
  kind: "scorer" | "detector" | "redteam_class" | "external_scorer";
  name: string;
  summary: string;
  limits: string;
  deterministic: boolean;
  runnableOn: string[];
  refs: { nistAiRmf: string[]; iso42001: string[]; euAiAct: string[]; owasp: string[] };
}
interface CatalogResponse {
  evaluators: CatalogEvaluator[];
  counts: { scorers: number; detectors: number; redteamClasses: number; externalScorers: number };
  owasp: {
    references: Array<{ id: string; list: string; name: string }>;
    source: { project: string; release: string; commit: string; licence: string };
  };
  note: string;
}

const KIND_LABEL: Record<CatalogEvaluator["kind"], string> = {
  scorer: "Scorer",
  detector: "Detector",
  redteam_class: "Red-team class",
  external_scorer: "External scorer",
};

function RefList(props: { refs: string[]; names?: Map<string, string> }) {
  if (props.refs.length === 0) return <span className={v.faint}>—</span>;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "var(--s1)" }}>
      {props.refs.map((r) => (
        <code key={r} title={props.names?.get(r)}>
          {r}
        </code>
      ))}
    </span>
  );
}

export default function EvalsCatalogTab() {
  const catalog = useQuery({
    queryKey: ["admin", "eval-catalog"],
    queryFn: () => api.get<CatalogResponse>("/v1/evals/catalog"),
  });
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const owaspNames = useMemo(
    () => new Map((catalog.data?.owasp.references ?? []).map((r) => [r.id, r.name])),
    [catalog.data],
  );
  const rows = (catalog.data?.evaluators ?? []).filter(
    (e) =>
      (!kind || e.kind === kind) &&
      (!q ||
        `${e.name} ${e.summary} ${[...e.refs.nistAiRmf, ...e.refs.iso42001, ...e.refs.euAiAct, ...e.refs.owasp].join(" ")}`
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  return (
    <QueryGate loading={catalog.isLoading} error={catalog.error} onRetry={() => void catalog.refetch()}>
      {catalog.data && (
        <Card title="Evaluator catalog — what each one measures, and which controls it evidences">
          <div className={v.stack}>
            <p className={v.dim}>{catalog.data.note}</p>
            <div className={a.statRow}>
              <Stat value={catalog.data.counts.scorers} label="Scorers" />
              <Stat value={catalog.data.counts.detectors} label="Guardrail detectors" />
              <Stat value={catalog.data.counts.redteamClasses} label="Red-team classes" />
              <Stat value={catalog.data.counts.externalScorers} label="External scorers" />
            </div>
            <div className={a.formRow}>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="">All kinds</option>
                  {optionEls(Object.entries(KIND_LABEL).map(([k, l]) => ({ v: k, l })))}
                </Select>
              </Field>
              <Field label="Search name or control" grow>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. MEASURE-2.7 or owasp:llm:01" />
              </Field>
            </div>
            <Table<CatalogEvaluator>
              rows={rows}
              rowKey={(r) => r.id}
              empty="No evaluator matches."
              columns={[
                {
                  key: "name",
                  header: "Evaluator",
                  render: (r) => (
                    <span>
                      <code>{r.id}</code>{" "}
                      <Badge tone={r.deterministic ? "ok" : "warn"}>{KIND_LABEL[r.kind]}</Badge>
                    </span>
                  ),
                },
                { key: "nist", header: "NIST AI RMF", render: (r) => <RefList refs={r.refs.nistAiRmf} /> },
                { key: "iso", header: "ISO/IEC 42001", render: (r) => <RefList refs={r.refs.iso42001} /> },
                { key: "eu", header: "EU AI Act", render: (r) => <RefList refs={r.refs.euAiAct} /> },
                { key: "owasp", header: "OWASP", render: (r) => <RefList refs={r.refs.owasp} names={owaspNames} /> },
                { key: "runs", header: "Runs on", render: (r) => <span className={v.dim}>{r.runnableOn.join(", ")}</span> },
                { key: "limits", header: "What it cannot do", render: (r) => <span className={v.faint}>{r.limits}</span> },
              ]}
            />
            <p className={v.faint} data-testid="owasp-attribution">
              OWASP ids and names: vendored from {catalog.data.owasp.source.project}'s framework mapping tables, release{" "}
              {catalog.data.owasp.source.release} (commit <code>{catalog.data.owasp.source.commit.slice(0, 12)}</code>,{" "}
              {catalog.data.owasp.source.licence} licence). The mapping of these evaluators onto the ids is regulAIt's own.
            </p>
          </div>
        </Card>
      )}
    </QueryGate>
  );
}
