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
import v from "../../views.module.css";
import k from "../../../ui/kit.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";
import {
  AFFECTED_PERSON_OPTIONS,
  BIOMETRIC_OPTIONS,
  BooleanAnswerField,
  DATA_CATEGORY_OPTIONS,
  DECISION_AUTONOMY_OPTIONS,
  DEPLOYMENT_OPTIONS,
  HintField,
  MultiAnswerField,
  PURPOSE_DOMAIN_OPTIONS,
  SECTOR_OPTIONS,
  StageHeading,
  optionList,
} from "./intakeFields";
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
  return (
    <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
      {d && allowed ? (
        <ResubmitForm useCaseId={props.useCaseId} detail={d} record={record} />
      ) : d ? (
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

function ResubmitForm(props: { useCaseId: string; detail: Detail; record: string }) {
  const { detail: d } = props;
  const resubmission = d.resubmission!;
  const navigate = useNavigate();
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
  // a retry after a failed questionnaire post does not PATCH the same body twice
  const patched = useRef<string | null>(null);

  const stageHeading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    stageHeading.current?.focus();
  }, [step]);

  const answers: IntakeScreeningAnswers | null = answersFromForm(form, affected !== "");
  const describeComplete = Boolean(description.trim());
  const canContinue = step === DESCRIBE ? describeComplete : step === CLASSIFY ? describeComplete && answers !== null : true;
  const goTo = (next: number) => setStep(Math.max(0, Math.min(REVIEW, next)));
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
    setBusy(true);
    setError(null);
    try {
      const body = resubmitPatch(current, { description, businessContext }, answers);
      const digest = JSON.stringify(body);
      if (patched.current !== digest) {
        await api.patch(`/v1/use-cases/${props.useCaseId}`, body);
        patched.current = digest;
      }
      await api.post(`/v1/workflows/instances/${instanceId}/artifacts`, {
        stageId: "questionnaire",
        content: rebuildQuestionnaire(parsed.current.preamble, sections, answers),
      });
      toast("Resubmitted for review", "success");
      void queryClient.invalidateQueries({ queryKey: ["governance"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "use-cases"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "use-case", props.useCaseId] });
      navigate(props.record);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const primary =
    step < REVIEW ? (
      <Button variant="primary" disabled={!canContinue} onClick={() => goTo(step + 1)}>Continue</Button>
    ) : (
      <Button variant="primary" disabled={busy || !answers} onClick={() => void submit()}>{busy ? "Resubmitting…" : "Resubmit for review"}</Button>
    );

  return (
    <>
      <PageHeader
        title="Update and resubmit"
        sub={`${current.name} — answer what the reviewer asked, then send it back for review.`}
        info={<p>Resubmitting saves a new questionnaire version and starts a new review round. Risks, frameworks and the linked stack stay as recorded; change them on the use case itself.</p>}
        actions={
          <div className={rg.headerActions}>
            <Link to={props.record} className={`${k.btnGhost} ${rg.linkBtn}`}>Cancel</Link>
            {step > DESCRIBE && <Button onClick={() => goTo(step - 1)}>Back</Button>}
            {primary}
          </div>
        }
      />
      <div className={v.stack}>
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
              <p className={v.dim}>These answers set the EU AI Act risk tier. A changed answer is screened again when you resubmit.</p>
              <section className={rg.group} aria-labelledby="resubmit-purpose">
                <h3 id="resubmit-purpose" className={rg.groupTitle}>Purpose and people</h3>
                <div className={rg.grid2}>
                  <HintField label="Primary purpose domain" hint="The area the output is used in.">
                    <Select value={form.purposeDomain} onChange={(event) => setAnswer("purposeDomain", event.target.value)} required>
                      {optionList("Choose a purpose domain", PURPOSE_DOMAIN_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="People affected" hint="Whose decisions or data it touches.">
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
                  <HintField label="Decision autonomy" hint="How much a person decides before anything happens.">
                    <Select value={form.decisionAutonomy} onChange={(event) => setAnswer("decisionAutonomy", event.target.value)} required>
                      {optionList("Choose decision autonomy", DECISION_AUTONOMY_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="Deployment audience" hint="Who uses it directly.">
                    <Select value={form.deployment} onChange={(event) => setAnswer("deployment", event.target.value)} required>
                      {optionList("Choose deployment audience", DEPLOYMENT_OPTIONS)}
                    </Select>
                  </HintField>
                  <HintField label="Biometric use">
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
                  <MultiAnswerField label="Data categories" values={form.dataCategories} options={DATA_CATEGORY_OPTIONS} onChange={(values) => setAnswer("dataCategories", values)} />
                  <MultiAnswerField label="Sectors" values={form.sectors} options={SECTOR_OPTIONS} onChange={(values) => setAnswer("sectors", values)} />
                </div>
              </section>
              <section className={rg.group} aria-labelledby="resubmit-practices">
                <h3 id="resubmit-practices" className={rg.groupTitle}>What it does in practice</h3>
                <div className={rg.grid3}>
                  {BOOLEAN_FIELDS.map(([key, label]) => (
                    <BooleanAnswerField key={key} label={label} value={form[key] as "" | "yes" | "no"} onChange={(value) => setAnswer(key, value)} />
                  ))}
                </div>
              </section>
              {!answers ? <p className={v.faint}>Answer every question to continue.</p> : null}
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
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
