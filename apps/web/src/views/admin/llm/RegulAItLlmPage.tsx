/**
 * RegulAIt-LLM (ADR-0065) — the custom-model creation and training surface.
 *
 * The screen where somebody builds a model out of their own data, and where the
 * product is either honest about what it just did or it is not. Five things it
 * exists to keep true, rendered rather than merely documented:
 *
 *  - **Every backend states what it CANNOT do, next to where you pick it.** The
 *    `limits` string comes straight from the backend's own capability
 *    declaration — including `local`'s blunt "IT DOES NOT FINE-TUNE A LANGUAGE
 *    MODEL". A person choosing a backend reads that at the moment they decide,
 *    not in an ADR they will never open. Same discipline as the Evaluations
 *    scorer table and the Guardrails detector table.
 *  - **The ingest scan verdict is shown on the data, not buried in a toast.**
 *    A refused upload says which categories fired and how many times — counts
 *    only, never the matched text — and a flagged version carries that verdict
 *    forever.
 *  - **A frozen dataset version says so.** The moment a job trains on a version
 *    it is immutable, and the row editor is replaced by "mint the next
 *    version". A claim about a model is meaningless if the data can move
 *    underneath it.
 *  - **A refused job is not a failed job.** `refused` (nothing was configured,
 *    nothing was attempted) renders differently from `failed` (we tried and it
 *    broke), because they are different facts about a model.
 *  - **An artifact is a governed model or it is nothing.** Registering one for
 *    inference mints an agent AND a model card, and the screen links straight
 *    to both, plus to an evaluation of it (ADR-0044).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Meter,
  Select,
  Table,
  Textarea,
  type Tone,
} from "../../../ui/kit";
import { KV, QueryGate, Stat, agentOpts, optionEls, projectOpts, useAction, useAgents, useProjects } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

// ---------------------------------------------------------------------------
// types (mirrors of the gateway's read projections)
// ---------------------------------------------------------------------------

interface BackendInfo {
  kind: string;
  requiresCredential: boolean;
  inProcess: boolean;
  methods: string[];
  producesQueryableArtifact: boolean;
  supportsCancel: boolean;
  summary: string;
  limits: string;
  defaultBaseUrl: string | null;
  configured: boolean;
  configEnabled: boolean;
  hasCredential: boolean;
  baseUrl: string | null;
  lastTestError: string | null;
}
interface ScanFindings {
  pii: Array<{ category: string; count: number }>;
  guardrails: Array<{ detector: string; category: string; count: number }>;
}
interface DatasetRow {
  id: string;
  name: string;
  version: number;
  note: string | null;
  format: string;
  rowCount: number;
  charCount: number;
  checksum: string;
  piiVerdict: string;
  piiMode: string;
  scanFindings: ScanFindings;
  projectId: string | null;
  jobCount: number;
  frozen: boolean;
  createdAt: string;
}
interface CorpusRow {
  id: string;
  idx: number;
  input: string;
  output: string | null;
}
interface JobRow {
  id: string;
  name: string;
  datasetId: string;
  datasetName?: string | null;
  datasetVersion: number;
  backend: string;
  method: string;
  baseModel: string | null;
  status: string;
  progress: number;
  error: string | null;
  estimatedCostUsd: number;
  costUsd: number | null;
  projectId: string | null;
  approvalId: string | null;
  artifactId?: string | null;
  inProcess?: boolean;
  createdAt: string;
  durationMs: number | null;
}
interface ArtifactRow {
  id: string;
  jobId: string;
  name: string;
  method: string;
  baseModel: string | null;
  kind: string;
  location: string | null;
  metrics: Record<string, unknown>;
  agentId: string | null;
  modelCardId: string | null;
  queryable: boolean;
  payloadKind: string | null;
  payloadSummary: Record<string, unknown> | null;
  createdAt: string;
  job?: JobRow | null;
}

const METHODS = ["retrieval_index", "text_classifier", "lora_sft", "full_sft", "dpo"] as const;
const FORMATS = ["prompt_completion", "classification", "documents"] as const;

/** the dials each method actually reads — mirrors METHOD_HYPERPARAMETERS in
 * @regulait/training-provider, so the form never offers a number the backend
 * will refuse as a no-op */
const METHOD_DIALS: Record<string, Array<{ key: string; label: string; def: string }>> = {
  retrieval_index: [
    { key: "topK", label: "Neighbours (topK)", def: "3" },
    { key: "evalFraction", label: "Held-out fraction", def: "0.2" },
  ],
  text_classifier: [
    { key: "epochs", label: "Epochs", def: "12" },
    { key: "learningRate", label: "Learning rate", def: "0.5" },
    { key: "l2", label: "L2", def: "0.0001" },
    { key: "maxVocabulary", label: "Max vocabulary", def: "4000" },
    { key: "evalFraction", label: "Held-out fraction", def: "0.2" },
  ],
  lora_sft: [
    { key: "epochs", label: "Epochs", def: "12" },
    { key: "learningRate", label: "Learning rate", def: "0.5" },
    { key: "batchSize", label: "Batch size", def: "8" },
    { key: "loraRank", label: "LoRA rank", def: "8" },
    { key: "evalFraction", label: "Held-out fraction", def: "0.2" },
  ],
  full_sft: [
    { key: "epochs", label: "Epochs", def: "12" },
    { key: "learningRate", label: "Learning rate", def: "0.5" },
    { key: "batchSize", label: "Batch size", def: "8" },
    { key: "evalFraction", label: "Held-out fraction", def: "0.2" },
  ],
  dpo: [
    { key: "epochs", label: "Epochs", def: "12" },
    { key: "learningRate", label: "Learning rate", def: "0.5" },
    { key: "batchSize", label: "Batch size", def: "8" },
    { key: "evalFraction", label: "Held-out fraction", def: "0.2" },
  ],
};

const statusTone = (s: string): Tone =>
  s === "succeeded"
    ? "ok"
    : s === "running"
      ? "info"
      : s === "pending_approval"
        ? "warn"
        : s === "refused"
          ? "warn"
          : s === "failed"
            ? "danger"
            : "neutral";

const verdictTone = (v: string): Tone => (v === "clean" ? "ok" : v === "flagged" ? "warn" : "danger");

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(4)}`);

/** Findings, COUNTS ONLY. There is deliberately no way to render matched text
 * here — the API does not return it and this component could not show it. */
function Findings(props: { findings: ScanFindings | undefined }) {
  const f = props.findings;
  const items = [
    ...(f?.pii ?? []).map((p) => `${p.category} ×${p.count}`),
    ...(f?.guardrails ?? []).map((g) => `${g.detector}/${g.category} ×${g.count}`),
  ];
  if (items.length === 0) return <span className={v.faint}>nothing fired</span>;
  return (
    <span>
      {items.map((i) => (
        <Badge key={i} tone="warn">
          {i}
        </Badge>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------

export default function RegulAItLlmPage() {
  const agents = useAgents();
  const projects = useProjects();
  const act = useAction();

  const backends = useQuery({
    queryKey: ["admin", "llm-backends"],
    queryFn: () =>
      api.get<{ enabled: boolean; approvalThresholdUsd: number; backends: BackendInfo[]; note: string }>(
        "/v1/llm/backends",
      ),
  });
  const datasets = useQuery({
    queryKey: ["admin", "llm-datasets"],
    queryFn: () => api.get<{ datasets: DatasetRow[]; note: string }>("/v1/llm/datasets"),
  });
  const jobs = useQuery({
    queryKey: ["admin", "llm-jobs"],
    queryFn: () => api.get<{ jobs: JobRow[] }>("/v1/llm/jobs?limit=100"),
  });
  const artifacts = useQuery({
    queryKey: ["admin", "llm-artifacts"],
    queryFn: () => api.get<{ artifacts: ArtifactRow[]; note: string }>("/v1/llm/artifacts"),
  });

  const [selectedDataset, setSelectedDataset] = useState("");
  const [selectedArtifact, setSelectedArtifact] = useState("");

  const datasetDetail = useQuery({
    queryKey: ["admin", "llm-dataset", selectedDataset],
    enabled: Boolean(selectedDataset),
    queryFn: () =>
      api.get<{ dataset: DatasetRow; rows: CorpusRow[]; versions: DatasetRow[]; jobs: JobRow[]; frozen: boolean }>(
        `/v1/llm/datasets/${selectedDataset}`,
      ),
  });
  const artifactDetail = useQuery({
    queryKey: ["admin", "llm-artifact", selectedArtifact],
    enabled: Boolean(selectedArtifact),
    queryFn: () =>
      api.get<{
        artifact: ArtifactRow;
        job: JobRow | null;
        trainedOn: DatasetRow | null;
        modelCard: { id: string; intendedUse: string; limitations: string | null } | null;
        agent: { id: string; name: string; tier: number } | null;
      }>(`/v1/llm/artifacts/${selectedArtifact}`),
  });

  // --- upload form
  const [dsName, setDsName] = useState("");
  const [dsFormat, setDsFormat] = useState<string>("prompt_completion");
  const [dsNote, setDsNote] = useState("");
  const [dsProject, setDsProject] = useState("");
  const [dsPiiMode, setDsPiiMode] = useState("block");
  const [dsBody, setDsBody] = useState(
    '{"input": "How do I rotate an API key?", "output": "Open Settings → Credentials → Rotate."}\n' +
      '{"input": "What is the refund window?", "output": "30 days from the renewal date."}',
  );
  const [scanReport, setScanReport] = useState<{ verdict: string; mode: string; findings: ScanFindings } | null>(null);

  // --- job form
  const [jobName, setJobName] = useState("");
  const [jobBackend, setJobBackend] = useState("local");
  const [jobMethod, setJobMethod] = useState("retrieval_index");
  const [jobBaseModel, setJobBaseModel] = useState("");
  const [jobBaseAgent, setJobBaseAgent] = useState("");
  const [jobProject, setJobProject] = useState("");
  const [jobApprover, setJobApprover] = useState("");
  const [jobPrice, setJobPrice] = useState("");
  const [jobDials, setJobDials] = useState<Record<string, string>>({});

  // --- bench
  const [benchQuery, setBenchQuery] = useState("");
  const [benchResult, setBenchResult] = useState<{ answer: string | null; score: number; detail: Record<string, unknown> } | null>(
    null,
  );

  // --- registration
  const [regName, setRegName] = useState("");
  const [regUse, setRegUse] = useState("");

  const backend = (backends.data?.backends ?? []).find((b) => b.kind === jobBackend);
  const dials = METHOD_DIALS[jobMethod] ?? [];

  /** JSONL → rows. Parsed HERE so a malformed line is named before anything is
   * uploaded, rather than surfacing as a 400 with an index nobody can find. */
  function parseRows(text: string): Array<{ input: string; output?: string | null }> {
    const out: Array<{ input: string; output?: string | null }> = [];
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line, i) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`line ${i + 1} is not valid JSON`);
        }
        const row = parsed as { input?: unknown; output?: unknown };
        if (typeof row.input !== "string" || row.input.length === 0) {
          throw new Error(`line ${i + 1} has no "input"`);
        }
        out.push({ input: row.input, output: typeof row.output === "string" ? row.output : null });
      });
    if (out.length === 0) throw new Error("no rows — an empty corpus trains nothing");
    return out;
  }

  return (
    <>
      <PageHeader
        title="RegulAIt-LLM"
        sub={
          "Build a model out of your own data, under the same governance every bought model already has: " +
          "the corpus is scanned for personal data BEFORE it is accepted, each version freezes the moment " +
          "a job trains on it, the job runs under your own entitlement and its cost lands in the one " +
          "ledger, an expensive one goes to the Approvals Queue, and the model that comes out gets a " +
          "model card and is subject to the MRM gate. What this is NOT is a claim to train frontier " +
          "models — read each backend's stated limits before you pick one."
        }
      />
      <div className={v.stack}>
        <QueryGate
          loading={backends.isLoading || datasets.isLoading}
          error={backends.error ?? datasets.error}
          onRetry={() => {
            void backends.refetch();
            void datasets.refetch();
          }}
        >
          {/* ---------------- backends ---------------- */}
          <Card title="Training backends, and what each one cannot do">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {backends.data?.note}
            </div>
            <div className={v.row} style={{ marginBottom: "var(--s2)" }}>
              <Stat
                value={backends.data?.enabled ? "on" : "off"}
                label="Custom-model creation"
              />
              <Stat
                value={`$${(backends.data?.approvalThresholdUsd ?? 0).toFixed(2)}`}
                label="Approval threshold (estimated cost)"
              />
            </div>
            <Table
              rows={backends.data?.backends ?? []}
              rowKey={(r) => r.kind}
              columns={[
                { key: "kind", header: "Backend", render: (r) => <code>{r.kind}</code> },
                {
                  key: "where",
                  header: "Runs",
                  render: (r) => (
                    <Badge tone={r.inProcess ? "ok" : "info"}>{r.inProcess ? "in-process" : "vendor compute"}</Badge>
                  ),
                },
                { key: "methods", header: "Methods", render: (r) => r.methods.join(", ") },
                {
                  key: "cred",
                  header: "Credential",
                  render: (r) =>
                    !r.requiresCredential ? (
                      <Badge tone="ok">none needed</Badge>
                    ) : r.hasCredential && r.configEnabled ? (
                      <Badge tone="ok">configured</Badge>
                    ) : (
                      <Badge tone="warn" title="Every job on this backend will be REFUSED until a credential is configured.">
                        missing — will refuse
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
          </Card>

          {/* ---------------- upload ---------------- */}
          <Card title="Upload training data">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {datasets.data?.note} Every row is scanned for personal data and credential material before
              the dataset exists — under the <code>block</code> mode nothing is stored at all.
            </div>
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  const rows = parseRows(dsBody);
                  const res = await api.post<{ dataset: DatasetRow; scan: { verdict: string; mode: string; findings: ScanFindings } }>(
                    "/v1/llm/datasets",
                    {
                      name: dsName,
                      format: dsFormat,
                      note: dsNote || undefined,
                      projectId: dsProject || undefined,
                      piiMode: dsPiiMode,
                      rows,
                    },
                  );
                  setScanReport(res.scan);
                  setDsName("");
                  await datasets.refetch();
                }, "Dataset created at version 1");
              }}
            >
              <div className={a.formRow}>
                <Field label="Name">
                  <Input value={dsName} onChange={(e) => setDsName(e.target.value)} required />
                </Field>
                <Field label="Format">
                  <Select value={dsFormat} onChange={(e) => setDsFormat(e.target.value)}>
                    {optionEls(FORMATS.map((f) => ({ v: f, l: f })))}
                  </Select>
                </Field>
                <Field label="Attribute to project">
                  <Select value={dsProject} onChange={(e) => setDsProject(e.target.value)}>
                    <option value="">(unattributed)</option>
                    {optionEls(projectOpts(projects.data?.projects))}
                  </Select>
                </Field>
                <Field label="Ingest posture">
                  <Select value={dsPiiMode} onChange={(e) => setDsPiiMode(e.target.value)}>
                    {optionEls([
                      { v: "block", l: "block — refuse a corpus with PII" },
                      { v: "warn", l: "warn — accept and flag" },
                      { v: "log", l: "log — accept and record" },
                      { v: "off", l: "off — do not scan for PII" },
                    ])}
                  </Select>
                </Field>
                <Field label="Note" grow>
                  <Input value={dsNote} onChange={(e) => setDsNote(e.target.value)} />
                </Field>
              </div>
              <Field label="Rows (JSONL — one {&quot;input&quot;, &quot;output&quot;} object per line)">
                <Textarea value={dsBody} onChange={(e) => setDsBody(e.target.value)} rows={8} />
              </Field>
              <div>
                <Button type="submit" variant="primary" disabled={act.busy || !dsName}>
                  Scan &amp; create
                </Button>
                <span className={v.faint} style={{ marginLeft: "var(--s2)" }}>
                  A project's compliance profile can only RAISE the posture above — it can never be lowered
                  from here.
                </span>
              </div>
            </form>
            {scanReport && (
              <div style={{ marginTop: "var(--s3)" }}>
                <KV
                  rows={[
                    ["Scan verdict", <Badge tone={verdictTone(scanReport.verdict)}>{scanReport.verdict}</Badge>],
                    ["Effective mode", <code>{scanReport.mode}</code>],
                    ["Findings (counts only)", <Findings findings={scanReport.findings} />],
                  ]}
                />
              </div>
            )}
          </Card>

          {/* ---------------- datasets ---------------- */}
          <Card title="Datasets">
            {(datasets.data?.datasets ?? []).length === 0 ? (
              <EmptyState
                title="No training data yet"
                body="A custom model needs a fixed, versioned corpus to learn from. Upload one above — it will be scanned before it is stored."
              />
            ) : (
              <Table
                rows={datasets.data?.datasets ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setSelectedDataset(r.id)}
                columns={[
                  { key: "name", header: "Dataset", render: (r) => r.name },
                  { key: "version", header: "Version", render: (r) => `v${r.version}` },
                  { key: "format", header: "Format", render: (r) => <code>{r.format}</code> },
                  { key: "rows", header: "Rows", render: (r) => r.rowCount },
                  {
                    key: "scan",
                    header: "Ingest scan",
                    render: (r) => (
                      <Badge tone={verdictTone(r.piiVerdict)} title={`mode: ${r.piiMode}`}>
                        {r.piiVerdict}
                      </Badge>
                    ),
                  },
                  { key: "jobs", header: "Jobs", render: (r) => r.jobCount },
                  {
                    key: "frozen",
                    header: "State",
                    render: (r) =>
                      r.frozen ? (
                        <Badge tone="info" title="A job has trained on this version, so its rows can no longer change.">
                          frozen
                        </Badge>
                      ) : (
                        <Badge tone="neutral">editable</Badge>
                      ),
                  },
                  { key: "when", header: "Created", render: (r) => ago(r.createdAt) },
                ]}
              />
            )}
          </Card>

          {/* ---------------- dataset detail + job creation ---------------- */}
          {selectedDataset && datasetDetail.data && (
            <Card
              title={`${datasetDetail.data.dataset.name} v${datasetDetail.data.dataset.version}`}
              actions={
                <Button size="sm" onClick={() => setSelectedDataset("")}>
                  Close
                </Button>
              }
            >
              <KV
                rows={[
                  ["Rows", datasetDetail.data.dataset.rowCount],
                  ["Characters", datasetDetail.data.dataset.charCount],
                  ["Checksum", <code>{datasetDetail.data.dataset.checksum}</code>],
                  [
                    "Ingest scan",
                    <>
                      <Badge tone={verdictTone(datasetDetail.data.dataset.piiVerdict)}>
                        {datasetDetail.data.dataset.piiVerdict}
                      </Badge>{" "}
                      at mode <code>{datasetDetail.data.dataset.piiMode}</code>{" "}
                      <Findings findings={datasetDetail.data.dataset.scanFindings} />
                    </>,
                  ],
                  [
                    "Versions",
                    datasetDetail.data.versions
                      .map((x) => `v${x.version} (${x.rowCount} rows)`)
                      .join(", "),
                  ],
                ]}
              />

              {datasetDetail.data.frozen && (
                <div className={v.faint} style={{ margin: "var(--s2) 0" }}>
                  A job has trained on this version, so it is immutable — a claim about a model is
                  meaningless if the data behind it can move afterwards. Mint the next version to change
                  the rows; this one keeps standing behind every artifact that cites it.
                  <div style={{ marginTop: "var(--s2)" }}>
                    <Button
                      size="sm"
                      disabled={act.busy}
                      onClick={() =>
                        void act.run(async () => {
                          const next = await api.post<{ dataset: DatasetRow }>(
                            `/v1/llm/datasets/${selectedDataset}/versions`,
                          );
                          setSelectedDataset(next.dataset.id);
                          await datasets.refetch();
                        }, "Next version minted with the rows copied")
                      }
                    >
                      Mint next version
                    </Button>
                  </div>
                </div>
              )}

              <div className={v.sectionTitle}>Rows</div>
              <Table
                rows={datasetDetail.data.rows}
                rowKey={(r) => r.id}
                empty="No rows."
                columns={[
                  { key: "idx", header: "#", render: (r) => r.idx },
                  { key: "input", header: "Input", render: (r) => r.input.slice(0, 140) },
                  { key: "output", header: "Output / label", render: (r) => (r.output ?? "—").slice(0, 140) },
                ]}
              />

              <div className={v.sectionTitle} style={{ marginTop: "var(--s3)" }}>
                Train a model on this version
              </div>
              <form
                className={v.stack}
                onSubmit={(e) => {
                  e.preventDefault();
                  void act.run(async () => {
                    const hyperparameters: Record<string, number> = {};
                    for (const d of dials) {
                      const raw = jobDials[d.key];
                      if (raw !== undefined && raw !== "") hyperparameters[d.key] = Number(raw);
                    }
                    await api.post("/v1/llm/jobs", {
                      name: jobName,
                      datasetId: selectedDataset,
                      backend: jobBackend,
                      method: jobMethod,
                      baseModel: jobBaseModel || undefined,
                      baseAgentId: jobBaseAgent,
                      projectId: jobProject || undefined,
                      approverUserId: jobApprover || undefined,
                      pricePerMTokUsd: jobPrice ? Number(jobPrice) : undefined,
                      hyperparameters,
                    });
                    setJobName("");
                    await jobs.refetch();
                    await artifacts.refetch();
                    await datasets.refetch();
                    await datasetDetail.refetch();
                  }, "Job submitted");
                }}
              >
                <div className={a.formRow}>
                  <Field label="Job name">
                    <Input value={jobName} onChange={(e) => setJobName(e.target.value)} required />
                  </Field>
                  <Field label="Backend">
                    <Select
                      value={jobBackend}
                      onChange={(e) => {
                        setJobBackend(e.target.value);
                        const b = (backends.data?.backends ?? []).find((x) => x.kind === e.target.value);
                        if (b && !b.methods.includes(jobMethod)) setJobMethod(b.methods[0] ?? "retrieval_index");
                      }}
                    >
                      {optionEls((backends.data?.backends ?? []).map((b) => ({ v: b.kind, l: b.kind })))}
                    </Select>
                  </Field>
                  <Field label="Method">
                    <Select value={jobMethod} onChange={(e) => setJobMethod(e.target.value)}>
                      {optionEls(
                        (backend?.methods ?? [...METHODS]).map((m) => ({ v: m, l: m })),
                      )}
                    </Select>
                  </Field>
                  <Field label="Base model (fine-tuning only)">
                    <Input
                      value={jobBaseModel}
                      onChange={(e) => setJobBaseModel(e.target.value)}
                      disabled={jobMethod === "retrieval_index" || jobMethod === "text_classifier"}
                      placeholder={jobMethod === "retrieval_index" ? "derives from no model" : ""}
                    />
                  </Field>
                </div>
                <div className={a.formRow}>
                  <Field label="Anchor agent (whose entitlement gates this)">
                    <Select value={jobBaseAgent} onChange={(e) => setJobBaseAgent(e.target.value)} required>
                      <option value="">Select…</option>
                      {optionEls(agentOpts(agents.data?.agents))}
                    </Select>
                  </Field>
                  <Field label="Bill to project">
                    <Select value={jobProject} onChange={(e) => setJobProject(e.target.value)}>
                      <option value="">(unattributed)</option>
                      {optionEls(projectOpts(projects.data?.projects))}
                    </Select>
                  </Field>
                  <Field label="Vendor $/M training tokens">
                    <Input
                      value={jobPrice}
                      onChange={(e) => setJobPrice(e.target.value)}
                      placeholder={backend?.inProcess ? "not billed" : "required for a remote backend"}
                      disabled={backend?.inProcess}
                    />
                  </Field>
                  <Field label="Approver (if over threshold)">
                    <Input value={jobApprover} onChange={(e) => setJobApprover(e.target.value)} placeholder="user id" />
                  </Field>
                </div>
                <div className={a.formRow}>
                  {dials.map((d) => (
                    <Field key={d.key} label={`${d.label} (default ${d.def})`}>
                      <Input
                        value={jobDials[d.key] ?? ""}
                        placeholder={d.def}
                        onChange={(e) => setJobDials({ ...jobDials, [d.key]: e.target.value })}
                      />
                    </Field>
                  ))}
                  <Button type="submit" variant="primary" disabled={act.busy || !jobName || !jobBaseAgent}>
                    Train
                  </Button>
                </div>
                {backend && (
                  <div className={v.faint}>
                    <strong>{backend.kind}:</strong> {backend.limits}
                  </div>
                )}
              </form>
            </Card>
          )}

          {/* ---------------- jobs ---------------- */}
          <Card title="Training jobs">
            <Table
              rows={jobs.data?.jobs ?? []}
              rowKey={(r) => r.id}
              empty="No training jobs yet."
              columns={[
                { key: "name", header: "Job", render: (r) => r.name },
                {
                  key: "dataset",
                  header: "Trained on",
                  render: (r) => `${r.datasetName ?? "?"} v${r.datasetVersion}`,
                },
                { key: "backend", header: "Backend", render: (r) => <code>{r.backend}</code> },
                { key: "method", header: "Method", render: (r) => <code>{r.method}</code> },
                {
                  key: "status",
                  header: "Status",
                  render: (r) => (
                    <Badge
                      tone={statusTone(r.status)}
                      title={
                        r.status === "refused"
                          ? "Nothing was attempted — the backend declined before any work happened. Distinct from 'failed'."
                          : (r.error ?? undefined)
                      }
                    >
                      {r.status}
                    </Badge>
                  ),
                },
                {
                  key: "progress",
                  header: "Progress",
                  render: (r) =>
                    r.status === "running" ? <Meter value={r.progress} max={1} /> : <span className={v.faint}>—</span>,
                },
                {
                  key: "cost",
                  header: "Cost",
                  render: (r) => (
                    <span title={`estimated ${usd(r.estimatedCostUsd)}`}>
                      {r.costUsd == null ? `est. ${usd(r.estimatedCostUsd)}` : usd(r.costUsd)}
                    </span>
                  ),
                },
                {
                  key: "approval",
                  header: "Approval",
                  render: (r) =>
                    r.approvalId ? (
                      <Link to="/admin/approvals" title="Decided in the one Approvals Queue">
                        queued
                      </Link>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                },
                {
                  key: "artifact",
                  header: "Artifact",
                  render: (r) =>
                    r.artifactId ? (
                      <Button size="sm" onClick={() => setSelectedArtifact(r.artifactId!)}>
                        Open
                      </Button>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                },
                { key: "when", header: "Started", render: (r) => ago(r.createdAt) },
                {
                  key: "act",
                  header: "",
                  render: (r) =>
                    ["running", "queued", "pending_approval"].includes(r.status) ? (
                      <Button
                        size="sm"
                        disabled={act.busy}
                        onClick={() =>
                          void act.run(async () => {
                            await api.post(`/v1/llm/jobs/${r.id}/cancel`);
                            await jobs.refetch();
                          }, "Cancelled")
                        }
                      >
                        Cancel
                      </Button>
                    ) : null,
                },
              ]}
            />
            <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
              Remote jobs are polled by the ADR-0064 scheduler (<code>training-job-poll-sweep</code>).{" "}
              <Button
                size="sm"
                disabled={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await api.post("/v1/llm/jobs/poll-sweep");
                    await jobs.refetch();
                    await artifacts.refetch();
                  }, "Swept")
                }
              >
                Poll now
              </Button>
            </div>
          </Card>

          {/* ---------------- artifacts ---------------- */}
          <Card title="Model artifacts">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {artifacts.data?.note}
            </div>
            <Table
              rows={artifacts.data?.artifacts ?? []}
              rowKey={(r) => r.id}
              onRowClick={(r) => setSelectedArtifact(r.id)}
              empty="Nothing has been trained yet."
              columns={[
                { key: "name", header: "Artifact", render: (r) => r.name },
                { key: "method", header: "Method", render: (r) => <code>{r.method}</code> },
                {
                  key: "kind",
                  header: "Where",
                  render: (r) =>
                    r.kind === "inline" ? (
                      <Badge tone="ok">queryable here</Badge>
                    ) : (
                      <Badge tone="info" title={r.location ?? undefined}>
                        on the backend
                      </Badge>
                    ),
                },
                {
                  key: "served",
                  header: "Served as",
                  render: (r) =>
                    r.agentId ? (
                      <Link to="/admin/agents">agent</Link>
                    ) : (
                      <span className={v.faint}>not registered</span>
                    ),
                },
                {
                  key: "card",
                  header: "Model card",
                  render: (r) =>
                    r.modelCardId ? <Link to="/admin/model-risk">card</Link> : <span className={v.faint}>—</span>,
                },
                { key: "when", header: "Created", render: (r) => ago(r.createdAt) },
              ]}
            />
          </Card>

          {/* ---------------- artifact detail ---------------- */}
          {selectedArtifact && artifactDetail.data && (
            <Card
              title={`Artifact — ${artifactDetail.data.artifact.name}`}
              actions={
                <Button size="sm" onClick={() => setSelectedArtifact("")}>
                  Close
                </Button>
              }
            >
              <KV
                rows={[
                  ["Method", <code>{artifactDetail.data.artifact.method}</code>],
                  ["Base model", artifactDetail.data.artifact.baseModel ?? "— (derives from no model)"],
                  [
                    "Trained on",
                    artifactDetail.data.trainedOn
                      ? `${artifactDetail.data.trainedOn.name} v${artifactDetail.data.trainedOn.version} · ${artifactDetail.data.trainedOn.rowCount} rows · ${artifactDetail.data.trainedOn.checksum}`
                      : "—",
                  ],
                  [
                    "Ingest scan of that corpus",
                    artifactDetail.data.trainedOn ? (
                      <Badge tone={verdictTone(artifactDetail.data.trainedOn.piiVerdict)}>
                        {artifactDetail.data.trainedOn.piiVerdict}
                      </Badge>
                    ) : (
                      "—"
                    ),
                  ],
                  [
                    "Served as agent",
                    artifactDetail.data.agent ? (
                      <>
                        {artifactDetail.data.agent.name} (tier {artifactDetail.data.agent.tier})
                      </>
                    ) : (
                      <span className={v.faint}>not registered for inference</span>
                    ),
                  ],
                  [
                    "Model card (ADR-0045)",
                    artifactDetail.data.modelCard ? (
                      <Link to="/admin/model-risk">{artifactDetail.data.modelCard.intendedUse}</Link>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                  ],
                ]}
              />

              <div className={v.sectionTitle} style={{ marginTop: "var(--s3)" }}>
                Measured metrics
              </div>
              <CodeBlock maxHeight="220px">
                {JSON.stringify(artifactDetail.data.artifact.metrics, null, 2)}
              </CodeBlock>

              {artifactDetail.data.artifact.payloadSummary && (
                <>
                  <div className={v.sectionTitle} style={{ marginTop: "var(--s3)" }}>
                    What the model learned
                  </div>
                  <CodeBlock maxHeight="220px">
                    {JSON.stringify(artifactDetail.data.artifact.payloadSummary, null, 2)}
                  </CodeBlock>
                </>
              )}

              {artifactDetail.data.artifact.queryable ? (
                <>
                  <div className={v.sectionTitle} style={{ marginTop: "var(--s3)" }}>
                    Bench — ask the model something
                  </div>
                  <form
                    className={a.formRow}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act.run(async () => {
                        const res = await api.post<{ answer: string | null; score: number; detail: Record<string, unknown> }>(
                          `/v1/llm/artifacts/${selectedArtifact}/query`,
                          { query: benchQuery },
                        );
                        setBenchResult(res);
                      }, null);
                    }}
                  >
                    <Field label="Query" grow>
                      <Input value={benchQuery} onChange={(e) => setBenchQuery(e.target.value)} required />
                    </Field>
                    <Button type="submit" variant="primary" disabled={act.busy || !benchQuery}>
                      Ask
                    </Button>
                  </form>
                  {benchResult && (
                    <KV
                      rows={[
                        [
                          "Answer",
                          benchResult.answer ?? (
                            <span className={v.faint}>
                              nothing in the corpus shares a term with that query — this model has no answer,
                              and says so rather than returning the least-bad row
                            </span>
                          ),
                        ],
                        ["Score", benchResult.score.toFixed(4)],
                      ]}
                    />
                  )}
                  <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
                    The bench is an admin tool and does NOT go through the MRM gate. The governed path is to
                    register the artifact below and invoke it as an agent.
                  </div>
                </>
              ) : (
                <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
                  This artifact's weights live on the training backend
                  {artifactDetail.data.artifact.location ? ` (${artifactDetail.data.artifact.location})` : ""}.
                  RegulAIt holds a reference and cannot run inference against it here — register the endpoint
                  that serves it as a custom LLM provider instead.
                </div>
              )}

              {!artifactDetail.data.artifact.agentId && artifactDetail.data.artifact.queryable && (
                <>
                  <div className={v.sectionTitle} style={{ marginTop: "var(--s3)" }}>
                    Register for inference
                  </div>
                  <form
                    className={a.formRow}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act.run(async () => {
                        await api.post(`/v1/llm/artifacts/${selectedArtifact}/register`, {
                          agentName: regName,
                          intendedUse: regUse,
                        });
                        setRegName("");
                        setRegUse("");
                        await artifacts.refetch();
                        await artifactDetail.refetch();
                      }, "Registered — it now has a model card and is subject to the MRM gate");
                    }}
                  >
                    <Field label="Agent name">
                      <Input value={regName} onChange={(e) => setRegName(e.target.value)} required />
                    </Field>
                    <Field label="Intended use (goes on the model card)" grow>
                      <Input value={regUse} onChange={(e) => setRegUse(e.target.value)} required />
                    </Field>
                    <Button type="submit" variant="primary" disabled={act.busy || !regName || !regUse}>
                      Register
                    </Button>
                  </form>
                  <div className={v.faint}>
                    Registering mints a registry agent at no more than the anchor agent's tier and an
                    ADR-0045 model card carrying this backend's own stated limits. With MRM enforcement on,
                    it stays undispatchable until a human accepts the risk. It is left UNPRICED on purpose:
                    nothing is billed for serving it, and a zero price would make the optimizer route
                    everything onto it because it looked free.
                  </div>
                </>
              )}

              {artifactDetail.data.artifact.agentId && (
                <div className={v.faint} style={{ marginTop: "var(--s3)" }}>
                  Next: <Link to="/admin/evals">evaluate it</Link> against a golden dataset (ADR-0044), and{" "}
                  <Link to="/admin/model-risk">sign off its model card</Link> (ADR-0045) before anyone
                  depends on it.
                </div>
              )}
            </Card>
          )}
        </QueryGate>
      </div>
    </>
  );
}
