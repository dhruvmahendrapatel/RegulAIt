/**
 * The registration screen's field helpers and the EU AI Act screening
 * choices, shared by registering a use case and resubmitting one sent back
 * for information (IntakeWizardPage, IntakeResubmit).
 */
import { cloneElement, useId, type ReactElement, type ReactNode, type RefObject } from "react";
import { humanize } from "../../../api/format";
import { Button, Fieldset, Select } from "../../../ui/kit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";
import ix from "./intakeHelp.module.css";
import type { BooleanAnswer, MissingAnswer } from "./registrationModel";

export type { BooleanAnswer } from "./registrationModel";
type Options = ReadonlyArray<readonly [value: string, label: string]>;

export const PURPOSE_DOMAIN_OPTIONS: Options = [
  ["essential-services", "Essential services"],
  ["employment-hr", "Employment / HR"],
  ["education", "Education"],
  ["law-enforcement", "Law enforcement"],
  ["migration-border", "Migration / border control"],
  ["justice-democracy", "Justice / democracy"],
  ["critical-infrastructure", "Critical infrastructure"],
  ["general-business", "General business"],
  ["internal-productivity", "Internal productivity"],
];
export const AFFECTED_PERSON_OPTIONS: Options = [
  ["none", "No natural persons"],
  ["employees", "Employees"],
  ["customers", "Customers"],
  ["general-public", "General public"],
  ["vulnerable-groups", "Vulnerable groups"],
];
export const DECISION_AUTONOMY_OPTIONS: Options = [
  ["narrow-procedural", "Narrow procedural task"],
  ["informs-human", "Informs a human"],
  ["human-reviews", "Human reviews every recommendation"],
  ["fully-automated", "Fully automated"],
];
export const DEPLOYMENT_OPTIONS: Options = [
  ["internal", "Internal"],
  ["customer-facing", "Customer-facing"],
  ["public", "Public"],
];
export const BIOMETRIC_OPTIONS: Options = [
  ["none", "None"],
  ["verification", "1:1 verification"],
  ["remote-identification", "Remote identification"],
];

export const SECTOR_OPTIONS = ["financial-services", "securities-broker-dealer", "healthcare", "payments", "public-sector", "general"] as const;
export const DATA_CATEGORY_OPTIONS = ["personal", "sensitive-personal", "health", "payment-card", "financial", "proprietary", "public"] as const;

/** a select's options, after its "Choose …" placeholder */
export const optionList = (placeholder: string, options: Options) => (
  <>
    <option value="">{placeholder}</option>
    {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
  </>
);

/**
 * A labelled control with a short hint UNDER it (ADR-0168: hints, not popovers).
 * The hint is the control's description (aria-describedby), so a screen reader
 * reads it after the name; the label stays exactly the field's name.
 */
export function HintField(props: { label: string; hint?: ReactNode; optional?: boolean; visuallyHiddenLabel?: boolean; id?: string; children: ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
  const auto = useId();
  const id = props.id ?? auto;
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

/**
 * AER-053: what each yes/no screening question means, in plain words with an
 * example — shown under the question, so nobody has to know the regulation's
 * vocabulary to answer it.
 */
export const SCREENING_HELP: Record<string, string> = {
  profilesNaturalPersons: "Does it build a picture of individual people (behaviour, finances, reliability) to judge or predict something about them? Example: estimating whether a customer will repay.",
  interactsWithHumans: "Do people talk to it or see what it produces directly, not only through a colleague? Example: a chat assistant on your website.",
  generatesSyntheticContent: "Does it write text or create images, audio or video, rather than only a score or label? Example: drafting a reply to a customer.",
  autonomousActions: "Can it act on its own through other systems (send, change, book, pay) without a person approving each action? Example: updating a customer record by itself.",
  usesExternalVendor: "Does a model or service from another company do part of the work? Example: a model hosted by an AI provider.",
  euNexus: "Is it used in the EU, offered to people in the EU, or do its results affect people there? Example: a service customers in Germany can use.",
  safetyComponent: "Does it help keep a product or critical infrastructure safe, so a mistake could put health or safety at risk? Example: monitoring a power network or a medical device.",
  emotionRecognition: "Does it infer how people feel or what they intend from their face, voice or body? Example: judging a caller's mood from their voice.",
  socialScoring: "Does it rate people on their general behaviour or personality in a way that could affect how they are treated elsewhere? Example: a trustworthiness score shared across services.",
  manipulativeTechniques: "Could it steer people's choices in ways they would not notice, or exploit a weakness such as age or money worries? Example: pressure tactics aimed at people in debt.",
};

/** what a "Not sure" answer means, said where the answer is chosen */
export const UNSURE_NOTE = "Not sure counts as yes until a reviewer confirms it. The reviewer sees that you were not sure.";

/**
 * A yes/no screening question with its plain-language help under it and a
 * governed "Not sure" choice (ADR-0171 item 5): never a silent no.
 */
export function BooleanAnswerField(props: { value: BooleanAnswer; onChange: (value: BooleanAnswer) => void; label: string; help?: string; id?: string }) {
  const unsure = props.value === "unsure";
  return (
    <HintField
      label={props.label}
      {...(props.id ? { id: props.id } : {})}
      hint={props.help || unsure ? (
        <>
          {props.help}
          {unsure ? <span className={ix.unsureNote}>{UNSURE_NOTE}</span> : null}
        </>
      ) : undefined}
    >
      <Select value={props.value} onChange={(event) => props.onChange(event.target.value as BooleanAnswer)} required>
        <option value="">Choose yes, no or not sure</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
        <option value="unsure">Not sure</option>
      </Select>
    </HintField>
  );
}

/** the id a Classify question's control carries, so the missing-answers summary can take focus to it */
export const questionId = (prefix: string, key: string) => `${prefix}-q-${key}`;

/**
 * AER-053: an incomplete Classify step names every unanswered question, by
 * group, and takes focus to the first — instead of a disabled button and
 * "answer every question".
 */
export function MissingAnswers(props: { missing: MissingAnswer[]; idPrefix: string; action: string }) {
  if (props.missing.length === 0) return null;
  const groups = [...new Set(props.missing.map((m) => m.group))];
  const first = props.missing[0]!;
  const goToFirst = () => {
    const el = document.getElementById(questionId(props.idPrefix, first.key));
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };
  return (
    <section className={ix.missing} aria-labelledby={`${props.idPrefix}-missing-title`}>
      <h3 id={`${props.idPrefix}-missing-title`} className={ix.missingTitle}>
        {props.missing.length === 1 ? "1 question still needs an answer" : `${props.missing.length} questions still need an answer`} before you can {props.action}
      </h3>
      <ul className={ix.missingList}>
        {groups.map((group) => (
          <li key={group}>
            <span className={ix.missingGroup}>{group}:</span> {props.missing.filter((m) => m.group === group).map((m) => m.label).join(", ")}
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" onClick={goToFirst}>Go to the first unanswered question</Button>
      </div>
    </section>
  );
}

/** a wizard stage's title: a real heading, focusable by script only, so a stage change can land focus on it */
export function StageHeading(props: { headingRef: RefObject<HTMLHeadingElement>; children: ReactNode }) {
  return <h2 ref={props.headingRef} tabIndex={-1} className={s.stageHeading}>{props.children}</h2>;
}

/** a group of yes/no boxes: one per option, stored as the selected slugs */
export function MultiAnswerField(props: { label: string; values: string[]; options: readonly string[]; onChange: (values: string[]) => void; id?: string }) {
  const toggle = (option: string, checked: boolean) => props.onChange(checked
    ? [...props.values, option]
    : props.values.filter((value) => value !== option));
  // a group of boxes is a fieldset, not a Field: the caption names the group
  // and each option keeps its own name (AER-029)
  return (
    <Fieldset legend={`${props.label} — select all that apply`}>
      <div className={v.stackTight}>
        {props.options.map((option, index) => (
          <label className={s.checkbox} key={option}>
            <input
              type="checkbox"
              // the first box is where "go to the first unanswered question" lands
              {...(index === 0 && props.id ? { id: props.id } : {})}
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
