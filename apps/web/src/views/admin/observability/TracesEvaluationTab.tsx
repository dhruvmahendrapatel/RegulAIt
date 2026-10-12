/**
 * The Traces page's "Evaluation" tab.
 *
 *  - ADR-0160 — content evaluation of model calls: the shipped detectors
 *    re-run over stored previews, summarised per agent, with the sweep a
 *    person can start (`GET /v1/governance/trace-evaluations`, `POST …/run`).
 *  - ADR-0173 — one deterministic scorer over chosen spans
 *    (`POST /v1/evals/traces/evaluate`); every result lands as a trace score,
 *    and every span it could not score says why.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, Button, Card, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
import { withRefusalCopy } from "../governance/refusalCopy";
import {
  DETERMINISTIC_TRACE_SCORERS,
  EMPTY_SCORER_FORM,
  TRACE_EVAL_DEFAULT_DAYS,
  TRACE_EVAL_WINDOWS,
  TRACE_SCORER_MAX_SPANS,
  TRACE_SCORER_REFUSALS,
  coverageText,
  detectorList,
  modelCallSpanIds,
  scorerBody,
  skipWords,
  sweepSentence,
  type AgentTraceSummary,
  type ScoredSpan,
  type ScorerForm,
  type ScorerRun,
  type TraceEvaluationSummary,
  type TraceScorerKind,
  type TraceSweepResult,
} from "./traceEvaluationModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function TracesEvaluationTab() {
  return (
    <div className={v.stack}>
      <ContentEvaluationCard />
      <TraceScorerCard />
    </div>
  );
}

function ContentEvaluationCard() {
  const [days, setDays] = useState(TRACE_EVAL_DEFAULT_DAYS);
  const act = useAction();
  const [sweep, setSweep] = useState<string | null>(null);
  const summary = useQuery({
    queryKey: ["admin", "trace-evaluations", days],
    queryFn: () => api.get<TraceEvaluationSummary>(`/v1/governance/trace-evaluations?days=${days}`),
  });
  // a gateway that answers without the summary shape is shown as not reported, never as zeros
  const s = summary.data?.totals ? summary.data : null;
  return (
    <Card
      title="Content evaluation of model calls"
      actions={
        <Button
          size="sm"
          disabled={act.busy}
          onClick={() =>
            void act.run(async () => {
              const out = await api.post<TraceSweepResult>("/v1/governance/trace-evaluations/run", {});
              const sentence = sweepSentence(out);
              setSweep(sentence);
              await summary.refetch();
              return sentence;
            })
          }
        >
          Evaluate new model calls now
        </Button>
      }
    >
      <div className={a.formRow}>
        <Field label="Window">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {TRACE_EVAL_WINDOWS.map((d) => (
              <option key={d} value={d}>
                Last {d} {d === 1 ? "day" : "days"}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {sweep && (
        <p role="status" className={v.dim}>
          {sweep}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <QueryGate loading={summary.isLoading} error={summary.error} onRetry={() => void summary.refetch()}>
        {s ? (
          <div className={v.stack} data-testid="trace-evaluation-summary">
            <div className={a.statRow}>
              <Stat value={s.totals.spans} label="model calls in the window" />
              <Stat value={s.totals.evaluated} label="evaluated" />
              <Stat value={<Badge tone={s.totals.flagged > 0 ? "danger" : "ok"}>{s.totals.flagged}</Badge>} label="flagged (content left the platform)" />
              <Stat value={s.totals.withheld} label="withheld (a block fired)" />
              <Stat value={s.totals.noContent} label="no content captured" />
            </div>
            <p className={v.faint}>
              Last evaluated: {s.lastEvaluatedAt ? ago(s.lastEvaluatedAt) : "never — run an evaluation before reading an empty table as clean"}
            </p>
            <Table<AgentTraceSummary>
              rows={s.agents ?? []}
              rowKey={(r) => r.agentId}
              empty={<span className={v.faint}>No evaluated model calls by any agent in this window.</span>}
              columns={[
                { key: "agent", header: "Agent", render: (r) => r.agentName ?? r.agentId, sort: (r) => r.agentName ?? r.agentId },
                { key: "spans", header: "Calls", render: (r) => r.spans, sort: (r) => r.spans },
                { key: "coverage", header: "Coverage", render: (r) => coverageText(r.coveragePct) },
                {
                  key: "flagged",
                  header: "Flagged",
                  render: (r) => <Badge tone={r.flagged > 0 ? "danger" : "ok"}>{r.flagged}</Badge>,
                  sort: (r) => r.flagged,
                },
                { key: "leaks", header: "Output hits", render: (r) => <span className={v.dim}>{detectorList(r.leaksByDetector)}</span> },
                { key: "attempts", header: "Input attempts", render: (r) => <span className={v.faint}>{detectorList(r.attemptsByDetector)}</span> },
              ]}
            />
            <p className={v.faint}>{s.notes?.method}</p>
            <p className={v.faint}>{s.notes?.leaks}</p>
            <p className={v.faint}>{s.notes?.coverage}</p>
          </div>
        ) : null}
      </QueryGate>
    </Card>
  );
}

interface TraceTreeLite {
  tree: Array<{ id: string; kind: string; children: unknown[] }>;
}

function TraceScorerCard() {
  const act = useAction();
  const [form, setForm] = useState<ScorerForm>(EMPTY_SCORER_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const [run, setRun] = useState<ScorerRun | null>(null);
  const [traceId, setTraceId] = useState("");
  const [loadNote, setLoadNote] = useState<string | null>(null);
  const ids = { intro: useId(), spans: useId(), config: useId(), problem: useId() };
  const set = <K extends keyof ScorerForm>(k: K, value: ScorerForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };

  return (
    <Card title="Score spans with a deterministic scorer">
      <p className={v.faint} id={ids.intro}>
        Runs one scorer that needs no model over the stored output previews of the spans you list. Nothing is sent to a
        model, and only what the trace already holds is read. Each result is recorded as a trace score.
      </p>
      <form
        aria-label="Load model-call spans from a trace"
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const id = traceId.trim();
          if (!id) return;
          setLoadNote(null);
          void act.run(async () => {
            const detail = await api.get<TraceTreeLite>(`/v1/traces/${encodeURIComponent(id)}`);
            const found = modelCallSpanIds(detail.tree);
            const existing = form.spanIds.trim();
            set("spanIds", [existing, ...found].filter(Boolean).join("\n"));
            setLoadNote(found.length ? `Added ${found.length} model-call span${found.length === 1 ? "" : "s"} from that trace.` : "That trace has no model-call spans to score.");
          }, null);
        }}
      >
        <Field label="Trace id (optional helper)" grow>
          <Input value={traceId} onChange={(e) => setTraceId(e.target.value)} placeholder="paste a trace id" />
        </Field>
        <Button type="submit" disabled={act.busy || !traceId.trim()}>
          Add its model-call spans
        </Button>
      </form>
      {loadNote && (
        <p role="status" className={v.faint}>
          {loadNote}
        </p>
      )}
      <form
        aria-label="Score trace spans"
        aria-describedby={ids.intro}
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          const built = scorerBody(form);
          if (!built.ok) {
            setProblem(built.problem);
            return;
          }
          setRun(null);
          void act.run(
            () =>
              withRefusalCopy(async () => {
                const out = await api.post<ScorerRun>("/v1/evals/traces/evaluate", built.body);
                setRun(out);
                return `${out.evaluated} scored, ${out.notEvaluated} not scored — recorded as '${out.scoreName}'`;
              }, TRACE_SCORER_REFUSALS),
          );
        }}
      >
        <div className={a.formRow}>
          <Field label="Scorer">
            <Select value={form.scorerKind} onChange={(e) => set("scorerKind", e.target.value as TraceScorerKind)}>
              {DETERMINISTIC_TRACE_SCORERS.map((k) => (
                <option key={k} value={k}>
                  {k.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Score name (optional)">
            <Input value={form.scoreName} onChange={(e) => set("scoreName", e.target.value)} placeholder={`evaluator.${form.scorerKind}`} />
          </Field>
        </div>
        <Field label="Span ids" grow>
          <Textarea rows={4} spellCheck={false} aria-describedby={ids.spans} value={form.spanIds} onChange={(e) => set("spanIds", e.target.value)} />
        </Field>
        <p className={v.faint} id={ids.spans}>
          One per line, or separated by commas. At most {TRACE_SCORER_MAX_SPANS} per run.
        </p>
        <Field label="Scorer configuration (JSON object)" grow>
          <Textarea rows={3} spellCheck={false} aria-describedby={ids.config} value={form.config} onChange={(e) => set("config", e.target.value)} style={{ fontFamily: "var(--font-mono, monospace)" }} />
        </Field>
        <p className={v.faint} id={ids.config}>
          The same configuration an evaluation case takes, for example needles for contains or a pattern for regex. A
          configuration that would pass every output is refused.
        </p>
        <Field label="Expected value (for scorers that compare against one)" grow>
          <Textarea rows={2} value={form.expected} onChange={(e) => set("expected", e.target.value)} />
        </Field>
        <label className={v.rowTight}>
          <input type="checkbox" checked={form.expectedIsJson} onChange={(e) => set("expectedIsJson", e.target.checked)} />
          <span>Read the expected value as JSON</span>
        </label>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
            Score spans
          </Button>
        </div>
        {problem && (
          <p className={v.errLine} role="alert" id={ids.problem}>
            {problem}
          </p>
        )}
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
      </form>
      <div aria-live="polite" data-testid="trace-scorer-results">
        {run && (
          <div className={v.stack}>
            <div className={v.row}>
              <Badge tone="info">{run.evaluated} scored</Badge>
              <Badge tone={run.notEvaluated ? "warn" : "neutral"}>{run.notEvaluated} not scored</Badge>
              <span className={v.faint}>recorded as {run.scoreName}</span>
            </div>
            <Table<ScoredSpan>
              rows={run.results}
              rowKey={(r) => `${r.spanId}:${r.outcome}:${r.outcome === "not_evaluated" ? r.reason : r.traceScoreId}`}
              columns={[
                { key: "span", header: "Span", render: (r) => <code>{r.spanId}</code> },
                {
                  key: "outcome",
                  header: "Result",
                  render: (r) =>
                    r.outcome === "evaluated" ? (
                      <Badge tone={r.passed ? "ok" : "danger"}>
                        {r.passed ? "pass" : "fail"} · {r.score.toFixed(2)}
                      </Badge>
                    ) : (
                      <span className={v.dim}>not scored: {skipWords(r.reason)}</span>
                    ),
                },
              ]}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
