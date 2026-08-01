/**
 * Run detail — the DAG drawn as a real graph, per-node states, live worker
 * streaming (the multiplexed per-node SSE envelope: node_start / node_delta /
 * node_complete / run_complete), accept + retry + auto-advance + abort.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errMessage, readSse, ssePost } from "../../api/client";
import type { MyAgentsResponse, NodeStatus, RunDetailResponse, RunGraphNode } from "../../api/types";
import { ago, approvalStageLabel, fmtDur, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  ErrorState,
  IdChip,
  Meter,
  SkeletonBlock,
  StatusBadge,
  StatusDot,
  type Tone,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { DecisionLedgerCard, PmLinksCard } from "../pm/PmAndDecisions";
import v from "../views.module.css";
import s from "./runs.module.css";

const STOP_LABELS: Record<string, string> = {
  completed: "run completed",
  awaiting_review: "stopped: review required",
  blocked: "stopped: a node is blocked",
  budget_exceeded: "stopped: budget cap reached (estimated)",
  budget_exceeded_measured: "stopped: budget cap reached",
  max_nodes_reached: "stopped: pass node-cap reached",
  iteration_cap: "stopped: iteration cap reached",
  in_progress_elsewhere: "stopped: a node is still in progress",
  no_ready_nodes: "stopped: nothing is ready to dispatch",
  terminal: "stopped: run is terminal",
};

const nodeTone: Record<NodeStatus, Tone> = {
  not_started: "neutral",
  in_progress: "info",
  blocked: "danger",
  in_review: "warn",
  done: "ok",
};

interface LivePane {
  nodeId: string;
  agentName?: string;
  text: string;
  status: "streaming" | "done" | "failed" | string;
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const { auth } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userId = auth?.userId ?? null;
  const [abortOpen, setAbortOpen] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [acceptReviews, setAcceptReviews] = useState(true);
  const [livePanes, setLivePanes] = useState<LivePane[]>([]);
  const livePaneRefs = useRef(new Map<string, HTMLPreElement>());

  const q = useQuery({
    queryKey: ["run", runId],
    enabled: Boolean(runId),
    queryFn: () => api.get<RunDetailResponse>(`/v1/runs/${runId}`),
  });
  const agentsQ = useQuery({
    queryKey: ["my-agents", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
  });
  const agentNames = useMemo(
    () => Object.fromEntries((agentsQ.data?.agents ?? []).map((a) => [a.agentId, a.name])),
    [agentsQ.data],
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
    [queryClient, runId],
  );

  const postEvent = useCallback(
    async (payload: Record<string, unknown>, label: string) => {
      try {
        await api.post(`/v1/runs/${runId}/events`, payload);
        toast(label, "success");
        void refresh();
      } catch (e) {
        toast(`✗ ${e instanceof Error ? e.message : e}`, "error");
      }
    },
    [runId, toast, refresh],
  );

  const patchPane = useCallback((nodeId: string, fn: (p: LivePane) => LivePane) => {
    setLivePanes((panes) => {
      const idx = panes.findIndex((p) => p.nodeId === nodeId);
      if (idx === -1) return [...panes, fn({ nodeId, text: "", status: "streaming" })];
      const copy = [...panes];
      copy[idx] = fn(copy[idx]!);
      return copy;
    });
  }, []);

  // pillar 7 live streaming: the multiplexed per-node envelope — every event
  // keyed by nodeId so parallel-wave deltas interleave safely, one pane each
  const autoAdvance = useCallback(async () => {
    setAutoBusy(true);
    setLivePanes([]);
    try {
      const res = await ssePost(`/v1/runs/${runId}/auto`, {
        stream: true,
        acceptReviews,
      });
      if (res.ok && res.headers.get("content-type")?.includes("event-stream")) {
        let final: { stoppedReason?: string } | null = null;
        await readSse(res, (ev, raw) => {
          const data = raw as {
            nodeId?: string;
            agent?: string;
            text?: string;
            status?: string;
            stoppedReason?: string;
          };
          if (ev === "node_start" && data.nodeId) {
            const agentName = agentNames[data.agent ?? ""] ?? "worker";
            patchPane(data.nodeId, (p) => ({ ...p, agentName, status: "streaming" }));
          }
          if (ev === "node_delta" && data.nodeId) {
            patchPane(data.nodeId, (p) => ({ ...p, text: p.text + (data.text ?? "") }));
            const el = livePaneRefs.current.get(data.nodeId);
            if (el) el.scrollTop = el.scrollHeight;
          }
          if (ev === "node_complete" && data.nodeId) {
            patchPane(data.nodeId, (p) => ({ ...p, status: data.status ?? "done" }));
          }
          if (ev === "run_complete") final = data;
        });
        const label = final
          ? (STOP_LABELS[(final as { stoppedReason?: string }).stoppedReason ?? ""] ??
            `stopped: ${String((final as { stoppedReason?: string }).stoppedReason ?? "").replaceAll("_", " ")}`)
          : "stream ended early";
        toast(`Auto-advance — ${label}`);
        void refresh();
        return;
      }
      // graceful degrade: buffered JSON (block-mode PII suppresses streaming)
      type BufferedAuto = { streamingSuppressed?: boolean; stoppedReason?: string; steps?: unknown[] };
      let j: BufferedAuto | null = null;
      try {
        j = (await res.json()) as BufferedAuto;
      } catch {
        j = null;
      }
      if (!res.ok) {
        toast(`✗ ${errMessage(res.status, j ?? {})}`, "error");
        void refresh();
        return;
      }
      if (j?.streamingSuppressed) {
        toast(
          "Streaming is disabled for this project: its PII mode is block, so worker output is checked in full before it is shown.",
        );
      }
      const label = STOP_LABELS[j?.stoppedReason ?? ""] ?? `stopped: ${String(j?.stoppedReason ?? "").replaceAll("_", " ")}`;
      toast(`Auto-advance took ${j?.steps?.length ?? 0} step${(j?.steps?.length ?? 0) === 1 ? "" : "s"} — ${label}`);
      void refresh();
    } catch (e) {
      toast(`✗ ${e instanceof Error ? e.message : e}`, "error");
      void refresh();
    } finally {
      setAutoBusy(false);
    }
  }, [runId, acceptReviews, agentNames, patchPane, toast, refresh]);

  if (q.isLoading) {
    return (
      <>
        <PageHeader title="Run" />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (q.isError || !q.data) {
    const err = q.error as { status?: number; message?: string } | null;
    return (
      <>
        <PageHeader title="Run" />
        <Card>
          <ErrorState
            message={err?.message ?? "unknown error"}
            access={err?.status === 403}
            onRetry={() => void q.refetch()}
          />
        </Card>
      </>
    );
  }

  const { run, events, pendingApprovals } = q.data;
  const graph = run.graph;
  const state = run.state;
  const budget = run.budget ?? {};
  const terminal = run.status === "completed" || run.status === "aborted";
  const outputs: Record<string, NonNullable<RunDetailResponse["events"][number]["event"]>> = {};
  for (const e of events) {
    if (e.event?.kind === "node_dispatched" && e.event.nodeId) outputs[e.event.nodeId] = e.event;
  }
  const timings = nodeTimings(events);
  const now = Date.now();
  const runElapsed = events.length
    ? fmtDur(
        (terminal ? new Date(events[events.length - 1]!.at).getTime() : now) -
          new Date(events[0]!.at).getTime(),
      )
    : null;
  const cap = budget.capUsd;
  const spent = budget.measuredSpentUsd ?? 0;

  return (
    <>
      <div style={{ marginBottom: "var(--s1)" }}>
        <Link to="/runs">← All runs</Link>
      </div>
      <PageHeader
        title={run.name}
        sub={
          <span className={v.rowTight}>
            <StatusBadge status={run.status} />
            <span>created {ago(run.createdAt)}</span>
            {runElapsed && <span className={v.num}>· {runElapsed} elapsed</span>}
            <IdChip id={run.id} />
          </span>
        }
        actions={
          <span className={v.row}>
            {run.status === "planned" && (
              <Button variant="primary" onClick={() => void postEvent({ kind: "start" }, "Run started")}>
                Start run
              </Button>
            )}
            {(run.status === "running" || run.status === "planned") && (
              <>
                <Button onClick={() => void autoAdvance()} disabled={autoBusy}>
                  {autoBusy ? "Advancing…" : "Auto-advance"}
                </Button>
                <label className={v.faint} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={acceptReviews}
                    onChange={(e) => setAcceptReviews(e.target.checked)}
                  />
                  auto-accept reviews
                </label>
                <Button variant="danger" size="sm" onClick={() => setAbortOpen(true)}>
                  Abort run
                </Button>
              </>
            )}
          </span>
        }
      />

      <div className={v.stack}>
        <Card title="Task graph">
          <div className={s.dagWrap}>
            <DagSvg nodes={graph.nodes} statuses={state.nodeStatuses} />
          </div>
        </Card>

        {livePanes.length > 0 && (
          <Card title="Live worker output">
            <div className={v.faint} style={{ marginBottom: "var(--s1)" }}>
              One pane per active node — parallel-wave nodes stream together.
            </div>
            {livePanes.map((p) => (
              <div key={p.nodeId} className={s.livePane}>
                <span className={v.rowTight}>
                  <Badge
                    tone={p.status === "streaming" ? "info" : p.status === "failed" || p.status === "refused" ? "danger" : "ok"}
                  >
                    {p.status}
                  </Badge>
                  <span className={v.mono}>{p.nodeId}</span>
                  {p.agentName && <span className={v.faint}>· {p.agentName}</span>}
                </span>
                <pre
                  className={s.livePre}
                  ref={(el) => {
                    if (el) livePaneRefs.current.set(p.nodeId, el);
                  }}
                >
                  {p.text}
                </pre>
              </div>
            ))}
          </Card>
        )}

        <Card title="Nodes">
          {graph.nodes.map((n) => {
            const st = state.nodeStatuses[n.id] ?? "not_started";
            const out = outputs[n.id];
            const w = timings[n.id];
            const elapsed = w && w.start !== null ? fmtDur((w.end ?? now) - w.start) : null;
            const lastError = state.lastError?.[n.id];
            return (
              <div key={n.id} className={s.nodeRow}>
                <StatusDot tone={nodeTone[st]} pulse={st === "in_progress"} title={st} />
                <div className={v.grow}>
                  <div className={s.nodeTitle}>
                    {n.title} <span className={v.mono}>{n.id}</span>
                  </div>
                  <div className={v.faint}>
                    {agentNames[state.owners[n.id] ?? ""] ?? "agent"}
                    {n.dependsOn?.length ? ` · after ${n.dependsOn.join(", ")}` : ""}
                    {elapsed ? ` · ${elapsed}` : ""}
                  </div>
                  {out && (
                    <details className={s.output}>
                      <summary>
                        output · {fmtUsd(out.costUsd)} · {out.model ?? ""}
                        {out.toolCalls
                          ? ` · ${out.turns} turn${out.turns === 1 ? "" : "s"} · ${out.toolCalls} tool call${out.toolCalls === 1 ? "" : "s"}`
                          : ""}
                      </summary>
                      <CodeBlock maxHeight="240px">{out.outputText ?? ""}</CodeBlock>
                    </details>
                  )}
                  {lastError && (
                    <div className={v.errLine} style={{ marginTop: "var(--s0)" }}>
                      {lastError}
                    </div>
                  )}
                  {st === "blocked" && (
                    <div className={v.row} style={{ marginTop: "var(--s0)" }}>
                      <Button
                        size="sm"
                        onClick={() => void postEvent({ kind: "retry_node", nodeId: n.id }, "Node re-opened")}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        title="Hand this failure to the run's escalation approver — it lands in their inbox"
                        onClick={() =>
                          void postEvent(
                            { kind: "escalate_node", nodeId: n.id },
                            "Escalated — waiting in the approver's inbox",
                          )
                        }
                      >
                        Escalate
                      </Button>
                    </div>
                  )}
                </div>
                <StatusBadge status={st} />
                {st === "in_review" && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void postEvent({ kind: "node_accepted", nodeId: n.id }, "Accepted")}
                  >
                    Accept
                  </Button>
                )}
              </div>
            );
          })}
        </Card>

        {cap != null && (
          <Card title="Budget">
            <div className={v.row}>
              <span className={v.num} style={{ fontWeight: 650 }}>
                {fmtUsd(spent)}
              </span>
              <span className={v.faint}>of {fmtUsd(cap)} measured</span>
              {budget.overageApproved && <Badge tone="warn">overage approved</Badge>}
            </div>
            <div style={{ marginTop: "var(--s1)" }}>
              <Meter value={spent} max={cap} over={spent > cap} label="run budget" />
            </div>
          </Card>
        )}

        {(pendingApprovals?.length ?? 0) > 0 && (
          <Card title="Waiting on approvals">
            {pendingApprovals!.map((a) => (
              <div key={a.id} className={v.listRow} style={{ alignItems: "center" }}>
                <span className={v.mono}>{approvalStageLabel(a) ?? a.stageId}</span>
                <span className={v.faint}>awaiting {a.approverName ?? "the named approver"}</span>
                <span className={v.grow} />
                <StatusBadge status={a.status} />
              </div>
            ))}
          </Card>
        )}

        {/* PILLAR 8: this run's task graph mapped onto the customer's own work
            items, and PILLAR 4's decision ledger for it — both scoped to this
            run, both feeding the same single audit trail. */}
        <PmLinksCard parent={{ objectType: "run", objectId: runId! }} />
        <DecisionLedgerCard parent={{ objectType: "run", objectId: runId! }} />
      </div>

      <ConfirmModal
        open={abortOpen}
        title="Abort this run for good?"
        body="Unfinished nodes stay where they are; the run turns terminal and cannot be restarted."
        confirmLabel="Abort run"
        danger
        onCancel={() => setAbortOpen(false)}
        onConfirm={() => {
          setAbortOpen(false);
          void postEvent({ kind: "abort" }, "Run aborted");
        }}
      />
    </>
  );
}

// ---- helpers --------------------------------------------------------------

function nodeTimings(events: RunDetailResponse["events"]) {
  const w: Record<string, { start: number | null; end: number | null }> = {};
  for (const e of events) {
    const ev = e.event;
    if (!ev?.nodeId) continue;
    const t = new Date(e.at).getTime();
    const win = (w[ev.nodeId] ??= { start: null, end: null });
    if (ev.kind === "node_started") {
      if (win.start === null) win.start = t;
      win.end = null;
    }
    if (ev.kind === "node_submitted" || ev.kind === "node_failed") win.end = t;
  }
  return w;
}

/** dependency-depth column layout, curved edges, tokens-only colouring */
function DagSvg(props: { nodes: RunGraphNode[]; statuses: Record<string, NodeStatus> }) {
  const { nodes, statuses } = props;
  const depth: Record<string, number> = {};
  const depthOf = (id: string): number => {
    if (id in depth) return depth[id]!;
    depth[id] = 0; // cycle guard (the kernel rejects cycles)
    const n = nodes.find((x) => x.id === id);
    depth[id] = (n?.dependsOn ?? []).reduce((m, dep) => Math.max(m, depthOf(dep) + 1), 0);
    return depth[id]!;
  };
  nodes.forEach((n) => depthOf(n.id));
  const rows: Record<number, number> = {};
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const c = depth[n.id]!;
    const r = rows[c] ?? 0;
    rows[c] = r + 1;
    pos[n.id] = { x: 70 + c * 170, y: 34 + r * 56 };
  }
  const maxC = Math.max(...nodes.map((n) => depth[n.id]!), 0);
  const maxR = Math.max(...Object.values(rows), 1);
  const w = 70 + maxC * 170 + 110;
  const h = 34 + (maxR - 1) * 56 + 40;
  const color: Record<NodeStatus, string> = {
    not_started: "var(--text-faint)",
    in_progress: "var(--info)",
    blocked: "var(--danger)",
    in_review: "var(--warn)",
    done: "var(--ok)",
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ maxWidth: w, display: "block" }} role="img" aria-label="Run task graph">
      {nodes.flatMap((n) =>
        (n.dependsOn ?? []).map((dep) => {
          const a = pos[dep];
          const b = pos[n.id];
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          return (
            <path
              key={`${dep}-${n.id}`}
              d={`M${a.x + 10} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - 10} ${b.y}`}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth="1.5"
            />
          );
        }),
      )}
      {nodes.map((n) => {
        const p = pos[n.id]!;
        const st = statuses[n.id] ?? "not_started";
        const short = n.id.length > 16 ? n.id.slice(0, 15) + "…" : n.id;
        return (
          <g key={n.id}>
            {st === "in_progress" && <circle cx={p.x} cy={p.y} r="12" fill="var(--info)" opacity="0.18" />}
            <circle cx={p.x} cy={p.y} r="7" fill={color[st]} />
            <text
              x={p.x}
              y={p.y + 23}
              textAnchor="middle"
              fill="var(--text-dim)"
              fontSize="10.5"
              fontFamily="var(--font-mono)"
            >
              {short}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
