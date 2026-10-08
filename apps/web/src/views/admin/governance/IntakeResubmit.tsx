/**
 * "Update and resubmit" — the registration screen in resubmit mode for a use
 * case sent back for information (ADR-0168 amendment, afternoon, item 4).
 *
 * Prefilled from the record: its name (fixed), purpose and context, every
 * Classify answer last submitted and the last questionnaire; the reviewer's
 * reason for sending it back stays at the top. On submit it PATCHes what
 * changed with the whole Classify answer set (the gateway re-screens the tier
 * and re-derives the data sensitivity from the data categories) and posts a
 * NEW questionnaire version, which starts a new review round; then it lands on
 * the record. Risks, frameworks and the stack stay as recorded — they are
 * changed on the record itself.
 *
 * ADR-0171: the edits are kept as the owner's own server-side draft for this
 * use case (offered back on return), leaving with unsaved edits asks first,
 * Cancel and Back wait while the resubmission is in flight, and each yes/no
 * answer has plain-language help and a "Not sure" choice.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { humanize } from "../../../api/format";
import type { IntakeScreeningAnswers, UseCaseLifecycleDetail } from "../../../api/types";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, Input, Select, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate } from "../adminKit";
import { useSession } from "../../../session/SessionContext";
import v from "../../views.module.css";
import k from "../../../ui/kit.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";
import ix from "./intakeHelp.module.css";
import {
  AFFECTED_PERSON_OPTIONS,
  BIOMETRIC_OPTIONS,
  BooleanAnswerField,
  DATA_CATEGORY_OPTIONS,
  DECISION_AUTONOMY_OPTIONS,
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
import { canonicalDigest } from "./intakeCheckpoint";
import { durableForLeave, savedAtText, useIntakeDraft, type DraftStatus } from "./intakeDraft";
import { useLeaveGuard } from "./LeaveGuard";
import { missingFrom, newIdempotencyKey, outcomeUnknown, questionLabel } from "./registrationModel";
import { deriveDataSensitivity } from "./dataSensitivity";
import {
  answersBlock,
  answersFromForm,
  formFromAnswers,
  isScreeningSection,
  rebuildQuestionnaire,
  resubmitPatch,
  sameAnswers,
  sameEuAnswers,
  splitQuestionnaire,
  type BooleanAnswer,
  type QuestionnaireSection,
  type ScreeningForm,
} from "./resubmission";

const STEPS = ["Describe", "Classify", "Questionnaire", "Review"];
const DESCRIBE = 0;
const CLASSIFY = 1;
const QUESTIONNAIRE = 2;
const REVIEW = 3;

type Detail = UseCaseLifecycleDetail & {
  useCase: UseCaseLifecycleDetail["useCase"] & { name?: string; description?: string; businessContext?: string; workflowInstanceId?: string | null };
  instance?: { id: string } | null;
};

/** what a resubmission keeps in its draft (opaque to the server) */
interface ResubmitDraft {
  kind: "resubmission";
  version: 1;
  step: number;
  description: string;
  businessContext: string;
  form: ScreeningForm;
  affected: string;
  sections: QuestionnaireSection[];
}

function readResubmitDraft(state: unknown): ResubmitDraft | null {
  if (!state || typeof state !== "object") return null;
  const d = state as Partial<ResubmitDraft>;
  if (d.kind !== "resubmission" || d.version !== 1 || !d.form || !Array.isArray(d.sections) || typeof d.step !== "number") return null;
  return d as ResubmitDraft;
}

// the registration screen's questions, in its order
const BOOLEAN_FIELDS: Array<[keyof ScreeningForm, string]> = [
  ["profilesNaturalPersons", "Profiles natural persons"],
  ["interactsWithHumans", "Interacts directly with people"],
  ["generatesSyntheticContent", "Generates synthetic content"],
  ["autonomousActions", "Can take autonomous actions"],
  ["usesExternalVendor", "Uses an external AI vendor"],
  ["euNexus", "Has an EU nexus"],
  ["safetyComponent", "Safety component"],
  ["emotionRecognition", "Emotion recognition"],
  ["socialScoring", "Social scoring"],
  ["manipulativeTechniques", "Manipulative techniques"],
];

export function IntakeResubmit(props: { useCaseId: string }) {
  const detail = useQuery({
    queryKey: ["governance", "use-case-detail", props.useCaseId],
    queryFn: () => api.get<Detail>(`/v1/use-cases/${props.useCaseId}`),
  });
  const record = `/admin/governance/use-cases/${props.useCaseId}`;
  const d = detail.data;
  const allowed = Boolean(d?.resubmission?.allowed) && d?.useCase.status === "needs_info";
  // This local baseline belongs to the mounted editing session, not to the
  // query cache. Session refresh clears that cache; temporarily missing data
  // must not unmount the form and silently erase its unsaved work.
  const opened = useRef<{ useCaseId: string; detail: Detail } | null>(null);
  if (opened.current?.useCaseId !== props.useCaseId) opened.current = null;
  if (!opened.current && d && allowed) opened.current = { useCaseId: props.useCaseId, detail: d };
  if (opened.current) {
    return <ResubmitForm useCaseId={props.useCaseId} detail={opened.current.detail} record={record}
      recordReady={allowed && !detail.error} refreshing={detail.isFetching} onRefresh={() => void detail.refetch()} />;
  }

  return (
    <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
      {d ? (
        <>
          <PageHeader title="Update and resubmit" sub="Only a use case sent back for information can be resubmitted." />
          <Card>
            <div className={v.stack}>
              <p>{String(d.useCase.name ?? "This use case")} is not waiting for an update, so there is nothing to resubmit.</p>
              <p><Link to={record}>Open the use case</Link></p>
            </div>
          </Card>
        </>
      ) : null}
    </QueryGate>
  );
}

function ResubmitForm(props: { useCaseId: string; detail: Detail; record: string; recordReady: boolean; refreshing: boolean; onRefresh: () => void }) {
  const { detail: d } = props;
  const resubmission = d.resubmission!;
  const navigate = useNavigate();
  const { auth } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = {
    name: String(d.useCase.name ?? ""),
    description: String(d.useCase.description ?? ""),
    businessContext: String(d.useCase.businessContext ?? ""),
  };
  const instanceId = d.useCase.workflowInstanceId ?? d.instance?.id ?? null;

  const [step, setStep] = useState(DESCRIBE);
  const [description, setDescription] = useState(current.description);
  // the same rule as registration: blank reuses the purpose
  const [businessContext, setBusinessContext] = useState(current.businessContext === current.description ? "" : current.businessContext);
  const [form, setForm] = useState<ScreeningForm>(() => formFromAnswers(resubmission.screeningAnswers));
  const [affected, setAffected] = useState(() =>
    resubmission.screeningAnswers ? resubmission.screeningAnswers.affectedPersons[0] ?? "none" : "",
  );
  const parsed = useRef(splitQuestionnaire(resubmission.questionnaire?.content ?? ""));
  const [sections, setSections] = useState<QuestionnaireSection[]>(() => parsed.current.sections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // R13-12: a resubmission refused because a different account is signed in now
  const [ownerRefused, setOwnerRefused] = useState(false);
  // a retry after a failed questionnaire post does not PATCH the same body twice
  const patched = useRef<string | null>(null);
  // ADR-0179: a retry after a lost response sends the same Idempotency-Key, so
  // it gets the same questionnaire version back instead of a second review
  // round. Page memory is enough here: once the version is stored the use case
  // is no longer sent back, so a reload cannot resubmit it again.
  const artifactAttempt = useRef<{ key: string; content: string } | null>(null);

  // ---- the draft for this use case (AER-050) ------------------------------
  const initial = useRef(canonicalDigest({ description, businessContext, form, affected, sections }));
  const edited = canonicalDigest({ description, businessContext, form, affected, sections }) !== initial.current;
  const [done, setDone] = useState(false);
  const dirty = edited && !done;
  const draft = useIntakeDraft<ResubmitDraft>({
    scope: props.useCaseId,
    enabled: auth?.via === "session",
    userId: auth?.userId ?? null,
    snapshot: dirty ? { kind: "resubmission", version: 1, step, description, businessContext, form, affected, sections } : null,
  });
  const ownerChanged = useRef(draft.ownerChanged);
  ownerChanged.current = draft.ownerChanged;
  const accountChangedDuringSend = useRef(false);
  if (busy && draft.ownerChanged) accountChangedDuringSend.current = true;
  const [sentBeforeChange,setSentBeforeChange]=useState(false);
  const resumeDraft = () => {
    const record = draft.resume();
    const saved = record ? readResubmitDraft(record.state) : null;
    if (!saved) {
      void draft.startFresh();
      return;
    }
    setDescription(saved.description);
    setBusinessContext(saved.businessContext);
    setForm(saved.form);
    setAffected(saved.affected);
    setSections(saved.sections);
    setStep(Math.max(DESCRIBE, Math.min(REVIEW, saved.step)));
  };
  const kept = draftKept(draft.status);
  const leave = useLeaveGuard({
    when: !done && (dirty || busy),
    unloadWhen: !done && (busy || (dirty && draft.unsaved)),
    title: busy ? "Your resubmission is still being sent" : "Leave this resubmission?",
    body: busy ? (
      <p>If you leave now, open the use case again to check whether it went back for review before resubmitting.</p>
    ) : kept && !draft.unsaved ? (
      <p>Your changes are saved as a draft for this use case. Open Update and resubmit again to pick up where you left off.</p>
    ) : draft.ownerChanged ? (
      <p>A different account is signed in now, so your latest changes cannot be saved to the previous account's draft. Discard them and leave, or stay on this page.</p>
    ) : kept ? (
      <p>Your latest changes are being saved. Leaving saves them first; open Update and resubmit again to pick up where you left off.</p>
    ) : (
      <p>Your changes are not saved anywhere else and will be lost if you leave now.</p>
    ),
    beforeLeave: async () =>
      draft.status.kind === "off" || draft.status.kind === "done" || draft.status.kind === "offer" ||
      durableForLeave(await draft.flush(), draft.unsaved),
    onDiscard: !busy && draft.unsaved && draft.status.kind !== "saving" ? draft.abandon : undefined,
    // R13-11: after an in-place sign-in change no retry can save these edits
    cannotSave: !busy && draft.ownerChanged && draft.unsaved,
  });

  // Navigate after the successful submission has rendered with its guard off.
  useEffect(() => {
    if (done) navigate(props.record);
  }, [done, navigate, props.record]);

  const stageHeading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stageHeading.current?.focus();
    void draft.flush();
  }, [step]);

  const answers: (IntakeScreeningAnswers & { unsure?: string[] }) | null = answersFromForm(form, affected !== "");
  const missing = missingFrom((key) => (key === "affectedPerson" ? affected : form[key as keyof ScreeningForm]));
  const describeComplete = Boolean(description.trim());
  const canContinue = step === DESCRIBE ? describeComplete : step === CLASSIFY ? describeComplete && answers !== null : true;
  const goTo = (next: number) => { if (!draft.ownerChanged) setStep(Math.max(0, Math.min(REVIEW, next))); };
  const setAnswer = (key: keyof ScreeningForm, value: string | string[]) => setForm((f) => ({ ...f, [key]: value }));
  const editable = sections.filter((section) => !isScreeningSection(section));
  const answersChanged = !sameAnswers(answers, resubmission.screeningAnswers);
  const tierAnswersChanged = !sameEuAnswers(answers, resubmission.screeningAnswers);
  const recordedSensitivity = String(d.useCase.dataSensitivity ?? "");
  const nextSensitivity = form.dataCategories.length > 0 ? deriveDataSensitivity(form.dataCategories) : null;
  const changedText = [
    description.trim() !== current.description ? "Purpose" : null,
    (businessContext.trim() || description.trim()) !== current.businessContext ? "Business context" : null,
  ].filter(Boolean);
  const sectionsChanged = editable.filter((section) => parsed.current.sections.find((o) => o.heading === section.heading)?.body.trim() !== section.body.trim()).length;
  const nextVersion = (resubmission.questionnaire?.version ?? 0) + 1;

  const submit = async () => {
    if (!answers) return;
    if (!instanceId) {
      setError("The use case has no intake workflow to resubmit to. An administrator needs to check its workflow.");
      return;
    }
    // R13-12: these edits belong to the account that opened this page. Under
    // another person's cookie the PATCH and the new questionnaire version would
    // be sent as them, and the draft delete would remove their draft: send nothing.
    if (draft.ownerChanged) {
      setError(null);
      setOwnerRefused(true);
      return;
    }
    if (!props.recordReady) {
      setError("The current account cannot resubmit until the use-case record is available. Your edits stay on this page.");
      return;
    }
    setOwnerRefused(false);
    setBusy(true);
    setError(null);
    accountChangedDuringSend.current=false;
    const stopAfterChange=()=>{
      if(!ownerChanged.current&&!accountChangedDuringSend.current)return false;
      setSentBeforeChange(true);return true;
    };
    try {
      if(ownerChanged.current)return;
      const body = resubmitPatch(current, { description, businessContext }, answers);
      const digest = JSON.stringify(body);
      if (patched.current !== digest) {
        await api.patch(`/v1/use-cases/${props.useCaseId}`, body);
        patched.current = digest;
      }
      if(stopAfterChange())return;
      const content = rebuildQuestionnaire(parsed.current.preamble, sections, answers);
      if (artifactAttempt.current?.content !== content) artifactAttempt.current = { key: newIdempotencyKey(), content };
      const sent = artifactAttempt.current!;
      try {
        await api.postWithHeaders(`/v1/workflows/instances/${instanceId}/artifacts`, { stageId: "questionnaire", content }, { "Idempotency-Key": sent.key });
      } catch (error) {
        // a refusal stored nothing: the next attempt starts with a new key
        if (!outcomeUnknown(error)) artifactAttempt.current = null;
        throw error;
      }
      if(stopAfterChange())return;
      setDone(true);
      // resubmitted: the draft has done its job
      void draft.discard();
      toast("Resubmitted for review", "success");
      void queryClient.invalidateQueries({ queryKey: ["governance"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "use-cases"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "use-case", props.useCaseId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // R13-20/21: keep the editing state private to its original owner. The
  // account-change notice replaces all old sections, progress and retry copy.
  if (draft.ownerChanged || sentBeforeChange || accountChangedDuringSend.current) return <>
    {leave.dialog}
    <PageHeader title="Update and resubmit" sub="The account for this editing session changed." />
    <Card>
      <p role="alert">{busy || sentBeforeChange || accountChangedDuringSend.current ? "You're now signed in as someone else. A request was sent before the account changed — open the record to check whether it was saved. No further resubmission requests will be sent. Discard to leave." : "You're now signed in as someone else. This resubmission belongs to the previous account, so nothing was sent. Sign back in as that account to resubmit, or discard to leave."}</p>
      <Button disabled={busy} onClick={() => { draft.abandon(); setDone(true); }}>Discard and leave</Button>
    </Card>
  </>;

  const primary =
    step < REVIEW ? (
      <Button variant="primary" disabled={!canContinue} onClick={() => goTo(step + 1)}>Continue</Button>
    ) : (
      <Button variant="primary" disabled={busy || !answers || !props.recordReady} onClick={() => void submit()}>{busy ? "Resubmitting…" : "Resubmit for review"}</Button>
    );

  return (
    <>
      <PageHeader
        title="Update and resubmit"
        sub={`${current.name} — answer what the reviewer asked, then send it back for review.`}
        info={<p>Resubmitting saves a new questionnaire version and starts a new review round. Risks, frameworks and the linked stack stay as recorded; change them on the use case itself.</p>}
        actions={
          <div className={rg.headerActions}>
            {busy ? <Button variant="ghost" disabled>Cancel</Button> : <Link to={props.record} className={`${k.btnGhost} ${rg.linkBtn}`}>Cancel</Link>}
            {step > DESCRIBE && <Button disabled={busy} onClick={() => goTo(step - 1)}>Back</Button>}
            {primary}
          </div>
        }
      />
      {leave.dialog}
      <div className={v.stack}>
        {draft.status.kind === "offer" ? (
          <div className={ix.resume}>
            <p>
              You have saved changes for this resubmission from {savedAtText(draft.status.draft.updatedAt)}.
              {dirty ? " Until you choose, changes on this page are not saved." : ""}
            </p>
            <div className={ix.resumeActions}>
              <Button size="sm" variant="primary" onClick={resumeDraft}>Resume your draft</Button>
              <Button size="sm" onClick={() => void draft.startFresh()}>Start fresh</Button>
            </div>
          </div>
        ) : null}
        <div className={s.callout} role="note" aria-label="Why it was sent back">
          <strong>Sent back for information{resubmission.returnedByName ? ` by ${resubmission.returnedByName}` : ""}.</strong>{" "}
          {resubmission.returnReason ?? "No reason was recorded."}
        </div>
        <ol className={rg.stepper} aria-label="Resubmission progress">
          {STEPS.map((label, index) => (
            <li key={label} className={`${rg.step} ${index === step ? rg.stepActive : index < step ? rg.stepDone : ""}`} aria-current={index === step ? "step" : undefined}>
              <span className={rg.stepNumber} aria-hidden>{index < step ? "✓" : index + 1}</span>
              <span className={rg.stepLabel}>{label}</span>
            </li>
          ))}
        </ol>
        <ResubmitDraftLine status={draft.status} dirty={dirty} unsaved={draft.unsaved} />
        {!props.recordReady && <div role="status">
          <p>The current account's access to this use case needs checking. Your edits are kept here; resubmission is paused until the record is available.</p>
          <Button disabled={props.refreshing} onClick={props.onRefresh}>Refresh use-case record</Button>
        </div>}


        {step === DESCRIBE && (
          <Card title={<StageHeading headingRef={stageHeading}>Describe the use case</StageHeading>}>
            <form className={rg.form} onSubmit={(event) => { event.preventDefault(); if (canContinue) goTo(CLASSIFY); }}>
              <HintField label="Use-case name" hint="A registered use case keeps its name.">
                <Input value={current.name} readOnly />
              </HintField>
              <HintField label="What will the system do?" hint="The task, who it affects, and what the AI produces or changes.">
                <Textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} required />
              </HintField>
              <HintField label="Business context" optional hint="Why the business wants it. Leave blank to reuse the purpose.">
                <Textarea rows={3} value={businessContext} onChange={(event) => setBusinessContext(event.target.value)} />
              </HintField>
            </form>
          </Card>
        )}

        {step === CLASSIFY && (
          <Card title={<StageHeading headingRef={stageHeading}>Check the screening answers</StageHeading>}>
            <form className={rg.form} onSubmit={(event) => { event.preventDefault(); if (canContinue) goTo(QUESTIONNAIRE); }}>
              <p className={v.dim}>These answers set the EU AI Act risk tier. A changed answer is screened again when you resubmit. If you are not sure, choose “Not sure”: it counts as yes until a reviewer confirms it.</p>
              <section className={rg.group} aria-labelledby="resubmit-purpose">
                <h3 id="resubmit-purpose" className={rg.groupTitle}>Purpose and people</h3>
                <div className={rg.grid2}>
                  <HintField label="Primary purpose domain" id={questionId("resubmit", "purposeDomain")} hint="The area the output is used in.">
                    <Select value={form.purposeDomain} onChange={(event) => setAnswer("purposeDomain", event.target.value)} required>
                      {optionList("Choose a purpose domain", PURPOSE_DOMAIN_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="People affected" id={questionId("resubmit", "affectedPerson")} hint="Whose decisions or data it touches.">
                    <Select
                      value={affected}
                      onChange={(event) => {
                        setAffected(event.target.value);
                        setForm((f) => ({ ...f, affectedPersons: event.target.value === "none" || !event.target.value ? [] : [event.target.value] }));
                      }}
                      required
                    >
                      {optionList("Choose who is affected", AFFECTED_PERSON_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="Decision autonomy" id={questionId("resubmit", "decisionAutonomy")} hint="How much a person decides before anything happens.">
                    <Select value={form.decisionAutonomy} onChange={(event) => setAnswer("decisionAutonomy", event.target.value)} required>
                      {optionList("Choose decision autonomy", DECISION_AUTONOMY_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="Deployment audience" id={questionId("resubmit", "deployment")} hint="Who uses it directly.">
                    <Select value={form.deployment} onChange={(event) => setAnswer("deployment", event.target.value)} required>
                      {optionList("Choose deployment audience", DEPLOYMENT_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="Biometric use" id={questionId("resubmit", "biometricUse")} hint="Whether it recognises or checks people by their face, voice, fingerprint or other body features.">
                    <Select value={form.biometricUse} onChange={(event) => setAnswer("biometricUse", event.target.value)} required>
                      {optionList("Choose biometric use", BIOMETRIC_OPTIONS)}
                    </Select>
                  </HintField>
                </div>
              </section>
              <section className={rg.group} aria-labelledby="resubmit-data">
                <h3 id="resubmit-data" className={rg.groupTitle}>Data and sector</h3>
                <p className={rg.groupHint}>The strictest data category sets the data sensitivity.</p>
                <div className={rg.grid2}>
                  <MultiAnswerField label="Data categories" id={questionId("resubmit", "dataCategories")} values={form.dataCategories} options={DATA_CATEGORY_OPTIONS} onChange={(values) => setAnswer("dataCategories", values)} />
                  <MultiAnswerField label="Sectors" id={questionId("resubmit", "sectors")} values={form.sectors} options={SECTOR_OPTIONS} onChange={(values) => setAnswer("sectors", values)} />
                </div>
              </section>
              <section className={rg.group} aria-labelledby="resubmit-practices">
                <h3 id="resubmit-practices" className={rg.groupTitle}>What it does in practice</h3>
                <div className={rg.grid3}>
                  {BOOLEAN_FIELDS.map(([key, label]) => (
                    <BooleanAnswerField key={key} id={questionId("resubmit", key)} label={label} help={SCREENING_HELP[key]} value={form[key] as BooleanAnswer} onChange={(value) => setAnswer(key, value)} />
                  ))}
                </div>
              </section>
              <MissingAnswers missing={missing} idPrefix="resubmit" action="continue" />
            </form>
          </Card>
        )}

        {step === QUESTIONNAIRE && (
          <Card title={<StageHeading headingRef={stageHeading}>Update the questionnaire</StageHeading>}>
            <div className={v.stack}>
              <p className={v.dim}>
                {resubmission.questionnaire
                  ? `Version ${resubmission.questionnaire.version} is below. Add what the reviewer asked for; your changes become version ${nextVersion}.`
                  : "No earlier questionnaire was found. The screening answers are sent as the new version."}
              </p>
              {sections.map((section, index) => isScreeningSection(section) ? null : (
                <HintField key={`${section.heading}-${index}`} label={section.heading}>
                  <Textarea rows={5} value={section.body} onChange={(event) => setSections((all) => all.map((item, i) => (i === index ? { ...item, body: event.target.value } : item)))} />
                </HintField>
              ))}
              {answers ? (
                <HintField label={sections.find(isScreeningSection)?.heading ?? "9. EU AI Act risk screening"} hint="Generated from your screening answers so a reviewer can reproduce the tier. Read-only.">
                  <Textarea rows={8} value={answersBlock(answers)} readOnly />
                </HintField>
              ) : null}
            </div>
          </Card>
        )}

        {step === REVIEW && (
          <Card title={<StageHeading headingRef={stageHeading}>Review and resubmit</StageHeading>}>
            <div className={v.stack}>
              <div className={v.listRow}><strong>Name</strong><span className={v.grow}>{current.name}</span></div>
              <div className={v.listRow}><strong>Changed details</strong><span className={v.grow}>{changedText.length ? changedText.join(", ") : <span className={v.faint}>None</span>}</span></div>
              <div className={v.listRow}>
                <strong>Screening answers</strong>
                <span className={v.grow}>
                  {tierAnswersChanged ? (
                    <Badge tone="warn">Changed — the tier is screened again</Badge>
                  ) : answersChanged ? (
                    <Badge tone="info">Changed</Badge>
                  ) : (
                    <Badge tone="neutral">Unchanged</Badge>
                  )}
                  {answers ? <span className={v.faint}> {humanize(answers.purposeDomain)} · {humanize(answers.decisionAutonomy)}</span> : null}
                </span>
              </div>
              {answers?.unsure?.length ? (
                <div className={v.listRow}>
                  <strong>Not sure about</strong>
                  <span className={v.grow}>{answers.unsure.map(questionLabel).join(", ")} <span className={v.faint}>— counted as yes; your reviewers see that you were not sure</span></span>
                </div>
              ) : null}
              {nextSensitivity ? (
                <div className={v.listRow}>
                  <strong>Data sensitivity</strong>
                  <span className={v.grow}>
                    <Badge tone="info">{humanize(nextSensitivity)}</Badge>{" "}
                    <span className={v.faint}>
                      {recordedSensitivity && recordedSensitivity !== nextSensitivity ? `was ${humanize(recordedSensitivity)}; ` : ""}from the data categories — the strictest wins
                    </span>
                  </span>
                </div>
              ) : null}
              <div className={v.listRow}>
                <strong>Questionnaire</strong>
                <span className={v.grow}>Version {nextVersion}{sectionsChanged ? `, ${sectionsChanged} section${sectionsChanged === 1 ? "" : "s"} changed` : ", wording unchanged"}</span>
              </div>
              <div className={s.callout}>Resubmitting starts a new review round. The reviewers see the new version and decide again.</div>
              {error ? <p className={v.errLine} role="alert">The use case was not resubmitted: {error} Retry continues where it stopped.</p> : null}
              {ownerRefused ? (
                <p className={v.errLine} role="alert">
                  You're now signed in as someone else. This resubmission belongs to the previous account, so nothing was sent. Sign back in as that account to resubmit, or discard to leave.
                </p>
              ) : null}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

/** the draft is being kept on the server */
// a pending Resume / Start fresh offer saves nothing until the user chooses,
// so it must not be described (or relied on) as keeping their changes
const draftKept = (status: DraftStatus) =>
  status.kind !== "off" && status.kind !== "error" && status.kind !== "done" && status.kind !== "offer";

function ResubmitDraftLine(props: { status: DraftStatus; dirty: boolean; unsaved: boolean }) {
  const { status } = props;
  if (!props.dirty || status.kind === "done" || status.kind === "loading" || status.kind === "offer") return null;
  const text =
    status.kind === "off" || status.kind === "error"
      ? "Your changes can't be saved as a draft right now: they stay on this page until you resubmit."
      : status.kind === "saved" && !props.unsaved
        ? `Draft saved ${savedAtText(status.at)}. Only you can open it.`
        : "Saving your draft…";
  return <p className={ix.draftLine}>{text}</p>;
}
