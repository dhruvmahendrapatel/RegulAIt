/**
 * ADR-0070 — TRACES. The one slice of the parity wave that is a VIEWING
 * feature, so the screen is the deliverable rather than an optional extra.
 *
 * FIVE THINGS THIS SCREEN EXISTS TO PUT IN FRONT OF A HUMAN, rather than in an
 * ADR nobody opens:
 *
 *  - **The denial is the headline.** The list leads with a "governance refused
 *    something" filter and every trace carrying a denied span is badged. The
 *    most valuable trace in this product is the one that shows why NOTHING
 *    happened, and a viewer that only made successes easy to find would bury
 *    exactly that.
 *  - **A deny span states its reason inline**, in the tree, at the row — not
 *    behind an expander, not in a tooltip. `status_reason` is the governance
 *    kernel's own words, verbatim.
 *  - **A fallback hop renders as a CHILD of the attempt that failed**, because
 *    that is what it is in the database. "I asked for X, it broke, and here is
 *    what answered instead" reads off the indentation.
 *  - **Every cost figure names the ledger row it came from.** The span carries
 *    `usageEventId`; the row shows it. A number with no provenance in a
 *    governance product is a number somebody will eventually dispute.
 *  - **Scope and limits are on the page.** The scope note says plainly that a
 *    trace shows what the GATEWAY mediated and nothing else, and the export
 *    card says plainly that no exporter is configured and that this is the
 *    shipped, air-gapped-correct state rather than a fault.
 *
 * ADR-0173 batch 2c — TRACES AS THE EVIDENCE SPINE. The list takes the shared
 * trace filter (agent, model, cost, latency, score, flagged, tag); a trace
 * carries key/value tag chips (click one to filter by it; the owner or an
 * admin edits them in the tree); several traces can be selected and added to
 * an evaluation dataset, sent to an annotation queue, or tagged in one go, each
 * answering what was added and what was skipped and why. The export card picks
 * the attribute vocabulary (OpenTelemetry GenAI, or OpenInference). The
 * "Automations" tab is a slot: `TracesAutomationsTab` is replaced by the
 * automation-rules UI.
 *
 * House pattern: react-router + TanStack Query + the owned kit, following
 * `RegulAItLlmPage.tsx`.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import { ago, fmtDur, fmtUsd, shortId } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Tabs,
  type Tone,
} from "../../../ui/kit";
import { KV, QueryGate, Stat, agentOpts, optionEls, useAction, useAgents } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import t from "./traces.module.css";
// ADR-0173 batch 2c: THE AUTOMATIONS SLOT. This import is the mount point the
// automation-rules UI replaces (the file, not this line).
import TracesAutomationsTab from "./TracesAutomationsTab";
import {
  EMPTY_TRACE_FILTERS,
  activeFilterCount,
  bulkSentence,
  reasonWords,
  tagProblem,
  traceFilterProblem,
  traceListQuery,
  type BulkOutcome,
  type TraceListFilters,
} from "./tracesQuery";

// ---------------------------------------------------------------------------
// mirrors of the gateway's read projections
// ---------------------------------------------------------------------------

interface TraceRow {
  id: string;
  sessionId: string | null;
  kind: string;
  rootRefId: string | null;
  name: string;
  userId: string;
  projectId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  spanCount: number;
  deniedSpanCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** ADR-0173 batch 2c */
  tags?: TraceTag[];
}

interface TraceTag {
  key: string;
  value: string;
}

interface TraceScore {
  spanId: string | null;
  source: string;
  name: string;
  value: number | null;
  label: string | null;
}

interface SpanNode {
  id: string;
  parentSpanId: string | null;
  seq: number;
  depth: number;
  kind: string;
  name: string;
  status: string;
  statusReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  usageEventId: string | null;
  auditLogId: string | null;
  runId: string | null;
  nodeId: string | null;
  agentId: string | null;
  mcpServerId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  inputPreview: string | null;
  outputPreview: string | null;
  contentWithheld: boolean;
  attributes: Record<string, unknown> | null;
  orphaned?: boolean;
  children: SpanNode[];
}

interface TraceDetail {
  trace: TraceRow;
  tree: SpanNode[];
  totals: {
    spans: number;
    denied: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    maxDepth: number;
  };
  partial: boolean;
  truncated: boolean;
  spanLimit?: number;
  note: string;
  tags?: TraceTag[];
  scores?: TraceScore[];
}

interface SessionRow {
  sessionId: string | null;
  kind: string;
  userId: string;
  traceCount: number;
  spanCount: number;
  deniedSpanCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  startedAt: string;
  lastAt: string;
}

interface TracingConfig {
  enabled: boolean;
  captureContent: boolean;
  previewMaxChars: number;
  otlp: { configured: boolean; endpoint: string | null; serviceName: string; headerNames: string[] };
  limits: string;
  retention: string;
  note: string;
  profiles?: string[];
  standards?: Record<string, string>;
}

interface DatasetOption {
  id: string;
  name: string;
  version: number;
  frozen?: boolean;
}

interface QueueOption {
  id: string;
  name: string;
}

const PROFILE_LABEL: Record<string, string> = {
  otel_genai: "OpenTelemetry GenAI (default)",
  openinference: "OpenInference",
};

// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, Tone> = {
  ok: "ok",
  running: "info",
  error: "warn",
  denied: "danger",
};

/** A denial is not an error and is not a success. It gets its own word. */
function statusWord(status: string): string {
  return status === "denied" ? "DENIED" : status.toUpperCase();
}

const KIND_LABEL: Record<string, string> = {
  run: "run",
  run_node: "node",
  llm: "model call",
  fallback_hop: "fallback hop",
  tool: "tool call",
  connector: "connector",
  policy: "governance",
  workflow_stage: "stage",
  eval_case: "eval case",
};

function flatten(nodes: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (ns: SpanNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------------------

export default function TracesPage() {
  const [tab, setTab] = useState("traces");
  return (
    <>
      <PageHeader
        title="Traces"
        sub={
          "One causal tree per governed call: an orchestration run, its nodes, every model turn, every " +
          "tool call — and, the reason this exists, every governance decision that refused one. A " +
          "refusal is a SPAN carrying its reason, not an absence. Nothing here is a second copy of the " +
          "ledger: a span references the usage_events row its cost came from and the audit row its " +
          "decision came from."
        }
      />
      <div className={v.stack}>
        <Tabs
          tabs={[
            { id: "traces", label: "Traces" },
            { id: "automations", label: "Automations" },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === "automations" ? <TracesAutomationsTab /> : <TracesView />}
      </div>
    </>
  );
}

function TracesView() {
  const act = useAction();
  const [filters, setFilters] = useState<TraceListFilters>(EMPTY_TRACE_FILTERS);
  const setFilter = <K extends keyof TraceListFilters>(k: K, value: TraceListFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: value }));
  // ADR-0173 batch 2b: the run graph links a step to its trace (?trace=<id>)
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(() => params.get("trace"));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // ADR-0173 batch 2c: multi-select, the bulk actions and their outcome
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [datasetId, setDatasetId] = useState("");
  const [queueId, setQueueId] = useState("");
  const [bulkKey, setBulkKey] = useState("");
  const [bulkValue, setBulkValue] = useState("");
  const [bulk, setBulk] = useState<{ sentence: string; skipped: BulkOutcome["skipped"] } | null>(null);
  const [profile, setProfile] = useState("otel_genai");
  const [tagKey, setTagKey] = useState("");
  const [tagValue, setTagValue] = useState("");

  const filterProblem = traceFilterProblem(filters);
  // a half-typed filter keeps the last good query rather than sending a 400
  const [lastGoodQs, setLastGoodQs] = useState(() => traceListQuery(EMPTY_TRACE_FILTERS));
  const qs = filterProblem ? lastGoodQs : traceListQuery(filters);
  if (!filterProblem && qs !== lastGoodQs) setLastGoodQs(qs);

  const list = useQuery({
    queryKey: ["admin", "traces", qs],
    queryFn: () =>
      api.get<{ traces: TraceRow[]; total?: number; scope: string; note: string }>(`/v1/traces?${qs}`),
  });
  const agents = useAgents();
  const anyPicked = picked.size > 0;
  const datasets = useQuery({
    queryKey: ["admin", "trace-action-datasets"],
    enabled: anyPicked,
    queryFn: () => api.get<{ datasets: DatasetOption[] }>("/v1/evals/datasets"),
  });
  const queues = useQuery({
    queryKey: ["admin", "trace-action-queues"],
    enabled: anyPicked,
    retry: false,
    queryFn: () => api.get<{ queues: QueueOption[] }>("/v1/annotation-queues"),
  });
  const sessions = useQuery({
    queryKey: ["admin", "trace-sessions"],
    queryFn: () => api.get<{ sessions: SessionRow[]; scope: string }>("/v1/sessions?limit=50"),
  });
  const config = useQuery({
    queryKey: ["admin", "tracing-config"],
    queryFn: () => api.get<TracingConfig>("/v1/tracing/config"),
  });
  const detail = useQuery({
    queryKey: ["admin", "trace", selected],
    enabled: Boolean(selected),
    queryFn: () => api.get<TraceDetail>(`/v1/traces/${selected}`),
  });

  const rows = useMemo(() => flatten(detail.data?.tree ?? []), [detail.data]);
  const visible = list.data?.traces ?? [];
  const allPicked = visible.length > 0 && visible.every((r) => picked.has(r.id));
  const togglePick = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** one bulk action: post, then say what was added and what was skipped */
  const runBulk = (action: string, target: string, call: () => Promise<BulkOutcome>) =>
    act.run(async () => {
      const out = await call();
      const sentence = bulkSentence(action, target, out);
      setBulk({ sentence, skipped: out.skipped ?? [] });
      return sentence;
    }, null);
  const pickedIds = [...picked];
  const datasetName = datasets.data?.datasets.find((d) => d.id === datasetId)?.name ?? "the dataset";
  const queueName = queues.data?.queues.find((q) => q.id === queueId)?.name ?? "the queue";
  const bulkTagProblem = bulkKey ? tagProblem(bulkKey, bulkValue) : null;
  const treeTagProblem = tagKey ? tagProblem(tagKey, tagValue) : null;

  return (
    <>
      <div className={v.stack}>
        {/* --- posture ------------------------------------------------- */}
        <QueryGate
          loading={config.isLoading}
          error={config.error}
          onRetry={() => void config.refetch()}
        >
          {config.data && (
            <Card title="Posture">
              <div className={v.stack}>
                <p className={v.dim}>
                  {config.data.enabled
                    ? "Recording is on. Turn it off in Organization settings to stop writing spans entirely."
                    : "RECORDING IS OFF — no span is being written. Nothing below will grow."}
                </p>
                <div className={v.grid}>
                  <Stat value={config.data.enabled ? "on" : "off"} label="Recording" />
                  <Stat
                    value={config.data.captureContent ? "stored" : "not stored"}
                    label="Prompts & outputs"
                  />
                  <Stat value={config.data.previewMaxChars} label="Preview limit (chars)" />
                  <Stat
                    value={config.data.otlp.configured ? "configured" : "none"}
                    label="OTLP exporter"
                  />
                </div>
                {!config.data.otlp.configured && (
                  <p className={v.dim}>
                    No OTLP endpoint is configured, so regulAIt opens no outbound telemetry
                    connection at all. <strong>That is the shipped state, not a fault</strong> —
                    air-gapped is the primary deployment mode and traces are fully usable locally.
                    Set <code>tracingOtlpEndpoint</code> in Organization settings to export; the
                    host must be on the egress allow-list first.
                  </p>
                )}
                {config.data.otlp.configured && (
                  <>
                    <KV
                      rows={[
                        ["Endpoint", <span className={v.mono}>{config.data.otlp.endpoint}</span>],
                        ["Service name", config.data.otlp.serviceName],
                        [
                          "Headers",
                          config.data.otlp.headerNames.length
                            ? config.data.otlp.headerNames.join(", ") + " (values redacted)"
                            : "none",
                        ],
                      ]}
                    />
                    <div className={a.formRow}>
                      <Field
                        label="Export profile"
                        help={
                          "OpenTelemetry GenAI is the standard vocabulary. OpenInference adds its " +
                          "span kinds, flattened messages and a cost key (llm.cost.total) for backends " +
                          "that read it. Neither profile carries prompts or outputs when content " +
                          "capture is off."
                        }
                      >
                        <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
                          {(config.data.profiles ?? ["otel_genai"]).map((p) => (
                            <option key={p} value={p}>
                              {PROFILE_LABEL[p] ?? p}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Button
                        size="sm"
                        onClick={() =>
                          act.run(
                            () => api.post("/v1/tracing/export", { dryRun: true, limit: 25, profile }),
                            "Built the OTLP payload and adjudicated egress — nothing was sent.",
                          )
                        }
                      >
                        Dry run
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          act.run(
                            () => api.post("/v1/tracing/export", { limit: 100, profile }),
                            "Exported to the configured OTLP endpoint.",
                          )
                        }
                      >
                        Export now
                      </Button>
                    </div>
                  </>
                )}
                {/* A REFUSAL AND AN OUTAGE ARE DIFFERENT THINGS, AND THE
                    EXPORT SAYS SO. Before 2026-08-15 a governance DENY left
                    here as OTel status ERROR, so in somebody else's Grafana the
                    product working looked exactly like the product failing.
                    The mapping is on the page because an operator who has to
                    read an ADR to know how their dashboard will read is not
                    actually told. */}
                <div className={v.sectionTitle}>How a status leaves as OpenTelemetry</div>
                <KV
                  rows={[
                    [
                      <Badge tone="ok">OK</Badge>,
                      "OTel Ok — the call completed.",
                    ],
                    [
                      <Badge tone="danger">DENIED</Badge>,
                      "OTel Unset — NOT an error. A governance refusal is this product " +
                        "working, and the OTel spec reserves Error for an operation that " +
                        "contains one. The reason and the rule ride regulait.reason and " +
                        "regulait.rule.id, and every span carries regulait.outcome so a " +
                        "refusal is one filter clause in any backend.",
                    ],
                    [
                      <Badge tone="warn">ERROR</Badge>,
                      "OTel Error, plus the standard error.type attribute — a real failure " +
                        "still shows up on an error dashboard built by somebody who has " +
                        "never heard of RegulAIt.",
                    ],
                  ]}
                />
                <p className={v.faint}>{config.data.limits}</p>
                {config.data.standards && (
                  <p className={v.faint}>
                    Pinned conventions: OpenTelemetry semantic conventions{" "}
                    {config.data.standards["otelSemanticConventions"]}, OpenInference{" "}
                    {config.data.standards["openInferenceSemanticConventions"]}.
                  </p>
                )}
                <p className={v.faint}>{config.data.retention}</p>
              </div>
            </Card>
          )}
        </QueryGate>

        {/* --- sessions ------------------------------------------------- */}
        <Card title="Sessions">
          <p className={v.dim}>
            Related traces grouped so a multi-turn conversation or a long-running workflow reads as
            one thing.
          </p>
          <QueryGate
            loading={sessions.isLoading}
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          >
            {(sessions.data?.sessions ?? []).length === 0 ? (
              <EmptyState title="No sessions yet" body="A conversation or a run will create one." />
            ) : (
              <Table
                rows={sessions.data!.sessions}
                rowKey={(s) => `${s.sessionId}:${s.kind}`}
                columns={[
                  { key: "session", header: "Session", render: (s) => (
                      <button
                        className={`${v.listRow} ${t.rowButton}`}
                        onClick={() => setFilter("sessionId", s.sessionId ?? "")}
                        title="filter the trace list to this session"
                      >
                        <span className={v.mono}>{shortId(s.sessionId ?? "")}</span>
                      </button>
                    ),
                  },
                  { key: "kind", header: "Kind", render: (s) => KIND_LABEL[s.kind] ?? s.kind },
                  { key: "traces", header: "Traces", render: (s) => s.traceCount },
                  { key: "spans", header: "Spans", render: (s) => s.spanCount },
                  { key: "refused", header: "Refused", render: (s) =>
                      s.deniedSpanCount > 0 ? (
                        <Badge tone="danger">{s.deniedSpanCount}</Badge>
                      ) : (
                        <span className={v.faint}>—</span>
                      ),
                  },
                  { key: "cost", header: "Cost", render: (s) => fmtUsd(s.costUsd) },
                  { key: "last", header: "Last", render: (s) => ago(s.lastAt) },
                ]}
              />
            )}
          </QueryGate>
        </Card>

        {/* --- trace list ------------------------------------------------ */}
        <Card
          title="Traces"
          actions={
            activeFilterCount(filters) > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_TRACE_FILTERS)}>
                Clear filters ({activeFilterCount(filters)})
              </Button>
            ) : undefined
          }
        >
          <div className={v.stack}>
            {list.data?.note && <p className={v.faint}>{list.data.note}</p>}
            <div className={a.formRow}>
              <Field label="Kind">
                <Select value={filters.kind} onChange={(e) => setFilter("kind", e.target.value)}>
                  {optionEls(
                    ["dispatch", "run", "conversation", "tool", "workflow", "eval"].map((k) => ({
                      v: k,
                      l: KIND_LABEL[k] ?? k,
                    })),
                    "any",
                  )}
                </Select>
              </Field>
              <Field label="Session id">
                <Input
                  value={filters.sessionId}
                  onChange={(e) => setFilter("sessionId", e.target.value)}
                  placeholder="any"
                />
              </Field>
              <Field label="Governance">
                <Select
                  value={filters.deniedOnly ? "denied" : ""}
                  onChange={(e) => setFilter("deniedOnly", e.target.value === "denied")}
                >
                  <option value="">everything</option>
                  <option value="denied">only traces where something was REFUSED</option>
                </Select>
              </Field>
              <Field label="Agent">
                <Select value={filters.agentId} onChange={(e) => setFilter("agentId", e.target.value)}>
                  {optionEls(agentOpts(agents.data?.agents), "any")}
                </Select>
              </Field>
              <Field label="Model">
                <Input value={filters.model} onChange={(e) => setFilter("model", e.target.value)} placeholder="any" />
              </Field>
              <Field label="Cost at least (USD)">
                <Input
                  inputMode="decimal"
                  value={filters.minCostUsd}
                  onChange={(e) => setFilter("minCostUsd", e.target.value)}
                  placeholder="0"
                />
              </Field>
              <Field label="Latency at least (ms)">
                <Input
                  inputMode="numeric"
                  value={filters.minLatencyMs}
                  onChange={(e) => setFilter("minLatencyMs", e.target.value)}
                  placeholder="0"
                />
              </Field>
            </div>
            <div className={a.formRow}>
              <Field label="Score name">
                <Input
                  value={filters.scoreName}
                  onChange={(e) => setFilter("scoreName", e.target.value)}
                  placeholder="any"
                />
              </Field>
              <Field label="Score from">
                <Input inputMode="decimal" value={filters.scoreMin} onChange={(e) => setFilter("scoreMin", e.target.value)} />
              </Field>
              <Field label="Score to">
                <Input inputMode="decimal" value={filters.scoreMax} onChange={(e) => setFilter("scoreMax", e.target.value)} />
              </Field>
              <Field label="Evaluation">
                <Select
                  value={filters.flagged}
                  onChange={(e) => setFilter("flagged", e.target.value as TraceListFilters["flagged"])}
                >
                  <option value="">any</option>
                  <option value="true">flagged by a trace evaluation</option>
                  <option value="false">not flagged</option>
                </Select>
              </Field>
              <Field label="Tag key">
                <Input value={filters.tagKey} onChange={(e) => setFilter("tagKey", e.target.value)} placeholder="any" />
              </Field>
              <Field label="Tag value">
                <Input value={filters.tagValue} onChange={(e) => setFilter("tagValue", e.target.value)} placeholder="any" />
              </Field>
            </div>
            {filterProblem && (
              <div className={v.errLine} role="alert">
                {filterProblem} — the list still shows the last valid filter.
              </div>
            )}

            {/* --- the selection bar: the bulk actions ------------------- */}
            {anyPicked && (
              <div className={t.selectionBar} role="region" aria-label="Selected traces">
                <strong>
                  {picked.size} selected
                </strong>
                <Field label="Dataset">
                  <Select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                    <option value="">choose a dataset</option>
                    {(datasets.data?.datasets ?? []).map((d) => (
                      <option key={d.id} value={d.id} disabled={d.frozen}>
                        {d.name} v{d.version}
                        {d.frozen ? " (frozen)" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  disabled={!datasetId || act.busy}
                  onClick={() =>
                    void runBulk("Added", `to ${datasetName}`, () =>
                      api.post<BulkOutcome>(`/v1/evals/datasets/${datasetId}/from-traces`, { traceIds: pickedIds }),
                    )
                  }
                >
                  Add to dataset
                </Button>
                <Field label="Annotation queue">
                  <Select value={queueId} onChange={(e) => setQueueId(e.target.value)}>
                    <option value="">{queues.isError ? "no queues available" : "choose a queue"}</option>
                    {(queues.data?.queues ?? []).map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  disabled={!queueId || act.busy}
                  onClick={() =>
                    void runBulk("Sent", `to ${queueName}`, () =>
                      api.post<BulkOutcome>(`/v1/annotation-queues/${queueId}/items`, {
                        subjects: pickedIds.map((id) => ({ kind: "trace", id })),
                      }),
                    )
                  }
                >
                  Send to annotation queue
                </Button>
                <Field label="Tag key" error={bulkTagProblem}>
                  <Input value={bulkKey} onChange={(e) => setBulkKey(e.target.value)} placeholder="release" />
                </Field>
                <Field label="Tag value">
                  <Input value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} placeholder="2026.10" />
                </Field>
                <Button
                  size="sm"
                  disabled={!bulkKey || Boolean(bulkTagProblem) || act.busy}
                  onClick={() =>
                    void runBulk("Tagged", `${bulkKey.trim()}=${bulkValue}`, () =>
                      api.post<BulkOutcome>("/v1/traces/tags", { traceIds: pickedIds, key: bulkKey.trim(), value: bulkValue }),
                    )
                  }
                >
                  Tag selected
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}
            {bulk && (
              <div role="status" className={v.stackTight}>
                <span>{bulk.sentence}</span>
                {bulk.skipped.length > 0 && (
                  <ul className={t.skipped} aria-label="Skipped traces">
                    {bulk.skipped.map((sk) => (
                      <li key={sk.id}>
                        <span className={v.mono}>{shortId(sk.id)}</span> — {reasonWords(sk.reason)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
              {visible.length === 0 ? (
                <EmptyState
                  title="No traces match"
                  body="Make a governed call — or clear the filters."
                />
              ) : (
                <>
                  {typeof list.data?.total === "number" && (
                    <p className={v.faint}>
                      Showing {visible.length} of {list.data.total} matching trace
                      {list.data.total === 1 ? "" : "s"}.
                    </p>
                  )}
                  <Table
                    rows={visible}
                    rowKey={(r) => r.id}
                    columns={[
                      {
                        key: "pick",
                        width: "36px",
                        header: (
                          <input
                            type="checkbox"
                            className={t.check}
                            aria-label="Select every trace on this page"
                            checked={allPicked}
                            onChange={() =>
                              setPicked(allPicked ? new Set() : new Set(visible.map((r) => r.id)))
                            }
                          />
                        ),
                        render: (r) => (
                          <input
                            type="checkbox"
                            className={t.check}
                            aria-label={`Select trace ${r.name}`}
                            checked={picked.has(r.id)}
                            onChange={() => togglePick(r.id)}
                          />
                        ),
                      },
                      { key: "trace", header: "Trace", render: (r) => (
                          <Button size="sm" variant="ghost" onClick={() => setSelected(r.id)}>
                            {r.name}
                          </Button>
                        ),
                      },
                      { key: "kind", header: "Kind", render: (r) => KIND_LABEL[r.kind] ?? r.kind },
                      { key: "status", header: "Status", render: (r) => (
                          <Badge tone={STATUS_TONE[r.status] ?? "info"}>{statusWord(r.status)}</Badge>
                        ),
                      },
                      { key: "refused", header: "Refused", render: (r) =>
                          r.deniedSpanCount > 0 ? (
                            <Badge tone="danger" title="a governance decision refused something in this trace">
                              {r.deniedSpanCount}
                            </Badge>
                          ) : (
                            <span className={v.faint}>—</span>
                          ),
                      },
                      { key: "tags", header: "Tags", render: (r) =>
                          (r.tags ?? []).length === 0 ? (
                            <span className={v.faint}>—</span>
                          ) : (
                            <ul className={t.tagList}>
                              {(r.tags ?? []).map((tg) => (
                                <li key={tg.key} className={t.tag}>
                                  <button
                                    type="button"
                                    className={t.tagButton}
                                    title="show only traces with this tag"
                                    aria-label={`Filter by tag ${tg.key}=${tg.value}`}
                                    onClick={() => setFilters((f) => ({ ...f, tagKey: tg.key, tagValue: tg.value }))}
                                  >
                                    {tg.value ? `${tg.key}=${tg.value}` : tg.key}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ),
                      },
                      { key: "spans", header: "Spans", render: (r) => r.spanCount },
                      { key: "tokens", header: "Tokens", render: (r) => (
                          <span className={v.num}>
                            {r.inputTokens}/{r.outputTokens}
                          </span>
                        ),
                      },
                      { key: "cost", header: "Cost", render: (r) => fmtUsd(r.costUsd) },
                      { key: "took", header: "Took", render: (r) => fmtDur(r.durationMs) },
                      { key: "when", header: "When", render: (r) => ago(r.startedAt) },
                    ]}
                  />
                </>
              )}
            </QueryGate>
          </div>
        </Card>

        {/* --- the tree --------------------------------------------------- */}
        {selected && (
          <Card
            title={`Trace tree — ${detail.data ? detail.data.trace.name : "loading…"}`}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
            }
          >
            <QueryGate
              loading={detail.isLoading}
              error={detail.error}
              onRetry={() => void detail.refetch()}
            >
              {detail.data && (
                <div className={v.stack}>
                  <div className={v.grid}>
                    <Stat value={detail.data.totals.spans} label="Spans" />
                    <Stat value={detail.data.totals.denied} label="Refused" />
                    <Stat value={detail.data.totals.errors} label="Errors" />
                    <Stat value={fmtUsd(detail.data.totals.costUsd)} label="Cost" />
                    <Stat
                      value={`${detail.data.totals.inputTokens}/${detail.data.totals.outputTokens}`}
                      label="Tokens in/out"
                    />
                    <Stat value={fmtDur(detail.data.trace.durationMs)} label="Elapsed" />
                  </div>

                  {detail.data.partial && (
                    <div className={v.errLine} role="alert">
                      This tree is INCOMPLETE: the trace counted {detail.data.trace.spanCount} spans
                      and {rows.length} are stored. A span write was lost. The recorder never fails
                      the call it is tracing, which is why a hole is reported here rather than
                      hidden.
                    </div>
                  )}
                  {detail.data.truncated && (
                    <div className={v.errLine} role="alert">
                      Showing the first {detail.data.spanLimit} spans of a larger trace.
                    </div>
                  )}

                  {/* ADR-0173 batch 2c: tags (the owner or an admin edits them) */}
                  <div className={v.sectionTitle}>Tags</div>
                  {(detail.data.tags ?? []).length === 0 ? (
                    <p className={v.faint}>No tags yet.</p>
                  ) : (
                    <ul className={t.tagList} aria-label="Trace tags">
                      {(detail.data.tags ?? []).map((tg) => (
                        <li key={tg.key} className={t.tag}>
                          <span>{tg.value ? `${tg.key}=${tg.value}` : tg.key}</span>
                          {!tg.key.startsWith("regulait.") && (
                            <button
                              type="button"
                              className={t.tagRemove}
                              aria-label={`Remove tag ${tg.key}`}
                              onClick={() =>
                                void act.run(
                                  () =>
                                    api.del(`/v1/traces/${detail.data!.trace.id}/tags/${encodeURIComponent(tg.key)}`),
                                  `Removed tag ${tg.key}.`,
                                )
                              }
                            >
                              ×
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className={a.formRow}>
                    <Field label="New tag key" error={treeTagProblem}>
                      <Input value={tagKey} onChange={(e) => setTagKey(e.target.value)} placeholder="release" />
                    </Field>
                    <Field label="New tag value">
                      <Input value={tagValue} onChange={(e) => setTagValue(e.target.value)} placeholder="2026.10" />
                    </Field>
                    <Button
                      size="sm"
                      disabled={!tagKey || Boolean(treeTagProblem) || act.busy}
                      onClick={() =>
                        void act
                          .run(
                            () =>
                              api.put(
                                `/v1/traces/${detail.data!.trace.id}/tags/${encodeURIComponent(tagKey.trim())}`,
                                { value: tagValue },
                              ),
                            `Tagged ${tagKey.trim()}${tagValue ? `=${tagValue}` : ""}.`,
                          )
                          .then((ok) => {
                            if (ok) {
                              setTagKey("");
                              setTagValue("");
                            }
                          })
                      }
                    >
                      Add tag
                    </Button>
                  </div>

                  {(detail.data.scores ?? []).length > 0 && (
                    <>
                      <div className={v.sectionTitle}>Scores</div>
                      <Table<TraceScore>
                        rows={detail.data.scores}
                        rowKey={(sc) => `${sc.source}:${sc.name}:${sc.spanId ?? "trace"}:${sc.value ?? ""}:${sc.label ?? ""}`}
                        columns={[
                          { key: "name", header: "Score", render: (sc) => sc.name },
                          { key: "value", header: "Value", render: (sc) => (sc.value == null ? "—" : <span className={v.num}>{sc.value}</span>) },
                          { key: "label", header: "Label", render: (sc) => sc.label ?? "—" },
                          { key: "source", header: "From", render: (sc) => sc.source.replace(/_/g, " ") },
                          { key: "on", header: "On", render: (sc) => (sc.spanId ? <span className={v.mono}>span {shortId(sc.spanId)}</span> : "the whole trace") },
                        ]}
                      />
                    </>
                  )}

                  <div className={v.stackTight}>
                    {rows.map((s) => {
                      const open = expanded[s.id] ?? false;
                      return (
                        <div key={s.id} className={v.stackTight}>
                          <button
                            className={`${v.listRow} ${t.rowButton}`}
                            style={{ paddingLeft: `${8 + s.depth * 20}px`, width: "100%", textAlign: "left" }}
                            onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                            aria-expanded={open}
                          >
                            <span className={v.row}>
                              <span className={v.faint} aria-hidden>
                                {s.depth > 0 ? "└" : "•"}
                              </span>
                              <Badge tone={STATUS_TONE[s.status] ?? "info"}>
                                {statusWord(s.status)}
                              </Badge>
                              <span className={v.faint}>{KIND_LABEL[s.kind] ?? s.kind}</span>
                              <strong>{s.name}</strong>
                              {s.model && <span className={v.mono}>{s.model}</span>}
                              <span className={v.grow} />
                              {s.inputTokens != null && (
                                <span className={v.num} title="input/output tokens">
                                  {s.inputTokens}/{s.outputTokens ?? 0}
                                </span>
                              )}
                              {s.costUsd != null && <span className={v.num}>{fmtUsd(s.costUsd)}</span>}
                              <span className={v.num}>{fmtDur(s.durationMs)}</span>
                            </span>
                          </button>
                          {/* THE REASON IS NOT BEHIND AN EXPANDER. A refusal
                              with a hidden reason explains nothing. */}
                          {s.statusReason && (
                            <div
                              className={a.snippet}
                              style={{ marginLeft: `${28 + s.depth * 20}px` }}
                            >
                              {s.status === "denied" ? "Refused: " : "Failed: "}
                              {s.statusReason}
                              {s.status === "denied" && (
                                <span className={v.faint}>
                                  {" "}
                                  — a refusal, not a failure. This exports as OTel Unset with
                                  regulait.outcome=denied.
                                </span>
                              )}
                            </div>
                          )}
                          {s.orphaned && (
                            <div className={v.faint} style={{ marginLeft: `${28 + s.depth * 20}px` }}>
                              Its recorded parent is not in this view, so it is shown at the root.
                            </div>
                          )}
                          {open && (
                            <div style={{ marginLeft: `${28 + s.depth * 20}px` }}>
                              <KV
                                rows={[
                                  ["Span id", <span className={v.mono}>{s.id}</span>],
                                  [
                                    "Parent",
                                    s.parentSpanId ? (
                                      <span className={v.mono}>{shortId(s.parentSpanId)}</span>
                                    ) : (
                                      "root"
                                    ),
                                  ],
                                  ["Provider / model", [s.provider, s.model].filter(Boolean).join(" / ") || "—"],
                                  [
                                    "Cost source",
                                    s.usageEventId ? (
                                      <span className={v.mono} title="the usage_events row this span's figures were copied from">
                                        usage_events {shortId(s.usageEventId)}
                                      </span>
                                    ) : (
                                      "no ledger row (nothing was billed)"
                                    ),
                                  ],
                                  [
                                    "Decision record",
                                    s.auditLogId ? (
                                      <span className={v.mono}>audit_log {shortId(s.auditLogId)}</span>
                                    ) : (
                                      "—"
                                    ),
                                  ],
                                  [
                                    "Run / node",
                                    s.runId ? `${shortId(s.runId)}${s.nodeId ? ` / ${s.nodeId}` : ""}` : "—",
                                  ],
                                  ["Started", new Date(s.startedAt).toLocaleString()],
                                ]}
                              />
                              {s.contentWithheld && (
                                <p className={v.dim}>
                                  Content was WITHHELD by a governance decision — what is stored is
                                  the marker, not the text.
                                </p>
                              )}
                              {s.inputPreview && (
                                <>
                                  <div className={v.sectionTitle}>Input</div>
                                  <CodeBlock maxHeight="220px">{s.inputPreview}</CodeBlock>
                                </>
                              )}
                              {s.outputPreview && (
                                <>
                                  <div className={v.sectionTitle}>Output</div>
                                  <CodeBlock maxHeight="220px">{s.outputPreview}</CodeBlock>
                                </>
                              )}
                              {!s.inputPreview && !s.outputPreview && !s.contentWithheld && (
                                <p className={v.faint}>
                                  No content stored for this span — either this deployment records
                                  metadata only, or this span never carried any.
                                </p>
                              )}
                              {s.attributes && Object.keys(s.attributes).length > 0 && (
                                <>
                                  <div className={v.sectionTitle}>Attributes</div>
                                  <CodeBlock maxHeight="180px">
                                    {JSON.stringify(s.attributes, null, 2)}
                                  </CodeBlock>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className={v.faint}>{detail.data.note}</p>
                </div>
              )}
            </QueryGate>
          </Card>
        )}
      </div>
    </>
  );
}
