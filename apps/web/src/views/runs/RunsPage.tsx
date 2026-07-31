/**
 * Runs — multi-agent task graphs. List + a template-driven "plan a run" form
 * (the canned graphs ship real node instructions, same as the legacy UI).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { MyAgentsResponse, Project, RunSummary } from "../../api/types";
import { ago, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  Table,
} from "../../ui/kit";
import { useToast } from "../../ui/toast";
import v from "../views.module.css";

interface TemplateNode {
  id: string;
  title: string;
  dependsOn: string[];
  instruction: string;
}
export const RUN_TEMPLATES: Array<{ id: string; label: string; nodes: TemplateNode[] }> = [
  {
    id: "feature",
    label: "Feature (design → implement → document)",
    nodes: [
      {
        id: "design",
        title: "Design the change",
        dependsOn: [],
        instruction:
          "Draft the technical design for the feature named in the run title. Cover the API surface or interfaces it adds or changes, the data it touches, and every error case you can foresee. Call out anything that needs a migration or a staged rollout, and end with a short list of open questions a reviewer should settle.",
      },
      {
        id: "implement",
        title: "Implement the change",
        dependsOn: ["design"],
        instruction:
          "Implement the feature following the design produced by the design node. Describe the change file by file, keep it minimal and consistent with the surrounding code, and state explicitly how each error case from the design is handled. Flag any place where you had to deviate from the design and why.",
      },
      {
        id: "document",
        title: "Document the change",
        dependsOn: ["implement"],
        instruction:
          "Write the user-facing documentation for the implemented feature: what it does, how to use it, and any limits or defaults worth knowing. Include a short changelog entry, and note anything an operator must do when rolling the change out.",
      },
    ],
  },
  {
    id: "bugfix",
    label: "Bug fix (reproduce → fix → verify)",
    nodes: [
      {
        id: "reproduce",
        title: "Reproduce the bug",
        dependsOn: [],
        instruction:
          "Reproduce the bug named in the run title. State the exact steps, inputs, and environment that trigger it, the observed behavior versus the expected behavior, and your best hypothesis for the root cause with the evidence supporting it.",
      },
      {
        id: "fix",
        title: "Fix the root cause",
        dependsOn: ["reproduce"],
        instruction:
          "Fix the root cause identified by the reproduce node — not just the symptom. Describe the change precisely, explain why it is the minimal correct fix, and list any related code paths that share the same flaw and should be checked while you are here.",
      },
      {
        id: "verify",
        title: "Verify the fix",
        dependsOn: ["fix"],
        instruction:
          "Verify the fix: re-run the reproduction steps and confirm the expected behavior, then look for regressions in the surrounding behavior. List every check performed with its result, and state clearly whether the fix is safe to ship.",
      },
    ],
  },
  {
    id: "analysis",
    label: "Analysis (gather → analyze → report)",
    nodes: [
      {
        id: "gather",
        title: "Gather the source material",
        dependsOn: [],
        instruction:
          "Gather the raw material needed for the analysis named in the run title. List every source consulted, quote or summarize the relevant parts, and flag the gaps where the available material is thin or contradictory.",
      },
      {
        id: "analyze",
        title: "Analyze the findings",
        dependsOn: ["gather"],
        instruction:
          "Analyze the gathered material. Identify the patterns, trade-offs, and risks that matter for the question in the run title, compare the plausible options against each other, and rank them with an explicit rationale for the ordering.",
      },
      {
        id: "report",
        title: "Write the report",
        dependsOn: ["analyze"],
        instruction:
          "Write the final report for a reader who has seen none of the earlier nodes: the question, the short answer up front, the supporting analysis, and a concrete recommendation with its main risks and mitigations. Keep it under a page.",
      },
    ],
  },
];

export default function RunsPage() {
  const { auth } = useSession();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = auth?.userId ?? null;

  const runsQ = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<{ runs: RunSummary[] }>("/v1/runs"),
  });
  const agentsQ = useQuery({
    queryKey: ["my-agents", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
  });
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });

  const agents = useMemo(
    () => (agentsQ.data?.agents ?? []).filter((a) => !a.revoked),
    [agentsQ.data],
  );
  const projects = projectsQ.data?.projects ?? [];

  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState(RUN_TEMPLATES[0]!.id);
  const [projectId, setProjectId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // mock agents run with no external credential — the default node owner
  const defaultOwner =
    agents.find((a) => a.provider === "mock")?.agentId ?? agents[0]?.agentId ?? "";

  const createRun = async () => {
    setCreateError(null);
    const template = RUN_TEMPLATES.find((t) => t.id === templateId) ?? RUN_TEMPLATES[0]!;
    if (!defaultOwner) {
      setCreateError("No agents are granted to your account — ask an admin to grant you one.");
      return;
    }
    setCreating(true);
    try {
      const graph = {
        run: title.trim() || "untitled run",
        escalationApproverUserId: userId,
        nodes: template.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          instruction: n.instruction,
          ownerAgentId: defaultOwner,
          mode: "execute",
          dependsOn: n.dependsOn,
        })),
      };
      const r = await api.post<{ id: string; budgetApprovalPending?: boolean }>("/v1/runs", {
        graph,
        ...(projectId ? { projectId } : {}),
      });
      toast(
        r.budgetApprovalPending
          ? "Run planned — over your budget cap, approval requested"
          : "Run planned",
        "success",
      );
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${r.id}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader title="Runs" sub="Multi-agent task graphs — planned, governed, metered." />
      <div className={v.stack}>
        <Card title="Plan a run">
          {agents.length === 0 && !agentsQ.isLoading ? (
            <EmptyState
              title="No agents granted"
              body="Ask an admin to grant your account an agent before planning a run."
            />
          ) : (
            <>
              <div className={v.row}>
                <Field label="Title" grow>
                  <Input
                    placeholder="What is this run for?"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field label="Template">
                  <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    {RUN_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Bill to">
                  <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">no project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div style={{ alignSelf: "flex-end" }}>
                  <Button variant="primary" onClick={() => void createRun()} disabled={creating}>
                    {creating ? "Planning…" : "Plan run"}
                  </Button>
                </div>
              </div>
              {createError && (
                <div className={v.errLine} role="alert" style={{ marginTop: "var(--s1)" }}>
                  {createError}
                </div>
              )}
              <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
                Each template node ships a real work order for its worker; escalations land in your
                own inbox. Goal-driven decomposition and per-node tuning stay available in the
                classic app for now.
              </div>
            </>
          )}
        </Card>

        <Card title="Your runs" flush>
          {runsQ.isError ? (
            <ErrorState
              message={(runsQ.error as Error).message}
              onRetry={() => void runsQ.refetch()}
            />
          ) : (
            <Table
              columns={[
                {
                  key: "name",
                  header: "Run",
                  render: (r: RunSummary) => <span style={{ fontWeight: 550 }}>{r.name}</span>,
                  sort: (r) => r.name.toLowerCase(),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (r) => <StatusBadge status={r.status} />,
                  sort: (r) => r.status,
                },
                {
                  key: "progress",
                  header: "Progress",
                  align: "right",
                  render: (r) => {
                    const st = r.state?.nodeStatuses ?? {};
                    const total = Object.keys(st).length;
                    const done = Object.values(st).filter((x) => x === "done").length;
                    return (
                      <span className={v.num}>
                        {done}/{total} nodes
                      </span>
                    );
                  },
                },
                {
                  key: "spend",
                  header: "Measured spend",
                  align: "right",
                  render: (r) => <span className={v.num}>{fmtUsd(r.budget?.measuredSpentUsd ?? 0)}</span>,
                  sort: (r) => r.budget?.measuredSpentUsd ?? 0,
                },
                {
                  key: "created",
                  header: "Created",
                  render: (r) => <span className={v.faint}>{ago(r.createdAt)}</span>,
                  sort: (r) => r.createdAt,
                },
              ]}
              rows={runsQ.data?.runs}
              rowKey={(r) => r.id}
              loading={runsQ.isLoading}
              onRowClick={(r) => navigate(`/runs/${r.id}`)}
              rowLabel={(r) => `Open run ${r.name}`}
              empty={
                <EmptyState
                  title="No runs yet"
                  body="Plan one above — independent branches dispatch in parallel, every node under your entitlements and budget."
                />
              }
            />
          )}
        </Card>
      </div>
    </>
  );
}
