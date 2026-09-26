/**
 * Evaluations (ADR-0044).
 *
 * The screen where the quality gate is authored, run, and argued with. Four
 * things it exists to keep honest, rendered rather than merely documented:
 *
 *  - **A frozen dataset says so.** The moment a run scores against a version,
 *    that version is immutable and the case editor is replaced by a "mint the
 *    next version" action. A gate result is meaningless if the ruler can move
 *    underneath it, so the UI makes the freeze visible rather than surfacing a
 *    409 after someone has typed a case.
 *  - **Every scorer states what it CANNOT do.** The `limits` string comes
 *    straight from the scorer's own definition, next to where a person picks
 *    it — including the judge's blunt "non-deterministic and not free".
 *  - **The regression is shown per case, not just in aggregate.** A red gate
 *    that only reports "0.72 vs 0.81" is un-actionable; the diff table names
 *    the cases that moved and by how much.
 *  - **The baseline is a deliberate act.** Pinning a run as the baseline
 *    changes what every future gate is measured against, so it is a button
 *    with a consequence spelled out, and it lands in the audit log.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import {
  QueryGate,
  Stat,
  agentOpts,
  optionEls,
  projectOpts,
  useAction,
  useAgents,
  useProjects,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface ScorerInfo {
  id: string;
  deterministic: boolean;
  modelBacked: boolean;
  summary: string;
  limits: string;
}
/** ADR-0088 — the registered external instruments, listed WITH the disclosure */
interface ExternalScorerListing {
  scorers: Array<{ name: string; scorerKinds: string[]; enabled: boolean; lastTestedAt: string | null }>;
  disclosure: string;
  note: string;
}
interface DatasetRow {
  id: string;
  name: string;
  version: number;
  note: string | null;
  scorerKind: string;
  scorerConfig: Record<string, unknown>;
  caseCount: number;
  runCount: number;
  frozen: boolean;
  createdAt: string;
}
interface CaseRow {
  id: string;
  input: string;
  expected: unknown;
  /** ADR-0067 — the retrieved/reference context this case is scored against */
  context?: string[];
  contextInPrompt?: boolean;
  scorerKind: string | null;
  tags: string[];
}
interface RunRow {
  id: string;
  datasetId: string;
  datasetName?: string | null;
  datasetVersion: number;
  agentName: string;
  model: string | null;
  trigger: string;
  status: string;
  cases: number;
  passedCases: number;
  meanScore: number | null;
  passRate: number | null;
  scoreDelta: number | null;
  gatePassed: boolean | null;
  regression: boolean | null;
  gateReason: string | null;
  isBaseline: boolean;
  costUsd: number;
  judgeImpl: string | null;
  startedAt: string;
}
interface DiffRow {
  caseId: string | null;
  input: string | null;
  score: number;
  baselineScore: number | null;
  delta: number | null;
  passed: boolean;
  baselinePassed: boolean | null;
  regressed: boolean;
}
interface ResultRow {
  id: string;
  caseId: string | null;
  scorerKind: string;
  score: number;
  passed: boolean;
  latencyMs: number | null;
  costUsd: number | null;
  outputText: string | null;
  judgeRationale: string | null;
  error: string | null;
  input: string | null;
  /** the row's stored evidence — `detail.method` is the provenance stamp
   * (lexical algorithm name / 'model-judged' / 'external:<name>', ADR-0088) */
  detail?: Record<string, unknown>;
}

/** ADR-0072's `GET /v1/evals/scoring-semantics` */
interface StrandedBaseline {
  runId: string;
  agentId: string;
  agentName: string;
  datasetId: string;
  datasetName: string | null;
  datasetVersion: number;
  scoringSemantics: number;
  startedAt: string;
  action: string;
}
interface ScoringSemantics {
  current: number;
  versions: Array<{ version: number; adr: string; summary: string }>;
  evalRuns: Array<{ version: number; runs: number; comparableToCurrent: boolean }>;
  stalePinnedBaselines: StrandedBaseline[];
  note: string;
}

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const signed = (n: number | null | undefined) =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(3)}`;

export default function EvalsPage() {
  const agents = useAgents();
  const projects = useProjects();
  const act = useAction();

  const scorers = useQuery({
    queryKey: ["admin", "eval-scorers"],
    queryFn: () =>
      api.get<{ scorers: ScorerInfo[]; note: string; externalScorers?: ExternalScorerListing }>(
        "/v1/evals/scorers",
      ),
  });
  const datasets = useQuery({
    queryKey: ["admin", "eval-datasets"],
    queryFn: () => api.get<{ datasets: DatasetRow[]; note: string }>("/v1/evals/datasets"),
  });
  const runs = useQuery({
    queryKey: ["admin", "eval-runs"],
    queryFn: () => api.get<{ runs: RunRow[] }>("/v1/evals/runs?limit=100"),
  });
  // ADR-0072 — which stored measurements are STRANDED by the scoring-semantics
  // correction. An operator has to be able to SEE this, not discover it as a
  // 422 the next time a gate runs.
  const semantics = useQuery({
    queryKey: ["admin", "eval-scoring-semantics"],
    queryFn: () => api.get<ScoringSemantics>("/v1/evals/scoring-semantics"),
  });

  const [selectedDataset, setSelectedDataset] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<string>("");

  const detail = useQuery({
    queryKey: ["admin", "eval-dataset", selectedDataset],
    enabled: Boolean(selectedDataset),
    queryFn: () =>
      api.get<{ dataset: DatasetRow; cases: CaseRow[]; frozen: boolean }>(
        `/v1/evals/datasets/${selectedDataset}`,
      ),
  });
  const runDetail = useQuery({
    queryKey: ["admin", "eval-run", selectedRun],
    enabled: Boolean(selectedRun),
    queryFn: () =>
      api.get<{ run: RunRow; results: ResultRow[]; baseline: RunRow | null; diff: DiffRow[] }>(
        `/v1/evals/runs/${selectedRun}`,
      ),
  });

  // --- new dataset form
  const [dsName, setDsName] = useState("");
  const [dsNote, setDsNote] = useState("");
  const [dsScorer, setDsScorer] = useState("contains");
  const [dsConfig, setDsConfig] = useState('{"threshold": 1}');

  // --- new case form
  const [caseInput, setCaseInput] = useState("");
  const [caseExpected, setCaseExpected] = useState("");
  const [caseScorer, setCaseScorer] = useState("");
  const [caseConfig, setCaseConfig] = useState("");
  // ADR-0067: the retrieved/reference context a groundedness metric scores
  // against. Blank-line-separated, because CHUNK BOUNDARIES are the metric —
  // a claim stitched out of two chunks is the fabrication it exists to catch.
  const [caseContext, setCaseContext] = useState("");
  const [caseContextInPrompt, setCaseContextInPrompt] = useState(true);

  // --- run form
  const [runAgent, setRunAgent] = useState("");
  const [runJudge, setRunJudge] = useState("");
  const [runProject, setRunProject] = useState("");
  const [runTolerance, setRunTolerance] = useState("0.05");

  return (
    <>
      <PageHeader
        title="Evaluations"
        sub="Golden datasets, scored runs, and the baseline comparison the workflow check gate blocks on. Every eval dispatch goes through the same governed core as any other call — entitlements, budget, PII and guardrails all apply, and the spend lands in the one usage ledger. An eval is not a bypass."
      />
      <div className={v.stack}>
        {/* ------- ADR-0072: what the numbers MEAN, and what is stranded ---- */}
        <Card title="Scoring semantics — which stored measurements are still comparable">
          <QueryGate
            loading={semantics.isLoading}
            error={semantics.error}
            onRetry={() => void semantics.refetch()}
          >
            {semantics.data && (
              <div className={v.stack}>
                <p className={v.dim}>{semantics.data.note}</p>

                <div className={a.statRow}>
                  <Stat value={`v${semantics.data.current}`} label="Current semantics" />
                  {semantics.data.evalRuns.map((r) => (
                    <Stat
                      key={r.version}
                      value={r.runs}
                      label={
                        r.comparableToCurrent
                          ? `runs on v${r.version} — comparable`
                          : `runs on v${r.version} — NOT comparable to today`
                      }
                    />
                  ))}
                  <Stat
                    value={semantics.data.stalePinnedBaselines.length}
                    label="Pinned baselines that are stranded"
                  />
                </div>

                <div className={v.sectionTitle}>What changed, and when</div>
                <Table<{ version: number; adr: string; summary: string }>
                  rows={semantics.data.versions}
                  rowKey={(r) => String(r.version)}
                  columns={[
                    {
                      key: "version",
                      header: "Version",
                      render: (r) => (
                        <Badge tone={r.version === semantics.data!.current ? "ok" : "neutral"}>
                          v{r.version}
                          {r.version === semantics.data!.current ? " (current)" : ""}
                        </Badge>
                      ),
                    },
                    { key: "adr", header: "Decided in", render: (r) => <code>{r.adr}</code> },
                    { key: "summary", header: "What a score MEANT", render: (r) => <span className={v.dim}>{r.summary}</span> },
                  ]}
                />

                {semantics.data.stalePinnedBaselines.length === 0 ? (
                  <p className={v.faint}>
                    No pinned baseline is stranded. Every pinned run was scored under the current semantics,
                    so every gate can produce a comparable delta.
                  </p>
                ) : (
                  <>
                    <div className={v.errLine} role="alert" data-testid="stranded-baselines">
                      {semantics.data.stalePinnedBaselines.length} pinned baseline(s) were scored under older
                      semantics. Until each one is re-pinned, its dataset/agent pair produces{" "}
                      <strong>no comparable delta</strong>: the gate FAILS and names the run to re-pin rather
                      than silently swapping in a different baseline, and pinning a v1 run is refused
                      outright with <code>baseline_semantics_stale</code>.
                    </div>
                    <Table<StrandedBaseline>
                      rows={semantics.data.stalePinnedBaselines}
                      rowKey={(r) => r.runId}
                      columns={[
                        { key: "agent", header: "Agent", render: (r) => r.agentName },
                        {
                          key: "dataset",
                          header: "Dataset",
                          render: (r) => `${r.datasetName ?? r.datasetId} v${r.datasetVersion}`,
                        },
                        { key: "sem", header: "Scored under", render: (r) => <Badge tone="danger">v{r.scoringSemantics}</Badge> },
                        { key: "when", header: "Run at", render: (r) => ago(r.startedAt) },
                        { key: "run", header: "Run id", render: (r) => <code>{r.runId}</code> },
                        { key: "action", header: "What to do", render: (r) => <span className={v.dim}>{r.action}</span> },
                      ]}
                    />
                  </>
                )}
              </div>
            )}
          </QueryGate>
        </Card>

        <QueryGate
          loading={scorers.isLoading || datasets.isLoading}
          error={scorers.error ?? datasets.error}
          onRetry={() => {
            void scorers.refetch();
            void datasets.refetch();
          }}
        >
          {/* ---------------- scorers ---------------- */}
          <Card title="Scorers, and what each one cannot do">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {scorers.data?.note}
            </div>
            <Table
              rows={scorers.data?.scorers ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "id", header: "Scorer", render: (r) => <code>{r.id}</code> },
                {
                  key: "kind",
                  header: "Kind",
                  render: (r) => (
                    <Badge tone={r.deterministic ? "ok" : "warn"}>
                      {r.deterministic ? "deterministic" : "model-backed"}
                    </Badge>
                  ),
                },
                { key: "summary", header: "What it does", render: (r) => r.summary },
                {
                  key: "limits",
                  header: "What it cannot do",
                  render: (r) => <span className={v.faint}>{r.limits}</span>,
                },
              ]}
            />
            {/* ADR-0088 — the external option, with its disclosure ON the page
                where the choice is made. Registration lives under
                Integrations → External scorers. */}
            {(scorers.data?.externalScorers?.scorers ?? []).length > 0 && (
              <div style={{ marginTop: "var(--s3)" }}>
                <h3 style={{ marginBottom: "var(--s2)" }}>External scorers (registered instruments)</h3>
                <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                  {scorers.data?.externalScorers?.disclosure} {scorers.data?.externalScorers?.note}
                </div>
                <Table
                  rows={scorers.data?.externalScorers?.scorers ?? []}
                  rowKey={(r) => r.name}
                  columns={[
                    { key: "name", header: "Name", render: (r) => <code>external:{r.name}</code> },
                    {
                      key: "kinds",
                      header: "Claims to serve",
                      render: (r) => <span className={v.faint}>{r.scorerKinds.join(", ")}</span>,
                    },
                    {
                      key: "state",
                      header: "State",
                      render: (r) => (
                        <Badge tone={r.enabled ? "ok" : "warn"}>{r.enabled ? "enabled" : "disabled"}</Badge>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </Card>

          {/* ---------------- datasets ---------------- */}
          <Card title="Golden datasets">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {datasets.data?.note}
            </div>
            <form
              className={a.formRow}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api.post("/v1/evals/datasets", {
                    name: dsName,
                    note: dsNote || undefined,
                    scorerKind: dsScorer,
                    scorerConfig: JSON.parse(dsConfig || "{}") as Record<string, unknown>,
                  });
                  setDsName("");
                  setDsNote("");
                  await datasets.refetch();
                }, "Dataset created at version 1");
              }}
            >
              <Field label="Name">
                <Input value={dsName} onChange={(e) => setDsName(e.target.value)} required />
              </Field>
              <Field label="Default scorer">
                <Select value={dsScorer} onChange={(e) => setDsScorer(e.target.value)}>
                  {optionEls((scorers.data?.scorers ?? []).map((s) => ({ v: s.id, l: s.id })))}
                </Select>
              </Field>
              <Field label="Default scorer config (JSON)" grow>
                <Input value={dsConfig} onChange={(e) => setDsConfig(e.target.value)} />
              </Field>
              <Field label="Note" grow>
                <Input value={dsNote} onChange={(e) => setDsNote(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabled={act.busy || !dsName}>
                Create
              </Button>
            </form>
            {(datasets.data?.datasets ?? []).length === 0 ? (
              <EmptyState
                title="No datasets yet"
                body="A regression gate needs a fixed set of cases to measure against. Create one, add cases, then run it to establish a baseline."
              />
            ) : (
              <Table
                rows={datasets.data?.datasets ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setSelectedDataset(r.id)}
                columns={[
                  { key: "name", header: "Dataset", render: (r) => r.name },
                  { key: "version", header: "Version", render: (r) => `v${r.version}` },
                  { key: "cases", header: "Cases", render: (r) => r.caseCount },
                  { key: "runs", header: "Runs", render: (r) => r.runCount },
                  { key: "scorer", header: "Default scorer", render: (r) => <code>{r.scorerKind}</code> },
                  {
                    key: "frozen",
                    header: "State",
                    render: (r) =>
                      r.frozen ? (
                        <Badge tone="info" title="A run has scored against this version, so its cases can no longer change.">
                          frozen
                        </Badge>
                      ) : (
                        <Badge tone="neutral">editable</Badge>
                      ),
                  },
                ]}
              />
            )}
          </Card>

          {/* ---------------- dataset detail + run trigger ---------------- */}
          {selectedDataset && detail.data && (
            <Card
              title={`${detail.data.dataset.name} v${detail.data.dataset.version}`}
              actions={
                <Button size="sm" onClick={() => setSelectedDataset("")}>
                  Close
                </Button>
              }
            >
              {detail.data.frozen ? (
                <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                  This version has been scored by a run and is immutable. Mint the next version to
                  change its cases — the old version keeps standing behind every gate result that
                  cited it.
                  <div style={{ marginTop: "var(--s2)" }}>
                    <Button
                      size="sm"
                      disabled={act.busy}
                      onClick={() =>
                        void act.run(async () => {
                          const next = await api.post<{ dataset: DatasetRow; copiedCases: number }>(
                            `/v1/evals/datasets/${selectedDataset}/versions`,
                          );
                          setSelectedDataset(next.dataset.id);
                          await datasets.refetch();
                        }, "Next version minted with the cases copied")
                      }
                    >
                      Mint next version
                    </Button>
                  </div>
                </div>
              ) : (
                <form
                  className={v.stack}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post(`/v1/evals/datasets/${selectedDataset}/cases`, {
                        input: caseInput,
                        expected: caseExpected || undefined,
                        ...(caseScorer ? { scorerKind: caseScorer } : {}),
                        ...(caseConfig
                          ? { scorerConfig: JSON.parse(caseConfig) as Record<string, unknown> }
                          : {}),
                        context: caseContext
                          .split(/\n\s*\n/)
                          .map((c) => c.trim())
                          .filter(Boolean),
                        contextInPrompt: caseContextInPrompt,
                      });
                      setCaseInput("");
                      setCaseExpected("");
                      setCaseContext("");
                      await detail.refetch();
                      await datasets.refetch();
                    }, "Case added");
                  }}
                >
                  <Field label="Input sent to the agent">
                    <Textarea
                      value={caseInput}
                      onChange={(e) => setCaseInput(e.target.value)}
                      rows={3}
                      required
                    />
                  </Field>
                  <Field label="Retrieved / reference context — one chunk per blank-line-separated block (groundedness metrics only)">
                    <Textarea
                      value={caseContext}
                      onChange={(e) => setCaseContext(e.target.value)}
                      rows={3}
                    />
                  </Field>
                  <div className={v.faint}>
                    Chunk boundaries matter: each claim is scored against the single best-matching
                    chunk, so a claim that only holds up when fragments of two chunks are stitched
                    together is correctly reported as unsupported.{" "}
                    <label>
                      <input
                        type="checkbox"
                        checked={caseContextInPrompt}
                        onChange={(e) => setCaseContextInPrompt(e.target.checked)}
                      />{" "}
                      Include the context in the prompt (uncheck to hold it back and score against it
                      only)
                    </label>
                  </div>
                  <div className={a.formRow}>
                    <Field label="Expected / reference" grow>
                      <Input value={caseExpected} onChange={(e) => setCaseExpected(e.target.value)} />
                    </Field>
                    <Field label="Scorer override">
                      <Select value={caseScorer} onChange={(e) => setCaseScorer(e.target.value)}>
                        <option value="">(dataset default)</option>
                        {optionEls((scorers.data?.scorers ?? []).map((s) => ({ v: s.id, l: s.id })))}
                      </Select>
                    </Field>
                    <Field label="Scorer config (JSON)" grow>
                      <Input value={caseConfig} onChange={(e) => setCaseConfig(e.target.value)} />
                    </Field>
                    <Button type="submit" variant="primary" disabled={act.busy || !caseInput}>
                      Add case
                    </Button>
                  </div>
                </form>
              )}
              <Table
                rows={detail.data.cases}
                rowKey={(r) => r.id}
                empty="No cases yet — an empty suite certifies nothing."
                columns={[
                  { key: "input", header: "Input", render: (r) => r.input.slice(0, 120) },
                  {
                    key: "expected",
                    header: "Expected",
                    render: (r) =>
                      r.expected == null
                        ? "—"
                        : typeof r.expected === "string"
                          ? r.expected.slice(0, 80)
                          : JSON.stringify(r.expected).slice(0, 80),
                  },
                  {
                    key: "context",
                    header: "Context",
                    render: (r) =>
                      (r.context ?? []).length === 0
                        ? "—"
                        : `${(r.context ?? []).length} chunk(s)${r.contextInPrompt === false ? " (scoring only)" : ""}`,
                  },
                  { key: "scorer", header: "Scorer", render: (r) => <code>{r.scorerKind ?? "(default)"}</code> },
                ]}
              />

              <div style={{ marginTop: "var(--s3)" }}>
                <form
                  className={a.formRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post("/v1/evals/runs", {
                        datasetId: selectedDataset,
                        agentId: runAgent,
                        judgeAgentId: runJudge || undefined,
                        projectId: runProject || undefined,
                        tolerance: Number(runTolerance),
                      });
                      await runs.refetch();
                      await datasets.refetch();
                      await detail.refetch();
                    }, "Run complete");
                  }}
                >
                  <Field label="Agent under test">
                    <Select value={runAgent} onChange={(e) => setRunAgent(e.target.value)} required>
                      <option value="">Select…</option>
                      {optionEls(agentOpts(agents.data?.agents))}
                    </Select>
                  </Field>
                  <Field label="Judge (llm_as_judge cases only)">
                    <Select value={runJudge} onChange={(e) => setRunJudge(e.target.value)}>
                      <option value="">(none)</option>
                      {optionEls(agentOpts(agents.data?.agents))}
                    </Select>
                  </Field>
                  <Field label="Bill to project">
                    <Select value={runProject} onChange={(e) => setRunProject(e.target.value)}>
                      <option value="">(unattributed)</option>
                      {optionEls(projectOpts(projects.data?.projects))}
                    </Select>
                  </Field>
                  <Field label="Tolerance">
                    <Input value={runTolerance} onChange={(e) => setRunTolerance(e.target.value)} />
                  </Field>
                  <Button type="submit" variant="primary" disabled={act.busy || !runAgent}>
                    Run now
                  </Button>
                </form>
              </div>
            </Card>
          )}

          {/* ---------------- runs ---------------- */}
          <Card title="Runs">
            <Table
              rows={runs.data?.runs ?? []}
              rowKey={(r) => r.id}
              onRowClick={(r) => setSelectedRun(r.id)}
              empty="No runs yet."
              columns={[
                { key: "dataset", header: "Dataset", render: (r) => `${r.datasetName ?? "?"} v${r.datasetVersion}` },
                { key: "agent", header: "Agent", render: (r) => r.agentName },
                { key: "model", header: "Model", render: (r) => r.model ?? "—" },
                { key: "trigger", header: "Trigger", render: (r) => r.trigger },
                { key: "score", header: "Mean score", render: (r) => (r.meanScore ?? 0).toFixed(3) },
                { key: "pass", header: "Pass rate", render: (r) => pct(r.passRate) },
                {
                  key: "delta",
                  header: "Δ vs baseline",
                  render: (r) => (
                    <Badge
                      tone={
                        r.scoreDelta == null ? "neutral" : r.scoreDelta < 0 ? "danger" : r.scoreDelta > 0 ? "ok" : "info"
                      }
                    >
                      {signed(r.scoreDelta)}
                    </Badge>
                  ),
                },
                {
                  key: "gate",
                  header: "Gate",
                  render: (r) =>
                    r.gatePassed == null ? (
                      <Badge tone="neutral">—</Badge>
                    ) : r.gatePassed ? (
                      <Badge tone="ok">pass</Badge>
                    ) : (
                      <Badge tone="danger" title={r.gateReason ?? undefined}>
                        {r.regression ? "regression" : "fail"}
                      </Badge>
                    ),
                },
                { key: "cost", header: "Cost", render: (r) => `$${r.costUsd.toFixed(4)}` },
                {
                  key: "baseline",
                  header: "Baseline",
                  render: (r) =>
                    r.isBaseline ? (
                      <Badge tone="info">pinned</Badge>
                    ) : (
                      <Button
                        size="sm"
                        disabled={act.busy || r.status !== "completed"}
                        onClick={() =>
                          void act.run(async () => {
                            await api.post(`/v1/evals/runs/${r.id}/baseline`, { isBaseline: true });
                            await runs.refetch();
                          }, "Baseline pinned — every later run on this dataset version is measured against it")
                        }
                      >
                        Pin
                      </Button>
                    ),
                },
                { key: "when", header: "When", render: (r) => ago(r.startedAt) },
              ]}
            />
          </Card>

          {/* ---------------- run detail + diff ---------------- */}
          {selectedRun && runDetail.data && (
            <Card
              title="Run detail"
              actions={
                <Button size="sm" onClick={() => setSelectedRun("")}>
                  Close
                </Button>
              }
            >
              <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                {runDetail.data.run.gateReason}
                {runDetail.data.run.judgeImpl
                  ? ` — scored with judge ${runDetail.data.run.judgeImpl}`
                  : ""}
              </div>
              {runDetail.data.baseline ? (
                <Table
                  rows={runDetail.data.diff}
                  rowKey={(r) => r.caseId ?? Math.random().toString()}
                  columns={[
                    { key: "input", header: "Case", render: (r) => (r.input ?? "").slice(0, 100) },
                    { key: "base", header: "Baseline", render: (r) => r.baselineScore?.toFixed(3) ?? "—" },
                    { key: "now", header: "This run", render: (r) => r.score.toFixed(3) },
                    {
                      key: "delta",
                      header: "Δ",
                      render: (r) => (
                        <Badge tone={r.delta == null ? "neutral" : r.delta < 0 ? "danger" : r.delta > 0 ? "ok" : "info"}>
                          {signed(r.delta)}
                        </Badge>
                      ),
                    },
                  ]}
                />
              ) : (
                <EmptyState
                  title="No baseline to diff against"
                  body="This run has nothing before it on this dataset version and agent, so it stands as the first reference. Pin it as the baseline to make later runs comparable."
                />
              )}
              <div style={{ marginTop: "var(--s3)" }}>
                <Table
                  rows={runDetail.data.results}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: "input", header: "Case", render: (r) => (r.input ?? "").slice(0, 80) },
                    { key: "scorer", header: "Scorer", render: (r) => <code>{r.scorerKind}</code> },
                    {
                      key: "method",
                      // ADR-0088: WHO produced this number — a local
                      // algorithm, a governed model judge, or a registered
                      // external instrument (external:<name>). Rendered on
                      // every row so a vendor's opinion can never read as a
                      // model's entailment judgement, or either as ours.
                      header: "Method",
                      render: (r) => {
                        const m = typeof r.detail?.method === "string" ? r.detail.method : null;
                        return m ? (
                          <Badge tone={m.startsWith("external:") ? "info" : "neutral"}>{m}</Badge>
                        ) : (
                          <span className={v.faint}>—</span>
                        );
                      },
                    },
                    { key: "score", header: "Score", render: (r) => r.score.toFixed(3) },
                    {
                      key: "passed",
                      header: "Result",
                      render: (r) => <Badge tone={r.passed ? "ok" : "danger"}>{r.passed ? "pass" : "fail"}</Badge>,
                    },
                    { key: "latency", header: "Latency", render: (r) => (r.latencyMs == null ? "—" : `${r.latencyMs}ms`) },
                    {
                      key: "why",
                      header: "Why",
                      render: (r) => (
                        <span className={v.faint}>{r.error ?? r.judgeRationale ?? (r.outputText ?? "").slice(0, 120)}</span>
                      ),
                    },
                  ]}
                />
              </div>
            </Card>
          )}
        </QueryGate>
      </div>
    </>
  );
}
