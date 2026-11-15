/**
 * ADR-0334 (lane E16): the browser governance contract's constants, catalogue and pure decisions, with NO
 * dependency at all, so the extension's content script and block page bundle only this (the schemas are in
 * index.ts).
 */

// ---------------------------------------------------------------------------
// Paths, headers, bounds
// ---------------------------------------------------------------------------

export const BROWSER_EXTENSION_PATHS = {
  register: "/v1/browser-extension/register",
  policy: "/v1/browser-extension/policy",
  events: "/v1/browser-extension/events",
  promptCaptures: "/v1/browser-extension/prompt-captures",
} as const;

/** the bulk enrolment token: `rgbe_` + 64 lowercase hex, shown once, stored as a SHA-256 */
export const BROWSER_ENROLMENT_TOKEN_PREFIX = "rgbe_";
export const BROWSER_ENROLMENT_TOKEN_RE = /^rgbe_[0-9a-f]{64}$/;
/** an enrolment token lives at most this long (the endpoint agent's default, ADR-0195 SD4b) */
export const BROWSER_ENROLMENT_TOKEN_MAX_DAYS = 30;
export const BROWSER_ENROLMENT_TOKEN_MAX_DEVICES = 100_000;

export const BROWSER_POLICY_SCHEMA = "regulait.browser-policy/1";
/**
 * The signed-policy envelope's key id shape: the endpoint agent's (agents/endpoint/internal/enforce `keyIDShape`), so
 * one gateway signer and one envelope serve both on-device enforcement points.
 */
export const DEVICE_POLICY_KEY_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** a policy is valid for this long after it is issued; the extension refetches well before */
export const BROWSER_POLICY_TTL_SECONDS = 4 * 3600;
/** a policy issued further than this in the extension's future is refused (clock skew allowance) */
export const BROWSER_POLICY_MAX_FUTURE_SKEW_SECONDS = 300;

export const BROWSER_REQUEST_MAX_BYTES = 64 * 1024;
export const BROWSER_EVENTS_PER_REQUEST = 50;
/** a captured prompt is cut at this many characters (UTF-16 code units) before it leaves the browser */
export const BROWSER_PROMPT_CAPTURE_MAX_CHARS = 16_000;
/** the extension inspects at most this much of a prompt for DLP (the endpoint agent's MaxValueBytes analogue) */
export const BROWSER_DLP_MAX_CHARS = 64 * 1024;
export const BROWSER_PATH_MAX = 512;

// ---------------------------------------------------------------------------
// The governed site catalogue
// ---------------------------------------------------------------------------

/**
 * The AI assistant web apps the extension governs: the consumer web app entries of the frozen shadow-AI catalogue
 * (ADR-0055 v1), by id, host and provider. Detection catalogue data (ADR-0195 owner decision 5). Copied here rather
 * than imported so the extension bundles no more than this file; `index.test.ts` holds every row equal to its
 * catalogue entry. The extension's host permissions are generated from exactly these hosts at build time, so it can
 * read nothing else; a signed policy can narrow the set but never widen it (the browser enforces the manifest).
 */
export const BROWSER_SITE_CATALOGUE_IDS = [
  "ep-openai-chatgpt",
  "ep-openai-chat-legacy",
  "ep-anthropic-claude-web",
  "ep-google-gemini-web",
  "ep-microsoft-copilot-web",
  "ep-perplexity-web",
  "ep-deepseek-chat-web",
  "ep-poe-web",
  "ep-characterai-web",
] as const;
export type BrowserSiteId = (typeof BROWSER_SITE_CATALOGUE_IDS)[number];

export interface BrowserCatalogueSite {
  siteId: BrowserSiteId;
  /** the registrable host; the site is this host and every dot-boundary subdomain of it */
  host: string;
  provider: string;
}

export const BROWSER_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const SITE_ROWS: readonly (readonly [BrowserSiteId, string, string])[] = [
  ["ep-openai-chatgpt", "chatgpt.com", "openai"],
  ["ep-openai-chat-legacy", "chat.openai.com", "openai"],
  ["ep-anthropic-claude-web", "claude.ai", "anthropic"],
  ["ep-google-gemini-web", "gemini.google.com", "google"],
  ["ep-microsoft-copilot-web", "copilot.microsoft.com", "microsoft"],
  ["ep-perplexity-web", "perplexity.ai", "perplexity"],
  ["ep-deepseek-chat-web", "chat.deepseek.com", "deepseek"],
  ["ep-poe-web", "poe.com", "quora-poe"],
  ["ep-characterai-web", "character.ai", "character-ai"],
];

export const BROWSER_SITE_CATALOGUE: readonly BrowserCatalogueSite[] = Object.freeze(
  SITE_ROWS.map(([siteId, host, provider]) => Object.freeze({ siteId, host, provider })),
);

/** the manifest match patterns for one site (the host itself and its subdomains, https only) */
export function siteMatchPatterns(site: Pick<BrowserCatalogueSite, "host">): string[] {
  return [`https://${site.host}/*`, `https://*.${site.host}/*`];
}

/** the catalogue site a hostname belongs to (exact host or a dot-boundary subdomain), or null */
export function siteForHost(hostname: string, sites: readonly Pick<BrowserCatalogueSite, "siteId" | "host">[] = BROWSER_SITE_CATALOGUE): BrowserSiteId | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  for (const s of sites) if (h === s.host || h.endsWith(`.${s.host}`)) return s.siteId as BrowserSiteId;
  return null;
}

// ---------------------------------------------------------------------------
// DLP: the shared dlp.secret.* rule ids (the patterns are compiled into the extension, never sent as data)
// ---------------------------------------------------------------------------

/**
 * The credential-material rule ids the extension can check, in the shared order. They are the `dlp.secret.*` subset
 * of `CREDENTIAL_MATERIAL_RULES` (guardrails.ts) as the endpoint agent compiles them for RE2
 * (agents/endpoint/internal/secrets); the extension's own drift test holds its table equal to both. A policy names
 * which of these are on; it never carries a pattern (no regex is taken from data, ADR-0195 decision 5).
 */
export const BROWSER_DLP_RULE_IDS = [
  "dlp.secret.aws_key",
  "dlp.secret.private_key",
  "dlp.secret.jwt",
  "dlp.secret.assignment",
  "dlp.secret.provider_token",
  "dlp.secret.anthropic_key",
  "dlp.secret.openai_key",
  "dlp.secret.github_fine_grained_pat",
  "dlp.secret.stripe_key",
  "dlp.secret.google_api_key",
  "dlp.secret.gitlab_pat",
  "dlp.secret.huggingface_token",
  "dlp.secret.regulait_token",
] as const;
export type BrowserDlpRuleId = (typeof BROWSER_DLP_RULE_IDS)[number];

export const BROWSER_OS = ["mac", "win", "linux", "cros", "other"] as const;
export const BROWSER_VERSION_RE = /^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/;

export const BROWSER_POLICY_MODES = ["enforce", "audit"] as const;
export type BrowserPolicyMode = (typeof BROWSER_POLICY_MODES)[number];
export const BROWSER_SITE_DECISIONS = ["allow", "deny"] as const;
/** why a site is denied: fixed codes the block page explains, never free text */
export const BROWSER_DENY_REASONS = ["site_denied", "no_site_rule", "execution_posture", "user_unknown"] as const;
export type BrowserDenyReason = (typeof BROWSER_DENY_REASONS)[number];

/**
 * The decision for one navigation, from a verified policy. Pure, deterministic, fail closed:
 * no policy, an expired one, a site the policy does not list, or a deny all block. `nowSeconds` is the caller's clock.
 */
export type BrowserSiteVerdict =
  | { effect: "allow" }
  | { effect: "block"; code: BrowserDenyReason | "no_valid_policy" | "site_not_in_policy" | "account_not_allowed" | "account_signed_out" };

/** the parts of a verified policy a verdict reads (the full type, with its schema, is `BrowserPolicy` in index.ts) */
export interface BrowserPolicyView {
  issuedAt: number;
  notAfter: number;
  sites: readonly { siteId: BrowserSiteId; decision: "allow" | "deny"; denyReason: BrowserDenyReason | null; accountDomains: readonly string[] }[];
}

export function siteVerdict(policy: BrowserPolicyView | null, siteId: BrowserSiteId, profileEmailNow: string, nowSeconds: number): BrowserSiteVerdict {
  if (!policy || nowSeconds >= policy.notAfter || policy.issuedAt - BROWSER_POLICY_MAX_FUTURE_SKEW_SECONDS > nowSeconds) {
    return { effect: "block", code: "no_valid_policy" };
  }
  const site = policy.sites.find((s) => s.siteId === siteId);
  if (!site) return { effect: "block", code: "site_not_in_policy" };
  if (site.decision === "deny") return { effect: "block", code: site.denyReason ?? "site_denied" };
  if (site.accountDomains.length > 0) {
    if (!profileEmailNow) return { effect: "block", code: "account_signed_out" };
    const domain = profileEmailNow.slice(profileEmailNow.lastIndexOf("@") + 1).toLowerCase();
    if (!site.accountDomains.includes(domain)) return { effect: "block", code: "account_not_allowed" };
  }
  return { effect: "allow" };
}

// ---------------------------------------------------------------------------
// Events (policy breaches) and prompt capture
// ---------------------------------------------------------------------------

export const BROWSER_EVENT_KINDS = ["site_blocked", "account_blocked", "dlp_blocked"] as const;
export type BrowserEventKind = (typeof BROWSER_EVENT_KINDS)[number];
/** `would_block` is an audit-mode policy's record of a block it did not apply */
export const BROWSER_EVENT_OUTCOMES = ["blocked", "would_block"] as const;
export const BROWSER_EVENT_CODES = [
  ...BROWSER_DENY_REASONS,
  "no_valid_policy",
  "site_not_in_policy",
  "account_not_allowed",
  "account_signed_out",
  "dlp_match",
] as const;
export type BrowserEventCode = (typeof BROWSER_EVENT_CODES)[number];

/** the fixed refusal codes the extension routes answer with (no detail is ever echoed) */
export const BROWSER_REFUSAL_CODES = [
  "browser_governance_disabled",
  "invalid_token",
  "token_revoked",
  "token_expired",
  "enrolment_cap_reached",
  "invalid_body",
  "body_too_large",
  "device_revoked",
  "policy_signer_unavailable",
  "prompt_capture_disabled",
  "data_key_unavailable",
  "issuer_not_configured",
  "credential_already_registered",
  "browser_extension_token_required",
] as const;
export type BrowserRefusalCode = (typeof BROWSER_REFUSAL_CODES)[number];
