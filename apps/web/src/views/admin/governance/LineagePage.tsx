/**
 * Data lineage / provenance graph (ADR-0050).
 *
 * The single most important thing this page does is REFUSE TO OVERSTATE. A
 * lineage view is exactly the surface where a reader will assume more than the
 * data supports — that the arrows mean "influenced", that an empty result means
 * "nothing touched it", that the graph is complete. So the scope sentence sits
 * at the top of the page and again on every result, `withheldEdges` is rendered
 * whenever a traversal was narrowed by the caller's own entitlement, and
 * `truncated` is shown rather than silently swallowed.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, optionEls, projectOpts, useAction, useProjects } from "../adminKit";
import { RunLineageCard } from "./RunLineageCard";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface LineageNode {
  id: string;
  projectId: string;
  kind: "source" | "run" | "output";
  subtype: string;
  naturalKey: string;
  refId: string | null;
  refKey: string | null;
  version: number | null;
  label: string;
  contentRecorded: boolean;
  depth?: number;
}
interface LineageEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: "flowed_into" | "produced" | "derived_from";
}
interface Traversal {
  start: LineageNode;
  direction: string;
  maxDepth: number;
  nodes: LineageNode[];
  edges: LineageEdge[];
  truncated: boolean;
  maxDepthReached: number;
  withheldEdges: number;
  note: string;
}
interface Overview {
  nodesByKind: Array<{ kind: string; n: number }>;
  edgesByKind: Array<{ kind: string; n: number }>;
  byProject: Array<{ projectId: string; name: string | null; n: number }>;
  contentLevelLineageEnabled: boolean;
  note: string;
  captureNote: string;
}

export default function LineagePage() {
  const act = useAction();
  const projects = useProjects();
  const overview = useQuery({
    queryKey: ["admin", "lineage-overview"],
    queryFn: () => api.get<Overview>("/v1/lineage/overview"),
  });

  const [projectId, setProjectId] = useState("");
  const [naturalKey, setNaturalKey] = useState("");
  const [direction, setDirection] = useState("backward");
  const [maxDepth, setMaxDepth] = useState("5");
  const [result, setResult] = useState<Traversal | null>(null);
  // ADR-0050: one run's direct inputs and outputs
  const [runId, setRunId] = useState<string | null>(null);

  const nodes = useQuery({
    queryKey: ["admin", "lineage-nodes", projectId],
    queryFn: () =>
      api.get<{ nodes: LineageNode[] }>(
        `/v1/lineage/nodes${projectId ? `?projectId=${projectId}` : ""}`,
      ),
  });

  const byId = new Map((result?.nodes ?? []).map((n) => [n.id, n]));

  // I-2: one empty state while nothing is recorded. Both reads must have answered, and answered empty; a failed
  // read falls through to the page as it is, where it says it failed.
  const census = overview.data;
  const nothingYet =
    !projectId &&
    !result &&
    overview.isSuccess &&
    nodes.isSuccess &&
    (census?.byProject ?? []).length === 0 &&
    (census?.nodesByKind ?? []).every((k) => k.n === 0) &&
    (census?.edgesByKind ?? []).every((k) => k.n === 0) &&
    (nodes.data?.nodes ?? []).length === 0;

  const coverage: ReactNode = (
    <div className={v.row}>
      <Badge
        tone="warn"
        infoLabel="what is captured, and what is not"
        info={
          <p>
            <strong>What is captured, and what is not.</strong> {census?.captureNote}
          </p>
        }
      >
        Limited coverage
      </Badge>
      <Badge
        tone={census?.contentLevelLineageEnabled ? "warn" : "ok"}
        infoLabel="content-level lineage"
        info={
          <p>
            The default is metadata-only, preserving the control-plane/agent-plane boundary and the BYOC
            &ldquo;content never leaves&rdquo; guarantee.
          </p>
        }
      >
        Content-level lineage: {census?.contentLevelLineageEnabled ? "ENABLED" : "off"}
      </Badge>
    </div>
  );

  if (nothingYet) {
    return (
      <>
        <PageHeader
          title="Data lineage"
          info={<p>Which inputs the gateway SUPPLIED to a dispatch, and what that dispatch produced — chained across runs through the shared context store's versioned items. This is supplied-inputs provenance, NOT intra-model attribution: it does not claim which of those inputs influenced the output, because that is not observable from outside a model. Completeness is bounded by gateway visibility, node granularity, and the metadata-by-default posture.</p>}
        />
        <div className={v.stack}>
          <Card title="Get started">
            <div className={v.stack}>
              {coverage}
              <EmptyState
                title="No lineage recorded yet"
                body="Nothing has been captured: no governed context write or run dispatch has happened in a project yet, so there is no node to trace. Lineage records itself as a project's agents run; once it does, pick a project and a node here to trace backward or forward."
                action={
                  <Link to="/projects">
                    <Button variant="primary">Open projects</Button>
                  </Link>
                }
              />
            </div>
          </Card>
          <RunLineageCard runId={runId} onRunId={setRunId} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Data lineage"
        info={<p>Which inputs the gateway SUPPLIED to a dispatch, and what that dispatch produced — chained across runs through the shared context store's versioned items. This is supplied-inputs provenance, NOT intra-model attribution: it does not claim which of those inputs influenced the output, because that is not observable from outside a model. Completeness is bounded by gateway visibility, node granularity, and the metadata-by-default posture.</p>}
      />
      <div className={v.stack}>
        <Card title="Trace">
          <div className={v.stack}>
            <div className={a.formRow}>
              <Field label="Project">
                <Select
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setNaturalKey("");
                    setResult(null);
                  }}
                >
                  {optionEls(projectOpts(projects.data?.projects), "select…")}
                </Select>
              </Field>
              <Field label="Node">
                <Select value={naturalKey} onChange={(e) => setNaturalKey(e.target.value)}>
                  {optionEls(
                    (nodes.data?.nodes ?? []).map((n) => ({ v: n.naturalKey, l: `${n.kind} — ${n.label}` })),
                    "select…",
                  )}
                </Select>
              </Field>
              <Field label="Direction">
                <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="backward">backward — what produced this</option>
                  <option value="forward">forward — what this reached</option>
                  <option value="both">both</option>
                </Select>
              </Field>
              <Field label="Max depth">
                <Input value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} />
              </Field>
              <Field label="&nbsp;">
                <Button
                  disabled={act.busy || !projectId || !naturalKey}
                  onClick={() =>
                    void act.run(async () => {
                      const q = new URLSearchParams({
                        projectId,
                        naturalKey,
                        direction,
                        maxDepth,
                      });
                      setResult(await api.get<Traversal>(`/v1/lineage?${q.toString()}`));
                    }, "Traversal complete")
                  }
                >
                  Trace
                </Button>
              </Field>
            </div>

            {!result ? (
              <EmptyState
                title="No traversal yet"
                body="Pick a project and a node. Backward answers 'where did this come from'; forward answers 'what did this reach'."
              />
            ) : (
              <div className={v.stack}>
                {result.truncated && (
                  <div className={a.effectBanner}>
                    <strong>This answer is PARTIAL.</strong> The walk stopped at the depth or breadth
                    cap (reached depth {result.maxDepthReached}). Widen the depth, or start from a
                    node further along the chain.
                  </div>
                )}
                {result.withheldEdges > 0 && (
                  <div className={a.effectBanner}>
                    <strong>{result.withheldEdges} edge(s) withheld.</strong> They lead to context in
                    a project you are not a member of. Neither the node nor its id is shown — for a
                    provenance graph, confirming that something exists is itself the disclosure.
                  </div>
                )}
                <Table
                  rows={result.nodes}
                  rowKey={(n) => n.id}
                  columns={[
                    { key: "depth", header: "Depth", render: (n) => n.depth ?? 0 },
                    {
                      key: "kind",
                      header: "Kind",
                      render: (n) => (
                        <Badge tone={n.kind === "run" ? "info" : n.kind === "output" ? "ok" : "neutral"}>
                          {n.kind}
                        </Badge>
                      ),
                    },
                    { key: "subtype", header: "Subtype", render: (n) => n.subtype },
                    { key: "label", header: "What", render: (n) => n.label },
                    { key: "ver", header: "Version", render: (n) => n.version ?? "—" },
                    {
                      key: "content",
                      header: "Content",
                      render: (n) =>
                        n.contentRecorded ? (
                          <Badge tone="warn">recorded (opt-in)</Badge>
                        ) : (
                          <span className={v.faint}>metadata only</span>
                        ),
                    },
                    {
                      key: "run",
                      header: "",
                      srHeader: "Actions",
                      align: "right",
                      render: (n) =>
                        n.kind === "run" && n.refId ? (
                          <Button size="sm" aria-label={`Inputs and outputs of ${n.label}`} onClick={() => setRunId(n.refId)}>
                            Inputs and outputs
                          </Button>
                        ) : null,
                    },
                  ]}
                />
                <div className={v.sectionTitle}>Edges</div>
                <Table
                  rows={result.edges}
                  rowKey={(e) => e.id}
                  columns={[
                    { key: "from", header: "From", render: (e) => byId.get(e.fromNodeId)?.label ?? e.fromNodeId },
                    { key: "kind", header: "Relationship", render: (e) => e.kind },
                    { key: "to", header: "To", render: (e) => byId.get(e.toNodeId)?.label ?? e.toNodeId },
                  ]}
                />
                <div className={v.faint}>{result.note}</div>
              </div>
            )}
          </div>
        </Card>

        <RunLineageCard runId={runId} onRunId={setRunId} />

        <QueryGate loading={overview.isLoading} error={overview.error} onRetry={() => void overview.refetch()}>
          <Card title="Graph census">
            <div className={v.stack}>
              {coverage}
              <Table
                rows={overview.data?.byProject ?? []}
                rowKey={(r) => r.projectId}
                columns={[
                  { key: "p", header: "Project", render: (r) => r.name ?? r.projectId },
                  { key: "n", header: "Nodes", render: (r) => r.n },
                ]}
                empty={<EmptyState title="No lineage recorded yet" body="Nothing has been captured — no governed context write or run dispatch has happened in a project yet." />}
              />
              <div className={v.faint}>
                Nodes:{" "}
                {(overview.data?.nodesByKind ?? []).map((k) => `${k.kind} ${k.n}`).join(", ") || "none"} · Edges:{" "}
                {(overview.data?.edgesByKind ?? []).map((k) => `${k.kind} ${k.n}`).join(", ") || "none"}
              </div>
            </div>
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
