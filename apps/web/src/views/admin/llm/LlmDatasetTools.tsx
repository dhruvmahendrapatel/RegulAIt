/**
 * ADR-0065 — three regulAIt-LLM controls the page lacked:
 *  - add rows to an EDITABLE dataset version (`POST /v1/llm/datasets/:id/rows`),
 *    scanned like the first upload, so a second upload cannot launder data;
 *  - a dry-run validation (`POST /v1/llm/datasets/:id/validate`): would this
 *    corpus train under this method, and roughly what would it cost? Nothing
 *    is written and no backend is contacted;
 *  - polling one running job on demand (`POST /v1/llm/jobs/:id/poll`), the
 *    manual door to the scheduler's sweep.
 */
import { useId, useState } from "react";
import { ApiError, api } from "../../../api/client";
import { Badge, Button, Field, Input, Select, Textarea } from "../../../ui/kit";
import { KV, OutcomePanel, optionEls, useAction, useApiAction } from "../adminKit";
import { LLM_REFUSALS, parseCorpusRows, rowsBodyProblem, validateBody, validationVerdict, type ValidateResponse } from "./llmDatasetModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface ScanFindings {
  pii?: Array<{ category: string; count: number }>;
  guardrails?: Array<{ detector: string; category: string; count: number }>;
}

/** counts only: the API never returns matched text */
function FindingCounts(props: { findings: unknown }) {
  const f = (props.findings ?? {}) as ScanFindings;
  const items = [...(f.pii ?? []).map((p) => `${p.category} ×${p.count}`), ...(f.guardrails ?? []).map((g) => `${g.detector}/${g.category} ×${g.count}`)];
  if (items.length === 0) return <span className={v.faint}>nothing fired</span>;
  return (
    <span>
      {items.map((i, n) => (
        <Badge key={`${n}-${i}`} tone="warn">
          {i}
        </Badge>
      ))}
    </span>
  );
}

function refusalLine(code: string | null) {
  return code && Object.hasOwn(LLM_REFUSALS, code) ? <p>{LLM_REFUSALS[code]}</p> : null;
}

export function AddRowsForm(props: { datasetId: string; label: string; onDone: () => void }) {
  const act = useApiAction();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const helpId = useId();
  const payload = act.outcome?.payload as { added?: number; scan?: { verdict?: string; findings?: unknown }; findings?: unknown } | null | undefined;
  return (
    <form
      className={v.stack}
      aria-label={`Add rows to ${props.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseCorpusRows(text);
        if ("error" in parsed) return setProblem(parsed.error);
        const tooLarge = rowsBodyProblem(parsed.rows);
        if (tooLarge) return setProblem(tooLarge);
        setProblem(null);
        void act.run(() => api.post(`/v1/llm/datasets/${props.datasetId}/rows`, { rows: parsed.rows }), `${parsed.rows.length} row(s) added after the ingest scan`).then((out) => {
          if (out) {
            setText("");
            props.onDone();
          }
        });
      }}
    >
      <Field label="Rows to add (JSON Lines)">
        <Textarea rows={4} value={text} aria-describedby={helpId} onChange={(e) => setText(e.target.value)} placeholder='{"input": "…", "output": "…"}' />
      </Field>
      <p id={helpId} className={v.faint}>
        One JSON object per line with an <code>input</code>, and optionally <code>output</code> and <code>tags</code>. The added rows are scanned at this
        version&apos;s mode before they are stored: a blocked scan adds nothing, and a flagged one marks the whole version flagged for good.
      </p>
      <div className={v.row}>
        <Button type="submit" disabled={act.busy || !text.trim()}>
          Scan and add rows
        </Button>
      </div>
      {problem && (
        <p className={v.errLine} role="alert">
          {problem}
        </p>
      )}
      <OutcomePanel outcome={act.outcome} testId="llm-add-rows-outcome">
        {act.outcome?.ok && payload?.scan && (
          <p>
            Added {payload.added ?? 0}. Scan: <Badge tone={payload.scan.verdict === "clean" ? "ok" : "warn"}>{payload.scan.verdict ?? "not reported"}</Badge>{" "}
            <FindingCounts findings={payload.scan.findings} />
          </p>
        )}
        {act.outcome && !act.outcome.ok && (
          <>
            {refusalLine(act.outcome.code)}
            {payload?.findings !== undefined && (
              <p>
                What fired: <FindingCounts findings={payload.findings} />
              </p>
            )}
          </>
        )}
      </OutcomePanel>
    </form>
  );
}

export function ValidateDatasetForm(props: {
  datasetId: string;
  backends: Array<{ kind: string; methods: string[] }>;
  methods: readonly string[];
  dials: Record<string, Array<{ key: string; label: string; def: string }>>;
}) {
  const act = useApiAction();
  // the person's choices; the effective values are derived on every render, so a
  // backend list that loads after mount (or changes) never leaves a stale choice
  const [chosenBackend, setBackend] = useState("");
  const [chosenMethod, setMethod] = useState("");
  const backend = props.backends.some((b) => b.kind === chosenBackend) ? chosenBackend : (props.backends[0]?.kind ?? "local");
  const offered = props.backends.find((b) => b.kind === backend)?.methods ?? [...props.methods];
  const method = offered.includes(chosenMethod) ? chosenMethod : (offered[0] ?? "");
  const [dials, setDials] = useState<Record<string, string>>({});
  const [price, setPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const dialList = props.dials[method] ?? [];
  const result = act.outcome?.ok ? (act.outcome.payload as unknown as ValidateResponse | null) : null;
  const verdict = result ? validationVerdict(result) : null;
  return (
    <form
      className={v.stack}
      aria-label="Validate this version"
      onSubmit={(e) => {
        e.preventDefault();
        const out = validateBody(
          { method, backend, dials, price },
          dialList.map((d) => d.key),
        );
        if ("error" in out) return setProblem(out.error);
        setProblem(null);
        void act.run(() => api.post<ValidateResponse>(`/v1/llm/datasets/${props.datasetId}/validate`, out.body), "Validation finished; nothing was written");
      }}
    >
      <div className={a.formRow}>
        <Field label="Validate for backend">
          <Select
            value={backend}
            onChange={(e) => {
              setBackend(e.target.value);
              const m = props.backends.find((b) => b.kind === e.target.value)?.methods ?? [];
              if (!m.includes(method)) setMethod(m[0] ?? "");
            }}
          >
            {optionEls(props.backends.map((b) => ({ v: b.kind, l: b.kind })))}
          </Select>
        </Field>
        <Field label="Validate for method">
          <Select value={method} onChange={(e) => (setMethod(e.target.value), setDials({}))}>
            {optionEls(offered.map((m) => ({ v: m, l: m })))}
          </Select>
        </Field>
        {dialList.map((d) => (
          <Field key={d.key} label={`${d.label} (default ${d.def})`}>
            <Input value={dials[d.key] ?? ""} placeholder={d.def} onChange={(e) => setDials({ ...dials, [d.key]: e.target.value })} />
          </Field>
        ))}
        <Field label="Vendor $/M training tokens (optional)">
          <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="unknown" />
        </Field>
        <Button type="submit" disabled={act.busy}>
          Validate
        </Button>
      </div>
      <p className={v.faint}>A dry run: no row is written, no job is created and no backend is contacted. An unknown price gives no estimate rather than a guess.</p>
      {problem && (
        <p className={v.errLine} role="alert">
          {problem}
        </p>
      )}
      {act.outcome && !act.outcome.ok && <OutcomePanel outcome={act.outcome}>{refusalLine(act.outcome.code)}</OutcomePanel>}
      {result && verdict && (
        <div aria-live="polite" data-testid="llm-validate-result" className={v.stackTight}>
          <p>
            <Badge tone={verdict.ok ? "ok" : "danger"}>{verdict.ok ? "would train" : "would not train"}</Badge> {result.validation.rowCount} rows,{" "}
            {result.validation.charCount} characters.
          </p>
          <KV
            rows={[
              ["Estimated cost", result.estimatedCostUsd == null ? "No estimate (price unknown)" : `$${result.estimatedCostUsd.toFixed(4)}`],
              ["Labels", result.validation.labels.length ? result.validation.labels.join(", ") : "None"],
              ["Split", result.validation.split ? `${result.validation.split.trainIdx.length} train / ${result.validation.split.evalIdx.length} held out` : "Not reported"],
            ]}
          />
          {verdict.problems.length > 0 && (
            <>
              <div className={v.sectionTitle}>Why it would not train</div>
              <ul>
                {verdict.problems.map((p, i) => (
                  <li key={`p-${i}`}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {result.validation.warnings.length > 0 && (
            <>
              <div className={v.sectionTitle}>Warnings</div>
              <ul>
                {result.validation.warnings.map((w, i) => (
                  <li key={`w-${i}`}>{w}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </form>
  );
}

export function PollJobButton(props: { jobId: string; jobName: string; onDone: () => void }) {
  const act = useAction();
  return (
    <span className={v.row}>
      <Button
        size="sm"
        variant="ghost"
        disabled={act.busy}
        aria-label={`Poll ${props.jobName} now`}
        onClick={() =>
          void act
            .run(async () => {
              try {
                const out = await api.post<{ job: { status: string; progress: number } }>(`/v1/llm/jobs/${props.jobId}/poll`);
                return `Polled ${props.jobName}: ${out.job.status}${out.job.status === "running" ? ` (${Math.round(out.job.progress * 100)}%)` : ""}`;
              } catch (e) {
                const code = e instanceof ApiError ? e.payload.error : undefined;
                if (typeof code === "string" && Object.hasOwn(LLM_REFUSALS, code)) throw new Error(LLM_REFUSALS[code]);
                throw e;
              }
            }, undefined)
            .then(() => props.onDone())
        }
      >
        Poll
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </span>
  );
}
