/**
 * Trace retention holds (ADR-0173 batch 2c, the "extend retention" automation
 * action): the list (`GET /v1/retention-holds`) and the release
 * (`POST /v1/retention-holds/release`), whose body is a strict discriminated
 * union (apps/gateway/src/automation-rules.ts `releaseBody`):
 *
 *  - `{reason: "erasure", userId, reference}` — an erasure request releases
 *    every hold on that person's traces;
 *  - `{reason: "admin", traceIds | userId, reference}` — exactly one of the two.
 *
 * Releasing held evidence is an `evidence_hold_override`, so the gateway asks
 * the admin to confirm it is them; the confirmation copy here says what ends.
 */
import { UUID_RE } from "../../../api/format";

export interface RetentionHold {
  traceId: string;
  traceUserId: string;
  holdUntil: string;
  ruleId: string | null;
  createdByUserId: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
}

export interface RetentionHoldsResponse {
  holds: RetentionHold[];
  retention: { floorDays: number; maxHoldDays: number };
}

export interface HoldFilters {
  traceId: string;
  userId: string;
}

/** the list query; a half-typed id is a problem, not a 400 */
export function holdsQuery(f: HoldFilters): { ok: true; qs: string } | { ok: false; problem: string } {
  const q = new URLSearchParams();
  if (f.traceId.trim()) {
    if (!UUID_RE.test(f.traceId.trim())) return { ok: false, problem: "The trace filter is not a trace id." };
    q.set("traceId", f.traceId.trim());
  }
  if (f.userId) q.set("userId", f.userId);
  q.set("limit", "200");
  return { ok: true, qs: q.toString() };
}

export const isActiveHold = (h: RetentionHold, now = Date.now()): boolean =>
  h.releasedAt === null && new Date(h.holdUntil).getTime() > now;

export type ReleaseBody =
  | { reason: "erasure"; userId: string; reference: string }
  | { reason: "admin"; traceIds: string[]; reference: string }
  | { reason: "admin"; userId: string; reference: string };

export interface ReleaseForm {
  /** "selected" = the picked traces; "person" = every hold on one person's traces */
  scope: "selected" | "person";
  /** only for scope "person" */
  erasure: boolean;
  userId: string;
  reference: string;
}

export const RELEASE_LIMITS = { maxTraces: 500, referenceMax: 200 } as const;

export function releaseBody(form: ReleaseForm, picked: readonly string[]): { ok: true; body: ReleaseBody } | { ok: false; problem: string } {
  const reference = form.reference.trim();
  if (!reference) return { ok: false, problem: "Give the ticket or erasure-request reference. It is kept in the audit record." };
  if (reference.length > RELEASE_LIMITS.referenceMax) {
    return { ok: false, problem: `The reference is at most ${RELEASE_LIMITS.referenceMax} characters.` };
  }
  if (form.scope === "selected") {
    if (picked.length === 0) return { ok: false, problem: "Select the held traces to release." };
    if (picked.length > RELEASE_LIMITS.maxTraces) return { ok: false, problem: `At most ${RELEASE_LIMITS.maxTraces} traces per release.` };
    return { ok: true, body: { reason: "admin", traceIds: [...picked], reference } };
  }
  if (!form.userId) return { ok: false, problem: "Choose the person whose holds are released." };
  return form.erasure
    ? { ok: true, body: { reason: "erasure", userId: form.userId, reference } }
    : { ok: true, body: { reason: "admin", userId: form.userId, reference } };
}

/** what becomes true once the release is written, for the confirmation */
export function releaseConsequence(body: ReleaseBody, personName: string | null): string {
  const who = personName ?? "this person";
  if (body.reason === "erasure") {
    return `Every retention hold on ${who}'s traces ends now, for their erasure request. Their traces then follow the normal retention schedule and can be deleted.`;
  }
  if ("traceIds" in body) {
    return `The hold on ${body.traceIds.length} ${body.traceIds.length === 1 ? "trace" : "traces"} ends now. They then follow the normal retention schedule and can be deleted.`;
  }
  return `Every retention hold on ${who}'s traces ends now. They then follow the normal retention schedule and can be deleted.`;
}
