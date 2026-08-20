/**
 * AI use-case registry (ADR-0080) — the pre-build front door.
 *
 * Governance that starts BEFORE anything runs: propose an AI use case, refine
 * it at the resting plan stage, fill the intake questionnaire, and a human
 * sign-off on the ONE approvals queue registers it. Three things this page
 * keeps honest, rendered rather than merely documented:
 *
 *  - **Status is decided, never edited.** There is no status control anywhere
 *    here. Approved/rejected happen in the Approvals queue, on the linked
 *    workflow instance; this page only shows the result.
 *  - **The questionnaire is a form the proposer fills.** No AI pre-fill — the
 *    blank template arrives from the server and the filled version is
 *    submitted as the intake instance's versioned artifact.
 *  - **The cascade card is derived, never duplicated.** The consequences shown
 *    for a use case's compliance tags come from the same profile resolution
 *    the enforcement cascade reads; editing a profile changes this card on the
 *    next load.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useAgents, useComplianceProfiles, useProjects, agentOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type UseCaseStatus = "proposed" | "under_review" | "approved" | "rejected" | "retired";

interface UseCaseRow {
  id: string;
  name: string;
  description: string;
  businessContext: string;
  ownerUserId: string;
  ownerName?: string | null;
  intendedAgentIds: string[];
  dataSensitivity: string;
  complianceTags: string[];
  projectId: string | null;
  status: UseCaseStatus;
  workflowInstanceId: string | null;
  decidedAt: string | null;
  retiredReason: string | null;
  createdAt: string;
}
interface RequiredTemplate {
  id: string;
  name: string;
  retired: boolean;
  stageIds: string[];
}
interface CascadeCard {
  profiles: Array<{
    tag: string;
    piiMode: string;
    auditRetentionDays: number | null;
    mcpDefaultMode: string;
    requiredTemplates: RequiredTemplate[];
  }>;
  unrecognizedTags: string[];
  combined: {
    piiMode: string;
    auditRetentionDays: number | null;
    mcpDefaultMode: string;
    requiredTemplates: RequiredTemplate[];
    forcedStageIds: string[];
  } | null;
  project: {
    id: string;
    name: string;
    classifications: string[];
    tagsCarried: string[];
    tagsNotCarried: string[];
  } | null;
  note: string;
}
interface UseCaseDetail {
  useCase: UseCaseRow;
  instance: {
    id: string;
    status: string;
    currentStageId: string | null;
    stages: Array<{ id: string; type: string }>;
  } | null;
  questionnaire: { version: number; content: string; createdAt: string } | null;
  questionnaireTemplate: string | null;
  cascadeConsequences: CascadeCard;
}

const statusTone = (s: UseCaseStatus): Tone =>
  s === "approved" ? "ok" : s === "under_review" ? "info" : s === "rejected" ? "danger" : s === "retired" ? "warn" : "neutral";

export default function UseCasesPage() {
  const agents = useAgents();
  const projects = useProjects();
  const profiles = useComplianceProfiles();
  const act = useAction();

  const list = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases: UseCaseRow[] }>("/v1/use-cases"),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["admin", "use-case", openId],
    queryFn: () => api.get<UseCaseDetail>(`/v1/use-cases/${openId}`),
    enabled: Boolean(openId),
  });

  // propose form
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [context, setContext] = useState("");
  const [sensitivity, setSensitivity] = useState("internal");
  const [tags, setTags] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");

  // questionnaire + retire
  const [answers, setAnswers] = useState("");
  const [retireReason, setRetireReason] = useState("");

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Use cases"
        sub="Governance before anything runs: a proposed AI use case starts a real intake workflow — plan, questionnaire, human sign-off on the one Approvals queue — and approval registers it as a governance object whose compliance tags are the same tags the cascade enforces. Approval registers intent; it does not yet gate dispatch."
      />
      <div className={v.stack}>
        {/* ---------------- propose ---------------- */}
        <Card title="Propose an AI use case">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/use-cases", {
                  name,
                  description: desc,
                  businessContext: context,
                  dataSensitivity: sensitivity,
                  complianceTags: tags.split(",").map((t) => t.trim()).filter(Boolean),
                  intendedAgentIds: agentId ? [agentId] : [],
                  ...(projectId ? { projectId } : {}),
                });
                setName("");
                setDesc("");
                setContext("");
                setTags("");
                await refreshAll();
              }, "Use case proposed — its intake workflow is resting at the plan stage");
            }}
          >
            <div className={a.formRow}>
              <Field label="Name" grow>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="summarize support tickets" required />
              </Field>
              <Field label="Data sensitivity">
                <Select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                  <option value="public">public</option>
                  <option value="internal">internal</option>
                  <option value="confidential">confidential</option>
                  <option value="regulated">regulated</option>
                </Select>
              </Field>
            </div>
            <Field label="Description">
              <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} required />
            </Field>
            <Field label="Business context — why the business wants this">
              <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} required />
            </Field>
            <div className={a.formRow}>
              <Field label="Compliance tags (comma-separated — the cascade's own tags)" grow>
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder={(profiles.data?.profiles ?? []).map((p) => p.tag).slice(0, 3).join(", ") || "hipaa, pci-dss"}
                />
              </Field>
              <Field label="Intended agent (optional)">
                <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {optionEls(agentOpts(agents.data?.agents), "none yet")}
                </Select>
              </Field>
              <Field label="Project (optional)">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {optionEls((projects.data?.projects ?? []).map((p) => ({ v: p.id, l: p.name })), "none yet")}
                </Select>
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={act.busy}>Propose use case</Button>
            </div>
          </form>
        </Card>

        {/* ---------------- registry ---------------- */}
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <Card title="Registry">
            {(list.data?.useCases ?? []).length === 0 ? (
              <EmptyState
                title="No use cases yet"
                body="Propose one above — the front door is how governance starts before the first call."
              />
            ) : (
              <Table
                rows={list.data?.useCases ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
                columns={[
                  { key: "name", header: "Name", render: (r) => r.name },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => <Badge tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Badge>,
                  },
                  { key: "sens", header: "Sensitivity", render: (r) => r.dataSensitivity },
                  {
                    key: "tags",
                    header: "Compliance tags",
                    render: (r) => (r.complianceTags.length ? r.complianceTags.join(", ") : <span className={v.faint}>none</span>),
                  },
                  { key: "owner", header: "Owner", render: (r) => r.ownerName ?? r.ownerUserId },
                  { key: "created", header: "Proposed", render: (r) => ago(r.createdAt) },
                ]}
              />
            )}
          </Card>
        </QueryGate>

        {/* ---------------- detail ---------------- */}
        {openId && (
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {d && (
              <Card
                title={`Use case: ${d.useCase.name}`}
                actions={<Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>}
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={statusTone(d.useCase.status)}>{d.useCase.status.replace("_", " ")}</Badge>{" "}
                    <span className={v.faint}>
                      {d.useCase.status === "retired"
                        ? `retired: ${d.useCase.retiredReason}`
                        : d.useCase.decidedAt
                          ? `decided ${ago(d.useCase.decidedAt)} by the intake instance's sign-off`
                          : "status follows the linked intake workflow — it is decided, never edited here"}
                    </span>
                  </div>
                  <div className={v.faint}>{d.useCase.description}</div>
                  <div className={v.faint}>Business context: {d.useCase.businessContext}</div>

                  {/* the linked workflow's state */}
                  {d.instance && (
                    <Card title="Intake workflow (pillar-2 rails)">
                      <div className={v.stack}>
                        <div>
                          {d.instance.stages.map((s) => (
                            <Badge
                              key={s.id}
                              tone={s.id === d.instance!.currentStageId ? "info" : "neutral"}
                              title={s.type}
                            >
                              {s.id}
                            </Badge>
                          ))}{" "}
                          <span className={v.faint}>instance {d.instance.status.replace(/_/g, " ")}</span>
                        </div>
                        {d.instance.status === "blocked_on_plan" && (
                          <div>
                            <Button
                              onClick={() =>
                                void act.run(async () => {
                                  await api.post(`/v1/workflows/instances/${d.instance!.id}/advance`, { stageId: "plan" });
                                  await refreshAll();
                                }, "Planning finished — fill and submit the questionnaire")
                              }
                            >
                              Finish planning
                            </Button>{" "}
                            <span className={v.faint}>
                              The instance rests at the plan stage (ADR-0079) while the proposal is refined.
                            </span>
                          </div>
                        )}
                        {d.instance.status === "blocked_on_approval" && (
                          <div className={v.faint}>
                            Awaiting sign-off — the decision happens in the{" "}
                            <Link to="/admin/approvals">Approvals queue</Link>, never here.
                          </div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* questionnaire: submitted artifact, or the blank form to fill */}
                  {d.questionnaire ? (
                    <Card title={`Intake questionnaire (artifact v${d.questionnaire.version})`}>
                      <pre className={v.pre ?? undefined} style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                        {d.questionnaire.content}
                      </pre>
                    </Card>
                  ) : d.instance && d.instance.status === "blocked_on_artifact" ? (
                    <Card title="Intake questionnaire — fill and submit">
                      <div className={v.stack}>
                        <div className={v.faint}>
                          The form is the deliverable — nothing is pre-filled by a model. Submitting stores it as the
                          instance&apos;s versioned artifact and sends the use case to review.
                        </div>
                        <Textarea
                          rows={14}
                          value={answers || d.questionnaireTemplate || ""}
                          onChange={(e) => setAnswers(e.target.value)}
                        />
                        <div>
                          <Button
                            disabled={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await api.post(`/v1/workflows/instances/${d.instance!.id}/artifacts`, {
                                  stageId: "questionnaire",
                                  content: answers || d.questionnaireTemplate || "",
                                });
                                setAnswers("");
                                await refreshAll();
                              }, "Questionnaire submitted — the use case is under review")
                            }
                          >
                            Submit questionnaire
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ) : null}

                  {/* cascade consequences — derived from the real cascade rules */}
                  <Card title="Cascade consequences of the compliance tags">
                    <div className={v.stack}>
                      <div className={v.faint}>{d.cascadeConsequences.note}</div>
                      {d.cascadeConsequences.combined && (
                        <div className={a.formRow}>
                          <Field label="PII mode (strictest)">
                            <Input readOnly value={d.cascadeConsequences.combined.piiMode} />
                          </Field>
                          <Field label="MCP default">
                            <Input readOnly value={d.cascadeConsequences.combined.mcpDefaultMode} />
                          </Field>
                          <Field label="Audit retention (days)">
                            <Input readOnly value={d.cascadeConsequences.combined.auditRetentionDays ?? "org default"} />
                          </Field>
                          <Field label="Forced workflow stages">
                            <Input
                              readOnly
                              value={d.cascadeConsequences.combined.forcedStageIds.join(", ") || "none"}
                            />
                          </Field>
                        </div>
                      )}
                      {d.cascadeConsequences.profiles.map((p) => (
                        <div key={p.tag}>
                          <Badge tone="info">{p.tag}</Badge>{" "}
                          <span className={v.faint}>
                            pii {p.piiMode}, mcp {p.mcpDefaultMode}
                            {p.requiredTemplates.length > 0 &&
                              `, forces ${p.requiredTemplates.map((t) => t.name).join(", ")}`}
                          </span>
                        </div>
                      ))}
                      {d.cascadeConsequences.unrecognizedTags.length > 0 && (
                        <div>
                          <Badge tone="warn">unrecognized</Badge>{" "}
                          <span className={v.faint}>
                            {d.cascadeConsequences.unrecognizedTags.join(", ")} — no compliance profile defines these
                            tags, so the cascade currently forces nothing for them
                          </span>
                        </div>
                      )}
                      {d.cascadeConsequences.project && (
                        <div>
                          <Badge tone={d.cascadeConsequences.project.tagsNotCarried.length ? "warn" : "ok"}>
                            project {d.cascadeConsequences.project.name}
                          </Badge>{" "}
                          <span className={v.faint}>
                            carries {d.cascadeConsequences.project.tagsCarried.join(", ") || "none of these tags"}
                            {d.cascadeConsequences.project.tagsNotCarried.length > 0 &&
                              ` — NOT yet classified with ${d.cascadeConsequences.project.tagsNotCarried.join(", ")}, so those consequences are not enforced there`}
                          </span>
                        </div>
                      )}
                    </div>
                  </Card>

                  {/* retire (admin) */}
                  {d.useCase.status !== "retired" && (
                    <div className={a.formRow}>
                      <Field label="Retire (admin) — reason is required and audited" grow>
                        <Input
                          value={retireReason}
                          onChange={(e) => setRetireReason(e.target.value)}
                          placeholder="superseded by a narrower use case"
                        />
                      </Field>
                      <Field label=" ">
                        <Button
                          variant="danger"
                          disabled={act.busy || !retireReason.trim()}
                          onClick={() =>
                            void act.run(async () => {
                              await api.post(`/v1/use-cases/${d.useCase.id}/retire`, { reason: retireReason.trim() });
                              setRetireReason("");
                              await refreshAll();
                            }, "Use case retired")
                          }
                        >
                          Retire use case
                        </Button>
                      </Field>
                    </div>
                  )}
                </div>
              </Card>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}
