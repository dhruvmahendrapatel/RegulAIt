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
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt, frameworkLabel, humanize, plural, shortId } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, InfoButton, Input, Select, Table, TagPicker, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useAgents, useComplianceProfiles, useProjects, agentOpts } from "../adminKit";
import { EU_AFFECTED, EU_AUTONOMY, EU_BIOMETRIC, EU_DOMAINS, EU_FLAGS, QuestionnaireView } from "./UseCaseQuestionnaire";
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

// ---- display words for stored values (the values themselves are unchanged) ----
const PII_MODE_LABEL: Record<string, string> = { block: "Block", warn: "Warn", log: "Log only" };
const MCP_MODE_LABEL: Record<string, string> = { read_only: "Read only", read_write: "Read and write" };
const piiLabel = (m: string) => PII_MODE_LABEL[m] ?? humanize(m);
const mcpLabel = (m: string) => MCP_MODE_LABEL[m] ?? humanize(m);

/** where the intake workflow is, in the words of the person waiting on it */
const INSTANCE_STATUS_LABEL: Record<string, string> = {
  running: "Running",
  blocked_on_plan: "Waiting for planning to finish",
  blocked_on_artifact: "Waiting for the questionnaire",
  blocked_on_approval: "Waiting for sign-off",
  completed: "Completed",
  denied: "Rejected at sign-off",
  aborted: "Stopped",
};
const instanceStatusLabel = (s: string) => INSTANCE_STATUS_LABEL[s] ?? humanize(s);

const ALIGNMENT_LABEL: Record<string, string> = {
  aligned: "Aligned",
  undershoot: "Grant gap",
  not_approved: "Not approved",
  no_intent_recorded: "No intent recorded",
};

/** the alignment explanation, keyed on its status (the server's note is written
 * for operators; the claim it makes is the same) */
function alignmentNote(status: string, useCaseStatus: UseCaseStatus): string {
  if (status === "not_approved")
    return useCaseStatus === "rejected"
      ? "Alignment is checked against approved intent only. This use case was rejected, so its intended agents were never approved intent."
      : useCaseStatus === "retired"
        ? "Alignment is checked against approved intent only. This use case was retired, so its intended agents are no longer approved intent."
        : "Alignment is checked against approved intent only. This use case is not approved yet, so there is nothing to check.";
  if (status === "no_intent_recorded")
    return "This approved use case names no intended agents, so there is nothing to compare grants against.";
  if (status === "undershoot")
    return "At least one intended agent is not granted to anyone on this use case (its owner or the linked project's members) — a provisioning gap, not evidence of use.";
  return "Every intended agent is granted to someone on this use case (its owner or the linked project's members). This compares grants with intent only, never observed traffic.";
}

/** "EU AI Act, NIST AI RMF" — compliance tags by their framework names */
const tagList = (tags: string[]) => tags.map(frameworkLabel).join(", ");

/**
 * whether the linked project carries this use case's tags, in one clause. Only a tag a compliance
 * profile defines has requirements to lose — a missing unprofiled tag is noted, never a warning.
 */
function projectClassificationNote(carried: string[], notCarried: string[], unprofiled: string[]): { text: string; tone: "ok" | "warn" | "neutral" } {
  const enforceable = notCarried.filter((t) => !unprofiled.includes(t));
  const quiet = notCarried.filter((t) => unprofiled.includes(t));
  if (notCarried.length === 0) return { text: `Classified with ${tagList(carried)}, matching this use case.`, tone: "ok" };
  if (enforceable.length === 0) {
    const head = carried.length ? `Classified with ${tagList(carried)}; not` : "Not";
    return { text: `${head} classified with ${tagList(quiet)} — nothing is lost until a compliance profile defines ${quiet.length === 1 ? "it" : "them"}.`, tone: "neutral" };
  }
  const missing = `${tagList(enforceable)}, so ${enforceable.length === 1 ? "that tag's" : "those tags'"} requirements are not enforced there.`;
  return { text: carried.length ? `Classified with ${tagList(carried)}, but not yet with ${missing}` : `Not yet classified with ${missing}`, tone: "warn" };
}

/** a server sentence that starts lowercase, as a sentence */
const capFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** a pack title carries its version note after " — v2 …"; lists show the name only */
const packName = (title: string) => title.split(/ — v\d/)[0]!;

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
  // the detail renders below the table: bring it into view when a row opens it
  const detailRef = useRef<HTMLDivElement | null>(null);
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
  const openedId = d?.useCase.id ?? null;
  useEffect(() => {
    if (openId && openedId === openId) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openId, openedId]);

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
                // The form empties itself and jumps back to step 1 on success,
                // which from the outside is indistinguishable from the form
                // having thrown everything away. Say what happened, and say
                // where the use case now IS — resting at the plan stage,
                // waiting for a human, not silently approved.
              }, "Use case proposed — its intake workflow is resting at the plan stage");
            }}
          >
            {step === 0 && (
              <>
                <Field
                  label="Name"
                  grow
                  helpLabel="the governed use-case identity created here"
                  help={<p>This becomes the use case's primary name in the AI inventory, intake workflow, approvals and audit trail. Use a business-facing name that distinguishes this system from a model or vendor name.</p>}
                >
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="summarize support tickets"
                    required
                    autoFocus
                  />
                </Field>
                <Field
                  label="What it does"
                  helpLabel="the governed system description recorded here"
                  help={<p>State the AI-enabled task, its inputs and outputs, and what action or recommendation follows. This description becomes part of the governed use-case record reviewers inspect.</p>}
                >
                  <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} required />
                </Field>
                <Field
                  label="Why the business wants it"
                  helpLabel="the business rationale recorded here"
                  help={<p>Record the intended business outcome and accountable rationale. This is stored as business context so reviewers can judge whether the benefits justify the declared risks and controls.</p>}
                >
                  <Textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)} required />
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Data sensitivity">
                  <Select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                    <option value="public">Public</option>
                    <option value="internal">Internal</option>
                    <option value="confidential">Confidential</option>
                    <option value="regulated">Regulated</option>
                  </Select>
                </Field>
                {/*
                  A real <label htmlFor>, NOT a bare <span>. The InfoButton has
                  to sit OUTSIDE the label — inside it, the label's click target
                  covers the button and every click on the explanation toggles
                  the control it explains. So the association is explicit by id
                  rather than implicit by wrapping, which is what <Field> does
                  everywhere there is no button to place.

                  The first cut used a span and lost the association entirely:
                  the control announced as an unlabelled combo box, the visible
                  text did not focus it, and getByLabel could not find it. Same
                  root cause as the info trigger inside the <h1> — putting the
                  button beside a labelling element broke the labelling element.
                */}
                <div className={a.labelRow}>
                  <label className={a.inlineLabel} htmlFor="uc-compliance-tags">
                    Compliance tags
                  </label>
                  <InfoButton label="the compliance-tags field">
                    <p>
                      These are the <em>same</em> tags the compliance cascade keys on. A tag that matches a compliance
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
                  id="uc-compliance-tags"
                  value={tags}
                  onChange={setTags}
                  known={(profiles.data?.profiles ?? []).map((p) => p.tag)}
                />
              </>
            )}

            {step === 2 && (
              <>
                <div className={a.labelRow}>
                  <label className={a.inlineLabel} htmlFor="uc-intended-agent">
                    Intended agent (optional)
                  </label>
                  <InfoButton label="the intended-agent field">
                    <p>
                      Naming the agents you <em>mean</em> to use is what the alignment flags stand on: the registry
                      later compares intent against what was actually granted and reports overshoot or undershoot.
                    </p>
                    <p>Leaving it empty is honest — it just means there is nothing to compare against.</p>
                  </InfoButton>
                </div>
                <Select id="uc-intended-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {optionEls(agentOpts(agents.data?.agents), "none yet")}
                </Select>
                <div className={a.labelRow}>
                  <label className={a.inlineLabel} htmlFor="uc-project">
                    Project (optional)
                  </label>
                  <InfoButton label="the project field">
                    <p>
                      Evidence is collected <em>per project</em>. A use case attributed to no project returns nulls
                      rather than zeros on its framework mapping — "not measured" and "measured as none" are
                      different claims, and the product declines to blur them.
                    </p>
                  </InfoButton>
                </div>
                <Select id="uc-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {optionEls((projects.data?.projects ?? []).map((p) => ({ v: p.id, l: p.name })), "none yet")}
                </Select>
              </>
            )}

            {step === 3 && (
              <dl className={a.review}>
                <div><dt>Name</dt><dd>{name || <em>—</em>}</dd></div>
                <div><dt>What it does</dt><dd>{desc || <em>—</em>}</dd></div>
                <div><dt>Why</dt><dd>{context || <em>—</em>}</dd></div>
                <div><dt>Sensitivity</dt><dd>{humanize(sensitivity)}</dd></div>
                <div>
                  <dt>Compliance tags</dt>
                  <dd>{tags.length ? tagList(tags) : <em>none — this use case inherits no cascade</em>}</dd>
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
                    render: (r) => <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>,
                  },
                  { key: "sens", header: "Sensitivity", render: (r) => humanize(r.dataSensitivity) },
                  {
                    key: "tags",
                    header: "Compliance tags",
                    render: (r) => (r.complianceTags.length ? tagList(r.complianceTags) : <span className={v.faint}>None</span>),
                  },
                  { key: "owner", header: "Owner", render: (r) => r.ownerName ?? shortId(r.ownerUserId) },
                  { key: "created", header: "Proposed", render: (r) => ago(r.createdAt) },
                ]}
              />
            )}
          </Card>
        </QueryGate>

        {/* ---------------- detail ---------------- */}
        {/* scroll-margin keeps the panel's title row clear of the sticky top bar (UIB-03) */}
        <div ref={detailRef} style={{ scrollMarginTop: "calc(52px + var(--s2))" }} />
        {openId && (
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {d && (
              <Card
                title={`Use case: ${d.useCase.name}`}
                actions={
                  <>
                    {/* the governed 360 workspace — frameworks, risks, stack,
                        approvals and audit live there, not in this drawer */}
                    <Link to={`/admin/governance/use-cases/${d.useCase.id}`}>Open the use-case workspace</Link>
                    <Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>
                  </>
                }
              >
                <div className={v.stack}>
                  <div className={v.row}>
                    <Badge tone={statusTone(d.useCase.status)}>{humanize(d.useCase.status)}</Badge>
                    <span className={v.faint}>
                      {d.useCase.status === "retired"
                        ? d.useCase.retiredReason || "No retirement reason was recorded."
                        : d.useCase.decidedAt
                          ? `Decided ${ago(d.useCase.decidedAt)} at the intake sign-off`
                          : "Status follows the intake workflow — it is decided at sign-off, never edited here."}
                    </span>
                  </div>
                  <dl className={a.review}>
                    <div><dt>What it does</dt><dd>{d.useCase.description || <em>—</em>}</dd></div>
                    <div><dt>Business context</dt><dd>{d.useCase.businessContext || <em>—</em>}</dd></div>
                    <div><dt>Data sensitivity</dt><dd>{humanize(d.useCase.dataSensitivity)}</dd></div>
                    <div>
                      <dt>Compliance tags</dt>
                      <dd>{d.useCase.complianceTags.length ? tagList(d.useCase.complianceTags) : <em>None</em>}</dd>
                    </div>
                    <div>
                      <dt>Owner</dt>
                      {/* GET /v1/use-cases/:id carries no ownerName; the list row
                          for the same id does, so the drawer agrees with the table */}
                      <dd>
                        {d.useCase.ownerName ??
                          list.data?.useCases.find((u) => u.id === d.useCase.id)?.ownerName ??
                          shortId(d.useCase.ownerUserId)}
                      </dd>
                    </div>
                    <div><dt>Proposed</dt><dd>{fmtAt(d.useCase.createdAt)}</dd></div>
                  </dl>

                  {/* ADR-0089 B3 — intent capture: which registered agents
                      this use case intends. Editable ONLY pre-decision —
                      after the sign-off, the intent is part of what was
                      decided and changing it is a NEW use case. Feeds the
                      SAME intendedAgentIds column the alignment flags read. */}
                  <Card title="Intended agents">
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
                            ? "No intended agents were recorded before the decision."
                            : "The intended agents are part of what was decided and can no longer be edited — changing them means proposing a new use case."}
                        </div>
                      )}
                      <div className={v.row}>
                        <Badge
                          tone={
                            d.intendedVsGranted.status === "aligned"
                              ? "ok"
                              : d.intendedVsGranted.status === "undershoot"
                                ? "warn"
                                : "neutral"
                          }
                        >
                          {ALIGNMENT_LABEL[d.intendedVsGranted.status] ?? humanize(d.intendedVsGranted.status)}
                        </Badge>
                        <span className={v.faint}>{alignmentNote(d.intendedVsGranted.status, d.useCase.status)}</span>
                      </div>
                      {(d.intendedVsGranted.agents ?? []).map(
                        (agRow: NonNullable<UseCaseDetail["intendedVsGranted"]["agents"]>[number]) => (
                          <div key={agRow.agentId} className={v.row}>
                            <Badge tone={agRow.grantedToParticipants ? "ok" : "warn"}>
                              {agRow.agentName ?? shortId(agRow.agentId)}
                            </Badge>
                            <span className={v.faint}>
                              {agRow.registered
                                ? agRow.grantedToParticipants
                                  ? `Granted to ${plural(agRow.participantHolders, "participant")}`
                                  : "Not granted to anyone on this use case — a provisioning gap, not evidence of use"
                                : "No longer in the agent registry (the recorded intent is kept on purpose)"}
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </Card>

                  {/* the linked workflow's state */}
                  {d.instance && (
                    <Card title="Intake workflow">
                      <div className={v.stack}>
                        <div className={v.row}>
                          {d.instance.stages.map((s) => (
                            <Badge
                              key={s.id}
                              tone={s.id === d.instance!.currentStageId ? "info" : "neutral"}
                              title={humanize(s.type)}
                            >
                              {humanize(s.id)}
                            </Badge>
                          ))}
                          {d.instance.status !== "blocked_on_approval" && (
                            <span className={v.faint}>{instanceStatusLabel(d.instance.status)}</span>
                          )}
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
                              The workflow rests at the plan stage while the proposal is refined. Finish planning to
                              open the questionnaire.
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
                    <Card
                      title={`Intake questionnaire · version ${d.questionnaire.version}`}
                      actions={<span className={v.faint}>Submitted {fmtAt(d.questionnaire.createdAt)}</span>}
                    >
                      <QuestionnaireView content={d.questionnaire.content} />
                    </Card>
                  ) : d.instance && d.instance.status === "blocked_on_artifact" ? (
                    <Card title="Intake questionnaire — fill and submit">
                      <div className={v.stack}>
                        <div className={v.faint}>
                          Answer each section in your own words — nothing here is pre-filled by a model. Submitting
                          saves it as a versioned record and sends the use case to review.
                        </div>
                        <Field
                          label="Questionnaire answers"
                          helpLabel="the versioned intake evidence submitted here"
                          help={<p>These answers are saved as a versioned intake artifact and sent to the approval queue. Describe the real purpose, ownership, data, safeguards and operating boundaries; this record becomes evidence for later reviews.</p>}
                        >
                          <Textarea
                            rows={14}
                            value={answers || d.questionnaireTemplate || ""}
                            onChange={(e) => setAnswers(e.target.value)}
                          />
                        </Field>
                        <Card title="EU AI Act screening questions">
                          <div className={v.stack}>
                            <div className={v.faint}>
                              When you submit, the platform works out the risk tier (prohibited, high, limited or
                              minimal) from these answers. A tier cannot be submitted directly — only the answers
                              count. This is a screening aid, not legal advice.
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
                      <Badge tone="danger">Prohibited</Badge> {d.euAiActScreening.refusal}
                    </div>
                  )}
                  <Card title="EU AI Act risk screening">
                    <div className={v.stack}>
                      {d.euAiActScreening.tier ? (
                        <div className={v.row}>
                          <Badge tone={tierTone(d.euAiActScreening.tier)}>
                            {d.euAiActScreening.tier === "prohibited"
                              ? "Prohibited"
                              : `${humanize(d.euAiActScreening.tier)} risk`}
                          </Badge>
                          <span className={v.faint}>
                            Worked out from the questionnaire&apos;s answers by rule set v
                            {d.euAiActScreening.rulesetVersion}. The tier informs the human sign-off and blocks
                            nothing by itself; approval only gates agent use where the organization has turned on the
                            use-case gate (Settings → Organization), which is off by default.
                          </span>
                        </div>
                      ) : (
                        <div className={v.faint}>
                          Not screened
                          {d.euAiActScreening.answersStatus === "invalid"
                            ? ` — the submitted screening answers could not be read: ${d.euAiActScreening.answersError}`
                            : " yet — the tier is worked out when the questionnaire is submitted with its screening answers. It is never guessed from prose."}
                        </div>
                      )}
                      {(d.euAiActScreening.reasons ?? []).map((r) => (
                        <div key={r.ruleId} className={v.row}>
                          <Badge tone={tierTone(r.tier as EuTier)}>{r.ref}</Badge>
                          <span className={v.faint}>{capFirst(r.reason)}</span>
                        </div>
                      ))}
                      {d.euAiActScreening.tier === "minimal" && (
                        <div className={v.faint}>
                          No rule in the rule set matched — which is exactly as much as a screening can honestly
                          say.
                        </div>
                      )}
                      {d.euAiActScreening.cascade && (
                        <div className={v.stack}>
                          <div className={v.faint}>
                            {d.euAiActScreening.tier === "prohibited"
                              ? "A prohibited result is a reason to refuse at sign-off, not to add tags. The cited controls show the high-risk obligations that would apply even to a narrowed version of this proposal."
                              : "A high-risk result recommends carrying the tags below. Where a compliance profile exists for a tag, adding it to this use case and its project turns the recommendation into enforced requirements; where none exists, creating the profile is the missing step."}
                          </div>
                          {d.euAiActScreening.cascade.recommendedTags.map((t) => (
                            <div key={t.tag} className={v.row}>
                              <Badge tone={t.profileExists ? "info" : "warn"}>{frameworkLabel(t.tag)}</Badge>
                              <span className={v.faint}>
                                {d.euAiActScreening.tier === "prohibited"
                                  ? t.carriedByUseCase
                                    ? "This use case carries the tag."
                                    : t.profileExists
                                      ? "A compliance profile exists for this tag."
                                      : "No compliance profile defines this tag yet."
                                  : t.profileExists
                                    ? t.carriedByUseCase
                                      ? "A compliance profile exists and this use case carries the tag."
                                      : "A compliance profile exists. Add the tag to this use case and its project to apply its requirements."
                                    : "No compliance profile defines this tag yet. Creating one is what makes the recommendation enforceable."}{" "}
                                Source: {packName(t.fromPack)}.
                              </span>
                            </div>
                          ))}
                          {d.euAiActScreening.cascade.packs.map((p) => (
                            <details key={p.id} className={v.faint}>
                              <summary style={{ cursor: "pointer" }}>
                                Cited: {packName(p.title)} (version {p.version}) · {plural(p.controls.length, "control")}
                              </summary>
                              {p.controls.length > 0 && <ul>{p.controls.map((c) => <li key={c.controlRef}>{c.title}</li>)}</ul>}
                            </details>
                          ))}
                        </div>
                      )}
                      {d.euAiActScreening.tier ? <div className={v.faint}>{d.euAiActScreening.disclaimer}</div> : null}
                    </div>
                  </Card>

                  {/* cascade consequences — derived from the real cascade rules */}
                  <Card title="What the compliance tags require">
                    <div className={v.stack}>
                      <div className={v.faint}>
                        {d.useCase.complianceTags.length === 0
                          ? "This use case carries no compliance tags, so no compliance profile adds requirements."
                          : d.cascadeConsequences.profiles.length === 0
                            ? "No compliance profile covers these tags yet, so they add no requirements."
                            : "Worked out live from the compliance profiles — the same rules enforced on a classified project. They apply where the linked project carries these tags."}
                      </div>
                      {d.cascadeConsequences.combined && d.cascadeConsequences.profiles.length > 0 && (
                        <div className={a.formRow}>
                          <Field label="PII handling (strictest)">
                            <Input readOnly value={piiLabel(d.cascadeConsequences.combined.piiMode)} />
                          </Field>
                          <Field label="MCP tool access">
                            <Input readOnly value={mcpLabel(d.cascadeConsequences.combined.mcpDefaultMode)} />
                          </Field>
                          <Field label="Audit retention">
                            <Input
                              readOnly
                              value={
                                d.cascadeConsequences.combined.auditRetentionDays == null
                                  ? "Organization default"
                                  : plural(d.cascadeConsequences.combined.auditRetentionDays, "day")
                              }
                            />
                          </Field>
                          <Field label="Required workflow stages">
                            <Input
                              readOnly
                              value={d.cascadeConsequences.combined.forcedStageIds.map(humanize).join(", ") || "None"}
                            />
                          </Field>
                        </div>
                      )}
                      {d.cascadeConsequences.profiles.map((p) => (
                        <div key={p.tag} className={v.row}>
                          <Badge tone="info">{frameworkLabel(p.tag)}</Badge>
                          <span className={v.faint}>
                            PII handling: {piiLabel(p.piiMode)} · MCP tool access: {mcpLabel(p.mcpDefaultMode)}
                            {p.requiredTemplates.length > 0 &&
                              ` · Requires the ${p.requiredTemplates.map((t) => t.name).join(", ")} ${p.requiredTemplates.length === 1 ? "workflow" : "workflows"}`}
                          </span>
                        </div>
                      ))}
                      {d.cascadeConsequences.unrecognizedTags.length > 0 && (
                        <div className={v.row}>
                          <Badge tone="warn">No profile</Badge>
                          <span className={v.faint}>
                            No compliance profile defines {tagList(d.cascadeConsequences.unrecognizedTags)} yet, so{" "}
                            {d.cascadeConsequences.unrecognizedTags.length === 1 ? "this tag doesn't" : "these tags don't"}{" "}
                            add workflow requirements.
                          </span>
                        </div>
                      )}
                      {d.cascadeConsequences.project && d.useCase.complianceTags.length > 0 && (() => {
                        const note = projectClassificationNote(
                          d.cascadeConsequences.project.tagsCarried,
                          d.cascadeConsequences.project.tagsNotCarried,
                          d.cascadeConsequences.unrecognizedTags,
                        );
                        return (
                          <div className={v.row}>
                            <Badge tone={note.tone}>Project: {d.cascadeConsequences.project.name}</Badge>
                            <span className={v.faint}>{note.text}</span>
                          </div>
                        );
                      })()}
                    </div>
                  </Card>

                  {/* retire (admin) */}
                  {d.useCase.status !== "retired" && (
                    <div className={a.formRow}>
                      <Field
                        label="Retire this use case — a reason is required and recorded in the audit log"
                        grow
                        helpLabel="the permanent retirement audit reason"
                        help={<p>This reason becomes permanent audit evidence explaining why the governed use case left active inventory. Include the replacement, closure or policy decision an auditor should be able to trace.</p>}
                      >
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
