/**
 * "Register AI use case" — the ONE way to propose an AI use case (ADR-0168
 * items 1 and 3). A full-page registration: a short Describe step, the EU AI
 * Act screening on its own Classify step, the assistant's suggestions to
 * accept or reject, the questionnaire, the stack, and a review. A right rail
 * lists existing use cases similar to the one being typed, so a duplicate is
 * seen before it is created; it never blocks the submission.
 *
 * The submission itself is AER-046's checkpointed pipeline (intakeCheckpoint.ts):
 * a retry after a failure resumes, applies edits to what was written, or is
 * refused with nothing sent.
 */
import { cloneElement, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import { humanize, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, Field, Fieldset, Input, Select, Textarea } from "../../../ui/kit";
import { useAction, useAgents } from "../adminKit";
import v from "../../views.module.css";
import k from "../../../ui/kit.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";
import { deriveDataSensitivity } from "./dataSensitivity";
import { canonicalDigest, emptyCheckpoint, planSubmission, type SubmissionCheckpoint, type SubmissionInputs } from "./intakeCheckpoint";
import { findSimilar, tokens } from "./similarUseCases";
import { statusLabel, statusTone, type UseCaseRow } from "./registryModel";

type Source = "rules" | "mock" | "model";
type Decision = "accepted" | "rejected";
type BooleanAnswer = "" | "yes" | "no";

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

/** AER-046: a retry the earlier records cannot be brought in line with — nothing was sent */
class RetryRefused extends Error {
  constructor(readonly useCaseId: string, readonly reasons: string[]) {
    super("This retry was not sent: the use case was already created from your earlier answers, and the gateway cannot apply these changes to it.");
    this.name = "RetryRefused";
  }
}

const STEPS = ["Describe", "Classify", "Suggestions", "Questionnaire", "Link stack", "Review"];
const DESCRIBE = 0;
const CLASSIFY = 1;
const SUGGESTIONS = 2;
const REVIEW = STEPS.length - 1;
const REGISTRY = "/admin/use-cases";

/** who wrote a suggestion, in words — never the internal source key */
const SOURCE_LABEL: Record<Source, string> = { rules: "Suggested by rules", model: "Suggested by AI", mock: "Sample suggestion" };
const SECTOR_OPTIONS = ["financial-services", "securities-broker-dealer", "healthcare", "payments", "public-sector", "general"] as const;
const DATA_CATEGORY_OPTIONS = ["personal", "sensitive-personal", "health", "payment-card", "financial", "proprietary", "public"] as const;

/** a rule's lowercase clause as a sentence: capital first letter, one closing period */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.$/, "")}.`;

export default function IntakeWizardPage() {
  const [prefill] = useSearchParams();
  const fromShadowAi = prefill.get("source") === "shadow-ai";
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(prefill.get("title") ?? "");
  const [description, setDescription] = useState(prefill.get("description") ?? "");
  // optional: blank reuses the purpose, as the single-field form always did
  const [businessContext, setBusinessContext] = useState("");
  // Every answer starts BLANK. A new operator opening this page must describe
  // their own system — a pre-selected sample read as a record that already
  // existed (UXJ-06). The worked example is one explicit click away below.
  const [purposeDomain, setPurposeDomain] = useState("");
  const [affectedPerson, setAffectedPerson] = useState("");
  const [decisionAutonomy, setDecisionAutonomy] = useState("");
  const [biometricUse, setBiometricUse] = useState("");
  const [emotionRecognition, setEmotionRecognition] = useState<BooleanAnswer>("");
  const [socialScoring, setSocialScoring] = useState<BooleanAnswer>("");
  const [manipulativeTechniques, setManipulativeTechniques] = useState<BooleanAnswer>("");
  const [profilesNaturalPersons, setProfilesNaturalPersons] = useState<BooleanAnswer>("");
  const [safetyComponent, setSafetyComponent] = useState<BooleanAnswer>("");
  const [interactsWithHumans, setInteractsWithHumans] = useState<BooleanAnswer>("");
  const [generative, setGenerative] = useState<BooleanAnswer>("");
  const [sectors, setSectors] = useState<string[]>([]);
  const [dataCategories, setDataCategories] = useState<string[]>([]);
  const [deployment, setDeployment] = useState("");
  const [euNexus, setEuNexus] = useState<BooleanAnswer>("");
  const [autonomousActions, setAutonomousActions] = useState<BooleanAnswer>("");
  const [usesExternalVendor, setUsesExternalVendor] = useState<BooleanAnswer>("");
  /** the worked example (a fictional bank's credit-limit assistant) — only on request */
  const fillExample = () => {
    setTitle("Credit-limit-increase assistant");
    setDescription("Helps Acme Bank customers request a credit-limit increase using profile and financial data, with a human reviewing every recommendation.");
    setBusinessContext("Faster answers for customers while every lending decision stays with an accountable person.");
    setPurposeDomain("essential-services");
    setAffectedPerson("customers");
    setDecisionAutonomy("human-reviews");
    setBiometricUse("none");
    setEmotionRecognition("no");
    setSocialScoring("no");
    setManipulativeTechniques("no");
    setProfilesNaturalPersons("yes");
    setSafetyComponent("no");
    setInteractsWithHumans("yes");
    setGenerative("yes");
    setSectors(["financial-services"]);
    setDataCategories(["personal", "financial"]);
    setDeployment("customer-facing");
    setEuNexus("yes");
    setAutonomousActions("no");
    setUsesExternalVendor("yes");
  };
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, string>>({});
  const [questionnaire, setQuestionnaire] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [submittedUseCaseId, setSubmittedUseCaseId] = useState<string | null>(null);
  // AER-046: each entry is bound to the digest of the inputs that wrote it (intakeCheckpoint.ts)
  const checkpoint = useRef<SubmissionCheckpoint>(emptyCheckpoint());
  const [retryRefused, setRetryRefused] = useState<RetryRefused | null>(null);
  const submitAction = useAction();
  const startOverAction = useAction();
  // A stage change unmounts the button that caused it ("Draft suggestions",
  // "Continue" on the last-but-one stage), which drops keyboard focus on
  // <body> and leaves a screen reader silent. Move focus to the new stage's
  // heading instead, so it is announced and Tab continues from the stage's
  // top. Not on first render: opening the page must not steal focus (AER-029).
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stageHeading.current?.focus();
  }, [step]);

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
          affectedPersons: affectedPerson === "none" ? [] : [affectedPerson],
          decisionAutonomy,
          biometricUse,
          emotionRecognition: emotionRecognition === "yes",
          socialScoring: socialScoring === "yes",
          manipulativeTechniques: manipulativeTechniques === "yes",
          profilesNaturalPersons: profilesNaturalPersons === "yes",
          safetyComponent: safetyComponent === "yes",
          interactsWithHumans: interactsWithHumans === "yes",
          generatesSyntheticContent: generative === "yes",
        },
        context: {
          sectors,
          dataCategories,
          deployment,
          euNexus: euNexus === "yes",
          usesExternalVendor: usesExternalVendor === "yes",
          generative: generative === "yes",
          autonomousActions: autonomousActions === "yes",
          toolsUsed: [],
        },
        draftNarrative: true,
        ...(agentId ? { agentId } : {}),
      }),
    onSuccess: (data) => {
      // frameworks and risks start UNDECIDED — the proposer accepts, edits or
      // rejects each (ADR-0149); questionnaire drafts are included and edited
      // answer by answer on the next step
      setDecisions(Object.fromEntries(data.questionnaire.map((item) => [`question:${item.id}`, "accepted" as const])));
      setQuestionnaire(Object.fromEntries(data.questionnaire.map((item) => [item.id, item.text])));
      setStep(SUGGESTIONS);
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

  const intakeAnswersComplete = Boolean(
    purposeDomain && affectedPerson && decisionAutonomy && biometricUse &&
    emotionRecognition && socialScoring && manipulativeTechniques && profilesNaturalPersons &&
    safetyComponent && interactsWithHumans && generative && sectors.length > 0 && dataCategories.length > 0 && deployment &&
    euNexus && autonomousActions && usesExternalVendor,
  );
  // ADR-0149: a suggestion is the proposer's to accept, edit or reject — none
  // counts as accepted until someone decides it ("Accept all remaining" is
  // that decision, made deliberately for the rest)
  const suggestionKeys = assist.data
    ? [...assist.data.frameworks.map((item) => `framework:${item.framework}`), ...assist.data.risks.map((item) => `risk:${item.scenarioKey}`)]
    : [];
  const undecidedSuggestions = suggestionKeys.filter((key) => !decisions[key]);
  const acceptAllRemaining = () =>
    setDecisions((current) => ({ ...current, ...Object.fromEntries(undecidedSuggestions.map((key) => [key, "accepted" as Decision])) }));
  const describeComplete = Boolean(title.trim() && description.trim());
  const canContinue =
    step === DESCRIBE
      ? describeComplete
      : step === CLASSIFY
        ? describeComplete && intakeAnswersComplete
        : step === SUGGESTIONS
          ? Boolean(assist.data) && undecidedSuggestions.length === 0
          : Boolean(assist.data);
  const setDecision = (key: string, value: Decision) => setDecisions((current) => ({ ...current, [key]: value }));

  const questionnaireMarkdown = () => {
    if (!assist.data) return "";
    const sections = acceptedQuestions.map((item) => {
      const edited = questionnaire[item.id] ?? item.text;
      return `## ${item.heading}\n\n${edited.trim()}`;
    });
    return [...sections, `## 9. EU AI Act risk screening\n\n${assist.data.euAiActBlock.trim()}`].join("\n\n");
  };

  /** exactly what each step sends, read once per attempt so every request of it sees the same inputs */
  const submissionInputs = (): SubmissionInputs => ({
    useCase: {
      name: title.trim(),
      description: description.trim(),
      businessContext: businessContext.trim() || description.trim(),
      dataSensitivity: deriveDataSensitivity(dataCategories),
      complianceTags: acceptedFrameworks.map((item) => item.framework),
      intendedAgentIds: agentId ? [agentId] : [],
    },
    questionnaire: questionnaireMarkdown(),
    risks: acceptedRisks.map((risk) => ({
      key: risk.scenarioKey,
      inputs: {
        title: risk.title,
        description: suggestionEdits[`risk:${risk.scenarioKey}`] ?? risk.description,
        category: risk.category,
        likelihood: risk.likelihood,
        impact: risk.impact,
        ...(agentId ? { agentId } : {}),
        ...(vendorId ? { vendorId } : {}),
      },
      controls: risk.suggestedControls,
    })),
  });

  const submit = async () => {
    if (!assist.data) return;
    setRetryRefused(null);
    const progress = checkpoint.current;
    const inputs = submissionInputs();
    // AER-046: decide every step BEFORE the first request — a retry whose
    // edits the written records cannot take is refused with nothing sent
    const plan = planSubmission(progress, inputs);
    if (plan.kind === "refuse") {
      const refused = new RetryRefused(plan.useCaseId, plan.reasons);
      setRetryRefused(refused);
      throw refused;
    }

    if (plan.useCase.action === "create") {
      const created = await api.post<CreatedUseCase>("/v1/use-cases", inputs.useCase);
      progress.useCase = { id: created.id, instanceId: created.instance?.id, inputs: inputs.useCase, digest: canonicalDigest(inputs.useCase) };
    } else if (plan.useCase.action === "update") {
      await api.patch(`/v1/use-cases/${progress.useCase!.id}`, plan.useCase.patch);
      progress.useCase = { ...progress.useCase!, inputs: inputs.useCase, digest: canonicalDigest(inputs.useCase) };
    }
    const useCase = progress.useCase!;

    if (!useCase.instanceId) {
      throw new Error("The use case was created, but the intake workflow instance was not returned. Retry after an operator checks the workflow setup.");
    }
    if (!progress.planningAdvanced) {
      await api.post(`/v1/workflows/instances/${useCase.instanceId}/advance`, { stageId: "plan" });
      progress.planningAdvanced = true;
    }
    if (plan.questionnaire !== "reuse") {
      // a resubmission is a NEW VERSION: the kernel re-opens the questionnaire
      // stage and supersedes the sign-off that was waiting on the stale one
      await api.post(`/v1/workflows/instances/${useCase.instanceId}/artifacts`, {
        stageId: "questionnaire",
        content: inputs.questionnaire,
      });
      progress.questionnaire = { digest: canonicalDigest(inputs.questionnaire) };
    }

    for (const { key, step, controlsToLink } of plan.risks) {
      const risk = inputs.risks.find((item) => item.key === key)!;
      if (step.action === "create") {
        const created = await api.post<CreatedRisk>("/v1/risks", { ...risk.inputs, useCaseId: useCase.id });
        progress.risks[key] = { id: created.id, inputs: risk.inputs, digest: canonicalDigest(risk.inputs), linkedControls: [] };
      } else if (step.action === "update") {
        await api.patch(`/v1/risks/${progress.risks[key]!.id}`, step.patch);
        progress.risks[key] = { ...progress.risks[key]!, inputs: risk.inputs, digest: canonicalDigest(risk.inputs) };
      }
      const written = progress.risks[key]!;
      for (const controlRef of controlsToLink) {
        try {
          await api.post(`/v1/risks/${written.id}/controls`, { controlRef });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
        }
        written.linkedControls.push(controlRef);
      }
    }

    setSubmittedUseCaseId(useCase.id);
  };

  /**
   * the proposer's explicit choice to submit these answers as a new use case.
   * The earlier record is WITHDRAWN first (its intake instance aborted: the
   * pending sign-off is superseded and the use case reads rejected), so an
   * approver can never sign off a record with only part of its risk set. If the
   * withdrawal fails nothing is cleared and the refusal stays on screen.
   */
  const startOver = async () => {
    const earlier = checkpoint.current.useCase;
    if (earlier?.instanceId) await api.post(`/v1/workflows/instances/${earlier.instanceId}/abort`, {});
    checkpoint.current = emptyCheckpoint();
    setRetryRefused(null);
    submitAction.setError(null);
  };


  const { auth } = useSession();
  const ownerName = auth?.user?.displayName ?? auth?.user?.email ?? "You";
  const goTo = (next: number) => setStep(Math.max(0, Math.min(REVIEW, next)));
  const prohibitedAlert = assist.data?.blocking ? (
    <div className={v.errLine} role="alert">
      <strong>Screened PROHIBITED (Art. 5) — a reviewer must refuse it at sign-off; it cannot go live.</strong>{" "}
      {typeof assist.data.blocking === "string" ? assist.data.blocking : assist.data.blocking.reason ?? "See the rule reasons."}
    </div>
  ) : null;

  // the step's one primary action, top right beside Cancel (and Back)
  const primary =
    step === DESCRIBE ? (
      <Button variant="primary" type="submit" form="intake-describe" disabled={!canContinue}>Continue</Button>
    ) : step === CLASSIFY ? (
      <Button variant="primary" type="submit" form="intake-classify" disabled={!canContinue || assist.isPending}>
        {assist.isPending ? "Drafting…" : "Draft suggestions"}
      </Button>
    ) : step < REVIEW ? (
      <Button variant="primary" disabled={!canContinue} onClick={() => goTo(step + 1)}>Continue</Button>
    ) : submittedUseCaseId ? null : (
      <Button variant="primary" disabled={submitAction.busy} onClick={() => void submitAction.run(submit, "Use case submitted for human review")}>
        {submitAction.busy ? "Submitting…" : "Submit for human review"}
      </Button>
    );

  return (
    <>
      <PageHeader
        title="Register AI use case"
        sub="Describe it, classify it, check the suggestions, then send it for review."
        info={<p>The assistant is suggestion-only. Nothing is saved until you submit, and you accept or reject every suggestion.</p>}
        actions={
          <div className={rg.headerActions}>
            {submittedUseCaseId ? (
              <Link to={REGISTRY} className={`${k.btn} ${rg.linkBtn}`}>Back to the registry</Link>
            ) : (
              <Link to={REGISTRY} className={`${k.btnGhost} ${rg.linkBtn}`}>Cancel</Link>
            )}
            {step > DESCRIBE && !submittedUseCaseId && <Button onClick={() => goTo(step - 1)}>Back</Button>}
            {primary}
          </div>
        }
      />
      <div className={rg.layout}>
        <div className={rg.main}>
          <ol className={rg.stepper} aria-label="Intake progress">
            {STEPS.map((label, index) => (
              <li key={label} className={`${rg.step} ${index === step ? rg.stepActive : index < step ? rg.stepDone : ""}`} aria-current={index === step ? "step" : undefined}>
                <span className={rg.stepNumber} aria-hidden>{index < step ? "✓" : index + 1}</span>
                <span className={rg.stepLabel}>{label}</span>
              </li>
            ))}
          </ol>

          {step === DESCRIBE && (
            <Card title={<StageHeading headingRef={stageHeading}>Describe the use case</StageHeading>}>
              <form id="intake-describe" className={rg.form} onSubmit={(event) => { event.preventDefault(); if (canContinue) goTo(CLASSIFY); }}>
                {fromShadowAi ? (
                  <div className={s.callout} role="status">
                    Prefilled from a shadow-AI finding — its name and observed use only. Answer the classification questions yourself; the finding does not establish them.
                  </div>
                ) : (
                  <div className={rg.exampleRow}>
                    <span>New here? See what a complete registration looks like.</span>
                    <Button size="sm" variant="ghost" onClick={fillExample}>Fill in an example</Button>
                  </div>
                )}
                <HintField label="Use-case name" hint="A name reviewers will recognize, such as “Credit-limit-increase assistant”.">
                  <Input value={title} onChange={(event) => setTitle(event.target.value)} required />
                </HintField>
                <HintField label="What will the system do?" hint="The task, who it affects, and what the AI produces or changes.">
                  <Textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} required />
                </HintField>
                <HintField label="Business context" optional hint="Why the business wants it and the outcome it should improve. Leave blank to reuse the purpose.">
                  <Textarea rows={3} value={businessContext} onChange={(event) => setBusinessContext(event.target.value)} />
                </HintField>
                <div className={rg.owner}>
                  <span className={rg.label}>Owner</span>
                  <span className={rg.ownerValue}>
                    <span className={rg.avatar} aria-hidden>{initials(ownerName)}</span>
                    {ownerName} (you)
                  </span>
                  <p className={rg.hint}>Whoever registers a use case owns it and completes its assessment.</p>
                </div>
              </form>
            </Card>
          )}

          {step === CLASSIFY && (
            <Card title={<StageHeading headingRef={stageHeading}>Classify the use case</StageHeading>}>
              <form id="intake-classify" className={rg.form} onSubmit={(event) => { event.preventDefault(); if (canContinue && !assist.isPending) assist.mutate(); }}>
                <p className={v.dim}>These answers set the EU AI Act risk tier and the suggestions. Blank does not mean “no”.</p>
                <section className={rg.group} aria-labelledby="classify-purpose">
                  <h3 id="classify-purpose" className={rg.groupTitle}>Purpose and people</h3>
                  <div className={rg.grid2}>
                    <HintField label="Primary purpose domain" hint="The area the output is used in.">
                      <Select value={purposeDomain} onChange={(event) => setPurposeDomain(event.target.value)} required>
                        <option value="">Choose a purpose domain</option>
                        <option value="essential-services">Essential services</option>
                        <option value="employment-hr">Employment / HR</option>
                        <option value="education">Education</option>
                        <option value="law-enforcement">Law enforcement</option>
                        <option value="migration-border">Migration / border control</option>
                        <option value="justice-democracy">Justice / democracy</option>
                        <option value="critical-infrastructure">Critical infrastructure</option>
                        <option value="general-business">General business</option>
                        <option value="internal-productivity">Internal productivity</option>
                      </Select>
                    </HintField>
                    <HintField label="People affected" hint="Whose decisions or data it touches.">
                      <Select value={affectedPerson} onChange={(event) => setAffectedPerson(event.target.value)} required>
                        <option value="">Choose who is affected</option><option value="none">No natural persons</option><option value="employees">Employees</option><option value="customers">Customers</option><option value="general-public">General public</option><option value="vulnerable-groups">Vulnerable groups</option>
                      </Select>
                    </HintField>
                    <HintField label="Decision autonomy" hint="How much a person decides before anything happens.">
                      <Select value={decisionAutonomy} onChange={(event) => setDecisionAutonomy(event.target.value)} required>
                        <option value="">Choose decision autonomy</option><option value="narrow-procedural">Narrow procedural task</option><option value="informs-human">Informs a human</option><option value="human-reviews">Human reviews every recommendation</option><option value="fully-automated">Fully automated</option>
                      </Select>
                    </HintField>
                    <HintField label="Deployment audience" hint="Who uses it directly.">
                      <Select value={deployment} onChange={(event) => setDeployment(event.target.value)} required>
                        <option value="">Choose deployment audience</option><option value="internal">Internal</option><option value="customer-facing">Customer-facing</option><option value="public">Public</option>
                      </Select>
                    </HintField>
                    <HintField label="Biometric use">
                      <Select value={biometricUse} onChange={(event) => setBiometricUse(event.target.value)} required>
                        <option value="">Choose biometric use</option><option value="none">None</option><option value="verification">1:1 verification</option><option value="remote-identification">Remote identification</option>
                      </Select>
                    </HintField>
                  </div>
                </section>
                <section className={rg.group} aria-labelledby="classify-data">
                  <h3 id="classify-data" className={rg.groupTitle}>Data and sector</h3>
                  <p className={rg.groupHint}>The strictest data category sets the data sensitivity.</p>
                  <div className={rg.grid2}>
                    <MultiAnswerField label="Data categories" values={dataCategories} options={DATA_CATEGORY_OPTIONS} onChange={setDataCategories} />
                    <MultiAnswerField label="Sectors" values={sectors} options={SECTOR_OPTIONS} onChange={setSectors} />
                  </div>
                </section>
                <section className={rg.group} aria-labelledby="classify-practices">
                  <h3 id="classify-practices" className={rg.groupTitle}>What it does in practice</h3>
                  <div className={rg.grid3}>
                    <BooleanAnswerField label="Profiles natural persons" value={profilesNaturalPersons} onChange={setProfilesNaturalPersons} />
                    <BooleanAnswerField label="Interacts directly with people" value={interactsWithHumans} onChange={setInteractsWithHumans} />
                    <BooleanAnswerField label="Generates synthetic content" value={generative} onChange={setGenerative} />
                    <BooleanAnswerField label="Can take autonomous actions" value={autonomousActions} onChange={setAutonomousActions} />
                    <BooleanAnswerField label="Uses an external AI vendor" value={usesExternalVendor} onChange={setUsesExternalVendor} />
                    <BooleanAnswerField label="Has an EU nexus" value={euNexus} onChange={setEuNexus} />
                    <BooleanAnswerField label="Safety component" value={safetyComponent} onChange={setSafetyComponent} />
                    <BooleanAnswerField label="Emotion recognition" value={emotionRecognition} onChange={setEmotionRecognition} />
                    <BooleanAnswerField label="Social scoring" value={socialScoring} onChange={setSocialScoring} />
                    <BooleanAnswerField label="Manipulative techniques" value={manipulativeTechniques} onChange={setManipulativeTechniques} />
                  </div>
                </section>
                {!intakeAnswersComplete ? <p className={v.faint}>Answer every question to draft suggestions.</p> : null}
                {assist.isError && <p className={v.errLine} role="alert">{(assist.error as Error).message}</p>}
              </form>
            </Card>
          )}

          {step === SUGGESTIONS && assist.data && (
            <Card title={<StageHeading headingRef={stageHeading}>Review suggestions</StageHeading>}>
              <div className={v.stack}>
                <div className={s.callout}>
                  Proposed tier: <strong>{assist.data.tier.value} risk</strong>. {assist.data.tier.disclaimer}
                </div>
                {prohibitedAlert}
                <div className={v.row}>
                  <Button size="sm" disabled={undecidedSuggestions.length === 0} onClick={acceptAllRemaining}>
                    Accept all remaining ({undecidedSuggestions.length})
                  </Button>
                  <span className={v.faint}>
                    {undecidedSuggestions.length === 0 ? "Every suggestion has a decision." : "Accept, edit or reject each one — nothing counts until you decide."}
                  </span>
                </div>
                <h3 className={v.sectionTitle}>Frameworks</h3>
                {assist.data.frameworks.map((item) => (
                  <Suggestion key={item.framework} title={item.title} body={suggestionEdits[`framework:${item.framework}`] ?? sentence(item.why)} source={item.source} decision={decisions[`framework:${item.framework}`]} onDecision={(value) => setDecision(`framework:${item.framework}`, value)} onEdit={(value) => setSuggestionEdits((current) => ({ ...current, [`framework:${item.framework}`]: value }))} hint="Why it applies. Accepting adds the framework to the use case." />
                ))}
                <h3 className={v.sectionTitle}>Risk scenarios</h3>
                {assist.data.risks.map((item) => (
                  <Suggestion key={item.scenarioKey} title={item.title} body={suggestionEdits[`risk:${item.scenarioKey}`] ?? `${item.description} Suggested because ${item.why.replace(/\.$/, "")}.`} source={item.source} decision={decisions[`risk:${item.scenarioKey}`]} onDecision={(value) => setDecision(`risk:${item.scenarioKey}`, value)} onEdit={(value) => setSuggestionEdits((current) => ({ ...current, [`risk:${item.scenarioKey}`]: value }))} meta={`${humanize(item.dimension)} · ${item.likelihood} likelihood · ${item.impact} impact`} hint="Accepted, this text becomes the description of a risk on the use case." />
                ))}
                <p className={v.faint}>{assist.data.disclaimer}</p>
              </div>
            </Card>
          )}

          {step === SUGGESTIONS + 1 && assist.data && (
            <Card title={<StageHeading headingRef={stageHeading}>Edit the questionnaire</StageHeading>}>
              <div className={v.stack}>
                <p className={v.dim}>The reviewer reads these answers. Replace draft wording with how the system really works.</p>
                {assist.data.questionnaire.map((item) => {
                  const rejected = decisions[`question:${item.id}`] === "rejected";
                  return (
                    <section key={item.id} className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
                      <div className={s.suggestionHeader}><strong>{item.heading}</strong><span className={rg.sourceLabel}>{SOURCE_LABEL[item.source]}</span><Badge tone={rejected ? "neutral" : "ok"}>{rejected ? "rejected" : "accepted"}</Badge></div>
                      {!rejected && (
                        <HintField label={`${item.heading} answer`} visuallyHiddenLabel>
                          <Textarea rows={4} value={questionnaire[item.id] ?? item.text} onChange={(event) => setQuestionnaire((current) => ({ ...current, [item.id]: event.target.value }))} />
                        </HintField>
                      )}
                      <div className={s.suggestionActions}>
                        <Button size="sm" variant={rejected ? "default" : "primary"} aria-pressed={!rejected} onClick={() => setDecision(`question:${item.id}`, "accepted")}>Accept</Button>
                        <Button size="sm" variant={rejected ? "danger" : "ghost"} aria-pressed={rejected} onClick={() => setDecision(`question:${item.id}`, "rejected")}>Reject</Button>
                      </div>
                    </section>
                  );
                })}
                <HintField label="9. EU AI Act risk screening" hint="Generated from your Classify answers so a reviewer can reproduce the tier. Read-only.">
                  <Textarea rows={8} value={assist.data.euAiActBlock} readOnly />
                </HintField>
              </div>
            </Card>
          )}

          {step === REVIEW - 1 && (
            <Card title={<StageHeading headingRef={stageHeading}>Link the stack</StageHeading>}>
              <div className={`${v.stack} ${rg.form}`}>
                <div className={rg.grid2}>
                  <HintField label="Model / agent" hint="The agent it will run on — recorded as the intended agent.">
                    <Select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                      <option value="">No agent selected yet</option>
                      {(agents.data?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.provider}/{agent.model ?? "default"}</option>)}
                    </Select>
                  </HintField>
                  <HintField label="Vendor" hint="Attached to each accepted risk.">
                    <Select value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
                      <option value="">No vendor selected yet</option>
                      {(vendors.data?.vendors ?? []).map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name} · {vendor.status}</option>)}
                    </Select>
                  </HintField>
                </div>
                {agents.isError || vendors.isError ? <p className={v.errLine}>Some choices could not be loaded. You can continue without them.</p> : null}
              </div>
            </Card>
          )}

          {step === REVIEW && assist.data && (
            <Card title={<StageHeading headingRef={stageHeading}>Review and submit</StageHeading>}>
              <div className={v.stack}>
                <div className={v.grid3}>
                  <Summary value={humanize(assist.data.tier.value)} label="Proposed tier" />
                  <Summary value={acceptedFrameworks.length} label="Accepted frameworks" />
                  <Summary value={acceptedRisks.length} label="Accepted risks" />
                </div>
                <div className={v.listRow}><strong>Name</strong><span className={v.grow}>{title}</span></div>
                <div className={v.listRow}><strong>Purpose</strong><span className={v.grow}>{description}</span></div>
                <div className={v.listRow}><strong>Business context</strong><span className={v.grow}>{businessContext.trim() || <span className={v.faint}>Same as the purpose</span>}</span></div>
                <div className={v.listRow}><strong>Owner</strong><span className={v.grow}>{ownerName}</span></div>
                <div className={v.listRow}><strong>Questionnaire</strong><span className={v.grow}>{plural(acceptedQuestions.length, "accepted section")}, plus the EU AI Act answers</span></div>
                <div className={v.listRow}><strong>Data sensitivity</strong><span className={v.grow}><Badge tone="info">{humanize(deriveDataSensitivity(dataCategories))}</Badge> <span className={v.faint}>from the data categories — the strictest wins</span></span></div>
                <div className={v.listRow}><strong>Suggested by</strong><span className={`${v.grow} ${v.row}`}>{sourceSummary.map((source) => <span key={source} className={rg.sourceLabel}>{SOURCE_LABEL[source]}</span>)}</span></div>
                {prohibitedAlert}
                {!submittedUseCaseId && (
                  <div className={s.callout}>
                    Submitting creates the use case with its risks and controls and sends it for review. If a step fails, retry continues where it stopped — nothing is created twice.
                  </div>
                )}
                {retryRefused ? (
                  <div className={`${v.errLine} ${s.refusal}`} role="alert">
                    <p>{retryRefused.message}</p>
                    <ul>{retryRefused.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    <p>
                      Undo those changes and submit again to finish that record, <Link to={`/admin/governance/use-cases/${retryRefused.useCaseId}`}>open the existing use case</Link>, or start over: that withdraws the earlier record (its pending sign-off is cancelled and it reads rejected) and submits these answers as a new use case.
                    </p>
                    {startOverAction.error ? <p>The earlier record could not be withdrawn, so nothing was started: {startOverAction.error}</p> : null}
                    <Button size="sm" disabled={startOverAction.busy} onClick={() => void startOverAction.run(startOver, "Earlier record withdrawn")}>
                      {startOverAction.busy ? "Withdrawing…" : "Start over as a new use case"}
                    </Button>
                  </div>
                ) : submitAction.error ? <p className={v.errLine} role="alert">{submitAction.error} The completed steps have been retained; retry to resume.</p> : null}
                {submittedUseCaseId ? (
                  <div className={s.callout} role="status">
                    Submitted for human review. <Link to={`/admin/governance/use-cases/${submittedUseCaseId}`}>Open the use-case workspace</Link>.
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </div>
        <SimilarUseCases name={title} description={description} excludeIds={[submittedUseCaseId, checkpoint.current.useCase?.id].filter((id): id is string => Boolean(id))} />
      </div>
    </>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "?";

/**
 * The right rail: existing use cases like the one being typed (ADR-0168 item 3).
 * Advice only — it links each match and never blocks a submission.
 */
function SimilarUseCases(props: { name: string; description: string; excludeIds: string[] }) {
  const list = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases?: UseCaseRow[] }>("/v1/use-cases"),
  });
  const name = useDeferredValue(props.name);
  const description = useDeferredValue(props.description);
  const exclude = props.excludeIds.join(",");
  const matches = useMemo(
    () => findSimilar({ name, description }, list.data?.useCases ?? [], { excludeIds: exclude ? exclude.split(",") : [] }),
    [name, description, list.data, exclude],
  );
  // the same two-word floor findSimilar applies: below it there is nothing to say yet
  const comparable = new Set([...tokens(name), ...tokens(description)]).size >= 2;
  const summary = list.isLoading
    ? "Checking the registry…"
    : list.isError
      ? "The registry could not be checked right now. You can still continue."
      : matches.length > 0
        ? <>We found <strong>{plural(matches.length, "similar use case")}</strong> — review {matches.length === 1 ? "it" : "them"} to avoid a duplicate.</>
        : comparable
          ? "No similar use cases found."
          : "Type a name and purpose to check for similar use cases.";
  return (
    <aside className={rg.rail} aria-labelledby="similar-use-cases-title">
      <h2 id="similar-use-cases-title" className={rg.railTitle}>Similar use cases</h2>
      <p className={rg.railSummary} aria-live="polite">{summary}</p>
      {matches.length > 0 && (
        <ul className={rg.railList}>
          {matches.map(({ useCase }) => (
            <li key={useCase.id} className={rg.railItem}>
              <span className={rg.railItemHead}>
                <Link to={`/admin/governance/use-cases/${useCase.id}`}>{useCase.name}</Link>
                <Badge tone={statusTone(useCase.status)}>{statusLabel(useCase.status)}</Badge>
              </span>
              {useCase.description ? <p className={rg.railDesc}>{useCase.description}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * A labelled control with a short hint UNDER it (ADR-0168: hints, not popovers).
 * The hint is the control's description (aria-describedby), so a screen reader
 * reads it after the name; the label stays exactly the field's name.
 */
function HintField(props: { label: string; hint?: ReactNode; optional?: boolean; visuallyHiddenLabel?: boolean; children: ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={rg.field}>
      <label className={props.visuallyHiddenLabel ? rg.srOnly : rg.label} htmlFor={id}>
        {props.label}
        {props.optional ? <span className={rg.optional} aria-hidden> (optional)</span> : null}
      </label>
      {cloneElement(props.children, { id, "aria-describedby": props.hint ? hintId : undefined })}
      {props.hint ? <p id={hintId} className={rg.hint}>{props.hint}</p> : null}
    </div>
  );
}

function BooleanAnswerField(props: { value: BooleanAnswer; onChange: (value: BooleanAnswer) => void; label: string }) {
  return (
    <Field label={props.label}>
      <Select value={props.value} onChange={(event) => props.onChange(event.target.value as BooleanAnswer)} required>
        <option value="">Choose yes or no</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    </Field>
  );
}

function MultiAnswerField(props: { label: string; values: string[]; options: readonly string[]; onChange: (values: string[]) => void }) {
  const toggle = (option: string, checked: boolean) => props.onChange(checked
    ? [...props.values, option]
    : props.values.filter((value) => value !== option));
  // a group of boxes is a fieldset, not a Field: the caption names the group
  // and each option keeps its own name (AER-029)
  return (
    <Fieldset legend={`${props.label} — select all that apply`}>
      <div className={v.stackTight}>
        {props.options.map((option) => (
          <label className={s.checkbox} key={option}>
            <input
              type="checkbox"
              // the visible words, so a speech-input user can say what they
              // see (WCAG 2.5.3); the slug is the stored value, not a name
              aria-label={`${props.label}: ${humanize(option)}`}
              checked={props.values.includes(option)}
              onChange={(event) => toggle(option, event.target.checked)}
            />
            <span>{humanize(option)}</span>
          </label>
        ))}
      </div>
    </Fieldset>
  );
}

function Suggestion(props: { title: string; body: string; source: Source; decision?: Decision; onDecision: (value: Decision) => void; onEdit: (value: string) => void; meta?: string; hint: string }) {
  const [editing, setEditing] = useState(false);
  const rejected = props.decision === "rejected";
  const accepted = props.decision === "accepted";
  return (
    <section className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
      <div className={s.suggestionHeader}><strong>{props.title}</strong><span className={rg.sourceLabel}>{SOURCE_LABEL[props.source]}</span><Badge tone={rejected ? "neutral" : accepted ? "ok" : "warn"}>{rejected ? "rejected" : accepted ? "accepted" : "not reviewed"}</Badge></div>
      {props.meta ? <p className={v.faint}>{props.meta}</p> : null}
      {editing ? (
        <HintField label={`Edit ${props.title}`} hint={props.hint}><Textarea rows={4} value={props.body} onChange={(event) => props.onEdit(event.target.value)} /></HintField>
      ) : (
        <p className={v.dim}>{props.body}</p>
      )}
      <div className={s.suggestionActions}>
        <Button size="sm" variant={accepted ? "default" : "primary"} aria-pressed={accepted} onClick={() => props.onDecision("accepted")}>Accept</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing((value) => !value)}>{editing ? "Done editing" : "Edit"}</Button>
        <Button size="sm" variant={rejected ? "danger" : "ghost"} aria-pressed={rejected} onClick={() => props.onDecision("rejected")}>Reject</Button>
      </div>
    </section>
  );
}

/** a wizard stage's title: a real heading, focusable by script only, so a stage change can land focus on it */
function StageHeading(props: { headingRef: RefObject<HTMLHeadingElement>; children: ReactNode }) {
  return <h2 ref={props.headingRef} tabIndex={-1} className={s.stageHeading}>{props.children}</h2>;
}

function Summary({ value, label }: { value: string | number; label: string }) {
  return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}>{label}</span></div>;
}
