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
 *
 * ADR-0171: the work is kept as a server-side draft (saved as you go, offered
 * back when the page opens), the create carries an `Idempotency-Key` kept in
 * that draft (a retry after a lost response, even after a reload, cannot
 * create a second use case), leaving asks first, returning to Classify never
 * silently replaces edits, a "Not sure" answer is recorded and counts as yes,
 * an edited framework explanation is saved, and Review shows the proposal.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import type { ReviewPolicy, ReviewTier } from "../../../api/types";
import { humanize, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, Input, Select, Textarea } from "../../../ui/kit";
import { useAction, useAgents } from "../adminKit";
import v from "../../views.module.css";
import k from "../../../ui/kit.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";
import ix from "./intakeHelp.module.css";
import { deriveDataSensitivity } from "./dataSensitivity";
import { canonicalDigest, emptyCheckpoint, planSubmission, type SubmissionCheckpoint, type SubmissionInputs } from "./intakeCheckpoint";
import { findSimilar, tokens } from "./similarUseCases";
import { statusLabel, statusTone, type UseCaseRow } from "./registryModel";
import { REVIEW_POLICY_KEY } from "./reviewPolicy";
import {
  AFFECTED_PERSON_OPTIONS,
  BIOMETRIC_OPTIONS,
  BooleanAnswerField,
  DECISION_AUTONOMY_OPTIONS,
  DATA_CATEGORY_OPTIONS,
  DEPLOYMENT_OPTIONS,
  HintField,
  MissingAnswers,
  MultiAnswerField,
  PURPOSE_DOMAIN_OPTIONS,
  SCREENING_HELP,
  SECTOR_OPTIONS,
  StageHeading,
  optionList,
  questionId,
} from "./intakeFields";
import { IntakeResubmit } from "./IntakeResubmit";
import { savedAtText, useIntakeDraft, type DraftStatus } from "./intakeDraft";
import { useLeaveGuard } from "./LeaveGuard";
import {
  BOOLEAN_QUESTIONS,
  CLASSIFY_GROUPS,
  applyProposal,
  classificationFingerprint,
  contextAnswers,
  diffIsEmpty,
  diffProposals,
  emptyForm,
  euAiActAnswers,
  euUnsureKeys,
  exampleForm,
  frameworkKey,
  initialProposalState,
  missingAnswers,
  newIdempotencyKey,
  outcomeUnknown,
  questionKey,
  questionLabel,
  readRegistrationDraft,
  riskKey,
  unsureKeys,
  withUnsure,
  type BooleanQuestion,
  type Decision,
  type FrameworkSuggestion,
  type IntakeAssistResponse,
  type ProposalDiff,
  type ProposalState,
  type RegistrationDraft,
  type RegistrationForm,
  type Source,
  type SubmissionAttempt,
} from "./registrationModel";

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
const QUESTIONNAIRE = 3;
const STACK = 4;
const REVIEW = STEPS.length - 1;
const REGISTRY = "/admin/use-cases";
const FRAMEWORK_RATIONALE_MAX = 2000;

/** who wrote a suggestion, in words — never the internal source key */
const SOURCE_LABEL: Record<Source, string> = { rules: "Suggested by rules", model: "Suggested by AI", mock: "Sample suggestion" };

/** a rule's lowercase clause as a sentence: capital first letter, one closing period */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.$/, "")}.`;

/** the explanation a framework suggestion shows before anyone edits it */
const frameworkWhy = (item: FrameworkSuggestion) => sentence(item.why);

/**
 * `?resubmit=<id>` opens the same screen in resubmit mode for a use case sent
 * back for information (ADR-0168 amendment); otherwise it registers a new one.
 */
export default function IntakeWizardPage() {
  const [params] = useSearchParams();
  const resubmitId = params.get("resubmit");
  return resubmitId ? <IntakeResubmit key={resubmitId} useCaseId={resubmitId} /> : <RegisterUseCase />;
}

const EMPTY_PROPOSAL_STATE: ProposalState = { decisions: {}, suggestionEdits: {}, questionnaire: {} };

function RegisterUseCase() {
  const [prefill] = useSearchParams();
  const fromShadowAi = prefill.get("source") === "shadow-ai";
  // Every answer starts BLANK. A new operator opening this page must describe
  // their own system — a pre-selected sample read as a record that already
  // existed (UXJ-06). The worked example is one explicit click away below.
  const [initialForm] = useState(() => emptyForm({ title: prefill.get("title"), description: prefill.get("description") }));
  const [form, setForm] = useState<RegistrationForm>(initialForm);
  const setField = <K extends keyof RegistrationForm>(key: K, value: RegistrationForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setAnswer = (key: BooleanQuestion, value: RegistrationForm["answers"][BooleanQuestion]) =>
    setForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));
  const [step, setStep] = useState(0);
  // the assistant's proposal, the classification it was drafted from, and the proposer's decisions about it
  const [proposal, setProposal] = useState<IntakeAssistResponse | null>(null);
  const [proposalFingerprint, setProposalFingerprint] = useState<string | null>(null);
  const [pstate, setPstate] = useState<ProposalState>(EMPTY_PROPOSAL_STATE);
  // AER-051: a re-draft from CHANGED answers waits for the proposer's choice
  const [redraft, setRedraft] = useState<{ proposal: IntakeAssistResponse; fingerprint: string; diff: ProposalDiff } | null>(null);
  const [agentId, setAgentId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [submittedUseCaseId, setSubmittedUseCaseId] = useState<string | null>(null);
  // AER-046: each entry is bound to the digest of the inputs that wrote it (intakeCheckpoint.ts)
  const checkpoint = useRef<SubmissionCheckpoint>(emptyCheckpoint());
  // AER-050: the create's idempotency key, minted once per attempt and reused on every retry of it
  const attempt = useRef<SubmissionAttempt | null>(null);
  const [, setProgress] = useState(0);
  const [retryRefused, setRetryRefused] = useState<RetryRefused | null>(null);
  // "Edit this section" on Review: the step to come back to
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const submitAction = useAction();
  const startOverAction = useAction();
  // A stage change unmounts the button that caused it ("Draft suggestions",
  // "Continue" on the last-but-one stage), which drops keyboard focus on
  // <body> and leaves a screen reader silent. Move focus to the new stage's
  // heading instead, so it is announced and Tab continues from the stage's
  // top. Not on first render: opening the page must not steal focus (AER-029).
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  const { auth } = useSession();
  const ownerName = auth?.user?.displayName ?? auth?.user?.email ?? "You";

  // ---- the draft (AER-050) -------------------------------------------------
  const dirty = !submittedUseCaseId && (
    canonicalDigest(form) !== canonicalDigest(initialForm) || proposal !== null || agentId !== "" || vendorId !== "" ||
    Boolean(checkpoint.current.useCase) || attempt.current !== null
  );
  const snapshot = (): RegistrationDraft => ({
    kind: "registration",
    version: 1,
    step,
    form,
    proposal,
    proposalFingerprint,
    proposalState: pstate,
    agentId,
    vendorId,
    checkpoint: checkpoint.current,
    attempt: attempt.current,
  });
  const draft = useIntakeDraft<RegistrationDraft>({ scope: "new", enabled: auth?.via === "session", snapshot: dirty ? snapshot() : null });

  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stageHeading.current?.focus();
    // a step change is a natural checkpoint: save now rather than in a second
    void draft.flush();
    if (step === REVIEW) setReturnTo(null);
  }, [step]);

  const resumeDraft = () => {
    const record = draft.resume();
    const saved = record ? readRegistrationDraft(record.state) : null;
    if (!saved) {
      void draft.startFresh();
      return;
    }
    setForm(saved.form);
    setProposal(saved.proposal);
    setProposalFingerprint(saved.proposalFingerprint);
    setPstate(saved.proposalState);
    setAgentId(saved.agentId);
    setVendorId(saved.vendorId);
    checkpoint.current = saved.checkpoint;
    attempt.current = saved.attempt;
    setStep(Math.max(0, Math.min(saved.proposal ? REVIEW : CLASSIFY, saved.step)));
  };

  const submitting = submitAction.busy;
  const leave = useLeaveGuard({
    when: dirty || submitting,
    unloadWhen: submitting || (dirty && draft.unsaved),
    title: submitting ? "Your submission is still being sent" : "Leave this registration?",
    body: submitting ? (
      <p>If you leave now, open Register AI use case again and submit from your draft: it remembers this submission, so finishing it will not create a second use case.</p>
    ) : draftKept(draft.status) && !draft.unsaved ? (
      <p>Your answers are saved as a draft. Open Register AI use case again to pick up where you left off.</p>
    ) : draftKept(draft.status) ? (
      <p>Your latest changes are being saved. Leaving saves them first; open Register AI use case again to pick up where you left off.</p>
    ) : (
      <p>Your answers are not saved anywhere else and will be lost if you leave now.</p>
    ),
    beforeLeave: () => (draftKept(draft.status) ? draft.flush() : undefined),
  });

  // ---- the stack and the assistant ------------------------------------------
  const agents = useAgents();
  const vendors = useQuery({
    queryKey: ["admin", "vendors"],
    queryFn: () => api.get<{ vendors: VendorSummary[] }>("/v1/vendors"),
  });
  const policy = useQuery({
    queryKey: REVIEW_POLICY_KEY,
    queryFn: () => api.get<ReviewPolicy>("/v1/governance/review-policy"),
    enabled: step === REVIEW,
    retry: false,
  });
  const fingerprint = classificationFingerprint(form);
  const assist = useMutation({
    mutationFn: async (fp: string) => ({
      fp,
      data: await api.post<IntakeAssistResponse>("/v1/use-cases/intake/assist", {
        title: form.title.trim(),
        description: form.description.trim(),
        euAiAct: euAiActAnswers(form),
        context: contextAnswers(form),
        draftNarrative: true,
        ...(agentId ? { agentId } : {}),
      }),
    }),
    onSuccess: ({ fp, data }) => {
      if (!proposal) {
        // frameworks and risks start UNDECIDED — the proposer accepts, edits or
        // rejects each (ADR-0149); questionnaire drafts are included and edited
        // answer by answer on the next step
        setProposal(data);
        setProposalFingerprint(fp);
        setPstate(initialProposalState(data));
        setStep(SUGGESTIONS);
        return;
      }
      // AER-051: answers changed after a proposal was worked on. Nothing the
      // proposer wrote or decided is replaced without their explicit choice.
      const diff = diffProposals(proposal, data, pstate);
      if (diffIsEmpty(diff)) {
        adopt("keep", data, fp);
        return;
      }
      setRedraft({ proposal: data, fingerprint: fp, diff });
    },
  });
  const adopt = (mode: "regenerate" | "keep", next: IntakeAssistResponse, fp: string) => {
    if (!proposal) return;
    const applied = applyProposal(mode, proposal, next, pstate);
    setProposal(applied.proposal);
    setPstate(applied.state);
    setProposalFingerprint(fp);
    setRedraft(null);
    setStep(SUGGESTIONS);
  };
  // a pending re-draft belongs to the answers it was drafted from
  useEffect(() => {
    if (redraft && redraft.fingerprint !== fingerprint) setRedraft(null);
  }, [redraft, fingerprint]);

  const { decisions, suggestionEdits, questionnaire } = pstate;
  const setDecision = (key: string, value: Decision) => setPstate((p) => ({ ...p, decisions: { ...p.decisions, [key]: value } }));
  const setEdit = (key: string, value: string) => setPstate((p) => ({ ...p, suggestionEdits: { ...p.suggestionEdits, [key]: value } }));
  const setAnswerText = (id: string, value: string) => setPstate((p) => ({ ...p, questionnaire: { ...p.questionnaire, [id]: value } }));

  const acceptedFrameworks = proposal?.frameworks.filter((item) => decisions[frameworkKey(item)] !== "rejected") ?? [];
  const acceptedRisks = proposal?.risks.filter((item) => decisions[riskKey(item)] !== "rejected") ?? [];
  const acceptedQuestions = proposal?.questionnaire.filter((item) => decisions[questionKey(item)] !== "rejected") ?? [];
  const sourceSummary = useMemo(() => {
    if (!proposal) return [];
    return [...new Set([
      ...proposal.frameworks.map((item) => item.source),
      ...proposal.risks.map((item) => item.source),
      ...proposal.questionnaire.map((item) => item.source),
      proposal.narrative.source,
    ].filter(Boolean))] as Source[];
  }, [proposal]);

  const missing = missingAnswers(form);
  const intakeAnswersComplete = missing.length === 0;
  // ADR-0149: a suggestion is the proposer's to accept, edit or reject — none
  // counts as accepted until someone decides it ("Accept all remaining" is
  // that decision, made deliberately for the rest)
  const suggestionKeys = proposal ? [...proposal.frameworks.map(frameworkKey), ...proposal.risks.map(riskKey)] : [];
  const undecidedSuggestions = suggestionKeys.filter((key) => !decisions[key]);
  const acceptAllRemaining = () =>
    setPstate((p) => ({ ...p, decisions: { ...p.decisions, ...Object.fromEntries(undecidedSuggestions.map((key) => [key, "accepted" as Decision])) } }));
  const describeComplete = Boolean(form.title.trim() && form.description.trim());
  // the proposal on screen was drafted from the answers on screen
  const proposalCurrent = Boolean(proposal) && proposalFingerprint === fingerprint;
  const canContinue =
    step === DESCRIBE
      ? describeComplete
      : step === CLASSIFY
        ? describeComplete && intakeAnswersComplete
        : step === SUGGESTIONS
          ? Boolean(proposal) && undecidedSuggestions.length === 0
          : Boolean(proposal);
  const canReturnToReview = describeComplete && intakeAnswersComplete && proposalCurrent && undecidedSuggestions.length === 0;

  /** the edited "why it applies" texts that differ from the suggestion: saved with the use case (AER-052) */
  const frameworkRationales = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const item of acceptedFrameworks) {
      const edit = suggestionEdits[frameworkKey(item)]?.trim();
      if (edit && edit !== frameworkWhy(item)) out[item.framework] = edit.slice(0, FRAMEWORK_RATIONALE_MAX);
    }
    return out;
  };

  /** the EU AI Act block the questionnaire carries, with the answers the proposer was not sure about */
  const screeningBlock = () => (proposal ? withUnsure(proposal.euAiActBlock, euUnsureKeys(form)) : "");

  const questionnaireMarkdown = () => {
    if (!proposal) return "";
    const sections = acceptedQuestions.map((item) => {
      const edited = questionnaire[item.id] ?? item.text;
      return `## ${item.heading}\n\n${edited.trim()}`;
    });
    return [...sections, `## 9. EU AI Act risk screening\n\n${screeningBlock().trim()}`].join("\n\n");
  };

  /** exactly what each step sends, read once per attempt so every request of it sees the same inputs */
  const submissionInputs = (): SubmissionInputs => {
    const rationales = frameworkRationales();
    return {
      useCase: {
        name: form.title.trim(),
        description: form.description.trim(),
        businessContext: form.businessContext.trim() || form.description.trim(),
        dataSensitivity: deriveDataSensitivity(form.dataCategories),
        complianceTags: acceptedFrameworks.map((item) => item.framework),
        intendedAgentIds: agentId ? [agentId] : [],
        // every Classify answer, stored with the use case so a send-back can be
        // resubmitted prefilled (the tier is still screened from the questionnaire)
        screeningAnswers: { ...euAiActAnswers(form), ...contextAnswers(form) },
        ...(Object.keys(rationales).length > 0 ? { frameworkRationales: rationales } : {}),
      },
      questionnaire: questionnaireMarkdown(),
      risks: acceptedRisks.map((risk) => ({
        key: risk.scenarioKey,
        inputs: {
          title: risk.title,
          description: suggestionEdits[riskKey(risk)] ?? risk.description,
          category: risk.category,
          likelihood: risk.likelihood,
          impact: risk.impact,
          ...(agentId ? { agentId } : {}),
          ...(vendorId ? { vendorId } : {}),
        },
        controls: risk.suggestedControls,
      })),
    };
  };

  /** keep the draft in step with the submission's progress (kept in refs, so outside a render) */
  const saveProgress = () => {
    setProgress((n) => n + 1);
    if (draftKept(draft.status)) return draft.flush(snapshot());
    return Promise.resolve();
  };

  const submit = async () => {
    if (!proposal) return;
    setRetryRefused(null);
    const progress = checkpoint.current;
    const inputs = submissionInputs();
    // AER-046: decide every step BEFORE the first request — a retry whose
    // edits the written records cannot take is refused with nothing sent
    let plan = planSubmission(progress, inputs);
    const refuse = (p: Extract<typeof plan, { kind: "refuse" }>) => {
      const refused = new RetryRefused(p.useCaseId, p.reasons);
      setRetryRefused(refused);
      return refused;
    };
    if (plan.kind === "refuse") throw refuse(plan);

    if (plan.useCase.action === "create") {
      // AER-050: the attempt (its key and exactly what it sends) is in the draft
      // BEFORE the request, so a retry after a lost response — from this page
      // or after a reload — sends the same key and gets the same use case back
      if (!attempt.current) attempt.current = { key: newIdempotencyKey(), useCase: inputs.useCase };
      const sent = attempt.current;
      await saveProgress();
      let created: CreatedUseCase;
      try {
        created = (await api.postWithHeaders<CreatedUseCase>("/v1/use-cases", sent.useCase, { "Idempotency-Key": sent.key })).body;
      } catch (error) {
        // a refusal created nothing: the next attempt starts with a new key
        if (!outcomeUnknown(error)) {
          attempt.current = null;
          void saveProgress();
        }
        throw error;
      }
      progress.useCase = { id: created.id, instanceId: created.instance?.id, inputs: sent.useCase, digest: canonicalDigest(sent.useCase) };
      attempt.current = null;
      void saveProgress();
      // the record holds what the attempt sent; an edit made since (after a
      // lost response) is brought up to date — or refused — like any retry
      plan = planSubmission(progress, inputs);
      if (plan.kind === "refuse") throw refuse(plan);
    }
    if (plan.useCase.action === "update") {
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
      void saveProgress();
    }

    for (const { key, step: riskStep, controlsToLink } of plan.risks) {
      const risk = inputs.risks.find((item) => item.key === key)!;
      if (riskStep.action === "create") {
        const created = await api.post<CreatedRisk>("/v1/risks", { ...risk.inputs, useCaseId: useCase.id });
        progress.risks[key] = { id: created.id, inputs: risk.inputs, digest: canonicalDigest(risk.inputs), linkedControls: [] };
        void saveProgress();
      } else if (riskStep.action === "update") {
        await api.patch(`/v1/risks/${progress.risks[key]!.id}`, riskStep.patch);
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
    // submitted: the draft has done its job (deleted once every save has landed)
    void draft.discard();
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
    attempt.current = null;
    void saveProgress();
    setRetryRefused(null);
    submitAction.setError(null);
  };

  const goTo = (next: number) => setStep(Math.max(0, Math.min(REVIEW, next)));
  const editSection = (target: number) => {
    setReturnTo(REVIEW);
    goTo(target);
  };
  const onDraftSuggestions = () => {
    if (!canContinue || assist.isPending) return;
    // AER-051: unchanged answers keep the proposal and every edit and decision
    if (proposal && proposalFingerprint === fingerprint) {
      setRedraft(null);
      goTo(SUGGESTIONS);
      return;
    }
    assist.mutate(fingerprint);
  };
  const prohibitedAlert = proposal?.blocking ? (
    <div className={v.errLine} role="alert">
      <strong>Screened PROHIBITED (Art. 5) — a reviewer must refuse it at sign-off; it cannot go live.</strong>{" "}
      {typeof proposal.blocking === "string" ? proposal.blocking : proposal.blocking.reason ?? "See the rule reasons."}
    </div>
  ) : null;

  // the step's one primary action, top right beside Cancel (and Back)
  const primary =
    step === DESCRIBE ? (
      <Button variant="primary" type="submit" form="intake-describe" disabled={!canContinue}>Continue</Button>
    ) : step === CLASSIFY ? (
      <Button variant="primary" type="submit" form="intake-classify" disabled={!canContinue || assist.isPending || redraft !== null}>
        {assist.isPending ? "Drafting…" : "Draft suggestions"}
      </Button>
    ) : step < REVIEW ? (
      <Button variant="primary" disabled={!canContinue} onClick={() => goTo(step + 1)}>Continue</Button>
    ) : submittedUseCaseId ? null : (
      <Button variant="primary" disabled={submitting} onClick={() => void submitAction.run(submit, "Use case submitted for human review")}>
        {submitting ? "Submitting…" : "Submit for human review"}
      </Button>
    );
  const pendingSubmission = !submittedUseCaseId && (Boolean(checkpoint.current.useCase) || attempt.current !== null);

  return (
    <>
      <PageHeader
        title="Register AI use case"
        sub="Describe it, classify it, check the suggestions, then send it for review."
        info={<p>The assistant is suggestion-only. You accept or reject every suggestion, and your answers are kept as a private draft that only you can open until you submit.</p>}
        actions={
          <div className={rg.headerActions}>
            {submittedUseCaseId ? (
              <Link to={REGISTRY} className={`${k.btn} ${rg.linkBtn}`}>Back to the registry</Link>
            ) : submitting ? (
              <Button variant="ghost" disabled>Cancel</Button>
            ) : (
              <Link to={REGISTRY} className={`${k.btnGhost} ${rg.linkBtn}`}>Cancel</Link>
            )}
            {step > DESCRIBE && !submittedUseCaseId && <Button disabled={submitting} onClick={() => goTo(step - 1)}>Back</Button>}
            {returnTo !== null && step !== REVIEW && !submittedUseCaseId ? (
              <Button disabled={!canReturnToReview} onClick={() => goTo(REVIEW)}>Return to review</Button>
            ) : null}
            {primary}
          </div>
        }
      />
      {leave.dialog}
      <div className={rg.layout}>
        <div className={rg.main}>
          {draft.status.kind === "offer" ? (
            <div className={ix.resume}>
              <p>
                You have a saved draft{draftName(draft.status.draft.state)} from {savedAtText(draft.status.draft.updatedAt)}.
                {dirty ? " Until you choose, changes on this page are not saved." : ""}
              </p>
              <div className={ix.resumeActions}>
                <Button size="sm" variant="primary" onClick={resumeDraft}>Resume your draft</Button>
                <Button size="sm" onClick={() => void draft.startFresh()}>Start fresh</Button>
              </div>
            </div>
          ) : null}
          <ol className={rg.stepper} aria-label="Intake progress">
            {STEPS.map((label, index) => (
              <li key={label} className={`${rg.step} ${index === step ? rg.stepActive : index < step ? rg.stepDone : ""}`} aria-current={index === step ? "step" : undefined}>
                <span className={rg.stepNumber} aria-hidden>{index < step ? "✓" : index + 1}</span>
                <span className={rg.stepLabel}>{label}</span>
              </li>
            ))}
          </ol>
          <DraftLine status={draft.status} dirty={dirty} unsaved={draft.unsaved} />

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
                    <Button size="sm" variant="ghost" onClick={() => setForm(exampleForm())}>Fill in an example</Button>
                  </div>
                )}
                <HintField label="Use-case name" hint="A name reviewers will recognize, such as “Credit-limit-increase assistant”.">
                  <Input value={form.title} onChange={(event) => setField("title", event.target.value)} required />
                </HintField>
                <HintField label="What will the system do?" hint="The task, who it affects, and what the AI produces or changes.">
                  <Textarea rows={4} value={form.description} onChange={(event) => setField("description", event.target.value)} required />
                </HintField>
                <HintField label="Business context" optional hint="Why the business wants it and the outcome it should improve. Leave blank to reuse the purpose.">
                  <Textarea rows={3} value={form.businessContext} onChange={(event) => setField("businessContext", event.target.value)} />
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
              <form id="intake-classify" className={rg.form} onSubmit={(event) => { event.preventDefault(); if (!redraft) onDraftSuggestions(); }}>
                <p className={v.dim}>These answers set the EU AI Act risk tier and the suggestions. Blank does not mean “no”. If you are not sure, choose “Not sure”: it counts as yes until a reviewer confirms it.</p>
                <section className={rg.group} aria-labelledby="classify-purpose">
                  <h3 id="classify-purpose" className={rg.groupTitle}>Purpose and people</h3>
                  <div className={rg.grid2}>
                    <HintField label="Primary purpose domain" id={questionId("classify", "purposeDomain")} hint="The area the output is used in.">
                      <Select value={form.purposeDomain} onChange={(event) => setField("purposeDomain", event.target.value)} required>
                        {optionList("Choose a purpose domain", PURPOSE_DOMAIN_OPTIONS)}
                      </Select>
                    </HintField>
                    <HintField label="People affected" id={questionId("classify", "affectedPerson")} hint="Whose decisions or data it touches.">
                      <Select value={form.affectedPerson} onChange={(event) => setField("affectedPerson", event.target.value)} required>
                        {optionList("Choose who is affected", AFFECTED_PERSON_OPTIONS)}
                      </Select>
                    </HintField>
                    <HintField label="Decision autonomy" id={questionId("classify", "decisionAutonomy")} hint="How much a person decides before anything happens.">
                      <Select value={form.decisionAutonomy} onChange={(event) => setField("decisionAutonomy", event.target.value)} required>
                        {optionList("Choose decision autonomy", DECISION_AUTONOMY_OPTIONS)}
                      </Select>
                    </HintField>
                    <HintField label="Deployment audience" id={questionId("classify", "deployment")} hint="Who uses it directly.">
                      <Select value={form.deployment} onChange={(event) => setField("deployment", event.target.value)} required>
                        {optionList("Choose deployment audience", DEPLOYMENT_OPTIONS)}
                      </Select>
                    </HintField>
                    <HintField label="Biometric use" id={questionId("classify", "biometricUse")} hint="Whether it recognises or checks people by their face, voice, fingerprint or other body features.">
                      <Select value={form.biometricUse} onChange={(event) => setField("biometricUse", event.target.value)} required>
                        {optionList("Choose biometric use", BIOMETRIC_OPTIONS)}
                      </Select>
                    </HintField>
                  </div>
                </section>
                <section className={rg.group} aria-labelledby="classify-data">
                  <h3 id="classify-data" className={rg.groupTitle}>Data and sector</h3>
                  <p className={rg.groupHint}>The strictest data category sets the data sensitivity.</p>
                  <div className={rg.grid2}>
                    <MultiAnswerField label="Data categories" id={questionId("classify", "dataCategories")} values={form.dataCategories} options={DATA_CATEGORY_OPTIONS} onChange={(values) => setField("dataCategories", values)} />
                    <MultiAnswerField label="Sectors" id={questionId("classify", "sectors")} values={form.sectors} options={SECTOR_OPTIONS} onChange={(values) => setField("sectors", values)} />
                  </div>
                </section>
                <section className={rg.group} aria-labelledby="classify-practices">
                  <h3 id="classify-practices" className={rg.groupTitle}>What it does in practice</h3>
                  <div className={rg.grid3}>
                    {CLASSIFY_GROUPS[2]!.questions.map(({ key, label }) => (
                      <BooleanAnswerField
                        key={key}
                        id={questionId("classify", key)}
                        label={label}
                        help={SCREENING_HELP[key]}
                        value={form.answers[key as BooleanQuestion]}
                        onChange={(value) => setAnswer(key as BooleanQuestion, value)}
                      />
                    ))}
                  </div>
                </section>
                <MissingAnswers missing={missing} idPrefix="classify" action="draft suggestions" />
                {assist.isError && <p className={v.errLine} role="alert">{(assist.error as Error).message}</p>}
              </form>
              {redraft && proposal ? (
                <RedraftChoice diff={redraft.diff} onRegenerate={() => adopt("regenerate", redraft.proposal, redraft.fingerprint)} onKeep={() => adopt("keep", redraft.proposal, redraft.fingerprint)} />
              ) : null}
            </Card>
          )}

          {step === SUGGESTIONS && proposal && (
            <Card title={<StageHeading headingRef={stageHeading}>Review suggestions</StageHeading>}>
              <div className={v.stack}>
                <div className={s.callout}>
                  Proposed tier: <strong>{proposal.tier.value} risk</strong>. {proposal.tier.disclaimer}
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
                {proposal.frameworks.map((item) => (
                  <Suggestion key={item.framework} title={item.title} body={suggestionEdits[frameworkKey(item)] ?? frameworkWhy(item)} source={item.source} kept={item.kept} decision={decisions[frameworkKey(item)]} onDecision={(value) => setDecision(frameworkKey(item), value)} onEdit={(value) => setEdit(frameworkKey(item), value)} maxLength={FRAMEWORK_RATIONALE_MAX} hint="Why it applies, in your words. An edited explanation is saved with the use case and shown to its reviewers." />
                ))}
                <h3 className={v.sectionTitle}>Risk scenarios</h3>
                {proposal.risks.map((item) => (
                  <Suggestion key={item.scenarioKey} title={item.title} body={suggestionEdits[riskKey(item)] ?? `${item.description} Suggested because ${item.why.replace(/\.$/, "")}.`} source={item.source} kept={item.kept} decision={decisions[riskKey(item)]} onDecision={(value) => setDecision(riskKey(item), value)} onEdit={(value) => setEdit(riskKey(item), value)} meta={`${humanize(item.dimension)} · ${item.likelihood} likelihood · ${item.impact} impact`} hint="Accepted, this text becomes the description of a risk on the use case." />
                ))}
                <p className={v.faint}>{proposal.disclaimer}</p>
              </div>
            </Card>
          )}

          {step === QUESTIONNAIRE && proposal && (
            <Card title={<StageHeading headingRef={stageHeading}>Edit the questionnaire</StageHeading>}>
              <div className={v.stack}>
                <p className={v.dim}>The reviewer reads these answers. Replace draft wording with how the system really works.</p>
                {proposal.questionnaire.map((item) => {
                  const rejected = decisions[questionKey(item)] === "rejected";
                  return (
                    <section key={item.id} className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
                      <div className={s.suggestionHeader}><strong>{item.heading}</strong><span className={rg.sourceLabel}>{item.kept ? "Kept from your earlier answers" : SOURCE_LABEL[item.source]}</span><Badge tone={rejected ? "neutral" : "ok"}>{rejected ? "rejected" : "accepted"}</Badge></div>
                      {!rejected && (
                        <HintField label={`${item.heading} answer`} visuallyHiddenLabel>
                          <Textarea rows={4} value={questionnaire[item.id] ?? item.text} onChange={(event) => setAnswerText(item.id, event.target.value)} />
                        </HintField>
                      )}
                      <div className={s.suggestionActions}>
                        <Button size="sm" variant={rejected ? "default" : "primary"} aria-pressed={!rejected} onClick={() => setDecision(questionKey(item), "accepted")}>Accept</Button>
                        <Button size="sm" variant={rejected ? "danger" : "ghost"} aria-pressed={rejected} onClick={() => setDecision(questionKey(item), "rejected")}>Reject</Button>
                      </div>
                    </section>
                  );
                })}
                <HintField label="9. EU AI Act risk screening" hint="Generated from your Classify answers so a reviewer can reproduce the tier. Read-only.">
                  <Textarea rows={8} value={screeningBlock()} readOnly />
                </HintField>
              </div>
            </Card>
          )}

          {step === STACK && (
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

          {step === REVIEW && proposal && (
            <Card title={<StageHeading headingRef={stageHeading}>Review and submit</StageHeading>}>
              <div className={v.stack}>
                <div className={v.grid3}>
                  <Summary value={humanize(proposal.tier.value)} label="Proposed tier" />
                  <Summary value={acceptedFrameworks.length} label="Accepted frameworks" />
                  <Summary value={acceptedRisks.length} label="Accepted risks" />
                </div>
                <div className={v.listRow}><strong>Owner</strong><span className={v.grow}>{ownerName}</span></div>
                <div className={v.listRow}><strong>Data sensitivity</strong><span className={v.grow}><Badge tone="info">{humanize(deriveDataSensitivity(form.dataCategories))}</Badge> <span className={v.faint}>from the data categories — the strictest wins</span></span></div>
                <div className={v.listRow}><strong>Suggested by</strong><span className={`${v.grow} ${v.row}`}>{sourceSummary.map((source) => <span key={source} className={rg.sourceLabel}>{SOURCE_LABEL[source]}</span>)}</span></div>
                <ProposalReview
                  form={form}
                  proposal={proposal}
                  pstate={pstate}
                  screeningBlock={screeningBlock()}
                  agentLabel={agentId ? labelOf(agents.data?.agents ?? [], agentId, (a) => `${a.name} · ${a.provider}/${a.model ?? "default"}`) : null}
                  vendorLabel={vendorId ? labelOf(vendors.data?.vendors ?? [], vendorId, (x) => `${x.name} · ${x.status}`) : null}
                  reviewers={reviewRoute(policy.data, proposal.tier.value)}
                  submitted={Boolean(submittedUseCaseId)}
                  onEdit={editSection}
                />
                {prohibitedAlert}
                {!submittedUseCaseId && (
                  <div className={s.callout}>
                    {pendingSubmission ? "A submission from these answers has already started. " : ""}
                    Submitting creates the use case with its risks and controls and sends it for review.{" "}
                    {draftKept(draft.status)
                      ? "Your answers are kept as a draft until it is sent: if a step fails or the page closes, submitting again from this page (or after reopening it) finishes the same use case instead of creating another."
                      : "If a step fails, submitting again from this page continues where it stopped. Keep this page open until it is sent: your answers are not saved anywhere else."}
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
                ) : submitAction.error ? (
                  <p className={v.errLine} role="alert">
                    {submitAction.error} What was already sent is kept{draftKept(draft.status) ? " with your draft" : " while this page stays open"}; retry to resume.
                  </p>
                ) : null}
                {submittedUseCaseId ? (
                  <div className={s.callout} role="status">
                    Submitted for human review. <Link to={`/admin/governance/use-cases/${submittedUseCaseId}`}>Open the use-case workspace</Link>.
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </div>
        <SimilarUseCases name={form.title} description={form.description} excludeIds={[submittedUseCaseId, checkpoint.current.useCase?.id].filter((id): id is string => Boolean(id))} />
      </div>
    </>
  );
}

/** the draft is being kept on the server (or will be once the person chooses at the resume offer) */
const draftKept = (status: DraftStatus) => status.kind !== "off" && status.kind !== "error" && status.kind !== "done";

/** " of “Name”" for the resume offer, when the saved draft has a name */
const draftName = (state: unknown) => {
  const name = readRegistrationDraft(state)?.form.title.trim();
  return name ? ` of “${name}”` : "";
};

/** what the person needs to know about their draft, in one quiet line */
function DraftLine(props: { status: DraftStatus; dirty: boolean; unsaved: boolean }) {
  const { status } = props;
  if (!props.dirty || status.kind === "done" || status.kind === "loading" || status.kind === "offer") return null;
  const text =
    status.kind === "off"
      ? status.reason === "not-signed-in"
        ? "Drafts are kept only for signed-in people: your answers stay on this page until you submit."
        : "Your draft can't be saved right now: your answers stay on this page until you submit."
      : status.kind === "error"
        ? status.tooLarge
          ? "This draft is too large to save: your answers stay on this page until you submit."
          : "Your latest changes could not be saved as a draft yet; they stay on this page and saving is retried."
        : status.kind === "saved" && !props.unsaved
          ? `Draft saved ${savedAtText(status.at)}. Only you can open it.`
          : "Saving your draft…";
  return <p className={ix.draftLine}>{text}</p>;
}

/** AER-051: what a re-draft from changed answers would change, and the proposer's choice */
function RedraftChoice(props: { diff: ProposalDiff; onRegenerate: () => void; onKeep: () => void }) {
  const { diff } = props;
  const names = (items: Array<{ title: string }>) => items.map((i) => i.title).join(", ");
  const lines: string[] = [];
  if (diff.tier) lines.push(`Risk tier: ${humanize(diff.tier.from)} becomes ${humanize(diff.tier.to)}.`);
  if (diff.frameworks.added.length) lines.push(`Frameworks: adds ${names(diff.frameworks.added)}.`);
  if (diff.frameworks.removed.length) lines.push(`Frameworks: no longer suggests ${names(diff.frameworks.removed)}.`);
  if (diff.risks.added.length) lines.push(`Risk scenarios: adds ${names(diff.risks.added)}.`);
  if (diff.risks.removed.length) lines.push(`Risk scenarios: no longer suggests ${names(diff.risks.removed)}.`);
  if (diff.questionnaire.changed.length) {
    lines.push(`Questionnaire: a new draft for ${diff.questionnaire.changed.map(({ item, edited }) => `${item.heading}${edited ? " (you edited it)" : ""}`).join(", ")}.`);
  }
  if (diff.questionnaire.added.length) lines.push(`Questionnaire: adds ${diff.questionnaire.added.map((q) => q.heading).join(", ")}.`);
  if (diff.questionnaire.removed.length) lines.push(`Questionnaire: no longer drafts ${diff.questionnaire.removed.map((q) => q.heading).join(", ")}.`);
  return (
    <section className={ix.redraft} aria-labelledby="redraft-title">
      <h3 id="redraft-title">Your answers changed since the suggestions were drafted</h3>
      <p>These sections are affected:</p>
      <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
      {diff.touchedRemovals.length ? (
        <p>Regenerating removes suggestions you already decided on or edited: {diff.touchedRemovals.join(", ")}.</p>
      ) : null}
      <p>
        Regenerating replaces only the affected sections; everything else keeps your edits and decisions.
        Keeping your edits leaves every section as you have it and adds any new suggestions for you to decide.
        Either way the risk tier and the EU AI Act screening section follow your new answers.
      </p>
      <div className={ix.redraftActions}>
        <Button variant="primary" onClick={props.onRegenerate}>Regenerate affected sections</Button>
        <Button onClick={props.onKeep}>Keep my edits</Button>
      </div>
    </section>
  );
}

/** "One review from each role: Privacy, Security" — or the single named approver when no policy applies */
function reviewRoute(policy: ReviewPolicy | undefined, tier: string): string {
  const roleIds = policy?.tiers?.[tier as ReviewTier]?.roleIds ?? [];
  const names = roleIds.map((id) => policy?.roles?.find((role) => role.id === id)?.name ?? humanize(id));
  return names.length > 0
    ? `One review from each of these reviewer roles: ${names.join(", ")}. Any member of a role can review for it.`
    : "The governance approver who signs off AI use cases. You can't review your own use case.";
}

const labelOf = <T extends { id: string }>(items: T[], id: string, label: (item: T) => string) => {
  const item = items.find((i) => i.id === id);
  return item ? label(item) : "Selected";
};

/**
 * AER-054: the final review shows the proposal itself — accepted framework and
 * risk text, the questionnaire (what is in and what is left out), the linked
 * stack, who receives it and where to follow it — and each part can be edited
 * and returned to.
 */
function ProposalReview(props: {
  form: RegistrationForm;
  proposal: IntakeAssistResponse;
  pstate: ProposalState;
  screeningBlock: string;
  agentLabel: string | null;
  vendorLabel: string | null;
  reviewers: string;
  submitted: boolean;
  onEdit: (step: number) => void;
}) {
  const { form, proposal, pstate } = props;
  const decided = (key: string) => pstate.decisions[key] !== "rejected";
  const frameworks = proposal.frameworks;
  const risks = proposal.risks;
  const sections = proposal.questionnaire;
  const unsure = unsureKeys(form);
  const edit = (label: string, target: number) => props.submitted ? null : (
    <div className={ix.sectionActions}>
      <Button size="sm" variant="ghost" aria-label={`Edit this section: ${label}`} onClick={() => props.onEdit(target)}>Edit this section</Button>
    </div>
  );
  const optionLabel = (options: ReadonlyArray<readonly [string, string]>, value: string) => options.find(([v]) => v === value)?.[1] ?? humanize(value);
  const answerText = (key: BooleanQuestion) => ({ yes: "Yes", no: "No", unsure: "Not sure (counted as yes)", "": "Not answered" })[form.answers[key]];
  return (
    <div className={ix.proposal} aria-label="Your proposal" role="group">
      <details className={ix.section} open>
        <summary>Name and purpose</summary>
        <div className={ix.sectionBody}>
          <p><span className={ix.itemTitle}>Name:</span> {form.title}</p>
          <p><span className={ix.itemTitle}>Purpose:</span> {form.description}</p>
          <p><span className={ix.itemTitle}>Business context:</span> {form.businessContext.trim() || <span className={ix.excluded}>Same as the purpose</span>}</p>
          {edit("Name and purpose", DESCRIBE)}
        </div>
      </details>
      <details className={ix.section} open>
        <summary>Classification <span className={ix.count}>· {humanize(proposal.tier.value)} tier{unsure.length ? ` · ${plural(unsure.length, "answer")} not sure` : ""}</span></summary>
        <div className={ix.sectionBody}>
          <dl className={ix.answers}>
            <dt>Primary purpose domain</dt><dd>{optionLabel(PURPOSE_DOMAIN_OPTIONS, form.purposeDomain)}</dd>
            <dt>People affected</dt><dd>{optionLabel(AFFECTED_PERSON_OPTIONS, form.affectedPerson)}</dd>
            <dt>Decision autonomy</dt><dd>{optionLabel(DECISION_AUTONOMY_OPTIONS, form.decisionAutonomy)}</dd>
            <dt>Deployment audience</dt><dd>{optionLabel(DEPLOYMENT_OPTIONS, form.deployment)}</dd>
            <dt>Biometric use</dt><dd>{optionLabel(BIOMETRIC_OPTIONS, form.biometricUse)}</dd>
            <dt>Data categories</dt><dd>{form.dataCategories.map(humanize).join(", ")}</dd>
            <dt>Sectors</dt><dd>{form.sectors.map(humanize).join(", ")}</dd>
            {BOOLEAN_QUESTIONS.map((key) => <Answer key={key} label={questionLabel(key)} value={answerText(key)} />)}
          </dl>
          {unsure.length ? <p>Your reviewers will see that you were not sure about: {unsure.map(questionLabel).join(", ")}.</p> : null}
          {edit("Classification", CLASSIFY)}
        </div>
      </details>
      <details className={ix.section} open>
        <summary>Frameworks <span className={ix.count}>· {frameworks.filter((f) => decided(frameworkKey(f))).length} accepted, {frameworks.filter((f) => !decided(frameworkKey(f))).length} rejected</span></summary>
        <div className={ix.sectionBody}>
          {frameworks.length === 0 ? <p className={ix.excluded}>No frameworks were suggested.</p> : (
            <ul>
              {frameworks.map((item) => (
                <li key={item.framework}>
                  <span className={ix.itemTitle}>{item.title}</span>{decided(frameworkKey(item)) ? "" : <span className={ix.excluded}> — rejected, not included</span>}
                  {decided(frameworkKey(item)) ? <span className={ix.itemText}>{pstate.suggestionEdits[frameworkKey(item)] ?? frameworkWhy(item)}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {edit("Frameworks", SUGGESTIONS)}
        </div>
      </details>
      <details className={ix.section} open>
        <summary>Risks <span className={ix.count}>· {risks.filter((r) => decided(riskKey(r))).length} accepted, {risks.filter((r) => !decided(riskKey(r))).length} rejected</span></summary>
        <div className={ix.sectionBody}>
          {risks.length === 0 ? <p className={ix.excluded}>No risk scenarios were suggested.</p> : (
            <ul>
              {risks.map((item) => (
                <li key={item.scenarioKey}>
                  <span className={ix.itemTitle}>{item.title}</span>{decided(riskKey(item)) ? ` · ${item.likelihood} likelihood, ${item.impact} impact` : <span className={ix.excluded}> — rejected, not included</span>}
                  {decided(riskKey(item)) ? <span className={ix.itemText}>{pstate.suggestionEdits[riskKey(item)] ?? item.description}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {edit("Risks", SUGGESTIONS)}
        </div>
      </details>
      <details className={ix.section}>
        <summary>Questionnaire <span className={ix.count}>· {plural(sections.filter((q) => decided(questionKey(q))).length, "section")} included, {sections.filter((q) => !decided(questionKey(q))).length} left out, plus the EU AI Act answers</span></summary>
        <div className={ix.sectionBody}>
          <ul>
            {sections.map((item) => (
              <li key={item.id}>
                <span className={ix.itemTitle}>{item.heading}</span>
                {decided(questionKey(item))
                  ? <span className={ix.itemText}>{(pstate.questionnaire[item.id] ?? item.text).trim()}</span>
                  : <span className={ix.excluded}> — rejected, not included</span>}
              </li>
            ))}
            <li><span className={ix.itemTitle}>9. EU AI Act risk screening</span><span className={ix.itemText}>Generated from your classification answers.</span></li>
          </ul>
          {edit("Questionnaire", QUESTIONNAIRE)}
        </div>
      </details>
      <details className={ix.section} open>
        <summary>Linked stack</summary>
        <div className={ix.sectionBody}>
          <p><span className={ix.itemTitle}>Model / agent:</span> {props.agentLabel ?? <span className={ix.excluded}>None yet. You or an administrator can link one later.</span>}</p>
          <p><span className={ix.itemTitle}>Vendor:</span> {props.vendorLabel ?? <span className={ix.excluded}>None yet. You can link one later.</span>}</p>
          {edit("Linked stack", STACK)}
        </div>
      </details>
      <details className={ix.section} open>
        <summary>Who receives this</summary>
        <div className={ix.sectionBody}>
          <p>{props.reviewers}</p>
          <p>
            You stay the owner. It shows as under review until every review is decided; reviewers can approve it, approve it with conditions, send it back with questions or reject it.{" "}
            <Link to="/admin/use-cases">Follow it in the AI registry</Link>.
          </p>
        </div>
      </details>
    </div>
  );
}

function Answer(props: { label: string; value: string }) {
  return <><dt>{props.label}</dt><dd>{props.value}</dd></>;
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

function Suggestion(props: { title: string; body: string; source: Source; kept?: boolean | undefined; decision?: Decision | undefined; onDecision: (value: Decision) => void; onEdit: (value: string) => void; meta?: string; hint: string; maxLength?: number }) {
  const [editing, setEditing] = useState(false);
  const rejected = props.decision === "rejected";
  const accepted = props.decision === "accepted";
  return (
    <section className={`${s.suggestion} ${rejected ? s.suggestionRejected : ""}`}>
      <div className={s.suggestionHeader}><strong>{props.title}</strong><span className={rg.sourceLabel}>{props.kept ? "No longer suggested by your answers" : SOURCE_LABEL[props.source]}</span><Badge tone={rejected ? "neutral" : accepted ? "ok" : "warn"}>{rejected ? "rejected" : accepted ? "accepted" : "not reviewed"}</Badge></div>
      {props.meta ? <p className={v.faint}>{props.meta}</p> : null}
      {editing ? (
        <HintField label={`Edit ${props.title}`} hint={props.hint}><Textarea rows={4} value={props.body} maxLength={props.maxLength} onChange={(event) => props.onEdit(event.target.value)} /></HintField>
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

function Summary({ value, label }: { value: string | number; label: string }) {
  return <div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}>{label}</span></div>;
}
