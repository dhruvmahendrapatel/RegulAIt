/**
 * ADR-0240 — what an admin sees of an external grant's second factor (a supplier contact's on the vendor's Supplier
 * access, an auditor's on Trust publishing), and what a reset does. One model for both admin screens; the dialog is
 * `ExternalSecondFactorDialog`.
 *
 * The gateway never returns the secret. A reset deletes the factor, ends the grant's sessions and revokes every unused
 * link, so the admin must send a new link afterwards; recovery is never self-service.
 */
import type { Tone } from "../../ui/kit";

export type ExternalFactorState = "none" | "enrolling" | "active" | "locked";

/** GET …/mfa: the factor's state, never its secret */
export interface ExternalFactorView {
  state: ExternalFactorState;
  enrolledAt: string | null;
  failedAttempts: number;
  lockedAt: string | null;
}

/** POST …/mfa/reset */
export interface ExternalFactorResetResult {
  reset: true;
  hadFactor: boolean;
  sessionsEnded: number;
  linksRevoked: number;
  notice?: string;
}

export const FACTOR_STATE_LABEL: Readonly<Record<ExternalFactorState, string>> = Object.freeze({
  none: "Not set up",
  enrolling: "Set-up started",
  active: "Active",
  locked: "Locked",
});

export const FACTOR_STATE_TONE: Readonly<Record<ExternalFactorState, Tone>> = Object.freeze({
  none: "neutral",
  enrolling: "info",
  active: "ok",
  locked: "danger",
});

/** a state the gateway may add later reads as "unknown", not as one of ours */
export function factorLabel(state: string): string {
  return (FACTOR_STATE_LABEL as Record<string, string>)[state] ?? "Unknown";
}
export function factorTone(state: string): Tone {
  return (FACTOR_STATE_TONE as Record<string, Tone>)[state] ?? "neutral";
}

/** one plain sentence about the factor, for the dialog */
export function factorSentence(v: ExternalFactorView, fmt: (iso: string) => string): string {
  switch (v.state) {
    case "none":
      return "No second factor yet. They set one up the first time they open a sign-in link.";
    case "enrolling":
      return "They opened a link but have not confirmed a code yet. The next link starts the set-up again with a new secret.";
    case "active":
      return v.enrolledAt ? `Set up ${fmt(v.enrolledAt)}. Every sign-in asks for a code from their authenticator app.` : "Every sign-in asks for a code from their authenticator app.";
    case "locked":
      return `Locked${v.lockedAt ? ` ${fmt(v.lockedAt)}` : ""} after too many wrong codes. They cannot sign in until you reset it.`;
    default:
      return "The gateway reported a state this page does not know.";
  }
}

/** a reset needs something to reset; otherwise the button says why it is off */
export function resetBlock(v: ExternalFactorView | undefined): string | null {
  if (!v) return "Loading the second factor.";
  if (v.state === "none") return "Nothing to reset: no second factor has been set up yet.";
  return null;
}

/** the toast after a reset: what changed, and the one thing the admin must do next */
export function resetSummary(out: ExternalFactorResetResult): string {
  const parts = [out.hadFactor ? "Second factor reset." : "Nothing was set up; sign-in state cleared."];
  if (out.sessionsEnded > 0) parts.push(`${out.sessionsEnded} ${out.sessionsEnded === 1 ? "session" : "sessions"} ended.`);
  if (out.linksRevoked > 0) parts.push(`${out.linksRevoked} unused ${out.linksRevoked === 1 ? "link" : "links"} revoked.`);
  parts.push("Send a new link so they can set it up again.");
  return parts.join(" ");
}
