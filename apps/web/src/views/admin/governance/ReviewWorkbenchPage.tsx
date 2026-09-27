/**
 * Review workbench (ADR-0046).
 *
 * The Approvals Queue scaled for volume — routing, SLA timers, escalation,
 * per-reviewer workload and bulk triage — all over the SAME `approvals` rows the
 * queue page shows. There is no second store and no second decision path.
 *
 * Four things this screen exists to keep honest:
 *
 *  - **Nothing here fires on its own.** The SLA panel says so in those words:
 *    breach is evaluated when the queue is read, when an approval is decided, or
 *    when the sweep button is pressed. There is no in-process scheduler, and a
 *    page implying one would be the lie the whole product is against.
 *  - **Escalation never decides.** The policy editor offers add-assignee,
 *    reassign and notify-only, and there is deliberately no auto-approve option
 *    to reach for.
 *  - **Routing decides whose queue, not who may act.** Said next to the rule
 *    editor, because the opposite reading is the dangerous one.
 *  - **Bulk is fenced, and the fence is visible.** The cap and the
 *    high-sensitivity exclusion are shown before the button, and every item
 *    comes back with its own result — a refused item never hides behind a
 *    successful batch.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useProjects, useTeams, useUsers, projectOpts, teamOpts, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface SlaPolicy {
  id: string;
  name: string;
  warnAfterMinutes: number;
  breachAfterMinutes: number;
  escalateAction: "add_assignee" | "reassign" | "notify_only";
  escalateToKind: string | null;
  escalateToId: string | null;
  enabled: boolean;
}
interface AssignmentRule {
  id: string;
  name: string;
  objectType: string | null;
  projectId: string | null;
  dataSensitivity: string | null;
  stagePattern: string | null;
  templateId: string | null;
  assigneeKind: "user" | "role" | "team";
  assigneeId: string;
  quorum: number;
  priority: number;
  slaPolicyId: string | null;
  enabled: boolean;
}
interface WorkloadRow {
  kind: string;
  id: string;
  name: string | null;
  open: number;
  dueSoon: number;
  breached: number;
}
interface QueueRow {
  id: string;
  objectType: string;
  status: string;
  approverUserId: string;
  approverName: string | null;
  objectLabel: string | null;
  requestedAt: string;
  assignment?: {
    assigneeKind: string;
    assigneeId: string;
    claimedByUserId: string | null;
    claimable: boolean;
    slaState: "ok" | "warning" | "breached";
    dueAt: string | null;
    escalationAssigneeKind: string | null;
  };
}

const OBJECT_TYPES = ["mcp_tool", "workflow", "run", "project", "infra_operation", "model_card"];

const slaTone = (s: string | undefined) =>
  s === "breached" ? "danger" : s === "warning" ? "warn" : "neutral";

export default function ReviewWorkbenchPage() {
  const { auth } = useSession();
  const me = auth?.userId ?? null;
  const act = useAction();
  const users = useUsers();
  const teams = useTeams();
  const projects = useProjects();

  const policies = useQuery({
    queryKey: ["admin", "approval-sla-policies"],
    queryFn: () => api.get<{ policies: SlaPolicy[]; note: string }>("/v1/approvals/sla-policies"),
  });
  const rules = useQuery({
    queryKey: ["admin", "approval-assignment-rules"],
    queryFn: () => api.get<{ rules: AssignmentRule[]; note: string }>("/v1/approvals/assignment-rules"),
  });
  const workload = useQuery({
    queryKey: ["admin", "approval-workload"],
    queryFn: () => api.get<{ workload: WorkloadRow[]; note: string }>("/v1/approvals/workload"),
  });
  const queue = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: QueueRow[] }>("/v1/approvals"),
  });

  // policy draft
  const [pName, setPName] = useState("");
  const [pWarn, setPWarn] = useState("60");
  const [pBreach, setPBreach] = useState("240");
  const [pAction, setPAction] = useState<SlaPolicy["escalateAction"]>("add_assignee");
  const [pKind, setPKind] = useState("user");
  const [pTarget, setPTarget] = useState("");

  // rule draft
  const [rName, setRName] = useState("");
  const [rObjectType, setRObjectType] = useState("");
  const [rProject, setRProject] = useState("");
  const [rSensitivity, setRSensitivity] = useState("");
  const [rStage, setRStage] = useState("");
  const [rKind, setRKind] = useState<"user" | "team">("team");
  const [rTarget, setRTarget] = useState("");
  const [rPriority, setRPriority] = useState("100");
  const [rPolicy, setRPolicy] = useState("");

  // bulk
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [bulkReason, setBulkReason] = useState("");
  const [bulkResults, setBulkResults] = useState<
    Array<{ approvalId: string; ok: boolean; error?: string; detail?: string }> | null
  >(null);

  const refreshAll = async () => {
    await Promise.all([policies.refetch(), rules.refetch(), workload.refetch(), queue.refetch()]);
  };

  const pending = (queue.data?.approvals ?? []).filter((r) => r.status === "pending");
  const selectedIds = Object.entries(selected)
    .filter(([, on]) => on)
    .map(([id]) => id);

  return (
    <>
      <PageHeader
        title="Review workbench"
        sub="Routing, SLA timers and bulk triage over the one approvals queue."
        info={<p>Routing, SLA timers, escalation and bulk triage over the SAME approvals the queue shows — one approval object, one decision path, one audit trail. Nothing here decides anything on a timer: escalation moves work toward someone who can decide it, and a queue that cleared itself by timeout would be a bypass, not a feature.</p>}
      />
      <div className={v.stack}>
        <QueryGate
          loading={policies.isLoading || rules.isLoading}
          error={policies.error ?? rules.error}
          onRetry={() => void refreshAll()}
        >
          {/* ---------------- workload ---------------- */}
          <Card title="Per-reviewer workload">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {workload.data?.note}
            </div>
            {(workload.data?.workload ?? []).length === 0 ? (
              <EmptyState title="No open approvals" body="Nothing is waiting on a human right now." />
            ) : (
              <Table
                rows={workload.data?.workload ?? []}
                rowKey={(r) => `${r.kind}:${r.id}`}
                columns={[
                  { key: "who", header: "Queue", render: (r) => r.name ?? `${r.kind} ${r.id.slice(0, 8)}` },
                  { key: "kind", header: "Kind", render: (r) => r.kind },
                  { key: "open", header: "Open", render: (r) => r.open },
                  { key: "soon", header: "Due soon", render: (r) => r.dueSoon },
                  {
                    key: "breached",
                    header: "Breached",
                    render: (r) =>
                      r.breached > 0 ? <Badge tone="danger">{r.breached}</Badge> : r.breached,
                  },
                ]}
              />
            )}
            <div style={{ marginTop: "var(--s2)" }}>
              <Button
                onClick={() =>
                  void act.run(async () => {
                    const r = await api.post<{ evaluated: number; breached: number; warned: number }>(
                      "/v1/approvals/sla/sweep",
                      {},
                    );
                    await refreshAll();
                    return `${r.evaluated} evaluated · ${r.breached} newly breached · ${r.warned} newly warned`;
                  })
                }
              >
                Run SLA sweep
              </Button>
            </div>
            <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
              Nothing calls this on a timer — there is no in-process scheduler in this deployment. Breach is
              also evaluated whenever the queue is read or an approval is decided, and the deadlines are a
              pure function of the request time, so a lazily detected breach is exactly what a timer would
              have produced.
            </div>
          </Card>

          {/* ---------------- SLA policies ---------------- */}
          <Card title="SLA policies">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {policies.data?.note}
            </div>
            <form
              className={a.formRow}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api.post("/v1/approvals/sla-policies", {
                    name: pName,
                    warnAfterMinutes: Number(pWarn),
                    breachAfterMinutes: Number(pBreach),
                    escalateAction: pAction,
                    ...(pAction === "notify_only" ? {} : { escalateToKind: pKind, escalateToId: pTarget }),
                  });
                  setPName("");
                  setPTarget("");
                  await refreshAll();
                }, "SLA policy created");
              }}
            >
              <Field label="Name">
                <Input value={pName} onChange={(e) => setPName(e.target.value)} required />
              </Field>
              <Field label="Warn after (min)">
                <Input type="number" value={pWarn} onChange={(e) => setPWarn(e.target.value)} required />
              </Field>
              <Field label="Breach after (min)">
                <Input type="number" value={pBreach} onChange={(e) => setPBreach(e.target.value)} required />
              </Field>
              <Field label="On breach">
                <Select value={pAction} onChange={(e) => setPAction(e.target.value as SlaPolicy["escalateAction"])}>
                  <option value="add_assignee">add an escalation assignee</option>
                  <option value="reassign">reassign to one user</option>
                  <option value="notify_only">record only</option>
                </Select>
              </Field>
              {pAction !== "notify_only" && (
                <>
                  <Field label="Escalate to">
                    <Select
                      value={pKind}
                      onChange={(e) => {
                        setPKind(e.target.value);
                        setPTarget("");
                      }}
                    >
                      <option value="user">user</option>
                      {pAction !== "reassign" && <option value="team">team</option>}
                    </Select>
                  </Field>
                  <Field label="Target">
                    <Select value={pTarget} onChange={(e) => setPTarget(e.target.value)} required>
                      {optionEls(
                        pKind === "team" ? teamOpts(teams.data?.teams) : userOpts(users.data?.users),
                        "select",
                      )}
                    </Select>
                  </Field>
                </>
              )}
              <Field label="&nbsp;">
                <Button type="submit" disabled={!pName}>
                  Add policy
                </Button>
              </Field>
            </form>
            {(policies.data?.policies ?? []).length > 0 && (
              <Table
                rows={policies.data?.policies ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "n", header: "Name", render: (r) => r.name },
                  { key: "w", header: "Warn", render: (r) => `${r.warnAfterMinutes}m` },
                  { key: "b", header: "Breach", render: (r) => `${r.breachAfterMinutes}m` },
                  { key: "a", header: "On breach", render: (r) => r.escalateAction },
                  {
                    key: "x",
                    header: "",
                    render: (r) => (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void act.run(async () => {
                            await api.del(`/v1/approvals/sla-policies/${r.id}`);
                            await refreshAll();
                          }, "SLA policy removed")
                        }
                      >
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          {/* ---------------- routing rules ---------------- */}
          <Card title="Routing rules">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {rules.data?.note}
            </div>
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api.post("/v1/approvals/assignment-rules", {
                    name: rName,
                    ...(rObjectType ? { objectType: rObjectType } : {}),
                    ...(rProject ? { projectId: rProject } : {}),
                    ...(rSensitivity ? { dataSensitivity: rSensitivity } : {}),
                    ...(rStage ? { stagePattern: rStage } : {}),
                    assigneeKind: rKind,
                    assigneeId: rTarget,
                    priority: Number(rPriority),
                    ...(rPolicy ? { slaPolicyId: rPolicy } : {}),
                  });
                  setRName("");
                  setRTarget("");
                  await refreshAll();
                }, "Routing rule created");
              }}
            >
              <div className={a.formRow}>
                <Field label="Name">
                  <Input value={rName} onChange={(e) => setRName(e.target.value)} required />
                </Field>
                <Field label="Object type">
                  <Select value={rObjectType} onChange={(e) => setRObjectType(e.target.value)}>
                    <option value="">any</option>
                    {OBJECT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Project">
                  <Select value={rProject} onChange={(e) => setRProject(e.target.value)}>
                    {optionEls(projectOpts(projects.data?.projects), "any")}
                  </Select>
                </Field>
                <Field label="Data sensitivity">
                  <Input
                    value={rSensitivity}
                    onChange={(e) => setRSensitivity(e.target.value)}
                    placeholder="e.g. hipaa"
                  />
                </Field>
                <Field label="Stage pattern">
                  <Input value={rStage} onChange={(e) => setRStage(e.target.value)} placeholder="stage:*" />
                </Field>
              </div>
              <div className={a.formRow}>
                <Field label="Route to">
                  <Select
                    value={rKind}
                    onChange={(e) => {
                      setRKind(e.target.value as "user" | "team");
                      setRTarget("");
                    }}
                  >
                    <option value="team">team</option>
                    <option value="user">user</option>
                  </Select>
                </Field>
                <Field label="Target">
                  <Select value={rTarget} onChange={(e) => setRTarget(e.target.value)} required>
                    {optionEls(
                      rKind === "team" ? teamOpts(teams.data?.teams) : userOpts(users.data?.users),
                      "select",
                    )}
                  </Select>
                </Field>
                <Field label="Priority (lower wins)">
                  <Input type="number" value={rPriority} onChange={(e) => setRPriority(e.target.value)} />
                </Field>
                <Field label="SLA policy">
                  <Select value={rPolicy} onChange={(e) => setRPolicy(e.target.value)}>
                    <option value="">none</option>
                    {(policies.data?.policies ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="&nbsp;">
                  <Button type="submit" disabled={!rName || !rTarget}>
                    Add rule
                  </Button>
                </Field>
              </div>
              <div className={v.faint}>
                A rule with no conditions is refused — it would silently capture every approval in the
                deployment. Routing changes whose queue an item shows in; the decide endpoint still checks who
                is allowed to act, independently.
              </div>
            </form>
            {(rules.data?.rules ?? []).length > 0 && (
              <Table
                rows={rules.data?.rules ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "p", header: "Pri", render: (r) => r.priority },
                  { key: "n", header: "Name", render: (r) => r.name },
                  {
                    key: "m",
                    header: "Matches",
                    render: (r) =>
                      [
                        r.objectType && `type=${r.objectType}`,
                        r.projectId && "project",
                        r.dataSensitivity && `sensitivity=${r.dataSensitivity}`,
                        r.stagePattern && `stage=${r.stagePattern}`,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                  },
                  { key: "to", header: "Routes to", render: (r) => r.assigneeKind },
                  {
                    key: "sla",
                    header: "SLA",
                    render: (r) =>
                      (policies.data?.policies ?? []).find((p) => p.id === r.slaPolicyId)?.name ?? "—",
                  },
                  {
                    key: "x",
                    header: "",
                    render: (r) => (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void act.run(async () => {
                            await api.del(`/v1/approvals/assignment-rules/${r.id}`);
                            await refreshAll();
                          }, "Routing rule removed")
                        }
                      >
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          {/* ---------------- triage ---------------- */}
          <Card title="Triage">
            {pending.length === 0 ? (
              <EmptyState title="Nothing pending" body="The queue is empty." />
            ) : (
              <>
                <Table
                  rows={pending}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      key: "sel",
                      header: "",
                      render: (r) => (
                        <input
                          type="checkbox"
                          checked={Boolean(selected[r.id])}
                          onChange={(e) => setSelected((s) => ({ ...s, [r.id]: e.target.checked }))}
                          aria-label={`select ${r.id}`}
                        />
                      ),
                    },
                    { key: "what", header: "What", render: (r) => r.objectLabel ?? r.objectType },
                    { key: "who", header: "Approver", render: (r) => r.approverName ?? "—" },
                    {
                      key: "queue",
                      header: "Queue",
                      render: (r) =>
                        r.assignment ? `${r.assignment.assigneeKind}${r.assignment.claimedByUserId ? " (claimed)" : ""}` : "—",
                    },
                    {
                      key: "sla",
                      header: "SLA",
                      render: (r) =>
                        r.assignment?.dueAt ? (
                          <Badge tone={slaTone(r.assignment.slaState)}>
                            {r.assignment.slaState} · due {ago(r.assignment.dueAt)}
                          </Badge>
                        ) : (
                          "—"
                        ),
                    },
                    { key: "age", header: "Waiting", render: (r) => ago(r.requestedAt) },
                    {
                      key: "claim",
                      header: "",
                      render: (r) =>
                        r.assignment?.claimable ? (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void act.run(async () => {
                                await api.post(`/v1/approvals/${r.id}/claim`, {});
                                await refreshAll();
                              }, "Claimed — it is now yours to decide")
                            }
                          >
                            Claim
                          </Button>
                        ) : r.approverUserId === me ? (
                          <span className={v.faint}>yours</span>
                        ) : (
                          ""
                        ),
                    },
                  ]}
                />
                <form
                  className={v.stack}
                  style={{ marginTop: "var(--s3)" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      const r = await api.post<{
                        decided: number;
                        refused: number;
                        results: Array<{ approvalId: string; ok: boolean; error?: string; detail?: string }>;
                      }>("/v1/approvals/bulk", {
                        approvalIds: selectedIds,
                        decision: "approved",
                        reason: bulkReason,
                      });
                      setBulkResults(r.results);
                      setSelected({});
                      await refreshAll();
                      return `${r.decided} decided · ${r.refused} refused`;
                    });
                  }}
                >
                  <Field label={`Bulk reason (applies to each of the ${selectedIds.length} selected)`}>
                    <Textarea
                      rows={2}
                      value={bulkReason}
                      onChange={(e) => setBulkReason(e.target.value)}
                      placeholder="why this batch is being decided together"
                    />
                  </Field>
                  <div className={a.formRow}>
                    <Button type="submit" disabled={selectedIds.length === 0 || !bulkReason.trim()}>
                      Bulk approve
                    </Button>
                    <Button
                      variant="danger"
                      type="button"
                      disabled={selectedIds.length === 0 || !bulkReason.trim()}
                      onClick={() =>
                        void act.run(async () => {
                          const r = await api.post<{
                            decided: number;
                            refused: number;
                            results: Array<{ approvalId: string; ok: boolean; error?: string; detail?: string }>;
                          }>("/v1/approvals/bulk", {
                            approvalIds: selectedIds,
                            decision: "denied",
                            reason: bulkReason,
                          });
                          setBulkResults(r.results);
                          setSelected({});
                          await refreshAll();
                          return `${r.decided} denied · ${r.refused} refused`;
                        })
                      }
                    >
                      Bulk deny
                    </Button>
                  </div>
                  <div className={v.faint}>
                    A bulk is N individual decisions through the one decide endpoint, each with its own audit
                    row — never one opaque event. It is capped per action, and it is refused item-by-item on
                    approvals attributed to a project whose compliance cascade blocks PII. Those must be
                    decided individually; the friction is the control.
                  </div>
                </form>
                {bulkResults && (
                  <Table
                    rows={bulkResults}
                    rowKey={(r) => r.approvalId}
                    columns={[
                      { key: "id", header: "Approval", render: (r) => r.approvalId.slice(0, 8) },
                      {
                        key: "ok",
                        header: "Result",
                        render: (r) =>
                          r.ok ? <Badge tone="ok">decided</Badge> : <Badge tone="danger">{r.error}</Badge>,
                      },
                      { key: "d", header: "Detail", render: (r) => r.detail ?? "" },
                    ]}
                  />
                )}
              </>
            )}
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
