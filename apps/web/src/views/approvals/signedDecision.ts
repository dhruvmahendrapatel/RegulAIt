/**
 * ADR-0186 A/B — deciding a TOOL-CALL approval from the browser.
 *
 * A tool-call approval (`mcp_tool`, `connector_call`) carries the signature
 * mode the gateway snapshotted when it was queued:
 *
 *  - `passkey` (the strict default): the approver SIGNS the exact call. The
 *    flow is `POST /v1/approvals/:id/signing-options {decision}` → the
 *    browser's passkey prompt (`@simplewebauthn/browser`) over the options →
 *    `POST /v1/approvals/:id/decide {decision, reason, passkey:{challengeId,
 *    response}}`. The challenge IS the digest of the call, so nothing here
 *    builds or checks it: the gateway does both.
 *  - `step_up`: the decide may answer `step_up_required`; `withStepUp` asks
 *    the global step-up dialog and resends the same decide with the grant.
 *  - `off` (an audited relaxation): a plain decide.
 *
 * Every other approval kind is decided exactly as before (a plain decide).
 * Quorum: an approval may need several different people; `quorumProgress`
 * says where it stands ("1 of 2 approvals").
 */
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ApiError } from "../../api/client";
import type { Approval } from "../../api/types";
import { api as stepUpApi, withStepUp } from "../../stepup/stepUp";

export const TOOL_CALL_APPROVAL_KINDS = ["mcp_tool", "connector_call"] as const;

/** is this approval decided by dual control and (by default) a passkey signature? */
export function isToolCallApproval(r: Pick<Approval, "objectType">): boolean {
  return (TOOL_CALL_APPROVAL_KINDS as readonly string[]).includes(r.objectType);
}

/** the signature mode the gateway snapshotted (absent on an old response: the strict default) */
export function signatureModeOf(r: Pick<Approval, "signatureMode">): "passkey" | "step_up" | "off" {
  return r.signatureMode ?? "passkey";
}

/** "1 of 2 approvals" — null for an approval that needs no quorum view */
export function quorumProgress(r: Pick<Approval, "objectType" | "quorum" | "approvalsCount">): {
  count: number;
  quorum: number;
  label: string;
} | null {
  if (!isToolCallApproval(r)) return null;
  const quorum = r.quorum ?? 1;
  const count = r.approvalsCount ?? 0;
  return { count, quorum, label: `${count} of ${quorum} approval${quorum === 1 ? "" : "s"}` };
}

export const DECISION_METHOD_COPY: Readonly<Record<string, string>> = {
  passkey: "passkey",
  totp: "authenticator code",
  sso: "fresh sign-in",
  none: "no confirmation (signing off)",
};

export interface SignedDecideDeps {
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) => Promise<T>;
  /** the browser's passkey prompt over the gateway's request options */
  authenticate: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<unknown>;
  /** runs a call that may need a step-up (the global dialog by default) */
  stepUp: <T>(call: (headers: Record<string, string>) => Promise<T>) => Promise<T>;
}

const defaultDeps: SignedDecideDeps = {
  post: (path, body, headers) => stepUpApi.post(path, body, headers),
  authenticate: (optionsJSON) => startAuthentication({ optionsJSON }),
  stepUp: (call) => withStepUp(call),
};

interface SigningOptions {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  signedPayload: Record<string, unknown>;
}

/**
 * Decide `row`. For a passkey-mode tool-call approval this signs the exact
 * call first; the person sees their browser's passkey prompt once.
 */
export async function decideApproval<T = unknown>(
  row: Pick<Approval, "id" | "objectType" | "signatureMode">,
  decision: "approved" | "denied",
  reason: string | undefined,
  deps: SignedDecideDeps = defaultDeps,
): Promise<T> {
  const body = { decision, ...(reason ? { reason } : {}) };
  const decideUrl = `/v1/approvals/${row.id}/decide`;
  if (!isToolCallApproval(row)) return deps.post<T>(decideUrl, body);
  const mode = signatureModeOf(row);
  if (mode === "passkey") {
    const opts = await deps.post<SigningOptions>(`/v1/approvals/${row.id}/signing-options`, { decision });
    const response = await deps.authenticate(opts.options);
    return deps.post<T>(decideUrl, { ...body, passkey: { challengeId: opts.challengeId, response } });
  }
  if (mode === "step_up") return deps.stepUp((headers) => deps.post<T>(decideUrl, body, headers));
  return deps.post<T>(decideUrl, body);
}

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  passkey_signature_required:
    "This approval must be signed with your passkey. Sign in to RegulAIt in your browser and try again.",
  passkey_signature_invalid:
    "Your passkey's signature couldn't be verified for this decision. Try again, using a passkey registered to your account.",
  passkey_challenge_expired: "The signing request expired before it was used. Try again.",
  passkey_challenge_used: "That signing request was already used. Try again.",
  approval_action_changed:
    "The call this approval describes changed after you were asked to sign it. Reload the queue and review it again.",
  passkey_rp_unconfigured:
    "Passkey signing isn't set up on this deployment (its public address is missing), so this approval can't be signed. Ask an operator to set REGULAIT_PUBLIC_URL.",
  duplicate_approver:
    "You've already decided this approval, or someone you're linked to by delegation has. Another approver must decide it.",
  caller_cannot_approve: "This is your own call (or someone you're linked to by delegation), so someone else must decide it.",
  not_the_named_approver: "You aren't one of this approval's approvers.",
  approval_requires_individual_signature: "This approval must be opened and signed on its own.",
  already_decided: "This approval has already been decided.",
  approval_superseded: "This approval was superseded and can't be decided.",
};

/** a person-readable sentence for a refused or cancelled signed decision */
export function signedDecisionErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = typeof err.payload.error === "string" ? err.payload.error : "";
    if (code === "passkey_signature_required" && err.payload.enrolled === false) {
      return "Approving a tool call needs a passkey. Add one on your Account page, then come back and approve.";
    }
    return REFUSAL_COPY[code] ?? err.message;
  }
  if (err instanceof Error) {
    // the browser's own refusals (cancelled prompt, timed out, no matching passkey)
    if (err.name === "NotAllowedError" || err.name === "AbortError") {
      return "The passkey prompt was cancelled or timed out, so nothing was decided.";
    }
    return err.message;
  }
  return String(err);
}
