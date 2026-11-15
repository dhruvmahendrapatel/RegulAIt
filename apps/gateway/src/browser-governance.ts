/**
 * ADR-0334 (lane E16): the gateway side of the managed browser extension, PURE PART (no database, no routes).
 *
 *  - Device authentication is NOT here: an extension is a workload identity of kind `browser_extension` and reaches
 *    the gateway with an S7 DPoP-bound self token (oauth/), the endpoint agent's pattern (ADR-0195 SD4b).
 *  - `buildBrowserPolicy`: the per-user decision for each catalogue site, deterministic, fail closed. The order is the
 *    governed core's (ADR-0251): a disabled person gets nothing (an unmatched account gets the org-wide rules, owner
 *    decision B1); the execution posture (the kernel's
 *    `executionGate`, the same kill switch every governed call obeys) can only remove access; then the admin's site
 *    rule, where no rule means deny. Account domains are carried for the extension to check against the profile.
 *  - Signing is the shared device-policy signer's (`device-policy-signer.ts`, owner decision B4).
 *
 * No model is called anywhere here: every permission and governance decision is a data check.
 */
import { createHmac } from "node:crypto";
import { executionGate, type ExecutionPosture } from "@regulait/policy-kernel";
import {
  BROWSER_DLP_RULE_IDS,
  BROWSER_POLICY_SCHEMA,
  BROWSER_POLICY_TTL_SECONDS,
  BROWSER_SITE_CATALOGUE,
  browserPolicySchema,
  type BrowserDenyReason,
  type BrowserPolicy,
  type BrowserPolicyMode,
  type BrowserPolicySite,
  type BrowserSiteId,
} from "@regulait/shared";

// ---------------------------------------------------------------------------
// Keyed references
// ---------------------------------------------------------------------------

/**
 * The conversation a governed page belongs to, as a keyed hash of the site and its path (no query, no fragment).
 * The path itself is never stored. `key` is the deployment's pseudonym key (ADR-0195 decision 20).
 */
export function conversationRef(key: Buffer, siteId: string, sitePath: string): string {
  return `cnv:${createHmac("sha256", key).update(`browser-conversation\u0000${siteId}\u0000${sitePath}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SiteRuleInput {
  siteId: string;
  decision: "allow" | "deny";
  accountDomains: readonly string[];
}

export interface BuildPolicyInput {
  deviceId: string;
  subject: string;
  profileEmail: string;
  mode: BrowserPolicyMode;
  promptCaptureEnabled: boolean;
  /** the org user the profile account matched, and whether they may act at all */
  user: { id: string; disabled: boolean } | null;
  /** the deployment's execution posture (the governed core's kill switch) */
  posture: ExecutionPosture;
  rules: readonly SiteRuleInput[];
  nowSeconds: number;
}

/** The per-user policy. Every catalogue site appears once; anything not explicitly allowed is a deny with its reason. */
export function buildBrowserPolicy(input: BuildPolicyInput): BrowserPolicy {
  // owner decision B1 (2026-11-15): a profile account that matches no RegulAIt user gets the org-wide site rules
  // (account-domain rules still apply, and the route audits the issue); a matched but disabled person gets nothing
  const userDeny: BrowserDenyReason | null = input.user?.disabled ? "user_disabled" : null;
  // a prompt to an AI site sends data out: a write for the read-only dial, and no per-call approval queue exists here
  const stop = executionGate(input.posture, true, "an AI assistant site in the browser", false);
  const postureDeny: BrowserDenyReason | null = stop && stop.effect !== "allow" ? "execution_posture" : null;
  const sites: BrowserPolicySite[] = BROWSER_SITE_CATALOGUE.map((site) => {
    const rule = input.rules.find((r) => r.siteId === site.siteId);
    const denyReason: BrowserDenyReason | null = userDeny ?? postureDeny ?? (!rule ? "no_site_rule" : rule.decision === "deny" ? "site_denied" : null);
    return {
      siteId: site.siteId as BrowserSiteId,
      decision: denyReason ? "deny" : "allow",
      denyReason,
      accountDomains: denyReason ? [] : [...(rule?.accountDomains ?? [])].sort(),
    };
  });
  const policy: BrowserPolicy = {
    schema: BROWSER_POLICY_SCHEMA,
    deviceId: input.deviceId,
    subject: input.subject,
    profileEmail: input.profileEmail,
    mode: input.mode,
    issuedAt: input.nowSeconds,
    notAfter: input.nowSeconds + BROWSER_POLICY_TTL_SECONDS,
    sites,
    // every shared credential rule is on; turning one off is a later, audited relaxation (ADR-0334 follow-ups)
    dlp: { ruleIds: [...BROWSER_DLP_RULE_IDS] },
    promptCapture: { enabled: input.promptCaptureEnabled },
  };
  // the same schema the extension parses: a policy the extension would refuse is never signed
  return browserPolicySchema.parse(policy);
}
