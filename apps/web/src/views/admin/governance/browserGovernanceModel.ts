/**
 * ADR-0334 (lane E16, D5) — the Browser governance page's pure model: the shapes the eleven admin routes answer
 * (apps/gateway/src/browser-governance-routes.ts), the mode as one choice, account-domain parsing, and every code the
 * page can show as words. No React here, so the unit tests read it directly.
 */

export type BrowserMode = "off" | "audit" | "enforce";

export interface PolicyKey {
  keyId: string;
  /** the Ed25519 public key as a JWK `x` (what a device's managed storage pins) */
  x: string;
}

export interface BrowserGovernanceSettings {
  enabled: boolean;
  mode: "enforce" | "audit";
  promptCaptureEnabled: boolean;
  promptCaptureRetentionDays: number;
  updatedAt: string;
  policySigner:
    | { state: "ok"; source: "operator_managed" | "install_generated"; activeKeyId: string; publishedKeys: PolicyKey[] }
    | { state: "missing" | "invalid" };
}

export interface BrowserSite {
  siteId: string;
  host: string;
  provider: string;
  /** the admin's rule; null when no rule was ever set (which means deny) */
  decision: "allow" | "deny" | null;
  effective: "allow" | "deny";
  accountDomains: string[];
}

export interface BrowserTokenView {
  tokenId: string;
  label: string;
  deviceCap: number;
  devicesEnrolled: number;
  devicesActive: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface BrowserDeviceView {
  deviceId: string;
  tokenId: string;
  os: string;
  browserMajor: number | string;
  extensionVersion: string;
  bound: boolean;
  boundSubject: string | null;
  boundAt: string | null;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface BrowserEventView {
  id: string;
  deviceId: string;
  kind: string;
  outcome: string;
  code: string;
  siteId: string;
  ruleIds: string[];
  subject: string;
  attribution: string;
  conversationRef: string | null;
  occurredAt: string;
  receivedAt: string;
  auditId: string;
}

export interface PromptCaptureView {
  id: string;
  deviceId: string;
  siteId: string;
  subject: string;
  conversationRef: string | null;
  text: string;
  capturedAt: string;
  receivedAt: string;
}

export interface IssuedToken {
  token: BrowserTokenView;
  managedConfig: { gatewayUrl: string; enrolmentToken: string; policyKeys: PolicyKey[] };
}

/** the gateway's bounds (packages/shared browser-governance constants) */
export const TOKEN_MAX_DAYS = 30;
export const TOKEN_MAX_DEVICES = 100_000;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;
export const ACCOUNT_DOMAINS_MAX = 20;

export const modeOf = (s: Pick<BrowserGovernanceSettings, "enabled" | "mode">): BrowserMode => (s.enabled ? s.mode : "off");

export const MODE_LABEL: Record<BrowserMode, string> = { off: "Off", audit: "Audit only", enforce: "Enforce" };

/** the settings write for a mode choice */
export function modeBody(mode: BrowserMode): { enabled: boolean; mode?: "enforce" | "audit" } {
  return mode === "off" ? { enabled: false } : { enabled: true, mode };
}

/** does moving from `from` to `to` relax the policy (turning on, or to audit only), which the gateway step-ups? */
export function modeRelaxes(from: BrowserMode, to: BrowserMode): boolean {
  return (from === "off" && to !== "off") || (to === "audit" && from !== "audit");
}

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** account domains typed as a list (commas, spaces or new lines): lower case, de-duplicated, sorted, or the problem */
export function parseAccountDomains(text: string): { domains: string[]; problem: string | null } {
  const parts = text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domains = [...new Set(parts)].sort();
  const bad = domains.find((d) => !DOMAIN_RE.test(d));
  if (bad) return { domains, problem: `"${bad}" is not a domain. Enter domains like example.com, without @ or a scheme.` };
  if (domains.length > ACCOUNT_DOMAINS_MAX) return { domains, problem: `At most ${ACCOUNT_DOMAINS_MAX} account domains per site.` };
  return { domains, problem: null };
}

export type TokenState = "active" | "exhausted" | "expired" | "revoked";

export function tokenState(t: BrowserTokenView, now = Date.now()): TokenState {
  if (t.revokedAt) return "revoked";
  if (Date.parse(t.expiresAt) <= now) return "expired";
  if (t.devicesEnrolled >= t.deviceCap) return "exhausted";
  return "active";
}

export const TOKEN_STATE: Record<TokenState, { label: string; tone: "ok" | "warn" | "neutral" }> = {
  active: { label: "Active", tone: "ok" },
  exhausted: { label: "Cap reached", tone: "warn" },
  expired: { label: "Expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "neutral" },
};

export const EVENT_KIND: Record<string, string> = {
  site_blocked: "Site",
  account_blocked: "Account",
  dlp_blocked: "Sensitive data",
};

/** every event code the extension sends, in words (BROWSER_EVENT_CODES) */
export const EVENT_CODE: Record<string, string> = {
  site_denied: "The site is denied",
  no_site_rule: "No rule allows the site, so it is denied",
  execution_posture: "Execution is halted, read-only or needs approval, so every site is denied",
  user_disabled: "The person's account is disabled",
  no_valid_policy: "The browser had no valid signed policy, so it blocked the site",
  site_not_in_policy: "The site was not in the browser's policy",
  account_not_allowed: "Signed in with an account outside the required domains",
  account_signed_out: "Not signed in to the browser profile with a work account",
  dlp_match: "Credential-like data in the prompt",
};

export const eventCodeText = (code: string): string => EVENT_CODE[code] ?? code.replace(/_/g, " ");

export const SIGNER_STATE: Record<"missing" | "invalid", string> = {
  missing: "No policy signing key is configured, so browsers cannot get a policy: turning governance on and issuing tokens are refused until an operator adds one.",
  invalid: "The policy signing key cannot be used, so browsers cannot get a policy until an operator fixes it.",
};

/** a key shortened for display; the full value is what Copy copies */
export const shortKey = (x: string): string => (x.length > 16 ? `${x.slice(0, 8)}…${x.slice(-6)}` : x);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s.trim());
