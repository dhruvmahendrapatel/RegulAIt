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
  type Tone,
} from "../../../ui/kit";
import { KV, QueryGate, Stat, optionEls, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

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
}

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
  const act = useAction();
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [kind, setKind] = useState("");
  const [sessionId, setSessionId] = useState("");
  // ADR-0173 batch 2b: the run graph links a step to its trace (?trace=<id>)
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(() => params.get("trace"));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const qs = new URLSearchParams();
  if (deniedOnly) qs.set("deniedOnly", "true");
  if (kind) qs.set("kind", kind);
  if (sessionId) qs.set("sessionId", sessionId);
  qs.set("limit", "100");

  const list = useQuery({
    queryKey: ["admin", "traces", qs.toString()],
    queryFn: () =>
      api.get<{ traces: TraceRow[]; scope: string; note: string }>(`/v1/traces?${qs.toString()}`),
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
                    <div className={v.row}>
                      <Button
                        size="sm"
                        onClick={() =>
                          act.run(
                            () => api.post("/v1/tracing/export", { dryRun: true, limit: 25 }),
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
                            () => api.post("/v1/tracing/export", { limit: 100 }),
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
                        className={v.listRow}
                        onClick={() => setSessionId(s.sessionId ?? "")}
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
        <Card title="Traces">
          <div className={v.stack}>
            {list.data?.note && <p className={v.faint}>{list.data.note}</p>}
            <div className={v.row}>
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value)}>
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
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  placeholder="any"
                />
              </Field>
              <Field label="Governance">
                <Select
                  value={deniedOnly ? "denied" : ""}
                  onChange={(e) => setDeniedOnly(e.target.value === "denied")}
                >
                  <option value="">everything</option>
                  <option value="denied">only traces where something was REFUSED</option>
                </Select>
              </Field>
            </div>
            <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
              {(list.data?.traces ?? []).length === 0 ? (
                <EmptyState
                  title="No traces match"
                  body="Make a governed call — or clear the filters."
                />
              ) : (
                <Table
                  rows={list.data!.traces}
                  rowKey={(t) => t.id}
                  columns={[
                    { key: "trace", header: "Trace", render: (t) => (
                        <Button size="sm" variant="ghost" onClick={() => setSelected(t.id)}>
                          {t.name}
                        </Button>
                      ),
                    },
                    { key: "kind", header: "Kind", render: (t) => KIND_LABEL[t.kind] ?? t.kind },
                    { key: "status", header: "Status", render: (t) => (
                        <Badge tone={STATUS_TONE[t.status] ?? "info"}>{statusWord(t.status)}</Badge>
                      ),
                    },
                    { key: "refused", header: "Refused", render: (t) =>
                        t.deniedSpanCount > 0 ? (
                          <Badge tone="danger" title="a governance decision refused something in this trace">
                            {t.deniedSpanCount}
                          </Badge>
                        ) : (
                          <span className={v.faint}>—</span>
                        ),
                    },
                    { key: "spans", header: "Spans", render: (t) => t.spanCount },
                    { key: "tokens", header: "Tokens", render: (t) => (
                        <span className={v.num}>
                          {t.inputTokens}/{t.outputTokens}
                        </span>
                      ),
                    },
                    { key: "cost", header: "Cost", render: (t) => fmtUsd(t.costUsd) },
                    { key: "took", header: "Took", render: (t) => fmtDur(t.durationMs) },
                    { key: "when", header: "When", render: (t) => ago(t.startedAt) },
                  ]}
                />
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

                  <div className={v.stackTight}>
                    {rows.map((s) => {
                      const open = expanded[s.id] ?? false;
                      return (
                        <div key={s.id} className={v.stackTight}>
                          <button
                            className={v.listRow}
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
