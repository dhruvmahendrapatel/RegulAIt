import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "../../../ui/kit";
import { useAction, useAgents } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type Source = "rules" | "mock" | "model";
type Decision = "accepted" | "rejected";

interface IntakeSuggestion {
  source: Source;
}
interface FrameworkSuggestion extends IntakeSuggestion { framework: string; title: string; why: string }
interface RiskSuggestion extends IntakeSuggestion {
  scenarioKey: string;
  title: string;
  description: string;
  category: string;
  dimension: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  suggestedControls: string[];
  why: string;
}
interface QuestionnaireSuggestion extends IntakeSuggestion { id: string; heading: string; text: string }
interface IntakeAssistResponse {
  tier: { value: string; reasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }>; rulesetVersion: number; source: "rules"; disclaimer: string };
  frameworks: FrameworkSuggestion[];
  risks: RiskSuggestion[];
  euAiActBlock: string;
  questionnaire: QuestionnaireSuggestion[];
  blocking: { reason?: string } | string | null;
  narrative: { status: string; source?: "model" | "mock"; [key: string]: unknown };
  disclaimer: string;
}

interface VendorSummary { id: string; name: string; category: string; status: string }
interface CreatedUseCase { id: string; instance: { id: string } | null }
interface CreatedRisk { id: string }

interface SubmissionCheckpoint {
  useCaseId?: string;
  instanceId?: string;
  planningAdvanced?: boolean;
  questionnaireSubmitted?: boolean;
  riskIds: Record<string, string>;
  linkedControls: Record<string, string[]>;
}

const STEPS = ["Describe", "Suggestions", "Questionnaire", "Link stack", "Review"];

export default function IntakeWizardPage() {
  const [prefill] = useSearchParams();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(prefill.get("title") ?? "Credit-limit-increase assistant");
  const [description, setDescription] = useState(
    prefill.get("description") ?? "Helps Acme Bank customers request a credit-limit increase using profile and financial data, with a human reviewing every recommendation.",
  );
  const [purposeDomain, setPurposeDomain] = useState("essential-services");
  const [profilesNaturalPersons, setProfilesNaturalPersons] = useState(true);
  const [generative, setGenerative] = useState(true);
  const [autonomousActions, setAutonomousActions] = useState(false);
  const [usesExternalVendor, setUsesExternalVendor] = useState(true);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, string>>({});
  const [questionnaire, setQuestionnaire] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [submittedUseCaseId, setSubmittedUseCaseId] = useState<string | null>(null);
  const checkpoint = useRef<SubmissionCheckpoint>({ riskIds: {}, linkedControls: {} });
  const submitAction = useAction();

  const agents = useAgents();
  const vendors = useQuery({
    queryKey: ["admin", "vendors"],
    queryFn: () => api.get<{ vendors: VendorSummary[] }>("/v1/vendors"),
  });
  const assist = useMutation({
    mutationFn: () =>
      api.post<IntakeAssistResponse>("/v1/use-cases/intake/assist", {
        title: title.trim(),
        description: description.trim(),
        euAiAct: {
          purposeDomain,
          affectedPersons: ["customers"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons,
          safetyComponent: false,
          interactsWithHumans: true,
          generatesSyntheticContent: generative,
        },
        context: {
          sectors: ["financial-services"],
          dataCategories: ["personal", "financial"],
          deployment: "customer-facing",
          euNexus: true,
          usesExternalVendor,
          generative,
          autonomousActions,
          toolsUsed: [],
        },
        draftNarrative: true,
        ...(agentId ? { agentId } : {}),
      }),
    onSuccess: (data) => {
      setDecisions(Object.fromEntries([
        ...data.frameworks.map((item) => [`framework:${item.framework}`, "accepted" as const]),
        ...data.risks.map((item) => [`risk:${item.scenarioKey}`, "accepted" as const]),
        ...data.questionnaire.map((item) => [`question:${item.id}`, "accepted" as const]),
      ]));
      setQuestionnaire(Object.fromEntries(data.questionnaire.map((item) => [item.id, item.text])));
      setStep(1);
    },
  });

  const acceptedFrameworks = assist.data?.frameworks.filter((item) => decisions[`framework:${item.framework}`] !== "rejected") ?? [];
  const acceptedRisks = assist.data?.risks.filter((item) => decisions[`risk:${item.scenarioKey}`] !== "rejected") ?? [];
  const acceptedQuestions = assist.data?.questionnaire.filter((item) => decisions[`question:${item.id}`] !== "rejected") ?? [];
  const sourceSummary = useMemo(() => {
    if (!assist.data) return [];
    return [...new Set([
      ...assist.data.frameworks.map((item) => item.source),
      ...assist.data.risks.map((item) => item.source),
      ...assist.data.questionnaire.map((item) => item.source),
      assist.data.narrative.source,
    ].filter(Boolean))] as Source[];
  }, [assist.data]);

  const canContinue = step === 0 ? Boolean(title.trim() && description.trim()) : Boolean(assist.data);
  const setDecision = (key: string, value: Decision) => setDecisions((current) => ({ ...current, [key]: value }));

  const questionnaireMarkdown = () => {
    if (!assist.data) return "";
    const sections = acceptedQuestions.map((item) => {
      const edited = questionnaire[item.id] ?? item.text;
      return `## ${item.heading}\n\n${edited.trim()}`;
    });
    return [...sections, `## 9. EU AI Act risk screening\n\n${assist.data.euAiActBlock.trim()}`].join("\n\n");
  };

  const submit = async () => {
    if (!assist.data) return;
    const progress = checkpoint.current;

    if (!progress.useCaseId) {
      const created = await api.post<CreatedUseCase>("/v1/use-cases", {
        name: title.trim(),
        description: description.trim(),
        businessContext: description.trim(),
        dataSensitivity: "restricted",
        complianceTags: acceptedFrameworks.map((item) => item.framework),
        intendedAgentIds: agentId ? [agentId] : [],
      });
      progress.useCaseId = created.id;
      progress.instanceId = created.instance?.id;
    }

    if (!progress.instanceId) {
      throw new Error("The use case was created, but the intake workflow instance was not returned. Retry after an operator checks the workflow setup.");
    }
    if (!progress.planningAdvanced) {
      await api.post(`/v1/workflows/instances/${progress.instanceId}/advance`, { stageId: "plan" });
      progress.planningAdvanced = true;
    }
    if (!progress.questionnaireSubmitted) {
      await api.post(`/v1/workflows/instances/${progress.instanceId}/artifacts`, {
        stageId: "questionnaire",
        content: questionnaireMarkdown(),
      });
      progress.questionnaireSubmitted = true;
    }

    for (const risk of acceptedRisks) {
      let riskId = progress.riskIds[risk.scenarioKey];
      if (!riskId) {
        const created = await api.post<CreatedRisk>("/v1/risks", {
          title: risk.title,
          description: suggestionEdits[`risk:${risk.scenarioKey}`] ?? risk.description,
          category: risk.category,
          likelihood: risk.likelihood,
          impact: risk.impact,
          useCaseId: progress.useCaseId,
          ...(agentId ? { agentId } : {}),
          ...(vendorId ? { vendorId } : {}),
        });
        riskId = created.id;
        progress.riskIds[risk.scenarioKey] = riskId;
      }

      const linked = progress.linkedControls[risk.scenarioKey] ?? [];
      for (const controlRef of risk.suggestedControls) {
        if (linked.includes(controlRef)) continue;
        try {
          await api.post(`/v1/risks/${riskId}/controls`, { controlRef });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
        }
        linked.push(controlRef);
      }
      progress.linkedControls[risk.scenarioKey] = linked;
    }

    setSubmittedUseCaseId(progress.useCaseId);
  };

  return (
    <>
      <PageHeader
        title="AI use-case intake"
        sub="Describe the proposed system, review every suggestion, then submit the human-edited record."
        info={<p>The assistant is suggestion-only. It writes nothing until the final submission, and every item keeps its rules, mock, or model source label.</p>}
      />
      <div className={v.stack}>
        <Card>
          <ol className={s.stepper} aria-label="Intake progress">
            {STEPS.map((label, index) => (
              <li key={label} className={`${s.step} ${index === step ? s.stepActive : index < step ? s.stepDone : ""}`} aria-current={index === step ? "step" : undefined}>
                <span className={s.stepNumber}>{index < step ? "✓" : index + 1}</span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
        </Card>

        {step === 0 && (
          <Card title="Describe the proposed AI system">
            <form className={v.stack} onSubmit={(event) => { event.preventDefault(); assist.mutate(); }}>
              <Field label="Use-case name"><Input value={title} onChange={(event) => setTitle(event.target.value)} required /></Field>
              <Field label="What will the system do?"><Textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} required /></Field>
              <div className={v.grid2}>
                <Field label="Primary purpose domain">
                  <Select value={purposeDomain} onChange={(event) => setPurposeDomain(event.target.value)}>
                    <option value="essential-services">Essential services</option>
                    <option value="employment-hr">Employment / HR</option>
                    <option value="education">Education</option>
                    <option value="law-enforcement">Law enforcement</option>
                    <option value="general-business">General business</option>
                  </Select>
                </Field>
                <Field label="Decision autonomy"><Input value="Human reviews every recommendation" readOnly /></Field>
              </div>
              <div className={s.checkboxGrid}>
                <Check checked={profilesNaturalPersons} onChange={setProfilesNaturalPersons} label="Profiles natural persons" />
                <Check checked={generative} onChange={setGenerative} label="Generates content" />
                <Check checked={autonomousActions} onChange={setAutonomousActions} label="Can take autonomous actions" />
                <Check checked={usesExternalVendor} onChange={setUsesExternalVendor} label="Uses an external AI vendor" />
              </div>
              {assist.isError && <p className={v.errLine} role="alert">{(assist.error as Error).message}</p>}
              <div><Button variant="primary" type="submit" disabled={!canContinue || assist.isPending}>{assist.isPending ? "Drafting…" : "Draft suggestions"}</Button></div>
            </form>
          </Card>
        )}

        {step === 1 && assist.data && (
          <Card title="Review assistant suggestions">
            <div className={v.stack}>
              <div className={s.callout}>
                Proposed tier: <strong>{assist.data.tier.value}</strong> · ruleset v{assist.data.tier.rulesetVersion}. {assist.data.tier.disclaimer}
              </div>
              {assist.data.blocking ? <div className={v.errLine} role="alert">Prohibited-use screening blocked this proposal: {typeof assist.data.blocking === "string" ? assist.data.blocking : assist.data.blocking.reason ?? "See the rule reasons."}</div> : null}
              <h2 className={v.sectionTitle}>Frameworks</h2>
              {assist.data.frameworks.map((item) => (
                <Suggestion key={item.framework} title={item.title} body={suggestionEdits[`framework:${item.framework}`] ?? item.why} source={item.source} decision={decisions[`framework:${item.framework}`]} onDecision={(value) => setDecision(`framework:${item.framework}`, value)} onEdit={(value) => setSuggestionEdits((current) => ({ ...current, [`framework:${item.framework}`]: value }))} />
              ))}
              <h2 className={v.sectionTitle}>Risk scenarios</h2>
              {assist.data.risks.map((item) => (
                <Suggestion key={item.scenarioKey} title={item.title} body={suggestionEdits[`risk:${item.scenarioKey}`] ?? `${item.description} ${item.why}`} source={item.source} decision={decisions[`risk:${item.scenarioKey}`]} onDecision={(value) => setDecision(`risk:${item.scenarioKey}`, value)} onEdit={(value) => setSuggestionEdits((current) => ({ ...current, [`risk:${item.scenarioKey}`]: value }))} meta={`${item.dimension} · ${item.likelihood} likelihood · ${item.impact} impact`} />
              ))}
              <p className={v.faint}>{assist.data.disclaimer}</p>
            </div>
          </Card>
        )}

        {step === 2 && assist.data && (
          <Card title="Questionnaire — edit the accepted draft">
            <div className={v.stack}>
              {assist.data.questionnaire.map((item) => {
                const rejected = decisions[`question:${item.id}`] === "rejected";
                return (
                  <section key={item.id} className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
                    <div className={s.suggestionHeader}><strong>{item.heading}</strong><Badge tone="info">{item.source}</Badge></div>
                    {!rejected && <Field label={`${item.heading} answer`}><Textarea rows={4} value={questionnaire[item.id] ?? item.text} onChange={(event) => setQuestionnaire((current) => ({ ...current, [item.id]: event.target.value }))} /></Field>}
                    <div className={s.suggestionActions}>
                      <Button size="sm" variant={rejected ? "default" : "primary"} onClick={() => setDecision(`question:${item.id}`, "accepted")}>Accept</Button>
                      <Button size="sm" variant={rejected ? "danger" : "ghost"} onClick={() => setDecision(`question:${item.id}`, "rejected")}>Reject</Button>
                    </div>
                  </section>
                );
              })}
              <Field label="9. EU AI Act risk screening (rule-generated)"><Textarea rows={10} value={assist.data.euAiActBlock} readOnly /></Field>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card title="Link the governed stack">
            <div className={v.stack}>
              <p className={v.dim}>The intended agent is recorded on the proposal. A selected vendor is attached to the accepted risk records during submission.</p>
              <div className={v.grid2}>
                <Field label="Model / agent">
                  <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                    <option value="">No agent selected yet</option>
                    {(agents.data?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.provider}/{agent.model ?? "default"}</option>)}
                  </Select>
                </Field>
                <Field label="Vendor">
                  <Select value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
                    <option value="">No vendor selected yet</option>
                    {(vendors.data?.vendors ?? []).map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name} · {vendor.status}</option>)}
                  </Select>
                </Field>
              </div>
              {agents.isError || vendors.isError ? <p className={v.errLine}>Some stack choices could not be loaded. You can continue without linking them.</p> : null}
            </div>
          </Card>
        )}

        {step === 4 && assist.data && (
          <Card title="Review before submission">
            <div className={v.stack}>
              <div className={v.grid3}>
                <Summary value={assist.data.tier.value} label="Proposed tier" />
                <Summary value={acceptedFrameworks.length} label="Accepted frameworks" />
                <Summary value={acceptedRisks.length} label="Accepted risks" />
              </div>
              <div className={v.listRow}><strong>Name</strong><span className={v.grow}>{title}</span></div>
              <div className={v.listRow}><strong>Description</strong><span className={v.grow}>{description}</span></div>
              <div className={v.listRow}><strong>Questionnaire</strong><span className={v.grow}>{acceptedQuestions.length} accepted sections plus the EU AI Act answers block</span></div>
              <div className={v.listRow}><strong>Sources</strong><span className={`${v.grow} ${v.row}`}>{sourceSummary.map((source) => <Badge key={source} tone="info">{source}</Badge>)}</span></div>
              {assist.data.blocking ? (
                <div className={v.errLine} role="alert">
                  This proposal screened as prohibited. The platform does not expose a direct “save rejected” transition, so submission is disabled rather than misrepresenting a proposed record as rejected.
                </div>
              ) : (
                <div className={s.callout}>
                  Submission creates the use case, advances planning, stores the human-edited questionnaire, creates each accepted risk, and links its suggested controls. If a later step fails, retry resumes from the last successful checkpoint rather than duplicating records.
                </div>
              )}
              {submitAction.error ? <p className={v.errLine} role="alert">{submitAction.error} The completed steps have been retained; retry to resume.</p> : null}
              {submittedUseCaseId ? (
                <div className={s.callout} role="status">
                  Submitted for human review. <Link to={`/admin/governance/use-cases/${submittedUseCaseId}`}>Open the use-case workspace</Link>.
                </div>
              ) : (
                <div>
                  <Button
                    variant="primary"
                    disabled={submitAction.busy || Boolean(assist.data.blocking)}
                    onClick={() => void submitAction.run(submit, "Use case submitted for human review")}
                  >
                    {submitAction.busy ? "Submitting…" : "Submit for human review"}
                  </Button>{" "}
                  <Link to="/admin/use-cases">Open the classic register</Link>
                </div>
              )}
            </div>
          </Card>
        )}

        {step > 0 && (
          <div className={s.footerActions}>
            <Button variant="ghost" onClick={() => setStep((current) => Math.max(0, current - 1))}>Back</Button>
            {step < STEPS.length - 1 && <Button variant="primary" disabled={!canContinue} onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}>Continue</Button>}
          </div>
        )}
      </div>
    </>
  );
}

function Check(props: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className={s.checkbox}><input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} /><span>{props.label}</span></label>;
}

function Suggestion(props: { title: string; body: string; source: Source; decision?: Decision; onDecision: (value: Decision) => void; onEdit: (value: string) => void; meta?: string }) {
  const [editing, setEditing] = useState(false);
  const rejected = props.decision === "rejected";
  return (
    <section className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
      <div className={s.suggestionHeader}><strong>{props.title}</strong><Badge tone="info">{props.source}</Badge><Badge tone={rejected ? "neutral" : "ok"}>{rejected ? "rejected" : "accepted"}</Badge></div>
      {props.meta ? <p className={v.faint}>{props.meta}</p> : null}
      {editing ? (
        <Field label={`Edit ${props.title}`}><Textarea rows={4} value={props.body} onChange={(event) => props.onEdit(event.target.value)} /></Field>
      ) : (
        <p className={v.dim}>{props.body}</p>
      )}
      <div className={s.suggestionActions}>
        <Button size="sm" variant={rejected ? "default" : "primary"} onClick={() => props.onDecision("accepted")}>Accept</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "Edit"}</Button>
        <Button size="sm" variant={rejected ? "danger" : "ghost"} onClick={() => props.onDecision("rejected")}>Reject</Button>
      </div>
    </section>
  );
}

function Summary({ value, label }: { value: string | number; label: string }) {
  return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}>{label}</span></div>;
}
