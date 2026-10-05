/**
 * ADR-0173 batch 2b — the run graph's drawing: @xyflow/react renders the
 * nodes and edges (pan, zoom, focus), @dagrejs/dagre lays them out left to
 * right (both MIT; apps/web/THIRD_PARTY.md). Loaded lazily by RunGraph, so
 * neither library is in the main bundle.
 *
 * Keyboard: every node is a focusable element named by its step sentence
 * (Tab moves through them in decision-path order); Enter or Space opens its
 * details. Nothing here can be dragged, connected or deleted: the graph is a
 * read-only view of what happened.
 */
import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  applyNodeChanges,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "../useTheme";
import { layoutRunGraph, NODE_HEIGHT, NODE_WIDTH } from "./runGraphLayout";
import {
  actorText,
  DASHED_EDGE_KINDS,
  edgeSentence,
  fmtCost,
  statusLabel,
  statusTone,
  stepSentence,
  type RunPathGraph,
  type RunPathNode,
} from "./runGraphModel";
import s from "./runGraph.module.css";

type StepData = { node: RunPathNode; index: number; open: boolean };
type StepNode = Node<StepData, "step">;

const StepNodeView = memo(function StepNodeView({ data }: NodeProps<StepNode>) {
  const n = data.node;
  const who = actorText(n.actor);
  const cost = fmtCost(n.costUsd);
  return (
    // the wrapper carries the accessible name (the full step sentence); this is its picture
    <div className={[s.step, s[`tone-${statusTone(n.status)}`], data.open ? s.stepOpen : ""].join(" ")} aria-hidden="true">
      <Handle type="target" position={Position.Left} isConnectable={false} className={s.handle} />
      <div className={s.stepStatus}>
        <span className={s.stepDot} />
        {statusLabel(n.status)}
      </div>
      <div className={s.stepLabel} title={n.label}>
        {n.label}
      </div>
      <div className={s.stepMeta}>
        {[who, cost].filter(Boolean).join(" · ") || " "}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className={s.handle} />
    </div>
  );
});

const NODE_TYPES = { step: StepNodeView };

export default function RunGraphCanvas(props: {
  graph: RunPathGraph;
  /** the canvas's accessible name */
  label: string;
  openId: string | null;
  onOpen: (nodeId: string) => void;
  height?: number;
  describedBy?: string;
}) {
  const { graph, openId, onOpen } = props;
  const { theme } = useTheme();
  const laidOut = useMemo(() => {
    const layout = layoutRunGraph(graph);
    const at = new Map(layout.nodes.map((p) => [p.id, p]));
    const nodes: StepNode[] = graph.nodes.map((n, index) => ({
      id: n.id,
      type: "step",
      position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: { node: n, index, open: false },
      ariaLabel: stepSentence(n, index, graph.nodes.length),
      draggable: false,
      connectable: false,
      deletable: false,
    }));
    const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const seen = new Set<string>();
    const edges: Edge[] = [];
    graph.edges.forEach((e, i) => {
      if (!labelOf.has(e.from) || !labelOf.has(e.to)) return;
      const key = `${e.from}\u0000${e.to}\u0000${e.kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        className: [s.edge, DASHED_EDGE_KINDS.has(e.kind) ? s.edgeDashed : ""].join(" "),
        ariaLabel: edgeSentence(e, (id) => labelOf.get(id) ?? id),
        focusable: false,
        selectable: false,
        deletable: false,
      });
    });
    return { nodes, edges };
  }, [graph]);

  const [nodes, setNodes] = useState<StepNode[]>(laidOut.nodes);
  useEffect(() => setNodes(laidOut.nodes), [laidOut.nodes]);
  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const shown = useMemo(
    () => nodes.map((n) => (n.data.open === (n.id === openId) ? n : { ...n, data: { ...n.data, open: n.id === openId } })),
    [nodes, openId],
  );

  // Enter or Space on a focused node opens its details (the node wrapper is the focus target)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    const id = el?.dataset.id;
    if (!id) return;
    e.preventDefault();
    onOpen(id);
  };

  return (
    <div className={s.canvas} style={{ height: props.height ?? 380 }} onKeyDown={onKeyDown}>
      <ReactFlow
        aria-label={props.label}
        aria-describedby={props.describedBy}
        nodes={shown}
        edges={laidOut.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onOpen(n.id)}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        // the page keeps scrolling over the graph; zoom with the buttons or a pinch
        zoomOnScroll={false}
        preventScrolling={false}
        defaultMarkerColor={null}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
