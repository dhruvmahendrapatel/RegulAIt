/**
 * ADR-0058 — the pure half of a compliance pack's detail, attestations and
 * stored reports. The attestation body is exactly `packAttestationSchema`
 * (packages/shared/src/compliance-packs.ts; strict): controlRef, statement
 * (≤ 4000), optional evidenceRef (≤ 600) and validUntil (an ISO datetime).
 */
import type { RefusalSentences } from "../governance/refusalCopy";

export interface PackControl {
  id: string;
  controlRef: string;
  title: string;
  description: string | null;
  coverage: "enforced" | "evidenced" | "partial" | "unaddressed";
  collector: string;
  collectorParams: Record<string, unknown>;
  minEvidenceCount: number;
  attestationRequired: boolean;
  ownerNote: string | null;
}

export interface PackAttestation {
  id: string;
  controlRef: string;
  statement: string;
  evidenceRef: string | null;
  validUntil: string | null;
  attestedByUserId: string | null;
  attestedAt: string;
}

export interface PackDetail {
  pack: { id: string; framework: string; version: number; title: string; status: string; description: string | null };
  controls: PackControl[];
  attestations: PackAttestation[];
  disclaimer: string;
}

export interface PackReportSummary {
  id: string;
  packId: string;
  framework: string;
  packVersion: number;
  requestedByUserId: string | null;
  scopeKind: string;
  entitlementScope: string;
  effectiveProjectIds: string[] | null;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
}

export interface PackReport extends PackReportSummary {
  scopeId: string | null;
  payload: {
    statement?: string;
    disclaimer?: string;
    period?: { label?: string };
    totals?: Record<string, number>;
    controls?: Array<{ controlRef: string; title: string; status: string; evidenceCount: number | null; minEvidenceCount: number; note: string }>;
  };
}

export const ATTESTATION_LIMITS = { statementMax: 4000, evidenceRefMax: 600 } as const;

export interface AttestationForm {
  controlRef: string;
  statement: string;
  evidenceRef: string;
  /** `<input type="date">`, blank = no expiry stated */
  validUntil: string;
}

export const EMPTY_ATTESTATION: AttestationForm = { controlRef: "", statement: "", evidenceRef: "", validUntil: "" };

export interface AttestationBody {
  controlRef: string;
  statement: string;
  evidenceRef?: string;
  validUntil?: string;
}

/** the controls a person may attest to: organisational ones only */
export const attestableControls = (controls: readonly PackControl[]): PackControl[] =>
  controls.filter((c) => c.attestationRequired);

export function attestationBody(
  form: AttestationForm,
  today: string = new Date().toISOString().slice(0, 10),
): { ok: true; body: AttestationBody } | { ok: false; problem: string } {
  if (!form.controlRef) return { ok: false, problem: "Choose the control this statement is about." };
  const statement = form.statement.trim();
  if (!statement) return { ok: false, problem: "Write the statement. It is recorded as your own, attributed to you." };
  if (statement.length > ATTESTATION_LIMITS.statementMax) {
    return { ok: false, problem: `The statement is at most ${ATTESTATION_LIMITS.statementMax} characters.` };
  }
  const body: AttestationBody = { controlRef: form.controlRef, statement };
  const evidenceRef = form.evidenceRef.trim();
  if (evidenceRef) {
    if (evidenceRef.length > ATTESTATION_LIMITS.evidenceRefMax) {
      return { ok: false, problem: `The evidence reference is at most ${ATTESTATION_LIMITS.evidenceRefMax} characters.` };
    }
    body.evidenceRef = evidenceRef;
  }
  if (form.validUntil) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validUntil)) return { ok: false, problem: "The valid-until date is not a date." };
    if (form.validUntil < today) return { ok: false, problem: "The valid-until date is in the past." };
    body.validUntil = `${form.validUntil}T23:59:59.000Z`;
  }
  return { ok: true, body };
}

/** an attestation whose stated validity has run out no longer stands */
export const attestationLapsed = (a: PackAttestation, now = Date.now()): boolean =>
  a.validUntil !== null && new Date(a.validUntil).getTime() < now;

export const PACK_REFUSALS: RefusalSentences = {
  unknown_compliance_pack: "This pack no longer exists. Reload the list.",
  unknown_pack_control: "This pack has no control with that reference.",
  control_is_auto_evidenced:
    "That control is evidenced from the ledgers, so a person's statement cannot stand in for it.",
  unknown_pack_report: "That report no longer exists.",
  pack_scope_not_entitled: "This report covers projects outside what you may see.",
};

export const scopeWords = (r: Pick<PackReportSummary, "entitlementScope" | "effectiveProjectIds">): string =>
  r.effectiveProjectIds === null
    ? "organisation-wide"
    : `${r.effectiveProjectIds.length} ${r.effectiveProjectIds.length === 1 ? "project" : "projects"} (${r.entitlementScope})`;
