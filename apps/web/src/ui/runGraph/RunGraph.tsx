/**
 * ADR-0173 batch 2b — THE RUN GRAPH: one run's decision path, read-only.
 *
 * Reads GET /v1/run-graph/... (a builder turn, an orchestration run, or a use
 * case) and shows it three ways that say the same thing:
 *  - the graph itself, drawn left to right (lazy-loaded: RunGraphCanvas);
 *  - "Steps in order", an ordered list of every step, the text alternative
 *    for anyone not using the drawing;
 *  - the details of one step (status and why, who, when, cost, facts, and its
 *    audit row / trace span / approval references), opened from either.
 *
 * Who may read is the server's decision (exactly who may open the thread, run
 * or use case); a refusal shows as the server's reason. Nothing here asks for
 * message text or tool arguments: the API never returns them.
 */
import { lazy, Suspense, useCallback, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, ErrorState, IdChip, SkeletonBlock } from "../kit";
import {
  actorText,
  fmtCost,
  fmtWhen,
  predecessors,
  runGraphKey,
  runGraphPath,
  statusLabel,
  statusTone,
  summaryText,
  type RunGraphSource,
  type RunPathGraph,
  type RunPathNode,
} from "./runGraphModel";
import s from "./runGraph.module.css";

const RunGraphCanvas = lazy(() => import("./RunGraphCanvas"));

export function RunGraph(props: {
  source: RunGraphSource;
  /** the drawing's accessible name, e.g. "Run task graph" */
  label: string;
  /** a value that changes when the underlying record changes (refetches) */
  refreshKey?: string | number;
  height?: number;
}) {
  const q = useQuery({
    queryKey: [...runGraphKey(props.source), props.refreshKey ?? null],
    queryFn: () => api.get<RunPathGraph>(runGraphPath(props.source)),
    placeholderData: (prev) => prev,
  });
  if (q.isLoading) return <SkeletonBlock lines={4} />;
  // a malformed answer is an error, never a crash of the page around the graph
  const ok = q.data && Array.isArray(q.data.nodes) && Array.isArray(q.data.edges) && q.data.summary && q.data.subject;
  if (q.isError || !ok)
    return <ErrorState title="Couldn't load the graph" message={(q.error as Error | null)?.message ?? "The server did not return a graph."} onRetry={() => void q.refetch()} />;
  return <RunGraphView graph={q.data!} label={props.label} height={props.height} />;
}

export function RunGraphView(props: { graph: RunPathGraph; label: string; height?: number }) {
  const { graph } = props;
  const { auth } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const uid = useId();
  const listId = `${uid}-steps`;

  const open = useCallback((id: string) => {
    opener.current = document.activeElement as HTMLElement | null;
    setOpenId(id);
    // after render: land on the details so a screen reader announces them
    requestAnimationFrame(() => detailsHeading.current?.focus());
  }, []);
  const close = () => {
    setOpenId(null);
    const back = opener.current;
    opener.current = null;
    requestAnimationFrame(() => back?.isConnected && back.focus());
  };

  const selected = graph.nodes.find((n) => n.id === openId) ?? null;
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const before = predecessors(graph);

  if (graph.nodes.length === 0) return <p className={s.dim}>Nothing has happened on this path yet.</p>;

  return (
    <div className={s.wrap}>
      <p className={s.summary} role="status">
        <strong>{graph.subject.label}</strong> · {summaryText(graph)}
      </p>
      <Suspense fallback={<div className={s.canvasLoading} style={{ height: props.height ?? 380 }}>Loading the graph…</div>}>
        <RunGraphCanvas graph={graph} label={props.label} openId={openId} onOpen={open} height={props.height} describedBy={`${uid}-hint`} />
      </Suspense>
      <p className={s.hint} id={`${uid}-hint`}>Tab to a step and press Enter for its details. The same steps are listed in order below.</p>

      {selected ? (
        <section className={s.details} aria-labelledby={`${uid}-details`}>
          <div className={s.detailsHead}>
            <h3 id={`${uid}-details`} ref={detailsHeading} tabIndex={-1} className={s.detailsTitle}>
              {selected.label}
            </h3>
            <Badge tone={statusTone(selected.status)}>{statusLabel(selected.status)}</Badge>
            <Button size="sm" variant="ghost" onClick={close}>
              Close details
            </Button>
          </div>
          <StepDetails node={selected} isAdmin={Boolean(auth?.isAdmin)} after={(before.get(selected.id) ?? []).map((id) => graph.nodes[index.get(id) ?? -1]?.label ?? id)} />
        </section>
      ) : null}

      <div className={s.listBlock}>
        <h3 className={s.listTitle} id={listId}>
          Steps in order
        </h3>
        <ol className={s.list} aria-labelledby={listId}>
          {graph.nodes.map((n) => {
            const who = actorText(n.actor);
            const when = fmtWhen(n.at);
            const cost = fmtCost(n.costUsd);
            return (
              <li key={n.id} className={s.listItem}>
                <button type="button" className={s.listButton} aria-current={n.id === openId ? "true" : undefined} onClick={() => open(n.id)}>
                  {n.label}
                </button>
                <span className={s.listMeta}>
                  <Badge tone={statusTone(n.status)}>{statusLabel(n.status)}</Badge>
                  {who ? <span>{who}</span> : null}
                  {when ? <span>{when}</span> : null}
                  {cost ? <span>{cost}</span> : null}
                </span>
                {n.statusDetail ? <span className={s.listDetail}>{n.statusDetail}</span> : null}
              </li>
            );
          })}
        </ol>
      </div>
      {graph.notes?.length ? (
        <ul className={s.notes} aria-label="About this graph">
          {graph.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepDetails(props: { node: RunPathNode; isAdmin: boolean; after: string[] }) {
  const n = props.node;
  const rows: Array<[string, React.ReactNode]> = [];
  if (n.statusDetail) rows.push(["Why", n.statusDetail]);
  if (n.rawStatus && n.rawStatus !== n.status) rows.push(["Recorded status", n.rawStatus]);
  const who = actorText(n.actor);
  if (who) rows.push(["Who", who]);
  const at = fmtWhen(n.at);
  if (at) rows.push(["Started", at]);
  const ended = fmtWhen(n.endedAt);
  if (ended) rows.push(["Ended", ended]);
  rows.push(["Cost", fmtCost(n.costUsd) ?? "not priced"]);
  if (props.after.length) rows.push(["Comes after", props.after.join(", ")]);
  for (const f of n.facts) rows.push([f.label, f.value]);
  const { auditLogId, traceId, spanId, approvalId } = n.links;
  return (
    <>
      <dl className={s.facts}>
        {rows.map(([k, v], i) => (
          <div key={`${k}-${i}`} className={s.fact}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <dl className={s.facts} aria-label="Records">
        <div className={s.fact}>
          <dt>Audit row</dt>
          <dd>{auditLogId ? <IdChip id={auditLogId} /> : "none recorded"}</dd>
        </div>
        <div className={s.fact}>
          <dt>Trace span</dt>
          <dd>
            {spanId || traceId ? (
              <span className={s.refs}>
                {spanId ? <IdChip id={spanId} /> : null}
                {traceId && props.isAdmin ? <Link to={`/admin/traces?trace=${encodeURIComponent(traceId)}`}>Open trace</Link> : traceId ? <IdChip id={traceId} /> : null}
              </span>
            ) : (
              "none recorded"
            )}
          </dd>
        </div>
        {approvalId ? (
          <div className={s.fact}>
            <dt>Approval</dt>
            <dd>
              <IdChip id={approvalId} />
            </dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}
