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
  code: "mfa_enrollment_required" | "ai-literacy-not-current" | "custom_provider_disabled";
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
  customProviderDisabled: {
    code: "custom_provider_disabled",
    message:
      "This custom model endpoint is switched off, so it can't be used. An administrator needs to run its connection " +
      "test and turn it on under Integrations → Custom LLM providers, then try again.",
    to: "/admin/custom-providers",
    linkLabel: "Open Custom LLM providers (administrators)",
  },
} as const satisfies Record<string, RefusalGuidance>;

/** the guidance for a refusal, or null when it is not one a person resolves this way */
export function refusalGuidance(status: number, payload: ApiErrorPayload | null | undefined): RefusalGuidance | null {
  if (!payload || typeof payload !== "object") return null;
  const code = typeof payload.error === "string" ? payload.error : null;
  const ruleId = (payload.decision as { ruleId?: unknown } | undefined)?.ruleId;
  if (code === LITERACY_REFUSAL_CODE || ruleId === LITERACY_REFUSAL_CODE) return REFUSAL_GUIDANCE.literacy;
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
