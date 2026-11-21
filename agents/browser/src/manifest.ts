/**
 * ADR-0334: the extension's Manifest V3 and its fail-closed static ruleset, generated from the governed site
 * catalogue at build time. Pure, so the permission set is pinned by a test:
 *
 *  - host permissions and content-script matches are exactly the catalogue sites (https, the host and its
 *    subdomains). There is no `<all_urls>`, no `tabs`, `history`, `webNavigation`, `scripting`, `cookies` or
 *    `webRequest`: the extension cannot read browsing outside the governed sites, and reads nothing of history.
 *  - `identity` + `identity.email` read only the browser profile's signed-in account, for account rules.
 *  - the `fail_closed` ruleset is ON in the manifest: every governed site is redirected to the block page until a
 *    verified, unexpired policy says otherwise. If the service worker never starts, the sites stay blocked.
 *  - `storage.managed_schema` is the only configuration channel: the customer's browser management writes it, the
 *    user cannot. The extension is deployed force-installed by policy; it is never published for user install.
 */
import { BROWSER_SITE_CATALOGUE, siteMatchPatterns, type BrowserCatalogueSite } from "@regulait/shared/browser-governance/constants";

export const FAIL_CLOSED_RULESET_ID = "fail_closed";
export const BLOCK_PAGE = "block.html";
/** static rules use ids 1..n; dynamic rules start here, so the two never collide */
export const DYNAMIC_RULE_ID_BASE = 1000;
/** the minimum Chromium version: MV3 `extensionPath` redirects and WebCrypto Ed25519 by default */
export const MIN_CHROMIUM_VERSION = "137";

export const PERMISSIONS = ["storage", "alarms", "declarativeNetRequest", "identity", "identity.email"] as const;

export function hostPatterns(sites: readonly Pick<BrowserCatalogueSite, "host">[] = BROWSER_SITE_CATALOGUE): string[] {
  return sites.flatMap((s) => siteMatchPatterns(s));
}

/**
 * The manifest. `gatewayOrigin` (#1029) is the one gateway this build reaches: its host permission lets the worker call
 * it without CORS, and only the worker uses it (it is in neither the content-script nor the web-accessible matches).
 * With none, the build reaches no gateway and stays closed.
 */
export function buildManifest(version: string, sites: readonly BrowserCatalogueSite[] = BROWSER_SITE_CATALOGUE, gatewayOrigin: string | null = null): Record<string, unknown> {
  const hosts = hostPatterns(sites);
  return {
    manifest_version: 3,
    name: "regulAIt browser governance",
    description: "Applies your organisation's AI use policy on governed AI sites. Managed by your organisation.",
    version,
    minimum_chrome_version: MIN_CHROMIUM_VERSION,
    permissions: [...PERMISSIONS],
    host_permissions: gatewayOrigin ? [...hosts, `${gatewayOrigin}/*`] : hosts,
    background: { service_worker: "background.js", type: "module" },
    content_scripts: [{ matches: hosts, js: ["content.js"], run_at: "document_start", all_frames: false }],
    declarative_net_request: { rule_resources: [{ id: FAIL_CLOSED_RULESET_ID, enabled: true, path: "rules/fail_closed.json" }] },
    web_accessible_resources: [{ resources: [BLOCK_PAGE, "block.js", "ui.css"], matches: hosts }],
    storage: { managed_schema: "managed_schema.json" },
    // MV3's own default, stated so a later edit cannot loosen it silently: no remote or inline script, no eval
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  };
}

/** the block-page path a redirect names, with the fixed code and site id (no URL of the blocked page travels) */
export function blockPath(code: string, siteId: string): string {
  return `/${BLOCK_PAGE}?code=${encodeURIComponent(code)}&site=${encodeURIComponent(siteId)}`;
}

/** one redirect rule per catalogue site: the fail-closed ruleset, and the shape the dynamic rules share */
export function blockRule(id: number, site: Pick<BrowserCatalogueSite, "host" | "siteId">, code: string): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: blockPath(code, site.siteId) } },
    condition: {
      requestDomains: [site.host],
      resourceTypes: ["main_frame", "sub_frame"] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}

export function failClosedRules(sites: readonly BrowserCatalogueSite[] = BROWSER_SITE_CATALOGUE): chrome.declarativeNetRequest.Rule[] {
  return sites.map((s, i) => blockRule(i + 1, s, "no_valid_policy"));
}

/** the managed storage schema (JSON Schema, as Chromium reads it): what the customer's browser management sets */
export const MANAGED_SCHEMA = {
  type: "object",
  properties: {
    gatewayUrl: { type: "string", title: "Gateway URL", description: "The RegulAIt gateway's public https URL." },
    enrolmentToken: { type: "string", title: "Enrolment token", description: "The rgbe_ token from the admin's enrolment step." },
    policyKeys: {
      type: "array",
      title: "Policy keys",
      description: "The gateway's browser policy public key(s): a policy signed by any other key is refused.",
      items: {
        type: "object",
        properties: { keyId: { type: "string" }, x: { type: "string" } },
      },
    },
  },
};
