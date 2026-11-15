/**
 * ADR-0334: what the content script decides when a person sends a prompt. Pure, so it is unit-tested apart from the
 * page. Deterministic: the shared credential rules only (no model, no remote call before the decision).
 */
import type { BrowserDlpRuleId } from "@regulait/shared/browser-governance/constants";
import { matchDlp } from "./dlp.js";
import type { VerdictReply } from "./messages.js";

export type SendDecision =
  | { action: "block"; ruleIds: BrowserDlpRuleId[] }
  | { action: "allow"; ruleIds: BrowserDlpRuleId[]; recordWouldBlock: boolean; capture: boolean };

/**
 * `reply` null means the worker could not answer: every rule applies and a match blocks (fail closed). In `audit`
 * mode a match is recorded as `would_block` and the prompt goes. A prompt is captured only when the policy says so,
 * and never one that matched a rule (credential material is not copied into the capture store).
 */
export function decideSend(text: string, reply: VerdictReply | null): SendDecision {
  const ruleIds = matchDlp(text, reply ? reply.dlpRuleIds : null);
  if (ruleIds.length > 0) {
    if (reply?.mode === "audit" && reply.verdict.effect === "allow") return { action: "allow", ruleIds, recordWouldBlock: true, capture: false };
    return { action: "block", ruleIds };
  }
  return { action: "allow", ruleIds, recordWouldBlock: false, capture: Boolean(reply?.promptCapture && reply.verdict.effect === "allow") };
}

/** is this key press a send in a prompt composer? Enter without Shift (a new line), or Ctrl/Cmd+Enter */
export function isSendKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "altKey">): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing;
}

/** a control that looks like a send button: a submit button, or a button labelled as send/submit */
export function looksLikeSendButton(label: string, type: string | null): boolean {
  if (type === "submit") return true;
  return /^(?:send|submit)\b/i.test(label.trim());
}
