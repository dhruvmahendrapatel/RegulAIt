/**
 * Runs — multi-agent task graphs. List + two ways to plan one:
 *
 *  1. a template-driven form (the canned graphs ship real node instructions);
 *  2. PILLAR 7 goal decomposition — describe a goal, a LEAD agent drafts the
 *     task graph (POST /v1/runs/decompose), and the draft lands in this editor
 *     for review and edit. The decompose call is a governed, metered lead
 *     dispatch that returns a PROPOSAL ONLY: nothing is created until the human
 *     presses Plan run, which is the same unchanged POST /v1/runs the template
 *     path uses. That human gate is deliberate — §3's "distinct, reviewable
 *     step", the product's own forced Plan-mode-before-build at the run level.
 *
 * §5.1 "a lead can suggest, never grant": where the lead named an agent or
 * tool outside the caller's entitlements, the gateway narrows it and records
 * the narrowing on the node. Every one of those is rendered — a silently
 * widened or silently swapped plan is exactly what this surface must not ship.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  DecomposeResponse,
  MyAgentsResponse,
  Project,
  ProposalNode,
  RunSummary,
} from "../../api/types";
import { ago, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  StatusBadge,
  Table,
  Textarea,
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

  // ---- pillar 7: goal → drafted proposal --------------------------------
  const [goal, setGoal] = useState("");
  const [leadAgentId, setLeadAgentId] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<DecomposeResponse | null>(null);
  /** the human's edits on top of the draft, by node id — the proposal object
   * itself is never mutated, so "what the lead said" stays inspectable */
  const [edits, setEdits] = useState<Record<string, { title?: string; ownerAgentId?: string }>>({});

  // mock agents run with no external credential — the default node owner
  const defaultOwner =
    agents.find((a) => a.provider === "mock")?.agentId ?? agents[0]?.agentId ?? "";
  const leadDefault = agentsQ.data?.defaultAgentId ?? defaultOwner;
  const leadValue = leadAgentId || leadDefault || "";
  const agentNameOf = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id.slice(0, 8) + "…";

  /** the nodes as they would be submitted: the lead's draft plus the human's
   * edits, with every §5.1 ceiling field the gateway already narrowed carried
   * through untouched (the UI never widens what the backend narrowed). */
  const editedNodes = (nodes: ProposalNode[]) =>
    nodes.map((n) => {
      const e = edits[n.id] ?? {};
      return {
        id: n.id,
        title: (e.title ?? n.title).trim() || n.title,
        instruction: n.instruction,
        ownerAgentId: e.ownerAgentId ?? n.ownerAgentId,
        mode: n.mode,
        dependsOn: n.dependsOn,
        ...(n.toolServers?.length ? { toolServers: n.toolServers } : {}),
        ...(n.maxTurns ? { maxTurns: n.maxTurns } : {}),
        ...(n.leadNodeId ? { leadNodeId: n.leadNodeId } : {}),
        ...(n.allowedAgentIds?.length ? { allowedAgentIds: n.allowedAgentIds } : {}),
        ...(n.allowedToolRefs?.length ? { allowedToolRefs: n.allowedToolRefs } : {}),
        ...(n.budgetCapUsd ? { budgetCapUsd: n.budgetCapUsd } : {}),
      };
    });

  const draftPlan = async () => {
    setDraftError(null);
    const g = goal.trim();
    if (g.length < 10) {
      setDraftError("Goal: describe it in at least 10 characters.");
      return;
    }
    setDrafting(true);
    try {
      const r = await api.post<DecomposeResponse>("/v1/runs/decompose", {
        goal: g,
        ...(leadValue ? { leadAgentId: leadValue } : {}),
        ...(projectId ? { projectId } : {}),
      });
      setProposal(r);
      setEdits({});
      if (!title.trim()) setTitle(r.proposal.name);
      toast("Plan drafted — review and adjust, then Plan run", "success");
    } catch (e) {
      // 422 decomposition_invalid arrives with its detail on the message
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const discardProposal = () => {
    setProposal(null);
    setEdits({});
    setDraftError(null);
  };

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
        run: title.trim() || proposal?.proposal.name || "untitled run",
        escalationApproverUserId: userId,
        // an accepted proposal replaces the template entirely — the human is
        // submitting the plan they just reviewed, not a canned one
        nodes: proposal
          ? editedNodes(proposal.proposal.nodes)
          : template.nodes.map((n) => ({
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
      discardProposal();
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
              {/* PILLAR 7 — describe the goal, a lead agent drafts the graph.
                  One governed, metered dispatch; it does NOT create a run. */}
              <div className={v.row}>
                <Field label="Describe the goal" grow>
                  <Textarea
                    rows={2}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder="What should this run achieve? A lead agent drafts the task graph — you review and edit it before anything runs."
                  />
                </Field>
                <Field label="Lead agent">
                  <Select
                    value={leadValue}
                    onChange={(e) => setLeadAgentId(e.target.value)}
                  >
                    {agents.map((a) => (
                      <option key={a.agentId} value={a.agentId}>
                        {a.name} · {a.provider} · tier {a.tier}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div style={{ alignSelf: "flex-end" }}>
                  <Button
                    onClick={() => void draftPlan()}
                    disabled={drafting}
                    title="one governed, metered lead dispatch drafts a proposal — it does NOT create a run"
                  >
                    {drafting ? "Drafting…" : "Draft plan with a lead agent"}
                  </Button>
                </div>
              </div>
              {draftError && (
                <div className={v.errLine} role="alert" style={{ marginTop: "var(--s1)" }}>
                  {draftError}
                </div>
              )}
              {proposal && (
                <ProposalEditor
                  proposal={proposal}
                  agents={agents}
                  edits={edits}
                  setEdits={setEdits}
                  agentNameOf={agentNameOf}
                  onDiscard={discardProposal}
                />
              )}
              <hr className={v.divider} />

              <div className={v.row}>
                <Field label="Title" grow>
                  <Input
                    placeholder="What is this run for?"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field label="Template">
                  <Select
                    value={templateId}
                    disabled={Boolean(proposal)}
                    title={
                      proposal
                        ? "a drafted plan is loaded — discard it above to plan from a template instead"
                        : undefined
                    }
                    onChange={(e) => setTemplateId(e.target.value)}
                  >
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
                {proposal
                  ? "Plan run submits the drafted plan exactly as edited above — the same governed POST /v1/runs a template uses. Nothing has run yet."
                  : "Each template node ships a real work order for its worker; escalations land in your own inbox. Or describe a goal above and let a lead agent draft the graph for you."}
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
              error={runsQ.error}
              onRetry={() => void runsQ.refetch()}
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

/**
 * The drafted proposal, in review. Three jobs, in priority order:
 *
 *  1. say who drafted it and what that cost — the decompose dispatch is real
 *     metered spend, so it is stated up front (a null cost renders as
 *     "unpriced", never as $0);
 *  2. surface EVERY §5.1 narrowing the gateway applied. A lead may suggest an
 *     agent or tool the caller is not entitled to; the gateway swaps or drops
 *     it and records that on the node. Each one gets its own line naming what
 *     was asked for and what happened — a plan that silently differs from what
 *     the lead proposed is not reviewable;
 *  3. let the human edit title + owner per node before accepting. Instructions
 *     and the dependency graph stay as drafted — restructuring a DAG in a row
 *     editor invites a broken graph, and the kernel validates on submit.
 */
function ProposalEditor(props: {
  proposal: DecomposeResponse;
  agents: Array<{ agentId: string; name: string; provider: string; tier: number }>;
  edits: Record<string, { title?: string; ownerAgentId?: string }>;
  setEdits: (
    fn: (
      prev: Record<string, { title?: string; ownerAgentId?: string }>,
    ) => Record<string, { title?: string; ownerAgentId?: string }>,
  ) => void;
  agentNameOf: (id: string) => string;
  onDiscard: () => void;
}) {
  const { proposal, dispatch, retried } = props.proposal;
  const setNode = (id: string, patch: { title?: string; ownerAgentId?: string }) =>
    props.setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // every place the gateway narrowed what the lead asked for
  const narrowings = proposal.nodes.flatMap((n) => [
    ...(n.substituted
      ? [
          `Node ${n.id}: the lead suggested “${n.substituted.requestedAgentName}”, which is not granted to you — swapped to ${props.agentNameOf(n.ownerAgentId)}.`,
        ]
      : []),
    ...((n.droppedAllowedAgents ?? []).length
      ? [
          `Node ${n.id}: the delegation ceiling dropped un-granted agent(s) ${n.droppedAllowedAgents!.join(", ")} — not in your entitlements.`,
        ]
      : []),
    ...((n.droppedAllowedTools ?? []).length
      ? [
          `Node ${n.id}: the delegation ceiling dropped un-entitled tool(s) ${n.droppedAllowedTools!.join(", ")}.`,
        ]
      : []),
    ...((n.droppedToolServers ?? []).length
      ? [
          `Node ${n.id}: dropped tool server(s) ${n.droppedToolServers!.join(", ")} — you are not entitled on them.`,
        ]
      : []),
  ]);

  return (
    <div style={{ marginTop: "var(--s2)" }} data-testid="run-proposal">
      <div className={v.row}>
        <Badge tone="primary">plan drafted by {props.agentNameOf(dispatch.servedAgentId)}</Badge>
        <Badge
          title={
            dispatch.costUsd == null
              ? "the lead's model has no price on file — the cost is an honest null, not zero"
              : "what drafting this plan actually cost, metered like any dispatch"
          }
        >
          lead cost {dispatch.costUsd == null ? "unpriced" : fmtUsd(dispatch.costUsd)} ·{" "}
          {dispatch.modelUsed}
        </Badge>
        <Badge title="tokens the lead dispatch consumed">
          {dispatch.tokens.inputTokens} in / {dispatch.tokens.outputTokens} out
        </Badge>
        {retried && (
          <Badge
            tone="warn"
            title="the first draft failed validation; the lead corrected it on one retry"
          >
            retried once
          </Badge>
        )}
        <span className={v.grow} />
        <Button size="sm" onClick={props.onDiscard}>
          Discard plan
        </Button>
      </div>
      <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
        Review before planning — <strong>nothing runs until you press Plan run</strong>. Titles and
        owners are editable here; instructions and dependencies are the lead&apos;s draft and are
        validated by the kernel on submit.
      </div>
      {narrowings.length > 0 && (
        <div style={{ marginTop: "var(--s1)" }} data-testid="proposal-narrowings">
          {narrowings.map((n) => (
            <div key={n} className={v.dim} style={{ fontSize: "var(--text-xs)" }}>
              {n}
            </div>
          ))}
        </div>
      )}
      <Table<ProposalNode>
        columns={[
          { key: "id", header: "Node", render: (n) => <span className={v.mono}>{n.id}</span> },
          {
            key: "title",
            header: "Title",
            render: (n) => (
              <Input
                value={props.edits[n.id]?.title ?? n.title}
                aria-label={`Title for node ${n.id}`}
                onChange={(e) => setNode(n.id, { title: e.target.value })}
              />
            ),
          },
          {
            key: "owner",
            header: "Owner agent",
            render: (n) => (
              <Select
                value={props.edits[n.id]?.ownerAgentId ?? n.ownerAgentId}
                aria-label={`Owner agent for node ${n.id}`}
                onChange={(e) => setNode(n.id, { ownerAgentId: e.target.value })}
              >
                {props.agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>
                    {a.name} · tier {a.tier}
                  </option>
                ))}
              </Select>
            ),
          },
          {
            key: "depends",
            header: "Depends on",
            render: (n) =>
              n.dependsOn.length === 0 ? (
                <span className={v.faint}>—</span>
              ) : (
                <span className={v.mono}>{n.dependsOn.join(", ")}</span>
              ),
          },
          {
            key: "cap",
            header: "Suggested cap",
            align: "right",
            render: (n) =>
              n.budgetCapUsd == null ? (
                <span className={v.faint}>—</span>
              ) : (
                <span
                  className={v.num}
                  title="a suggestion only — the run budget and the transitive ceiling still enforce"
                >
                  {fmtUsd(n.budgetCapUsd)}
                </span>
              ),
          },
          {
            key: "instruction",
            header: "Instruction",
            render: (n) => (
              <span className={v.dim} title={n.instruction}>
                {n.instruction.length > 90 ? n.instruction.slice(0, 90) + "…" : n.instruction}
              </span>
            ),
          },
        ]}
        rows={proposal.nodes}
        rowKey={(n) => n.id}
      />
    </div>
  );
}
