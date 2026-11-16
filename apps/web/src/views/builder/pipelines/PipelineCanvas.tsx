/**
 * ADR-0341 slice 2 — the pipeline builder's canvas: the run graph's @xyflow/react + @dagrejs/dagre setup (MIT,
 * apps/web/THIRD_PARTY.md), made editable. Loaded lazily by PipelineBuilderPage, so neither library is in the entry
 * bundle; it shares their vendor split with RunGraphCanvas.
 *
 * The canvas holds no state of its own beyond where a node is while it is being dragged: nodes and edges are
 * `toCanvas(definition)` laid out by dagre, and every gesture becomes one edit of the definition —
 *   - drag a stage left or right and drop it: `moveStage` to the position it was dropped at;
 *   - drop a palette entry on the canvas: `onInsert` at the position it was dropped at;
 *   - keyboard, on a focused stage: Enter or Space selects it, Alt+Left/Right moves it, Delete removes it.
 * Every one of these is also in the Outline view, which is the screen-reader and phone path.
 */
import { memo, useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  applyNodeChanges,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "../../../ui/useTheme";
import { layoutRunGraph, NODE_HEIGHT, NODE_WIDTH } from "../../../ui/runGraph/runGraphLayout";
import { plural } from "../../../api/format";
import { isStageType, stageSentence, stageTypeLabel, toCanvas, type TemplateDefinition, type TemplateStage } from "./pipelineCanvasModel";
import { indexAtX, STAGE_DRAG_TYPE } from "./stageDrag";
import s from "./pipelineBuilder.module.css";

type StageData = { stage: TemplateStage; index: number; issues: number; selected: boolean };
type StageNode = Node<StageData, "stage">;

const StageNodeView = memo(function StageNodeView({ data }: NodeProps<StageNode>) {
  const st = data.stage;
  return (
    // the wrapper carries the accessible name (the step sentence); this is its picture
    <div className={[s.node, data.issues > 0 ? s.nodeIssue : "", data.selected ? s.nodeSelected : ""].join(" ")} aria-hidden="true">
      <Handle type="target" position={Position.Left} isConnectable={false} className={s.handle} />
      <div className={s.nodeType}>
        <span className={s.nodeIndex}>{data.index + 1}</span>
        {stageTypeLabel(st.type)}
      </div>
      <div className={s.nodeId}>{st.id}</div>
      <div className={s.nodeMeta}>{data.issues > 0 ? plural(data.issues, "problem", "problems") : isStageType(st.type) ? "Ready" : "Unknown type"}</div>
      <Handle type="source" position={Position.Right} isConnectable={false} className={s.handle} />
    </div>
  );
});

const NODE_TYPES = { stage: StageNodeView };
/** xyflow's fit-view margin, as a fraction of the viewport (the run graph's value); not a CSS spacing */
const FIT_VIEW_PADDING = 0.12;

export interface PipelineCanvasProps {
  definition: TemplateDefinition;
  issuesByStage: ReadonlyMap<string, readonly unknown[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onInsert: (type: string, index: number) => void;
  onRemove: (id: string) => void;
  /** the canvas's accessible name */
  label: string;
  describedBy?: string;
  readOnly?: boolean;
  height?: number;
}

function Canvas(props: PipelineCanvasProps) {
  const { definition, issuesByStage, selectedId } = props;
  const { theme } = useTheme();
  const flow = useReactFlow();
  const laidOut = useMemo(() => {
    const model = toCanvas(definition);
    const layout = layoutRunGraph(model);
    const at = new Map(layout.nodes.map((p) => [p.id, p]));
    const total = model.nodes.length;
    const nodes: StageNode[] = model.nodes.map((n) => {
      const issues = issuesByStage.get(n.id)?.length ?? 0;
      return {
        id: n.id,
        type: "stage",
        position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: { stage: n.stage, index: n.index, issues, selected: false },
        ariaLabel: stageSentence(n.stage, n.index, total, issues),
        draggable: !props.readOnly,
        connectable: false,
        deletable: false,
      };
    });
    const edges: Edge[] = model.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      className: [s.edge, e.kind === "rollback" ? s.edgeRollback : ""].join(" "),
      ariaLabel: e.kind === "rollback" ? `On failure, ${e.from} rolls back through ${e.to}` : `${e.from} then ${e.to}`,
      focusable: false,
      selectable: false,
      deletable: false,
    }));
    return { nodes, edges };
  }, [definition, issuesByStage, props.readOnly]);

  const [nodes, setNodes] = useState<StageNode[]>(laidOut.nodes);
  useEffect(() => setNodes(laidOut.nodes), [laidOut.nodes]);
  const onNodesChange = useCallback((changes: NodeChange<StageNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const shown = useMemo(
    () => nodes.map((n) => (n.data.selected === (n.id === selectedId) ? n : { ...n, data: { ...n.data, selected: n.id === selectedId } })),
    [nodes, selectedId],
  );

  const centres = useCallback(
    () => laidOut.nodes.map((n) => ({ id: n.id, x: n.position.x + NODE_WIDTH / 2 })),
    [laidOut.nodes],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: StageNode) => {
      const to = indexAtX(centres(), node.position.x + NODE_WIDTH / 2, node.id);
      if (to === node.data.index) setNodes(laidOut.nodes); // dropped where it was: snap back
      else props.onMove(node.id, to);
    },
    [centres, laidOut.nodes, props],
  );

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (props.readOnly || !e.dataTransfer.types.includes(STAGE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const type = e.dataTransfer.getData(STAGE_DRAG_TYPE);
    if (props.readOnly || !type) return;
    e.preventDefault();
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    props.onInsert(type, indexAtX(centres(), at.x));
  };

  // keyboard on a focused stage (the node wrapper is the focus target)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    const id = el?.dataset.id;
    if (!id) return;
    const node = laidOut.nodes.find((n) => n.id === id);
    if (!node) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onSelect(id);
    } else if (!props.readOnly && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      props.onMove(id, node.data.index + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (!props.readOnly && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      props.onRemove(id);
    }
  };

  return (
    <div className={s.canvas} style={{ height: props.height ?? 420 }} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        aria-label={props.label}
        aria-describedby={props.describedBy}
        nodes={shown}
        edges={laidOut.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => props.onSelect(n.id)}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: FIT_VIEW_PADDING, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable={!props.readOnly}
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnScroll={false}
        preventScrolling={false}
        defaultMarkerColor={null}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}

export default function PipelineCanvas(props: PipelineCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
