/**
 * The registration screen's field helpers and the EU AI Act screening
 * choices, shared by registering a use case and resubmitting one sent back
 * for information (IntakeWizardPage, IntakeResubmit).
 */
import { cloneElement, useId, type ReactElement, type ReactNode, type RefObject } from "react";
import { humanize } from "../../../api/format";
import { Field, Fieldset, Select } from "../../../ui/kit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";
import rg from "./registration.module.css";

export type BooleanAnswer = "" | "yes" | "no";
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
export function HintField(props: { label: string; hint?: ReactNode; optional?: boolean; visuallyHiddenLabel?: boolean; children: ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
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

export function BooleanAnswerField(props: { value: BooleanAnswer; onChange: (value: BooleanAnswer) => void; label: string }) {
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

/** a wizard stage's title: a real heading, focusable by script only, so a stage change can land focus on it */
export function StageHeading(props: { headingRef: RefObject<HTMLHeadingElement>; children: ReactNode }) {
  return <h2 ref={props.headingRef} tabIndex={-1} className={s.stageHeading}>{props.children}</h2>;
}

/** a group of yes/no boxes: one per option, stored as the selected slugs */
export function MultiAnswerField(props: { label: string; values: string[]; options: readonly string[]; onChange: (values: string[]) => void }) {
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
