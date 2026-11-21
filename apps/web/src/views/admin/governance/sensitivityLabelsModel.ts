/**
 * ADR-0363 slice 1 — the customer's sensitivity labels, as pure functions for the "Sensitivity labels" page
 * (`GET /v1/sensitivity-labels`, `PUT /v1/sensitivity-labels/settings`, `PUT|DELETE /v1/sensitivity-labels/:id/rule`).
 *
 * The labels are read from the organisation's tenant by the identity-provider discovery scan; this page only maps them.
 * Each label is allowed, redacted or blocked when a file carrying it is sent to a model, with a data sensitivity and
 * optionally a compliance profile, which can only raise that call's PII mode and guardrail floor. Three fallbacks
 * cover an unmapped label, an encrypted file and a file that cannot be read. Everything starts at "block": loosening any
 * of them is a relaxation, so the gateway asks the admin to confirm it is them, and audits it.
 *
 * The page never pre-selects a looser choice (DESIGN_GUIDELINES, States): a new mapping opens on "block".
 */
import type { Tone } from "../../../ui/kit";

export const LABEL_ACTIONS = ["allow", "redact", "block"] as const;
export type LabelAction = (typeof LABEL_ACTIONS)[number];
export const LABEL_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type LabelSensitivity = (typeof LABEL_SENSITIVITIES)[number];

export interface LabelRule {
  action: LabelAction;
  sensitivity: LabelSensitivity;
  complianceProfileId: string | null;
}

export interface SensitivityLabel {
  id: string;
  provider: string;
  tenantId: string;
  labelId: string;
  name: string;
  parentLabelId: string | null;
  rank: number | null;
  active: boolean;
  syncedAt: string;
  rule: LabelRule | null;
}

export interface LabelSettings {
  unmappedAction: LabelAction;
  protectedAction: LabelAction;
  unreadableAction: LabelAction;
  strictDefault: boolean;
}

export interface LabelList {
  settings: LabelSettings;
  trustedTenantIds: string[];
  labels: SensitivityLabel[];
}

export const ACTION_WORDS: Readonly<Record<LabelAction, { label: string; tone: Tone; help: string }>> = Object.freeze({
  block: { label: "Block", tone: "danger", help: "The request is refused before it reaches the model." },
  redact: { label: "Redact", tone: "warn", help: "The file is replaced by a short note; the rest of the request is sent." },
  allow: { label: "Allow", tone: "ok", help: "The file is sent to the model as it is." },
});

export const SENSITIVITY_WORDS: Readonly<Record<LabelSensitivity, string>> = Object.freeze({
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
});

export const FALLBACKS = [
  { key: "unmappedAction", label: "A label with no mapping", help: "Any label below that is not mapped, and any label from another tenant." },
  { key: "protectedAction", label: "An encrypted file", help: "A file protected with encryption, whose content cannot be inspected." },
  { key: "unreadableAction", label: "A file that cannot be read", help: "A file whose labels cannot be read, for example a damaged document." },
] as const satisfies ReadonlyArray<{ key: keyof Omit<LabelSettings, "strictDefault">; label: string; help: string }>;
export type FallbackKey = (typeof FALLBACKS)[number]["key"];
export type FallbackDraft = Record<FallbackKey, LabelAction>;

const strictness = (a: LabelAction) => LABEL_ACTIONS.indexOf(a);
/** true when `next` lets more through than `prev` (block → redact → allow) */
export const loosens = (prev: LabelAction, next: LabelAction) => strictness(next) < strictness(prev);

export const fallbackDraft = (s: LabelSettings): FallbackDraft => ({ unmappedAction: s.unmappedAction, protectedAction: s.protectedAction, unreadableAction: s.unreadableAction });

/** the fallbacks that change, and whether any of them loosens (a step-up) */
export function fallbackChange(saved: LabelSettings, draft: FallbackDraft): { changed: Partial<FallbackDraft>; relaxes: boolean } {
  const changed: Partial<FallbackDraft> = {};
  let relaxes = false;
  for (const f of FALLBACKS) {
    if (draft[f.key] !== saved[f.key]) {
      changed[f.key] = draft[f.key];
      if (loosens(saved[f.key], draft[f.key])) relaxes = true;
    }
  }
  return { changed, relaxes };
}

export interface RuleDraft {
  action: LabelAction;
  sensitivity: LabelSensitivity;
  complianceProfileId: string;
}

/** a new mapping starts at the strictest choice; an existing one starts where it is */
export const ruleDraft = (l: SensitivityLabel): RuleDraft =>
  l.rule ? { action: l.rule.action, sensitivity: l.rule.sensitivity, complianceProfileId: l.rule.complianceProfileId ?? "" } : { action: "block", sensitivity: "restricted", complianceProfileId: "" };

export const ruleBody = (d: RuleDraft) => ({ action: d.action, sensitivity: d.sensitivity, complianceProfileId: d.complianceProfileId || null });

/** what a label does today: its own action, or the unmapped fallback */
export const effectiveAction = (l: SensitivityLabel, s: LabelSettings): LabelAction => l.rule?.action ?? s.unmappedAction;

/**
 * Whether saving `draft` for `l` lets more through than today, by the gateway's own rule (`labelPolicyRelaxes`): a looser
 * action than the label has now (its rule, or the unmapped fallback), a lower sensitivity than before ("restricted" for
 * a new mapping), or a compliance profile dropped or swapped. The gateway asks for the step-up only then; the page uses
 * this to warn before it asks.
 */
export function ruleRelaxes(l: SensitivityLabel, s: LabelSettings, d: RuleDraft): boolean {
  if (loosens(effectiveAction(l, s), d.action)) return true;
  const sens = (x: LabelSensitivity) => LABEL_SENSITIVITIES.indexOf(x);
  if (sens(d.sensitivity) < sens(l.rule ? l.rule.sensitivity : "restricted")) return true;
  const old = l.rule?.complianceProfileId ?? null;
  return old !== null && (d.complianceProfileId || null) !== old;
}

/** removing a mapping: the label falls to the unmapped action and loses its profile */
export function removalRelaxes(l: SensitivityLabel, s: LabelSettings): boolean {
  if (!l.rule) return false;
  return loosens(l.rule.action, s.unmappedAction) || l.rule.complianceProfileId !== null;
}

/** parents before their children, each child indented once; a child whose parent is not synced stays top level */
export function labelTree(labels: readonly SensitivityLabel[]): Array<{ label: SensitivityLabel; depth: 0 | 1; parentName: string | null }> {
  const byLabelId = new Map(labels.map((l) => [l.labelId, l]));
  const children = new Map<string, SensitivityLabel[]>();
  const roots: SensitivityLabel[] = [];
  for (const l of labels) {
    const parent = l.parentLabelId ? byLabelId.get(l.parentLabelId) : undefined;
    if (parent && parent !== l) children.set(parent.labelId, [...(children.get(parent.labelId) ?? []), l]);
    else roots.push(l);
  }
  const out: Array<{ label: SensitivityLabel; depth: 0 | 1; parentName: string | null }> = [];
  for (const r of roots) {
    out.push({ label: r, depth: 0, parentName: null });
    for (const c of children.get(r.labelId) ?? []) out.push({ label: c, depth: 1, parentName: r.name });
  }
  return out;
}

export const LABEL_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  label_not_found: "That label is no longer in the synced list. Run the identity-provider scan again to refresh it.",
  compliance_profile_not_found: "That compliance profile no longer exists. Pick another, or none.",
});
