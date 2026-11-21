/** ADR-0334: the messages between the content script and the service worker (types only). */
import type { BrowserDlpRuleId, BrowserEvent, BrowserPolicyMode, BrowserSiteId, BrowserSiteVerdict } from "@regulait/shared/browser-governance";

/** the fields a content script supplies; the worker adds the site, path and time from the sender itself */
export type ContentEvent = Pick<BrowserEvent, "eventId" | "kind" | "outcome" | "code" | "ruleIds">;

export type ContentRequest =
  | { type: "verdict" }
  | { type: "event"; event: ContentEvent }
  | { type: "capture"; text: string }
  /** from the block page: a navigation the rules redirected (site and code from its own query, checked by the worker) */
  | { type: "blocked"; siteId: string; code: string };

export interface VerdictReply {
  siteId: BrowserSiteId;
  mode: BrowserPolicyMode;
  verdict: BrowserSiteVerdict;
  /** null: no valid policy, so every rule applies */
  dlpRuleIds: readonly BrowserDlpRuleId[] | null;
  promptCapture: boolean;
}
