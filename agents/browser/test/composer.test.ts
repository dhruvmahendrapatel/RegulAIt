import { describe, expect, it } from "vitest";
import { BROWSER_DLP_RULE_IDS } from "@regulait/shared/browser-governance/constants";
import { decideSend, isSendKey, looksLikeSendButton } from "../src/composer.js";
import { blockCopy, BLOCK_COPY_CODES } from "../src/copy.js";
import type { VerdictReply } from "../src/messages.js";

const key = "id=AKIA" + "Q".repeat(16);
const reply = (over: Partial<VerdictReply> = {}): VerdictReply => ({
  siteId: "ep-poe-web",
  mode: "enforce",
  verdict: { effect: "allow" },
  dlpRuleIds: [...BROWSER_DLP_RULE_IDS],
  promptCapture: false,
  ...over,
});

describe("ADR-0334 send decision", () => {
  it("blocks a credential, and blocks with every rule when the worker did not answer", () => {
    expect(decideSend(`here: ${key}`, reply())).toEqual({ action: "block", ruleIds: ["dlp.secret.aws_key"] });
    expect(decideSend(`here: ${key}`, null)).toEqual({ action: "block", ruleIds: ["dlp.secret.aws_key"] });
  });

  it("audit mode records would_block and sends; it never captures a matched prompt", () => {
    expect(decideSend(key, reply({ mode: "audit", promptCapture: true }))).toEqual({ action: "allow", ruleIds: ["dlp.secret.aws_key"], recordWouldBlock: true, capture: false });
  });

  it("captures only when the policy says so", () => {
    expect(decideSend("hello", reply())).toMatchObject({ action: "allow", capture: false });
    expect(decideSend("hello", reply({ promptCapture: true }))).toMatchObject({ action: "allow", capture: true });
    expect(decideSend("hello", null)).toMatchObject({ action: "allow", capture: false });
  });

  it("recognises send keys and send buttons", () => {
    expect(isSendKey({ key: "Enter", shiftKey: false, altKey: false, isComposing: false })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true, altKey: false, isComposing: false })).toBe(false);
    expect(isSendKey({ key: "Enter", shiftKey: false, altKey: false, isComposing: true })).toBe(false);
    expect(looksLikeSendButton("Send message", null)).toBe(true);
    expect(looksLikeSendButton("Settings", "submit")).toBe(true);
    expect(looksLikeSendButton("Sentiment", null)).toBe(false);
  });

  it("has words for every block code and never shows a code as the title", () => {
    for (const code of ["site_denied", "no_site_rule", "execution_posture", "user_disabled", "account_not_allowed", "account_signed_out", "site_not_in_policy", "no_valid_policy"]) {
      expect(BLOCK_COPY_CODES).toContain(code);
      expect(blockCopy(code).title).not.toMatch(/_/);
    }
    expect(blockCopy("anything else")).toEqual(blockCopy("no_valid_policy"));
  });
});
