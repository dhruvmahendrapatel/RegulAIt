import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { Badge, Button, Card, EmptyState } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type NodeType = "use_case" | "agent" | "model" | "vendor" | "mcp_server" | "connector";
type RiskBand = "none" | "low" | "medium" | "high";

export interface GraphNode {
  key: string;
  type: NodeType;
  id: string | null;
  label: string;
  attributes: Record<string, unknown>;
  ownRisk: { score: number; band: RiskBand; riskId: string | null; openRisks: number };
  propagatedRisk: { score: number; band: RiskBand; sourceNodeKey: string | null; sourceRiskId: string | null; path: string[] };
}
interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  basis: "declared" | "observed";
  observedCount?: number;
  lastSeenAt?: string;
}
interface GraphResponse {
  generatedAt: string;
  scope: { useCaseId: string | null; includeObserved: boolean };
  window: { days: number; applies: string };
  summary: { nodes: number; edges: number; byType: Record<string, number>; propagatedHigh: number; inheritedExposure: number; unattachedRisks?: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes: { propagation: string; ratings: string; observed: string; unattached: string };
}

const COL: Record<NodeType, number> = {
  use_case: 90,
  agent: 290,
  model: 500,
  vendor: 710,
  mcp_server: 500,
  connector: 500,
};
const BAND_TONE: Record<RiskBand, "neutral" | "ok" | "warn" | "danger"> = {
  none: "neutral",
  low: "ok",
  medium: "warn",
  high: "danger",
};

export function DependencyGraphPanel({ useCaseId }: { useCaseId?: string }) {
  const [includeObserved, setIncludeObserved] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const graph = useQuery({
    queryKey: ["governance", "dependency-graph", useCaseId ?? "all", includeObserved],
    queryFn: () => {
      const params = new URLSearchParams();
      if (useCaseId) params.set("useCaseId", useCaseId);
      params.set("includeObserved", String(includeObserved));
      return api.get<GraphResponse>(`/v1/inventory/graph?${params}`);
    },
  });

  const layout = useMemo(() => {
    const byColumn = new Map<number, GraphNode[]>();
    for (const node of graph.data?.nodes ?? []) {
      const col = COL[node.type];
      byColumn.set(col, [...(byColumn.get(col) ?? []), node]);
    }
    const out = new Map<string, { x: number; y: number }>();
    for (const [x, nodes] of byColumn) {
      nodes.forEach((node, index) => out.set(node.key, { x, y: 70 + index * 105 }));
    }
    return out;
  }, [graph.data?.nodes]);

  const selected = (graph.data?.nodes ?? []).find((node) => node.key === selectedKey) ?? null;
  const height = Math.max(270, ...[...layout.values()].map((point) => point.y + 70));

  return (
    <div className={v.stack}>
      <div className={v.row}>
        <label className={s.checkbox}>
          <input type="checkbox" checked={includeObserved} onChange={(event) => setIncludeObserved(event.target.checked)} />
          <span>Include observed runtime edges</span>
        </label>
        <span className={v.grow} />
        <Button size="sm" onClick={() => void graph.refetch()}>Refresh graph</Button>
      </div>
      <QueryGate loading={graph.isLoading} error={graph.error} onRetry={() => void graph.refetch()}>
        {!graph.data || graph.data.nodes.length === 0 ? (
          <EmptyState title="No governed dependencies found" body="Link an agent, model, vendor, MCP server, or connector to make the dependency chain visible." />
        ) : (
          <>
            {/* unattachedRisks is org-wide: the API omits it when scoped to one use case */}
            <div className={graph.data.summary.unattachedRisks === undefined ? v.grid3 : v.grid4}>
              <GraphStat label="Nodes" value={graph.data.summary.nodes} />
              <GraphStat label="Inherited exposure" value={graph.data.summary.inheritedExposure} />
              <GraphStat label="Propagated high" value={graph.data.summary.propagatedHigh} />
              {graph.data.summary.unattachedRisks === undefined ? null : (
                <GraphStat label="Unattached risks" value={graph.data.summary.unattachedRisks} />
              )}
            </div>
            <div className={s.graphScroller}>
              <svg className={s.graph} viewBox={`0 0 800 ${height}`} role="img" aria-label="AI dependency and propagated risk graph">
                <g className={s.graphHeadings}>
                  <text x="90" y="25">Use case</text><text x="290" y="25">Agent</text><text x="500" y="25">Model / MCP / connector</text><text x="710" y="25">Vendor</text>
                </g>
                {graph.data.edges.map((edge, index) => {
                  const from = layout.get(edge.from);
                  const to = layout.get(edge.to);
                  if (!from || !to) return null;
                  return (
                    <g key={`${edge.from}-${edge.to}-${index}`}>
                      <line x1={from.x + 58} y1={from.y} x2={to.x - 58} y2={to.y} className={edge.basis === "observed" ? s.graphEdgeObserved : s.graphEdge} />
                      {edge.basis === "observed" && edge.observedCount != null ? <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 5} className={s.graphEdgeLabel}>{edge.observedCount} calls</text> : null}
                    </g>
                  );
                })}
                {graph.data.nodes.map((node) => {
                  const point = layout.get(node.key)!;
                  const inherited = node.ownRisk.band !== node.propagatedRisk.band;
                  return (
                    <g key={node.key} role="button" tabIndex={0} aria-label={`${node.label}, propagated risk ${node.propagatedRisk.band}`} onClick={() => setSelectedKey(node.key)} onKeyDown={(event) => event.key === "Enter" && setSelectedKey(node.key)} className={s.graphNode}>
                      {inherited ? <rect x={point.x - 65} y={point.y - 33} width="130" height="66" rx="12" className={s.graphInheritedRing} /> : null}
                      <rect x={point.x - 59} y={point.y - 27} width="118" height="54" rx="9" className={`${s.graphNodeBox} ${s[`graphBand_${node.propagatedRisk.band}`]}`} />
                      <text x={point.x} y={point.y - 5} className={s.graphNodeType}>{node.type.replace("_", " ")}</text>
                      <text x={point.x} y={point.y + 12} className={s.graphNodeLabel}>{shortLabel(node.label)}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <p className={v.faint}>Solid edges are declared. Dashed edges are observed in the last {graph.data.window.days} days. A cyan ring means propagated exposure differs from the node’s own risk.</p>
            <div className={v.stackTight}>
              <p className={v.faint}>{graph.data.notes.propagation}</p>
              <p className={v.faint}>{graph.data.notes.ratings}</p>
              <p className={v.faint}>{graph.data.notes.observed}</p>
              <p className={v.faint}>{graph.data.notes.unattached}</p>
            </div>
            {selected ? <GraphNodeDetail node={selected} nodes={graph.data.nodes} /> : <p className={v.dim}>Select a node to inspect its inherited-risk path and source.</p>}
          </>
        )}
      </QueryGate>
    </div>
  );
}

function GraphNodeDetail({ node, nodes }: { node: GraphNode; nodes: GraphNode[] }) {
  const labels = new Map(nodes.map((item) => [item.key, item.label]));
  return (
    <Card title={node.label}>
      <div className={v.stack}>
        <div className={v.row}>
          <Badge tone={BAND_TONE[node.ownRisk.band]}>own: {node.ownRisk.band}</Badge>
          <Badge tone={BAND_TONE[node.propagatedRisk.band]}>propagated: {node.propagatedRisk.band}</Badge>
          <span className={v.faint}>{node.ownRisk.openRisks} open risk(s)</span>
        </div>
        {node.propagatedRisk.path.length > 0 ? (
          <div>
            <strong>Propagation path</strong>
            <ol className={s.pathList}>{node.propagatedRisk.path.map((key) => <li key={key}>{labels.get(key) ?? key}</li>)}</ol>
          </div>
        ) : <p className={v.dim}>No inherited path; this node’s propagated position comes from its own risks.</p>}
        <div className={v.row}>
          {node.type === "use_case" && node.id ? <Link to={`/admin/governance/use-cases/${node.id}`}>Open use case</Link> : null}
          {node.type === "agent" && node.id ? <Link to={`/admin/agents#agent-${node.id}`}>Open this agent</Link> : null}
          {node.type === "vendor" && node.id ? <Link to={`/admin/vendors?vendorId=${node.id}`}>Open this vendor</Link> : null}
          {node.propagatedRisk.sourceRiskId ? <Link to={`/admin/risks?riskId=${node.propagatedRisk.sourceRiskId}`}>Open source risk</Link> : null}
        </div>
      </div>
    </Card>
  );
}

function GraphStat({ label, value }: { label: string; value: number }) {
  return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}>{label}</span></div>;
}

function shortLabel(label: string) {
  return label.length > 20 ? `${label.slice(0, 19)}…` : label;
}
