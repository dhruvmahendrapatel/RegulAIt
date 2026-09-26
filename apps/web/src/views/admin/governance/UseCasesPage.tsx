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
import { Badge, Button, Card, EmptyState, Field, InfoButton, Input, Select, Table, TagPicker, Textarea, type Tone } from "../../../ui/kit";
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
  euAiActTier: EuTier | null;
  euAiActReasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }> | null;
  euAiActRulesetVersion: number | null;
  decidedAt: string | null;
  retiredReason: string | null;
  createdAt: string;
}
type EuTier = "prohibited" | "high" | "limited" | "minimal";
interface EuScreening {
  tier: EuTier | null;
  reasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }> | null;
  rulesetVersion: number | null;
  disclaimer: string;
  enforcement: string;
  answersStatus: "no_questionnaire" | "missing" | "invalid" | "ok";
  answersError: string | null;
  refusal: string | null;
  cascade: {
    recommendedTags: Array<{ tag: string; fromPack: string; profileExists: boolean; carriedByUseCase: boolean }>;
    packs: Array<{
      id: string;
      framework: string;
      version: number;
      title: string;
      cascadeTag: string | null;
      profileExists: boolean;
      carriedByUseCase: boolean;
      controls: Array<{ controlRef: string; title: string }>;
    }>;
    note: string;
  } | null;
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
  euAiActScreening: EuScreening;
  /** ADR-0089: the use-case side of intended-vs-granted, computed at read time */
  intendedVsGranted: {
    status: "aligned" | "undershoot" | "not_approved" | "no_intent_recorded";
    note: string;
    agents?: Array<{
      agentId: string;
      agentName: string | null;
      registered: boolean;
      grantedToParticipants: boolean;
      participantHolders: number;
    }>;
  };
}

const statusTone = (s: UseCaseStatus): Tone =>
  s === "approved" ? "ok" : s === "under_review" ? "info" : s === "rejected" ? "danger" : s === "retired" ? "warn" : "neutral";

const tierTone = (t: EuTier): Tone =>
  t === "prohibited" ? "danger" : t === "high" ? "warn" : t === "limited" ? "info" : "ok";

// the screening questionnaire vocabulary — mirrors euAiActAnswersSchema in
// @regulait/shared (the server refuses anything else, so drift fails loudly)
const EU_DOMAINS = [
  ["general-business", "General business use"],
  ["internal-productivity", "Internal productivity / tooling"],
  ["employment-hr", "Employment / HR (recruitment, evaluation)"],
  ["education", "Education / vocational training"],
  ["essential-services", "Essential services (credit, benefits, insurance)"],
  ["law-enforcement", "Law enforcement"],
  ["migration-border", "Migration / asylum / border control"],
  ["justice-democracy", "Justice / democratic processes"],
  ["critical-infrastructure", "Critical infrastructure"],
] as const;
const EU_AUTONOMY = [
  ["narrow-procedural", "Narrow procedural task — a human fully decides"],
  ["informs-human", "Informs a human decision"],
  ["human-reviews", "Decides, a human reviews"],
  ["fully-automated", "Fully automated decisions"],
] as const;
const EU_BIOMETRIC = [
  ["none", "No biometric use"],
  ["verification", "1:1 verification only (unlock/login)"],
  ["remote-identification", "Remote biometric identification"],
] as const;
const EU_AFFECTED = [
  ["employees", "Employees"],
  ["customers", "Customers"],
  ["general-public", "General public"],
  ["vulnerable-groups", "Vulnerable groups"],
] as const;
const EU_FLAGS = [
  ["emotionRecognition", "Emotion recognition"],
  ["socialScoring", "Social scoring"],
  ["manipulativeTechniques", "Manipulative or deceptive techniques"],
  ["profilesNaturalPersons", "Profiles natural persons"],
  ["safetyComponent", "Safety component of a regulated product"],
  ["interactsWithHumans", "People interact with it directly"],
  ["generatesSyntheticContent", "Generates synthetic content"],
] as const;
const INTAKE_STEPS = ["What it is", "Data & risk", "Intended use", "Review"] as const;

const EU_ANSWERS_FENCE_RE = /```eu-ai-act-answers[\s\S]*?```/g;

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
  const [tags, setTags] = useState<string[]>([]);
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  /**
   * The intake is staged rather than one wall of fields, because the stages ARE
   * the governance: what it is, what data it touches, what it may use. A person
   * who has answered "regulated" should be looking at the tag picker next, not
   * scrolling past it. `step` is the cursor; nothing is submitted until step 4.
   */
  const [step, setStep] = useState(0);

  // questionnaire + retire
  const [answers, setAnswers] = useState("");
  const [retireReason, setRetireReason] = useState("");

  // ADR-0089 B3 — the intent-capture edit buffer (null = mirror the stored
  // intent). Editable only pre-decision; the server refuses the rest by name.
  const [intentDraft, setIntentDraft] = useState<string[] | null>(null);

  // EU AI Act screening answers (ADR-0085) — serialized into the questionnaire
  // as the fenced eu-ai-act-answers block; the TIER is computed server-side
  const [euDomain, setEuDomain] = useState("general-business");
  const [euAutonomy, setEuAutonomy] = useState("informs-human");
  const [euBiometric, setEuBiometric] = useState("none");
  const [euAffected, setEuAffected] = useState<string[]>([]);
  const [euFlags, setEuFlags] = useState<Record<string, boolean>>(
    Object.fromEntries(EU_FLAGS.map(([k]) => [k, false])),
  );

  /** the questionnaire the server stores: the prose, with exactly one
   * canonical answers block appended (any hand-pasted block is replaced) */
  const questionnaireWithAnswersBlock = (prose: string) => {
    const block =
      "```eu-ai-act-answers\n" +
      JSON.stringify(
        {
          purposeDomain: euDomain,
          affectedPersons: euAffected,
          decisionAutonomy: euAutonomy,
          biometricUse: euBiometric,
          ...euFlags,
        },
        null,
        2,
      ) +
      "\n```";
    return prose.replace(EU_ANSWERS_FENCE_RE, "").trimEnd() + "\n\n" + block + "\n";
  };

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Use cases"
        sub="Every AI use case, from proposal to sign-off to retirement."
      />
      <div className={v.stack}>
        {/* ---------------- propose ---------------- */}
        <Card
          title="Propose an AI use case"
          actions={
            <InfoButton label="proposing a use case" align="end">
              <p>
                Governance before anything runs. Proposing starts a real intake workflow — plan, questionnaire,
                human sign-off on the one Approvals queue — and approval registers the use case as a governance
                object whose compliance tags are the same tags the cascade enforces.
              </p>
              <p>
                Approval registers <em>intent</em>. It only gates dispatch where the org's use-case gate is armed
                (Settings → Organization); that ships off.
              </p>
            </InfoButton>
          }
        >
          <ol className={a.steps} aria-label="Intake progress">
            {INTAKE_STEPS.map((label, i) => (
              <li key={label} className={i === step ? a.stepOn : i < step ? a.stepDone : undefined}>
                <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
                  <span className={a.stepNum}>{i < step ? "✓" : i + 1}</span>
                  {label}
                </button>
              </li>
            ))}
          </ol>

          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              // Only the final step submits. Without this guard an Enter press
              // in any text field on step 1 would propose a half-filled use
              // case — a governance object created by a keystroke nobody meant.
              if (step < INTAKE_STEPS.length - 1) return setStep((n) => n + 1);
              void act.run(async () => {
                await api.post("/v1/use-cases", {
                  name,
                  description: desc,
                  businessContext: context,
                  dataSensitivity: sensitivity,
                  complianceTags: tags,
                  intendedAgentIds: agentId ? [agentId] : [],
                  ...(projectId ? { projectId } : {}),
                });
                setName("");
                setDesc("");
                setContext("");
                setTags([]);
                setAgentId("");
                setProjectId("");
                setStep(0);
                await refreshAll();
              });
            }}
          >
            {step === 0 && (
              <>
                <Field label="Name" grow>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="summarize support tickets"
                    required
                    autoFocus
                  />
                </Field>
                <Field label="What it does">
                  <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} required />
                </Field>
                <Field label="Why the business wants it">
                  <Textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} required />
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Data sensitivity">
                  <Select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                    <option value="public">public</option>
                    <option value="internal">internal</option>
                    <option value="confidential">confidential</option>
                    <option value="regulated">regulated</option>
                  </Select>
                </Field>
                <div className={a.labelRow}>
                  <span className={a.inlineLabel}>Compliance tags</span>
                  <InfoButton label="compliance tags">
                    <p>
                      These are the <em>same</em> tags the pillar-3 cascade keys on. A tag that matches a compliance
                      profile pulls in its consequences — required workflow stages, PII handling mode, audit retention,
                      connector data-scope defaults.
                    </p>
                    <p>
                      A tag with no profile behind it is allowed and marked <strong>unbound</strong>: it enforces
                      nothing until a profile carries it.
                    </p>
                  </InfoButton>
                </div>
                <TagPicker
                  value={tags}
                  onChange={setTags}
                  known={(profiles.data?.profiles ?? []).map((p) => p.tag)}
                />
              </>
            )}

            {step === 2 && (
              <>
                <div className={a.labelRow}>
                  <span className={a.inlineLabel}>Intended agent (optional)</span>
                  <InfoButton label="intended agents">
                    <p>
                      Naming the agents you <em>mean</em> to use is what the alignment flags stand on: the registry
                      later compares intent against what was actually granted and reports overshoot or undershoot.
                    </p>
                    <p>Leaving it empty is honest — it just means there is nothing to compare against.</p>
                  </InfoButton>
                </div>
                <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {optionEls(agentOpts(agents.data?.agents), "none yet")}
                </Select>
                <div className={a.labelRow}>
                  <span className={a.inlineLabel}>Project (optional)</span>
                  <InfoButton label="the project attribution">
                    <p>
                      Evidence is collected <em>per project</em>. A use case attributed to no project returns nulls
                      rather than zeros on its framework mapping — "not measured" and "measured as none" are
                      different claims, and the product declines to blur them.
                    </p>
                  </InfoButton>
                </div>
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {optionEls((projects.data?.projects ?? []).map((p) => ({ v: p.id, l: p.name })), "none yet")}
                </Select>
              </>
            )}

            {step === 3 && (
              <dl className={a.review}>
                <div><dt>Name</dt><dd>{name || <em>—</em>}</dd></div>
                <div><dt>What it does</dt><dd>{desc || <em>—</em>}</dd></div>
                <div><dt>Why</dt><dd>{context || <em>—</em>}</dd></div>
                <div><dt>Sensitivity</dt><dd>{sensitivity}</dd></div>
                <div>
                  <dt>Compliance tags</dt>
                  <dd>{tags.length ? tags.join(", ") : <em>none — this use case inherits no cascade</em>}</dd>
                </div>
                <div>
                  <dt>Intended agent</dt>
                  <dd>{agentId ? (agents.data?.agents ?? []).find((x) => x.id === agentId)?.name ?? agentId : <em>none</em>}</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd>{projectId ? (projects.data?.projects ?? []).find((x) => x.id === projectId)?.name ?? projectId : <em>none — evidence will not be measured</em>}</dd>
                </div>
              </dl>
            )}

            <div className={a.stepNav}>
              {step > 0 && (
                <Button type="button" variant="ghost" onClick={() => setStep((n) => n - 1)}>
                  Back
                </Button>
              )}
              {/* The last step COMMITS — it creates a governance object and starts a
                  workflow. Wearing the same default variant as "Back" it read as
                  disabled against the dark surface, which is the wrong signal on the
                  one irreversible action in the flow. */}
              <Button
                type="submit"
                variant={step === INTAKE_STEPS.length - 1 ? "primary" : "default"}
                disabled={act.busy || (step === 0 && !name.trim())}
              >
                {step < INTAKE_STEPS.length - 1 ? "Continue" : "Propose use case"}
              </Button>
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
                onRowClick={(r) => {
                  setIntentDraft(null);
                  setOpenId(openId === r.id ? null : r.id);
                }}
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

                  {/* ADR-0089 B3 — intent capture: which registered agents
                      this use case intends. Editable ONLY pre-decision —
                      after the sign-off, the intent is part of what was
                      decided and changing it is a NEW use case. Feeds the
                      SAME intendedAgentIds column the alignment flags read. */}
                  <Card title="Intended agents (the intent the alignment flags stand on)">
                    <div className={v.stack}>
                      {d.useCase.status === "proposed" || d.useCase.status === "under_review" ? (
                        <div className={a.formRow}>
                          <Field label="Intended agents (ctrl/cmd-click to select several)" grow>
                            <Select
                              multiple
                              size={Math.min(6, Math.max(3, (agents.data?.agents ?? []).length))}
                              value={intentDraft ?? d.useCase.intendedAgentIds}
                              onChange={(e) =>
                                setIntentDraft(Array.from(e.target.selectedOptions).map((o) => o.value))
                              }
                            >
                              {(agents.data?.agents ?? []).map((ag) => (
                                <option key={ag.id} value={ag.id}>
                                  {ag.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          {/* deliberately OUTSIDE a Field: a <label>-wrapped
                              button inherits the label text as its accessible
                              name, which would erase this button's */}
                          <div style={{ alignSelf: "flex-end" }}>
                            <Button
                              disabled={act.busy || intentDraft === null}
                              onClick={() =>
                                void act.run(async () => {
                                  await api.patch(`/v1/use-cases/${d.useCase.id}`, {
                                    intendedAgentIds: intentDraft ?? [],
                                  });
                                  setIntentDraft(null);
                                  await refreshAll();
                                }, "Intended agents captured — the alignment comparison reads exactly this list")
                              }
                            >
                              Save intended agents
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className={v.faint}>
                          {d.useCase.intendedAgentIds.length === 0
                            ? "No intent was recorded before the decision — the register says so rather than guessing."
                            : "Intent is part of what was decided and is no longer editable — changing it means proposing a NEW use case."}
                        </div>
                      )}
                      <div>
                        <Badge
                          tone={
                            d.intendedVsGranted.status === "aligned"
                              ? "ok"
                              : d.intendedVsGranted.status === "undershoot"
                                ? "warn"
                                : "neutral"
                          }
                        >
                          {d.intendedVsGranted.status.replace(/_/g, " ")}
                        </Badge>{" "}
                        <span className={v.faint}>{d.intendedVsGranted.note}</span>
                      </div>
                      {(d.intendedVsGranted.agents ?? []).map(
                        (agRow: NonNullable<UseCaseDetail["intendedVsGranted"]["agents"]>[number]) => (
                          <div key={agRow.agentId}>
                            <Badge tone={agRow.grantedToParticipants ? "ok" : "warn"}>
                              {agRow.agentName ?? agRow.agentId}
                            </Badge>{" "}
                            <span className={v.faint}>
                              {agRow.registered
                                ? agRow.grantedToParticipants
                                  ? `granted to ${agRow.participantHolders} participant(s)`
                                  : "no participant holds a grant — a provisioning gap, not evidence of use"
                                : "no longer in the registry (intent survives agent deletion by design)"}
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </Card>

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
                        <Card title="EU AI Act risk screening (ADR-0085)">
                          <div className={v.stack}>
                            <div className={v.faint}>
                              The platform computes the risk tier (prohibited / high / limited / minimal)
                              server-side from these structured answers when you submit — a submitted tier is
                              refused; only the answers count. Screening, not legal advice.
                            </div>
                            <div className={a.formRow}>
                              <Field label="Purpose domain" grow>
                                <Select value={euDomain} onChange={(e) => setEuDomain(e.target.value)}>
                                  {EU_DOMAINS.map(([val, label]) => (
                                    <option key={val} value={val}>{label}</option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label="Decision autonomy" grow>
                                <Select value={euAutonomy} onChange={(e) => setEuAutonomy(e.target.value)}>
                                  {EU_AUTONOMY.map(([val, label]) => (
                                    <option key={val} value={val}>{label}</option>
                                  ))}
                                </Select>
                              </Field>
                              <Field label="Biometric use" grow>
                                <Select value={euBiometric} onChange={(e) => setEuBiometric(e.target.value)}>
                                  {EU_BIOMETRIC.map(([val, label]) => (
                                    <option key={val} value={val}>{label}</option>
                                  ))}
                                </Select>
                              </Field>
                            </div>
                            <div>
                              <span className={v.faint}>Affected persons: </span>
                              {EU_AFFECTED.map(([val, label]) => (
                                <label key={val} style={{ marginRight: "1rem" }}>
                                  <input
                                    type="checkbox"
                                    checked={euAffected.includes(val)}
                                    onChange={(e) =>
                                      setEuAffected(
                                        e.target.checked
                                          ? [...euAffected, val]
                                          : euAffected.filter((x) => x !== val),
                                      )
                                    }
                                  />{" "}
                                  {label}
                                </label>
                              ))}
                            </div>
                            <div>
                              {EU_FLAGS.map(([key, label]) => (
                                <label key={key} style={{ marginRight: "1rem", display: "inline-block" }}>
                                  <input
                                    type="checkbox"
                                    checked={euFlags[key] ?? false}
                                    onChange={(e) => setEuFlags({ ...euFlags, [key]: e.target.checked })}
                                  />{" "}
                                  {label}
                                </label>
                              ))}
                            </div>
                          </div>
                        </Card>
                        <div>
                          <Button
                            disabled={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await api.post(`/v1/workflows/instances/${d.instance!.id}/artifacts`, {
                                  stageId: "questionnaire",
                                  content: questionnaireWithAnswersBlock(
                                    answers || d.questionnaireTemplate || "",
                                  ),
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

                  {/* EU AI Act screening (ADR-0085) — computed server-side, informs the sign-off */}
                  {d.euAiActScreening.refusal && (
                    <div
                      role="alert"
                      style={{
                        border: "2px solid var(--danger, #c0392b)",
                        borderRadius: 8,
                        padding: "0.75rem 1rem",
                        fontWeight: 600,
                      }}
                    >
                      <Badge tone="danger">prohibited</Badge> {d.euAiActScreening.refusal}
                    </div>
                  )}
                  <Card title="EU AI Act risk screening">
                    <div className={v.stack}>
                      {d.euAiActScreening.tier ? (
                        <div>
                          <Badge tone={tierTone(d.euAiActScreening.tier)}>
                            {d.euAiActScreening.tier}
                          </Badge>{" "}
                          <span className={v.faint}>
                            computed server-side from the questionnaire&apos;s answers by rule set v
                            {d.euAiActScreening.rulesetVersion} — {d.euAiActScreening.enforcement}
                          </span>
                        </div>
                      ) : (
                        <div className={v.faint}>
                          Not screened
                          {d.euAiActScreening.answersStatus === "invalid"
                            ? ` — the submitted answers block is invalid: ${d.euAiActScreening.answersError}`
                            : " — the questionnaire has no structured answers block yet. The tier is computed server-side when one is submitted; it is never guessed from prose."}
                        </div>
                      )}
                      {(d.euAiActScreening.reasons ?? []).map((r) => (
                        <div key={r.ruleId}>
                          <Badge tone={tierTone(r.tier as EuTier)}>{r.ref}</Badge>{" "}
                          <span className={v.faint}>{r.reason}</span>
                        </div>
                      ))}
                      {d.euAiActScreening.tier === "minimal" && (
                        <div className={v.faint}>
                          No rule in the compiled rule set matched — which is exactly as much as a
                          screening can honestly say.
                        </div>
                      )}
                      {d.euAiActScreening.cascade && (
                        <div className={v.stack}>
                          <div className={v.faint}>{d.euAiActScreening.cascade.note}</div>
                          {d.euAiActScreening.cascade.recommendedTags.map((t) => (
                            <div key={t.tag}>
                              <Badge tone={t.profileExists ? "info" : "warn"}>{t.tag}</Badge>{" "}
                              <span className={v.faint}>
                                from {t.fromPack} —{" "}
                                {t.profileExists
                                  ? t.carriedByUseCase
                                    ? "profile exists and this use case carries the tag"
                                    : "a §8.3 profile exists; add the tag to this use case (and the governed project) to bind its consequences"
                                  : "no §8.3 compliance profile exists for this tag yet — creating one is what makes the recommendation enforceable"}
                              </span>
                            </div>
                          ))}
                          {d.euAiActScreening.cascade.packs.map((p) => (
                            <div key={p.id} className={v.faint}>
                              Pack citation (read-only): {p.title} (v{p.version}) —{" "}
                              {p.controls.map((c) => c.controlRef).join(", ")}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className={v.faint}>{d.euAiActScreening.disclaimer}</div>
                    </div>
                  </Card>

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
