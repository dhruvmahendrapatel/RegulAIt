/**
 * ADR-0189 R25 item 13 follow-up — the admin re-sync of a use case left behind
 * its completed intake workflow, from the posture page.
 *
 * `POST /v1/use-cases/:id/resync` asks for an `approval_decide` step-up; only a
 * signed-in browser session can give one, so the call goes through
 * `withStepUp` (the global dialog answers it and the same POST is resent once).
 */
import { ApiError } from "../../../api/client";
import { api, withStepUp } from "../../../stepup/stepUp";

export interface ResyncResult {
  useCaseId: string;
  status: string;
  resynced: boolean;
  aiBomSnapshotWarning?: { detail?: string };
}

export function resyncUseCase(useCaseId: string): Promise<ResyncResult> {
  return withStepUp((h) => api.post<ResyncResult>(`/v1/use-cases/${encodeURIComponent(useCaseId)}/resync`, {}, h));
}

/** each refusal the route names, as a sentence an admin can act on */
const SENTENCE: Readonly<Record<string, string>> = {
  bom_signing_unavailable:
    "No receipt signing key is available, so the approval can't take its signed AI BOM snapshot. Configure a key, then re-sync.",
  receipt_signing_key_invalid: "The receipt signing key is configured but can't be used. Fix the key, then re-sync.",
  use_case_edited_after_completion:
    "This use case was edited after its workflow completed, so it can't be approved as it stands. Propose the edited use case as a new one.",
  instance_not_completed: "Its intake workflow has not completed, so there is nothing to re-sync.",
  no_governing_instance: "This use case has no intake workflow to re-sync with.",
  step_up_required: "Re-syncing needs you to confirm it's you, and that was not completed.",
  bootstrap_cannot_drive: "Sign in as an administrator to re-sync; the bootstrap credential can't apply an approval.",
};

export function resyncRefusalText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = typeof e.payload.error === "string" ? e.payload.error : "";
    return SENTENCE[code] ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** the line announced after a re-sync answers */
export function resyncOutcomeText(r: ResyncResult): string {
  const base = r.resynced ? `Use case ${r.useCaseId} re-synced: now ${r.status.replace(/_/g, " ")}.` : `Use case ${r.useCaseId} was already in step (${r.status.replace(/_/g, " ")}); nothing changed.`;
  return r.aiBomSnapshotWarning ? `${base} Its AI BOM snapshot failed; take it on demand.` : base;
}
