import { describe, expect, it } from "vitest";
import { BROWSER_SITE_CATALOGUE } from "@regulait/shared/browser-governance/constants";
import { blockPath, buildManifest, failClosedRules, FAIL_CLOSED_RULESET_ID, hostPatterns, MANAGED_SCHEMA, PERMISSIONS } from "../src/manifest.js";

describe("ADR-0334 manifest: least privilege, fail closed", () => {
  const m = buildManifest("1.2.3") as Record<string, any>;

  it("is Manifest V3 with exactly the pinned permissions", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(["storage", "alarms", "declarativeNetRequest", "identity", "identity.email"]);
    for (const banned of ["tabs", "history", "webNavigation", "scripting", "cookies", "webRequest", "webRequestBlocking", "<all_urls>", "debugger", "management", "nativeMessaging"]) {
      expect(m.permissions).not.toContain(banned);
    }
    expect(m.optional_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toBeUndefined();
    expect(PERMISSIONS).toHaveLength(5);
  });

  it("host permissions and content-script matches are exactly the catalogue sites, https only", () => {
    const expected = BROWSER_SITE_CATALOGUE.flatMap((s) => [`https://${s.host}/*`, `https://*.${s.host}/*`]);
    expect(m.host_permissions).toEqual(expected);
    expect(m.content_scripts[0].matches).toEqual(expected);
    expect(m.web_accessible_resources[0].matches).toEqual(expected);
    for (const p of [...m.host_permissions, ...m.content_scripts[0].matches]) {
      expect(p).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+\/\*$/);
      expect(p).not.toContain("<all_urls>");
    }
    expect(hostPatterns()).toEqual(expected);
  });

  it("ships the fail-closed ruleset enabled, covering every site", () => {
    expect(m.declarative_net_request.rule_resources).toEqual([{ id: FAIL_CLOSED_RULESET_ID, enabled: true, path: "rules/fail_closed.json" }]);
    const rules = failClosedRules();
    expect(rules.map((r) => r.condition.requestDomains?.[0])).toEqual(BROWSER_SITE_CATALOGUE.map((s) => s.host));
    for (const r of rules) {
      expect(r.action.type).toBe("redirect");
      expect(r.action.redirect?.extensionPath).toMatch(/^\/block\.html\?code=no_valid_policy&site=ep-/);
      expect(r.condition.resourceTypes).toEqual(["main_frame", "sub_frame"]);
    }
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  it("keeps a strict extension-page CSP, a managed schema and a module worker", () => {
    expect(m.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    expect(m.storage).toEqual({ managed_schema: "managed_schema.json" });
    expect(m.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(Object.keys(MANAGED_SCHEMA.properties)).toEqual(["gatewayUrl", "enrolmentToken", "policyKeys"]);
    expect(m.update_url).toBeUndefined();
    expect(m.name).toBe("regulAIt browser governance");
  });

  it("a block path carries only the code and site id", () => {
    expect(blockPath("site_denied", "ep-poe-web")).toBe("/block.html?code=site_denied&site=ep-poe-web");
  });
});
