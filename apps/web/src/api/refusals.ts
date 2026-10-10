/**
 * ADR-0183 batch 2.3 — refusals a person can resolve themselves, as "what to do
 * next" plus the place to do it.
 *
 * Three gateway refusals used to reach the screen as the generic "Mfa enrollment
 * required — … (POST /auth/totp/enroll) …" or "HTTP 403 — <reason>", which names
 * an API route rather than the page that fixes it:
 *
 *  - 403 `mfa_enrollment_required` on an API key: the key's owner has not set up
 *    two-step verification, which the organisation requires for them, so the key
 *    does not work (ADR-0181 FX2). The gateway marks it `credential: "api_key"`;
 *    the session gate's refusal with the same code gets the "your account" wording;
 *  - 409 `mfa_enrollment_required` when a key is issued to such a person: no key
 *    is minted until they enrol;
 *  - `ai-literacy-not-current` (the run-start refusal's `error`, or a governed
 *    call's `decision.ruleId`): the person has not acknowledged the AI policy that
 *    applies to them, outside the acknowledgement interstitial (ADR-0182 A14);
 *  - 409 `custom_provider_disabled` (R167-04): a custom model endpoint is switched
 *    off, so an agent cannot be bound to it (POST /v1/agents) or call it (dispatch);
 *    an administrator tests and enables it on the Custom LLM providers page.
 *
 * The message replaces the generic sentence everywhere an `ApiError` is shown
 * (its `message`), and the surfaces that can carry a link render `to` with
 * `RefusalLink`. The code stays on `payload.error` for anything that branches on it.
 */
import type { ApiErrorPayload } from "./client";

export interface RefusalGuidance {
  /** the gateway refusal this answers */
  code: "mfa_enrollment_required" | "ai-literacy-not-current" | "step_up_unavailable" | "custom_provider_disabled";
  /** what happened and what to do next, in words */
  message: string;
  /** the in-app route that resolves it */
  to: string;
  /** the link's text */
  linkLabel: string;
}

export const LITERACY_REFUSAL_CODE = "ai-literacy-not-current";

export const REFUSAL_GUIDANCE = {
  apiKeyMfa: {
    code: "mfa_enrollment_required",
    message:
      "This API key can't be used yet: your organization requires two-step verification for its owner, who hasn't set it " +
      "up. Sign in with your password and set up an authenticator app on the Account page; the key works from then on.",
    to: "/account?section=mfa",
    linkLabel: "Set up two-step verification",
  },
  sessionMfa: {
    code: "mfa_enrollment_required",
    message:
      "Your organization requires two-step verification for your account, and it isn't set up yet. Set up an " +
      "authenticator app on the Account page, then try again.",
    to: "/account?section=mfa",
    linkLabel: "Set up two-step verification",
  },
  keyIssueMfa: {
    code: "mfa_enrollment_required",
    message:
      "No key was issued: your organization requires two-step verification for this person, and they haven't set it up. " +
      "Ask them to sign in and set up an authenticator app on their Account page, then issue the key again.",
    to: "/account?section=mfa",
    linkLabel: "Where two-step verification is set up",
  },
  literacy: {
    code: LITERACY_REFUSAL_CODE,
    message:
      "You haven't acknowledged the current version of an AI policy that applies to you, so this was refused. Read and " +
      "acknowledge it on your Account page, then try again.",
    to: "/account?section=ai-policies",
    linkLabel: "Open the AI policies on your Account page",
  },
  // ADR-0186 A: the action needs a step-up, and the account has no way to give one
  stepUpUnavailable: {
    code: "step_up_unavailable",
    message:
      "This action needs you to confirm it's you, and your account has no way to do that yet. Set up an authenticator " +
      "app on the Account page (or a passkey, once your organization offers them), then try again.",
    to: "/account?section=mfa",
    linkLabel: "Set up a way to confirm it's you",
  },
  customProviderDisabled: {
    code: "custom_provider_disabled",
    message:
      "This custom model endpoint is switched off, so it can't be used. An administrator needs to run its connection " +
      "test and turn it on under Integrations → Custom LLM providers, then try again.",
    to: "/admin/custom-providers",
    linkLabel: "Open Custom LLM providers (administrators)",
  },
} as const satisfies Record<string, RefusalGuidance>;

/**
 * ADR-0186 (batch 4) — the refusal codes of dual control, step-up and
 * passkey-signed approvals as sentences a person reads (AgentCoordination §4.9).
 * The code stays on `payload.error` for anything that branches on it (the
 * step-up prompt branches on `step_up_required`, see `onStepUpRequired` in
 * client.ts); `codeSentence` reads these.
 */
export const BATCH4_REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  step_up_required:
    "Confirm it's you to continue: this action needs a fresh passkey, authenticator code or sign-in",
  step_up_unavailable: REFUSAL_GUIDANCE.stepUpUnavailable.message,
  duplicate_approver:
    "You (or the person you approve for) have already decided this — a different person must give the next approval",
  quorum_unsatisfiable:
    "This rule can never be met: it needs more different approvers than its approver pool has (the person making the call never counts)",
  approval_requires_individual_signature:
    "This approval has to be signed on its own with a passkey — it can't be decided in bulk",
  chatops_step_up_required: "This approval can't be decided from chat — open it in RegulAIt and confirm it's you there",
  sso_reauth_stale: "Your sign-in at your identity provider wasn't fresh — sign in again when asked, then try again",
  sso_reauth_identity_mismatch:
    "You signed in at your identity provider as someone other than the person using RegulAIt — sign in as yourself and try again",
  passkey_signature_required: "Approving this call needs your passkey signature over it",
  passkey_signature_invalid: "Your passkey signature couldn't be verified — try again with the passkey registered to your account",
  passkey_challenge_expired: "The signing request expired — start again",
  passkey_challenge_used: "That signing request was already used — start again",
  approval_action_changed:
    "The call changed after you were asked to approve it, so your signature no longer matches — review the call again",
  passkey_rp_unconfigured:
    "Passkeys aren't available yet: an administrator has to set this deployment's public address first",
  not_built: "This isn't available yet",
  // ADR-0186 A2+B: dual control and signed approvals
  caller_cannot_approve:
    "This is your own call (or the call of someone you're linked to by delegation), so a different person must decide it",
  approval_not_signable: "This approval isn't decided with a passkey signature — decide it the usual way",
  unknown_role: "The approver role you chose no longer exists — pick another role",
  approval_quorum_unsatisfiable:
    "This call needs more different approvers than are available besides you, so it was refused rather than queued",
  approval_signature_recheck_failed:
    "The approval for this call no longer matches the call (a signature didn't verify), so nothing ran — submit it again for a fresh approval",
  // B4S-02: only accounts that existed (and are active) since the call was queued may decide it
  approver_not_eligible:
    "You can't decide this call: only an active account that already existed when it was queued can — someone who was an approver then must decide it",
  // ADR-0186 A (slice A1): the passkey and step-up ceremonies
  passkey_attestation_refused:
    "That passkey sent manufacturer details RegulAIt doesn't accept — try again, or use a different passkey",
  passkey_already_registered: "That passkey is already registered",
  fresh_sign_in_required: "Adding your first passkey needs a fresh sign-in — sign out, sign in again, then add it",
  browser_session_required: "This can only be done by a person signed in to RegulAIt in a browser",
  unknown_challenge: "That request isn't known for this session — start again",
  unknown_step_up: "That confirmation request isn't known for this session — start again",
  step_up_action_too_large: "This action can't be confirmed — its details are larger than any action has",
};

/** the guidance for a refusal, or null when it is not one a person resolves this way */
export function refusalGuidance(status: number, payload: ApiErrorPayload | null | undefined): RefusalGuidance | null {
  if (!payload || typeof payload !== "object") return null;
  const code = typeof payload.error === "string" ? payload.error : null;
  const ruleId = (payload.decision as { ruleId?: unknown } | undefined)?.ruleId;
  if (code === LITERACY_REFUSAL_CODE || ruleId === LITERACY_REFUSAL_CODE) return REFUSAL_GUIDANCE.literacy;
  if (code === "step_up_unavailable" && status === 422) return REFUSAL_GUIDANCE.stepUpUnavailable;
  if (code === "mfa_enrollment_required") {
    if (status === 409) return REFUSAL_GUIDANCE.keyIssueMfa;
    if (status === 403) return payload.credential === "api_key" ? REFUSAL_GUIDANCE.apiKeyMfa : REFUSAL_GUIDANCE.sessionMfa;
  }
  if (code === "custom_provider_disabled" && status === 409) return REFUSAL_GUIDANCE.customProviderDisabled;
  return null;
}

/** the guidance carried by a thrown error (an `ApiError`), or null */
export function guidanceOf(error: unknown): RefusalGuidance | null {
  const g = (error as { guidance?: RefusalGuidance | null } | null)?.guidance;
  return g ?? null;
}
